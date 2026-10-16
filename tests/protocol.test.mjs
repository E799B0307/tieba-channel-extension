import test from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('../tieba-extension-lite/', import.meta.url);
const { parseMessage, parseReactions, parseReactionUsers, parseFavoriteStickers, imageUpload, parseJSON, isDisplayableMessage, canRecallMessage, userIdFromAuthorId, authorIdFromUserId } = await import(new URL('protocol.js', root));
const { TiebaClient } = await import(new URL('tieba.js', root));
const { BLCPClient } = await import(new URL('blcp.js', root));
const { summarizeReply } = await import(new URL('send-diagnostics.js', root));
const { concatBytes, encodeBytesField, encodeVarintField, parseFields, findField } = await import(new URL('protobuf.js', root));
const { reactionChoices } = await import(new URL('reactions.js', root));
const image = reactionChoices[0].image;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=';
const own = '9007199254740993123';
const other = '9007199254740993124';
const state = { room: '123', fid: '456', authorId: 'self-uk', accountId: '789', sentKeys: {} };
const account = { id: '789', token: 'test-token', tbs: '0123456789abcdef', name: 'tester', generation: 0 };
function raw(id, detail, extra = {}) {
  return { msgid: id, from_user: '321', content: JSON.stringify({ text: JSON.stringify({ room_id: '123', ...detail }) }), ...extra };
}
function fixture() {
  const client = new TiebaClient();
  client.roomState = async () => ({ state, account });
  client.verifyAccount = async () => {};
  client.device = async () => 'original-install-device|0';
  client.history(state, account).set(own, parseMessage(raw(own, { type: '0', name: 'tester', baidu_uk: 'self-uk', msg_key: 'own-key', content_body: JSON.stringify({ text: 'own message' }) })));
  client.history(state, account).set(other, parseMessage(raw(other, { type: '0', name: 'another', baidu_uk: 'other-uk', msg_key: 'other-key', content_body: JSON.stringify({ text: 'other message' }) })));
  return client;
}

function captureHttpSend(t, reply = '{"err_code":0,"response_params":{"msgid":"999"}}') {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options, fields: Object.fromEntries(options.body) });
    return new Response(reply);
  });
  return requests;
}

test('hidden control packets, join notices and ordinary chat stay distinct', () => {
  assert.equal(parseMessage(raw('0', {})).hidden, true);
  assert.equal(parseMessage(raw('1', { type: '109', data: { service_info: { msg_conf: { is_visible: 0 } } } })).hidden, true);
  assert.equal(parseMessage(raw('2', { type: '109' })).hidden, true);
  assert.equal(parseMessage(raw('3', { type: '109', data: { service_info: { msg_conf: { show_content: '小明加入了频道' } } } })).hidden, true);
  assert.equal(parseMessage(raw('4', { type: '109', data: { service_info: { msg_conf: { show_content: '频道公告更新了' } } } })).hidden, false);
  assert.equal(parseMessage(raw('5', { type: '0', baidu_uk: 'other', content_body: '{"text":"我刚加入了频道"}' })).hidden, false);
  const recall = parseMessage(raw('6', { type: '106', data: { msgids: [own] } }));
  assert.equal(recall.removed, true);
  assert.equal(recall.hidden, true);
  assert.deepEqual(recall.deleted, [own]);
});

test('empty JSON bodies and legacy parsed system packets never create placeholder bubbles', () => {
  for (const body of ['{}', '[]', 'null', '""']) {
    const message = parseMessage(raw('30', { type: '109', content_body: body }, { from_user: '0' }));
    assert.equal(message.hidden, true, body);
    assert.equal(isDisplayableMessage(message), false);
  }
  assert.equal(isDisplayableMessage({ id: '31', name: '系统', text: '', authorId: '', from: '0', hidden: false }), false);
  assert.equal(isDisplayableMessage({ id: '32', name: '系统', text: '频道公告更新了', from: '0' }), true);
  assert.equal(isDisplayableMessage({ id: '33', name: '用户', authorId: 'other', from: '321', text: '' }), true);
  assert.equal(isDisplayableMessage({ id: '34', name: '系统', text: '小明进入了房间', from: '0' }), false);
  assert.equal(isDisplayableMessage({ id: '35', name: '用户', authorId: 'other', from: '321', text: '我刚加入了频道' }), true);
});

test('large message IDs and original reaction URLs survive parsing', () => {
  assert.equal(parseJSON('{"msgid":9007199254740993123}').msgid, own);
  const reactions = parseReactions([{ emoji_content: image.replace('https:', 'http:'), reactions_num: 1, has_reacted: 1 }]);
  assert.equal(reactions[0].image, image);
  assert.equal(reactions[0].content, image.replace('https:', 'http:'));
  assert.equal(reactions[0].reacted, true);
  assert.deepEqual(parseReactionUsers([{ reaction_bduk: 'some-uk', sort_time_us: '123456' }]), [{ id: 'some-uk', time: 123456 }]);
});

