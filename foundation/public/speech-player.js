// One active request/player; a newer request invalidates even late old results.
export class SpeechPlayer {
  constructor({ request, audio, status, createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL, channel = null, locks = null }) {
    Object.assign(this, { request, audio, status, createURL, revokeURL, channel, locks });
    this.epoch = 0;
    this.latestIntent = '';
    channel?.addEventListener('message', ({ data }) => {
      if (typeof data?.intent !== 'string' || !/^\d{16}:[a-f0-9-]{36}$/i.test(data.intent) || data.intent <= this.latestIntent) return;
      this.latestIntent = data.intent;
      this.stop(false);
    });
    audio.addEventListener('ended', () => { this.releasePlayback?.(); status('播放结束，可在播放器中重听。'); });
    audio.addEventListener('error', () => { this.releasePlayback?.(); this.release(); status('音频播放失败，可点击回复下方的语音按钮重试。'); });
    // Native audio controls must use the same lock as automatic playback.
    audio.addEventListener('play', () => {
      if (!this.locks || this.lockHeld) return;
      const blob = this.blob;
      audio.pause();
      if (blob) void this.playBlob(blob);
    });
  }
  release() { if (this.url) this.revokeURL(this.url); this.url = null; }
  stop(shared = true) {
    if (shared && this.channel) {
      const time = Math.max(Date.now(), Number(this.latestIntent.slice(0, 16)) + 1);
      this.latestIntent = String(time).padStart(16, '0') + ':' + crypto.randomUUID();
      this.channel.postMessage({ intent: this.latestIntent });
    }
    ++this.epoch; this.controller?.abort(); this.controller = null;
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); this.release(); this.blob = null;
    this.releasePlayback?.();
    this.status('语音已停止。');
  }
  async playCurrent(epoch, started) {
    let complete;
    const ready = new Promise(resolve => { complete = resolve; });
    const work = async () => {
      if (epoch !== this.epoch) { complete(); return; }
      let finish;
      const ended = new Promise(resolve => { finish = resolve; });
      this.releasePlayback = finish;
      this.lockHeld = true;
      try {
        await this.audio.play();
        if (epoch !== this.epoch) return;
        this.status(`正在播放 · 音频准备 ${((performance.now() - started) / 1000).toFixed(1)} 秒。`);
        complete();
        if (this.locks) await ended;
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.status(error.name === 'NotAllowedError' ? '浏览器阻止自动播放，请点击下方播放器的播放键。' : '音频播放失败，请重试语音。');
      } finally {
        this.lockHeld = false;
        if (this.releasePlayback === finish) this.releasePlayback = null;
        complete();
      }
    };
    const pending = this.locks ? this.locks.request('foundation-role-audio', work) : work();
    pending.catch(() => { if (epoch === this.epoch) this.status('音频播放暂不可用，请重试。'); complete(); });
    return ready;
  }
  async playBlob(blob) {
    this.stop();
    const epoch = this.epoch;
    this.blob = blob; this.url = this.createURL(blob); this.audio.src = this.url;
    await this.playCurrent(epoch, performance.now());
  }
  async playRequest(url, method, data, prerecorded = false) {
    this.stop();
    const epoch = this.epoch; const controller = new AbortController(); this.controller = controller;
    const started = performance.now();
    this.status(prerecorded ? '正在读取主动关心录音…' : '正在合成…首次会加载长离模型，请稍候。文字聊天可继续。');
    try {
      const response = await this.request(url, method, data, controller.signal);
      const blob = await response.blob();
      if (epoch !== this.epoch) return;
      this.blob = blob; this.url = this.createURL(blob); this.audio.src = this.url;
      await this.playCurrent(epoch, started);
    } catch (error) {
      if (epoch === this.epoch && !controller.signal.aborted) this.status(`语音暂不可用：${error.message}。文字已保留，可重试语音。`);
    } finally { if (epoch === this.epoch) this.controller = null; }
  }
  speak(characterId, text) { return this.playRequest(`/api/characters/${encodeURIComponent(characterId)}/speech`, 'POST', { text }); }
  recording(characterId, messageId) { return this.playRequest(`/api/characters/${encodeURIComponent(characterId)}/care/audio/${encodeURIComponent(messageId)}`, 'GET', undefined, true); }
}
