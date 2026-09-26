#!/usr/bin/env node
/*
 * zcodium-mobile-bridge.mjs — ZCodium 手机远控桥（C2 方案，custom 分支单文件）
 *
 * 角色：同时扮演官方架构里的「云中继」与「桌面主机连接入口」：
 *   手机页面(remote/v4) ⇄ [本桥] ⇄ zcode --web (127.0.0.1 后端 /ws)
 * 协议依据（2026-09-26 静态提取，见 项目资源/ZCodium手机远控Phase0通道映射表.md 附录 B）：
 *   - 握手: auth_challenge{nonce} → auth_response{device_sid, proof, client_ts} → auth_ack{pair_status}
 *     proof = base64url(HMAC-SHA256(key=hash, msg=`${nonce}|terminal|${device_sid}`))
 *   - 信封: {type:'data', payload:{zcode_type:'rpc-frame', bridgeSessionId, bridgeGeneration,
 *     recoveryId?, seq, messageSeq, fragmentIndex, fragmentCount, messageBytes,
 *     checksum:{algorithm:'crc32', value}, dataBase64}, client_ts}
 *   - 桥接时序: bootstrap-request/response → workspace-list-request/response →
 *     workspace-bridge-open/ready → rpc-frame ⇄ rpc-frame-ack
 *   - 后端 /ws 帧: 13 字节头 (u8 type=1 Regular, u32BE id, u32BE ack, u32BE len) + RPC body；
 *     RPC body 与手机 rpc-frame 的 dataBase64 内容字节级同格式 → 直通。
 * 零第三方依赖（Node ≥ 22）。
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── 配置 ────────────────────────────────────────────────────────────────
function loadConfig() {
  const cfg = {
    port: 4310,
    host: "127.0.0.1",
    token: null, // 配对令牌（= hash 参数；REST/WS 校验）
    sid: "d_zcodium_" + crypto.randomBytes(6).toString("hex"),
    backendHttp: "http://127.0.0.1:3030",
    backendWs: "ws://127.0.0.1:3030/ws",
    snapshotDir: path.join(HERE, "remote_v4"),
    workspacePath: process.cwd(),
    workspaceLabel: "ZCodium",
    publicBaseUrl: null, // 例如 https://xx.de5.net（隧道时设置；缺省按请求 Host）
    logDir: path.join(HERE, "logs"),
    spawnBackend: null, // 例如 { command:"node", args:["...zcode.cjs","--web",...] }（增强功能开关接入后由桌面端托管）
  };
  const cfgFile = process.env.ZCODIUM_BRIDGE_CONFIG || path.join(HERE, "bridge.config.json");
  if (fs.existsSync(cfgFile)) Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, "utf8")));
  if (process.env.BRIDGE_PORT) cfg.port = Number(process.env.BRIDGE_PORT);
  if (process.env.BRIDGE_TOKEN) cfg.token = process.env.BRIDGE_TOKEN;
  if (process.env.BRIDGE_SID) cfg.sid = process.env.BRIDGE_SID;
  if (process.env.BRIDGE_PUBLIC_BASE) cfg.publicBaseUrl = process.env.BRIDGE_PUBLIC_BASE;
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString("base64url");
    console.log(`[bridge] 未配置 token，本次生成：${cfg.token}`);
  }
  return cfg;
}
const CFG = loadConfig();

// ── 日志（NDJSON，脱敏）─────────────────────────────────────────────────
fs.mkdirSync(CFG.logDir, { recursive: true });
const LOG_FILE = path.join(CFG.logDir, `bridge-${new Date().toISOString().slice(0, 10)}.ndjson`);
function log(kind, data) {
  let s;
  try { s = JSON.stringify(data); } catch { s = String(data); }
  s = s.replace(/"proof":"[^"]*"/g, '"proof":"[redacted]"').replace(new RegExp(CFG.token, "g"), "[token]");
  fs.appendFile(LOG_FILE, JSON.stringify({ t: Date.now(), kind, d: s.slice(0, 4000) }) + "\n", () => {});
}

// ── CRC32 ───────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

// ── proof 计算（与页面 bundle H2t 一致）─────────────────────────────────
function calcProof(hash, nonce, role, sid) {
  return crypto.createHmac("sha256", hash).update(`${nonce}|${role}|${sid}`).digest("base64url");
}

// ── 极简 WebSocket 服务器（RFC6455，文本帧为主，支持分片/ping/close）────
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function wsAccept(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}
function wsFrame(payloadBuf, opcode, fin = true) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  return Buffer.concat([header, payloadBuf]);
}
class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.alive = true;
    this.onmessage = null; // (text) => void
    this.onclose = null;
    this._frag = [];
    this._fragOp = 0;
    this._buf = Buffer.alloc(0);
    socket.on("data", (d) => this._feed(d));
    socket.on("close", () => this._dead());
    socket.on("error", () => this._dead());
  }
  _dead() { if (this.alive) { this.alive = false; try { this.onclose && this.onclose(); } catch {} } }
  sendText(str) { this._raw(wsFrame(Buffer.from(str, "utf8"), 0x1)); }
  sendBinary(buf) { this._raw(wsFrame(buf, 0x2)); }
  _raw(buf) { if (this.alive) { try { this.socket.write(buf); } catch {} } }
  close(code = 1000) {
    if (!this.alive) return;
    const b = Buffer.alloc(4); b.writeUInt16BE(code, 2);
    this._raw(wsFrame(b.subarray(2), 0x8));
    setTimeout(() => { try { this.socket.destroy(); } catch {} }, 200);
  }
  _feed(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (true) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < off + 2) return; len = b.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (b.length < off + 8) return; len = Number(b.readBigUInt64BE(off)); off += 8; }
      let mask = null;
      if (masked) { if (b.length < off + 4) return; mask = b.subarray(off, off + 4); off += 4; }
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (mask) { const u = Buffer.from(payload); for (let i = 0; i < u.length; i++) u[i] ^= mask[i & 3]; payload = u; }
      this._buf = b.subarray(off + len);
      this._handleFrame(fin, op, payload);
    }
  }
  _handleFrame(fin, op, payload) {
    if (op === 0x9) { this._raw(wsFrame(payload, 0xa)); return; } // ping→pong
    if (op === 0x8) { this.close(1000); return; }
    if (op === 0xa) return; // pong
    if (op !== 0) { this._fragOp = op; this._frag = [payload]; }
    else this._frag.push(payload);
    if (!fin) return;
    const full = Buffer.concat(this._frag.length ? this._frag : [payload]);
    const opFinal = op === 0 ? this._fragOp : op;
    this._frag = []; this._fragOp = 0;
    if (opFinal === 0x1) { try { this.onmessage && this.onmessage(full.toString("utf8")); } catch (e) { log("error", { where: "onmessage", msg: String(e) }); } }
    else if (opFinal === 0x2) { try { this.onmessage && this.onmessage(full); } catch (e) { log("error", { where: "onmessage-bin", msg: String(e) }); } }
  }
}

// ── HTTP：静态页面 + REST 门面 ──────────────────────────────────────────
const MIME = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon" };
function findAsset(rel) {
  const clean = rel.replace(/^\/+/, "").replace(/\.\./g, "");
  for (const p of [path.join(CFG.snapshotDir, clean), path.join(CFG.snapshotDir, "latest", clean), path.join(CFG.snapshotDir, "latest", clean.replace(/^assets\//, "assets/"))]) {
    const f = path.normalize(p);
    if (f.startsWith(path.normalize(CFG.snapshotDir)) && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(s);
}
function checkToken(req, url) {
  const auth = req.headers["authorization"] || "";
  if (auth === `Bearer ${CFG.token}`) return true;
  if (url.searchParams.get("token") === CFG.token) return true;
  return false;
}
function pairingUrl(req) {
  const base = CFG.publicBaseUrl || `https://${req.headers.host}`;
  return `${base.replace(/\/$/, "")}/remote/v4?sid=${encodeURIComponent(CFG.sid)}&hash=${encodeURIComponent(CFG.token)}&t=${Date.now()}&mid=${crypto.randomUUID()}&name=ZCodium&app_version=3.14.3`;
}
function workspacesPayload() {
  return [{ workspaceKey: "ws-local", workspacePath: CFG.workspacePath, label: CFG.workspaceLabel, kind: "local" }];
}
function tasksPayload() { return []; }

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }); return res.end(); }
  // 配对页（浏览器直接打开即可拿 URL）
  if (p === "/pair") {
    if (!checkToken(req, url)) return json(res, 401, { error: "unauthorized" });
    return json(res, 200, { pairingUrl: pairingUrl(req), sid: CFG.sid });
  }
  // 静态页面
  if (p === "/remote/v4" || p === "/remote/v4/" || p === "/remote/v4/index.html") {
    const idx = findAsset("index.html");
    if (!idx) return json(res, 500, { error: "snapshot missing" });
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    return res.end(fs.readFileSync(idx));
  }
  if (p.startsWith("/remote/v4/")) {
    const f = findAsset(p.slice("/remote/v4/".length));
    if (f) { res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" }); return res.end(fs.readFileSync(f)); }
    return json(res, 404, { error: "asset not found", path: p });
  }
  // REST：/api/remote-control/...
  let m;
  if ((m = p.match(/^\/api\/remote-control\/windows\/bootstrap\/([^/]+)$/))) {
    if (m[1] !== CFG.token) return json(res, 401, { error: "unauthorized" });
    return json(res, 200, { workspaces: workspacesPayload(), tasks: tasksPayload(), initialViewState: { activeWorkspaceKey: "ws-local", updatedAt: Date.now() }, mobileViewState: { updatedAt: Date.now() } });
  }
  if ((m = p.match(/^\/api\/remote-control\/windows\/([^/]+)\/workspace-bridge$/)) && req.method === "POST") {
    if (m[1] !== CFG.token) return json(res, 401, { error: "unauthorized" });
    const base = CFG.publicBaseUrl || `${req.socket.encrypted ? "wss" : "ws"}://${req.headers.host}`;
    const wsBase = base.replace(/^http/, "ws").replace(/\/$/, "");
    return json(res, 200, { wsUrl: `${wsBase}/ws/remote-control/window/${CFG.token}` });
  }
  if ((m = p.match(/^\/api\/remote-control\/windows\/([^/]+)\/mobile-view-state$/)) && req.method === "POST") {
    if (m[1] !== CFG.token) return json(res, 401, { error: "unauthorized" });
    return json(res, 200, { success: true });
  }
  if ((m = p.match(/^\/api\/remote-control\/platform\/([^/]+)$/)) && req.method === "POST") {
    if (m[1] !== CFG.token) return json(res, 401, { error: "unauthorized" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let method = "";
      try { method = JSON.parse(body).method || ""; } catch {}
      const stubs = { isDockerAvailable: false, listWSLDistros: [], listDockerContainers: [], listSSHConfigAliases: [], loadMcpFromUserDirectory: { servers: [] }, saveMcpToUserDirectory: { success: false, error: "not supported by bridge" }, migrateLegacyCommonMcp: { servers: {}, totalCount: 0, importedCount: 0 } };
      log("platform", { method });
      return json(res, 200, { result: method in stubs ? stubs[method] : null });
    });
    return;
  }
  json(res, 404, { error: "no route", path: p });
});

// ── WS 升级：手机页面接入 ───────────────────────────────────────────────
const sessionsBySid = new Map(); // sid → RelaySession
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  const m = url.pathname.match(/^\/ws\/remote-control\/window\/([^/]+)$/) || url.pathname.match(/^\/ws$/);
  if (!m) { socket.destroy(); return; }
  const tokenInPath = m[1];
  if (tokenInPath && tokenInPath !== CFG.token) { socket.destroy(); return; }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  const conn = new WsConn(socket);
  if (head && head.length) conn._feed(head);
  new RelaySession(conn, url);
});

// ── 中继会话：握手 → 桥接 → rpc-frame 直通 ─────────────────────────────
class RelaySession {
  constructor(conn, url) {
    this.conn = conn;
    this.sid = url.searchParams.get("sid") || CFG.sid;
    this.nonce = crypto.randomBytes(16).toString("hex");
    this.authed = false;
    this.bridgeSessionId = null;
    this.outSeq = 0;
    this.outMessageSeq = 0;
    this.backend = null; // WebSocket
    this.pendingToBackend = [];
    this.dead = false;

    const prev = sessionsBySid.get(this.sid);
    if (prev && prev !== this) { try { prev.sendEnvelope({ type: "error", code: "KICKED" }); prev.teardown("kicked"); } catch {} }
    sessionsBySid.set(this.sid, this);
    log("session-open", { sid: this.sid });

    this.sendEnvelope({ type: "auth_challenge", nonce: this.nonce });
    this.heartbeat = setInterval(() => { try { this.conn._raw(wsFrame(Buffer.alloc(0), 0x9)); } catch {} }, 25000);

    conn.onmessage = (msg) => {
      if (typeof msg !== "string") return this.onBackendFacingBinary?.(msg);
      let env; try { env = JSON.parse(msg); } catch { return; }
      this.handleEnvelope(env).catch((e) => log("error", { where: "handleEnvelope", msg: String(e) }));
    };
    conn.onclose = () => this.teardown("phone-close");
  }

  sendEnvelope(obj) { this.conn.sendText(JSON.stringify(obj)); }
  sendData(payload) { this.sendEnvelope({ type: "data", payload, server_ts: Date.now() }); }

  async handleEnvelope(env) {
    if (env.type === "auth_response") {
      const expect = calcProof(CFG.token, this.nonce, "terminal", env.device_sid || this.sid);
      if (env.proof !== expect) {
        log("auth-fail", { sid: env.device_sid });
        this.sendEnvelope({ type: "error", code: "AUTH_FAILED" });
        return this.teardown("auth-fail");
      }
      this.authed = true;
      this.sendEnvelope({ type: "auth_ack", pair_status: "paired" });
      log("auth-ok", { sid: this.sid });
      return;
    }
    if (env.type === "auth_init") return; // 容忍
    if (env.type !== "data" || !env.payload) return;
    const p = env.payload;
    const zt = p.zcode_type;
    log("recv", { zt, requestId: p.requestId, bridgeSessionId: p.bridgeSessionId });

    if (zt === "bootstrap-request") {
      return this.sendData({
        zcode_type: "bootstrap-response", requestId: p.requestId, success: true,
        result: {
          windowControlSessionId: "win-" + crypto.randomBytes(4).toString("hex"),
          workspaces: workspacesPayload(), tasks: tasksPayload(),
          initialViewState: { activeWorkspaceKey: "ws-local", updatedAt: Date.now() },
          mobileViewState: { updatedAt: Date.now() },
        },
      });
    }
    if (zt === "workspace-list-request") {
      return this.sendData({
        zcode_type: "workspace-list-response", requestId: p.requestId, success: true,
        result: { workspaces: workspacesPayload(), activeWorkspaceKey: "ws-local" },
      });
    }
    if (zt === "workspace-bridge-open") {
      this.bridgeSessionId = p.bridgeSessionId;
      this.connectBackend(p);
      return;
    }
    if (zt === "rpc-frame") {
      const body = Buffer.from(p.dataBase64 || "", "base64");
      if (p.checksum && p.checksum.algorithm === "crc32" && p.checksum.value !== crc32(body)) {
        log("fault", { why: "crc32-mismatch", want: p.checksum.value, got: crc32(body) });
        return this.sendData({ zcode_type: "rpc-transport-fault", bridgeSessionId: p.bridgeSessionId, reason: "checksum" });
      }
      this.sendData({ zcode_type: "rpc-frame-ack", bridgeSessionId: p.bridgeSessionId, bridgeGeneration: p.bridgeGeneration, ackMessageSeq: p.messageSeq ?? p.seq });
      this.toBackend(body);
      return;
    }
    if (zt === "rpc-frame-ack") return; // 手机对下行帧的确认：直通模式无需处理
    log("unknown-envelope", { zt });
  }

  connectBackend(openEnv) {
    if (this.backend) return;
    const ws = new WebSocket(CFG.backendWs);
    ws.binaryType = "arraybuffer";
    this.backend = ws;
    ws.addEventListener("open", () => {
      this.sendData({
        zcode_type: "workspace-bridge-ready",
        requestId: openEnv.requestId,
        bridgeSessionId: openEnv.bridgeSessionId,
        bridgeGeneration: openEnv.bridgeGeneration,
        bridge: {
          bridgeSessionId: openEnv.bridgeSessionId,
          kind: "local",
          workspaceKey: openEnv.workspaceKey || "ws-local",
          workspacePath: CFG.workspacePath,
          initialTaskId: openEnv.taskId,
        },
      });
      log("backend-open", {});
      for (const b of this.pendingToBackend.splice(0)) this.writeBackend(b);
    });
    ws.addEventListener("message", (ev) => {
      const buf = Buffer.from(ev.data);
      if (buf.length < 13) return;
      const type = buf.readUInt8(0);
      const len = buf.readUInt32BE(9);
      if (type !== 1 || buf.length < 13 + len) { log("backend-frame", { type, len, actual: buf.length }); if (type !== 1) return; }
      const body = buf.subarray(13, 13 + len);
      this.toPhoneFrame(body);
    });
    ws.addEventListener("error", () => log("backend-error", {}));
    ws.addEventListener("close", (ev) => {
      log("backend-close", { code: ev.code });
      this.sendData({ zcode_type: "workspace-bridge-error", requestId: openEnv.requestId, bridgeSessionId: openEnv.bridgeSessionId, error: "backend-closed" });
      this.teardown("backend-close");
    });
  }

  writeBackend(body) {
    const head = Buffer.alloc(13);
    head.writeUInt8(1, 0); // Regular
    head.writeUInt32BE(0, 1); head.writeUInt32BE(0, 5);
    head.writeUInt32BE(body.length, 9);
    this.backend.send(Buffer.concat([head, body]));
  }
  toBackend(body) {
    if (this.backend && this.backend.readyState === 1) this.writeBackend(body);
    else this.pendingToBackend.push(body);
  }

  toPhoneFrame(body) {
    this.outSeq += 1; this.outMessageSeq += 1;
    this.sendData({
      zcode_type: "rpc-frame",
      bridgeSessionId: this.bridgeSessionId,
      bridgeGeneration: 1,
      seq: this.outSeq,
      messageSeq: this.outMessageSeq,
      fragmentIndex: 0,
      fragmentCount: 1,
      messageBytes: body.length,
      checksum: { algorithm: "crc32", value: crc32(body) },
      dataBase64: body.toString("base64"),
    });
  }

  teardown(why) {
    if (this.dead) return;
    this.dead = true;
    clearInterval(this.heartbeat);
    if (sessionsBySid.get(this.sid) === this) sessionsBySid.delete(this.sid);
    try { this.backend && this.backend.close(); } catch {}
    try { this.conn.close(1000); } catch {}
    log("session-close", { why });
  }
}

// ── 后端进程托管（可选；增强功能开关接入后由桌面端触发）─────────────────
let backendProc = null;
async function startBackend() {
  if (!CFG.spawnBackend) return;
  const { spawn } = await import("node:child_process");
  backendProc = spawn(CFG.spawnBackend.command, CFG.spawnBackend.args || [], { stdio: "ignore", detached: false });
  log("backend-spawn", { cmd: CFG.spawnBackend.command });
}
startBackend().catch((e) => log("error", { where: "startBackend", msg: String(e) }));

// ── main ────────────────────────────────────────────────────────────────
httpServer.listen(CFG.port, CFG.host, () => {
  console.log(`[bridge] http://${CFG.host}:${CFG.port}`);
  console.log(`[bridge] 配对 URL（手机 App 直接打开/填入）：`);
  const demoReq = { headers: { host: `${CFG.host}:${CFG.port}` }, socket: { encrypted: false } };
  console.log(`  ${pairingUrl(demoReq)}`);
  console.log(`[bridge] 令牌即 URL 里的 hash 参数；日志: ${LOG_FILE}`);
});
process.on("SIGINT", () => { try { backendProc && backendProc.kill(); } catch {} process.exit(0); });