test('image validation inspects bytes, limits size and preserves aspect ratio', () => {
  const valid = imageUpload({ data: png, width: 400, height: 200 });
  assert.equal(valid.type, 'image/png');
  assert.deepEqual(valid.metadata, { big_size: '100,50', bsize: '100,50' });
  assert.throws(() => imageUpload({ data: btoa('<svg onload="bad()"></svg>'), width: 1, height: 1 }));
  assert.throws(() => imageUpload({ data: png, width: 0, height: 1 }));
  assert.throws(() => imageUpload({ data: '*%', width: 1, height: 1 }));
  assert.throws(() => imageUpload({ data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'), width: 1, height: 1 }));
  const gif = Buffer.from('GIF89a' + '\0'.repeat(20)).toString('base64');
  assert.equal(imageUpload({ data: gif, width: 10, height: 20 }).type, 'image/gif');
});

const favoriteRow = { pic_id: '9007199254740993123', pck_id: '42',
  pic_url: 'http://imgsrc.baidu.com/forum/pic/item/favorite.gif', thumbnail: image, width: '400', height: '200' };

test('favorites use the native pic_ids schema, preserve GIF URLs and reject unsafe entries', () => {
  const result = parseFavoriteStickers({ pic_update_time: 123, pic_ids: [favoriteRow, favoriteRow,
    { ...favoriteRow, pic_id: 'bad', pic_url: 'https://attacker.example/image.gif' },
    { ...favoriteRow, pic_id: 'bad-size', width: 0 },
    { ...favoriteRow, pic_id: 'credential', pic_url: 'https://secret@imgsrc.baidu.com/image.png' }],
    diy_pic_ids: [{ ...favoriteRow, pic_id: 'not-a-favorite' }] });
  assert.equal(result.stickers.length, 1);
  assert.equal(result.unavailable, 3);
  assert.equal(result.stickers[0].id, '42:9007199254740993123');
  assert.equal(result.stickers[0].url, favoriteRow.pic_url.replace('http:', 'https:'));
  assert.deepEqual(result.stickers[0].metadata, { big_size: '100,50', bsize: '100,50' });
  assert.deepEqual(parseFavoriteStickers({ pic_ids: [] }), { stickers: [], unavailable: 0 });
  assert.deepEqual(parseFavoriteStickers({ pic_update_time: 0 }), { stickers: [], unavailable: 0 });
  for (const invalid of [null, {}, { pic_ids: '[]' }, { pic_update_time: 123 }]) assert.throws(() => parseFavoriteStickers(invalid), /无法识别/);
  const fallback = parseFavoriteStickers({ pic_ids: [{ ...favoriteRow, thumbnail: 'javascript:bad()' }] });
  assert.equal(fallback.stickers[0].thumbnail, fallback.stickers[0].url);
});

test('favorites sync uses the current account, refreshes and clears on account invalidation', async () => {
  const client = fixture();
  let activeAccount = account;
  const calls = [];
  client.account = async (expectedId) => { assert.equal(expectedId, activeAccount.id); return activeAccount; };
  client.app = async (url, fields) => { calls.push({ url, fields }); return { data: { pic_ids: [favoriteRow] } }; };
  await client.favoriteStickers('789');
  await client.favoriteStickers('789');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/c/e/meme/getAllMeme');
  assert.equal(calls[0].fields.BDUSS, account.token);
  await client.favoriteStickers('789', true);
  assert.equal(calls.length, 2);
  activeAccount = { ...account, id: '790', token: 'another-test-token' };
  await client.favoriteStickers('790');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].fields.BDUSS, 'another-test-token');
  globalThis.chrome = { storage: { session: { clear: async () => {} }, local: { remove: async () => {} } } };
  await client.invalidateAccount();
  assert.equal(client.stickerCache, null);
});

test('favorites never cache an old account response or turn API failures into an empty library', async () => {
  const client = fixture();
  client.account = async () => account;
  client.app = async () => ({ data: { pic_ids: [favoriteRow] } });
  client.verifyAccount = async () => { throw Object.assign(new Error('account changed'), { code: 'ACCOUNT_CHANGED' }); };
  await assert.rejects(client.favoriteStickers('789'), { code: 'ACCOUNT_CHANGED' });
  assert.equal(client.stickerCache, null);
  client.verifyAccount = async () => {};
  client.app = async () => { throw new Error('server rejected'); };
  await assert.rejects(client.favoriteStickers('789'), /server rejected/);
  assert.equal(client.stickerCache, null);
});

test('favorite sending resolves the server catalog, preserves the original and performs no upload', async (t) => {
  const client = fixture();
  client.account = async () => account;
  client.app = async (url) => url.endsWith('getAllMeme') ? { data: { pic_ids: [favoriteRow] } } : { user_level: 12 };
  const requests = captureHttpSend(t);
  client.getBlcp = async () => { throw new Error('favorites must not depend on the BLCP sender'); };
  client.uploadImage = async () => { throw new Error('must not upload a favorite'); };
  globalThis.chrome = { storage: { session: { get: async () => ({ 'room:123': state }), set: async () => {} } } };
  await assert.rejects(client.send('123', '', '789', '', null, null, 'https://attacker.example/file'), /失效/);
  assert.equal(requests.length, 0);
  await client.send('123', '', '789', own, null, null, '42:9007199254740993123');
  assert.equal(requests.length, 1);
  const packet = requests[0].fields;
  const content = JSON.parse(JSON.parse(packet.content).text);
  assert.equal(JSON.parse(content.content_body).url, favoriteRow.pic_url.replace('http:', 'https:'));
  assert.equal(content.content_type, '1');
  assert.equal(packet.device_type, 'iOS');
  assert.equal(JSON.parse(content.ext).from, 'ios');
  assert.equal(JSON.parse(content.ext).content.big_size, '100,50');
  assert.equal(content.re_data.re_msg_id, own);
});

test('recall uses the dedicated endpoint, stored identity and lossless ID', async () => {
  const client = fixture();
  const calls = [];
  client.app = async (...args) => { calls.push(args); return args[0].endsWith('getChatRoomDetail') ? { data: { user_info: { identity_role: 0 } } } : {}; };
  await assert.rejects(client.recall('123', '789', other), /没有.*频道管理权限/);
  await assert.rejects(client.recall('123', '789', { msgid: own, authorUk: 'forged' }), /有效/);
  assert.equal(calls.filter((call) => call[0].endsWith('withdrawMsg')).length, 0);
  calls.length = 0;
  const result = await client.recall('123', '789', own);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/c/c/chatroom/withdrawMsg');
  assert.equal(calls[0][1].msg_id, own);
  assert.equal(calls[0][1].msg_key, 'own-key');
  assert.equal(calls[0][1].msg_type, '1');
  assert.equal(calls[0][1].uid_to, account.id);
  assert.deepEqual(result, { room: '123', id: own });
});

test('author identity decoding preserves the actual Baidu UID, not the IM connection UID', async () => {
  for (const id of ['12345', '9007199254740993123']) {
    assert.equal(await userIdFromAuthorId(await authorIdFromUserId(id)), id);
  }
  await assert.rejects(userIdFromAuthorId('bad-key'), /无法解析/);
});

test('recall permission follows channel identity and protects other managers', () => {
  const target = { authorId: 'other', role: 0 };
  for (const identityRole of [1, 2, 3]) assert.equal(canRecallMessage({ ...state, identityRole }, target), true);
  for (const identityRole of [undefined, null, 0, 4, 64]) assert.equal(canRecallMessage({ ...state, identityRole }, target), false);
  assert.equal(canRecallMessage({ ...state, identityRole: 2 }, { ...target, role: 1 }), false);
  assert.equal(canRecallMessage({ ...state, identityRole: 2 }, { ...target, role: 2 }), false);
  assert.equal(canRecallMessage({ ...state, identityRole: 1 }, { ...target, role: 2 }), true);
  assert.equal(canRecallMessage(state, { authorId: state.authorId, role: 1 }), true);
  assert.equal(canRecallMessage({ ...state, identityRole: 1 }, { ...target, recalled: true }), false);
});

test('message recall uses native message types and sender roles', () => {
  const text = parseMessage(raw('1', { type: '0', content_type: '0', ext: JSON.stringify({ role: 2, type: 1 }) }));
  assert.equal(text.msgType, '1');
  assert.equal(text.role, 2);
  assert.equal(parseMessage(raw('2', { type: '0', content_type: '1' })).msgType, '2');
  assert.equal(parseMessage(raw('3', { type: '0', content_type: '2' })).msgType, '3');
  assert.equal(parseMessage(raw('4', { type: '0', content_type: '3' })).msgType, '4');
  assert.equal(parseMessage(raw('5', { type: '0', content_type: '0', ext: '{"type":0}' })).msgType, '1');
});

test('manager recall rechecks live permission and addresses the original sender', async () => {
  const client = fixture();
  const target = client.history(state, account).get(other);
  target.authorId = await authorIdFromUserId('12345');
  target.role = 0;
  let currentRole = 2;
  const calls = [];
  client.roomState = async () => ({ state: { ...state, identityRole: 1 }, account });
  client.app = async (url, fields) => {
    calls.push({ url, fields });
    if (url.endsWith('getChatRoomDetail')) return { data: { basic_info: { id: state.room, forum_id: state.fid }, user_info: { identity_role: currentRole } } };
    return {};
  };
  await client.recall('123', '789', other);
  assert.equal(calls[0].url, '/c/f/chat/getChatRoomDetail');
  const writes = () => calls.filter((call) => call.url.endsWith('withdrawMsg'));
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].fields.uid_to, '12345');
  assert.notEqual(writes()[0].fields.uid_to, target.from);
  assert.equal(writes()[0].fields.msg_id, other);
  assert.equal(target.recalled, undefined, 'only a recall event may mark a message recalled');
  currentRole = 0;
  await assert.rejects(client.recall('123', '789', other), /没有.*频道管理权限/);
  assert.equal(writes().length, 1, 'cached manager identity must not override revoked permission');
  currentRole = 2;
  target.role = 1;
  await assert.rejects(client.recall('123', '789', other), /没有.*频道管理权限/);
  assert.equal(writes().length, 1, 'protected manager messages must not be submitted');
});

