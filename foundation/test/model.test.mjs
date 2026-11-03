import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelClient, readSSE } from '../src/model.mjs';
import { config } from './helpers.mjs';

const frame = event => `data: ${JSON.stringify(event)}\r\n\r\n`;
test('SSE跨字节片段和中文解码，忽略注释', async () => {
  const encoded = Buffer.from(':ping\r\n\r\n' + frame({ type: 'response.output_text.delta', delta: '你好' }));
  async function* chunks() { for (let i = 0; i < encoded.length; i += 3) yield encoded.subarray(i, i + 3); }
  const events = []; for await (const event of readSSE(chunks())) events.push(event);
  assert.equal(events[0].delta, '你好');
});
test('未完成SSE事件不能当作完成', async () => {
  async function* chunks() { yield Buffer.from('data: {"type":'); }
  await assert.rejects(async () => { for await (const event of readSSE(chunks())) void event; }, { code: 'incomplete_stream' });
});
test('真实请求形状：默认模型、流式、不存服务端对话、不自动截断', async () => {
  let sent;
  const client = new ModelClient(config, async (url, options) => {
    sent = JSON.parse(options.body);
    assert.equal(url, config.baseURL + '/responses');
    return new Response(frame({ type: 'response.output_text.delta', delta: '你好' }) + frame({ type: 'response.completed', response: { usage: { input_tokens: 10 } } }));
  });
  const deltas = [];
  const result = await client.stream('设定', [{ role: 'user', content: '你好' }], { onDelta: delta => deltas.push(delta) });
  assert.equal(result.text, '你好'); assert.deepEqual(deltas, ['你好']);
  assert.equal(sent.model, 'gpt-6.1-sol'); assert.equal(sent.store, false); assert.equal(sent.stream, true); assert.equal(sent.truncation, 'disabled');
  assert.equal(sent.previous_response_id, undefined);
});
test('余额耗尽与临时限流区分，无自动重试且不回显服务端敏感正文', async () => {
  let calls = 0;
  const client = new ModelClient(config, async () => { calls++; return Response.json({ error: { code: 'insufficient_quota', message: 'SECRET' } }, { status: 429 }); });
  await assert.rejects(client.count('', []), error => error.code === 'quota_exhausted' && !error.message.includes('SECRET'));
  assert.equal(calls, 1);
  const limited = new ModelClient(config, async () => Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 }));
  await assert.rejects(limited.count('', []), { code: 'model_rate_limit' });
});
test('缺API凭据时不发网络请求', async () => {
  let calls = 0;
  const client = new ModelClient({ ...config, apiKey: '' }, async () => { calls++; });
  await assert.rejects(client.count('', []), { code: 'model_unconfigured' }); assert.equal(calls, 0);
});
test('上下文长度用服务端精确值，无效计数拒绝', async () => {
  const client = new ModelClient(config, async url => { assert.match(url, /responses\/input_tokens$/); return Response.json({ input_tokens: 137 }); });
  assert.equal(await client.count('', []), 137);
  client.fetch = async () => Response.json({ input_tokens: '137' });
  await assert.rejects(client.count('', []), { code: 'invalid_count' });
});
test('流中断和不完整回复不能返回成功', async () => {
  const client = new ModelClient(config, async () => new Response(frame({ type: 'response.output_text.delta', delta: '半句' })));
  await assert.rejects(client.stream('', [], { onDelta() {} }), { code: 'incomplete_response' });
});
test('自动记忆结构校验，store:false且没有写资料工具', async () => {
  const client = new ModelClient(config, async (url, options) => {
    const sent = JSON.parse(options.body); assert.equal(sent.store, false); assert.equal(sent.tools, undefined);
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"memories":["喜欢茶"]}' }] }] });
  });
  assert.deepEqual(await client.extractMemory('我喜欢茶', '好'), ['喜欢茶']);
});
