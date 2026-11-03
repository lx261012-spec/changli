import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.mjs';
import { config, tempDir, removeTempDir } from './helpers.mjs';

async function fixture(t) {
  const directory = tempDir(); const seen = []; let failed = true;
  const model = { count: async () => 10, stream: async (_, input, { onDelta }) => {
    seen.push(input);
    if (failed) throw Object.assign(new Error('Temporary test outage'), { code: 'service_unavailable' });
    await onDelta('恢复后的回复'); return { text: '恢复后的回复' };
  }, extractMemory: async () => ['重试只保存一份记忆'] };
  const app = createApp({ config: { ...config, dataDir: directory }, model, token: 'c'.repeat(64) });
  const session = app.store.createSession('changli');
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = (suffix, value, character = 'changli', id = session.id) => fetch(`${base}/api/characters/${character}/sessions/${id}/${suffix}`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + 'c'.repeat(64), 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  t.after(async () => { await app.close(); removeTempDir(directory); });
  return { ...app, session, seen, api, recover() { failed = false; } };
}

test('failed retry reuses original user message, model context and memory source without duplicate append', async t => {
  const app = await fixture(t);
  const failed = await (await app.api('messages', { content: '请保留这条原文' })).text(); assert.match(failed, /event: error/);
  const original = app.store.messages('changli', app.session.id)[0];
  assert.equal(app.store.messages('changli', app.session.id).length, 1);
  const failedAgain = await (await app.api('retry', { messageId: original.id })).text(); assert.match(failedAgain, /event: error/);
  assert.equal(app.store.messages('changli', app.session.id).length, 1);
  app.recover();
  const success = await (await app.api('retry', { messageId: original.id, content: '浏览器不能偷换原文' })).text();
  assert.match(success, /event: saved/); assert.match(success, new RegExp('"userMessageId":"' + original.id + '"'));
  assert.deepEqual(app.seen.at(-1), [{ role: 'user', content: '请保留这条原文' }]);
  const messages = app.store.messages('changli', app.session.id);
  assert.deepEqual(messages.map(message => message.content), ['请保留这条原文', '恢复后的回复']); assert.equal(messages[0].id, original.id);
  assert.deepEqual(app.store.listMemories('changli')[0].sourceMessageIds.sort(), [original.id, messages[1].id].sort());
});

test('answered, stale and absent retry targets do not invoke model or change history', async t => {
  const app = await fixture(t); app.recover();
  await app.service.chat('changli', app.session.id, '已回答的问题', () => {});
  const messages = app.store.messages('changli', app.session.id), calls = app.seen.length;
  for (const id of [messages[0].id, messages[1].id, 'missing']) {
    const response = await (await app.api('retry', { messageId: id })).text(); assert.match(response, /invalid_retry/);
  }
  assert.equal((await app.api('retry', {})).status, 400); assert.equal(app.seen.length, calls);
  assert.deepEqual(app.store.messages('changli', app.session.id), messages);
});

test('retry target is scoped to selected session and character', async t => {
  const app = await fixture(t);
  await app.api('messages', { content: '长离未回复' });
  const target = app.store.messages('changli', app.session.id)[0]; const other = app.store.createSession('changli');
  assert.match(await (await app.api('retry', { messageId: target.id }, 'changli', other.id)).text(), /invalid_retry/);
  assert.equal((await app.api('retry', { messageId: target.id }, 'aimisi')).status, 404);
  assert.deepEqual(app.store.listSessions('aimisi'), []); assert.equal(app.seen.length, 1);
});

test('stale retry cannot overwrite a newer pending user message', async t => {
  const app = await fixture(t);
  await app.api('messages', { content: '原问题' });
  const original = app.store.messages('changli', app.session.id)[0];
  const latest = app.store.addMessage('changli', app.session.id, 'user', '新问题'); app.recover();
  const response = await (await app.api('retry', { messageId: original.id })).text(); assert.match(response, /invalid_retry/);
  assert.equal(app.seen.length, 1);
  assert.deepEqual(app.store.messages('changli', app.session.id).map(message => message.id), [original.id, latest.id]);
});
