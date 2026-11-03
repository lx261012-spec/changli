import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAccountClient } from '../src/codex-account.mjs';
import { tempDir } from './helpers.mjs';

const done = text => [{ type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed' }];
function fixture(t, { events = done('你好😀'), status = 'Logged in using ChatGPT', exitCode = 0, hold = false } = {}) {
  const calls = [];
  const spawn = (executable, args, options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null)); };
    const call = { executable, args, options, input: '', child }; calls.push(call);
    child.stdin.on('data', chunk => { call.input += chunk; });
    child.stdin.on('finish', () => queueMicrotask(() => {
      if (args[0] === 'login') { child.stderr.write(status); child.emit('close', 0); return; }
      if (hold) return;
      const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
      for (let i = 0; i < bytes.length && !child.killed; i += 3) child.stdout.write(bytes.subarray(i, i + 3));
      child.emit('close', exitCode);
    }));
    return child;
  };
  return { client: new CodexAccountClient({ executable: 'official-codex.exe', cwd: tempDir(t), model: 'gpt-6.1-sol', timeoutMs: 2000 }, spawn), calls };
}

test('账号通道只用官方客户端登录态，临时会话和隔离参数完整，中文跨字节解析正确', async t => {
  const { client, calls } = fixture(t);
  const deltas = [];
  assert.deepEqual(await client.stream('角色设定', [{ role: 'user', content: '你好' }], { onDelta: text => deltas.push(text) }), { text: '你好😀', usage: null });
  assert.deepEqual(deltas, ['你好😀']);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].args, ['login', 'status']);
  const request = calls[1];
  for (const arg of ['--ephemeral','--ignore-user-config','read-only','gpt-6.1-sol','shell_tool','apply_patch_freeform','hooks','plugins','multi_agent','project_doc_max_bytes=0','history.persistence="none"']) assert.ok(request.args.includes(arg));
  assert.equal(request.options.windowsHide, true);
  assert.deepEqual(JSON.parse(request.input), { instructions: '角色设定', conversation: [{ role: 'user', content: '你好' }] });
  for (const name of Object.keys(request.options.env)) assert.doesNotMatch(name, /API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|OPENAI_BASE_URL/i);
  assert.equal(request.options.env.CODEX_HOME, process.env.CODEX_HOME);
});

test('未登录账号时明确失败，不偷偷使用API密钥或发生成请求', async t => {
  const { client, calls } = fixture(t, { status: 'Not logged in' });
  await assert.rejects(client.stream('', [], { onDelta() {} }), { code: 'account_login_required' });
  assert.equal(calls.length, 1);
});

test('不完整、工具事件、非零退出和额度失败都不能保存为成功回复', async t => {
  for (const [events, exitCode, expected] of [
    [[{ type: 'item.completed', item: { type: 'agent_message', text: '半句' } }], 0, 'incomplete_response'],
    [[{ type: 'item.started', item: { type: 'command_execution', command: 'SECRET' } }], 0, 'invalid_stream'],
    [done('不该保存'), 1, 'account_failed'],
    [[{ type: 'turn.failed', error: { message: "You've hit your usage limit. SECRET" } }], 0, 'quota_exhausted'],
  ]) {
    const { client } = fixture(t, { events, exitCode });
    let emitted = false;
    await assert.rejects(client.stream('', [], { onDelta() { emitted = true; } }), error => error.code === expected && !error.message.includes('SECRET'));
    assert.equal(emitted, false);
  }
});

test('账号打断终止所属子进程，不输出迟到结果', async t => {
  const { client, calls } = fixture(t, { hold: true });
  const controller = new AbortController();
  const pending = client.stream('', [], { signal: controller.signal, onDelta() { assert.fail('Cancelled text must not be emitted'); } });
  while (calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('user_stop'));
  await assert.rejects(pending, /user_stop/); assert.equal(calls[1].child.killed, true);
});

test('账号超时终止挂起客户端，不自动重发', async t => {
  const { client, calls } = fixture(t, { hold: true });
  client.config.timeoutMs = 20;
  await assert.rejects(client.stream('', [], { onDelta() { assert.fail('Timed out text must not be emitted'); } }), { code: 'model_timeout' });
  assert.equal(calls.length, 2); assert.equal(calls[1].child.killed, true);
});

test('账号上下文只显示准确本机字符和保护阈值，超长不发生成或自动压缩', async t => {
  const { client, calls } = fixture(t);
  const counted = await client.count('中😀', [{ role: 'user', content: '你好' }]);
  assert.equal(counted.used, [...JSON.stringify({ instructions: '中😀', conversation: [{ role: 'user', content: '你好' }] })].length);
  assert.equal(counted.unit, 'characters'); assert.equal(counted.limit, 50000);
  await assert.rejects(client.stream('', [{ role: 'user', content: 'x'.repeat(50000) }], { onDelta() {} }), { code: 'context_limit' });
  assert.equal(calls.length, 1);
});

test('账号记忆使用独立临时生成并验证JSON、来源规则及长度', async t => {
  const { client, calls } = fixture(t, { events: done('{"memories":["喜欢茶"]}') });
  assert.deepEqual(await client.extractMemory('我喜欢茶', '好'), ['喜欢茶']);
  const sent = JSON.parse(calls[1].input); assert.match(sent.instructions, /不采信助手/);
  assert.deepEqual(JSON.parse(sent.conversation[0].content), { user: '我喜欢茶', assistant: '好' });
  const invalid = fixture(t, { events: done('{"memories":[""]}') });
  await assert.rejects(invalid.client.extractMemory('你好', '好'), { code: 'memory_invalid' });
});
