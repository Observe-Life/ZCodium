// zcode-codec.mjs — ZCode RPC 二进制编解码（与 serialization.ts / rpc_codec.dart 同格式）
// tag: 0 null/undefined, 1 string, 2/3 binary, 4 array, 5 object(JSON), 6 int(varint)
// 帧 = serialize(header) + serialize(body)，header = [type,id,channel,method] 或 [type,id]

export function writeVarint(out, v) {
  if (v === 0) { out.push(0); return; }
  let uv = BigInt(v < 0 ? 0 : v);
  while (uv > 0n) {
    let b = Number(uv & 0x7fn);
    uv >>= 7n;
    if (uv > 0n) b |= 0x80;
    out.push(b);
  }
}
export function readVarint(buf, pos) {
  let value = 0n, shift = 0n, i = pos;
  for (;;) {
    const b = buf[i++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (i - pos > 10) throw new Error("varint too long");
  }
  return { value: Number(value), next: i };
}
export function serialize(value) {
  const out = [];
  ser(value, out);
  return Buffer.from(out);
}
function ser(v, out) {
  if (v === null || v === undefined) { out.push(0); return; }
  if (typeof v === "number") { out.push(6); writeVarint(out, v); return; }
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    out.push(1); writeVarint(out, b.length); out.push(...b); return;
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    out.push(2); writeVarint(out, v.length); out.push(...v); return;
  }
  if (Array.isArray(v)) {
    out.push(4); writeVarint(out, v.length);
    for (const item of v) ser(item, out);
    return;
  }
  if (typeof v === "object") {
    const b = Buffer.from(JSON.stringify(v), "utf8");
    out.push(5); writeVarint(out, b.length); out.push(...b); return;
  }
  out.push(0);
}
export function deserialize(buf, pos = 0) {
  const tag = buf[pos++];
  switch (tag) {
    case 0: return { value: null, next: pos };
    case 6: { const r = readVarint(buf, pos); return { value: r.value, next: r.next }; }
    case 1: {
      const l = readVarint(buf, pos); const s = buf.subarray(l.next, l.next + l.value).toString("utf8");
      return { value: s, next: l.next + l.value };
    }
    case 2: case 3: {
      const l = readVarint(buf, pos);
      return { value: Buffer.from(buf.subarray(l.next, l.next + l.value)), next: l.next + l.value };
    }
    case 4: {
      const n = readVarint(buf, pos); let i = n.next; const arr = [];
      for (let k = 0; k < n.value; k++) { const r = deserialize(buf, i); arr.push(r.value); i = r.next; }
      return { value: arr, next: i };
    }
    case 5: {
      const l = readVarint(buf, pos);
      const s = JSON.parse(buf.subarray(l.next, l.next + l.value).toString("utf8"));
      return { value: s, next: l.next + l.value };
    }
    default: throw new Error("bad tag " + tag);
  }
}
// 解析一整帧（header + body）
export function parseFrame(buf) {
  const h = deserialize(buf, 0);
  const b = h.next >= buf.length ? { value: undefined, next: buf.length } : deserialize(buf, h.next);
  return { header: h.value, body: b.value };
}
// 构造请求帧：[100,id,channel,method] + args
export function buildRequest(id, channel, method, args) {
  return Buffer.concat([serialize([100, id, channel, method]), serialize(args === undefined ? null : args)]);
}
// 构造响应帧：[201,id] + result
export function buildResponse(id, result) {
  return Buffer.concat([serialize([201, id]), serialize(result)]);
}
