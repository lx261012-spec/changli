import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';

const WEEK = 7 * 24 * 60 * 60 * 1000;

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aimisi-store-'));
  let store = new Store(directory, options);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() { return store; },
    directory,
    reopen() { store.close(); store = new Store(directory, options); return store; },
  };
}

function error(status, code) {
  return value => value.status === status && value.code === code;
}

function conversation(store, characterId = 'changli') {
  const session = store.createSession(characterId);
  const messages = [
    store.addMessage(characterId, session.id, 'user', '我喜欢茶。'),
    store.addMessage(characterId, session.id, 'assistant', '记住了。'),
    store.addMessage(characterId, session.id, 'user', '以后一起喝茶。'),
    store.addMessage(characterId, session.id, 'assistant', '好。'),
  ];
  return { session, messages };
}

test('新库使用指定默认通道，重启不覆盖用户后来手动选择的通道', t => {
  const state = fixture(t, { defaultProvider: 'deepseek' });
  assert.equal(state.store.getProvider('changli'), 'deepseek'); assert.equal(state.store.getProvider('aimisi'), 'deepseek');
  state.store.setProvider('changli', 'gemini'); state.reopen();
  assert.equal(state.store.getProvider('changli'), 'gemini'); assert.equal(state.store.getProvider('aimisi'), 'deepseek');
});

test('角色、用户资料、会话与记忆在重启后持久，记录返回值不能修改存储', t => {
  const state = fixture(t, { now: () => 12345 });
  const { store } = state;
  assert.deepEqual(store.characters(), [
    { id: 'changli', name: '长离', instructions: '' },
    { id: 'aimisi', name: '爱弥斯', instructions: '' },
  ]);
  store.updateCharacter('changli', { instructions: '保持长离的口吻。' });
  store.setProfile({ nickname: '旅行者', preferences: ['茶'] });
  const { session, messages } = conversation(store);
  const memory = store.addMemory('changli', '用户喜欢茶。', [messages[0].id]);
  store.updateMemory('changli', memory.id, '用户喜欢喝茶。');
  store.getProfile().preferences.push('不应保存');
  const reopened = state.reopen();
  assert.equal(reopened.getCharacter('changli').instructions, '保持长离的口吻。');
  assert.equal(reopened.getCharacter('aimisi').instructions, '');
  assert.deepEqual(reopened.getProfile(), { nickname: '旅行者', preferences: ['茶'] });
  assert.deepEqual(reopened.getSession('changli', session.id), session);
  assert.deepEqual(reopened.listSessions('changli'), [session]);
  assert.deepEqual(reopened.messages('changli', session.id), messages);
  assert.deepEqual(reopened.listMemories('changli'), [{ ...memory, text: '用户喜欢喝茶。' }]);
  assert.deepEqual(reopened.listSessions('aimisi'), []);
  assert.deepEqual(reopened.listMemories('aimisi'), []);
  assert.deepEqual(readdirSync(state.directory).sort(), ['aimisi.sqlite', 'changli.sqlite', 'shared.sqlite']);
});

test('角色无法改用户源资料或角色设定，用户仍能维护资料', t => {
  const { store } = fixture(t);
  store.setProfile({ name: '用户' });
  for (const actor of ['assistant', 'tool', '', null]) {
    assert.throws(() => store.setProfile({}, { actor }), error(403, 'USER_WRITE_REQUIRED'));
    assert.throws(() => store.updateCharacter('changli', { instructions: '覆盖' }, { actor }), error(403, 'USER_WRITE_REQUIRED'));
  }
  assert.deepEqual(store.getProfile(), { name: '用户' });
  for (const profile of [null, [], 'bad', { invalid: undefined }, { invalid: Infinity }, new Date()]) {
    assert.throws(() => store.setProfile(profile), error(400, 'INVALID_PROFILE'));
  }
  const circular = {}; circular.self = circular;
  assert.throws(() => store.setProfile(circular), error(400, 'INVALID_PROFILE'));
  assert.equal(store.getCharacter('changli').instructions, '');
});

