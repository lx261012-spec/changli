import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { careLines, careEntryLines, readCareAudio } from '../src/care-audio.mjs';
import { config, tempDir, removeTempDir } from './helpers.mjs';

async function fixture(t, modelOverrides = {}, policyOverrides = {}) {
  const directory = tempDir();
  writeFileSync(join(directory, 'proactive-care-policy.json'), JSON.stringify({ probabilities: [.2,.4,.7,1], timeoutAction: 'ignore', ...policyOverrides }));
  const requests = [];
  const model = { count: async (instructions, input) => { requests.push({ instructions, input }); return 50; }, stream: async (_, __, { onDelta }) => { await onDelta('听见了。'); return { text: '听见了。' }; }, extractMemory: async () => [], ...modelOverrides };
  const app = createApp({ config: { ...config, dataDir: directory, proactiveCare: true, careAudioDir: directory }, model, token: 'a'.repeat(64) });
  app.care.start = () => {};
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); removeTempDir(directory); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: 'Bearer ' + 'a'.repeat(64), 'Content-Type': 'application/json' };
  const api = (path, method = 'GET', data) => fetch(base + '/api/' + path, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const owner = randomUUID(); let time = 0;
  const engine = app.care.engine; engine.now = () => time; engine.random = () => 0;
  for (let i = 0; i <= 360; i++) { time = i * 5000; engine.sample({ foreground: 'wps', running: ['wps'] }); }
  const invitationId = engine.snapshot().rounds.wps.invitation.id;
  const send = (choice, extra = {}) => api('characters/changli/care/respond', 'POST', { invitationId, choice, consumerId: owner, ...extra });
  const present = () => api('characters/changli/care/present', 'POST', { invitationId, consumerId: owner });
  return { ...app, api, requests, owner, send, present, invitationId, directory, advance: ms => { time += ms; } };
}

test('接听只写当前角色当前会话一次，不调用模型、不记忆、不接受浏览器伪造台词', async t => {
  const f = await fixture(t);
  const older = f.store.createSession('changli'); const latest = f.store.createSession('changli');
  await f.api('characters/changli/active-session', 'PUT', { sessionId: older.id });
  await f.present();
  const result = await (await f.send('accept', { text: '伪造的浏览器台词' })).json();
  assert.equal(result.delivery.sessionId, older.id);
  assert.equal(result.delivery.message.content, careLines.wps.text);
  assert.equal(f.store.messages('changli', latest.id).length, 0);
  assert.equal((await f.send('accept')).status, 409);
  assert.equal(f.store.messages('changli', older.id).length, 1);
  assert.equal(f.store.listSessions('aimisi').length, 0);
  assert.deepEqual(f.store.listMemories('changli'), []);
  assert.equal(f.requests.length, 0);
  assert.equal((await (await f.api('state')).json()).activeSessionId, older.id);
});

test('没有会话时首次接听创建；拒绝与超时都不生成会话或聊天消息', async t => {
  const accepted = await fixture(t); await accepted.present();
  const result = await (await accepted.send('accept')).json();
  assert.equal(accepted.store.listSessions('changli').length, 1);
  assert.equal(accepted.store.getActiveSession('changli'), result.delivery.sessionId);
  const rejected = await fixture(t); await rejected.present(); await rejected.send('reject');
  assert.equal(rejected.store.listSessions('changli').length, 0);
  const ignored = await fixture(t); await ignored.present(); ignored.advance(10001);
  assert.equal((await ignored.send('accept')).status, 409);
  ignored.care.engine.sample({ foreground: 'wps', running: ['wps'] });
  assert.equal(ignored.care.engine.snapshot().rounds.wps.status, 'ignored');
  assert.equal(ignored.store.listSessions('changli').length, 0);
});

test('错误会话/跨角色/中途数据库故障不会消耗接听或留下半条记录；恢复后可再接听', async t => {
  const f = await fixture(t); await f.present();
  const other = f.store.createSession('aimisi');
  assert.equal((await f.send('accept', { sessionId: other.id })).status, 404);
  assert.equal(f.care.engine.snapshot().rounds.wps.status, 'shown');
  const save = f.store.saveCareState.bind(f.store);
  f.store.saveCareState = () => { throw new Error('Fixture database failure'); };
  assert.equal((await f.send('accept')).status, 500);
  assert.equal(f.store.listSessions('changli').length, 0);
  assert.equal(f.care.engine.snapshot().rounds.wps.status, 'shown');
  f.store.saveCareState = save;
  assert.equal((await f.send('accept')).status, 200);
  assert.equal(f.store.listSessions('changli').length, 1);
});

test('同一邀请只允许一个窗口显示和接听，重复回执不延长倒计时或重复计数', async t => {
  const f = await fixture(t); const first = await (await f.present()).json();
  f.advance(1000); const second = await (await f.present()).json();
  assert.equal(first.expiresAt, second.expiresAt);
  assert.equal(f.care.engine.snapshot().rounds.wps.invitations, 1);
  const intruder = randomUUID();
  assert.equal((await f.api('characters/changli/care/present', 'POST', { invitationId: f.invitationId, consumerId: intruder })).status, 409);
  assert.equal((await f.send('accept', { consumerId: intruder })).status, 409);
  assert.equal((await f.send('accept')).status, 200);
});

