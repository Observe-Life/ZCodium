#!/usr/bin/env node
/*
 * zcodium-mobile-bridge.mjs — ZCodium 手机远控桥（C2 方案，custom 分支单文件）
 *
 * 角色：手机远控的「运输面」——隧道、配对令牌、页面静态资源、v4 协议封装；
 *   手机页面(remote/v4) ⇄ [本桥] ⇄ 桌面端 host 本地 RPC 桥服务(127.0.0.1:4311)
 * （2026-09-30 同进程直连改造：数据面不再经独立 `zcode --web` 后端，手机与桌面 UI
 *   复用同一批 host 服务实例——一本账、一份事件源。）
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
    backendHttp: "http://127.0.0.1:3030", // 已退役（同进程直连改造后仅留注释位，不再连接）
    backendWs: "ws://127.0.0.1:3030/ws",
    desktopUrl: "ws://127.0.0.1:4311/mobile-rpc", // 桌面端 host 本地 RPC 桥服务
    desktopToken: null, // 缺省与配对令牌 CFG.token 同值（supervisor 可经 BRIDGE_DESKTOP_TOKEN 覆盖）
    snapshotDir: path.join(HERE, "remote_v4"),
    workspacePath: process.cwd(),
    workspaceLabel: "ZCodium",
    publicBaseUrl: null, // 例如 https://xx.de5.net（隧道时设置；缺省按请求 Host）
    logDir: path.join(HERE, "logs"),
    debugFrames: false,
    provider: "glm",
    // Server酱³ 推送（沿用既有配置；enabled 由该文件控制）
    notifyConfigPath: "C:\\Users\\Bingcan Lin\\AppData\\Local\\ZCode\\serverchan-notify.json",
    debugAgent: false, // 临时：抓取 zcode-agent 请求与事件结构（BRIDGE_DEBUG_AGENT=1）
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
  if (process.env.BRIDGE_DESKTOP_URL) cfg.desktopUrl = process.env.BRIDGE_DESKTOP_URL;
  if (process.env.BRIDGE_DESKTOP_TOKEN) cfg.desktopToken = process.env.BRIDGE_DESKTOP_TOKEN;
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

// ── desktopLink：桌面端 host 本地 RPC 桥（同进程直连改造，替代独立后端 /ws）────
// 协议：call/listen/unlisten → res/err/evt（见 host/mobileRpcBridgeServer.ts）。
// 断线：pending 全部快速失败、事件表清空、onDown 通知上层（页面连接随之下线重连重订阅）。
const DIRECT_LISTEN = new Set([
  "zcode-agent.onAgentRuntimeLifecycle",
  "zcode-agent.onAgentRuntimeRestarted",
  "broadcast.onMessage",
  "model-selection.onDidChange",
  "provider-settings.onDidChange",
]);
const desktopLink = (() => {
  const token = CFG.desktopToken || CFG.token;
  let ws = null;
  let seq = 0;
  let closed = false;
  const pending = new Map(); // linkId -> {resolve, reject, timer}
  const evtHandlers = new Map(); // listenId -> (data)=>void
  const downCallbacks = new Set();
  const openWaiters = new Set();
  const connected = () => Boolean(ws && ws.readyState === 1);
  function stringifyFrame(frame) {
    return JSON.stringify(frame, (_k, v) =>
      Buffer.isBuffer(v) || v instanceof Uint8Array ? { __b64: Buffer.from(v).toString("base64") } : v,
    );
  }
  function sendRaw(frame) {
    if (!connected()) return false;
    try {
      ws.send(stringifyFrame(frame));
      return true;
    } catch {
      return false;
    }
  }
  function ensureOpen(timeoutMs) {
    if (connected()) return Promise.resolve();
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        openWaiters.delete(onOpen);
        rej(new Error("desktop-link-timeout"));
      }, timeoutMs);
      const onOpen = () => {
        clearTimeout(timer);
        openWaiters.delete(onOpen);
        res();
      };
      openWaiters.add(onOpen);
    });
  }
  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(CFG.desktopUrl, { headers: { authorization: `Bearer ${token}` } });
    } catch (error) {
      log("desktop-link-connect-error", { msg: String(error).slice(0, 160) });
      setTimeout(connect, 3000);
      return;
    }
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      log("desktop-link-open", {});
      for (const cb of [...openWaiters]) {
        try { cb(); } catch {}
      }
    });
    ws.addEventListener("message", (ev) => {
      let f;
      try {
        f = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
      } catch {
        return;
      }
      if (!f || typeof f !== "object") return;
      if (f.t === "evt") {
        const h = evtHandlers.get(f.listenId);
        if (h) {
          try { h(f.data); } catch (e) { log("desktop-link-evt-error", { msg: String(e).slice(0, 160) }); }
        }
        return;
      }
      const w = pending.get(f.id);
      if (!w) return;
      pending.delete(f.id);
      clearTimeout(w.timer);
      if (f.t === "res") w.resolve(f.data);
      else w.reject(new Error(String(f.msg || "rpc-error").slice(0, 200)));
    });
    const down = () => {
      for (const [id, w] of pending) {
        pending.delete(id);
        clearTimeout(w.timer);
        w.reject(new Error("desktop-link-down"));
      }
      evtHandlers.clear();
      for (const cb of [...downCallbacks]) {
        try { cb(); } catch {}
      }
      if (!closed) setTimeout(connect, 3000);
    };
    ws.addEventListener("close", down);
    ws.addEventListener("error", () => { /* close 事件统一处理 */ });
  }
  function call(ch, me, args, timeoutMs = 10000) {
    return ensureOpen(6000).then(
      () =>
        new Promise((res, rej) => {
          const id = ++seq;
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`desktop-link-timeout:${ch}.${me}`));
          }, timeoutMs);
          pending.set(id, { resolve: res, reject: rej, timer });
          if (!sendRaw({ t: "call", id, ch, me, args })) {
            clearTimeout(timer);
            pending.delete(id);
            rej(new Error("desktop-link-down"));
          }
        }),
    );
  }
  function listen(ch, me, args, handler) {
    return ensureOpen(6000).then(() => {
      const id = ++seq;
      const mode = DIRECT_LISTEN.has(ch + "." + me) ? "direct" : "curried";
      if (!sendRaw({ t: "listen", id, ch, me, args, mode })) throw new Error("desktop-link-down");
      evtHandlers.set(id, handler);
      return id;
    });
  }
  function unlisten(id) {
    if (typeof id === "number" && id > 0) {
      sendRaw({ t: "unlisten", id });
      evtHandlers.delete(id);
    }
  }
  connect();
  return {
    call,
    listen,
    unlisten,
    connected,
    onDown(cb) {
      downCallbacks.add(cb);
      return () => downCallbacks.delete(cb);
    },
  };
})();

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
  ping() { this._raw(wsFrame(Buffer.alloc(0), 0x9)); } // 主动心跳：经 Cloudflare 隧道时保持长连接不被空闲掐断
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
  return [{ workspaceKey: CFG.workspacePath, workspacePath: CFG.workspacePath, label: CFG.workspaceLabel, kind: "local" }];
}
// 手机首页列表的数据源：同进程直连后取自桌面端 window-controller 服务（与桌面 UI 同一数据源）。
// 桌面端未就绪时返回空表——页面随后经 controller/tasks-index 订阅快照补齐，不影响可用性。
async function tasksPayload() {
  try {
    const result = await desktopLink.call("window-controller", "listTaskList", [
      { kind: "timeline", workspaceScopes: [{ workspacePath: CFG.workspacePath }], sortBy: "updated", limit: 200 },
    ], 6000);
    const items = Array.isArray(result && result.items) ? result.items : [];
    return items
      .filter((it) => it && it.meta && it.meta.taskId)
      .map((it) => {
        const m = it.meta;
        return {
          taskId: m.taskId,
          title: m.title || m.taskId,
          workspacePath: m.workspacePath || CFG.workspacePath,
          ...(m.workspaceIdentity ? { workspaceIdentity: m.workspaceIdentity } : {}),
          pinned: !!(it.membership && it.membership.pinned),
          archived: !!(it.membership && it.membership.archived),
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
          // 页面以 typeof unreadAt==='number' 判未读，0 不下发（会把全部标成未读）
          ...(typeof m.unreadAt === "number" && m.unreadAt > 0 ? { unreadAt: m.unreadAt } : {}),
          ...(m.status ? { status: m.status } : {}),
          ...(m.provider ? { provider: m.provider } : {}),
        };
      });
  } catch (e) {
    log("tasks-payload-error", { msg: String(e).slice(0, 160) });
    return [];
  }
}