test('会话、消息与记忆跨角色和跨会话读写被拒绝', t => {
  const { store } = fixture(t);
  const a = conversation(store, 'changli');
  const b = conversation(store, 'aimisi');
  const other = store.createSession('changli');
  const memory = store.addMemory('changli', '独立经历。', [a.messages[0].id]);
  for (const action of [
    () => store.getSession('aimisi', a.session.id),
    () => store.messages('aimisi', a.session.id),
    () => store.addMessage('aimisi', a.session.id, 'user', '混入'),
    () => store.editMessage('aimisi', a.session.id, a.messages[0].id, '覆盖'),
    () => store.deleteSession('aimisi', a.session.id),
  ]) assert.throws(action, error(404, 'SESSION_NOT_FOUND'));
  assert.throws(() => store.editMessage('changli', other.id, a.messages[0].id, '覆盖'), error(404, 'MESSAGE_NOT_FOUND'));
  assert.throws(() => store.addMemory('aimisi', '混用', [a.messages[0].id]), error(404, 'MEMORY_SOURCE_NOT_FOUND'));
  assert.throws(() => store.updateMemory('aimisi', memory.id, '混用'), error(404, 'MEMORY_NOT_FOUND'));
  assert.throws(() => store.deleteMemories('aimisi', [memory.id]), error(404, 'MEMORY_NOT_FOUND'));
  assert.deepEqual(store.messages('changli', a.session.id), a.messages);
  assert.deepEqual(store.messages('aimisi', b.session.id), b.messages);
  assert.throws(() => store.getCharacter('../changli'), error(404, 'CHARACTER_NOT_FOUND'));
  assert.throws(() => store.getSession('changli', '../shared'), error(400, 'INVALID_ID'));
});

test('编辑任意历史物理覆盖后续，并失效编辑消息及后续相关的全部记忆', t => {
  const state = fixture(t);
  const { store } = state;
  const { session, messages } = conversation(store);
  const retained = store.addMemory('changli', '保留首条。', [messages[0].id]);
  store.addMemory('changli', '旧回复相关。', [messages[1].id]);
  store.addMemory('changli', '混合来源的旧记忆。', [messages[0].id, messages[3].id]);
  const other = conversation(store, 'aimisi');
  const edited = store.editMessage('changli', session.id, messages[1].id, '更新后的回答。');
  assert.deepEqual(edited, { ...messages[1], content: '更新后的回答。' });
  assert.deepEqual(store.messages('changli', session.id), [messages[0], edited]);
  assert.deepEqual(store.listMemories('changli'), [retained]);
  assert.deepEqual(store.messages('aimisi', other.session.id), other.messages);
  const reopened = state.reopen();
  assert.deepEqual(reopened.messages('changli', session.id), [messages[0], edited]);
  const bytes = readFileSync(join(state.directory, 'changli.sqlite'));
  for (const deleted of ['以后一起喝茶。', '旧回复相关。', '混合来源的旧记忆。']) {
    assert.equal(bytes.includes(Buffer.from(deleted)), false, `${deleted}不应残留在已释放页`);
  }
});

test('重新生成删目标回复和后续，保留之前对话且不允许重生成用户消息', t => {
  const { store } = fixture(t);
  const { session, messages } = conversation(store);
  const retained = store.addMemory('changli', '之前的用户信息。', [messages[0].id]);
  store.addMemory('changli', '旧回答。', [messages[1].id]);
  store.addMemory('changli', '后续经历。', [messages[3].id]);
  assert.throws(() => store.regenerate('changli', session.id, messages[0].id), error(400, 'INVALID_REGENERATION'));
  assert.deepEqual(store.messages('changli', session.id), messages);
  assert.deepEqual(store.regenerate('changli', session.id, messages[1].id), { deleted: 3 });
  assert.deepEqual(store.messages('changli', session.id), [messages[0]]);
  assert.deepEqual(store.listMemories('changli'), [retained]);
  const replacement = store.addMessage('changli', session.id, 'assistant', '新的回答。');
  assert.notEqual(replacement.id, messages[1].id);
});

test('选删消息原子验证所有标识，删除依赖记忆，其他消息保持原次序', t => {
  const { store } = fixture(t);
  const { session, messages } = conversation(store);
  const memory = store.addMemory('changli', '多条来源。', [messages[0].id, messages[2].id]);
  assert.throws(() => store.deleteMessages('changli', session.id, [messages[0].id, randomUUID()]), error(404, 'MESSAGE_NOT_FOUND'));
  assert.deepEqual(store.messages('changli', session.id), messages);
  assert.deepEqual(store.listMemories('changli'), [memory]);
  assert.deepEqual(store.deleteMessages('changli', session.id, [messages[2].id, messages[2].id]), { deleted: 1 });
  assert.deepEqual(store.messages('changli', session.id), [messages[0], messages[1], messages[3]]);
  assert.deepEqual(store.listMemories('changli'), []);
  assert.deepEqual(store.deleteMessages('changli', session.id, []), { deleted: 0 });
});

