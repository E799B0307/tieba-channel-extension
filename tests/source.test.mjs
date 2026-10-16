import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../tieba-extension-lite/', import.meta.url));

for (const file of ['diag.mjs', ...readdirSync(resolve(root, 'test')).filter(name => name.endsWith('.mjs')).map(name => `test/${name}`)]) {
  test(`supplied source check: ${file}`, () => {
    // The supplied checks use console.assert, which normally does not fail the process.
    const bootstrap = "import assert from 'node:assert/strict'; console.assert = (value, ...message) => assert.ok(value, message.join(' ')); await import(process.argv[1]);";
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap, pathToFileURL(resolve(root, file)).href], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}

test('extension, lite variant, and proxy JavaScript pass syntax checks', () => {
  const folders = [root, resolve(root, 'variants/lite'), resolve(root, 'proxy'), resolve(root, 'emoji')];
  for (const folder of folders) {
    for (const file of readdirSync(folder).filter(name => name.endsWith('.js'))) {
      const result = spawnSync(process.execPath, ['--check', resolve(folder, file)], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, `${relative(root, resolve(folder, file))}: ${result.stderr}`);
    }
  }
});

test('manifest entrypoints and local HTML assets exist for full and lite variants', () => {
  for (const folder of [root, resolve(root, 'variants/lite')]) {
    const manifest = JSON.parse(readFileSync(resolve(folder, 'manifest.json'), 'utf8'));
    for (const file of [manifest.background.service_worker, manifest.side_panel.default_path,
      manifest.options_ui?.page, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(entry => entry.js)].filter(Boolean)) {
      assert.ok(existsSync(resolve(folder, file)) || existsSync(resolve(root, file)), file);
    }
    for (const file of readdirSync(folder).filter(name => name.endsWith('.html'))) {
      const html = readFileSync(resolve(folder, file), 'utf8');
      for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        if (/^[a-z]+:/i.test(match[1])) continue;
        assert.ok(existsSync(resolve(dirname(resolve(folder, file)), match[1])) || existsSync(resolve(root, match[1])), `${file}: ${match[1]}`);
      }
    }
  }
});
