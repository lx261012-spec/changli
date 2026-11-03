import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { config, tempDir, removeTempDir } from './helpers.mjs';

test('主动关心接口认证、角色隔离、显示回执与拒绝持久；状态读取不重复触发', async t => {
  const directory = tempDir();
  // Fixture policies only. Production choices remain unset until the user answers.
  writeFileSync(join(directory, 'proactive-care-policy.json'), JSON.stringify({ probabilities: [.2,.4,.7,1], timeoutAction: 'ignore' }));
  const app = createApp({ config: { ...config, dataDir: directory, proactiveCare: true }, token: 'a'.repeat(64) });
  app.care.start = () => {}; // No native monitoring in isolated API tests.
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); removeTempDir(directory); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: 'Bearer ' + 'a'.repeat(64), 'Content-Type': 'application/json' };
  const api = (path, data) => fetch(base + '/api/characters/' + path, { method: data ? 'POST' : 'GET', headers, ...(data ? {body: JSON.stringify(data)} : {}) });
  assert.equal((await fetch(base + '/api/characters/changli/care')).status, 401);
  const engine = app.care.engine; let now = 0; engine.now = () => now; engine.random = () => 0;
  for (let i = 0; i <= 360; i++) { now = i * 5000; engine.sample({ foreground: 'wps', running: ['wps'] }); }
  const first = await (await api('changli/care')).json(); const id = first.rounds.wps.invitation.id;
  assert.equal(first.rounds.wps.status, 'queued');
  assert.equal((await (await api('changli/care')).json()).rounds.wps.invitation.id, id);
  assert.equal((await api('aimisi/care/respond', { invitationId: id, choice: 'reject' })).status, 409);
  assert.equal((await api('changli/care/respond', { invitationId: id, choice: 'reject' })).status, 409);
  assert.equal((await api('changli/care/present', { invitationId: id })).status, 200);
  assert.equal((await api('changli/care/respond', { invitationId: id, choice: 'reject' })).status, 200);
  assert.equal(app.store.getCareState('changli').wps.rejections, 1);
  assert.equal((await api('changli/care/respond', { invitationId: id, choice: 'reject' })).status, 409);
  assert.equal((await (await api('aimisi/care')).json()).observer, 'not_configured');
});
