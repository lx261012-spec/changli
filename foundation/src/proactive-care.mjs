import { randomUUID } from 'node:crypto';

export const CARE_APPS = {
  wps: ['wps', 'et', 'wpp'], gpt: ['chatgpt'], dsh: [], gemini: [], doubao: ['doubao'],
  qqmusic: ['qqmusic'], netease: ['cloudmusic'], kugou: ['kugou'], minecraft: [],
  wuthering: [], steam: ['steam'], ananta: [], douyin: ['douyin'],
};
const MINUTE = 60000;
const fail = message => { throw Object.assign(new Error(message), { status: 409, code: 'care_conflict' }); };

export function identifySoftware(sample, aliases = CARE_APPS, processPaths = {}) {
  if (!sample || !Array.isArray(sample.running) || typeof sample.foreground !== 'string') throw new Error('软件采样格式无效');
  const normalize = name => typeof name === 'string' ? name.toLowerCase().replace(/\.exe$/, '') : '';
  const runningNames = new Set(sample.running.map(normalize));
  const normalizePath = value => typeof value === 'string' ? value.replaceAll('/', '\\').toLowerCase() : '';
  const records = Array.isArray(sample.processes) ? sample.processes : [];
  const pathsMatch = (id, record) => (processPaths[id] || []).some(path => normalizePath(path) === normalizePath(record.path));
  const running = Object.keys(CARE_APPS).filter(id => (processPaths[id]?.length ? records.some(record => pathsMatch(id, record)) : (aliases[id] || []).some(name => runningNames.has(normalize(name)))));
  const foreground = running.find(id => processPaths[id]?.length ? records.some(record => record.id === sample.foregroundId && pathsMatch(id, record)) : (aliases[id] || []).some(name => normalize(name) === normalize(sample.foreground))) || null;
  return { running, foreground };
}