test('缺失录音只使播放失败，已接听文字保留；编辑/删除后不能访问旧录音关联', async t => {
  const f = await fixture(t); await f.present(); const { delivery } = await (await f.send('accept')).json();
  const audioPath = `characters/changli/care/audio/${delivery.message.id}`;
  assert.equal((await f.api(audioPath)).status, 503);
  assert.equal((await f.api(`characters/aimisi/care/audio/${delivery.message.id}`)).status, 409);
  assert.equal(f.store.messages('changli', delivery.sessionId)[0].content, careLines.wps.text);
  f.store.editMessage('changli', delivery.sessionId, delivery.message.id, '用户修改了这句话');
  assert.equal((await f.api(audioPath)).status, 404);
  assert.equal(f.store.messages('changli', delivery.sessionId)[0].careAppId, undefined);
  f.store.deleteSession('changli', delivery.sessionId);
  assert.equal(f.store.getActiveSession('changli'), null);
});

test('后续聊天收到已接听台词作为上下文，不假造用户消息；首条关心可重生成并清理后续', async t => {
  const f = await fixture(t); await f.present(); const { delivery } = await (await f.send('accept')).json();
  const session = delivery.sessionId;
  await f.service.chat('changli', session, '再等十分钟', () => {});
  assert.deepEqual(f.requests[0].input[0], { role: 'assistant', content: careLines.wps.text });
  assert.equal(f.requests[0].input[1].role, 'user');
  const sources = f.store.messages('changli', session);
  f.store.addMemory('changli', '测试派生记忆', [sources[1].id, sources[2].id]);
  await f.service.chat('changli', session, undefined, () => {}, undefined, { regenerateId: delivery.message.id });
  const after = f.store.messages('changli', session);
  assert.equal(after.length, 1); assert.equal(after[0].content, '听见了。');
  assert.equal(after[0].careAppId, undefined);
  assert.match(f.requests.at(-1).instructions, /重写用户已接听/);
  assert.deepEqual(f.requests.at(-1).input, []);
  assert.deepEqual(f.store.listMemories('changli'), []);
});

test('接听与正在生成的聊天串行，关心不会插入用户发言和模型回复之间', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { stream: async () => { entered(); await gate; return { text: '完成当前回复' }; } });
  const session = f.store.createSession('changli'); await f.present();
  const chatting = f.service.chat('changli', session.id, '正在说的话', () => {});
  await started;
  const accepting = f.send('accept', { sessionId: session.id });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.store.messages('changli', session.id).length, 1);
  release(); await chatting;
  assert.equal((await accepting).status, 200);
  assert.deepEqual(f.store.messages('changli', session.id).map(m => m.content), ['正在说的话', '完成当前回复', careLines.wps.text]);
});

test('原录音读取验证内容哈希和文件名，拒绝损坏或目录穿越', t => {
  const directory = tempDir(t);
  const wav = Buffer.alloc(48); wav.write('RIFF'); wav.write('WAVE', 8);
  const filename = 'C10_wps_duration.wav'; writeFileSync(join(directory, filename), wav);
  const line = { filename, sha256: createHash('sha256').update(wav).digest('hex') };
  assert.deepEqual(readCareAudio(directory, line), wav);
  assert.throws(() => readCareAudio(directory, { ...line, sha256: '0'.repeat(64) }), { code: 'care_audio_unavailable' });
  assert.throws(() => readCareAudio(directory, { ...line, filename: '../C10_wps_duration.wav' }), { code: 'care_audio_unavailable' });
  assert.equal(Object.keys(careLines).length, 13);
  const entry = { ...line, filename: 'C09_wps_entry.wav' };
  writeFileSync(join(directory, entry.filename), wav);
  assert.deepEqual(readCareAudio(directory, entry), wav);
  assert.equal(Object.keys(careEntryLines).length, 13);
});

test('进入接听使用进入台词与独立录音标识，保持同会话且不消耗时长邀请', async t => {
  const f = await fixture(t, {}, { entryEnabled: true });
  assert.equal(f.care.snapshot().entryEnabled, true);
  assert.equal(f.care.engine.locate(f.invitationId).invitation.kind, 'entry');
  const session = f.store.createSession('changli'); await f.present();
  const response = await f.send('accept', { sessionId: session.id, kind: 'duration', text: '不能伪造台词' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.delivery.sessionId, session.id);
  assert.equal(result.delivery.message.content, careEntryLines.wps.text);
  assert.equal(result.delivery.message.careAppId, 'wps_entry');
  assert.equal(f.store.getCareMessage('changli', result.delivery.message.id).appId, 'wps_entry');
  assert.equal(result.rounds.wps.status, 'timing');
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.store.listSessions('aimisi'), []);
  assert.equal((await f.send('accept')).status, 409);
});
