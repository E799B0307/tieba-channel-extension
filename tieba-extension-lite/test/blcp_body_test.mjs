// 验证模块导入链 + BLCP 请求体构造是否正确（不连网络）
import { BLCPClient, CHAT_SDK_VERSION, CHAT_VERSION, packFrame } from '../blcp.js';

// 验证导出存在
console.assert(typeof BLCPClient === 'function', 'BLCPClient');
console.assert(CHAT_SDK_VERSION === 11250036, 'CHAT_SDK_VERSION');
console.assert(CHAT_VERSION === '12.68.1.0', 'CHAT_VERSION');
console.assert(typeof packFrame === 'function', 'packFrame');

// 构造一个 BLCPClient 实例，验证 sendMethod185 的请求体结构
const client = new BLCPClient({ bduss: 'test-bduss', cuidGalaxy2: 'X'.repeat(32) + '|V' + 'A'.repeat(8), c3Aid: 'A00-' + 'B'.repeat(32) + '-' + 'C'.repeat(8) });

// 手动填充 user 信息，模拟登录后状态
client.status = 1;
client.user = { userId: 123, portrait: 'tb.1.abc', nickName: '测试', uk: 456789, triggerId: 999, isVip: false, glevel: 5 };

// 调用 _buildSendRequestData 验证请求体（不发送）
const rd = client._buildSendRequestData({ roomId: '9669859877', forumId: '15131073', text: 'hello', atData: [], robot: -1, user: client.user, level: 3 });

console.assert(rd.method === 185, 'method');
console.assert(rd.mcast_id === '9669859877', 'mcast_id');
console.assert(rd.role === 3, 'role');
console.assert(rd.token === 'test-bduss', 'token');
console.assert(rd.uk === 456789, 'uk');
console.assert(rd.origin_id === 999, 'origin_id');
console.assert(rd.type === 81, 'type');
console.assert(rd.account_type === 1, 'account_type');
console.assert(rd.sdk_version === 11250036, 'sdk_version');
console.assert(Array.isArray(rd.event_list) && rd.event_list.length === 3, 'event_list');
console.assert(typeof rd.app_safe_ext === 'string', 'app_safe_ext');

// content 结构：双层 JSON
const outer = JSON.parse(rd.content);
console.assert(typeof outer.text === 'string', 'content.text is string');
const inner = JSON.parse(outer.text);
console.assert(inner.content_type === '0', 'content_type');
console.assert(inner.baidu_uk != null, 'baidu_uk');
const body = JSON.parse(inner.content_body);
console.assert(body.text === 'hello', 'content_body.text');

console.log('全部通过：BLCP 请求体结构正确');
