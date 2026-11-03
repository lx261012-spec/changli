import test from 'node:test';
import assert from 'node:assert/strict';
import { ProactiveCare, identifySoftware } from '../src/proactive-care.mjs';
import { Store } from '../src/store.mjs';
import { tempDir } from './helpers.mjs';

function fixture(options = {}) {
  let time = 0, saved = {}, draws = 0;
  const store = { getCareState: () => structuredClone(saved), saveCareState: (_, value) => { saved = structuredClone(value); } };
  const f = { store, now: () => time, random: () => { draws++; return options.draw ?? 0; }, probabilities: [.2, .4, .7, 1], timeoutAction: 'ignore', ...options };
  let engine = new ProactiveCare(f);
  return {
    get engine() { return engine; }, get draws() { return draws; },
    restart() { engine = new ProactiveCare(f); },
    sample(foreground = 'wps', running = ['wps']) { engine.sample({ foreground, running }); },
    advance(minutes, foreground = 'wps', running = ['wps']) { for (let i = 0; i < minutes * 12; i++) { time += 5000; engine.sample({ foreground, running }); } },
    jump(ms) { time += ms; },
  };
}

test('进程识别只认明确映射，不把浏览器或通用Java冒认GPT/我的世界', () => {
  assert.deepEqual(identifySoftware({ foreground: 'WPS.EXE', running: ['wps', 'chrome', 'javaw'] }), { foreground: 'wps', running: ['wps'] });
  assert.equal(identifySoftware({ foreground: 'chrome', running: ['chrome'] }).foreground, null);
  assert.equal(identifySoftware({ foreground: 'custom', running: ['custom'] }, { dsh: ['custom'] }).foreground, 'dsh');
});

test('完整程序路径区分桌面Codex与同名后台CLI，路径读取失败不冒认', () => {
  const paths = { gpt: ['C:/Apps/Codex/app/Codex.exe'], dsh: ['C:/Apps/DeepSeek Harness/DeepSeek Harness.exe'] };
  const sample = { foreground: 'codex', foregroundId: 1, running: ['codex', 'DeepSeek Harness'], processes: [
    { id: 1, path: 'C:/Tools/codex.exe' }, { id: 2, path: 'c:\\apps\\codex\\app\\CODEX.EXE' }, { id: 3, path: paths.dsh[0] },
  ] };
  assert.deepEqual(identifySoftware(sample, undefined, paths), { running: ['gpt', 'dsh'], foreground: null });
  sample.foregroundId = 2;
  assert.equal(identifySoftware(sample, undefined, paths).foreground, 'gpt');
  sample.processes = [{ id: 1, path: '' }];
  assert.deepEqual(identifySoftware(sample, undefined, paths).running, []);
});

test('前台累计、后台暂停保留、长时间失联不计入；策略未定时不抽取', () => {
  const f = fixture({ probabilities: null, timeoutAction: null }); f.sample(); f.advance(20);
  f.advance(20, null); assert.equal(f.engine.snapshot().rounds.wps.activeMs, 20 * 60000);
  f.sample(); f.advance(10); f.jump(3600000); f.sample();
  assert.equal(f.engine.snapshot().rounds.wps.activeMs, 30 * 60000);
  assert.equal(f.draws, 0); assert.equal(f.engine.snapshot().policyReady, false);
});

test('30/40/50/60分钟每点只抽一次，首次成功后不再抽；非每帧递增', () => {
  const f = fixture({ draw: .99 }); f.sample(); f.advance(29); assert.equal(f.draws, 0);
  f.advance(1); assert.equal(f.draws, 1); f.sample(); assert.equal(f.draws, 1);
  f.advance(30); assert.equal(f.draws, 4); assert.equal(f.engine.snapshot().rounds.wps.status, 'queued');
  f.advance(30); assert.equal(f.draws, 4);
});

test('只在显示回执后开始10秒倒计时，重复回执不重复计邀请', () => {
  const f = fixture(); f.sample(); f.advance(30);
  const invite = f.engine.snapshot().rounds.wps.invitation; assert.equal(invite.expiresAt, null);
  assert.equal(f.engine.snapshot().rounds.wps.invitations, 0);
  const first = f.engine.present(invite.id); f.jump(1000);
  assert.deepEqual(f.engine.present(invite.id), first);
  assert.equal(f.engine.snapshot().rounds.wps.invitations, 1);
});

test('首次拒绝30分钟前台时间后只补邀一次；二拒停止，重启不绕过', () => {
  const f = fixture(); f.sample(); f.advance(30);
  let id = f.engine.snapshot().rounds.wps.invitation.id; f.engine.present(id); f.engine.respond(id, 'reject');
  assert.throws(() => f.engine.respond(id, 'reject'), { code: 'care_conflict' });
  f.advance(29); assert.equal(f.engine.snapshot().rounds.wps.status, 'retry_wait');
  f.advance(1); id = f.engine.snapshot().rounds.wps.invitation.id; f.engine.present(id); f.engine.respond(id, 'reject');
  f.restart(); f.sample(); f.advance(120);
  assert.equal(f.engine.snapshot().rounds.wps.status, 'stopped');
  assert.equal(f.engine.snapshot().rounds.wps.rejections, 2);
  assert.equal(f.engine.snapshot().rounds.wps.invitations, 2);
});

