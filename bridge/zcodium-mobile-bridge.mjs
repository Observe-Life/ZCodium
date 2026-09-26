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
import { DatabaseSync } from "node:sqlite";
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
    debugFrames: false,
    // 任务列表就地应答：后端（CLI）与桌面端的数据根不一致时，桥直接读桌面端的任务索引作答。
    tasksIndexPath: "D:\\ZCodium\\.zcodium\\v2\\tasks-index.sqlite",
    provider: "glm",
    // Server酱³ 推送（沿用既有配置；enabled 由该文件控制）
    notifyConfigPath: "C:\\Users\\Bingcan Lin\\AppData\\Local\\ZCode\\serverchan-notify.json",
    notifyDebounceMs: 90000, // 静默期：任务进入终态后稳定这么久才推送（防多轮接力刷屏）
    spawnBackend: null, // 例如 { command:"node", args:["...zcode.cjs","--web",...] }（增强功能开关接入后由桌面端托管）
  };
  const cfgFile = process.env.ZCODIUM_BRIDGE_CONFIG || path.join(HERE, "bridge.config.json");
  if (fs.existsSync(cfgFile)) Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, "utf8")));
  if (process.env.BRIDGE_PORT) cfg.port = Number(process.env.BRIDGE_PORT);
  if (process.env.BRIDGE_TOKEN) cfg.token = process.env.BRIDGE_TOKEN;
  if (process.env.BRIDGE_SID) cfg.sid = process.env.BRIDGE_SID;
  if (process.env.BRIDGE_PUBLIC_BASE) cfg.publicBaseUrl = process.env.BRIDGE_PUBLIC_BASE;
  if (process.env.BRIDGE_DEBUG_FRAMES) cfg.debugFrames = process.env.BRIDGE_DEBUG_FRAMES === "1";
  if (process.env.BRIDGE_WORKSPACE) cfg.workspacePath = process.env.BRIDGE_WORKSPACE;
  if (process.env.BRIDGE_HOST) cfg.host = process.env.BRIDGE_HOST;
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

// ── 内联 RPC 编解码（tag: 0 null/1 string/2,3 binary/4 array/5 object/6 int；LEB128）──
function writeVarint(out, v) {
  if (v === 0) { out.push(0); return; }
  let uv = BigInt(v < 0 ? 0 : v);
  while (uv > 0n) { let b = Number(uv & 0x7fn); uv >>= 7n; if (uv > 0n) b |= 0x80; out.push(b); }
}
function readVarint(buf, pos) {
  let value = 0n, shift = 0n, i = pos;
  for (;;) { const b = buf[i++]; value |= BigInt(b & 0x7f) << shift; if ((b & 0x80) === 0) break; shift += 7n; if (i - pos > 10) throw new Error("varint"); }
  return { value: Number(value), next: i };
}
function rpcSerialize(value) { const out = []; rpcSer(value, out); return Buffer.from(out); }
function rpcSer(v, out) {
  if (v === null || v === undefined) { out.push(0); return; }
  if (typeof v === "number") { out.push(6); writeVarint(out, v); return; }
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); out.push(1); writeVarint(out, b.length); out.push(...b); return; }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) { out.push(2); writeVarint(out, v.length); out.push(...v); return; }
  if (Array.isArray(v)) { out.push(4); writeVarint(out, v.length); for (const it of v) rpcSer(it, out); return; }
  if (typeof v === "object") { const b = Buffer.from(JSON.stringify(v), "utf8"); out.push(5); writeVarint(out, b.length); out.push(...b); return; }
  out.push(0);
}
function rpcDeserialize(buf, pos = 0) {
  const tag = buf[pos++];
  if (tag === 0) return { value: null, next: pos };
  if (tag === 6) { const r = readVarint(buf, pos); return { value: r.value, next: r.next }; }
  if (tag === 1) { const l = readVarint(buf, pos); return { value: buf.subarray(l.next, l.next + l.value).toString("utf8"), next: l.next + l.value }; }
  if (tag === 2 || tag === 3) { const l = readVarint(buf, pos); return { value: Buffer.from(buf.subarray(l.next, l.next + l.value)), next: l.next + l.value }; }
  if (tag === 4) { const n = readVarint(buf, pos); let i = n.next; const arr = []; for (let k = 0; k < n.value; k++) { const r = rpcDeserialize(buf, i); arr.push(r.value); i = r.next; } return { value: arr, next: i }; }
  if (tag === 5) { const l = readVarint(buf, pos); return { value: JSON.parse(buf.subarray(l.next, l.next + l.value).toString("utf8")), next: l.next + l.value }; }
  throw new Error("bad tag " + tag);
}
function rpcParseFrame(buf) {
  const h = rpcDeserialize(buf, 0);
  const b = h.next >= buf.length ? { value: undefined } : rpcDeserialize(buf, h.next);
  return { header: h.value, body: b.value };
}

