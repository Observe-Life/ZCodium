// bridge-probe.mjs — 手机页面模拟器：走完整链路（REST→握手→bootstrap→bridge-open→rpc 往返）
import crypto from "node:crypto";
import { serialize, deserialize, parseFrame, buildRequest } from "./zcode-codec.mjs";

const TOKEN = process.env.BRIDGE_TOKEN || "test-token-1234567890";
const SID = process.env.BRIDGE_SID || "d_probe";
const BASE = process.env.BRIDGE_BASE || "http://127.0.0.1:4310";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ✔ ${name}`); } else { fail++; console.log(`  ✘ ${name} ${extra}`); } };
const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcT[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0"); }

console.log("[1] REST bootstrap");
const boot = await fetch(`${BASE}/api/remote-control/windows/bootstrap/${TOKEN}`);
const bootJson = await boot.json();
ok("bootstrap 200 + workspaces", boot.status === 200 && Array.isArray(bootJson.workspaces) && bootJson.workspaces.length > 0, JSON.stringify(bootJson).slice(0, 120));

console.log("[2] REST workspace-bridge → wsUrl");
const br = await fetch(`${BASE}/api/remote-control/windows/${TOKEN}/workspace-bridge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceKey: "ws-local" }) });
const brJson = await br.json();
ok("wsUrl 返回", br.status === 200 && typeof brJson.wsUrl === "string", JSON.stringify(brJson));

console.log("[3] WS 连接与握手");
let authAck, frameRes, ackRes;
const authP = new Promise((r) => (authAck = r));
const ws = new WebSocket(brJson.wsUrl + `?sid=${SID}`);
ws.binaryType = "arraybuffer";
let seq = 0, msgSeq = 0, nonce = null, bridgeSessionId = "bridge-probe-" + crypto.randomUUID();
const pending = new Map();
function sendPayload(obj) { ws.send(JSON.stringify({ type: "data", payload: obj, client_ts: Date.now() })); }
function sendRpc(bodyBuf) {
  seq++; msgSeq++;
  sendPayload({ zcode_type: "rpc-frame", bridgeSessionId, bridgeGeneration: 1, seq, messageSeq: msgSeq, fragmentIndex: 0, fragmentCount: 1, messageBytes: bodyBuf.length, checksum: { algorithm: "crc32", value: crc32(bodyBuf) }, dataBase64: bodyBuf.toString("base64") });
}
ws.addEventListener("message", (ev) => {
  let env; try { env = JSON.parse(ev.data); } catch { return; }
  if (env.type === "auth_challenge") {
    nonce = env.nonce;
    const proof = crypto.createHmac("sha256", TOKEN).update(`${nonce}|terminal|${SID}`).digest("base64url");
    ws.send(JSON.stringify({ type: "auth_response", device_sid: SID, proof, client_ts: Date.now() }));
    return;
  }
  if (env.type === "auth_ack") { authAck(env.pair_status); return; }
  if (env.type !== "data") return;
  const p = env.payload;
  const res = pending.get(p.requestId);
  if (res) { pending.delete(p.requestId); res(p); return; }
  if (p.zcode_type === "rpc-frame") {
    const body = Buffer.from(p.dataBase64, "base64");
    const ck = crc32(body) === (p.checksum && p.checksum.value);
    frameRes({ ok: ck, frame: parseFrame(body) });
  }
  if (p.zcode_type === "rpc-frame-ack") ackRes && (ackRes(p), ackRes = null);
});
ok("auth_ack(paired)", (await Promise.race([authP, new Promise((r) => setTimeout(() => r("timeout"), 4000))])) === "paired");

function request(zt, extra = {}) {
  const requestId = "req-" + crypto.randomUUID();
  const p = new Promise((r) => pending.set(requestId, r));
  sendPayload({ zcode_type: zt, requestId, ...extra });
  return p;
}
console.log("[4] bootstrap-request/response");
const bs = await request("bootstrap-request");
ok("bootstrap-response", bs.zcode_type === "bootstrap-response" && bs.success === true && !!bs.result?.windowControlSessionId, JSON.stringify(bs).slice(0, 150));

console.log("[5] workspace-bridge-open/ready");
const ready = await request("workspace-bridge-open", { bridgeSessionId, workspaceKey: "ws-local" });
ok("workspace-bridge-ready", ready.zcode_type === "workspace-bridge-ready" && !!ready.bridge, JSON.stringify(ready).slice(0, 150));

console.log("[6] rpc-frame 往返（zcode-task.listTasks → mock echo）");
const frameP = new Promise((r) => { frameRes = r; });
const ackP = new Promise((r) => { ackRes = r; });
sendRpc(buildRequest(77, "zcode-task", "listTasks", null));
const ack = await Promise.race([ackP, new Promise((r) => setTimeout(() => r(null), 3000))]);
ok("rpc-frame-ack", !!ack && ack.ackMessageSeq === msgSeq, JSON.stringify(ack || {}));
const fr = await Promise.race([frameP, new Promise((r) => setTimeout(() => r(null), 4000))]);
ok("rpc-frame 响应且 crc 正确", !!fr && fr.ok && fr.frame && fr.frame.header[0] === 201 && fr.frame.header[1] === 77 && fr.frame.body?.echo?.method === "listTasks", JSON.stringify(fr || {}).slice(0, 200));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