test('missing, failed or cross-channel permission reads cannot authorize manager recall', async () => {
  const client = fixture();
  let writes = 0;
  let detail = { data: { user_info: {} } };
  client.app = async (url) => { if (url.endsWith('withdrawMsg')) writes++; return detail; };
  await assert.rejects(client.recall('123', '789', other), /权限数据无效/);
  detail = { data: { basic_info: { id: '999' }, user_info: { identity_role: 1 } } };
  await assert.rejects(client.recall('123', '789', other), /权限数据无效/);
  client.app = async () => { throw new Error('permission request failed'); };
  await assert.rejects(client.recall('123', '789', other), /permission request failed/);
  assert.equal(writes, 0);
});

test('enter persists server channel identity, and permission failure falls back to own-message actions', async () => {
  const client = new TiebaClient();
  const originalChrome = globalThis.chrome;
  const stored = { 'forum:456': { accountId: account.id, rooms: [{ id: '123', name: 'test channel' }] } };
  globalThis.chrome = { storage: { session: {
    get: async (key) => ({ [key]: stored[key] }), set: async (values) => Object.assign(stored, values),
  } } };
  client.account = async () => account;
  client.verifyAccount = async () => {};
  client.device = async () => 'test-device';
  client.im = async () => ({ room_info: { room_id: '123' }, baidu_uk: state.authorId });
  client.getBlcp = async () => ({ joinedRooms: new Set(['123']) });
  client.app = async () => ({ data: { user_info: { identity_role: 2 }, basic_info: { id: '123', forum_id: '456' } } });
  try {
    const entered = await client.enter('123', '456', account.id);
    assert.equal(entered.identityRole, 2);
    assert.equal(stored['room:123'].identityRole, 2);
    assert.equal(stored['room:123'].accountId, account.id);
    client.app = async () => { throw new Error('read failed'); };
    const fallback = await client.enter('123', '456', account.id);
    assert.equal(fallback.identityRole, null);
    assert.equal(fallback.permissionError, true);
    assert.equal(canRecallMessage(fallback, { authorId: state.authorId }), true);
    assert.equal(canRecallMessage(fallback, { authorId: 'other' }), false);
  } finally { globalThis.chrome = originalChrome; }
});