// ── 任务列表就地应答（读桌面端任务索引）────────────────────────────────
function queryTasks(indexPath, kind, workspacePath) {  const db = new DatabaseSync(indexPath, { readOnly: true });
  try {
    const where = ["workspace_key = ?", "provider = ?"];
    const params = [workspacePath, CFG.provider];
    if (kind === "listTasks") { where.push("pinned = 0", "archived = 0", "deleted = 0"); }
    if (kind === "listPinnedTasks") { where.push("pinned = 1", "archived = 0", "deleted = 0"); }
    if (kind === "listArchivedTasks") { where.push("archived = 1"); }
    const rows = db.prepare(`SELECT meta_json FROM tasks WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`).all(...params);
    return rows.map((r) => { try { return JSON.parse(r.meta_json); } catch { return null; } }).filter(Boolean);
  } finally { try { db.close(); } catch {} }
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
  const base = (CFG.publicBaseUrl || `https://${req.headers.host}`).replace(/\/$/, "");
  // 带 token 时页面自动走 /web-remote 流程；relayOrigin 显式给出以确保 REST/WS 都指回本桥。
  return `${base}/web-remote?remoteControlToken=${encodeURIComponent(CFG.token)}&relayOrigin=${encodeURIComponent(base)}`;
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
  // 静态页面（/remote/v4 与 /web-remote 两个入口都供同一份 SPA；页面会在带 token 时自动走 /web-remote 流程）
  if (p === "/remote/v4" || p === "/remote/v4/" || p === "/remote/v4/index.html" || p === "/web-remote" || p === "/web-remote/") {
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
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let workspaceKey = "ws-local";
      try { const b = JSON.parse(body || "{}"); if (b.workspaceKey) workspaceKey = b.workspaceKey; } catch {}
      const base = CFG.publicBaseUrl || `${req.socket.encrypted ? "wss" : "ws"}://${req.headers.host}`;
      const wsBase = base.replace(/^http/, "ws").replace(/\/$/, "");
      return json(res, 200, {
        wsUrl: `${wsBase}/ws/remote-control/workspace/${CFG.token}`,
        bridgeSessionId: "bridge-" + crypto.randomUUID(),
        bridgeGeneration: 1,
        kind: "local",
        workspaceKey,
        workspacePath: CFG.workspacePath,
        initialTaskId: null,
      });
    });
    return;
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

// ── WS 升级：区分「窗口 socket」与「工作区 socket」两路 ────────────────
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  const winM = url.pathname.match(/^\/ws\/remote-control\/window\/([^/]+)$/);
  const wsM = url.pathname.match(/^\/ws\/remote-control\/workspace\/([^/]+)$/);
  if (!winM && !wsM) { socket.destroy(); return; }
  const tokenInPath = (winM || wsM)[1];
  if (tokenInPath !== CFG.token) { socket.destroy(); return; }
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
  if (winM) new WindowSocket(conn);
  else new WorkspaceRelay(conn);
});

// ── 窗口 socket：/web-remote token 流程的第一条连接，连上即回 window-control-ready ──
class WindowSocket {
  constructor(conn) {
    this.conn = conn;
    this.windowControlSessionId = "wcs-" + crypto.randomBytes(6).toString("hex");
    this.mobileConnectionId = "mc-" + crypto.randomBytes(8).toString("hex");
    log("window-open", { wcs: this.windowControlSessionId });
    conn.sendText(JSON.stringify({
      type: "window-control-ready",
      windowControlSessionId: this.windowControlSessionId,
      mobileConnectionId: this.mobileConnectionId,
    }));
    conn.onmessage = (msg) => { log("window-recv", { d: String(msg).slice(0, 240) }); };
    conn.onclose = () => log("window-close", {});
  }
}

