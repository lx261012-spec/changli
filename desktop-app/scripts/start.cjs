const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, openSync } = require('node:fs');
const { resolve, join } = require('node:path');
const root = resolve(__dirname, '..');
const binary = join(root, 'runtime', 'electron.exe');
if (!existsSync(binary)) { process.stderr.write('缺少Electron运行时，请运行安装运行时.ps1。\n'); process.exit(1); }
mkdirSync(join(root, 'logs'), {recursive:true});
const log = openSync(join(root, 'logs', 'desktop.log'), 'a');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
// Electron is the visible GUI; hiding it here also suppresses its first BrowserWindow on Windows.
const child = spawn(binary, [root, ...process.argv.slice(2)], {cwd:root, env, detached:true, windowsHide:false, stdio:['ignore',log,log]});
child.on('error', () => process.stderr.write('长离程序未能启动，请查看logs/desktop.log。\n'));
child.unref();
