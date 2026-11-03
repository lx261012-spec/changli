import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = dirname(desktopRoot);
const originalWorkspace = 'D:/UserData/Documents/ChatGPT/爱弥斯agent';
export const minimalEnvironment = () => Object.fromEntries(
  Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMDATA|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key))
);

export class LocalTranscriber {
  constructor({ python, runtime, model, tempDir } = {}) {
    const pythonCandidates = [python, process.env.CHANGLI_ASR_PYTHON,
      join(workspace, 'work/sovits-env/Scripts/python.exe'),
      join(originalWorkspace, 'work/sovits-env/Scripts/python.exe'),
      join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe')];
    this.python = pythonCandidates.find(value => value && existsSync(value));
    this.runtime = runtime || process.env.CHANGLI_ASR_RUNTIME || [join(workspace, 'work/audio-runtime'), join(originalWorkspace, 'work/audio-runtime')].find(path => existsSync(join(path, 'faster_whisper')));
    this.model = model || process.env.CHANGLI_ASR_MODEL || [join(workspace, 'work/audio-models/faster-whisper-small'), join(originalWorkspace, 'work/audio-models/faster-whisper-small')].find(path => existsSync(join(path, 'model.bin')));
    this.tempDir = tempDir || join(desktopRoot, 'data/recordings');
    this.available = Boolean(this.python && this.runtime && this.model && existsSync(join(this.runtime, 'faster_whisper')) && existsSync(join(this.model, 'model.bin')));
  }
  status() { return { available: this.available, offline: true, busy: Boolean(this.pending), maxSeconds: 120, textScript: 'zh-Hans' }; }
  start() {
    if (this.child) return;
    const child = spawn(this.python, ['-u', join(desktopRoot, 'backend/transcriber.py'), this.runtime, this.model], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...minimalEnvironment(), PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
    });
    this.child = child;
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.id !== this.pending?.id) return;
      if (value.error) this.pending.reject(Object.assign(new Error(value.error), { code: value.error, status: 422 }));
      else this.pending.resolve({ text: value.text, duration: value.duration, offline: true });
    });
    const failed = () => {
      lines.close();
      if (this.child !== child) return;
      this.child = null;
      this.pending?.reject(Object.assign(new Error('本地语音识别进程未能运行，请重试。'), { code: 'transcription_unavailable', status: 503 }));
    };
    child.once('error', failed); child.once('exit', failed);
  }
  async transcribe(buffer, extension, signal) {
    if (!this.available) throw Object.assign(new Error('本地识别资源不可用，请检查语音识别运行时。'), { code: 'transcription_unavailable', status: 503 });
    if (this.pending) throw Object.assign(new Error('正在识别上一段录音，请稍候。'), { code: 'transcription_busy', status: 409 });
    mkdirSync(this.tempDir, { recursive: true });
    const temp = mkdtempSync(join(this.tempDir, 'mic-'));
    const path = join(temp, `recording.${extension}`);
    writeFileSync(path, buffer, { mode: 0o600 });
    let timer, abort;
    try {
      return await new Promise((resolve, reject) => {
        const id = randomUUID();
        this.pending = { id, resolve, reject };
        timer = setTimeout(() => { this.close(); reject(Object.assign(new Error('本地识别超时，请缩短录音后重试。'), { code: 'transcription_timeout', status: 504 })); }, 180_000);
        abort = () => { this.close(); reject(Object.assign(new Error('录音识别已取消。'), { code: 'cancelled', status: 499 })); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        this.start();
        this.child.stdin.write(JSON.stringify({ id, path }) + '\n');
      });
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending = null;
      rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
  close() {
    const child = this.child; this.child = null; child?.kill();
    this.pending?.reject(Object.assign(new Error('录音识别已取消。'), { code: 'cancelled', status: 499 }));
  }
}
