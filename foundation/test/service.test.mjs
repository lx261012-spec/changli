import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Foundation } from '../src/service.mjs';
import { config, tempDir, removeTempDir } from './helpers.mjs';

function setup(t, overrides = {}) {
  const directory = tempDir(); const store = new Store(directory); t.after(() => { store.close(); removeTempDir(directory); });
  const session = store.createSession('changli');
  const model = { count: async () => 50, stream: async (_, __, { onDelta }) => { await onDelta('你好'); return { text: '你好' }; }, extractMemory: async () => [] , ...overrides };
  const service = new Foundation({ store, model, tasks: { list: () => [] }, config });
  return { store, model, service, session };
}
test('完整聊天保存后自动形成可追溯记忆，不能改用户源资料', async t => {
  const { store, service, session } = setup(t, { extractMemory: async () => ['喜欢茶'] });
  store.setProfile({ name: '用户' }); const events = [];
  await service.chat('changli', session.id, '我喜欢茶', (type, data) => events.push({ type, data }));
  assert.equal(store.messages('changli', session.id).length, 2);
  assert.equal(store.listMemories('changli')[0].sourceMessageIds.length, 2);
  assert.deepEqual(store.getProfile(), { name: '用户' }); assert.equal(store.listMemories('aimisi').length, 0);
  assert.ok(events.some(event => event.type === 'delta'));
});
test('上下文达到上限时暂停，不删除历史也不调用生成', async t => {
  let generated = false;
  const { store, service, session } = setup(t, { count: async () => config.contextLimit, stream: async () => { generated = true; } });
  const prior = store.addMessage('changli', session.id, 'user', '旧记录');
  await assert.rejects(service.chat('changli', session.id, '新记录', () => {}), { code: 'context_limit' });
  assert.equal(generated, false); assert.deepEqual(store.messages('changli', session.id).map(m => m.id), [prior.id]);
});
test('重新生成失败保留原回复、后续及记忆', async t => {
  const { store, service, session } = setup(t, { stream: async () => { throw Object.assign(new Error('quota'), { code: 'quota_exhausted' }); } });
  const u = store.addMessage('changli', session.id, 'user', '你好');
  const a = store.addMessage('changli', session.id, 'assistant', '原回复');
  store.addMessage('changli', session.id, 'user', '后续'); store.addMemory('changli', '原记忆', [a.id]);
  await assert.rejects(service.chat('changli', session.id, undefined, () => {}, undefined, { regenerateId: a.id }), { code: 'quota_exhausted' });
  assert.equal(store.messages('changli', session.id).length, 3); assert.equal(store.listMemories('changli').length, 1);
  assert.equal(service.quotaPaused, true); assert.equal(store.messages('changli', session.id)[0].id, u.id);
});
test('重新生成成功才原子覆盖；旧后续派生记忆不进入新请求', async t => {
  let suppliedPrompt;
  const { store, service, session } = setup(t, { stream: async (instructions, input, { onDelta }) => { suppliedPrompt = instructions; assert.equal(input.length, 1); await onDelta('新回复'); return { text: '新回复' }; } });
  store.addMessage('changli', session.id, 'user', '你好'); const a = store.addMessage('changli', session.id, 'assistant', '原回复');
  const tail = store.addMessage('changli', session.id, 'user', '秘密后续'); store.addMemory('changli', '不应泄露的后续记忆', [tail.id]);
  await service.chat('changli', session.id, undefined, () => {}, undefined, { regenerateId: a.id });
  assert.equal(suppliedPrompt.includes('不应泄露'), false);
  assert.deepEqual(store.messages('changli', session.id).map(m => m.content), ['你好', '新回复']); assert.equal(store.listMemories('changli').length, 0);
});
test('并发输入只运行最新请求；不会交叉写两条回复', async t => {
  let active = 0, maximum = 0, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { store, service, session } = setup(t, { stream: async (_, input, { signal, onDelta }) => {
    active++; maximum = Math.max(maximum, active);
    try {
      if (input.at(-1).content === 'A') { started(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
      signal.throwIfAborted(); await onDelta(input.at(-1).content); return { text: '回答' + input.at(-1).content };
    } finally { active--; }
  } });
  const a = service.chat('changli', session.id, 'A', () => {}); await ready;
  const b = service.chat('changli', session.id, 'B', () => {}); const c = service.chat('changli', session.id, 'C', () => {});
  await Promise.all([a, b, c]);
  assert.equal(maximum, 1); assert.deepEqual(store.messages('changli', session.id).map(m => m.content), ['A', 'C', '回答C']);
});
test('编辑会中断旧生成，不能写回陈旧回复或陈旧记忆', async t => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const { store, service, session } = setup(t, { stream: async (_, __, { signal }) => { started(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  const run = service.chat('changli', session.id, '旧内容', () => {}); await ready;
  const messageId = store.messages('changli', session.id)[0].id;
  await service.mutate('changli', () => store.editMessage('changli', session.id, messageId, '新内容')); await run;
  assert.deepEqual(store.messages('changli', session.id).map(m => m.content), ['新内容']); assert.equal(store.listMemories('changli').length, 0);
});

test('停止在排队启动前生效，不得继续调用模型或写历史', async t => {
  let calls = 0;
  const { service, store, session } = setup(t, { count: async () => { calls++; return 50; } });
  const pending = service.chat('changli', session.id, '不该发送', () => {});
  service.interrupt('changli'); await pending;
  assert.equal(calls, 0); assert.equal(store.messages('changli', session.id).length, 0);
});

test('通道切换按角色持久，额度耗尽只暂停对应通道且不自动换模型', async t => {
  const { service, store, session } = setup(t, { stream: async () => { throw Object.assign(new Error('quota'), { code: 'quota_exhausted' }); } });
  let deepseekCalls = 0;
  service.models.deepseek = { count: async () => ({ used: 10, unit: 'characters', limit: 200000 }), stream: async (_, __, { onDelta }) => { deepseekCalls++; await onDelta('另一通道'); return { text: '另一通道' }; }, extractMemory: async () => [] };
  await assert.rejects(service.chat('changli', session.id, '你好', () => {}), { code: 'quota_exhausted' });
  assert.equal(deepseekCalls, 0);
  await service.mutate('changli', () => store.setProvider('changli', 'deepseek'));
  assert.equal(store.getProvider('aimisi'), 'openai');
  await service.chat('changli', session.id, '手动换通道', () => {});
  assert.equal(deepseekCalls, 1); assert.equal(service.isPaused('changli'), false); assert.equal(service.isPaused('aimisi'), true);
  assert.throws(() => store.setProvider('changli', 'openai', { actor: 'assistant' }), { code: 'USER_WRITE_REQUIRED' });
});