test('软件完全退出满5分钟才新一轮，短暂切窗/退出保留原轮次；离线不当退出', () => {
  const f = fixture(); f.sample(); f.advance(10); const id = f.engine.snapshot().rounds.wps.id;
  f.advance(3, null, []); f.sample(); assert.equal(f.engine.snapshot().rounds.wps.id, id);
  f.sample(null, []); f.jump(3600000); f.sample(null, []);
  assert.notEqual(f.engine.snapshot().rounds.wps.status, 'ended');
  f.advance(5, null, []); assert.equal(f.engine.snapshot().rounds.wps.status, 'ended');
  f.sample(); assert.notEqual(f.engine.snapshot().rounds.wps.id, id);
});

test('接听结束本轮；超时不冒充有效点击，忽略策略不算拒绝或补邀', () => {
  const f = fixture(); f.sample(); f.advance(30); let id = f.engine.snapshot().rounds.wps.invitation.id;
  f.engine.present(id); f.engine.respond(id, 'accept'); f.advance(90);
  assert.equal(f.engine.snapshot().rounds.wps.status, 'accepted');
  const g = fixture(); g.sample(); g.advance(30); id = g.engine.snapshot().rounds.wps.invitation.id;
  g.engine.present(id); g.advance(1);
  assert.equal(g.engine.snapshot().rounds.wps.status, 'ignored');
  assert.equal(g.engine.snapshot().rounds.wps.rejections, 0);
  assert.throws(() => g.engine.respond(id, 'reject'), { code: 'care_conflict' });
});

test('真实SQLite保存重开后仍保留拒绝和轮次，角色状态独立', t => {
  const directory = tempDir(t); let store = new Store(directory);
  try {
    store.saveCareState('changli', { wps: { id: 'round', rejections: 2, status: 'stopped' } });
    store.close(); store = new Store(directory);
    assert.equal(store.getCareState('changli').wps.rejections, 2);
    assert.deepEqual(store.getCareState('aimisi'), {});
  } finally { store.close(); }
});

test('进入邀请立即排队且同轮只一次；接听进入台词后仍有独立时长检查点', () => {
  const f = fixture({ entryEnabled: true }); f.sample('qqmusic', ['qqmusic']);
  let round = f.engine.snapshot().rounds.qqmusic;
  assert.equal(round.activeMs, 0); assert.equal(round.invitation.kind, 'entry'); assert.equal(f.draws, 0);
  const id = round.invitation.id; f.engine.present(id); f.engine.respond(id, 'accept');
  f.restart(); f.sample('qqmusic', ['qqmusic']); f.advance(29, 'qqmusic', ['qqmusic']);
  round = f.engine.snapshot().rounds.qqmusic;
  assert.equal(round.status, 'timing'); assert.equal(round.invitations, 1);
  f.advance(1, 'qqmusic', ['qqmusic']); round = f.engine.snapshot().rounds.qqmusic;
  assert.equal(round.invitation.kind, 'duration'); assert.equal(f.draws, 1);
});

test('进入邀请超时不计拒绝、不重弹，时长仍正常计时；后台存在不触发', () => {
  const f = fixture({ entryEnabled: true }); f.sample(null, ['qqmusic']);
  assert.equal(f.engine.snapshot().rounds.qqmusic, undefined);
  f.sample('qqmusic', ['qqmusic']); const id = f.engine.snapshot().rounds.qqmusic.invitation.id;
  f.engine.present(id); f.jump(10001); f.sample('qqmusic', ['qqmusic']);
  f.restart(); f.sample('qqmusic', ['qqmusic']);
  const round = f.engine.snapshot().rounds.qqmusic;
  assert.equal(round.status, 'timing'); assert.equal(round.rejections, 0); assert.equal(round.invitations, 1); assert.equal(round.invitation, null);
});

test('进入拒绝后只按30分钟前台时间补邀；旧停止、已接听或忽略状态不因启用进入而重置', () => {
  const f = fixture({ entryEnabled: true }); f.sample();
  const id = f.engine.snapshot().rounds.wps.invitation.id;
  f.engine.present(id); f.engine.respond(id, 'reject');
  f.advance(29); assert.equal(f.engine.snapshot().rounds.wps.status, 'retry_wait');
  f.advance(1); const next = f.engine.snapshot().rounds.wps.invitation;
  assert.equal(next.kind, 'duration'); f.engine.present(next.id); f.engine.respond(next.id, 'reject');
  f.restart(); f.sample(); assert.equal(f.engine.snapshot().rounds.wps.status, 'stopped');
  for (const status of ['accepted', 'ignored', 'stopped', 'retry_wait']) {
    f.engine.rounds.wps = { id: 'legacy', activeMs: 0, checkpoint: 0, invitations: 1, rejections: 0, status, absentSince: null, invitation: null, retryAtMs: 1800000 };
    f.sample(); assert.equal(f.engine.snapshot().rounds.wps.status, status);
    assert.equal(f.engine.snapshot().rounds.wps.id, 'legacy');
  }
});
