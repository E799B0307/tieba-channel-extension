/**
 * crypto.js — 移植自 aiotieba/helper/crypto（C 源码反推）
 * 包含：
 *   - md5 / sha1（用 WebCrypto）
 *   - crc32
 *   - xxHash32（heliosHash 依赖）
 *   - heliosHash（cuid_galaxy2 / c3_aid 核心）
 *   - base32 非标准编码（无 padding，自定义 alphabet）
 *   - cuid_galaxy2 / c3_aid
 *   - rc4_42（暂用不到，预留）
 *   - sign（贴吧客户端签名）
 *   - enuid（login 第二部分使用，urlsafe-base64 变种，需抓包验证）
 */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 贴吧自定义 base32（无 padding） */
export function b32encode(bytes) {
  let out = '';
  let buffer = 0;
  let bitsLeft = 0;
  let idx = 0;
  while (bitsLeft > 0 || idx < bytes.length) {
    if (bitsLeft < 5) {
      if (idx < bytes.length) {
        buffer = ((buffer << 8) | bytes[idx++]) >>> 0;
        bitsLeft += 8;
      } else {
        const pad = 5 - bitsLeft;
        buffer = (buffer << pad) >>> 0;
        bitsLeft += pad;
      }
    }
    const index = (buffer >> (bitsLeft - 5)) & 0x1f;
    bitsLeft -= 5;
    out += B32_ALPHABET[index];
  }
  return out;
}

/* ---------- CRC32 (IEEE, poly 0xEDB88320) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, prev = 0) {
  let crc = (~prev) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (~crc) >>> 0;
}

/* ---------- xxHash32 (seed=0) ---------- */
function rotl32(x, r) { return ((x << r) | (x >>> (32 - r))) >>> 0; }
function u32(v) { return v >>> 0; }
const XXH_PRIME32_1 = 0x9E3779B1, XXH_PRIME32_2 = 0x85EBCA77, XXH_PRIME32_3 = 0xC2B2AE3D,
      XXH_PRIME32_4 = 0x27D4EB2F, XXH_PRIME32_5 = 0x165667B1;

function xxh32Round(acc, lane) {
  acc = u32(acc + Math.imul(lane, XXH_PRIME32_2));
  acc = rotl32(acc, 13);
  acc = Math.imul(acc, XXH_PRIME32_1);
  return acc;
}
function xxh32Avalanche(h) {
  h ^= h >>> 15; h = Math.imul(h, XXH_PRIME32_2);
  h ^= h >>> 13; h = Math.imul(h, XXH_PRIME32_3);
  h ^= h >>> 16;
  return h >>> 0;
}

/** data: Uint8Array；多段数据通过多次调用拼接为逻辑流（state 简化：直接拼 buffer） */
export function xxh32(data, seed = 0) {
  const len = data.length;
  let h;
  let i = 0;
  const rd = o => (data[o] | data[o+1]<<8 | data[o+2]<<16 | data[o+3]<<24) >>> 0;
  if (len >= 16) {
    let v1 = u32(seed + XXH_PRIME32_1 + XXH_PRIME32_2);
    let v2 = u32(seed + XXH_PRIME32_2);
    let v3 = u32(seed);
    let v4 = u32(seed - XXH_PRIME32_1);
    while (i + 16 <= len) {
      v1 = xxh32Round(v1, rd(i));
      v2 = xxh32Round(v2, rd(i+4));
      v3 = xxh32Round(v3, rd(i+8));
      v4 = xxh32Round(v4, rd(i+12));
      i += 16;
    }
    h = u32(rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18));
  } else {
    h = u32(seed + XXH_PRIME32_5);
  }
  h = u32(h + len);
  // remaining 4-byte chunks
  while (i + 4 <= len) {
    h = u32(h + Math.imul(rd(i), XXH_PRIME32_3));
    h = rotl32(h, 17);
    h = Math.imul(h, XXH_PRIME32_4);
    i += 4;
  }
  while (i < len) {
    h = u32(h + Math.imul(data[i], XXH_PRIME32_5));
    h = rotl32(h, 11);
    h = Math.imul(h, XXH_PRIME32_1);
    i++;
  }
  return xxh32Avalanche(h);
}

