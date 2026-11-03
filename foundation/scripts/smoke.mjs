import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = join(root, '.test-data');
mkdirSync(tempRoot, { recursive: true });
const dataDir = mkdtempSync(join(tempRoot, 'launch-'));
const child = spawn(process.execPath, [join(root, 'scripts/launch.mjs'), '--no-open'], {
  cwd: root, env: { ...process.env, PORT: '0', FOUNDATION_DATA_DIR: dataDir, OPENAI_AUTH_MODE: 'api-key', OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '', GEMINI_API_KEY: '', GUI_API_KEY: '' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
try {
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('启动验收超时')), 15000);
    child.on('error', reject);
    child.stdout.on('data', chunk => {
      output += chunk.toString(); const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('启动器提前退出')); });
  });
  const token = readFileSync(join(dataDir, 'access-token'), 'utf8').trim();
  const response = await fetch(url + 'api/state', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.provider, 'openai'); assert.equal(state.model, 'gpt-6.1-sol'); assert.equal(state.modelConfigured, false);
  assert.deepEqual(state.providers.map(item => item.id), ['openai', 'deepseek', 'gemini']);
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url + 'app.js')).status, 200);
  console.log('便携运行时启动、自动配置/令牌生成、本机认证、三通道状态与管理台资源验收通过。');
} finally {
  child.kill(); await exited;
  if (!resolve(dataDir).startsWith(resolve(tempRoot) + sep)) throw new Error('测试目录超出范围');
  rmSync(dataDir, { recursive: true, force: true });
}
