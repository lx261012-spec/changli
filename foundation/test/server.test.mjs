import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.mjs';
import { config, tempDir, removeTempDir } from './helpers.mjs';

async function setup(t) {
  const directory = tempDir();
  const model = {
    count: async () => 50,
    stream: async (_, input, { onDelta }) => { await onDelta('测试回复'); return { text: '测试回复' }; },
    extractMemory: async () => ['喜欢茶'],
  };
  const token = 'a'.repeat(64);
  const app = createApp({ config: { ...config, dataDir: directory }, model, token });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); removeTempDir(directory); });
  const request = (path, method = 'GET', value, headers = {}) => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { app, base, request, model };
}
test('本机API认证、跨站与Host校验，不泄露模型凭据', async t => {
  const { base, request } = await setup(t);
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await request('/api/state', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
  const deniedHost = await new Promise((resolve, reject) => {
    const req = httpRequest(base + '/api/state', { headers: { Host: 'evil.example', Authorization: 'Bearer ' + 'a'.repeat(64) } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(deniedHost, 403);
  const state = await request('/api/state'); assert.equal(state.status, 200);
  const text = await state.text(); assert.equal(text.includes('test-key'), false); assert.equal(JSON.parse(text).model, 'gpt-6.1-sol');
});
test('Gemini appears in state and manual selection is role-specific and persists without exposing secrets', async t => {
  const { app, request } = await setup(t);
  let geminiCalls = 0;
  app.service.models.gemini = { config: { model: 'gemini-3.8-flash', apiKey: 'SECRET-GEMINI' }, count: async () => ({ used: 123, unit: 'tokens', limit: 999 }), stream: async (_, __, { onDelta }) => { geminiCalls++; await onDelta('Gemini测试回复'); return { text: 'Gemini测试回复' }; }, extractMemory: async () => [] };
  const initial = await (await request('/api/state')).json();
  assert.deepEqual(initial.providers.map(item => item.id), ['openai', 'deepseek', 'gemini']);
  assert.equal(JSON.stringify(initial).includes('SECRET-GEMINI'), false);
  const session = await (await request('/api/characters/changli/sessions', 'POST', {})).json();
  assert.equal((await request('/api/characters/changli/provider', 'POST', { provider: 'gemini' })).status, 200);
  const state = await (await request('/api/state')).json();
  assert.equal(state.provider, 'gemini'); assert.equal(state.providers.at(-1).label, 'Gemini'); assert.equal(state.modelConfigured, true);
  assert.equal((await (await request('/api/state?character=aimisi')).json()).provider, 'openai');
  const reply = await (await request(`/api/characters/changli/sessions/${session.id}/messages`, 'POST', { content: '你好' })).text();
  assert.match(reply, /Gemini测试回复/); assert.match(reply, /"limit":999/); assert.equal(geminiCalls, 1);
  assert.equal(app.store.getProvider('changli'), 'gemini');
});
test('账号通道按官方登录状态显示配置，不依赖API密钥且不泄露凭据', async t => {
  const { app, request } = await setup(t);
  let loggedIn = true;
  app.service.models.openai = { config: { model: 'gpt-6.1-sol' }, configured: async () => loggedIn };
  let state = await (await request('/api/state')).json();
  assert.equal(state.modelConfigured, true);
  loggedIn = false;
  state = await (await request('/api/state')).json();
  assert.equal(state.modelConfigured, false);
});
test('HTTP贯通：新会话、流式回复、自动记忆、编辑覆盖与角色隔离', async t => {
  const { request } = await setup(t);
  const session = await (await request('/api/characters/changli/sessions', 'POST', {})).json();
  const response = await request(`/api/characters/changli/sessions/${session.id}/messages`, 'POST', { content: '我喜欢茶' });
  assert.match(await response.text(), /event: done/);
  let history = await (await request(`/api/characters/changli/sessions/${session.id}`)).json();
  assert.equal(history.messages.length, 2);
  assert.equal((await request(`/api/characters/aimisi/sessions/${session.id}`)).status, 404);
  let state = await (await request('/api/state')).json(); assert.equal(state.memories.length, 1);
  await request(`/api/characters/changli/sessions/${session.id}/messages/${history.messages[0].id}`, 'PATCH', { content: '我喜欢咖啡' });
  history = await (await request(`/api/characters/changli/sessions/${session.id}`)).json();
  assert.deepEqual(history.messages.map(m => m.content), ['我喜欢咖啡']);
  state = await (await request('/api/state')).json(); assert.equal(state.memories.length, 0);
});
test('无效JSON、超大请求和源资料格式有明确错误', async t => {
  const { base, request } = await setup(t);
  assert.equal((await request('/api/profile', 'PUT', { profile: [] })).status, 400);
  const response = await fetch(base + '/api/profile', { method: 'PUT', headers: { Authorization: 'Bearer ' + 'a'.repeat(64), 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(response.status, 400);
  assert.equal((await request('/api/profile', 'PUT', { profile: { text: 'x'.repeat(260000) } })).status, 413);
});
test('重生成API失败不删历史，普通消息不会暗中执行电脑任务', async t => {
  const { request, model, app } = await setup(t);
  const session = await (await request('/api/characters/changli/sessions', 'POST', {})).json();
  await (await request(`/api/characters/changli/sessions/${session.id}/messages`, 'POST', { content: '打开软件' })).text();
  const history = await (await request(`/api/characters/changli/sessions/${session.id}`)).json();
  model.stream = async () => { throw Object.assign(new Error('empty quota'), { code: 'quota_exhausted', status: 402 }); };
  const response = await request(`/api/characters/changli/sessions/${session.id}/regenerate`, 'POST', { messageId: history.messages[1].id });
  assert.match(await response.text(), /quota_exhausted/);
  const after = await (await request(`/api/characters/changli/sessions/${session.id}`)).json();
  assert.deepEqual(after.messages, history.messages); assert.equal(app.tasks.list('changli').length, 0);
});
