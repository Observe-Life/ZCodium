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
import net from "node:net";
import { spawn } from "node:child_process";
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
    debugAgent: false, // 临时：抓取 zcode-agent 请求与事件结构（BRIDGE_DEBUG_AGENT=1）
    spawnBackend: null, // 例如 { command:"node", args:["...zcode.cjs","--web",...] }（增强功能开关接入后由桌面端托管）
    // 公网隧道（Phase 4）：cloudflared 快速隧道 + DNSHE 固定域名同步；由桌面端 supervisor 透传。
    tunnel: null, // { enabled, domain, subdomainId, dnsheKey, dnsheSecret, cloudflaredPath }
  };
  const cfgFile = process.env.ZCODIUM_BRIDGE_CONFIG || path.join(HERE, "bridge.config.json");
  if (fs.existsSync(cfgFile)) Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, "utf8")));
  if (process.env.BRIDGE_PORT) cfg.port = Number(process.env.BRIDGE_PORT);
  if (process.env.BRIDGE_TOKEN) cfg.token = process.env.BRIDGE_TOKEN;
  if (process.env.BRIDGE_SID) cfg.sid = process.env.BRIDGE_SID;
  if (process.env.BRIDGE_PUBLIC_BASE) cfg.publicBaseUrl = process.env.BRIDGE_PUBLIC_BASE;
  if (process.env.BRIDGE_DEBUG_FRAMES) cfg.debugFrames = process.env.BRIDGE_DEBUG_FRAMES === "1";
  if (process.env.BRIDGE_DEBUG_AGENT) cfg.debugAgent = process.env.BRIDGE_DEBUG_AGENT === "1";
  if (process.env.BRIDGE_WORKSPACE) cfg.workspacePath = process.env.BRIDGE_WORKSPACE;
  if (process.env.BRIDGE_HOST) cfg.host = process.env.BRIDGE_HOST;
  if (process.env.BRIDGE_TUNNEL === "1") {
    cfg.tunnel = {
      enabled: true,
      domain: process.env.BRIDGE_TUNNEL_DOMAIN || "",
      subdomainId: Number(process.env.BRIDGE_TUNNEL_SUBDOMAIN_ID || 0),
      dnsheKey: process.env.BRIDGE_DNSHE_KEY || "",
      dnsheSecret: process.env.BRIDGE_DNSHE_SECRET || "",
      cloudflaredPath: process.env.BRIDGE_CLOUDFLARED || "",
      // 命名隧道运行令牌（CF 账号隧道）；为空时降级为快速隧道（域名每次启动会变）。
      token: process.env.BRIDGE_TUNNEL_TOKEN || "",
    };
  }
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
    // 只按工作区过滤：provider 字段会随用户换模型而变，带着它会漏列会话（r6）。
    const where = ["workspace_key = ?"];
    const params = [workspacePath];
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
  const base = `https://${req.headers.host}`.replace(/\/$/, "");
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
    return json(res, 200, { pairingUrl: pairingUrl(req), sid: CFG.sid, tunnel: { ...tunnelState } });
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
      const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
      const isSecure = forwardedProto ? forwardedProto === "https" : Boolean(req.socket.encrypted);
      const base = `${isSecure ? "wss" : "ws"}://${req.headers.host}`;
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
      if (CFG.debugAgent && body.length > 13) {
        try {
          const p = rpcParseFrame(body);
          const [tc] = p.header || [];
          if (tc === 204) {
            const s = JSON.stringify(p.body);
            if (s.includes("sessions-index")) {
              fs.writeFileSync(path.join(HERE, "sessions_index_dump.json"), s);
              log("agent-event", { head: JSON.stringify(p.header), dumped: s.length });
            } else {
              log("agent-event", { head: JSON.stringify(p.header), body: s.slice(0, 700) });
            }
          }
        } catch {}
      }
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
        if (CFG.debugAgent) {
          try { const p = rpcParseFrame(body); const [tc, rid2, ch, me] = p.header || []; if (ch === "zcode-agent" && (me === "initializeConversationV4" || me === "subscribeSessionsIndexV4")) { fs.writeFileSync(path.join(HERE, `handshake_${me}.json`), JSON.stringify(p.body)); log("handshake-captured", { me }); } } catch {}
        }
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

