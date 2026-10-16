// 测试 crypto.js 的底层算法（crc32 / xxh32 / base32）
import { crc32, xxh32, b32encode } from '../crypto.js';

let fail = 0;
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log('PASS', name);
  else { console.log('FAIL', name, 'actual=', a, 'expected=', e); fail++; }
}

// CRC32 test vector: "123456789" -> 0xCBF43926
assertEq('crc32("123456789")', crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
assertEq('crc32("")', crc32(new TextEncoder().encode('')), 0);

// xxHash32 test vectors (seed 0)
// xxh32("") = 0x02CC5D05
assertEq('xxh32("")', xxh32(new TextEncoder().encode('')), 0x02CC5D05);
// xxh32("a") = 0x550D7456
assertEq('xxh32("a")', xxh32(new TextEncoder().encode('a')), 0x550D7456);
// xxh32("abc") = 0x32D153FF
assertEq('xxh32("abc")', xxh32(new TextEncoder().encode('abc')), 0x32D153FF);
// xxh32("123456789") = 0xB6855437? Actually standard is different; use known:
// xxh32("The quick brown fox jumps over the lazy dog") = 0x... let's skip long one

// base32 (RFC4648 no-pad) test: "foobar" -> MZXW6YTBOI======
// 但我们的 alphabet 是 A-Z2-7（同 RFC4648），无 padding
// "foobar" -> "MZXW6YTBOI"
assertEq('b32encode("foobar")', b32encode(new TextEncoder().encode('foobar')), 'MZXW6YTBOI');

process.exit(fail ? 1 : 0);
