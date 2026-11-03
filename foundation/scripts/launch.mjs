import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig, enableConfiguredProxy } from '../src/config.mjs';
import { accessToken, createApp } from '../src/server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envFile = join(root, '.env');
if (!existsSync(envFile)) copyFileSync(join(root, '.env.example'), envFile);
process.loadEnvFile(envFile);
enableConfiguredProxy();
const config = loadConfig(process.env, root);
function openConsole(token, port) {
  const url = `http://127.0.0.1:${port}/#token=${token}`;
  if (process.platform === 'win32' && !process.argv.includes('--no-open')) {
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
    browser.on('error', () => console.log('请手动打开管理台并从 data/access-token 填入本机访问令牌。'));
  } else console.log('请手动打开管理台并从 data/access-token 填入本机访问令牌。');
}
let reused = false;
if (config.port) {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/state`, { headers: { Authorization: `Bearer ${accessToken(config.dataDir)}` }, signal: AbortSignal.timeout(1500) });
    const health = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1500) }).then(result => result.json());
    if (response.ok && health.speechBridge === 1) { reused = true; openConsole(accessToken(config.dataDir), config.port); console.log('已唤回正在运行的本机底基，语音模型与会话继续保留。'); }
  } catch { /* If no matching service is running, start normally. */ }
}
if (!reused) {
const app = createApp({ config });
app.server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? '端口已占用：请检查已有底基窗口，或修改 .env 的 PORT。' : '底基服务无法启动，请检查本机配置。');
  process.exitCode = 1; app.close().catch(() => {});
});
app.server.listen(config.port, config.host, () => {
  console.log('底基1.0 已启动。保持此窗口打开，按 Ctrl+C 停止服务。');
  console.log(`管理台：http://127.0.0.1:${app.server.address().port}/`);
  console.log('模型密钥在同目录 .env 配置；未配置也可管理角色资料和历史。');
  openConsole(app.token, app.server.address().port);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)).catch(() => process.exit(1)));
}
