import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WEEK = 7 * 24 * 60 * 60 * 1000;
const CHARACTERS = [
  { id: 'changli', name: '长离' },
  { id: 'aimisi', name: '爱弥斯' },
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'INVALID_ID', '标识格式无效。');
  return value;
}

function text(value, label = '内容', allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    fail(400, 'INVALID_TEXT', `${label}必须是${allowEmpty ? '' : '非空'}文字。`);
  }
  return value;
}

function ids(values) {
  if (!Array.isArray(values)) fail(400, 'INVALID_IDS', '请提供标识列表。');
  return [...new Set(values.map(id))];
}

function userOnly(actor) {
  if (actor !== 'user') fail(403, 'USER_WRITE_REQUIRED', '只有用户可以修改源资料与角色设定。');
}

function jsonObject(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    fail(400, 'INVALID_PROFILE', '用户资料必须是 JSON 对象。');
  }
  const seen = new Set();
  function check(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) fail(400, 'INVALID_PROFILE', '用户资料必须是有效 JSON。');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      fail(400, 'INVALID_PROFILE', '用户资料必须是有效 JSON。');
    }
    seen.add(item);
    for (const child of Object.values(item)) check(child);
    seen.delete(item);
  }
  check(value);
  return JSON.stringify(value);
}

function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Keep the original failure. */ }
    throw error;
  }
}

function database(path) {
  const db = new DatabaseSync(path);
  // Deleted conversations must not remain in free pages or a persistent WAL.
  db.exec('PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 5000;');
  return db;
}

export class Store {
  #shared;
  #databases = new Map();
  #now;
  #closed = false;