test('failed or stale-account recalls never retry writes', async () => {
  const client = fixture();
  let writes = 0;
  client.app = async () => { writes++; throw new Error('rejected'); };
  await assert.rejects(client.recall('123', '789', own), /rejected/);
  assert.equal(writes, 1);
  client.verifyAccount = async () => { throw Object.assign(new Error('account changed'), { code: 'ACCOUNT_CHANGED' }); };
  await assert.rejects(client.recall('123', '789', own), /account changed/);
  assert.equal(writes, 1);
});

test('reaction writes target the original author, never the logged-in user', async () => {
  const client = fixture();
  let reacted = false;
  const writes = [];
  client.im = async () => ({ result: { [other]: reacted ? [{ emoji_content: image, reactions_num: 1, has_reacted: 1 }] : [] } });
  client.getBlcp = async () => ({ joinedRooms: new Set(['123']), user: { uk: 888 }, cuidGalaxy2: 'device',
    react: async (data) => { writes.push(data); reacted = data.op_type === 1; } });
  let result = await client.react('123', other, image, true, '789');
  assert.equal(result.confirmed, true);
  assert.equal(writes[0].method, 214);
  assert.equal(writes[0].msgid, other);
  assert.equal(writes[0].msg_from_uk, 321);
  assert.equal(writes[0].uk, 888);
  await client.react('123', other, image, true, '789');
  assert.equal(writes.length, 1, 'already-added reaction must be idempotent');
  result = await client.react('123', other, image, false, '789');
  assert.equal(writes[1].op_type, 2);
  assert.equal(result.confirmed, true);
  await assert.rejects(client.react('123', other, 'https://example.com/x.png', true, '789'));
  client.history(state, account).get(other).recalled = true;
  await assert.rejects(client.react('123', other, image, true, '789'), /失效/);
});

test('BLCP reaction transport sends service 3 method 214 and checks errors', async () => {
  const blcp = new BLCPClient({ bduss: 'test', cuidGalaxy2: 'device', c3Aid: '' });
  blcp.status = 1;
  let request;
  blcp._request = async (...args) => { request = args; return { meta: { errorCode: 0 }, lcm: { kind: 'json', data: { err_code: 0 } } }; };
  await blcp.react({ method: 214, msgid: other });
  assert.deepEqual(request.slice(0, 2), [3, 214]);
  assert.equal(JSON.parse(new TextDecoder().decode(request[2])).msgid, other);
  blcp._request = async () => ({ meta: { errorCode: 0 }, lcm: { kind: 'json', data: { err_code: 5 } } });
  await assert.rejects(blcp.react({ method: 214 }), /未成功/);
});