/* ---------- MD5 / SHA1 ---------- */
// MD5 用纯 JS 实现（Node 的 WebCrypto 不支持 MD5，Chrome 支持但为跨环境统一用纯 JS）
// SHA1 用 WebCrypto（Node/Chrome 均支持）

export async function md5(bytes) {
  return md5Pure(bytes);
}

export async function sha1(bytes) {
  const h = await crypto.subtle.digest('SHA-1', bytes);
  return new Uint8Array(h);
}

/* 纯 JS MD5（标准 RFC1321） */
function md5Pure(input) {
  const data = input instanceof Uint8Array ? input : new TextEncoder().encode(String(input));
  const msg = new Uint8Array(data.length + 72);
  msg.set(data);
  const len = data.length;
  msg[len] = 0x80;
  const bitLen = len * 8;
  // 追加长度（little-endian 64bit），位置在填充后的最后 8 字节
  const totalLen = (((len + 8) >> 6) + 1) << 6; // 补到 64 的倍数
  const padded = new Uint8Array(totalLen);
  padded.set(data);
  padded[len] = 0x80;
  // 写入 64-bit 长度（低 32 位 + 高 32 位）
  const dv = new DataView(padded.buffer);
  dv.setUint32(totalLen - 8, bitLen >>> 0, true);
  dv.setUint32(totalLen - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  const S = [7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
             5,9,14,20, 5,9,14,20, 5,9,14,20, 5,9,14,20,
             4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
             6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

  function rotl(x, c) { return ((x << c) | (x >>> (32 - c))) >>> 0; }

  for (let off = 0; off < totalLen; off += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = dv.getUint32(off + j * 4, true);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return out;
}

/* ---------- HeliosHash ---------- */
const STEP_SIZE = 5;
const HASH_BITS = 32;

function tbcUpdate(sec, hashVal, start, flag) {
  // sec 为 BigInt(40 位)
  const end = BigInt(start + HASH_BITS);
  const var9 = (1n << end) - 1n;
  let var5 = (var9 & sec) >> BigInt(start);
  if (flag) var5 ^= BigInt(hashVal >>> 0); else var5 &= BigInt(hashVal >>> 0);

  let secTemp = sec;
  for (let i = 0; i < HASH_BITS; i++) {
    const opIdx = BigInt(start + i);
    if (var5 & (1n << BigInt(i))) secTemp |= (1n << opIdx);
    else secTemp &= ~(1n << opIdx);
  }
  return secTemp;
}

function writeBuffer(buffer, offset, sec) {
  let tmp = sec;
  for (let i = 0; i < STEP_SIZE; i++) {
    buffer[offset + i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
}

/** src: Uint8Array；返回 5 字节 helios hash */
export function heliosHash(src) {
  let sec = (1n << 40n) - 1n;               // -1L >>> -40L
  const buffer = new Uint8Array(STEP_SIZE * 4);
  buffer.fill(0xff, 0, STEP_SIZE);          // [-1*5, ...]

  // 1. CRC32
  let crc = crc32(src, 0);
  crc = crc32(buffer.subarray(0, STEP_SIZE), crc);
  sec = tbcUpdate(sec, crc, 8, false);
  writeBuffer(buffer, STEP_SIZE, sec);      // [-1*5, crc, ...]

  // 2. xxHash32(src + buffer[0..10])
  const xxInput2 = new Uint8Array(src.length + STEP_SIZE * 2);
  xxInput2.set(src, 0);
  xxInput2.set(buffer.subarray(0, STEP_SIZE * 2), src.length);
  const xx2 = xxh32(xxInput2, 0);
  sec = tbcUpdate(sec, xx2, 0, true);
  writeBuffer(buffer, STEP_SIZE * 2, sec);  // [-1*5, crc, xx, ...]

  // 3. xxHash32(state of step2 + buffer[10..15])
  //    C 代码：xxState4StepThree 是 step2 状态副本，再 update(buffer[10..15])
  //    等价于 xxh32(src + buffer[0..10] + buffer[10..15]) = xxh32(src + buffer[0..15])
  const xxInput3 = new Uint8Array(src.length + STEP_SIZE * 3);
  xxInput3.set(src, 0);
  xxInput3.set(buffer.subarray(0, STEP_SIZE * 3), src.length);
  const xx3 = xxh32(xxInput3, 0);
  sec = tbcUpdate(sec, xx3, 1, true);
  writeBuffer(buffer, STEP_SIZE * 3, sec);  // [-1*5, crc, xx, xx]

  // 4. CRC32(buffer[5..20], prev=crc)
  crc = crc32(buffer.subarray(STEP_SIZE, STEP_SIZE * 4), crc);
  sec = tbcUpdate(sec, crc, 7, true);

  const out = new Uint8Array(STEP_SIZE);
  writeBuffer(out, 0, sec);
  return out;
}

/* ---------- cuid_galaxy2 / c3_aid ---------- */
function toHexUpper(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

export async function cuidGalaxy2(androidId) {
  // androidId: 16 位小写 hex 字符串
  const prefix = new TextEncoder().encode('com.baidu');
  const aid = new TextEncoder().encode(androidId);
  const md5Input = new Uint8Array(prefix.length + aid.length);
  md5Input.set(prefix, 0);
  md5Input.set(aid, prefix.length);
  const md5Bytes = await md5(md5Input);
  const md5Hex = toHexUpper(md5Bytes);          // 32 字节大写 hex

  // heliosHash 输入是 32 字节 ASCII
  const heHash = heliosHash(new TextEncoder().encode(md5Hex));
  return md5Hex + '|V' + b32encode(heHash);
}

export async function c3Aid(androidId, uuid) {
  // androidId: 16 字符 hex，uuid: 36 字符
  const prefix = new TextEncoder().encode('com.helios');
  const aid = new TextEncoder().encode(androidId);
  const uu = new TextEncoder().encode(uuid);
  const sha1Input = new Uint8Array(prefix.length + aid.length + uu.length);
  sha1Input.set(prefix, 0);
  sha1Input.set(aid, prefix.length);
  sha1Input.set(uu, prefix.length + aid.length);
  const sha1Bytes = await sha1(sha1Input);
  const sha1B32 = b32encode(sha1Bytes);         // 32 字符

  // heliosHash 输入是 'A00-' + sha1B32 + '-'（4 + 32 + 1 = 37 字节）
  const head = new TextEncoder().encode('A00-' + sha1B32 + '-');
  const heHash = heliosHash(head);
  return 'A00-' + sha1B32 + '-' + b32encode(heHash);
}

/* ---------- enuid（libbase64encoder_v2_0.so 变种 base64） ----------
 * 逆向：百度 EnUid 对 cuid_galaxy2 做 base64url（去 padding）
 * 待真机抓包验证；如果不匹配再调整字母表
 */
export function enuid(cuidGalaxy2) {
  const bytes = new TextEncoder().encode(cuidGalaxy2);
  // 标准 base64
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  // urlsafe + 去 padding
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---------- rc4_42 ---------- */
export function rc4_42(keyStr, data) {
  // keyStr: 32 字节 md5 hex 字符串
  const key = new TextEncoder().encode(keyStr);
  const m = new Uint8Array(256);
  for (let i = 0; i < 256; i++) m[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + m[i] + key[i % key.length]) & 0xff;
    [m[i], m[j]] = [m[j], m[i]];
  }
  let x = 0, y = 0;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    x = (x + 1) & 0xff;
    const a = m[x];
    y = (y + a) & 0xff;
    const b = m[y];
    m[x] = b; m[y] = a;
    out[i] = (data[i] ^ m[(a + b) & 0xff]) ^ 42;
  }
  return out;
}

/* ---------- 贴吧客户端签名 ----------
 * data: Array<[string, string|number]>
 * 返回 md5(key1=value1 key2=value2 ... tieba-client!!!) 小写 hex
 */
export async function tbSign(data) {
  const encoder = new TextEncoder();
  const parts = [];
  for (const [k, v] of data) {
    parts.push(encoder.encode(k + '='));
    parts.push(encoder.encode(String(v)));
  }
  parts.push(encoder.encode('tieba-client!!!'));
  const total = parts.reduce((s, a) => s + a.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.length; }
  const h = await md5(buf);
  return Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
}
