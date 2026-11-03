import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskManager } from '../src/tasks.mjs';
import { createUITarsOperator } from '../src/ui-tars.mjs';

const basic = { characterId: 'changli', appId: 'notepad', instruction: '完成测试任务' };
const semantic = capability => ({ kind: 'semantic', capability, description: capability });
function setup(t, factory, onEvent) {
  const parent = new URL('../.test-data/', import.meta.url);
  mkdirSync(parent, { recursive: true });
  const dataDir = mkdtempSync(join(fileURLToPath(parent), 'tasks-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return new TaskManager({ dataDir, operatorFactory: factory, onEvent });
}
async function until(manager, task, status) {
  for (let count = 0; count < 200; count++) {
    const snapshot = manager.get(task.characterId, task.id);
    if (snapshot.status === status) return snapshot;
    await delay(5);
  }
  assert.fail(`等待 ${status} 超时，当前 ${JSON.stringify(manager.get(task.characterId, task.id))}`);
}
async function released(manager) {
  for (let count = 0; count < 200 && manager.runs.size; count++) await delay(5);
  assert.equal(manager.runs.size, 0);
}

test('normal game/application capabilities are allowed inside the explicitly requested task', async t => {
  const executed = [];
  const manager = setup(t, () => ({ run: async (_, { onAction }) => {
    for (const cap of ['app.open', 'app.read', 'app.navigate', 'app.play', 'game.play']) await onAction(semantic(cap), () => executed.push(cap));
  } }));
  const task = manager.start(basic);
  assert.equal(task.status, 'running');
  await until(manager, task, 'completed');
  assert.equal(executed.length, 5);
  assert.equal(manager.get('changli', task.id).actions.length, 5);
  assert.throws(() => manager.get('aemeath', task.id), { code: 'not_found' });
  assert.equal(manager.list('aemeath').length, 0);
});

test('sensitive action blocks despite model risk=low, once is consumed for that action only', async t => {
  let executed = 0;
  const manager = setup(t, () => ({ run: async (_, { onAction }) => {
    await onAction({ ...semantic('message.send'), risk: 'low', requiresApproval: false }, () => executed++);
    await onAction(semantic('message.send'), () => executed++);
  } }));
  const task = manager.start(basic);
  const first = await until(manager, task, 'awaiting_approval');
  assert.equal(executed, 0);
  manager.approve('changli', task.id, first.approval.id, 'once');
  const second = await until(manager, task, 'awaiting_approval');
  assert.notEqual(second.approval.id, first.approval.id);
  assert.equal(executed, 1);
  assert.throws(() => manager.approve('changli', task.id, first.approval.id, 'once'), { code: 'invalid_state' });
  manager.approve('changli', task.id, second.approval.id, 'once');
  await until(manager, task, 'completed');
  assert.equal(executed, 2);
  assert.equal(manager.grants('changli').length, 0);
});

test('always is persisted and strictly scoped to character, application and capability; can revoke', async t => {
  let capability = 'message.send';
  let executed = 0;
  const factory = () => ({ run: async (_, { onAction }) => onAction(semantic(capability), () => executed++) });
  let manager = setup(t, factory);
  let task = manager.start(basic);
  let pending = await until(manager, task, 'awaiting_approval');
  manager.approve('changli', task.id, pending.approval.id, 'always');
  await until(manager, task, 'completed');
  const grant = manager.grants('changli')[0];
  assert.deepEqual([grant.characterId, grant.appId, grant.capability], ['changli', 'notepad', 'message.send']);
  manager = new TaskManager({ dataDir: manager.dataDir, operatorFactory: factory });
  task = manager.start(basic);
  await until(manager, task, 'completed');
  assert.equal(executed, 2);
  for (const change of [{ characterId: 'aemeath' }, { appId: 'music' }]) {
    task = manager.start({ ...basic, ...change });
    pending = await until(manager, task, 'awaiting_approval');
    manager.cancel(task.characterId, task.id);
    await released(manager);
  }
  capability = 'file.delete';
  task = manager.start(basic);
  await until(manager, task, 'awaiting_approval');
  manager.cancel('changli', task.id);
  await released(manager);
  capability = 'message.send';
  assert.throws(() => manager.revokeGrant('aemeath', grant.id), { code: 'not_found' });
  manager.revokeGrant('changli', grant.id);
  assert.equal(manager.grants('changli').length, 0);
  task = manager.start(basic);
  pending = await until(manager, task, 'awaiting_approval');
  manager.approve('changli', task.id, pending.approval.id, 'once');
  await until(manager, task, 'completed');
});

test('opaque coordinate action cannot masquerade as an ordinary app operation or gain wildcard permission', async t => {
  let executed = false;
  const manager = setup(t, () => ({ run: async (_, { onAction }) => onAction({ ...semantic('app.read'), type: 'click', x: 100, y: 50, risk: 'low' }, () => { executed = true; }) }));
  const task = manager.start(basic);
  const pending = await until(manager, task, 'awaiting_approval');
  assert.equal(pending.approval.capability, 'gui.action');
  assert.equal(pending.approval.allowAlways, false);
  assert.throws(() => manager.approve('changli', task.id, pending.approval.id, 'always'), { code: 'opaque_action' });
  assert.equal(executed, false);
  manager.approve('changli', task.id, pending.approval.id, 'once');
  await until(manager, task, 'completed');
  assert.equal(executed, true);
});

test('unrecognized capabilities require review, never support unrestricted always grants', async t => {
  const manager = setup(t, () => ({ run: async (_, { onAction }) => onAction(semantic('*'), () => {}) }));
  const task = manager.start(basic);
  const pending = await until(manager, task, 'awaiting_approval');
  assert.equal(pending.approval.allowAlways, false);
  manager.cancel('changli', task.id);
  await released(manager);
});

test('interrupt preserves progress, blocks all later actions and resumes through a fresh observation', async t => {
  let calls = 0;
  let executed = 0;
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const instructions = [];
  const manager = setup(t, () => ({ run: async (instruction, { signal, onAction, onData }) => {
    instructions.push(instruction);
    onData({ kind: 'observed' });
    calls++;
    await onAction(semantic('app.read'), () => executed++);
    if (calls === 1) {
      firstStarted();
      await held;
      assert.equal(signal.aborted, true);
      await onAction(semantic('app.read'), () => executed++);
    }
  } }));
  const task = manager.start(basic);
  await started;
  manager.interrupt('changli', task.id);
  assert.equal(manager.get('changli', task.id).status, 'paused');
  assert.throws(() => manager.resume('changli', task.id), { code: 'desktop_busy' });
  release();
  await released(manager);
  assert.equal(executed, 1);
  assert.equal(manager.get('changli', task.id).status, 'paused');
  manager.resume('changli', task.id);
  const completed = await until(manager, task, 'completed');
  assert.equal(executed, 2);
  assert.match(instructions[1], /先重新观察当前屏幕/);
  assert.match(instructions[1], /勿盲目重复/);
  assert.equal(completed.observations.length, 2);
});

test('interrupt while approval pending invalidates approval and never executes the input', async t => {
  let executed = 0;
  const manager = setup(t, () => ({ run: async (_, { onAction }) => onAction(semantic('payment.submit'), () => executed++) }));
  const task = manager.start(basic);
  const pending = await until(manager, task, 'awaiting_approval');
  manager.interrupt('changli', task.id);
  assert.throws(() => manager.approve('changli', task.id, pending.approval.id, 'once'), { code: 'invalid_state' });
  await released(manager);
  assert.equal(executed, 0);
  assert.equal(manager.get('changli', task.id).status, 'paused');
});

test('cancel closes approval and cannot be resumed', async t => {
  let executed = 0;
  const manager = setup(t, () => ({ run: async (_, { onAction }) => onAction(semantic('file.delete'), () => executed++) }));
  const task = manager.start(basic);
  await until(manager, task, 'awaiting_approval');
  manager.cancel('changli', task.id);
  await released(manager);
  assert.equal(manager.get('changli', task.id).status, 'cancelled');
  assert.equal(executed, 0);
  assert.throws(() => manager.resume('changli', task.id), { code: 'invalid_state' });
});

test('only one desktop executor across characters and manager instances', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const first = setup(t, () => ({ run: () => held }));
  const second = setup(t, () => ({ run: async () => {} }));
  const task = first.start(basic);
  assert.throws(() => first.start({ ...basic, characterId: 'aemeath' }), { code: 'desktop_busy' });
  assert.throws(() => second.start(basic), { code: 'desktop_busy' });
  first.cancel('changli', task.id);
  assert.throws(() => second.start(basic), { code: 'desktop_busy' });
  release();
  await released(first);
  const next = second.start(basic);
  await until(second, next, 'completed');
});

test('restarted running/awaiting tasks become paused and never auto-resume', async t => {
  let runs = 0;
  const manager = setup(t, () => ({ run: async () => { runs++; } }));
  const task = manager.start(basic);
  await until(manager, task, 'completed');
  const stored = JSON.parse(readFileSync(manager.path, 'utf8'));
  stored[0].status = 'awaiting_approval';
  stored[0].approval = { id: 'stale' };
  writeFileSync(manager.path, JSON.stringify(stored));
  const reloaded = new TaskManager({ dataDir: manager.dataDir, operatorFactory: () => ({ run: async () => { runs++; } }) });
  await delay(10);
  assert.equal(runs, 1);
  const paused = reloaded.get('changli', task.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.error.code, 'restart_interrupted');
  assert.equal(paused.approval, null);
  reloaded.resume('changli', task.id);
  await until(reloaded, task, 'completed');
  assert.equal(runs, 2);
});

test('missing configuration produces explicit unconfigured failure', async t => {
  const manager = setup(t, () => createUITarsOperator());
  const task = manager.start(basic);
  const failed = await until(manager, task, 'failed');
  assert.equal(failed.error.code, 'unconfigured');
  assert.match(failed.error.message, /GUI_MODEL/);
});

test('operator error cannot be reported as completed and observer errors do not affect execution', async t => {
  const manager = setup(t, () => ({ run: async () => { throw new Error('测试执行失败'); } }), () => { throw new Error('observer failed'); });
  const task = manager.start(basic);
  const failed = await until(manager, task, 'failed');
  assert.equal(failed.error.message, '测试执行失败');
});

test('cross-app action and invalid identifiers are rejected', async t => {
  const manager = setup(t, () => ({ run: async (_, { onAction }) => onAction({ ...semantic('app.open'), appId: 'other-app' }, () => assert.fail('must not run')) }));
  assert.throws(() => manager.start({ ...basic, appId: '*' }), { code: 'invalid_input' });
  assert.throws(() => manager.start({ ...basic, characterId: '../escape' }), { code: 'invalid_input' });
  const task = manager.start(basic);
  const failed = await until(manager, task, 'failed');
  assert.equal(failed.error.code, 'app_mismatch');
});

test('close immediately after start aborts before execution and waits until the desktop lease is released', async t => {
  let runs = 0;
  const manager = setup(t, () => ({ run: async () => { runs++; } }));
  const task = manager.start(basic);
  await manager.close();
  assert.equal(runs, 0);
  assert.equal(manager.runs.size, 0);
  assert.equal(manager.get('changli', task.id).status, 'paused');
  assert.throws(() => manager.start(basic), { code: 'closed', status: 409 });
  const next = setup(t, () => ({ run: async () => {} }));
  await until(next, next.start(basic), 'completed');
});

test('close during approval leaves restartable paused state and releases pending promises', async t => {
  const manager = setup(t, () => ({ run: async (_, { onAction }) => onAction(semantic('file.delete'), () => assert.fail('must not execute')) }));
  const task = manager.start(basic);
  await until(manager, task, 'awaiting_approval');
  await manager.close();
  assert.equal(manager.runs.size, 0);
  assert.equal(manager.get('changli', task.id).status, 'paused');
  assert.equal(manager.get('changli', task.id).approval, null);
});

test('installed SDK boundary: approvals, screenshot changes, cancellation, completion and key redaction', async t => {
  const { GUIAgent, StatusEnum } = await import('@ui-tars/sdk');
  const { NutJSOperator } = await import('@ui-tars/operator-nut-js');
  const config = { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'secret-test-key', model: 'test-gui', maxLoopCount: 7, uiTarsVersion: '1.5' };
  const params = { parsedPrediction: { action_type: 'click', action_inputs: { start_box: '(10,20)' } }, screenWidth: 100, screenHeight: 100, scaleFactor: 1, factors: [1, 1] };
  await t.test('real class constructors plus mocked native input enforce approval before executing', async t => {
    let executed = 0;
    let ready;
    const reached = new Promise(resolve => { ready = resolve; });
    let allow;
    const gate = new Promise(resolve => { allow = resolve; });
    t.mock.method(NutJSOperator.prototype, 'screenshot', async () => ({ base64: 'stable-screen', scaleFactor: 1 }));
    t.mock.method(NutJSOperator.prototype, 'execute', async () => { executed++; });
    t.mock.method(GUIAgent.prototype, 'run', async function () {
      assert.equal(this.config.maxLoopCount, 7);
      assert.equal(this.config.uiTarsVersion, '1.5');
      assert.equal(typeof this.config.logger.debug, 'function');
      await this.config.operator.screenshot();
      await this.config.operator.execute(params);
      this.config.onData({ data: { status: StatusEnum.END } });
    });
    const result = createUITarsOperator(config).run('test', { signal: new AbortController().signal, onAction: async (action, execute) => {
      assert.equal(action.opaque, true);
      ready();
      await gate;
      return execute();
    } });
    await reached;
    assert.equal(executed, 0);
    allow();
    await result;
    assert.equal(executed, 1);
  });
  await t.test('changed screen prevents stale coordinates from being executed', async t => {
    let observed = false;
    t.mock.method(NutJSOperator.prototype, 'screenshot', async () => ({ base64: observed ? 'new-screen' : (observed = true, 'original-screen'), scaleFactor: 1 }));
    t.mock.method(NutJSOperator.prototype, 'execute', async () => assert.fail('stale input must not execute'));
    t.mock.method(GUIAgent.prototype, 'run', async function () { await this.config.operator.screenshot(); await this.config.operator.execute(params); });
    await assert.rejects(createUITarsOperator(config).run('test', { signal: new AbortController().signal, onAction: (_, execute) => execute() }), { code: 'screen_changed' });
  });
  await t.test('SDK catching an input failure cannot continue a batch or report success', async t => {
    let approvals = 0;
    t.mock.method(NutJSOperator.prototype, 'screenshot', async () => ({ base64: 'same', scaleFactor: 1 }));
    t.mock.method(NutJSOperator.prototype, 'execute', async () => assert.fail('failed batch must not run'));
    t.mock.method(GUIAgent.prototype, 'run', async function () {
      await this.config.operator.screenshot();
      for (let count = 0; count < 2; count++) {
        try { await this.config.operator.execute(params); } catch {}
      }
      this.config.onData({ data: { status: StatusEnum.END } });
    });
    await assert.rejects(createUITarsOperator(config).run('test', { signal: new AbortController().signal, onAction: async () => { approvals++; throw Object.assign(new Error('approval rejected'), { code: 'denied' }); } }), { code: 'denied' });
    assert.equal(approvals, 1);
  });
  await t.test('aborted input is blocked, SDK user_stop cleanup remains harmless', async t => {
    const controller = new AbortController();
    t.mock.method(NutJSOperator.prototype, 'screenshot', async () => ({ base64: 'same', scaleFactor: 1 }));
    t.mock.method(NutJSOperator.prototype, 'execute', async () => assert.fail('aborted input must not execute'));
    t.mock.method(GUIAgent.prototype, 'run', async function () {
      await this.config.operator.screenshot();
      controller.abort();
      const stopped = await this.config.operator.execute({ parsedPrediction: { action_type: 'user_stop' } });
      assert.equal(stopped.status, StatusEnum.USER_STOPPED);
      await this.config.operator.execute(params);
    });
    await assert.rejects(createUITarsOperator(config).run('test', { signal: controller.signal, onAction: (_, execute) => execute() }), { code: 'task_interrupted' });
  });
  await t.test('swallowed SDK error is surfaced and API key is removed', async t => {
    t.mock.method(GUIAgent.prototype, 'run', async function () {
      this.config.onError({ error: new Error(`bad response ${config.apiKey}`) });
      this.config.onData({ data: { status: StatusEnum.ERROR } });
    });
    await assert.rejects(createUITarsOperator(config).run('test', { signal: new AbortController().signal, onAction: (_, execute) => execute() }), error => error.code === 'operator_failed' && !error.message.includes(config.apiKey) && error.message.includes('[REDACTED]'));
  });
  await t.test('thrown errors are redacted and absent completion never counts as success', async t => {
    t.mock.method(GUIAgent.prototype, 'run', async () => { throw new Error(`failure ${config.apiKey}`); });
    await assert.rejects(createUITarsOperator(config).run('test', { signal: new AbortController().signal, onAction: (_, execute) => execute() }), error => !error.message.includes(config.apiKey));
    t.mock.method(GUIAgent.prototype, 'run', async () => {});
    await assert.rejects(createUITarsOperator(config).run('test', { signal: new AbortController().signal, onAction: (_, execute) => execute() }), { code: 'operator_incomplete' });
  });
});