test('BLCP acknowledgements and notifications preserve unquoted 64-bit message IDs', async () => {
  const blcp = new BLCPClient({ bduss: 'test', cuidGalaxy2: 'device', c3Aid: '' });
  blcp.status = 1;
  blcp._write = async (frame) => {
    const rpcLength = new DataView(frame.buffer, frame.byteOffset).getUint32(8, false);
    const fields = parseFields(frame.slice(12, 12 + rpcLength));
    const correlation = findField(fields, 4).value;
    const response = concatBytes(encodeBytesField(2, concatBytes(encodeVarintField(1, 3), encodeVarintField(2, 185))), encodeVarintField(4, correlation));
    const data = new TextEncoder().encode(`{"err_code":0,"response_params":{"msgid":${own}}}`);
    blcp._handleFrame(concatBytes(response, data), response.length);
  };
  assert.equal(await blcp.sendMethod185({ method: 185 }), own);
  assert.equal(blcp.diagnostics.at(-1).methodId, 185);
  assert.equal(blcp.diagnostics.at(-1).body.response_params.values.msgid, own);
  let packet;
  blcp.onMessage((value) => { packet = value; });
  const notification = encodeBytesField(8, encodeVarintField(1, 3));
  const data = new TextEncoder().encode(`{"messages":[{"msgid":${own},"from_user":321}]}`);
  blcp._handleFrame(concatBytes(notification, data), notification.length);
  assert.equal(packet.messages[0].msgid, own);
  assert.equal(packet.messages[0].from_user, 321);
});

test('send and join use native microseconds and unique safe request IDs', async (t) => {
  const now = 1792152000123;
  t.mock.method(Date, 'now', () => now);
  const blcp = new BLCPClient({ bduss: 'test', cuidGalaxy2: 'device', c3Aid: '' });
  blcp.status = 1;
  const calls = [];
  blcp._request = async (service, method, bytes, correlation) => {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    calls.push({ service, method, body, correlation });
    return { meta: { errorCode: 0 }, lcm: { kind: 'json', data: { err_code: 0,
      response_params: method === 201 ? { mcast_id: 123 } : { msgid: own } } } };
  };
  await blcp.joinChatRoom(123);
  await Promise.all([blcp.sendMethod185({}), blcp.sendMethod185({})]);
  for (const call of calls) {
    assert.ok(Number.isSafeInteger(call.body.client_logid));
    assert.ok(call.body.client_logid >= now * 1000 && call.body.client_logid < now * 1000 + 1000);
    if (call.method === 185) assert.equal(call.correlation, call.body.client_logid);
  }
  assert.equal(new Set(calls.map(call => call.body.client_logid)).size, 3);
});

test('joining requires a successful reply for the requested room', async () => {
  const blcp = new BLCPClient({ bduss: 'test', cuidGalaxy2: 'device', c3Aid: '' });
  blcp.status = 1;
  let data = { err_code: 0, response_params: { mcast_id: 999 } };
  blcp._request = async () => ({ meta: { errorCode: 0 }, lcm: { kind: 'json', data } });
  await assert.rejects(blcp.joinChatRoom(123), /频道|房间/);
  data = { err_code: 0 };
  await assert.rejects(blcp.joinChatRoom(123), /频道|房间/);
  data = { err_code: 0, response_params: { mcast_id: '123' } };
  assert.equal(await blcp.joinChatRoom(123), true);
});

test('login retains the server role for subsequent sends', async () => {
  const blcp = new BLCPClient({ bduss: 'test', cuidGalaxy2: 'device', c3Aid: '' });
  blcp.generateLcmToken = async () => 'test-lcm-token';
  blcp._request = async (service) => ({ meta: { errorCode: 0 }, lcm: { kind: 'json', data: service === 2
    ? { err_code: 0, uk: 888, bd_uid: 789, trigger_id: [9], role: 7 } : { errno: 0 } } });
  await blcp.login();
  assert.equal(blcp.user.role, 7);
});

test('send acknowledgements reject server errors and unsafe IDs without retrying', async () => {
  const blcp = new BLCPClient({ bduss: 'test', cuidGalaxy2: 'device', c3Aid: '' });
  blcp.status = 1;
  let calls = 0;
  let response = { meta: { errorCode: 5 }, lcm: { kind: 'json', data: { msgid: own } } };
  blcp._request = async () => { calls++; return response; };
  await assert.rejects(blcp.sendMethod185({}), /发送失败/);
  assert.equal(calls, 1);
  response = { meta: { errorCode: 0 }, lcm: { kind: 'json', data: { err_code: 0, msgid: Number(own) } } };
  await assert.rejects(blcp.sendMethod185({}), /确认/);
  response = { meta: { errorCode: 0 }, lcm: { kind: 'json', data: { err_code: '0', msgid: 123 } } };
  assert.equal(await blcp.sendMethod185({}), '123');
});

