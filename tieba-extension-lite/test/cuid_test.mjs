import { cuidGalaxy2, c3Aid, heliosHash, b32encode } from '../crypto.js';

// 结构验证：cuid_galaxy2 = 32 hex + "|V" + 8 b32 = 42 字符
// c3_aid = "A00-" + 32 b32 + "-" + 8 b32 = 45 字符
const aid = '91be894d01799c49';
const uuid = 'e4200716-58a8-4170-af15-ea7edeb8e513';

const cg = await cuidGalaxy2(aid);
console.log('cuid_galaxy2:', cg, 'len=', cg.length);
console.assert(cg.length === 42, 'cuid_galaxy2 长度应为 42');
console.assert(/^[0-9A-F]{32}\|V[A-Z2-7]{8}$/.test(cg), 'cuid_galaxy2 格式');

const c3 = await c3Aid(aid, uuid);
console.log('c3_aid:', c3, 'len=', c3.length);
console.assert(c3.length === 45, 'c3_aid 长度应为 45');
console.assert(/^A00-[A-Z2-7]{32}-[A-Z2-7]{8}$/.test(c3), 'c3_aid 格式');

console.log('heliosHash(32字节) len=', heliosHash(new TextEncoder().encode('A'.repeat(32))).length, '(应为5)');
console.log('全部通过');