const httpServer = http.createServer(async (req, res) => {
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
    return json(res, 200, { workspaces: workspacesPayload(), tasks: await tasksPayload(), initialViewState: { activeWorkspaceKey: CFG.workspacePath, updatedAt: Date.now() }, mobileViewState: { activeWorkspaceKey: CFG.workspacePath, updatedAt: Date.now() } });
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
    // 空闲保活：边缘按"有无数据帧"判空闲（协议 ping 不算数），每 25 秒补一个数据帧；
    // 页面在拿到 ready 后已摘掉 message 监听，未知类型会被浏览器直接丢弃，无副作用。
    this.pingTimer = setInterval(() => {
      try { conn.sendText(JSON.stringify({ type: "keep-alive", t: Date.now() })); } catch {}
      try { conn.ping(); } catch {}
    }, 25000);
    conn.onclose = () => { clearInterval(this.pingTimer); log("window-close", {}); };
  }
}

// ── 工作区 socket：持久层（id/ack/KeepAlive）服务端 + 数据面 desktopLink 直通 ─────
class WorkspaceRelay {
  constructor(conn) {
    this.conn = conn;
    this.lastPageId = 0; // 页面发来的最大 id，用于回 ack
    this.outId = 0;      // 桥发往页面的 id
    this.dead = false;
    this.debugFrames = !!CFG.debugFrames;
    this.cmdWindow = []; // 会话命令时间戳（限流闸：防页面卡循环反复拉起桌面会话）
    this.linkListens = new Map(); // 页面 EventListen rid → desktopLink listenId
    // 空闲保活：工作区 socket 每 25 秒补一个"数据帧"（协议 KeepAlive=9，页面解码器只上抛 Regular，安全）
    this.pingTimer = setInterval(() => {
      try { this.toPage(9, Buffer.alloc(0)); } catch {}
      try { this.conn.ping(); } catch {}
    }, 25000);
    log("workspace-open", {});
    this.offLinkDown = desktopLink.onDown(() => this.teardown("desktop-link-down"));

    conn.onmessage = (msg) => {
      if (typeof msg === "string") { log("workspace-text", { d: msg.slice(0, 160) }); return; }
      const buf = Buffer.from(msg);
      if (buf.length < 13) return;
      const type = buf.readUInt8(0);
      const id = buf.readUInt32BE(1);
      const len = buf.readUInt32BE(9);
      const body = buf.subarray(13, 13 + len);
      if (type === 1) { // Regular：RPC 帧统一改道 desktopLink；均立即回 Ack
        this.lastPageId = Math.max(this.lastPageId, id);
        if (this.debugFrames) log("ws-req", { len: body.length, head: body.subarray(0, 24).toString("hex") });
        let p = null;
        try { p = rpcParseFrame(body); } catch { /* 非 RPC 帧忽略 */ }
        const header = p && Array.isArray(p.header) ? p.header : null;
        this.toPage(3, Buffer.alloc(0), id);
        if (!header) return;
        const [tc, rid, ch, me] = header;
        log("rpc-in", { tc, rid, ch, me, len: body.length });
        if (tc === 100) {
          if (this.shouldDropFlood(tc, ch, me)) return;
          this.forwardCall(rid, ch, me, p.body);
        } else if (tc === 102) {
          this.forwardListen(rid, ch, me, p.body);
        } else if (tc === 103) {
          const lid = this.linkListens.get(rid);
          this.linkListens.delete(rid);
          if (typeof lid === "number") desktopLink.unlisten(lid);
        }
        return;
      }
      if (type === 9) { this.toPage(9, Buffer.alloc(0)); return; } // KeepAlive → 回 KeepAlive
      if (type === 3) return; // 页面对桥下行帧的 Ack：忽略
      if (type === 5) return this.teardown("page-disconnect");
      log("workspace-frame", { type, len });
    };
    conn.onclose = () => this.teardown("page-close");
  }
  // Promise 型 RPC：desktopLink 结果封装为 201/202 帧回页面（错误体形状与旧链路一致）
  forwardCall(rid, ch, me, args) {
    if (CFG.debugAgent && ch === "zcode-agent" && (me === "initializeConversationV4" || me === "subscribeSessionsIndexV4")) {
      try { fs.writeFileSync(path.join(HERE, `handshake_${me}.json`), JSON.stringify(args)); log("handshake-captured", { me }); } catch {}
    }
    desktopLink
      .call(ch, me, args)
      .then((data) => {
        if (this.dead) return;
        this.toPage(1, Buffer.concat([rpcSerialize([201, rid]), rpcSerialize(data === undefined ? null : data)]));
      })
      .catch((error) => {
        if (this.dead) return;
        this.toPage(1, Buffer.concat([rpcSerialize([202, rid]), rpcSerialize({ message: String((error && error.message) || error).slice(0, 300), name: "Error" })]));
        log("call-error", { ch, me, msg: String((error && error.message) || error).slice(0, 160) });
      });
  }
  // 事件订阅（EventListen=102）：注册 desktopLink.listen；事件以 [204, 页面rid] 帧回页面
  forwardListen(rid, ch, me, args) {
    desktopLink
      .listen(ch, me, args, (data) => {
        if (this.dead) return;
        this.toPage(1, Buffer.concat([rpcSerialize([204, rid]), rpcSerialize(data === undefined ? null : data)]));
      })
      .then((lid) => {
        if (this.dead) { desktopLink.unlisten(lid); return; }
        this.linkListens.set(rid, lid);
      })
      .catch((error) => {
        if (this.dead) return;
        this.toPage(1, Buffer.concat([rpcSerialize([202, rid]), rpcSerialize({ message: String((error && error.message) || error).slice(0, 300), name: "Error" })]));
        log("listen-error", { ch, me, msg: String((error && error.message) || error).slice(0, 160) });
      });
  }
  // 限流闸：同一页面 60 秒内发超过 25 次会话命令即判"卡循环"，后续命令丢弃（仍回 Ack 保持连接），
  // 避免桌面端被反复拉起会话进程（2026-09-29 实测页面卡循环 48 次/分钟引发）。
  shouldDropFlood(tc, ch, me) {
    if (tc !== 100 || ch !== "zcode-agent" || me !== "sendConversationCommandV4") return false;
    const now = Date.now();
    this.cmdWindow = (this.cmdWindow || []).filter((t) => now - t < 60000);
    this.cmdWindow.push(now);
    if (this.cmdWindow.length > 25) {
      if (!this.cmdFloodLogged || now - this.cmdFloodLogged > 60000) {
        this.cmdFloodLogged = now;
        log("agent-command-flood", { count: this.cmdWindow.length, action: "drop" });
      }
      return true;
    }
    return false;
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
    try { this.offLinkDown && this.offLinkDown(); } catch {}
    for (const lid of this.linkListens.values()) {
      try { desktopLink.unlisten(lid); } catch {}
    }
    this.linkListens.clear();
    if (this.pingTimer) { try { clearInterval(this.pingTimer); } catch {} this.pingTimer = null; }
    try { this.conn.close(1000); } catch {}
    log("workspace-close", { why });
  }
}