test('text restores the original signed HTTPS sender without BLCP or automatic fallback', async (t) => {
  const client = fixture();
  client.app = async () => ({ user_level: 12 });
  const requests = captureHttpSend(t, '{"err_code":0,"response_params":{"msgid":9007199254740993123}}');
  client.getBlcp = async () => { throw new Error('text must not need a local proxy or BLCP login'); };
  globalThis.chrome = { storage: { session: { get: async () => ({ 'room:123': state }), set: async () => {} } } };
  const result = await client.send('123', '一条普通文字', '789');
  assert.equal(result.id, own, 'HTTPS replies must preserve 64-bit message IDs');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://pim.baidu.com/imsapi/1.0/send_mcast_msg/liveshowuser');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.credentials, 'include');
  const packet = requests[0].fields;
  assert.equal(packet.cuid, 'original-install-device|0');
  assert.equal(packet.device_type, 'iOS');
  assert.equal(packet.app_version, '22.12.1.0');
  assert.equal(packet.sdk_version, '11220030');
  assert.equal(packet.msg_type, '81');
  assert.equal(packet.mcast_id, state.room);
  assert.match(packet.sign, /^[a-f0-9]{32}$/);
  assert.equal(packet.token, undefined, 'use the existing HTTPS cookie, never copy it into the form');
  const envelope = JSON.parse(packet.content);
  assert.equal(typeof envelope.text, 'string');
  const inner = JSON.parse(envelope.text);
  assert.equal(inner.baidu_uk, state.authorId);
  assert.equal(inner.room_id, state.room);
  assert.equal(inner.content_type, '0');
  assert.deepEqual(JSON.parse(inner.content_body), { text: '一条普通文字' });
  assert.equal(JSON.parse(inner.ext).type, 1);
  const diagnostics = await client.sendDiagnostics('123', '789');
  assert.equal(diagnostics.sendTransport, 'https-imsapi');
  assert.equal(diagnostics.httpSendReply.body.response_params.values.msgid, own);
  assert.ok(!JSON.stringify(diagnostics).includes('一条普通文字'));
});

test('HTTPS send failures never retry via BLCP', async (t) => {
  const client = fixture();
  client.app = async () => ({ user_level: 12 });
  const requests = captureHttpSend(t, '{"err_code":5,"err_msg":"rejected"}');
  client.getBlcp = async () => { throw new Error('must not retry on another transport'); };
  await assert.rejects(client.send('123', 'test', '789'), /rejected/);
  assert.equal(requests.length, 1);
});