// ── Phase 5：Server酱³ 推送（持久订阅会话索引 + 实时推送 + 去重）──
// 完成推送判据：phase ∈ {completedSuccess,error} 且 hasBackgroundWork!==true 且 sessionEnded===true。
//   多轮接力期间 sessionEnded=false 天然不刷屏；去重键 = sessionId|lastActivityAt。
// 请决策推送判据：会话摘要带 pendingInteraction（kind=permission 求确认 / userInput 求回答）
//   或 pendingInteractionSummary 计数>0，出现瞬间即推；去重键 = sessionId|interactionId（同一请求多帧只推一次），回答/撤销后自动复位。
const NOTIFY_STATE_FILE = path.join(HERE, "notify-state.json");
let notifyState = { sent: {}, asks: {} };
try {
  const raw = JSON.parse(fs.readFileSync(NOTIFY_STATE_FILE, "utf8"));
  notifyState = { sent: raw.sent || {}, asks: raw.asks || {} };
} catch {}
function saveNotifyState() {
  try { fs.writeFileSync(NOTIFY_STATE_FILE, JSON.stringify(notifyState)); } catch {}
}
function loadNotifyConfig() {
  try { return JSON.parse(fs.readFileSync(CFG.notifyConfigPath, "utf8")); } catch { return null; }
}
async function sendServerChan(cfg, title, short, desp) {
  const url = `https://${cfg.uid}.push.ft07.com/send/${cfg.sendKey}.send`;
  const body = JSON.stringify({ title, desp: desp || short, short });
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  const text = await res.text();
  log("notify-sent", { title: title.slice(0, 30), status: res.status, resp: text.slice(0, 160) });
  return res.ok;
}
function isQuiescent(s) {
  return (s.phase === "completedSuccess" || s.phase === "error") && s.hasBackgroundWork !== true && s.sessionEnded === true;
}
function pendingAskInfo(s) {
  const pi = s.pendingInteraction;
  if (pi && pi.interactionId) return { sig: "id:" + pi.interactionId, kind: pi.kind, toolName: pi.toolName };
  const sum = s.pendingInteractionSummary; // 旧帧兼容：只有计数没有单项明细
  if (sum && (sum.permissionCount || 0) + (sum.userInputCount || 0) > 0)
    return { sig: `n:${sum.permissionCount || 0}:${sum.userInputCount || 0}`, kind: (sum.userInputCount || 0) > 0 ? "userInput" : "permission" };
  return null;
}
function sessionDesp(s, extra) {
  let d = `会话：${String(s.title || s.sessionId).slice(0, 40)}`;
  if (extra) d += `\n${extra}`;
  if (s.lastAssistantPreview) d += `\n— ${String(s.lastAssistantPreview).slice(0, 80)}`;
  if (CFG.publicBaseUrl) d += `\n\n打开远控页面：${CFG.publicBaseUrl.replace(/\/$/, "")}/web-remote`;
  return d;
}
let notifySeeded = false; // 初始快照只打底不推送，避免启动时把历史静止会话全推一遍
function handleSessionsSnapshot(sessions) {
  const cfg = loadNotifyConfig();
  if (!cfg || !cfg.enabled) return;
  const events = cfg.events || {};
  for (const s of sessions || []) {
    if (!s || !s.sessionId) continue;
    // ① 请决策：出现即推、去重、回答后复位（与 phase 无关，阻塞中的会话往往仍在 running）
    const ask = pendingAskInfo(s);
    const prevAsk = notifyState.asks[s.sessionId];
    if (!ask) {
      if (prevAsk) { delete notifyState.asks[s.sessionId]; saveNotifyState(); log("notify-ask-cleared", { sessionId: s.sessionId }); }
    } else if (prevAsk !== ask.sig) {
      notifyState.asks[s.sessionId] = ask.sig;
      saveNotifyState();
      if (notifySeeded && events.ask !== false) {
        // 标题遵循安卓端既有规范（PushSettingsActivity/serverchan-notify.js）：【智能体】请决策
        const detail = ask.kind === "permission"
          ? "等待权限确认" + (ask.toolName ? `（${ask.toolName}）` : "")
          : ask.kind === "userInput" ? "有问题等你回答" : "等待你的决策";
        const short = `会话：${String(s.title || s.sessionId).slice(0, 40)}`;
        sendServerChan(cfg, "【智能体】请决策", short, sessionDesp(s, detail))
          .catch((e) => log("notify-error", { msg: String(e) }));
        log("notify-ask-sent", { sessionId: s.sessionId, kind: ask.kind, tool: ask.toolName || null });
      }
    }
    // ② 完成 / 中断（静止判据）
    if (!isQuiescent(s)) continue;
    const key = `${s.sessionId}|${s.lastActivityAt || 0}`;
    if (!notifySeeded) { notifyState.sent[key] = true; continue; } // 打底：标记为已处理，不推送
    if (notifyState.sent[key]) continue;
    if (s.phase === "error" && events.error === false) continue;
    if (s.phase === "completedSuccess" && events.done === false) continue;
    const label = s.phase === "error" ? "已中断" : "已完成";
    const short = `会话：${String(s.title || s.sessionId).slice(0, 40)}`;
    notifyState.sent[key] = true;
    saveNotifyState();
    sendServerChan(cfg, `【智能体】${label}`, short, sessionDesp(s)).catch((e) => log("notify-error", { msg: String(e) }));
  }
}
// —— 桥的持久后端订阅（不依赖手机是否在线）——
let notifySub = null;
function startNotifySubscription() {
  const cfg = loadNotifyConfig();
  if (!cfg || !cfg.enabled) { log("notify-disabled", { path: CFG.notifyConfigPath }); return; }
  const ws = new WebSocket(CFG.backendWs);
  ws.binaryType = "arraybuffer";
  notifySub = ws;
  let rid = 0;
  const initId = { v: 0 };
  const sendRpc = (channel, method, args) => {
    const id = ++rid;
    const body = Buffer.concat([rpcSerialize([100, id, channel, method]), rpcSerialize(args === undefined ? null : args)]);
    const h = Buffer.alloc(13);
    h.writeUInt8(1, 0); h.writeUInt32BE(0, 1); h.writeUInt32BE(0, 5); h.writeUInt32BE(body.length, 9);
    ws.send(Buffer.concat([h, body]));
    return id;
  };
  const sendListen = (channel, method, args) => {
    const id = ++rid;
    const body = Buffer.concat([rpcSerialize([102, id, channel, method]), rpcSerialize(args === undefined ? null : args)]);
    const h = Buffer.alloc(13);
    h.writeUInt8(1, 0); h.writeUInt32BE(0, 1); h.writeUInt32BE(0, 5); h.writeUInt32BE(body.length, 9);
    ws.send(Buffer.concat([h, body]));
    return id;
  };
  ws.addEventListener("open", () => {
    log("notify-sub-open", {});
    // 事件订阅（页面同款）：onDynamicSessionsIndexFrame（102 EventListen），再走三步握手
    sendListen("zcode-agent", "onDynamicSessionsIndexFrame", { workspacePath: CFG.workspacePath });
    initId.v = sendRpc("zcode-agent", "helloConversationV4", []);
  });
  ws.addEventListener("message", (ev) => {
    const b = Buffer.from(ev.data);
    if (b.length < 13) return;
    const type = b.readUInt8(0);
    if (type !== 1) return;
    const len = b.readUInt32BE(9);
    try {
      const p = rpcParseFrame(b.subarray(13, 13 + len));
      const [tcode, rmid] = p.header || [];
      if (CFG.debugAgent) log("notify-frame", { tcode, rmid, err: tcode === 202 || tcode === 203 ? JSON.stringify(p.body).slice(0, 300) : undefined });
      if (initId.v && rmid === initId.v) {
        const stage = initId.stage || "hello";
        if (stage === "hello") {
          initId.stage = "init";
          initId.v = sendRpc("zcode-agent", "initializeConversationV4", [{ kind: "clientHello", protocolVersion: 3, clientId: "client-" + crypto.randomUUID(), clientKind: "web", appVersion: "unknown", capabilities: { workspaceHookReviewUi: true } }]);
          return;
        }
        if (stage === "init") {
          initId.stage = "sub";
          initId.v = sendRpc("zcode-agent", "subscribeSessionsIndexV4", [{ workspacePath: CFG.workspacePath, runtimePolicy: "start-if-needed" }]);
          log("notify-subscribed", { workspacePath: CFG.workspacePath, initOk: tcode === 201 });
          return;
        }
        initId.v = 0;
        return;
      }
      if (tcode !== 204) return;
      const frame = p.body && p.body.frame;
      const snap = frame && frame.payload && frame.payload.snapshot;
      if (snap && Array.isArray(snap.sessions)) {
        const wasSeeded = notifySeeded;
        handleSessionsSnapshot(snap.sessions);
        if (!wasSeeded) { notifySeeded = true; saveNotifyState(); log("notify-seeded", { n: snap.sessions.length }); }
      }
      const delta = frame && frame.payload && frame.payload.deltas;
      if (Array.isArray(delta)) {
        for (const d of delta) {
          if (d && d.op === "session.removed" && d.sessionId && notifyState.asks[d.sessionId]) {
            delete notifyState.asks[d.sessionId];
            saveNotifyState();
          }
        }
        const sessions = delta.filter((d) => d && d.op === "session.upserted" && d.session).map((d) => d.session);
        if (sessions.length) handleSessionsSnapshot(sessions);
      }
    } catch {}
  });
  ws.addEventListener("close", (ev) => { log("notify-sub-closed", { code: ev.code, reason: String(ev.reason || "").slice(0, 120) }); setTimeout(startNotifySubscription, 5000); });
  ws.addEventListener("error", (ev) => { log("notify-sub-error", { msg: String((ev && ev.message) || ev).slice(0, 200) }); });
}

