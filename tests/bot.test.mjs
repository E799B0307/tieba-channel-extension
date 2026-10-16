import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoRecallBot, checkRecallWords } from '../tieba-extension-lite/bot.js';
import { TiebaClient } from '../tieba-extension-lite/tieba.js';
import { authorIdFromUserId } from '../tieba-extension-lite/protocol.js';

const now = 1792158655000;
const messageId = '9007199254740993123';
const actorId = await authorIdFromUserId('800');
const peerId = await authorIdFromUserId('900');
const message = { room: '123', id: messageId, key: 'fixture-msg-key', authorId: peerId, time: now / 1000,
  text: 'example SPAM message', msgType: '1', role: 0, deleted: [] };
const botAccount = { id: '800', name: 'fixture bot', token: 'bot-fixture-token', tbs: '0123456789abcdef', created: now };

function setup(t) {
  t.mock.method(Date, 'now', () => now);
  const stored = { autoRecallSettings: { enabled: true, ownerId: '789', botBduss: botAccount.token,
    recallWords: ['spam'], revision: 'initial', startedAt: now - 5000,
    rooms: [{ roomId: '123', fid: '456', name: 'test room', addedAt: now - 5000 }] },
    'forum:456': { accountId: '789', name: '嘉然', rooms: [{ id: '123' }] } };
  const storage = {
    get: async (key) => ({ [key]: structuredClone(stored[key]) }),
    set: async (values) => Object.assign(stored, structuredClone(values)),
  };
  globalThis.chrome = { storage: { local: storage, session: storage } };
  const writes = [];
  const reader = {
    account: async (id) => { assert.ok(!id || id === '789'); return { id: '789' }; },
    roomState: async () => ({ state: { room: '123', fid: '456', name: 'test room' }, account: { id: '789' } }),
    ensureJoined: async () => true,
    readMessages: async () => ({ messages: [message] }),
  };
  const actor = {
    loginWithToken: async (token) => { assert.equal(token, botAccount.token); return { ...botAccount }; },
    recallAsBot: async (account, room, target, guard) => { await guard(); writes.push({ account, room, target }); return { room: room.room, id: target.id }; },
  };
  const bot = new AutoRecallBot(reader, actor);
  return { bot, reader, actor, stored, writes };
}

test('literal keyword matching is case-insensitive, not regex', () => {
  assert.deepEqual(checkRecallWords('hello SPAM [x]', ['spam', '[x]', '.*', '']), ['spam', '[x]']);
});

test('bot is off by default and snapshots never expose credentials', async (t) => {
  const { bot, stored } = setup(t);
  const snapshot = await bot.snapshot();
  assert.equal(snapshot.hasToken, true);
  assert.ok(!JSON.stringify(snapshot).includes(botAccount.token));
  delete stored.autoRecallSettings;
  assert.equal((await bot.settings()).enabled, false);
});

test('only new matching messages in registered rooms and accounts are eligible', async (t) => {
  const { bot, writes, stored } = setup(t);
  await bot.accept([message], 'another-account');
  const invalid = [
    { room: '124' }, { time: 0 }, { time: (now - 6000) / 1000 }, { time: (now + 120000) / 1000 },
    { time: (now - 360000) / 1000 }, { system: true }, { hidden: true }, { removed: true }, { recalled: true },
    { deleted: ['99'] }, { text: 'ordinary message' }, { authorId: actorId }, { id: 'invalid' },
  ];
  for (const patch of invalid) await bot.accept([{ ...message, ...patch }], '789');
  assert.equal(writes.length, 0);
  stored.autoRecallSettings.enabled = false;
  await bot.accept([message], '789');
  assert.equal(writes.length, 0);
  stored.autoRecallSettings.enabled = true;
  await bot.accept([message], '789');
  assert.equal(writes.length, 1);
  assert.equal(stored.autoRecallRecords[0].status, 'accepted');
  assert.ok(!JSON.stringify(stored.autoRecallRecords).includes(message.text));
});

