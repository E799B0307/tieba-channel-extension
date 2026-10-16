const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../tieba-extension-lite');
const output = path.resolve(__dirname, '../artifacts');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=', 'base64');

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.clock.install();
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'extension.test') {
        const emojiFile = url.pathname.match(/\/(image_editoricon\d+@2x\.png)$/)?.[1];
        let body = png;
        if (emojiFile) {
          try { body = await fs.readFile(path.join(root, 'emoji', emojiFile)); } catch {}
        }
        return route.fulfill({ contentType: 'image/png', body });
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.resolve(root, relative);
      if (!file.startsWith(path.resolve(root) + path.sep)) return route.abort();
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
      try { await route.fulfill({ contentType: types[path.extname(file)], body: await fs.readFile(file) }); }
      catch { await route.fulfill({ status: 404, body: '' }); }
    });
    await page.addInitScript(() => {
      const own = '9007199254740993123';
      const other = '9007199254740993124';
      const image = 'https://tb2.bdstatic.com/tb/editor/images/client/image_emoticon1.png';
      const base = { time: 1792123200, room: '123', key: 'message-key', contentType: '0', from: '321', avatar: '', level: 14,
        vip: false, image: '', reactions: [], deleted: [], hidden: false, msgType: '0' };
      const rows = [
        { ...base, id: own, name: '自己', authorId: 'self-uk', text: '我发的消息' },
        { ...base, id: other, name: '一位名字比较长的频道成员', authorId: 'other-uk', text: '可以给这条消息贴表情',
          reactions: [{ image, content: image, count: 1, reacted: false }] },
        { ...base, id: '9007199254740993125', hidden: true, system: true, text: '' },
      ];
      const listeners = [];
      window.calls = [];
      window.runtimeBuild = '0.2.5-local';
      window.identityRole = 0;
      window.reloads = 0;
      window.failNext = '';
      window.delayDetail = false;
      window.pendingDetail = null;
      window.emptyStickers = false;
      window.delayStickers = false;
      window.pendingStickers = null;
      window.sendId = own;
      window.delayedMessage = '';
      window.failMessageReads = false;
      let generation = 0;
      window.push = (messages) => listeners.forEach((fn) => fn({ type: 'blcp-push', messages }, { id: 'test-extension', url: 'http://extension.test/background.js' }));
      window.chrome = { runtime: {
        id: 'test-extension', getURL: (name) => 'http://extension.test/' + name,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        reload: () => { window.reloads++; },
        sendMessage: async (request) => {
          window.calls.push(request);
          if (window.failNext === request.type) { window.failNext = ''; return { ok: false, error: '模拟请求失败' }; }
          let data;
          switch (request.type) {
            case 'runtime-info':
              if (!window.runtimeBuild) return { ok: false, error: '不支持的操作' };
              data = { build: window.runtimeBuild, operations: ['send', 'send-image', 'send-sticker', 'favorite-stickers', 'react', 'reaction-detail', 'recall'] }; break;
            case 'initialize': data = { account: { id: '789', name: '自己' }, context: { name: '嘉然' }, lastForum: '' }; break;
            case 'rooms': data = { fid: '456', name: '嘉然', rooms: [{ id: '123', name: '嘉心糖的手账本' }, { id: '124', name: '另一个频道' }] }; break;
            case 'enter': data = { room: request.room, fid: '456', authorId: 'self-uk', identityRole: request.room === '123' ? window.identityRole : 0, name: request.room === '123' ? '嘉心糖的手账本' : '另一个频道' }; break;
            case 'account-check': data = {}; break;
            case 'favorite-stickers':
              data = { stickers: window.emptyStickers ? [] : Array.from({ length: 13 }, (_, index) => ({
                id: `0:${9000 + index}`, url: 'https://imgsrc.baidu.com/forum/pic/item/favorite.gif',
                thumbnail: 'https://tb2.bdstatic.com/tb/editor/images/client/image_editoricon' + (index + 1) + '@2x.png', width: 200, height: 100,
              })), unavailable: 0 };
              if (window.delayStickers) return new Promise((resolve) => { window.pendingStickers = () => resolve({ ok: true, data }); });
              break;
            case 'messages':
              if (window.failMessageReads) return { ok: false, error: '模拟频道读取失败' };
              data = { room: request.room,
              messages: request.room === '123' ? rows.filter((row) => BigInt(row.id) > BigInt(request.after)) : [],
              reacts: rows.map((row) => ({ id: row.id, reactions: row.reactions })), reactionGeneration: generation };
              if (window.delayedMessage && request.room === '123') data.messages.push({ ...base,
                id: window.sendId, name: '自己', authorId: 'self-uk', text: window.delayedMessage });
              break;
            case 'react': {
              const row = rows.find((row) => row.id === request.id);
              row.reactions = request.add ? [{ image: request.image, count: 2, reacted: true }] : [{ image: request.image, count: 1, reacted: false }];
              data = { room: request.room, id: request.id, reactions: row.reactions, confirmed: true, reactionGeneration: ++generation }; break;
            }
            case 'reaction-detail':
              data = { room: request.room, id: request.id, users: [{ id: request.after === 1 ? 'a' : 'b', name: request.after === 1 ? '贴表情的小明' : '贴表情的小红', after: request.after === 1 ? 1000 : 2000 }], hasMore: request.after === 1 };
              if (window.delayDetail) return new Promise((resolve) => { window.pendingDetail = () => resolve({ ok: true, data }); });
              break;
            case 'recall':
              setTimeout(() => window.push([{ ...base, id: '9007199254740993999', removed: true, hidden: true, deleted: [request.id] }]), 100);
              data = { room: request.room, id: request.id }; break;
            case 'send':
            case 'send-image':
            case 'send-sticker':
              data = { room: request.room, id: window.sendId }; break;
            default: return { ok: false, error: 'unexpected API: ' + request.type };
          }
          return { ok: true, data: structuredClone(data) };
        },
      } };
    });
    await page.goto('http://extension.test/panel.html');
    await page.locator('#rooms option[value="123"]').waitFor({ state: 'attached' });
    await page.locator('#rooms').selectOption('123');
    const own = page.locator('[data-message-id="9007199254740993123"]');
    const other = page.locator('[data-message-id="9007199254740993124"]');
    await other.waitFor();
    assert.equal(await page.locator('.message').count(), 2, 'history system packet must stay hidden');
    assert.equal(await other.getByRole('button', { name: '撤回自己发送的消息' }).count(), 0, 'cannot recall others');
    assert.equal(await own.getByRole('button', { name: '撤回自己发送的消息' }).count(), 1);
    await page.evaluate(() => window.push([{ id: '9007199254740993222', room: '123', hidden: true, removed: false, deleted: [], system: true, text: '' }]));
    assert.equal(await page.locator('.message').count(), 2, 'push system packet must stay hidden');
    await page.evaluate(() => window.push([{ id: '9007199254740993223', room: '123', hidden: false, deleted: [], name: '系统', from: '0', authorId: '', text: '', image: '' }]));
    assert.equal(await page.locator('.message').count(), 2, 'legacy backend packet must not create unsupported-message bubble');
    console.log('PASS history/push filtering and recall ownership');

    await other.locator('.reaction-count').click();
    await page.getByText('贴表情的小明', { exact: true }).waitFor();
    await page.locator('#detail-more').click();
    await page.getByText('贴表情的小红', { exact: true }).waitFor();
    await page.locator('#detail-close').click();
    await other.locator('.reaction-image').click();
    await other.locator('.reaction.reacted').waitFor();
    await other.locator('.reaction-image').click();
    await page.waitForFunction(() => !document.querySelector('[data-message-id="9007199254740993124"] .reaction.reacted'));
    await other.locator('.reaction-trigger').click();
    await page.locator('#reaction-search').fill('呵呵');
    await page.locator('#reaction-list button').first().click();
    await other.locator('.reaction.reacted').waitFor();
    await page.evaluate(() => { window.failNext = 'react'; });
    await other.locator('.reaction-image').click();
    await page.getByText('模拟请求失败', { exact: true }).waitFor();
    assert.equal(await other.locator('.reaction.reacted').count(), 1, 'failed writes must not alter reaction UI');
    console.log('PASS add/remove reactions, picker, participant names and pagination');

    await page.locator('#notice').waitFor({ state: 'hidden' });
    await page.locator('#text').fill('收藏表情发送时保留的草稿');
    await page.locator('#image-toggle').click();
    await page.locator('#sticker-list button').first().waitFor();
    assert.equal(await page.locator('#sticker-list button').count(), 13);
    assert.equal(await page.locator('#sticker-upload').isVisible(), true);
    assert.equal(await page.evaluate(() => calls.filter((call) => call.type === 'send-sticker').length), 0);
    await page.locator('#sticker-refresh').click();
    await page.locator('#sticker-list button').first().waitFor();
    assert.equal(await page.evaluate(() => calls.filter((call) => call.type === 'favorite-stickers').at(-1).refresh), true);
    for (const width of [280, 340, 420, 800]) {
      await page.setViewportSize({ width, height: 860 });
      await page.waitForFunction(() => [...document.querySelectorAll('#sticker-list img')].slice(0, 3).every((img) => img.complete && img.naturalWidth > 10));
      await page.screenshot({ path: path.join(output, `cloud-stickers-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'sticker grid must not overflow');
      const buttons = await page.locator('#sticker-list button').evaluateAll((nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
      assert.ok(buttons.every((button) => Math.abs(button.width - button.height) < 2), 'sticker tiles stay square');
    }
    await page.setViewportSize({ width: 420, height: 860 });
    await page.locator('#sticker-list button').first().click();
    assert.equal(await page.locator('#sticker-picker').isVisible(), false);
    await page.locator('#image-preview').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => calls.filter((call) => call.type === 'send-sticker').length), 0, 'selection only previews');
    await page.evaluate(() => { window.failNext = 'send-sticker'; });
    await page.locator('#send').click();
    await page.getByText('模拟请求失败', { exact: true }).waitFor();
    assert.equal(await page.locator('#image-preview').isVisible(), true);
    await page.locator('#send').click();
    await page.locator('#image-preview').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#text').inputValue(), '收藏表情发送时保留的草稿');
    const selected = await page.evaluate(() => calls.filter((call) => call.type === 'send-sticker').at(-1));
    assert.equal(selected.favoriteId, '0:9000');
    assert.equal(selected.upload, undefined, 'never upload preview bytes for a favorite');

    await page.evaluate(() => { window.emptyStickers = true; });
    await page.locator('#image-toggle').click();
    await page.getByText('暂无收藏表情', { exact: true }).waitFor();
    assert.equal(await page.locator('#sticker-upload').isEnabled(), true);
    await page.evaluate(() => { window.emptyStickers = false; window.failNext = 'favorite-stickers'; });
    await page.locator('#sticker-refresh').click();
    await page.locator('#sticker-retry').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#sticker-upload').isEnabled(), true);
    await page.locator('#sticker-retry').click();
    await page.locator('#sticker-list button').first().waitFor();
    await page.locator('#emoji-toggle').click();
    assert.equal(await page.locator('#sticker-picker').isVisible(), false);
    await page.locator('#emoji-close').click();
    await page.locator('#image-toggle').click();
    await page.locator('#sticker-list button').first().waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#sticker-picker').isVisible(), false);
    await page.locator('#image-toggle').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#sticker-upload').click();
    await (await chooser).setFiles({ name: 'outside.png', mimeType: 'image/png', buffer: png });
    await page.locator('#image-preview').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#image-name').textContent(), 'outside.png');
    await page.locator('#image-cancel').click();

    await page.evaluate(() => { window.delayStickers = true; });
    await page.locator('#image-toggle').click();
    await page.waitForFunction(() => !!window.pendingStickers);
    await page.locator('#rooms').selectOption('124');
    await page.evaluate(() => { window.pendingStickers(); window.delayStickers = false; });
    assert.equal(await page.locator('#sticker-picker').isVisible(), false);
    assert.equal(await page.locator('#sticker-list button').count(), 0);
    await page.locator('#rooms').selectOption('123');
    await other.waitFor();
    console.log('PASS cloud favorites, refresh, empty/error/retry, preview/send, external upload, room isolation and responsive grid');

    await page.locator('#text').fill('保留文字草稿');
    await page.locator('#image-file').setInputFiles({ name: 'meme.png', mimeType: 'image/png', buffer: png });
    await page.locator('#image-preview').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => calls.filter((call) => call.type === 'send-image').length), 0, 'preview must not send');
    await page.evaluate(() => { window.failNext = 'send-image'; });
    await page.locator('#send').click();
    await page.getByText('模拟请求失败', { exact: true }).waitFor();
    assert.equal(await page.locator('#image-preview').isVisible(), true, 'failure must retain preview');
    await page.locator('#send').click();
    await page.locator('#image-preview').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#text').inputValue(), '保留文字草稿');
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    await page.locator('#image-file').setInputFiles({ name: 'animated.gif', mimeType: 'image/gif', buffer: gif });
    await page.locator('#image-preview').waitFor({ state: 'visible' });
    await page.locator('#image-cancel').click();
    assert.equal(await page.locator('#image-preview').isVisible(), false);
    await page.locator('#image-file').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('<svg><script/></svg>') });
    await page.getByText('只支持 PNG、JPEG、GIF、WebP 图片', { exact: true }).waitFor();
    assert.equal(await page.locator('#image-preview').isVisible(), false);
    await page.evaluate(() => { window.failNext = 'send'; });
    await page.locator('#send').click();
    await page.getByText('模拟请求失败', { exact: true }).waitFor();
    assert.equal(await page.locator('#text').inputValue(), '保留文字草稿');
    console.log('PASS image preview, explicit send, and failed-send draft preservation');

    await page.evaluate(() => { window.delayDetail = true; });
    await other.locator('.reaction-count').click();
    await page.waitForFunction(() => !!window.pendingDetail);
    await page.locator('#rooms').selectOption('124');
    await page.evaluate(() => window.pendingDetail());
    assert.equal(await page.locator('#reaction-detail').isVisible(), false, 'stale participant request must not reopen panel');
    assert.equal(await page.locator('.message').count(), 0);
    await page.evaluate(() => { window.delayDetail = false; });
    await page.locator('#rooms').selectOption('123');
    await other.waitFor();
    page.once('dialog', (dialog) => dialog.accept());
    await own.getByRole('button', { name: '撤回自己发送的消息' }).click();
    await own.locator('.bubble').getByText('该消息已被删除或撤回', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => calls.filter((call) => call.type === 'recall').length), 1);
    console.log('PASS stale-room response isolation and server-confirmed recall');

    for (const width of [280, 340, 420, 800]) {
      await page.setViewportSize({ width, height: 860 });
      await other.locator('.reaction-trigger').click();
      await page.screenshot({ path: path.join(output, `panel-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow at ' + width);
      const send = await page.locator('#send').boundingBox();
      assert.ok(send.x + send.width <= width);
      const rects = await other.locator('.meta > *').evaluateAll((nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }));
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        assert.ok(!(a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom), 'metadata must not overlap at ' + width);
      }
      await page.locator('#reaction-close').click();
    }
    assert.deepEqual(errors, []);
    console.log('PASS 280/340/420/800px layout and no browser runtime errors');

    await page.evaluate(() => { window.identityRole = 2; });
    await page.locator('#rooms').selectOption('124');
    await page.locator('#rooms').selectOption('123');
    const managerRecall = other.getByRole('button', { name: '以频道管理身份撤回此消息' });
    await managerRecall.waitFor();
    await page.setViewportSize({ width: 280, height: 860 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(output, 'admin-recall-280.png') });
    page.once('dialog', (dialog) => { assert.ok(dialog.message().includes('以频道管理身份')); dialog.dismiss(); });
    const recallCount = await page.evaluate(() => calls.filter((call) => call.type === 'recall').length);
    await managerRecall.click();
    assert.equal(await page.evaluate(() => calls.filter((call) => call.type === 'recall').length), recallCount);
    await page.evaluate(() => { window.failNext = 'recall'; });
    page.once('dialog', (dialog) => dialog.accept());
    await managerRecall.click();
    await page.getByText('模拟请求失败', { exact: true }).waitFor();
    assert.equal(await other.locator('.bubble').textContent(), '可以给这条消息贴表情');
    page.once('dialog', (dialog) => dialog.accept());
    await managerRecall.click();
    await other.locator('.bubble').getByText('该消息已被删除或撤回', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => calls.filter((call) => call.type === 'recall').at(-1).id), '9007199254740993124');
    await page.evaluate(() => { window.identityRole = 0; });
    await page.locator('#rooms').selectOption('124');
    await page.locator('#rooms').selectOption('123');
    await other.waitFor();
    assert.equal(await other.getByRole('button', { name: '以频道管理身份撤回此消息' }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS manager-only recall, explicit confirmation, failed request, and confirmed removal');

    await page.evaluate(() => { window.runtimeBuild = null; });
    await page.locator('#reconnect').click();
    await page.locator('#runtime-warning').waitFor({ state: 'visible' });
    await page.setViewportSize({ width: 280, height: 860 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(output, 'runtime-mismatch-280.png') });
    await page.locator('#rooms').selectOption('123');
    await other.waitFor();
    await page.locator('#text').fill('不能交给旧后台的消息');
    assert.equal(await page.locator('#send').isDisabled(), true);
    assert.equal(await page.locator('#image-toggle').isDisabled(), true);
    assert.equal(await other.locator('.reaction-trigger').isDisabled(), true);
    const writesBefore = await page.evaluate(() => calls.filter((call) => ['send', 'send-image', 'react', 'recall'].includes(call.type)).length);
    await page.locator('#text').press('Enter');
    assert.equal(await page.evaluate(() => calls.filter((call) => ['send', 'send-image', 'react', 'recall'].includes(call.type)).length), writesBefore);
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.locator('#reload-extension').click();
    assert.equal(await page.evaluate(() => reloads), 0, 'cancel must retain drafts');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#reload-extension').click();
    assert.equal(await page.evaluate(() => reloads), 1);
    console.log('PASS old-background detection, blocked writes, and explicit runtime reload');

    const reloadForDelivery = async () => {
      await page.reload();
      await page.locator('#rooms option[value="123"]').waitFor({ state: 'attached' });
      await page.locator('#rooms').selectOption('123');
      await other.waitFor();
      await page.evaluate(() => { window.sendId = '9007199254740993122'; });
      await page.locator('#text').fill('发送确认测试');
      await page.locator('#send').click();
      await page.waitForFunction(() => !document.querySelector('#text').value);
    };
    const unconfirmed = page.locator('#notice').filter({ hasText: '服务器已受理，但暂未在频道中确认' });
    await reloadForDelivery();
    await page.clock.fastForward(9000);
    assert.equal(await page.locator('#notice').isVisible(), false, 'slow delivery must not be treated as failure at eight seconds');
    await page.evaluate(() => { window.delayedMessage = '迟到但确实送达的消息'; });
    await page.clock.fastForward(4000);
    const lateMessage = page.locator('[data-message-id="9007199254740993122"]');
    await lateMessage.waitFor();
    await page.clock.fastForward(31000);
    assert.equal(await unconfirmed.isVisible(), false);
    assert.equal(await lateMessage.count(), 1, 'overlapping message reads must not duplicate the message');
    assert.equal(await page.evaluate(() => calls.filter(call => call.type === 'send').length), 1);

    await reloadForDelivery();
    await page.evaluate(() => { window.failMessageReads = true; });
    await page.clock.fastForward(31000);
    await page.getByText('模拟频道读取失败', { exact: true }).waitFor();
    assert.equal(await unconfirmed.isVisible(), false, 'read failures cannot establish non-delivery');
    await page.evaluate(() => { window.failMessageReads = false; window.delayedMessage = '断网恢复后确认的消息'; });
    await page.clock.fastForward(4000);
    await lateMessage.waitFor();
    await page.clock.fastForward(31000);
    assert.equal(await unconfirmed.isVisible(), false);
    assert.equal(await page.evaluate(() => calls.filter(call => call.type === 'send').length), 1, 'recovery must not resend');

    await reloadForDelivery();
    await page.clock.fastForward(31000);
    for (let tick = 0; tick < 6 && !await unconfirmed.isVisible(); tick++) await page.clock.runFor(1000);
    await unconfirmed.waitFor();
    assert.equal(await page.evaluate(() => calls.filter(call => call.type === 'send').length), 1);
    assert.equal(await page.locator('#notice').textContent().then(text => /限频|审核|稍后可重试/.test(text)), false);
    await page.screenshot({ path: path.join(output, 'delivery-unconfirmed-280.png') });

    await reloadForDelivery();
    await page.locator('#rooms').selectOption('124');
    await page.clock.fastForward(35000);
    assert.equal(await unconfirmed.isVisible(), false, 'old-room delivery timers must be cancelled');
    assert.deepEqual(errors, []);
    console.log('PASS delayed delivery, overlapping cursors, read recovery, uncertain receipts, no resend, and room isolation');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