// ── Phase 4：公网隧道（cloudflared 快速隧道 + DNSHE 固定域名自动同步）──
// 由桌面端 supervisor 经环境变量透传配置；本模块只负责：拉起/守护 cloudflared、
// 解析隧道域名、通过 DNSHE API 把固定域名 CNAME 指向当前隧道、暴露状态给 /pair。
let tunnelState = {
  enabled: false,
  mode: null, // "named"（CF 账号命名隧道，域名固定）| "quick"（快速隧道，域名每次变）
  tunnelId: null,
  tunnelUrl: null,
  fixedDomain: null,
  publicUrl: null,
  dnsSyncedAt: null,
  lastError: null,
};
let tunnelProc = null;
let tunnelRestartTimer = null;
const TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

async function dnsheRequest(query, init) {
  const api = `https://api005.dnshe.com/index.php?m=domain_hub&endpoint=dns_records${query}`;
  const headers = {
    "X-API-Key": CFG.tunnel.dnsheKey,
    "X-API-Secret": CFG.tunnel.dnsheSecret,
    ...((init && init.headers) || {}),
  };
  const res = await fetch(api, { ...(init || {}), headers });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  if (!res.ok || !payload || payload.success === false) {
    throw new Error(`dnshe ${res.status}: ${text.slice(0, 160)}`);
  }
  return payload;
}

