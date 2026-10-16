import { md5 } from '../crypto.js';

function toHex(b) { return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }

// MD5 test vectors
const cases = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
];
let fail = 0;
for (const [input, expected] of cases) {
  const got = toHex(await md5(new TextEncoder().encode(input)));
  if (got === expected) console.log('PASS md5(' + JSON.stringify(input) + ')');
  else { console.log('FAIL md5(' + JSON.stringify(input) + ') got=' + got + ' expected=' + expected); fail++; }
}
process.exit(fail ? 1 : 0);
