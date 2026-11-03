// Functional integration surface; the desktop renderer can reuse the same care API.
export class CarePanel {
  constructor({ root, json, character, session, busy, delivered, play, voiceEnabled }) {
    Object.assign(this, { root, json, character, session, busy, delivered, play, voiceEnabled });
    this.owner = crypto.randomUUID();
    this.find = name => root.querySelector(`[data-care="${name}"]`);
    for (const choice of ['accept', 'reject']) this.find(choice).addEventListener('click', () => void this.respond(choice));
  }
  tick() {
    const left = Math.max(0, (this.invitation?.expiresAt || 0) - Date.now());
    this.find('bubble').hidden = !left || this.character() !== 'changli' || document.hidden;
    this.find('countdown').value = left;
    this.find('seconds').textContent = `${Math.ceil(left / 1000)} 秒`;
    for (const choice of ['accept', 'reject']) this.find(choice).disabled = this.pending || !left;
  }
  async poll() {
    if (this.polling || this.pending) return;
    this.root.hidden = this.character() !== 'changli';
    if (this.root.hidden || document.hidden) { this.invitation = null; this.tick(); return; }
    this.polling = true;
    try {
      const result = await this.json('/api/characters/changli/care');
      if (this.character() !== 'changli') return;
      this.find('status').textContent = result.policyReady ? '按已确认的软件时长规则等待邀请。' : '当前未启用软件主动关心策略。';
      const rounds = Object.values(result.rounds);
      const shown = rounds.find(round => round.status === 'shown');
      const next = shown?.invitation.owner === this.owner ? shown : !shown && !this.busy() ? rounds.find(round => round.status === 'queued') : null;
      if (!next) { this.invitation = null; this.tick(); return; }
      // The panel is visible before its acknowledgement starts the countdown.
      this.find('bubble').hidden = false;
      this.invitation = await this.json('/api/characters/changli/care/present', 'POST', { invitationId: next.invitation.id, consumerId: this.owner });
      this.tick();
    } catch (error) { this.invitation = null; this.tick(); this.find('status').textContent = error.message; }
    finally { this.polling = false; }
  }
  async respond(choice) {
    if (this.pending || !this.invitation || Date.now() >= this.invitation.expiresAt) return;
    this.pending = true; this.tick();
    const context = { characterId: this.character(), sessionId: this.session() };
    try {
      const result = await this.json('/api/characters/changli/care/respond', 'POST', {
        invitationId: this.invitation.id, choice, consumerId: this.owner, sessionId: context.sessionId,
      });
      this.invitation = null; this.tick();
      if (result.delivery) {
        this.find('status').textContent = '已接听，台词已加入当前会话。';
        const stillHere = await this.delivered(result.delivery, context);
        if (stillHere && this.voiceEnabled()) void this.play(result.delivery.message);
      } else this.find('status').textContent = '已拒绝，本次没有添加聊天消息。';
    } catch (error) { this.find('status').textContent = `${error.message}；可刷新会话查看已保存的内容。`; }
    finally { this.pending = false; this.tick(); }
  }
}
