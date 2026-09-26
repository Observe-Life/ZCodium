// backend-mock.mjs — 假 zcode --web：127.0.0.1:3030 /ws，13 字节帧头 + RPC 直通应答（仅 Phase 1 验收用）
import http from "node:http";
import crypto from "node:crypto";
import { parseFrame, buildResponse } from "./zcode-codec.mjs";

const PORT = 3030;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}
function decodeFrames(state, chunk, onMessage) {
  state.buf = Buffer.concat([state.buf, chunk]);
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return;
    const op = b[0] & 0x0f;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const masked = (b[1] & 0x80) !== 0;
    let mask = null;
    if (masked) { if (b.length < off + 4) return; mask = b.subarray(off, off + 4); off += 4; }
    if (b.length < off + len) return;
    let payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    state.buf = b.subarray(off + len);
    if (op === 0x8) { state.closed = true; onMessage(null); return; }
    if (op === 0x9) { state.sock.write(encodeFrame(payload, 0xa)); continue; }
    if (op === 0x1 || op === 0x2) onMessage(payload);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/api/server-info") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ mock: true })); }
  res.writeHead(404); res.end();
});
server.on("upgrade", (req, socket) => {
  if (!/^\/ws/.test(req.url)) { socket.destroy(); return; }
  const key = req.headers["sec-websocket-key"];
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${crypto.createHash("sha1").update(key + GUID).digest("base64")}\r\n\r\n`);
  socket.setNoDelay(true);
  const state = { buf: Buffer.alloc(0), sock: socket, closed: false };
  decodeFrames(state, Buffer.alloc(0), () => {});
  socket.on("data", (chunk) => decodeFrames(state, chunk, (msg) => {
    if (msg === null) { socket.end(); return; }
    if (msg.length < 13) return;
    const type = msg.readUInt8(0);
    const len = msg.readUInt32BE(9);
    if (type !== 1) return;
    const body = msg.subarray(13, 13 + len);
    let frame; try { frame = parseFrame(body); } catch (e) { console.log("[mock] parse fail", String(e)); return; }
    const [tcode, id, channel, method] = frame.header;
    console.log(`[mock] RPC type=${tcode} id=${id} channel=${channel} method=${method}`);
    if (tcode === 100) {
      const result = { ok: true, mock: true, echo: { channel, method, id } };
      const respBody = buildResponse(id, result);
      const head = Buffer.alloc(13);
      head.writeUInt8(1, 0); head.writeUInt32BE(0, 1); head.writeUInt32BE(0, 5); head.writeUInt32BE(respBody.length, 9);
      socket.write(encodeFrame(Buffer.concat([head, respBody]), 0x2));
    }
  }));
  socket.on("error", () => {});
});
server.listen(PORT, "127.0.0.1", () => console.log(`[mock] backend ws://127.0.0.1:${PORT}/ws ready`));