test('SQLite中途写入失败回滚消息及已经失效的记忆', t => {
  const state = fixture(t);
  const { store } = state;
  const { session, messages } = conversation(store);
  const memory = store.addMemory('changli', '需要事务保护。', [messages[2].id]);
  const inspection = new DatabaseSync(join(state.directory, 'changli.sqlite'));
  try {
    inspection.exec("CREATE TRIGGER injected_failure BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    assert.throws(() => store.deleteMessages('changli', session.id, [messages[2].id]), /injected/);
    assert.deepEqual(store.messages('changli', session.id), messages);
    assert.deepEqual(store.listMemories('changli'), [memory]);
    assert.throws(() => store.editMessage('changli', session.id, messages[0].id, '不应保存。'), /injected/);
    assert.deepEqual(store.messages('changli', session.id), messages);
    assert.deepEqual(store.listMemories('changli'), [memory]);
  } finally {
    inspection.close();
  }
});

test('删除会话使跨会话来源的派生记忆整体失效，保留无关记忆与用户资料', t => {
  const { store } = fixture(t);
  const a = conversation(store);
  const b = conversation(store);
  store.setProfile({ nickname: '保留' });
  store.addMemory('changli', '混合的相处经历。', [a.messages[0].id, b.messages[0].id]);
  const retained = store.addMemory('changli', '另一个会话。', [b.messages[1].id]);
  assert.deepEqual(store.deleteSession('changli', a.session.id), { deleted: true });
  assert.deepEqual(store.listSessions('changli'), [b.session]);
  assert.deepEqual(store.listMemories('changli'), [retained]);
  assert.deepEqual(store.getProfile(), { nickname: '保留' });
  assert.throws(() => store.messages('changli', a.session.id), error(404, 'SESSION_NOT_FOUND'));
});

test('每周提醒持久，确认后顺延，两个角色提醒相互独立且不自动删除', t => {
  let time = 1_000_000;
  const state = fixture(t, { now: () => time });
  const { store } = state;
  const { session, messages } = conversation(store);
  const memory = store.addMemory('changli', '用户自己决定删除。', [messages[0].id]);
  assert.deepEqual(store.reviewStatus('changli'), { due: false, nextReviewAt: time + WEEK });
  time += WEEK;
  const reopened = state.reopen();
  assert.deepEqual(reopened.reviewStatus('changli'), { due: true, nextReviewAt: time });
  assert.deepEqual(reopened.markReviewed('changli'), { due: false, nextReviewAt: time + WEEK });
  assert.equal(reopened.reviewStatus('aimisi').due, true);
  assert.deepEqual(reopened.listMemories('changli'), [memory]);
  assert.deepEqual(reopened.messages('changli', session.id), messages);
  time += WEEK - 1;
  assert.equal(reopened.reviewStatus('changli').due, false);
  time += 1;
  assert.equal(reopened.reviewStatus('changli').due, true);
});

test('记忆来源验证与批量删除不留半写入，输入验证不接受空内容或无源自动记忆', t => {
  const { store } = fixture(t);
  const { session, messages } = conversation(store);
  assert.throws(() => store.addMemory('changli', '没有来源', []), error(400, 'MEMORY_SOURCE_REQUIRED'));
  assert.throws(() => store.addMemory('changli', '坏来源', [messages[0].id, randomUUID()]), error(404, 'MEMORY_SOURCE_NOT_FOUND'));
  assert.deepEqual(store.listMemories('changli'), []);
  const memory = store.addMemory('changli', '有来源。', [messages[0].id, messages[0].id]);
  assert.deepEqual(memory.sourceMessageIds, [messages[0].id]);
  assert.throws(() => store.deleteMemories('changli', [memory.id, randomUUID()]), error(404, 'MEMORY_NOT_FOUND'));
  assert.deepEqual(store.listMemories('changli'), [memory]);
  assert.deepEqual(store.deleteMemories('changli', [memory.id]), { deleted: 1 });
  assert.deepEqual(store.listMemories('changli'), []);
  assert.throws(() => store.addMessage('changli', session.id, 'system', '注入'), error(400, 'INVALID_ROLE'));
  assert.throws(() => store.editMessage('changli', session.id, messages[0].id, '   '), error(400, 'INVALID_TEXT'));
  store.close();
  store.close();
  assert.throws(() => store.getProfile(), error(409, 'STORE_CLOSED'));
});