test('missing keys are retried after history fills them; concurrent and restarted workers do not repeat withdrawals', async (t) => {
  const { bot, reader, actor, writes, stored } = setup(t);
  await bot.accept([{ ...message, key: '' }], '789');
  assert.equal(stored.autoRecallRecords, undefined);
  await Promise.all([bot.accept([message], '789'), bot.accept([message], '789')]);
  assert.equal(writes.length, 1);
  await new AutoRecallBot(reader, actor).accept([message], '789');
  assert.equal(writes.length, 1);
  await bot.accept([{ room: '123', id: '9007199254740993124', deleted: [messageId], removed: true }], '789');
  assert.equal(stored.autoRecallRecords[0].status, 'confirmed');
});

test('failed or interrupted withdrawals are not automatically retried or reported as successful', async (t) => {
  const { bot, reader, actor, stored } = setup(t);
  let calls = 0;
  actor.recallAsBot = async () => { calls++; throw new Error('failure containing secret data'); };
  await bot.accept([message], '789');
  assert.equal(stored.autoRecallRecords[0].status, 'failed');
  assert.ok(!JSON.stringify(stored.autoRecallRecords).includes('secret data'));
  await new AutoRecallBot(reader, actor).accept([message], '789');
  assert.equal(calls, 1);
  stored.autoRecallRecords[0].status = 'pending';
  await new AutoRecallBot(reader, actor).accept([message], '789');
  assert.equal(calls, 1);
});

test('a recall event in the same batch prevents a redundant withdrawal', async (t) => {
  const { bot, writes } = setup(t);
  await bot.accept([message, { room: message.room, deleted: [message.id], removed: true }], '789');
  assert.equal(writes.length, 0);
});

test('deduplication capacity pauses writes instead of evicting recent attempts', async (t) => {
  const { bot, stored, writes } = setup(t);
  stored.autoRecallRecords = Array.from({ length: 2000 }, (_, index) => ({ ownerId: '789', room: '123', id: String(index + 1), at: now, status: 'accepted' }));
  await bot.accept([message], '789');
  assert.equal(writes.length, 0);
  assert.equal(stored.autoRecallRecords.length, 2000);
  assert.match(bot.status, /记录已满/);
});

test('stop prevents new writes even while another settings save is awaiting login', async (t) => {
  const { bot, actor, writes, stored } = setup(t);
  let finishLogin;
  let loginStarted;
  const started = new Promise(resolve => { loginStarted = resolve; });
  actor.loginWithToken = () => new Promise(resolve => { finishLogin = resolve; loginStarted(); });
  const enabling = bot.save({ enabled: true, recallWords: ['spam'] });
  await started;
  const stopping = bot.save({ enabled: false, recallWords: ['spam'] });
  await bot.accept([message], '789');
  assert.equal(writes.length, 0);
  finishLogin({ ...botAccount });
  await Promise.all([enabling, stopping]);
  assert.equal(stored.autoRecallSettings.enabled, false);
});

test('turning off, removing the room or switching accounts during permission lookup cancels the write', async (t) => {
  for (const change of ['disable', 'remove', 'account']) {
    const { bot, actor, reader, writes, stored } = setup(t);
    actor.recallAsBot = async (account, room, target, guard) => {
      if (change === 'disable') await bot.save({ enabled: false, recallWords: ['spam'] });
      else if (change === 'remove') await bot.removeRoom('123');
      else reader.account = async () => { throw new Error('account changed'); };
      await guard();
      writes.push(target);
    };
    await bot.accept([message], '789');
    assert.equal(writes.length, 0, change);
    assert.notEqual(stored.autoRecallRecords[0].status, 'accepted');
  }
});

