const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../tieba-extension-lite');
const output = path.resolve(__dirname, '../artifacts');

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'extension.test') return route.abort();
      const file = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
      if (!file.startsWith(root + path.sep)) return route.abort();
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
      try { await route.fulfill({ contentType: types[path.extname(file)], body: await fs.readFile(file) }); }
      catch { await route.fulfill({ status: 404, body: '' }); }
    });
    await page.addInitScript(() => {
      window.calls = [];
      window.localData = {};
      const changes = [];
      const listeners = [];
      window.chrome = {
        storage: {
          onChanged: { addListener: callback => changes.push(callback) },
          local: {
            get: async key => ({ [key]: structuredClone(window.localData[key]) }),
            set: async values => {
              const changed = {};
              for (const [key, value] of Object.entries(values)) {
                changed[key] = { oldValue: window.localData[key], newValue: structuredClone(value) };
                window.localData[key] = structuredClone(value);
              }
              changes.forEach(callback => callback(changed, 'local'));
            },
            remove: async key => { delete window.localData[key]; },
          },
        },
        runtime: {
          id: 'fixture-extension', getURL: name => 'http://extension.test/' + name,
          onMessage: { addListener: callback => listeners.push(callback) },
          openOptionsPage: async () => { window.optionsOpened = true; },
          sendMessage: async request => {
            window.calls.push(request);
            let data;
            switch (request.type) {
              case 'runtime-info': data = { build: '0.2.5-local', operations: ['send', 'send-image', 'send-sticker', 'favorite-stickers', 'react', 'reaction-detail', 'recall'] }; break;
              case 'initialize': data = { account: { id: '789', name: 'fixture user' }, context: { name: '嘉然' }, lastForum: '' }; break;
              case 'rooms': data = { fid: '456', name: '嘉然', rooms: [{ id: '123', name: '嘉心糖的手账本' }] }; break;
              case 'enter': data = { room: '123', fid: '456', authorId: 'self-uk', name: '嘉心糖的手账本', identityRole: 0 }; break;
              case 'messages': data = { room: '123', messages: [{ id: '9007199254740993123', key: 'fixture-key', name: 'fixture sender',
                room: '123', authorId: 'peer-uk', time: 1792158655, text: '界面加载测试', reactions: [], deleted: [], level: 10 }], reacts: [], deleted: [] }; break;
              case 'add-room': data = { added: true, room: '123', name: '嘉心糖的手账本' }; break;
              case 'account-check': data = {}; break;
              default: throw new Error('Unexpected API: ' + request.type);
            }
            return { ok: true, build: '0.2.5-local', data };
          },
        },
      };
    });
    await page.goto('http://extension.test/panel.html');
    await page.locator('#rooms option[value="123"]').waitFor({ state: 'attached' });
    await page.locator('#rooms').selectOption('123');
    await page.getByText('界面加载测试', { exact: true }).waitFor();
    assert.equal(await page.locator('#runtime-version').textContent(), '0.2.5-local');
    assert.equal(await page.locator('#runtime-warning').isVisible(), false);
    await page.locator('#open-settings').click();
    assert.equal(await page.evaluate(() => window.optionsOpened), true);
    await page.locator('#bot-toggle').click();
    await page.locator('#bot-log').waitFor({ state: 'visible' });
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#add-bot').click();
    await page.getByText('⚠ 已监控，机器人未启用', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => calls.filter(call => call.type === 'add-room').length), 1);
    await page.screenshot({ path: path.join(output, 'replacement-panel.png') });
    await page.goto('http://extension.test/settings.html');
    await page.locator('#bot-name').waitFor();
    assert.equal(await page.locator('#bot-enabled').isChecked(), false);
    await page.locator('#bot-name').fill('fixture bot');
    await page.locator('#recallword-input').fill('测试撤回词');
    await page.locator('#recallword-add').click();
    await page.locator('#save').click();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => localData.botSettings.recallWords), ['测试撤回词']);
    assert.equal(await page.evaluate(() => localData.botSettings.botName), 'fixture bot');
    await page.screenshot({ path: path.join(output, 'replacement-settings.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS supplied full-version panel, runtime handshake, bot registration/logs and settings save; all APIs mocked');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
