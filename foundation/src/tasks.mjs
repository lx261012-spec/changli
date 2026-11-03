import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_ALLOWED = new Set(['app.open', 'app.read', 'app.navigate', 'app.play', 'game.play']);
const SENSITIVE = new Set(['message.send', 'file.delete', 'file.overwrite', 'payment.submit', 'system.configure', 'account.modify', 'app.install', 'data.share', 'permission.modify']);
const ACTIVE = new Set(['running', 'awaiting_approval']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
let desktopOwner;

function failure(code, message) {
  const status = { invalid_input: 400, invalid_action: 400, opaque_action: 403, app_mismatch: 403, not_found: 404, desktop_busy: 409, invalid_state: 409, closed: 409, storage_error: 500, unconfigured: 503 }[code] || 500;
  return Object.assign(new Error(message), { code, status });
}
function id(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) throw failure('invalid_input', `${label} 必须是有效标识。`);
  return value;
}
function copy(value) { return structuredClone(value); }
function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw failure('storage_error', `不能读取任务数据：${error.message}`); }
}
function saveJSON(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}

// Only trusted adapters may emit semantic capabilities; model-supplied risk labels never authorize an action.
function classify(action) {
  if (!action || typeof action !== 'object') throw failure('invalid_action', '执行器未提供动作。');
  const opaque = action.opaque === true || action.kind !== 'semantic' || action.parsedPrediction || action.prediction ||
    /^(click|type|hotkey|press|release|scroll|drag|hover|mouse_move|left_|right_|double_)/.test(action.type || '') ||
    ['x', 'y', 'coordinates', 'start_box'].some(key => Object.hasOwn(action, key));
  const capability = opaque ? 'gui.action' : action.capability;
  return {
    capability: typeof capability === 'string' ? capability : 'unknown.action',
    automatic: !opaque && DEFAULT_ALLOWED.has(capability),
    allowAlways: !opaque && SENSITIVE.has(capability),
    description: String(action.description || action.type || capability || '未识别操作').slice(0, 4000),
    ...(opaque ? { detail: String(action.detail || action.prediction || JSON.stringify(action)).slice(0, 8000) } : {}),
  };
}

export class TaskManager {
  constructor({ dataDir, operatorFactory, onEvent = () => {} }) {
    if (!dataDir) throw failure('invalid_input', '需要任务存储目录。');
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    this.path = join(this.dataDir, 'tasks.json');
    this.grantsPath = join(this.dataDir, 'grants.json');
    this.lockPath = join(this.dataDir, 'desktop-executor.lock');
    this.tasks = readJSON(this.path, []);
    this.permissions = readJSON(this.grantsPath, []);
    if (!Array.isArray(this.tasks) || !Array.isArray(this.permissions)) throw failure('storage_error', '任务数据格式错误。');
    this.operatorFactory = operatorFactory;
    this.onEvent = onEvent;
    this.runs = new Map();
    let changed = false;
    for (const task of this.tasks) {
      if (ACTIVE.has(task.status)) {
        task.status = 'paused';
        task.approval = null;
        task.error = { code: 'restart_interrupted', message: '程序重启，任务已暂停；请确认后恢复。' };
        changed = true;
      }
    }
    if (changed) saveJSON(this.path, this.tasks);
  }