// ── 工作区 socket：持久层（id/ack/KeepAlive）服务端 + 后端 /ws 直通 ─────
class WorkspaceRelay {
  constructor(conn) {
    this.conn = conn;
    this.backend = null;
    this.lastPageId = 0; // 页面发来的最大 id，用于回 ack
    this.outId = 0;      // 桥发往页面的 id
    this.dead = false;
    this.debugFrames = !!CFG.debugFrames;
    log("workspace-open", {});

    const ws = new WebSocket(CFG.backendWs);
    ws.binaryType = "arraybuffer";
    this.backend = ws;
    ws.addEventListener("open", () => log("backend-open", {}));
    ws.addEventListener("message", (ev) => {
      const buf = Buffer.from(ev.data);
      if (buf.length < 13) return;
      const len = buf.readUInt32BE(9);
      if (buf.length < 13 + len) return;
      const body = buf.subarray(13, 13 + len);
      if (this.debugFrames) log("ws-res", { len: body.length, head: body.subarray(0, 24).toString("hex") });
      this.toPage(1, body); // 持久层只向上传 Regular，统一以 Regular 转发（含后端的 Control/initialize 载荷）
    });
    ws.addEventListener("close", () => this.teardown("backend-close"));
    ws.addEventListener("error", () => log("backend-error", {}));

    conn.onmessage = (msg) => {
      if (typeof msg === "string") { log("workspace-text", { d: msg.slice(0, 160) }); return; }
      const buf = Buffer.from(msg);
      if (buf.length < 13) return;
      const type = buf.readUInt8(0);
      const id = buf.readUInt32BE(1);
      const len = buf.readUInt32BE(9);
      const body = buf.subarray(13, 13 + len);
      if (type === 1) { // Regular：任务列表就地应答，其余转给后端；均立即回 Ack
        this.lastPageId = Math.max(this.lastPageId, id);
        if (this.debugFrames) log("ws-req", { len: body.length, head: body.subarray(0, 24).toString("hex") });
        if (!this.tryLocalTaskList(body)) this.toBackend(body);
        this.toPage(3, Buffer.alloc(0), id);
        return;
      }
      if (type === 9) { this.toPage(9, Buffer.alloc(0)); return; } // KeepAlive → 回 KeepAlive
      if (type === 3) return; // 页面对桥下行帧的 Ack：忽略
      if (type === 5) return this.teardown("page-disconnect");
      log("workspace-frame", { type, len });
    };
    conn.onclose = () => this.teardown("page-close");
  }
  toBackend(body) {
    if (!this.backend || this.backend.readyState !== 1) return;
    const head = Buffer.alloc(13);
    head.writeUInt8(1, 0);
    head.writeUInt32BE(0, 1);
    head.writeUInt32BE(0, 5);
    head.writeUInt32BE(body.length, 9);
    this.backend.send(Buffer.concat([head, body]));
  }
  // 任务列表就地应答：绕过后端（CLI）与桌面端的数据根差异，直接读桌面端任务索引
  tryLocalTaskList(body) {
    let parsed;
    try { parsed = rpcParseFrame(body); } catch { return false; }
    const header = parsed.header;
    if (!Array.isArray(header)) return false;
    const [tcode, rid, channel, method] = header;
    if (tcode === 100 && channel === "window-controller") {
      log("window-controller-req", { method, args: JSON.stringify(parsed.body).slice(0, 400) });
      return false; // 先观察，不拦截
    }
    if (tcode !== 100 || channel !== "zcode-task") return false;
    if (!["listTasks", "listPinnedTasks", "listArchivedTasks"].includes(method)) return false;
    try {
      const argObj = Array.isArray(parsed.body) && parsed.body[0] && typeof parsed.body[0] === "object" ? parsed.body[0] : {};
      const workspacePath = argObj.workspacePath || CFG.workspacePath;
      const tasks = queryTasks(CFG.tasksIndexPath, method, workspacePath);
      this.toPage(1, Buffer.concat([rpcSerialize([201, rid]), rpcSerialize(tasks)]));
      log("local-task-list", { method, count: tasks.length, wsPath: workspacePath, provider: CFG.provider, db: CFG.tasksIndexPath });
      return true;
    } catch (e) {
      log("local-task-list-error", { msg: String(e) });
      return false;
    }
  }
  toPage(type, body, ackOverride) {
    if (this.dead) return;
    this.outId += 1;
    const head = Buffer.alloc(13);
    head.writeUInt8(type, 0);
    head.writeUInt32BE(this.outId, 1);
    head.writeUInt32BE(ackOverride ?? this.lastPageId, 5);
    head.writeUInt32BE(body.length, 9);
    this.conn.sendBinary(Buffer.concat([head, body]));
  }
  teardown(why) {
    if (this.dead) return;
    this.dead = true;
    try { this.backend && this.backend.close(); } catch {}
    try { this.conn.close(1000); } catch {}
    log("workspace-close", { why });
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

// ── Phase 5：Server酱³ 推送（轮询任务库 + 静默去抖 + 去重）─────────────
const NOTIFY_STATE_FILE = path.join(HERE, "notify-state.json");
let notifyState = { sent: {} }; // key: `${taskId}|${updatedAt}` → true
try { notifyState = JSON.parse(fs.readFileSync(NOTIFY_STATE_FILE, "utf8")); } catch {}
const pendingNotify = new Map(); // taskId → { since, status, updatedAt, title }
function saveNotifyState() {
  try { fs.writeFileSync(NOTIFY_STATE_FILE, JSON.stringify(notifyState)); } catch {}
}
function loadNotifyConfig() {
  try { return JSON.parse(fs.readFileSync(CFG.notifyConfigPath, "utf8")); } catch { return null; }
}
async function sendServerChan(cfg, title, short) {
  const url = `https://${cfg.uid}.push.ft07.com/send/${cfg.sendKey}.send`;
  const body = JSON.stringify({ title, desp: short, short });
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  const text = await res.text();
  log("notify-sent", { title: title.slice(0, 30), status: res.status, resp: text.slice(0, 160) });
  return res.ok;
}
async function notifyTick() {
  const cfg = loadNotifyConfig();
  if (!cfg || !cfg.enabled || !cfg.uid || !cfg.sendKey) return;
  let rows;
  try {
    const db = new DatabaseSync(CFG.tasksIndexPath, { readOnly: true });
    rows = db.prepare("SELECT task_id, title, task_status, updated_at FROM tasks WHERE deleted = 0 AND archived = 0 ORDER BY updated_at DESC LIMIT 30").all();
    db.close();
  } catch (e) { return; }
  const now = Date.now();
  for (const r of rows) {
    const status = String(r.task_status || "");
    const terminal = status === "completed" || status === "error";
    const key = `${r.task_id}|${r.updated_at}`;
    if (!terminal) { pendingNotify.delete(r.task_id); continue; }
    if (notifyState.sent[key]) { pendingNotify.delete(r.task_id); continue; }
    const p = pendingNotify.get(r.task_id);
    if (!p || p.updatedAt !== r.updated_at) {
      pendingNotify.set(r.task_id, { since: now, status, updatedAt: r.updated_at, title: r.title });
      continue;
    }
    if (now - p.since < CFG.notifyDebounceMs) continue;
    if (status === "error" && cfg.events && cfg.events.error === false) { pendingNotify.delete(r.task_id); continue; }
    if (status === "completed" && cfg.events && cfg.events.done === false) { pendingNotify.delete(r.task_id); continue; }
    const label = status === "error" ? "已中断" : "已完成";
    const title = `【智能体】${label}`;
    const short = `会话：${String(r.title || r.task_id).slice(0, 40)}`;
    const ok = await sendServerChan(cfg, title, short).catch((e) => { log("notify-error", { msg: String(e) }); return false; });
    if (ok) { notifyState.sent[key] = true; saveNotifyState(); }
    pendingNotify.delete(r.task_id);
  }
}
function startNotifyLoop() {
  const cfg = loadNotifyConfig();
  if (!cfg || !cfg.enabled) { log("notify-disabled", { path: CFG.notifyConfigPath }); return; }
  setInterval(() => { notifyTick().catch((e) => log("notify-tick-error", { msg: String(e) })); }, 10000);
  log("notify-loop-started", { uid: cfg.uid });
}

// ── main ────────────────────────────────────────────────────────────────
httpServer.listen(CFG.port, CFG.host, () => {
  console.log(`[bridge] http://${CFG.host}:${CFG.port}`);
  console.log(`[bridge] 配对 URL（手机 App 直接打开/填入）：`);
  const demoReq = { headers: { host: `${CFG.host}:${CFG.port}` }, socket: { encrypted: false } };
  console.log(`  ${pairingUrl(demoReq)}`);
  console.log(`[bridge] 令牌即 URL 里的 hash 参数；日志: ${LOG_FILE}`);
  startNotifyLoop();
});
process.on("SIGINT", () => { try { backendProc && backendProc.kill(); } catch {} process.exit(0); });