test('settings take effect immediately, preserve registered rooms, and do not leak a cleared token', async (t) => {
  const { bot, writes, stored } = setup(t);
  await bot.save({ enabled: true, recallWords: ['different'] });
  await bot.accept([{ ...message, time: (now + 1000) / 1000 }], '789');
  assert.equal(writes.length, 0);
  assert.equal(stored.autoRecallSettings.rooms.length, 1);
  await bot.save({ enabled: false, recallWords: [], botBduss: '' });
  assert.equal((await bot.snapshot()).hasToken, false);
  await assert.rejects(bot.save({ enabled: true, recallWords: ['spam'] }), /启用前/);
  assert.equal(stored.autoRecallSettings.enabled, false);
});

test('only a validated current Jia Ran channel can be registered', async (t) => {
  const { bot, stored } = setup(t);
  stored.autoRecallSettings.rooms = [];
  stored['forum:456'].name = 'another forum';
  await assert.rejects(bot.addRoom('123', '789'), /嘉然/);
  stored['forum:456'].name = '嘉然';
  stored['forum:456'].accountId = 'other';
  await assert.rejects(bot.addRoom('123', '789'), /嘉然/);
  stored['forum:456'].accountId = '789';
  await bot.addRoom('123', '789');
  await bot.addRoom('123', '789');
  assert.equal(stored.autoRecallSettings.rooms.length, 1);
});

test('background polling rejoins channels and processes missing-key history without a panel or Bilibili config', async (t) => {
  const { bot, reader, writes } = setup(t);
  let joins = 0;
  let reads = 0;
  reader.ensureJoined = async (room, owner) => { joins++; assert.equal(room, '123'); assert.equal(owner, '789'); };
  reader.readMessages = async (room, account) => { reads++; assert.equal(room.fid, '456'); assert.equal(account.id, '789'); return { messages: [message] }; };
  await Promise.all([bot.poll(), bot.poll()]);
  assert.equal(joins, 1);
  assert.equal(reads, 1);
  assert.equal(writes.length, 1);
});

test('bot login and withdrawals use only bot credentials and enforce live channel permissions', async (t) => {
  const client = new TiebaClient();
  const calls = [];
  let role = 2;
  let responseRoom = '123';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const fields = Object.fromEntries(options.body);
    calls.push({ url, options, fields });
    assert.equal(options.credentials, 'omit');
    assert.equal(fields.BDUSS || fields.bdusstoken, botAccount.token);
    const response = url.endsWith('/login') ? { user: { id: '800' }, anti: { tbs: botAccount.tbs } }
      : url.endsWith('/profile') ? { user: { id: '800', name: 'bot' } }
      : url.endsWith('/getChatRoomDetail') ? { data: { basic_info: { id: responseRoom, forum_id: '456' }, user_info: { identity_role: role } } }
      : { error_code: 0 };
    return new Response(JSON.stringify(response));
  });
  const account = await client.loginWithToken(botAccount.token);
  assert.equal(account.tbs, botAccount.tbs);
  let guarded = false;
  await client.recallAsBot(account, { room: '123', fid: '456' }, message, async () => { guarded = true; });
  assert.equal(guarded, true);
  const write = calls.find(call => call.url.endsWith('/withdrawMsg'));
  assert.equal(write.fields.msg_id, messageId);
  assert.equal(write.fields.uid_to, '900');
  assert.equal(write.fields.tbs, botAccount.tbs);
  for (const patch of [{ role: 1 }, { room: '124' }, { authorId: actorId }, { key: '' }, { system: true }]) {
    await assert.rejects(client.recallAsBot(account, { room: '123', fid: '456' }, { ...message, ...patch }, async () => {}));
  }
  role = 0;
  await assert.rejects(client.recallAsBot(account, { room: '123', fid: '456' }, message, async () => {}), { code: 'RECALL_FORBIDDEN' });
  role = 1;
  responseRoom = '124';
  await assert.rejects(client.recallAsBot(account, { room: '123', fid: '456' }, message, async () => {}), { code: 'RECALL_FORBIDDEN' });
  responseRoom = '123';
  await assert.rejects(client.recallAsBot(account, { room: '123', fid: '456' }, message, async () => { throw new Error('disabled'); }), /disabled/);
  assert.equal(calls.filter(call => call.url.endsWith('/withdrawMsg')).length, 1);
});