test('HTTP sender preserves its original installation identity across background restarts', async () => {
  const stored = { deviceId: 'old-http-device|0' };
  const originalChrome = globalThis.chrome;
  const writes = [];
  globalThis.chrome = { storage: { local: {
    get: async (key) => ({ [key]: structuredClone(stored[key]) }),
    set: async (value) => { writes.push(value); Object.assign(stored, value); },
  } } };
  try {
    assert.equal(await new TiebaClient().device(), stored.deviceId);
    assert.equal(await new TiebaClient().device(), stored.deviceId);
    assert.equal(writes.length, 0);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('send diagnostics retain numeric business status without credentials or server text', () => {
  const secret = 'private-message-and-token';
  const response = { meta: { errorCode: 0, errorText: secret }, lcm: { kind: 'json', data: {
    err_code: 0, auto_risk_control_status: 2, tips_new: { code: 5, text: secret },
    token: secret, bd_uid: '1234567891234567', content: secret,
    response_params: { msgid: own, time: '1792152000000', role: 7, cookie: secret, name: secret },
  } } };
  const summary = summarizeReply(3, 185, response);
  assert.equal(summary.rpcErrorCode, 0);
  assert.equal(summary.rpcErrorTextPresent, true);
  assert.equal(summary.rpcErrorTextIsSuccess, false);
  assert.equal(summary.body.values.auto_risk_control_status, 2);
  assert.equal(summary.body.response_params.values.msgid, own);
  assert.equal(summary.body.tips_new.values.code, 5);
  assert.equal(summary.body.fields.content, 'string');
  assert.ok(!JSON.stringify(summary).includes(secret));
  assert.ok(!JSON.stringify(summary).includes('1234567891234567'));
  response.lcm.data.err_code = secret;
  assert.equal(summarizeReply(3, 185, response).body.values.err_code, undefined);
  assert.equal(summarizeReply(3, 185, null).outcome, 'timeout');
});

test('BLCP diagnostics are bounded and exclude heartbeats and unrelated responses', async () => {
  const blcp = new BLCPClient({ bduss: 'test-token', cuidGalaxy2: 'test-device', c3Aid: 'test-aid' });
  blcp._recordReply(1, 3, null);
  blcp._recordReply(3, 214, null);
  assert.equal(blcp.diagnostics.length, 0);
  for (let i = 0; i < 25; i++) blcp._recordReply(3, 185, null);
  assert.equal(blcp.diagnostics.length, 20);
  blcp._write = async () => {};
  await assert.rejects(blcp._request(3, 185, new Uint8Array(), 123, 5), /超时/);
  assert.equal(blcp.diagnostics.at(-1).outcome, 'timeout');
  assert.equal(blcp.waiters.size, 0);
  blcp._recordReply(2, 50, { meta: {}, lcm: { kind: 'json', data: { role: 7 } } });
  assert.equal(blcp.diagnostics.at(-1).body.values.role, 7);
  assert.equal(blcp.diagnostics.length, 20);
});

test('diagnostic export is read-only, account-bound and distinguishes history from receipt', async () => {
  const client = fixture();
  const roomState = { ...state, sentKeys: { [own]: 'private-reply-key', '999': 'another-private-key' } };
  client.roomState = async () => ({ state: roomState, account });
  client.blcpAccount = account.token;
  client.device = async () => 'test-device';
  client.blcp = { status: 1, user: { role: 7, bdUid: 789 }, cuidGalaxy2: 'test-device', joinedRooms: new Set(['123']),
    diagnostics: [summarizeReply(3, 185, { meta: {}, lcm: { kind: 'json', data: { msgid: own } } })] };
  client.im = async () => ({ messages: [raw(own, { type: '0', content_body: '{"text":"private-chat"}' })] });
  await client.messages('123', '789');
  client.getBlcp = async () => { throw new Error('must not connect or send'); };
  client.im = async () => { throw new Error('must not request a new history read'); };
  const report = await client.sendDiagnostics('123', '789');
  assert.equal(report.connection.joined, true);
  assert.equal(report.identityChecks.imAccountMatchesWeb, true);
  assert.equal(report.lastHistoryRead.count, 1);
  assert.deepEqual(report.deliveryChecks, [
    { msgid: '999', seenInCache: false, seenInLastHistoryRead: false },
    { msgid: own, seenInCache: true, seenInLastHistoryRead: true },
  ]);
  for (const privateValue of [account.token, 'private-reply-key', 'another-private-key', 'private-chat', 'self-uk']) {
    assert.ok(!JSON.stringify(report).includes(privateValue));
  }
  report.replies.length = 0;
  assert.equal(client.blcp.diagnostics.length, 1);
  client.blcpAccount = 'previous-account-token';
  assert.equal((await client.sendDiagnostics('123', '789')).replies.length, 0);
  client.roomState = async () => { throw new Error('account changed'); };
  await assert.rejects(client.sendDiagnostics('123', '790'), /account changed/);
  globalThis.chrome = { storage: { session: { clear: async () => {} }, local: { remove: async () => {} } } };
  await client.invalidateAccount();
  assert.equal(client.messageReads.size, 0);
  assert.equal(client.lastHttpSend, null);
  assert.equal(client.blcp, null);
});

test('message polling returns late arrivals even when a newer cursor has already been seen', async () => {
  const client = fixture();
  client.im = async () => ({ messages: [raw(own, { type: '0', baidu_uk: 'self-uk', content_body: '{"text":"late own message"}' })] });
  const result = await client.messages('123', '789', other);
  assert.equal(result.messages.some((message) => message.id === own), true);
  assert.equal(result.messages.find((message) => message.id === own).text, 'late own message');
});

test('reaction details resolve names and retain pagination cursor', async () => {
  const client = fixture();
  client.history(state, account).get(other).reactions = [{ image, content: image, count: 1 }];
  let read;
  client.im = async (...args) => { read = args; return { result: [{ reaction_bduk: 'other-uk', sort_time_us: 1234 }], has_more: 1 }; };
  client.app = async () => ({ data: { user_info: { 'other-uk': { user_name: 'named user', portrait: 'portrait-id' } } } });
  const result = await client.reactionDetail('123', other, image, '789');
  assert.equal(read[0], 'chatroom/reaction_detail');
  assert.equal(read[3], false);
  assert.equal(result.users[0].name, 'named user');
  assert.equal(result.users[0].after, 1234);
  assert.equal(result.hasMore, true);
});

test('stale reaction reads cannot overwrite a newer write', async () => {
  const client = fixture();
  let finish;
  client.im = () => new Promise((resolve) => { finish = resolve; });
  const pending = client.readReactions(state, account, [client.history(state, account).get(other)], '789');
  client.reactionGeneration++;
  finish({ result: { [other]: [{ emoji_content: image, reactions_num: 99, has_reacted: 0 }] } });
  await pending;
  assert.equal(client.reactionCache.size, 0);
});

test('pushes cache message keys and recalls, keeping hidden packets hidden', () => {
  const client = fixture();
  let listener;
  let pushed;
  const blcp = { onMessage: (fn) => { listener = fn; } };
  client.blcp = blcp;
  client.onPush((rows) => { pushed = rows; });
  client._wirePush(blcp, account);
  listener([raw('20', { type: '106', data: { msgids: [own] } })]);
  assert.equal(client.history(state, account).get(own).recalled, true);
  assert.equal(pushed[0].hidden, true);
  listener([raw('21', { type: '0', baidu_uk: 'other', msg_key: 'push-key', content_body: '{"text":"new"}' })]);
  assert.equal(client.history(state, account).get('21').key, 'push-key');
  client.accountGeneration++;
  listener([raw('22', { type: '0', content_body: '{"text":"old account"}' })]);
  assert.equal(client.history(state, account).has('22'), false);
});

test('image send uploads once, preserves original bytes, and sends mobile image metadata', async () => {
  const client = fixture();
  client.app = async () => ({ user_level: 12 });
  let packet;
  const blcp = { joinedRooms: new Set(['123']), user: { uk: 888, triggerId: 9 }, cuidGalaxy2: 'device',
    sendMethod185: async () => { throw new Error('must not send the image over BLCP'); } };
  client.getBlcp = async () => blcp;
  globalThis.chrome = { storage: { session: { get: async () => ({ 'room:123': state }), set: async () => {} } } };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/send_mcast_msg/liveshowuser')) {
      packet = Object.fromEntries(options.body);
      return new Response('{"err_code":0,"response_params":{"msgid":"999"}}');
    }
    return calls.length === 1 ? new Response(JSON.stringify({ response_params: {
      put_url: 'https://bucket.bj.bcebos.com/picture', get_url: 'https://tieba-im-middleend.cdn.bcebos.com/picture.png',
      authorization: 'upload-token', date: 'today' } })) : new Response('', { status: 200 });
  };
  try {
    await client.send('123', '', '789', '', null, { data: png, width: 400, height: 200 });
    assert.equal(calls.length, 3);
    assert.equal(calls[1].options.method, 'PUT');
    assert.equal(calls[1].options.credentials, 'omit');
    assert.deepEqual(Buffer.from(calls[1].options.body), Buffer.from(png, 'base64'));
    const content = JSON.parse(JSON.parse(packet.content).text);
    assert.equal(content.content_type, '1');
    const ext = JSON.parse(content.ext);
    assert.equal(ext.type, 2);
    assert.equal(ext.content.big_size, '100,50');
  } finally { globalThis.fetch = originalFetch; }
});

test('upload authorization is never sent to an untrusted host', async () => {
  const client = fixture();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ response_params: {
    put_url: 'https://attacker.example/upload', get_url: 'https://tieba-im-middleend.cdn.bcebos.com/file',
    authorization: 'secret', date: 'today' } })); };
  try {
    await assert.rejects(client.uploadImage(account, { user: { uk: 888 }, cuidGalaxy2: 'device' }, imageUpload({ data: png, width: 1, height: 1 }), '789'), /地址无效/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('background accepts only its own panel and serializes writes per message', async () => {
  let listener;
  let finish;
  let writes = 0;
  const original = TiebaClient.prototype.react;
  TiebaClient.prototype.react = () => { writes++; return new Promise((resolve) => { finish = resolve; }); };
  const storage = { setAccessLevel: async () => {} };
  globalThis.chrome = {
    runtime: { id: 'test-id', getURL: (file) => `chrome-extension://test-id/${file}`,
      sendMessage: async () => {}, onMessage: { addListener: (fn) => { listener = fn; } } },
    storage: { local: storage, session: storage },
    sidePanel: { setPanelBehavior: () => {} }, cookies: { onChanged: { addListener: () => {} } },
  };
  try {
    await import(new URL('background.js', root));
    const request = { type: 'react', accountId: '789', room: '123', id: own, image, add: true };
    const sender = { id: 'test-id', url: 'chrome-extension://test-id/panel.html' };
    const info = await new Promise((resolve) => listener({ type: 'runtime-info' }, sender, resolve));
    assert.equal(info.ok, true);
    assert.equal(info.data.build, '0.2.10-local');
    assert.ok(['send-image', 'send-sticker', 'favorite-stickers', 'react', 'recall', 'send-diagnostics'].every((operation) => info.data.operations.includes(operation)));
    assert.equal(listener(request, { id: 'test-id', url: 'https://tieba.baidu.com/' }, () => {}), false);
    assert.equal(listener(request, { id: 'other-extension', url: sender.url }, () => {}), false);
    const first = new Promise((resolve) => listener(request, sender, resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const duplicate = await new Promise((resolve) => listener(request, sender, resolve));
    assert.equal(duplicate.ok, false);
    assert.equal(writes, 1);
    finish({ id: own });
    assert.equal((await first).ok, true);
    const invalid = await new Promise((resolve) => listener({ ...request, accountId: '' }, sender, resolve));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'ACCOUNT_CHANGED');
  } finally { TiebaClient.prototype.react = original; }
});
