/**
 * 极简 protobuf 编解码器（仅覆盖本项目用到的类型：varint / string / bytes / message）
 * wire type: 0=varint, 2=length-delimited
 */

export function encodeVarint(v) {
  // 支持 number 或 BigInt；负数按 64 位二补码编码（proto3 的 int32/int64 语义，
  // 如 start_type=-1 → 10 字节 varint），否则会死循环导致 "Invalid array length"
  let n = typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)));
  if (n < 0n) n += 1n << 64n; // 转为无符号 64 位二补码
  const bytes = [];
  while (true) {
    const b = Number(n & 0x7fn);
    n >>= 7n;
    if (n === 0n) { bytes.push(b); break; }
    bytes.push(b | 0x80);
  }
  return Uint8Array.from(bytes);
}

export function decodeVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (true) {
    const b = buf[i++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return [result, i];
}

export function encodeKey(field, wireType) {
  return encodeVarint((BigInt(field) << 3n) | BigInt(wireType));
}

export function encodeBytesField(field, bytes) {
  const k = encodeKey(field, 2);
  const len = encodeVarint(bytes.length);
  const out = new Uint8Array(k.length + len.length + bytes.length);
  out.set(k, 0); out.set(len, k.length); out.set(bytes, k.length + len.length);
  return out;
}

export function encodeStringField(field, str) {
  return encodeBytesField(field, new TextEncoder().encode(str));
}

export function encodeVarintField(field, v) {
  const k = encodeKey(field, 0);
  const val = encodeVarint(v);
  const out = new Uint8Array(k.length + val.length);
  out.set(k, 0); out.set(val, k.length);
  return out;
}

export function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

/** 解析一个 message 为字段数组 [{field, wireType, value}] */
export function parseFields(buf) {
  const fields = [];
  let i = 0;
  while (i < buf.length) {
    const [key, afterKey] = decodeVarint(buf, i);
    i = afterKey;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let value;
    if (wire === 0) {
      const [v, ni] = decodeVarint(buf, i);
      value = v;
      i = ni;
    } else if (wire === 2) {
      const [len, ni] = decodeVarint(buf, i);
      i = ni;
      const n = Number(len);
      value = buf.slice(i, i + n);
      i += n;
    } else if (wire === 1) {
      value = buf.slice(i, i + 8); i += 8;
    } else if (wire === 5) {
      value = buf.slice(i, i + 4); i += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
    fields.push({ field, wireType: wire, value });
  }
  return fields;
}

export function findField(fields, fieldNum) {
  return fields.find(f => f.field === fieldNum);
}
export function findFields(fields, fieldNum) {
  return fields.filter(f => f.field === fieldNum);
}
export function bytesToString(bytes) {
  return new TextDecoder().decode(bytes);
}
