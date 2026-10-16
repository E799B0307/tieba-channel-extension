// 测试 BLCP 帧编解码 round-trip
import { packFrame } from '../blcp.js';

// 直接用内部构建函数验证帧格式；这里手写一个 RpcMeta 解析测试
// 由于 buildRpcBody 未导出，这里通过构造一个简单帧验证 packFrame 头
const rpc = new Uint8Array([0x08, 0x01, 0x10, 0x02, 0x18, 0x03]); // 假 RpcMeta
const lcm = new Uint8Array([0x0a, 0x03, 0x68, 0x69, 0x21]);       // 假 lcm

const frame = packFrame(rpc, lcm);
// 帧头: "lcp\x01" + total(4) + rpc_len(4)
console.log('frame header bytes:', Array.from(frame.slice(0, 12)));
console.assert(frame[0] === 0x6c && frame[1] === 0x63 && frame[2] === 0x70 && frame[3] === 0x01, 'magic');
const dv = new DataView(frame.buffer, frame.byteOffset, frame.length);
console.assert(dv.getUint32(4, false) === rpc.length + lcm.length, 'total len');
console.assert(dv.getUint32(8, false) === rpc.length, 'rpc len');
console.assert(frame.length === 12 + rpc.length + lcm.length, 'frame length');
console.log('PASS packFrame 帧格式');
