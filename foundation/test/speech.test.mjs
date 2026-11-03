import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.mjs';
import { SpeechEngine } from '../src/speech.mjs';
import { SpeechPlayer } from '../public/speech-player.js';
import { config, tempDir, removeTempDir } from './helpers.mjs';

test('语音接口沿用认证，拒绝角色串音；语音失败不破坏文字聊天', async t => {
  const directory = tempDir();
  const wav = Buffer.alloc(46); wav.write('RIFF'); wav.write('WAVE', 8);
  const speech = {
    status: id => ({ configured: id === 'changli', ready: id === 'changli' }),
    stop() {},
    async synthesize(id, text) {
      if (id !== 'changli') throw Object.assign(new Error('未配置'), { code: 'speech_unconfigured', status: 503 });
      if (text === '失败') throw Object.assign(new Error('语音失败'), { code: 'speech_failed', status: 502 });
      return { audio: wav, seconds: 1, generationMs: 2, loadMs: 3 };
    },
  };
  const model = { count: async () => 10, stream: async (_, __, { onDelta }) => { await onDelta('文字保留'); return { text: '文字保留' }; }, extractMemory: async () => [] };
  const app = createApp({ config: { ...config, dataDir: directory }, model, speech, token: 'a'.repeat(64) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); removeTempDir(directory); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, method = 'GET', data) => fetch(base + path, { method, headers: { Authorization: 'Bearer ' + 'a'.repeat(64), 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  assert.equal((await fetch(base + '/api/characters/changli/speech', { method: 'POST' })).status, 401);
  const audio = await request('/api/characters/changli/speech', 'POST', { text: '你好' });
  assert.equal(audio.headers.get('content-type'), 'audio/wav'); assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wav);
  assert.equal((await request('/api/characters/aimisi/speech', 'POST', { text: '你好' })).status, 503);
  assert.equal((await request('/api/characters/changli/speech', 'POST', { text: '失败' })).status, 502);
  const session = await (await request('/api/characters/changli/sessions', 'POST', {})).json();
  assert.match(await (await request(`/api/characters/changli/sessions/${session.id}/messages`, 'POST', { content: '你好' })).text(), /文字保留/);
  assert.equal((await (await request('/api/state?character=aimisi')).json()).speechConnected, false);
});

test('未配置、空文本、超长文本在创建推理进程前拒绝', async () => {
  const engine = new SpeechEngine();
  await assert.rejects(engine.synthesize('aimisi', '你好'), { code: 'speech_unconfigured' });
  engine.status = () => ({ configured: true });
  for (const text of ['', null, 'a'.repeat(2001)]) await assert.rejects(engine.synthesize('changli', text), { code: 'invalid_speech' });
  assert.equal(engine.child, null);
});

function playerFixture(request) {
  const statuses = [], revoked = [], played = [];
  const audio = { addEventListener() {}, pause() {}, removeAttribute() {}, load() {}, async play() { played.push(this.src); } };
  let nextURL = 0;
  return { audio, statuses, revoked, played, player: new SpeechPlayer({ request, audio, status: text => statuses.push(text), createURL: () => `blob:${++nextURL}`, revokeURL: url => revoked.push(url) }) };
}

test('后请求替换前请求，迟到旧音频与停止后的音频均不能播放', async () => {
  const pending = [];
  const f = playerFixture((...args) => new Promise(resolve => pending.push({ resolve, args })));
  const first = f.player.speak('changli', '旧');
  const second = f.player.speak('changli', '新');
  assert.equal(pending[0].args[3].aborted, true);
  pending[0].resolve(new Response('旧')); await first;
  assert.equal(f.played.length, 0);
  pending[1].resolve(new Response('新')); await second;
  assert.deepEqual(f.played, ['blob:1']);
  const third = f.player.speak('changli', '停止'); f.player.stop();
  pending[2].resolve(new Response('停止')); await third;
  assert.equal(f.played.length, 1); assert.deepEqual(f.revoked, ['blob:1']);
});

test('浏览器阻止自动播放时保留播放器；语音故障提供重试提示', async () => {
  const f = playerFixture(async () => new Response('音频'));
  f.audio.play = async () => { throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); };
  await f.player.speak('changli', '你好');
  assert.match(f.statuses.at(-1), /播放键/); assert.equal(f.audio.src, 'blob:1');
  f.player.request = async () => { throw new Error('语音离线'); };
  await f.player.speak('changli', '你好');
  assert.match(f.statuses.at(-1), /文字已保留.*重试/);
});