  #task(characterId, taskId) {
    id(characterId, '角色');
    const task = this.tasks.find(item => item.characterId === characterId && item.id === taskId);
    if (!task) throw failure('not_found', '找不到此角色的任务。');
    return task;
  }

  #update(task) {
    task.updatedAt = new Date().toISOString();
    saveJSON(this.path, this.tasks);
    try { this.onEvent({ type: 'task', task: copy(task) }); } catch { /* Observers cannot change task execution. */ }
  }

  #acquire(task) {
    if (desktopOwner) throw failure('desktop_busy', '电脑执行器正在处理另一项任务，需先停止或暂停它。');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = openSync(this.lockPath, 'wx', 0o600);
        try { writeFileSync(handle, JSON.stringify({ pid: process.pid, taskId: task.id })); }
        finally { closeSync(handle); }
        desktopOwner = { manager: this, taskId: task.id };
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const lock = readJSON(this.lockPath, {});
        if (Number.isInteger(lock.pid) && lock.pid > 0) {
          try { process.kill(lock.pid, 0); }
          catch (probe) { if (probe.code === 'ESRCH') { unlinkSync(this.lockPath); continue; } }
        }
        throw failure('desktop_busy', '另一进程持有电脑执行锁；未自动抢占。');
      }
    }
    throw failure('desktop_busy', '无法取得电脑执行锁。');
  }

  #release(task) {
    if (desktopOwner?.manager === this && desktopOwner.taskId === task.id) {
      desktopOwner = undefined;
      const lock = readJSON(this.lockPath, {});
      if (lock.pid === process.pid && lock.taskId === task.id) unlinkSync(this.lockPath);
    }
  }

  start({ characterId, appId, instruction }) {
    if (this.closed) throw failure('closed', '任务管理器已关闭。');
    id(characterId, '角色'); id(appId, '应用');
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 16000) throw failure('invalid_input', '任务描述需为 1～16000 字符。');
    const task = { id: randomUUID(), characterId, appId, instruction: instruction.trim(), status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), actions: [], observations: [], approval: null, error: null };
    this.#acquire(task);
    this.tasks.push(task);
    try { this.#update(task); this.#launch(task, false); }
    catch (error) { this.#release(task); throw error; }
    return copy(task);
  }

  get(characterId, taskId) { return copy(this.#task(characterId, taskId)); }
  list(characterId) { id(characterId, '角色'); return copy(this.tasks.filter(task => task.characterId === characterId)); }
  grants(characterId) { id(characterId, '角色'); return copy(this.permissions.filter(grant => grant.characterId === characterId)); }
  revokeGrant(characterId, grantId) {
    id(characterId, '角色');
    const index = this.permissions.findIndex(grant => grant.characterId === characterId && grant.id === grantId);
    if (index < 0) throw failure('not_found', '找不到此角色的授权。');
    this.permissions.splice(index, 1);
    saveJSON(this.grantsPath, this.permissions);
    return { revoked: true };
  }

  #stop(task, status) {
    if (TERMINAL.has(task.status)) throw failure('invalid_state', '任务已经结束。');
    const run = this.runs.get(task.id);
    task.status = status;
    task.approval = null;
    run?.controller.abort(failure('task_interrupted', '任务已被用户打断。'));
    try { run?.operator?.stop?.(); } catch { /* The action gate remains closed even if the SDK cannot stop. */ }
    this.#update(task);
    return copy(task);
  }

  interrupt(characterId, taskId) { return this.#stop(this.#task(characterId, taskId), 'paused'); }
  cancel(characterId, taskId) { return this.#stop(this.#task(characterId, taskId), 'cancelled'); }
  resume(characterId, taskId) {
    if (this.closed) throw failure('closed', '任务管理器已关闭。');
    const task = this.#task(characterId, taskId);
    if (task.status !== 'paused') throw failure('invalid_state', '只有暂停任务可以恢复。');
    this.#acquire(task);
    task.status = 'running'; task.error = null; task.approval = null;
    try { this.#update(task); this.#launch(task, true); }
    catch (error) { this.#release(task); throw error; }
    return copy(task);
  }

  approve(characterId, taskId, approvalId, mode) {
    const task = this.#task(characterId, taskId);
    const run = this.runs.get(task.id);
    const approval = task.approval;
    if (task.status !== 'awaiting_approval' || approval?.id !== approvalId || !run?.approval) throw failure('invalid_state', '此审批已失效。');
    if (mode !== 'once' && mode !== 'always') throw failure('invalid_input', '请选择仅本次允许或始终允许。');
    if (mode === 'always' && !approval.allowAlways) throw failure('opaque_action', '原始坐标和按键无法可靠绑定应用或判断提交含义，目前只能逐次审阅。');
    if (mode === 'always' && !this.permissions.some(grant => grant.characterId === characterId && grant.appId === task.appId && grant.capability === approval.capability)) {
      this.permissions.push({ id: randomUUID(), characterId, appId: task.appId, capability: approval.capability, createdAt: new Date().toISOString() });
      saveJSON(this.grantsPath, this.permissions);
    }
    task.status = 'running'; task.approval = null;
    this.#update(task);
    run.approval.resolve();
    run.approval = null;
    return copy(task);
  }

  #launch(task, resumed) {
    const run = { controller: new AbortController(), operator: null, approval: null };
    this.runs.set(task.id, run);
    run.done = Promise.resolve().then(() => this.#execute(task, run, resumed));
    run.done.catch(() => {});
  }

  async settled() { await Promise.all([...this.runs.values()].map(run => run.done)); }

  async close() {
    this.closed = true;
    for (const task of this.tasks) {
      if (this.runs.has(task.id) && !TERMINAL.has(task.status)) this.#stop(task, 'paused');
    }
    await this.settled();
  }

  #check(task, run) {
    if (this.runs.get(task.id) !== run || run.controller.signal.aborted || !ACTIVE.has(task.status)) throw failure('task_interrupted', '任务已暂停或结束，后续操作被阻止。');
  }

  async #action(task, run, action, execute) {
    this.#check(task, run);
    if (typeof execute !== 'function') throw failure('invalid_action', '动作缺少执行函数。');
    if (action?.appId && action.appId !== task.appId) throw failure('app_mismatch', '动作目标应用超出任务授权范围。');
    const policy = classify(action);
    const record = { id: randomUUID(), ...policy, status: 'pending', at: new Date().toISOString() };
    task.actions.push(record);
    task.actions = task.actions.slice(-200);
    const hasGrant = policy.allowAlways && this.permissions.some(grant => grant.characterId === task.characterId && grant.appId === task.appId && grant.capability === policy.capability);
    if (!policy.automatic && !hasGrant) {
      task.status = 'awaiting_approval';
      task.approval = { id: randomUUID(), actionId: record.id, appId: task.appId, ...policy, reason: policy.capability === 'gui.action' ? '该原始 GUI 输入无法可靠判断是否涉及发送、删除或付款，请审阅操作详情和当前屏幕。' : '该能力需要你确认。' };
      let abort;
      const pending = new Promise((resolve, reject) => {
        run.approval = { resolve, reject };
        abort = () => reject(failure('task_interrupted', '审批已取消。'));
        run.controller.signal.addEventListener('abort', abort, { once: true });
      });
      this.#update(task);
      try { await pending; }
      finally { run.controller.signal.removeEventListener('abort', abort); }
    }
    this.#check(task, run);
    record.status = 'executing';
    this.#update(task);
    try {
      const result = await execute();
      record.status = 'completed';
      record.finishedAt = new Date().toISOString();
      this.#update(task);
      this.#check(task, run);
      return result;
    } catch (error) {
      if (record.status === 'executing') record.status = 'failed';
      this.#update(task);
      throw error;
    }
  }

  async #execute(task, run, resumed) {
    const timer = setTimeout(() => {
      if (ACTIVE.has(task.status)) {
        task.status = 'failed'; task.approval = null;
        task.error = { code: 'task_timeout', message: '任务超过 5 分钟，已停止。' };
        run.controller.abort();
        try { run.operator?.stop?.(); } catch {}
        this.#update(task);
      }
    }, 300000);
    timer.unref();
    try {
      this.#check(task, run);
      if (typeof this.operatorFactory !== 'function') throw failure('unconfigured', '尚未配置电脑操作模型与执行器。');
      run.operator = await this.operatorFactory({ characterId: task.characterId, appId: task.appId, taskId: task.id });
      this.#check(task, run);
      if (typeof run.operator?.run !== 'function') throw failure('unconfigured', '电脑操作执行器不可用。');
      const instruction = resumed ? `${task.instruction}\n\n用户主动恢复任务。必须先重新观察当前屏幕，勿盲目重复已发生的提交动作。已完成动作记录：${JSON.stringify(task.actions.filter(action => action.status === 'completed'))}` : task.instruction;
      await run.operator.run(instruction, {
        signal: run.controller.signal,
        onAction: (action, execute) => this.#action(task, run, action, execute),
        onData: data => {
          if (run.controller.signal.aborted || this.runs.get(task.id) !== run) return;
          task.observations.push({ at: new Date().toISOString(), kind: String(data?.kind || 'status').slice(0, 50), status: String(data?.status || '').slice(0, 100), text: String(data?.text || '').slice(0, 2000) });
          task.observations = task.observations.slice(-100);
          this.#update(task);
        },
      });
      this.#check(task, run);
      task.status = 'completed';
    } catch (error) {
      if (ACTIVE.has(task.status)) {
        task.status = 'failed';
        task.error = { code: String(error.code || 'operator_failed'), message: String(error.message || '电脑操作失败。').slice(0, 2000) };
      }
    } finally {
      clearTimeout(timer);
      task.approval = null;
      for (const action of task.actions) if (action.status === 'pending') action.status = 'interrupted';
      this.runs.delete(task.id);
      this.#release(task);
      this.#update(task);
    }
  }
}