// ── 后端进程托管已退役（同进程直连改造 2026-09-30）：数据面=desktopLink ─────

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
let notifySubCancel = null;
// Server酱³ 推送订阅（同进程直连版）：数据源=桌面端 sessions-index。
// 桌面 host 的 wire 帧形状为 {frame:{payload:{snapshot|deltas}}}（与旧 EventFire 内层一致），
// 做一层防御：若 host 直接推 payload 本体也兼容。
function handleNotifyWire(data) {
  try {
    const frame = (data && data.frame) ? data.frame : data;
    const payload = frame && frame.payload;
    const snap = payload && payload.snapshot;
    if (snap && Array.isArray(snap.sessions)) {
      const wasSeeded = notifySeeded;
      handleSessionsSnapshot(snap.sessions);
      if (!wasSeeded) { notifySeeded = true; saveNotifyState(); log("notify-seeded", { n: snap.sessions.length }); }
    }
    const delta = payload && payload.deltas;
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
  } catch (e) {
    log("notify-wire-error", { msg: String(e).slice(0, 160) });
  }
}
function startNotifySubscription() {
  const cfg = loadNotifyConfig();
  if (!cfg || !cfg.enabled) { log("notify-disabled", { path: CFG.notifyConfigPath }); return; }
  if (notifySubCancel) {
    try { notifySubCancel(); } catch {}
  }
  let done = false;
  const retryLater = () => {
    if (done) return;
    done = true;
    try { offDown(); } catch {}
    notifySubCancel = null;
    setTimeout(startNotifySubscription, 5000);
  };
  const offDown = desktopLink.onDown(retryLater);
  notifySubCancel = () => { done = true; try { offDown(); } catch {} };
  (async () => {
    await desktopLink.call("zcode-agent", "helloConversationV4", []);
    await desktopLink.call("zcode-agent", "initializeConversationV4", [{ kind: "clientHello", protocolVersion: 3, clientId: "client-" + crypto.randomUUID(), clientKind: "web", appVersion: "unknown", capabilities: { workspaceHookReviewUi: true } }]);
    const listenId = await desktopLink.listen("zcode-agent", "onDynamicSessionsIndexFrame", { workspacePath: CFG.workspacePath }, handleNotifyWire);
    await desktopLink.call("zcode-agent", "subscribeSessionsIndexV4", [{ workspacePath: CFG.workspacePath, runtimePolicy: "start-if-needed" }]);
    log("notify-subscribed", { workspacePath: CFG.workspacePath, listenId });
  })().catch((error) => {
    log("notify-sub-error", { msg: String((error && error.message) || error).slice(0, 200) });
    retryLater();
  });
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
      ttl: 60, // 短 TTL：隧道换址后手机端最多 1 分钟就拿到新地址（600s 的旧值会让手机长时间连到已停的隧道）
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
  // --protocol http2：走 TCP 443，避开 QUIC/UDP 在国内被重置导致的隧道"连上即断"。
  tunnelState.mode = "quick";
  const child = spawn(
    cfg.cloudflaredPath,
    ["tunnel", "--url", `http://127.0.0.1:${CFG.port}`, "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4"],
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
process.on("SIGINT", () => process.exit(0));
