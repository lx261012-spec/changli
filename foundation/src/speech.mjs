import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelError } from './model.mjs';

export class SpeechEngine {
  constructor(config = {}) { this.config = config; this.child = null; this.pending = null; this.ready = false; this.sequence = 0; }
  status(characterId) {
    const configured = characterId === 'changli' && ['python', 'runtime', 's1', 's2', 'reference'].every(key => this.config[key] && existsSync(this.config[key]));
    return { configured, ready: configured && this.ready, voice: configured ? '长离 · 首轮专属 v2' : null, mode: 'CPU FP32', maxCharacters: 2000 };
  }
  stop() {
    const child = this.child; this.child = null; this.ready = false;
    this.pending?.reject(new ModelError('语音已停止或被新请求替代', 'speech_cancelled', 409)); this.pending = null;
    child?.kill();
  }
  async synthesize(characterId, text, signal) {
    if (!this.status(characterId).configured) throw new ModelError('当前角色的本地音色未配置，文字聊天可继续', 'speech_unconfigured', 503);
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new ModelError('单次语音需为 1～2000 字符，长回复请分段试听', 'invalid_speech', 400);
    signal?.throwIfAborted();
    if (this.pending) this.stop();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (this.pending?.id === id) this.pending = null; };
      const finish = value => { cleanup(); resolve(value); };
      const fail = error => { cleanup(); reject(error); };
      const abort = () => { if (this.pending?.id === id) this.stop(); };
      const timer = setTimeout(() => { fail(new ModelError('本地语音合成超时，文字保留，可点击重试', 'speech_timeout', 504)); this.stop(); }, 300_000);
      this.pending = { id, reject: fail };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (!this.child) this.start();
        this.pending.resolve = finish;
        this.child.stdin.write(JSON.stringify({ id, text: text.trim() }) + '\n');
      } catch { this.stop(); fail(new ModelError('本地语音无法启动，请检查语音安装路径', 'speech_start_failed', 503)); }
    });
  }
  start() {
    const worker = fileURLToPath(new URL('../scripts/speech_worker.py', import.meta.url));
    const child = spawn(this.config.python, ['-u', '-X', 'utf8', worker], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CHANGLI_SPEECH_CONFIG: JSON.stringify(this.config), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' },
    });
    this.child = child;
    let diagnostics = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-24000); });
    const saveDiagnostic = () => {
      try { mkdirSync(this.config.cache, { recursive: true }); writeFileSync(join(this.config.cache, 'last-error.log'), diagnostics, 'utf8'); } catch { /* The API still returns a useful failure if the log is unwritable. */ }
    };
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 40_000_000) { this.stop(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.ready) { this.ready = true; continue; }
        if (row.fatal) { saveDiagnostic(); this.pending?.reject(new ModelError('长离语音模型加载失败，请检查原权重与参考音频', 'speech_load_failed', 503)); this.stop(); return; }
        if (row.id !== this.pending?.id) continue;
        if (row.error) { saveDiagnostic(); this.pending.reject(new ModelError('语音合成失败，文字已保留，可点击重试', 'speech_failed')); continue; }
        const audio = Buffer.from(row.audio || '', 'base64');
        if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') this.pending.reject(new ModelError('语音输出无效，请重试', 'speech_invalid'));
        else this.pending.resolve({ audio, seconds: row.seconds, generationMs: row.generationMs, loadMs: row.loadMs });
      }
    });
    const failed = () => { if (this.child === child) { saveDiagnostic(); this.pending?.reject(new ModelError('语音进程已退出，文字保留，可点击重试', 'speech_exited', 503)); this.stop(); } };
    child.on('error', failed); child.on('exit', failed); child.stdin.on('error', failed);
  }
}