/** 命名隧道令牌是 base64(JSON)：{ a: 账户标签, t: 隧道ID, s: 隧道密钥 }。 */
function decodeTunnelToken(token) {
  try {
    const json = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    if (json && typeof json.t === "string" && json.t) return { tunnelId: json.t, accountTag: json.a };
  } catch {}
  return null;
}

/** 记录固定域名的对外地址（DNS 已指向 targetHost 后调用）。 */
function applyFixedDomain(targetHost) {
  const base = `https://${CFG.tunnel.domain}`;
  tunnelState.fixedDomain = CFG.tunnel.domain;
  tunnelState.dnsSyncedAt = Date.now();
  tunnelState.lastError = null;
  tunnelState.publicUrl = `${base}/web-remote?remoteControlToken=${encodeURIComponent(CFG.token)}&relayOrigin=${encodeURIComponent(base)}`;
  log("tunnel-dns-synced", { host: targetHost, domain: CFG.tunnel.domain });
}

async function syncFixedDomain(targetHost) {
  const list = await dnsheRequest(`&action=list&subdomain_id=${CFG.tunnel.subdomainId}`);
  for (const record of list.records || []) {
    if (record && record.record_id) {
      await dnsheRequest("&action=delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ record_id: record.record_id }),
      });
    }
  }
  await dnsheRequest("&action=create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subdomain_id: CFG.tunnel.subdomainId,
      type: "CNAME",
      content: targetHost,
    }),
  });
  applyFixedDomain(targetHost);
}

