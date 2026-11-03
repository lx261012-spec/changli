import { existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { ModelError } from './model.mjs';

const execute = promisify(execFile);
// shortcut: this machine's verified QQ Music path; add discovery when supporting other installations.
const executable = 'D:/QQMusic/QQMusic.exe';

// Only a complete, explicit request can launch; prose, negation and extra actions stay in chat.
export function requestsQQMusic(text) {
  if(typeof text!=='string')return false;
  const simplified={幫:'帮',開:'开',啟:'启',動:'动',樂:'乐',長:'长',離:'离',請:'请',嗎:'吗',愛:'爱',彌:'弥',將:'将'};
  const value=text.normalize('NFKC').trim().replace(/[幫開啟動樂長離請嗎愛彌將]/g,char=>simplified[char]);
  return /^(?:(?:长离|爱弥斯)\s*[，,:：]?\s*)?(?:(?:请|麻烦|帮我|帮忙|给我|替我|能不能|可不可以|可以|能|你)\s*)*(?:(?:打开|启动)\s*(?:一下\s*)?QQ\s*音乐|(?:把|将)\s*QQ\s*音乐\s*(?:给我\s*)?(?:打开|启动))\s*(?:一下)?\s*(?:吧|吗|好吗|可以吗)?[。！!？?]*$/i.test(value);
}

export const qqMusicAvailable = () => process.platform === 'win32' && existsSync(executable);

export async function openQQMusic(signal) {
  signal?.throwIfAborted();
  if (!qqMusicAvailable()) throw new ModelError('没有找到已配置的 QQ 音乐程序，暂未启动。', 'app_unavailable', 503);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA)$/i.test(key)));
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { shell: false, detached: true, windowsHide: false, stdio: 'ignore', env });
    child.once('error', () => reject(new ModelError('QQ 音乐启动失败，请稍后重试。', 'app_launch_failed', 503)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    await setTimeout(300, undefined, { signal });
    let result;
    try {
      result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -Name QQMusic -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq 'D:\\QQMusic\\QQMusic.exe' }).Count"], { windowsHide: true, env, timeout: 4000, signal });
    } catch {
      signal?.throwIfAborted();
      throw new ModelError('已发送打开请求，但暂时无法核对 QQ 音乐的运行状态，请检查窗口。', 'app_launch_unconfirmed', 503);
    }
    if (Number(result.stdout.trim()) > 0) return 'QQ 音乐已经启动了，选一首想听的吧。';
  }
  throw new ModelError('已发送打开请求，但尚未确认 QQ 音乐启动成功，请检查后重试。', 'app_launch_unconfirmed', 503);
}
