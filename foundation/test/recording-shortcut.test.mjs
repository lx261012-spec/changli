import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';
import { config, tempDir, removeTempDir } from './helpers.mjs';
import { once } from 'node:events';

test('录音快捷键按角色持久保存、清除，角色不能改设置且无默认注册', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  try {
    assert.equal(store.getRecordingShortcut('changli'), null);
    store.setRecordingShortcut('changli', 'Ctrl+Alt+R');
    assert.equal(store.getRecordingShortcut('aimisi'), null);
    assert.throws(() => store.setRecordingShortcut('changli', 'Ctrl+S', { actor: 'character' }), { code: 'USER_WRITE_REQUIRED' });
    for (const invalid of [undefined, {}, 'R', 'Win+R', 'Ctrl+Ctrl+R', 'Ctrl+F25', 'Ctrl+']) {
      assert.throws(() => store.setRecordingShortcut('changli', invalid), { code: 'INVALID_SHORTCUT' });
      assert.equal(store.getRecordingShortcut('changli'), 'Ctrl+Alt+R');
    }
    store.close(); store = new Store(directory);
    assert.equal(store.getRecordingShortcut('changli'), 'Ctrl+Alt+R');
    store.setRecordingShortcut('changli', null);
    assert.equal(store.getRecordingShortcut('changli'), null);
  } finally { store.close(); }
});

test('录音快捷键API需认证，状态返回已存选择且不影响模型或会话', async t => {
  const directory = tempDir();
  const app = createApp({ config: { ...config, dataDir: directory }, token: 'a'.repeat(64) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); removeTempDir(directory); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const url = base + '/api/characters/changli/recording-shortcut';
  const headers = { Authorization: 'Bearer ' + 'a'.repeat(64), 'Content-Type': 'application/json' };
  assert.equal((await fetch(url, { method: 'PUT' })).status, 401);
  assert.equal((await fetch(url, { method: 'PUT', headers, body: '{}' })).status, 400);
  const saved = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ recordingShortcut: 'Ctrl+Shift+F8' }) });
  assert.deepEqual(await saved.json(), { recordingShortcut: 'Ctrl+Shift+F8' });
  const state = await (await fetch(base + '/api/state?character=changli', { headers })).json();
  assert.equal(state.speech.recordingShortcut, 'Ctrl+Shift+F8');
  assert.equal(state.provider, 'openai'); assert.deepEqual(state.sessions, []);
  assert.equal((await (await fetch(base + '/api/state?character=aimisi', { headers })).json()).speech.recordingShortcut, null);
  assert.deepEqual(await (await fetch(url, { method: 'PUT', headers, body: '{"recordingShortcut":null}' })).json(), { recordingShortcut: null });
});