/** cloudflared 子进程的公共接线：URL 扫描（仅快速隧道用）、崩溃自愈。 */
function attachTunnelChild(child, watchForQuickUrl) {
  tunnelProc = child;
  if (watchForQuickUrl) {
    const scan = (chunk) => {
      const match = String(chunk).match(TUNNEL_URL_RE);
      if (!match) return;
      const url = match[0];
      if (url === tunnelState.tunnelUrl) return;
      tunnelState.tunnelUrl = url;
      log("tunnel-url", { url });
      syncFixedDomain(url.replace(/^https:\/\//, "")).catch((error) => {
        tunnelState.lastError = String(error);
        log("tunnel-dns-error", { msg: String(error).slice(0, 200) });
      });
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
  }
  child.on("error", (error) => log("tunnel-spawn-error", { msg: String(error) }));
  child.on("exit", (code) => {
    tunnelProc = null;
    log("tunnel-exit", { code });
    if (tunnelState.enabled && !tunnelRestartTimer) {
      tunnelRestartTimer = setTimeout(() => {
        tunnelRestartTimer = null;
        startTunnel();
      }, 5000);
    }
  });
}

function startTunnel() {
  const cfg = CFG.tunnel;
  if (!cfg || !cfg.enabled) return;
  tunnelState.enabled = true;
  tunnelState.startedAt = Date.now(); // 供健康哨兵计算启动宽限期
  const dnsReady = Boolean(cfg.domain && cfg.subdomainId && cfg.dnsheKey && cfg.dnsheSecret);
  if (!cfg.cloudflaredPath || !dnsReady) {
    tunnelState.lastError = "tunnel-config-incomplete";
    log("tunnel-config-incomplete", {});
    return;
  }

  // 命名隧道（首选）：令牌含隧道 ID，DNS 目标恒为 <id>.cfargotunnel.com，域名与地址跨重启稳定。
  if (cfg.token) {
    const info = decodeTunnelToken(cfg.token);
    if (!info) {
      tunnelState.lastError = "tunnel-token-invalid";
      log("tunnel-token-invalid", {});
      return;
    }
    const targetHost = `${info.tunnelId}.cfargotunnel.com`;
    tunnelState.mode = "named";
    tunnelState.tunnelId = info.tunnelId;
    tunnelState.tunnelUrl = `https://${targetHost}`;
    applyFixedDomain(targetHost);
    syncFixedDomain(targetHost).catch((error) => {
      tunnelState.lastError = String(error);
      log("tunnel-dns-error", { msg: String(error).slice(0, 200) });
    });
    const child = spawn(cfg.cloudflaredPath, ["tunnel", "--no-autoupdate", "run", "--token", cfg.token], {
      windowsHide: true,
    });
    attachTunnelChild(child, false);
    log("tunnel-started", { mode: "named", tunnelId: info.tunnelId, port: CFG.port });
    return;
  }

  // 快速隧道（降级备用）：地址每次启动都变，由 DNS 同步跟随。
  tunnelState.mode = "quick";
  const child = spawn(
    cfg.cloudflaredPath,
    ["tunnel", "--url", `http://127.0.0.1:${CFG.port}`, "--no-autoupdate"],
    { windowsHide: true },
  );
  attachTunnelChild(child, true);
  log("tunnel-started", { mode: "quick", bin: cfg.cloudflaredPath, port: CFG.port });
}

// ── 隧道健康哨兵 ─────────────────────────────────────────────────────────
// 快速隧道会"僵而不死"：cloudflared 进程活着，但到 Cloudflare 边缘的连接已断、
// 也不再吐新地址——exit 自愈管不到这种情况。
// 判活信号用 cloudflared 本机的 /ready 指标端口（默认 127.0.0.1:20241/ready，
// 连接建立返回 200，未连返回非 2xx），**不走公网回探**——公网回探依赖本机 DNS，
// 而 DNS 抽风时会把活隧道误判为死（上一版每 4 分钟误杀一次，反把模拟器连接打断）。
// 启动后给 3 分钟宽限期；此后连续 3 次（每 60s 一次，共约 3 分钟）非 200 才重启。
function startTunnelWatchdog() {
  let fails = 0;
  setInterval(() => {
    if (!tunnelState.enabled || !tunnelProc) return;
    if (tunnelState.mode !== "quick") return; // 命名隧道地址恒定，无需回探
    if (Date.now() - (tunnelState.startedAt || 0) < 180000) return; // 启动宽限期
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    fetch("http://127.0.0.1:20241/ready", { signal: ctrl.signal })
      .then((r) => { fails = r.status === 200 ? 0 : fails + 1; })
      .catch(() => { fails += 1; })
      .finally(() => {
        clearTimeout(timer);
        if (fails >= 3) {
          fails = 0;
          log("tunnel-health-dead", { url: tunnelState.tunnelUrl });
          try { tunnelProc.kill(); } catch { /* 已退出 */ }
        }
      });
  }, 60000);
}

// ── main ────────────────────────────────────────────────────────────────
httpServer.listen(CFG.port, CFG.host, () => {
  console.log(`[bridge] http://${CFG.host}:${CFG.port}`);
  console.log(`[bridge] 配对 URL（手机 App 直接打开/填入）：`);
  const demoReq = { headers: { host: `${CFG.host}:${CFG.port}` }, socket: { encrypted: false } };
  console.log(`  ${pairingUrl(demoReq)}`);
  console.log(`[bridge] 令牌即 URL 里的 hash 参数；日志: ${LOG_FILE}`);
  startNotifySubscription();
  startTunnel();
  startTunnelWatchdog();
});
process.on("SIGINT", () => { try { backendProc && backendProc.kill(); } catch {} process.exit(0); });
