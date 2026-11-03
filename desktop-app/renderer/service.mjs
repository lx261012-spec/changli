import { SpeechPlayer } from '/speech-player.js';

export const character = 'changli';
export const characterPath = suffix => `/api/characters/${character}${suffix || ''}`;
export const $ = id => document.getElementById(id);
export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function button(text, action, className = 'small-button') {
  const node = el('button', text, className); node.type = 'button';
  node.addEventListener('click', event => { event.stopPropagation(); void Promise.resolve().then(action).catch(report); });
  return node;
}
export function report(error) {
  const text = typeof error === 'string' ? error : error.message || '操作暂未完成，请重试。';
  document.dispatchEvent(new CustomEvent('notice', { detail: text }));
}
export async function request(url, method = 'GET', data, signal) {
  const response = await fetch(url, { method, signal, credentials: 'same-origin',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw Object.assign(new Error(failure.error?.message || `本机服务暂不可用（${response.status}），请重试。`), { code: failure.error?.code, status: response.status });
  }
  return response;
}
export const json = async (...args) => (await request(...args)).json();
export const voiceEnabled = () => localStorage.getItem('changli-speech-enabled') !== 'false';
export function setVoiceEnabled(value) {
  localStorage.setItem('changli-speech-enabled', String(value));
  void window.desktop?.setVoiceEnabled?.(value);
  const channel = new BroadcastChannel('changli-preferences'); channel.postMessage({ key: 'voiceEnabled', value }); channel.close();
  document.dispatchEvent(new CustomEvent('voice-preference', { detail: value }));
}
export const changes = new BroadcastChannel('changli-desktop-state');
export function changed(type = 'refresh') { changes.postMessage({ type }); }

export function createPlayer(audio, status = report) {
  const channel = new BroadcastChannel('foundation-role-audio');
  const player = new SpeechPlayer({ request, audio, status, channel, locks: navigator.locks });
  const stopOnOff = () => { if (!voiceEnabled()) player.stop(); };
  window.addEventListener('storage', event => { if (event.key === 'changli-speech-enabled') stopOnOff(); });
  document.addEventListener('voice-preference', stopOnOff);
  window.addEventListener('pagehide', () => { player.stop(false); channel.close(); });
  return player;
}
export function playMessage(player, message) {
  return message.careAppId ? player.recording(character, message.id) : player.speak(character, message.content);
}

export function parseSSE(block) {
  let event = 'message'; const lines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
  }
  return lines.length ? { event, data: JSON.parse(lines.join('\n')) } : null;
}
export class Conversation extends EventTarget {
  constructor(player) { super(); this.player = player; this.messages = []; this.stream = ''; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  path(suffix = '') { return characterPath(`/sessions/${encodeURIComponent(this.sessionId)}${suffix}`); }
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.load().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async load() {
      this.state = await json('/api/state?character=changli');
      // The server owns the current session across the chat and pet windows.
      if (!this.controller) this.sessionId = this.state.activeSessionId || null;
      if (this.sessionId && !this.controller) this.messages = (await json(this.path())).messages;
      else if (!this.sessionId) this.messages = [];
      this.emit('refresh', this.state);
  }
  async select(id) { if (this.controller) throw new Error('请先停止当前回复，再切换会话。'); await json(characterPath('/active-session'), 'PUT', { sessionId: id }); await this.refreshing; await this.refresh(); changed(); }
  async newSession() { if (this.controller) throw new Error('请先停止当前回复。'); await json(characterPath('/sessions'), 'POST', {}); await this.refreshing; await this.refresh(); changed(); }
  async stop() { this.player.stop(); this.controller?.abort(); await json(characterPath('/interrupt'), 'POST', {}); }
  async retry(messageId) { return this.send(null, null, messageId); }
  async send(content, regenerateId, retryId) {
    if (this.controller) throw new Error('正在回复，请稍候或点击停止。');
    if (!regenerateId && !retryId && !content?.trim()) return;
    if (!this.sessionId) await this.newSession();
    const last = this.messages.at(-1);
    if (!regenerateId && !retryId && last?.role === 'user' && last.content === content) retryId = last.id;
    this.player.stop(); this.stream = ''; const controller = new AbortController(); this.controller = controller;
    this.emit('busy', true); let saved = false;
    try {
      const response = await request(this.path(regenerateId ? '/regenerate' : retryId ? '/retry' : '/messages'), 'POST', regenerateId || retryId ? { messageId: regenerateId || retryId } : { content }, controller.signal);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
          const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop(); if (done && buffer.trim()) blocks.push(buffer);
          for (const block of blocks) {
            const item = parseSSE(block); if (!item) continue;
            if (item.event === 'delta') { this.stream += item.data.text; this.emit('delta', this.stream); }
            else if (item.event === 'saved') { saved = true; this.emit('saved', item.data.message); if (voiceEnabled()) void playMessage(this.player, item.data.message); }
            else if (item.event === 'error') throw new Error(item.data.message || '回复失败，请重试。');
            else if (item.event === 'warning' || item.event === 'interrupted') report(item.data.message);
          }
          if (done) break;
        }
      } finally { reader.releaseLock(); }
      if (!saved) throw new Error('本次回复未完成，草稿已保留。可点击发送重试。');
      return true;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      report('回复已停止，未完成的内容不写入历史。');
      return false;
    } finally {
      this.controller = null; this.emit('busy', false); await this.refresh(); changed();
    }
  }
}

export class Recorder extends EventTarget {
  constructor() { super(); this.state = 'idle'; window.addEventListener('pagehide', () => { clearTimeout(this.timeout); this.stream?.getTracks().forEach(track => track.stop()); }); }
  setState(state) { this.state = state; this.dispatchEvent(new CustomEvent('state', { detail: state })); }
  async toggle() {
    if (this.state === 'processing' || this.state === 'starting') return;
    if (this.state === 'recording') { this.recorder.stop(); return; }
    this.setState('starting');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不能使用麦克风，请从桌面程序打开。');
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : {}); const parts = [];
      this.recorder.addEventListener('dataavailable', event => { if (event.data.size) parts.push(event.data); });
      this.recorder.addEventListener('stop', async () => {
        clearTimeout(this.timeout); this.stream.getTracks().forEach(track => track.stop()); this.setState('processing');
        try {
          const blob = new Blob(parts, { type: this.recorder.mimeType || 'audio/webm' });
          const response = await fetch('/desktop/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
          const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || '语音识别暂不可用。');
          this.dispatchEvent(new CustomEvent('text', { detail: result.text || '' }));
        } catch (error) { report(error); } finally { this.setState('idle'); }
      }, { once: true });
      this.recorder.start(); this.setState('recording');
      this.timeout = setTimeout(() => { if (this.state === 'recording') this.recorder.stop(); }, 115000);
    } catch (error) { this.stream?.getTracks().forEach(track => track.stop()); this.setState('idle'); throw error; }
  }
}

export function preference(key, fallback) { return localStorage.getItem(`changli-${key}`) || fallback; }
export function setPreference(key, value) { localStorage.setItem(`changli-${key}`, value); changed('appearance'); }
export function applyAppearance() {
  document.documentElement.dataset.variant = preference('variant', 'A');
  document.documentElement.dataset.scene = preference('scene', 'snow');
}
export function bindShell(callback) { window.desktop?.onEvent(event => void Promise.resolve().then(() => callback(event)).catch(report)); }
