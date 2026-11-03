import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARE_APPS, identifySoftware, ProactiveCare } from './proactive-care.mjs';

export class SoftwareCareService {
  constructor({ store, dataDir }) {
    let policy = {};
    try { policy = JSON.parse(readFileSync(join(dataDir, 'proactive-care-policy.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('主动关心策略配置无效，请检查本机配置文件'); }
    this.aliases = structuredClone(CARE_APPS);
    this.processPaths = {};
    for (const [id, paths] of Object.entries(policy.processPaths || {})) {
      if (!Object.hasOwn(CARE_APPS, id) || !Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !win32.isAbsolute(path) || win32.extname(path).toLowerCase() !== '.exe' || path.includes('\0'))) throw new Error('软件程序路径映射无效');
      this.processPaths[id] = paths;
    }
    for (const [id, names] of Object.entries(policy.processNames || {})) {
      if (!Object.hasOwn(CARE_APPS, id) || !Array.isArray(names) || names.some(name => typeof name !== 'string' || !/^[\w .-]{1,100}$/.test(name))) throw new Error('软件进程映射无效');
      this.aliases[id] = names;
    }
    this.engine = new ProactiveCare({ store, probabilities: policy.probabilities ?? null, timeoutAction: policy.timeoutAction ?? null, entryEnabled: policy.entryEnabled === true });
    this.status = 'not_started';
  }
  snapshot() {
    return { ...this.engine.snapshot(), observer: this.status, currentSoftware: this.currentSoftware || null, processMappings: this.aliases, pathMappedApps: Object.keys(this.processPaths).filter(id => this.processPaths[id].length), unmappedApps: Object.keys(this.aliases).filter(id => !this.aliases[id].length && !this.processPaths[id]?.length) };
  }
  start() {
    if (this.child || process.platform !== 'win32') return;
    const script = fileURLToPath(new URL('../scripts/software-observer.ps1', import.meta.url));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP)$/i.test(key)));
    const names = [...new Set([...Object.values(this.aliases).flat(), ...Object.values(this.processPaths).flat().map(path => win32.parse(path).name)])];
    this.child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-MatchNamesJson', JSON.stringify(names)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    this.status = 'starting';
    this.child.stderr.resume();
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      try { this.currentSoftware = identifySoftware(JSON.parse(line), this.aliases, this.processPaths); this.engine.sample(this.currentSoftware); this.status = 'observing'; }
      catch { this.currentSoftware = null; this.engine.pause(); this.status = 'sample_failed'; }
    });
    this.child.on('error', () => { this.engine.pause(); this.status = 'unavailable'; });
    this.child.on('exit', () => { this.engine.pause(); if (this.status !== 'stopped') this.status = 'unavailable'; this.child = null; });
  }
  stop() {
    this.status = 'stopped'; this.lines?.close(); this.child?.kill(); this.child = null; this.engine.pause();
  }
}
