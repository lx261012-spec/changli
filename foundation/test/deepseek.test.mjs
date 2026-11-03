import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekClient } from '../src/deepseek.mjs';

const config = { apiKey: 'deepseek-test-key', timeoutMs: 5000, maxOutputTokens: 4096 };
const frame = data => `data: ${JSON.stringify(data)}\r\n\r\n`;
const delta = content => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const stop = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
const done = 'data: [DONE]\r\n\r\n';
const complete = content => frame(delta(content)) + frame(stop) + done;

test('DeepSeek uses non-thinking Chat Completions and decodes fragmented Chinese SSE', async () => {
  const client = new DeepSeekClient(config, async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const sent = JSON.parse(options.body);
    assert.equal(sent.model, 'deepseek-flash'); assert.deepEqual(sent.thinking, { type: 'disabled' });
    assert.deepEqual(sent.messages, [{ role: 'system', content: '设定' }, { role: 'user', content: '你好' }]);
    assert.equal(sent.stream, true); assert.equal(sent.stream_options.include_usage, true);
    assert.equal(sent.max_tokens, 4096); assert.equal(sent.instructions, undefined); assert.equal(sent.input, undefined);
    assert.equal(sent.tools, undefined); assert.equal(sent.reasoning, undefined); assert.equal(sent.store, undefined);
    const encoded = Buffer.from(': heartbeat\r\n\r\n' + complete('你好😀'));
    return new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < encoded.length; offset += 3) controller.enqueue(encoded.subarray(offset, offset + 3));
      controller.close();
    } }));
  });
  const deltas = []; const result = await client.stream('设定', [{ role: 'user', content: '你好' }], { onDelta: text => deltas.push(text) });
  assert.equal(result.text, '你好😀'); assert.deepEqual(deltas, ['你好😀']); assert.deepEqual(result.usage, stop.usage);
});

test('DeepSeek requires both stop and DONE and rejects partial, tool and empty replies', async () => {
  for (const source of [frame(delta('半句')), frame(delta('半句')) + frame(stop), frame(delta('半句')) + done, frame(stop) + done]) {
    const client = new DeepSeekClient(config, async () => new Response(source));
    await assert.rejects(client.stream('', [], { onDelta() {} }), { code: 'incomplete_response' });
  }
  for (const reason of ['length', 'content_filter', 'tool_calls', 'insufficient_system_resource', 'aborted']) {
    const client = new DeepSeekClient(config, async () => new Response(frame(delta('部分')) + frame({ choices: [{ delta: {}, finish_reason: reason }] }) + done));
    await assert.rejects(client.stream('', [], { onDelta() {} }), { code: 'incomplete_response' });
  }
  const client = new DeepSeekClient(config, async () => new Response(frame({ choices: [{ delta: { tool_calls: [{}] } }] })));
  await assert.rejects(client.stream('', [], { onDelta() {} }), { code: 'invalid_stream' });
});

test('DeepSeek handles HTTP balance, rate-limit and authentication without retry or sensitive error echo', async () => {
  for (const [status, expected] of [[402, 'quota_exhausted'], [429, 'model_rate_limit'], [401, 'model_auth']]) {
    let calls = 0;
    const client = new DeepSeekClient(config, async () => { calls++; return Response.json({ error: { code: 'provider_error', message: 'SECRET' } }, { status }); });
    await assert.rejects(client.stream('', [], { onDelta() {} }), error => error.code === expected && !error.message.includes('SECRET'));
    assert.equal(calls, 1);
  }
});

test('DeepSeek detects quota errors inside a successful HTTP stream', async () => {
  const client = new DeepSeekClient(config, async () => new Response(frame({ error: { code: 'insufficient_quota', message: 'SECRET' } })));
  await assert.rejects(client.stream('', [], { onDelta() {} }), error => error.code === 'quota_exhausted' && !error.message.includes('SECRET'));
});

test('DeepSeek local context display counts Unicode characters with no token estimate or network call', async () => {
  const client = new DeepSeekClient({}, () => { throw new Error('No network call expected'); });
  const empty = await client.count('', [{ role: 'user', content: '' }]);
  const counted = await client.count('中😀', [{ role: 'user', content: '好😀' }]);
  assert.equal(counted.used - empty.used, 4);
  assert.equal(counted.unit, 'characters'); assert.equal(counted.exact, true); assert.equal(counted.limit, 200000);
  assert.equal(counted.tokens, undefined);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(client.count('', [], controller.signal), /cancelled/);
});

test('DeepSeek missing key prevents requests and names its own environment variable', async () => {
  let calls = 0; const client = new DeepSeekClient({}, async () => { calls++; });
  await assert.rejects(client.stream('', [], { onDelta() {} }), error => error.code === 'model_unconfigured' && error.message.includes('DEEPSEEK_API_KEY'));
  await assert.rejects(client.extractMemory('你好', '好'), { code: 'model_unconfigured' });
  assert.equal(calls, 0);
});

test('DeepSeek memory extraction uses JSON mode, validates provenance input and has no write tools', async () => {
  const client = new DeepSeekClient(config, async (url, options) => {
    assert.match(url, /chat\/completions$/);
    const sent = JSON.parse(options.body);
    assert.equal(sent.stream, false); assert.deepEqual(sent.thinking, { type: 'disabled' });
    assert.deepEqual(sent.response_format, { type: 'json_object' }); assert.equal(sent.tools, undefined);
    assert.match(sent.messages[0].content, /JSON/);
    assert.deepEqual(JSON.parse(sent.messages[1].content), { user: '我喜欢茶', assistant: '好' });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"memories":["喜欢茶"]}' } }] });
  });
  assert.deepEqual(await client.extractMemory('我喜欢茶', '好'), ['喜欢茶']);
});

test('DeepSeek rejects invalid or truncated memory output', async () => {
  for (const content of ['not-json', 'null', '{"memories":"茶"}', '{"memories":[""]}', JSON.stringify({ memories: ['x'.repeat(501)] }), '{"memories":["1","2","3","4"]}']) {
    const client = new DeepSeekClient(config, async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    await assert.rejects(client.extractMemory('你好', '好'), { code: 'memory_invalid' });
  }
  const client = new DeepSeekClient(config, async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"memories":[]}' } }] }));
  await assert.rejects(client.extractMemory('你好', '好'), { code: 'memory_incomplete' });
});
