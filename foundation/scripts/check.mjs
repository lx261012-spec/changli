import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function check(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) check(path);
    else if (/\.(mjs|js)$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit', windowsHide: true });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
for (const directory of ['src', 'test', 'scripts', 'public']) check(join(root, directory));
await import('@ui-tars/sdk');
await import('@ui-tars/operator-nut-js');
console.log('语法检查与 UI-TARS/Windows 原生依赖导入通过。');
