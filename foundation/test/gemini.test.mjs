import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient } from '../src/gemini.mjs';

const config = { apiKey: 'gemini-test-key', timeoutMs: 5000 };
const frame = event => `data: ${JSON.stringify(event)}\r\n\r\n`;
const candidate = (text, finishReason) => ({ candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] });

test('Gemini native SSE decodes fragmented Chinese and hides thoughts, credentials stay in headers', async () => {
  const client = new GeminiClient(config, async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    assert.equal(options.headers['x-goog-api-key'], config.apiKey); assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    const sent = JSON.parse(options.body);
    assert.deepEqual(sent.systemInstruction, { parts: [{ text: '设定' }] });
    assert.deepEqual(sent.contents.map(item => item.role), ['user', 'model', 'user']);
    assert.equal(sent.generationConfig.maxOutputTokens, 4096); assert.equal(sent.tools, undefined);
    const thought = { candidates: [{ content: { parts: [{ text: '不显示的思考', thought: true }] } }] };
    const source = Buffer.from(frame(thought) + frame(candidate('你好😀')) + frame({ ...candidate('。', 'STOP'), usageMetadata: { totalTokenCount: 20 } }));
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < source.length; i += 3) controller.enqueue(source.subarray(i, i + 3)); controller.close(); } }));
  });
  const deltas = [];
  const result = await client.stream('设定', [{ role: 'user', content: '前文' }, { role: 'assistant', content: '回答' }, { role: 'user', content: '你好' }], { onDelta: text => deltas.push(text) });
  assert.equal(result.text, '你好😀。'); assert.deepEqual(deltas, ['你好😀', '。']); assert.equal(result.usage.totalTokenCount, 20);
});

test('Gemini counts the full system and conversation using official countTokens and its own context limit', async () => {
  const client = new GeminiClient({ ...config, contextLimit: 8192 }, async (url, options) => {
    assert.match(url, /:countTokens$/);
    const sent = JSON.parse(options.body).generateContentRequest;
    assert.equal(sent.model, 'models/gemini-3.8-flash');
    assert.equal(sent.systemInstruction.parts[0].text, '长离设定'); assert.equal(sent.contents[0].parts[0].text, '用户消息');
    return Response.json({ totalTokens: 123 });
  });
  assert.deepEqual(await client.count('长离设定', [{ role: 'user', content: '用户消息' }]), { used: 123, unit: 'tokens', exact: true, limit: 4096 });
  for (const totalTokens of [-1, '123', null, 0.5]) {
    const invalid = new GeminiClient(config, async () => Response.json({ totalTokens }));
    await assert.rejects(invalid.count('', []), { code: 'invalid_count' });
  }
});

test('Gemini incomplete, blocked, empty, malformed and tool output cannot become saved replies', async () => {
  const sources = [frame(candidate('半句')), frame(candidate('', 'STOP')), frame(candidate('截断', 'MAX_TOKENS')), frame({ promptFeedback: { blockReason: 'SAFETY' } }), frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'send' } }] }, finishReason: 'STOP' }] }), 'data: {broken}\n\n', frame(candidate('半句')) + 'data: {'];
  for (const source of sources) {
    const client = new GeminiClient(config, async () => new Response(source));
    await assert.rejects(client.stream('', [], { onDelta() {} }), error => ['incomplete_response', 'invalid_stream', 'incomplete_stream'].includes(error.code));
  }
});

test('Gemini auth, quota and rate-limit failures do not echo provider secrets or retry', async () => {
  for (const [status, expected] of [[403, 'model_auth'], [402, 'quota_exhausted'], [429, 'model_rate_limit'], [500, 'model_provider']]) {
    let calls = 0;
    const client = new GeminiClient(config, async () => { calls++; return Response.json({ error: { code: status, status: 'RESOURCE_EXHAUSTED', message: 'SECRET' } }, { status }); });
    await assert.rejects(client.stream('', [], { onDelta() {} }), error => error.code === expected && !error.message.includes('SECRET'));
    assert.equal(calls, 1);
  }
  const client = new GeminiClient(config, async () => new Response(frame({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'SECRET' } })));
  await assert.rejects(client.stream('', [], { onDelta() {} }), error => error.code === 'model_rate_limit' && !error.message.includes('SECRET'));
});

test('Gemini missing key names GEMINI_API_KEY and never makes network requests', async () => {
  const client = new GeminiClient({}, () => { throw new Error('network should not run'); });
  for (const action of [() => client.count('', []), () => client.stream('', [], { onDelta() {} }), () => client.extractMemory('你好', '好')]) {
    await assert.rejects(action(), error => error.code === 'model_unconfigured' && error.message.includes('GEMINI_API_KEY'));
  }
});

test('Gemini abort blocks streaming and preserves cancellation through shared transport', async () => {
  const controller = new AbortController();
  const client = new GeminiClient(config, async () => new Response(frame(candidate('一')) + frame(candidate('二', 'STOP'))));
  const deltas = [];
  await assert.rejects(client.stream('', [], { signal: controller.signal, onDelta(text) { deltas.push(text); controller.abort(new Error('cancelled')); } }), /cancelled/);
  assert.deepEqual(deltas, ['一']);
  const network = new GeminiClient(config, async (_, { signal }) => { signal.throwIfAborted(); });
  await assert.rejects(network.count('', [], controller.signal), /cancelled/);
});

test('Gemini memory uses native JSON schema and validates user provenance, size and complete finish', async () => {
  const client = new GeminiClient(config, async (url, options) => {
    assert.match(url, /:generateContent$/); const sent = JSON.parse(options.body);
    assert.equal(sent.generationConfig.responseMimeType, 'application/json');
    assert.equal(sent.generationConfig.responseSchema.properties.memories.type, 'ARRAY');
    assert.equal(sent.tools, undefined); assert.match(sent.systemInstruction.parts[0].text, /只依据用户明确/);
    assert.deepEqual(JSON.parse(sent.contents[0].parts[0].text), { user: '我喜欢茶', assistant: '好' });
    return Response.json(candidate('{"memories":["喜欢茶"]}', 'STOP'));
  });
  assert.deepEqual(await client.extractMemory('我喜欢茶', '好'), ['喜欢茶']);
  for (const content of ['not-json', 'null', '{"memories":"茶"}', '{"memories":[""]}', JSON.stringify({ memories: ['x'.repeat(501)] }), '{"memories":["1","2","3","4"]}']) {
    const invalid = new GeminiClient(config, async () => Response.json(candidate(content, 'STOP')));
    await assert.rejects(invalid.extractMemory('你好', '好'), { code: 'memory_invalid' });
  }
  const truncated = new GeminiClient(config, async () => Response.json(candidate('{"memories":[]}')));
  await assert.rejects(truncated.extractMemory('你好', '好'), { code: 'memory_incomplete' });
});