// One coordinator per character, shared by all windows. No model calls or screen contents.
export class ProactiveCare {
  constructor({ store, characterId = 'changli', now = Date.now, random = Math.random, probabilities = null, timeoutAction = null, entryEnabled = false }) {
    if (probabilities !== null && (!Array.isArray(probabilities) || probabilities.length !== 4 || probabilities.some((p, i) => !Number.isFinite(p) || p < 0 || p > 1 || (i && p < probabilities[i - 1])) || probabilities[3] !== 1)) throw new Error('概率须为四个递增的0—1数值，最后为1');
    if (![null, 'ignore', 'reject'].includes(timeoutAction)) throw new Error('未回应处理无效');
    Object.assign(this, { store, characterId, now, random, probabilities, timeoutAction, entryEnabled });
    this.rounds = store.getCareState(characterId);
    this.previous = null;
    // Offline time cannot prove software exited, and must not bypass refusal.
    for (const round of Object.values(this.rounds)) round.absentSince = null;
  }
  persist() {
    try { this.store.saveCareState(this.characterId, this.rounds); }
    catch (error) { this.rounds = this.store.getCareState(this.characterId); this.previous = null; throw error; }
  }
  snapshot() {
    return structuredClone({ policyReady: Boolean(this.probabilities && this.timeoutAction), probabilities: this.probabilities, timeoutAction: this.timeoutAction, entryEnabled: this.entryEnabled, rounds: this.rounds });
  }
  pause() { this.previous = null; for (const round of Object.values(this.rounds)) round.absentSince = null; }
  sample({ foreground, running }) {
    const now = this.now();
    const present = new Set(running.filter(id => Object.hasOwn(CARE_APPS, id)));
    if (!Object.hasOwn(CARE_APPS, foreground) || !present.has(foreground)) foreground = null;
    const gap = this.previous ? now - this.previous.at : 0;
    const elapsed = gap >= 0 && gap <= 15000 ? gap : 0;
    if (foreground && (!this.rounds[foreground] || this.rounds[foreground].status === 'ended')) {
      this.rounds[foreground] = { id: randomUUID(), activeMs: 0, checkpoint: 0, invitations: 0, rejections: 0, status: 'timing', absentSince: null, invitation: null };
    }
    for (const [appId, round] of Object.entries(this.rounds)) {
      if (round.status === 'ended') continue;
      if (present.has(appId)) round.absentSince = null;
      else {
        if (gap > 15000 || gap < 0) round.absentSince = now;
        if (round.absentSince === null) round.absentSince = now;
        if (now - round.absentSince >= 5 * MINUTE) { round.status = 'ended'; round.invitation = null; continue; }
      }
      if (foreground === appId && this.previous?.foreground === appId) round.activeMs += elapsed;
      if (round.status === 'shown' && now >= round.invitation.expiresAt) {
        if (this.timeoutAction === null) round.status = 'awaiting_timeout_policy';
        else this.finish(round, this.timeoutAction === 'reject' ? 'reject' : 'ignored');
      }
      if (foreground !== appId || !this.probabilities || !this.timeoutAction) continue;
      if (this.entryEnabled && round.status === 'timing' && !round.entryOffered && !round.invitations && !round.rejections && !round.checkpoint && round.activeMs < 30 * MINUTE) {
        round.entryOffered = true;
        this.queue(round, appId, 'entry');
      }
      if (round.status === 'retry_wait' && round.activeMs >= round.retryAtMs) this.queue(round, appId);
      if (round.status !== 'timing') continue;
      const times = [30, 40, 50, 60];
      while (round.checkpoint < times.length && round.activeMs >= times[round.checkpoint] * MINUTE) {
        const p = this.probabilities[round.checkpoint++];
        if (this.random() < p) { this.queue(round, appId); break; }
      }
    }
    this.previous = { at: now, foreground };
    this.persist();
  }
  queue(round, appId, kind = 'duration') {
    // Countdown starts on renderer acknowledgement, never while nobody can see the bubble.
    round.status = 'queued';
    round.invitation = { id: randomUUID(), roundId: round.id, appId, kind, text: '长离有话想和你说', createdAt: this.now(), expiresAt: null };
  }
  locate(invitationId) {
    const round = Object.values(this.rounds).find(r => r.invitation?.id === invitationId && ['queued', 'shown'].includes(r.status));
    if (!round) fail('邀请已失效，请刷新当前状态。');
    return round;
  }
  present(invitationId, owner = null) {
    const round = this.locate(invitationId);
    if (round.status === 'shown' && (round.invitation.owner ?? null) !== owner) fail('邀请已在另一个窗口显示。');
    if (round.status === 'queued') {
      if (Object.values(this.rounds).some(r => r.status === 'shown')) fail('已有邀请正在显示。');
      round.status = 'shown'; round.invitations++; round.invitation.expiresAt = this.now() + 10000; round.invitation.owner = owner; this.persist();
    }
    return structuredClone(round.invitation);
  }
  respond(invitationId, choice, { owner = null, sessionId, line } = {}) {
    if (!['accept', 'reject'].includes(choice)) throw Object.assign(new Error('仅支持接听或拒绝'), { status: 400, code: 'invalid_choice' });
    const round = this.locate(invitationId);
    if ((round.invitation.owner ?? null) !== owner) fail('请在显示此邀请的窗口操作。');
    if (round.status !== 'shown' || this.now() >= round.invitation.expiresAt) fail('邀请尚未显示或已经超时。');
    const appId = round.invitation.appId;
    const recordingId = round.invitation.kind === 'entry' ? `${appId}_entry` : appId;
    this.finish(round, choice);
    let delivery;
    try {
      if (choice === 'accept' && line) delivery = this.store.acceptCare(this.characterId, this.rounds, sessionId, line, recordingId);
      else this.persist();
    } catch (error) { this.rounds = this.store.getCareState(this.characterId); throw error; }
    return { ...this.snapshot(), ...(delivery ? { delivery } : {}) };
  }
  finish(round, choice) {
    const entry = round.invitation?.kind === 'entry';
    if (choice === 'reject') {
      round.rejections++;
      round.status = round.rejections >= 2 ? 'stopped' : 'retry_wait';
      round.retryAtMs = round.activeMs + 30 * MINUTE;
    } else round.status = entry ? 'timing' : choice === 'accept' ? 'accepted' : 'ignored';
    round.invitation = null;
  }
}