  constructor(dataDir, { now = () => Date.now(), defaultProvider = 'openai' } = {}) {
    text(dataDir, '存储目录');
    if (typeof now !== 'function') fail(400, 'INVALID_CLOCK', '时钟必须是函数。');
    if (!['openai', 'deepseek', 'gemini'].includes(defaultProvider)) fail(400, 'INVALID_PROVIDER', '默认模型通道无效。');
    this.#now = now;
    const initialReview = this.#time() + WEEK;
    mkdirSync(dataDir, { recursive: true });
    try {
      this.#shared = database(join(dataDir, 'shared.sqlite'));
      this.#shared.exec(`
        CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
        INSERT OR IGNORE INTO profile (id, value) VALUES (1, '{}');
      `);
      for (const character of CHARACTERS) {
        const db = database(join(dataDir, `${character.id}.sqlite`));
        this.#databases.set(character.id, db);
        db.exec(`
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS messages (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
          CREATE TABLE IF NOT EXISTS care_messages (
            message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            app_id TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS memory_sources (
            memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            PRIMARY KEY (memory_id, message_id)
          );
          CREATE INDEX IF NOT EXISTS memory_source_message ON memory_sources(message_id);
        `);
        db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('instructions', '');
        db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('provider', defaultProvider);
        db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('nextReviewAt', String(initialReview));
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #time() {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) fail(400, 'INVALID_CLOCK', '时钟必须返回有效毫秒时间。');
    return value;
  }

  #open() {
    if (this.#closed) fail(409, 'STORE_CLOSED', '存储已经关闭。');
  }

  #db(characterId) {
    this.#open();
    if (typeof characterId !== 'string' || !this.#databases.has(characterId)) {
      fail(404, 'CHARACTER_NOT_FOUND', '角色不存在。');
    }
    return this.#databases.get(characterId);
  }

  #session(db, sessionId) {
    const result = db.prepare('SELECT id, created_at AS createdAt FROM sessions WHERE id = ?').get(id(sessionId));
    if (!result) fail(404, 'SESSION_NOT_FOUND', '当前角色没有此会话。');
    return { ...result };
  }

  #message(db, sessionId, messageId) {
    const result = db.prepare('SELECT seq, id, role, content, created_at AS createdAt FROM messages WHERE session_id = ? AND id = ?')
      .get(sessionId, id(messageId));
    if (!result) fail(404, 'MESSAGE_NOT_FOUND', '当前会话没有此消息。');
    return { ...result };
  }

  #invalidate(db, messageIds) {
    const statement = db.prepare('DELETE FROM memories WHERE id IN (SELECT memory_id FROM memory_sources WHERE message_id = ?)');
    for (const messageId of messageIds) statement.run(messageId);
  }

  #memory(db, memoryId) {
    const result = db.prepare('SELECT id, text, created_at AS createdAt FROM memories WHERE id = ?').get(id(memoryId));
    if (!result) fail(404, 'MEMORY_NOT_FOUND', '当前角色没有此记忆。');
    const sources = db.prepare('SELECT message_id AS id FROM memory_sources WHERE memory_id = ? ORDER BY position').all(memoryId);
    return { ...result, sourceMessageIds: sources.map(source => source.id) };
  }

  characters() {
    return CHARACTERS.map(character => this.getCharacter(character.id));
  }

  getCharacter(characterId) {
    const db = this.#db(characterId);
    const instructions = db.prepare("SELECT value FROM settings WHERE key = 'instructions'").get().value;
    return { ...CHARACTERS.find(character => character.id === characterId), instructions };
  }

  updateCharacter(characterId, patch, { actor = 'user' } = {}) {
    const db = this.#db(characterId);
    userOnly(actor);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'INVALID_CHARACTER', '请提供角色设定。');
    const instructions = text(patch.instructions, '角色设定', true);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'instructions'").run(instructions);
    return this.getCharacter(characterId);
  }

  getProvider(characterId) {
    return this.#db(characterId).prepare("SELECT value FROM settings WHERE key = 'provider'").get().value;
  }

  setProvider(characterId, provider, { actor = 'user' } = {}) {
    const db = this.#db(characterId);
    userOnly(actor);
    if (!['openai', 'deepseek', 'gemini'].includes(provider)) fail(400, 'INVALID_PROVIDER', '仅支持 openai、deepseek 或 gemini 通道。');
    db.prepare("UPDATE settings SET value = ? WHERE key = 'provider'").run(provider);
    return { provider };
  }

  getCareState(characterId) {
    const row = this.#db(characterId).prepare("SELECT value FROM settings WHERE key = 'proactiveCare'").get();
    return row ? JSON.parse(row.value) : {};
  }

  saveCareState(characterId, value) {
    this.#db(characterId).prepare("INSERT INTO settings (key,value) VALUES ('proactiveCare',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
  }

  getRecordingShortcut(characterId) {
    return this.#db(characterId).prepare("SELECT value FROM settings WHERE key = 'recordingShortcut'").get()?.value || null;
  }

  getAppLaunchEnabled(characterId) {
    return this.#db(characterId).prepare("SELECT value FROM settings WHERE key = 'appLaunchEnabled'").get()?.value !== 'false';
  }

  setAppLaunchEnabled(characterId, enabled, { actor = 'user' } = {}) {
    userOnly(actor);
    if(typeof enabled!=='boolean')fail(400,'INVALID_LAUNCH_PERMISSION','软件启动开关需为开启或关闭。');
    this.#db(characterId).prepare("INSERT INTO settings(key,value) VALUES ('appLaunchEnabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(enabled));
    return {enabled};
  }

  setRecordingShortcut(characterId, shortcut, { actor = 'user' } = {}) {
    const db = this.#db(characterId);
    userOnly(actor);
    if (shortcut !== null) {
      if (typeof shortcut !== 'string' || !/^(?:(?:Ctrl|Alt|Shift)\+)+(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))$/.test(shortcut)) {
        fail(400, 'INVALID_SHORTCUT', '请使用 Ctrl、Alt 或 Shift 搭配字母、数字或功能键。');
      }
      const modifiers = shortcut.split('+').slice(0, -1);
      if (new Set(modifiers).size !== modifiers.length) fail(400, 'INVALID_SHORTCUT', '组合键不能包含重复修饰键。');
      db.prepare("INSERT INTO settings (key, value) VALUES ('recordingShortcut', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(shortcut);
    } else db.prepare("DELETE FROM settings WHERE key = 'recordingShortcut'").run();
    return { recordingShortcut: this.getRecordingShortcut(characterId) };
  }

  getProfile() {
    this.#open();
    return JSON.parse(this.#shared.prepare('SELECT value FROM profile WHERE id = 1').get().value);
  }

  setProfile(profile, { actor = 'user' } = {}) {
    this.#open();
    userOnly(actor);
    this.#shared.prepare('UPDATE profile SET value = ? WHERE id = 1').run(jsonObject(profile));
    return this.getProfile();
  }

  createSession(characterId) {
    const db = this.#db(characterId);
    const result = { id: randomUUID(), characterId, createdAt: this.#time() };
    db.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run(result.id, result.createdAt);
    this.setActiveSession(characterId, result.id);
    return result;
  }

  getActiveSession(characterId) {
    const db = this.#db(characterId);
    return db.prepare("SELECT s.id FROM sessions s JOIN settings v ON v.key = 'activeSession' AND v.value = s.id").get()?.id
      || this.listSessions(characterId)[0]?.id || null;
  }

  setActiveSession(characterId, sessionId) {
    this.getSession(characterId, sessionId);
    this.#db(characterId).prepare("INSERT INTO settings(key,value) VALUES ('activeSession',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(sessionId);
    return { sessionId };
  }

  acceptCare(characterId, rounds, sessionId, line, appId) {
    const db = this.#db(characterId);
    return transaction(db, () => {
      sessionId ??= this.getActiveSession(characterId);
      sessionId ??= this.createSession(characterId).id;
      this.getSession(characterId, sessionId);
      const message = this.addMessage(characterId, sessionId, 'assistant', line.text);
      db.prepare('INSERT INTO care_messages(message_id,app_id) VALUES (?,?)').run(message.id, appId);
      this.saveCareState(characterId, rounds);
      return { sessionId, message: { ...message, careAppId: appId } };
    });
  }

  getCareMessage(characterId, messageId) {
    const row = this.#db(characterId).prepare('SELECT c.app_id AS appId, m.content FROM care_messages c JOIN messages m ON m.id=c.message_id WHERE m.id=?').get(id(messageId));
    if (!row) fail(404, 'CARE_MESSAGE_NOT_FOUND', '当前角色没有此主动关心消息。');
    return { ...row };
  }

  listSessions(characterId) {
    return this.#db(characterId).prepare('SELECT id, created_at AS createdAt FROM sessions ORDER BY created_at DESC, rowid DESC')
      .all().map(session => ({ ...session, characterId }));
  }

  getSession(characterId, sessionId) {
    return { ...this.#session(this.#db(characterId), sessionId), characterId };
  }

  messages(characterId, sessionId) {
    const db = this.#db(characterId);
    this.#session(db, sessionId);
    return db.prepare('SELECT m.id, m.role, m.content, m.created_at AS createdAt, c.app_id AS careAppId FROM messages m LEFT JOIN care_messages c ON c.message_id=m.id WHERE m.session_id = ? ORDER BY m.seq')
      .all(sessionId).map(({ careAppId, ...message }) => careAppId ? { ...message, careAppId } : { ...message });
  }

  addMessage(characterId, sessionId, role, content) {
    const db = this.#db(characterId);
    this.#session(db, sessionId);
    if (!['user', 'assistant'].includes(role)) fail(400, 'INVALID_ROLE', '消息角色必须是 user 或 assistant。');
    text(content);
    const message = { id: randomUUID(), role, content, createdAt: this.#time() };
    db.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(message.id, sessionId, role, content, message.createdAt);
    return message;
  }

  editMessage(characterId, sessionId, messageId, content) {
    const db = this.#db(characterId);
    this.#session(db, sessionId);
    text(content);
    return transaction(db, () => {
      const target = this.#message(db, sessionId, messageId);
      const affected = db.prepare('SELECT id FROM messages WHERE session_id = ? AND seq >= ?').all(sessionId, target.seq);
      this.#invalidate(db, affected.map(message => message.id));
      db.prepare('DELETE FROM messages WHERE session_id = ? AND seq > ?').run(sessionId, target.seq);
      db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, messageId);
      db.prepare('DELETE FROM care_messages WHERE message_id = ?').run(messageId);
      const { seq, ...message } = this.#message(db, sessionId, messageId);
      return message;
    });
  }

  regenerate(characterId, sessionId, assistantMessageId) {
    const db = this.#db(characterId);
    this.#session(db, sessionId);
    return transaction(db, () => {
      const target = this.#message(db, sessionId, assistantMessageId);
      if (target.role !== 'assistant') fail(400, 'INVALID_REGENERATION', '只能重新生成角色回复。');
      const affected = db.prepare('SELECT id FROM messages WHERE session_id = ? AND seq >= ?').all(sessionId, target.seq);
      this.#invalidate(db, affected.map(message => message.id));
      db.prepare('DELETE FROM messages WHERE session_id = ? AND seq >= ?').run(sessionId, target.seq);
      return { deleted: affected.length };
    });
  }

  deleteMessages(characterId, sessionId, messageIds) {
    const db = this.#db(characterId);
    this.#session(db, sessionId);
    const selected = ids(messageIds);
    return transaction(db, () => {
      for (const messageId of selected) this.#message(db, sessionId, messageId);
      this.#invalidate(db, selected);
      const statement = db.prepare('DELETE FROM messages WHERE session_id = ? AND id = ?');
      for (const messageId of selected) statement.run(sessionId, messageId);
      return { deleted: selected.length };
    });
  }

  deleteSession(characterId, sessionId) {
    const db = this.#db(characterId);
    return transaction(db, () => {
      this.#session(db, sessionId);
      this.#invalidate(db, db.prepare('SELECT id FROM messages WHERE session_id = ?').all(sessionId).map(message => message.id));
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      db.prepare("DELETE FROM settings WHERE key = 'activeSession' AND value = ?").run(sessionId);
      return { deleted: true };
    });
  }

  listMemories(characterId) {
    const db = this.#db(characterId);
    return db.prepare('SELECT id FROM memories ORDER BY created_at, rowid').all().map(memory => this.#memory(db, memory.id));
  }

  addMemory(characterId, memoryText, sourceMessageIds, { actor = 'assistant' } = {}) {
    const db = this.#db(characterId);
    if (!['user', 'assistant'].includes(actor)) fail(403, 'MEMORY_WRITE_FORBIDDEN', '此身份不能保存记忆。');
    text(memoryText, '记忆');
    const selected = ids(sourceMessageIds);
    if (!selected.length) fail(400, 'MEMORY_SOURCE_REQUIRED', '自动记忆需要关联源消息。');
    return transaction(db, () => {
      const exists = db.prepare('SELECT id FROM messages WHERE id = ?');
      for (const messageId of selected) {
        if (!exists.get(messageId)) fail(404, 'MEMORY_SOURCE_NOT_FOUND', '记忆来源必须是当前角色的现存消息。');
      }
      const memory = { id: randomUUID(), text: memoryText, sourceMessageIds: selected, createdAt: this.#time() };
      db.prepare('INSERT INTO memories (id, text, created_at) VALUES (?, ?, ?)').run(memory.id, memory.text, memory.createdAt);
      const insert = db.prepare('INSERT INTO memory_sources (memory_id, message_id, position) VALUES (?, ?, ?)');
      selected.forEach((messageId, position) => insert.run(memory.id, messageId, position));
      return memory;
    });
  }

  updateMemory(characterId, memoryId, memoryText) {
    const db = this.#db(characterId);
    text(memoryText, '记忆');
    this.#memory(db, memoryId);
    db.prepare('UPDATE memories SET text = ? WHERE id = ?').run(memoryText, memoryId);
    return this.#memory(db, memoryId);
  }

  deleteMemories(characterId, memoryIds) {
    const db = this.#db(characterId);
    const selected = ids(memoryIds);
    return transaction(db, () => {
      for (const memoryId of selected) this.#memory(db, memoryId);
      const statement = db.prepare('DELETE FROM memories WHERE id = ?');
      for (const memoryId of selected) statement.run(memoryId);
      return { deleted: selected.length };
    });
  }

  reviewStatus(characterId) {
    const db = this.#db(characterId);
    const nextReviewAt = Number(db.prepare("SELECT value FROM settings WHERE key = 'nextReviewAt'").get().value);
    return { due: this.#time() >= nextReviewAt, nextReviewAt };
  }

  markReviewed(characterId) {
    const db = this.#db(characterId);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'nextReviewAt'").run(String(this.#time() + WEEK));
    return this.reviewStatus(characterId);
  }

  close() {
    if (this.#closed) return;
    for (const db of this.#databases.values()) db.close();
    this.#shared?.close();
    this.#closed = true;
  }
}
