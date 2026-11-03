import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../foundation/src/server.mjs';
import { config, tempDir, removeTempDir } from '../../foundation/test/helpers.mjs';
import { startDesktopServer } from '../server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/29436/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = dirname(dirname(fileURLToPath(import.meta.url))), output = join(root, 'qa'); mkdirSync(output, { recursive: true });
const targeted = process.argv.includes('--targeted');
const temp = tempDir(), wav = readFileSync(join(root, 'wallpaper/media/T01.wav'));
let modelFails = false;
const model = { count: async () => 30, stream: async () => { if (modelFails) throw Object.assign(new Error('测试模型暂不可用'), { code: 'service_unavailable' }); return { text: '听见了。' }; }, extractMemory: async () => [] };
const speech = { status: () => ({ configured: true, ready: true }), stop() {}, async synthesize() { return { audio: wav, seconds: 3.14, generationMs: 0, loadMs: 0 }; } };
const backend = createApp({ config: { ...config, dataDir: temp }, model, speech, token: 'b'.repeat(64) });
const session = backend.store.createSession('changli'); backend.store.setActiveSession('changli', session.id);
backend.store.addMessage('changli', session.id, 'user', '忙了一天，想在这里安静待一会儿。');
backend.store.addMessage('changli', session.id, 'assistant', '那便在这里歇一歇。雪落得正轻，不必急着把所有事情说完。\n\n若有想聊的，我听着；若只想坐一会儿，也很好。');
backend.store.addMessage('changli', session.id, 'user', '好，陪我听会儿雪吧。');
backend.server.listen(0, '127.0.0.1'); await once(backend.server, 'listening');
const desktop = await startDesktopServer({ port: 0, backendURL: `http://127.0.0.1:${backend.server.address().port}`, backendToken: 'b'.repeat(64), ensureBackend: false, backendRoot: join(root, '../foundation') });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const errors = [], checks = [], snapshots = [];
await context.addInitScript(() => {
  if (location.protocol !== 'http:') return;
  localStorage.setItem('changli-speech-enabled', 'false'); localStorage.setItem('changli-click-sound', 'false');
  window.desktop = { async getState() { return { testMode: true, wallpaperSettings: { follow: true, volume: .7, videoSound: false, paused: false } }; }, onEvent(callback) { window.__shellCallback = callback; }, async enterChat() { return { greet: false }; }, async setRecordingShortcut() {}, async showPet() {}, async hidePet() {}, async setWallpaperEnabled() { return {}; }, close() {} };
});
context.on('page', page => { page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept()); });
function mark(name) { checks.push(name); console.log(JSON.stringify({ passed: name })); }
async function playing(page, id) { await page.waitForFunction(id => { const a = document.getElementById(id); return a && !a.paused && a.currentTime > .05; }, id); }
let result = 'failed', failure;
try {
  const page = await context.newPage(); await page.goto(desktop.url); await page.waitForTimeout(1900);
  const titleDebug = await page.locator('#home-title').evaluate(image => [image, image.parentElement, image.parentElement.parentElement].map(node => {
    const style = getComputedStyle(node); return { tag: node.tagName, className: node.className, hidden: node.hidden, opacity: style.opacity, clipPath: style.clipPath, display: style.display, visibility: style.visibility, filter: style.filter, transform: style.transform, rect: node.getBoundingClientRect().toJSON(), naturalWidth: node.naturalWidth, complete: node.complete, animations: node.getAnimations().map(animation => ({playState: animation.playState,currentTime: animation.currentTime})) };
  }));
  writeFileSync(join(output, 'title-dom-debug.json'), JSON.stringify(titleDebug, null, 2));
  await page.screenshot({path:join(output,'home-title-debug.png')});
  await page.locator('#enter').click(); await page.locator('#messages .message').first().waitFor();
  const wallpaper = await context.newPage(); await wallpaper.goto(desktop.url + '/wallpaper/'); await wallpaper.waitForFunction(() => document.getElementById('wallpaper').readyState >= 2);
  await page.locator('[data-page=settings]').click(); await page.locator('[data-setting=display]').click();
  await page.getByLabel('壁纸眼睛轻微跟随鼠标').uncheck(); await wallpaper.waitForFunction(() => !document.getElementById('eye-follow').checked);
  await page.getByLabel('暂停壁纸画面').check(); await wallpaper.waitForFunction(() => document.getElementById('wallpaper').paused);
  await page.locator('#settings-content input[type=range]').fill('0.35'); await page.locator('#settings-content input[type=range]').dispatchEvent('change');
  await wallpaper.waitForFunction(() => Math.abs(document.getElementById('voice').volume - .35) < .001);
  assert.equal(await wallpaper.locator('#wallpaper').evaluate(video => video.paused), true);
  mark('主界面显示设置广播真实作用于壁纸，调音量不解除暂停');
  await wallpaper.evaluate(() => { window.__leaveCount = 0; document.getElementById('stage').addEventListener('pointerleave', () => window.__leaveCount++); window.__shellCallback({ type: 'wallpaper-pointer', x: 600, y: 200, active: false, down: false }); });
  assert.equal(await wallpaper.evaluate(() => window.__leaveCount), 1); mark('非桌面前台原生指针触发离开，不继续跟随');
  await page.locator('[data-page=chat]').click();
  await wallpaper.route('**/media/T*.wav', async route => { await new Promise(done => setTimeout(done, 700)); await route.continue(); }, { times: 1 });
  await wallpaper.locator('.zone.head').dispatchEvent('click');
  await page.locator('#messages .assistant').getByText('播放', { exact: true }).click(); await playing(page, 'speech-audio'); await page.waitForTimeout(900);
  assert.equal(await wallpaper.locator('#voice').evaluate(audio => audio.paused), true);
  assert.equal(await page.locator('#speech-audio').evaluate(audio => audio.paused), false); await page.locator('#stop-audio').click();
  mark('延迟的旧壁纸录音不会打断用户后来启动的聊天播放');

  if (!targeted) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1180, height: 820 }, { width: 860, height: 650 }]) {
    await page.setViewportSize(viewport);
    await page.locator('[data-page=settings]').click(); await page.locator('[data-setting=display]').click();
    for (const variant of ['A', 'B']) for (const scene of ['snow', 'courtyard']) {
      await page.locator(`#settings-content [data-scene=${scene}]`).click(); await page.locator(`#settings-content [data-variant=${variant}]`).click();
      await page.locator('#back-home').click(); await page.waitForTimeout(1850);
      assert.equal(await page.locator('#home-title').evaluate(image => image.complete && image.naturalWidth > 0 && parseFloat(getComputedStyle(image).opacity) >= .99), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      let file = `home-${variant}-${scene}-${viewport.width}x${viewport.height}.png`; await page.screenshot({ path: join(output, file) }); snapshots.push(file);
      await page.locator('#enter').click(); await page.waitForTimeout(450);
      file = `chat-${variant}-${scene}-${viewport.width}x${viewport.height}.png`; await page.screenshot({ path: join(output, file) }); snapshots.push(file);
      const overflow = await page.locator('#messages').evaluate(node => node.scrollWidth > node.clientWidth + 1); assert.equal(overflow, false);
      await page.locator('[data-page=settings]').click(); await page.locator('[data-setting=display]').click();
    }
  }
  mark('两版两场景三尺寸完整书法入场与真实气泡排版，24张截图且无横向溢出');
  }
  await page.locator('[data-page=chat]').click(); await page.locator('#select-messages').click();
  const selector = page.locator('#messages .message input[type=checkbox]').first(); await selector.check(); await page.locator('#delete-selected').click();
  await page.waitForFunction(() => document.querySelectorAll('#messages .message').length === 2);
  assert.equal(backend.store.messages('changli', session.id).length, 2); mark('选择指定消息删除准确调用底基、不误删其余消息');

  await page.locator('#new-chat').click();
  await page.locator('#chat-input').fill('临时模型故障后重试'); modelFails = true; await page.locator('#send').click();
  await page.locator('#notice').filter({ hasText: '测试模型暂不可用' }).waitFor();
  const retrySession = backend.store.getActiveSession('changli');
  assert.equal(backend.store.messages('changli', retrySession).length, 1);
  modelFails = false;
  await page.locator('#messages .user').getByText('重试回复', { exact: true }).click();
  await page.locator('#messages .assistant .bubble').filter({ hasText: '听见了。' }).waitFor();
  assert.deepEqual(backend.store.messages('changli', retrySession).map(message => message.content), ['临时模型故障后重试', '听见了。']);
  mark('实际失败消息保留、明确重试成功只保留一份用户原文');

  await context.addInitScript(({ base64 }) => {
    if (location.protocol !== 'http:') return;
    const bytes = Uint8Array.from(atob(base64), value => value.charCodeAt(0));
    window.MediaRecorder = class extends EventTarget {
      static isTypeSupported() { return true; }
      constructor() { super(); this.mimeType = 'audio/wav'; }
      start() {}
      stop() { this.dispatchEvent(new BlobEvent('dataavailable', { data: new Blob([bytes], { type: 'audio/wav' }) })); this.dispatchEvent(new Event('stop')); }
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => ({ getTracks: () => [{ stop() {} }] }) });
  }, { base64: wav.toString('base64') });
  const pet = await context.newPage(); await pet.setViewportSize({ width: 400, height: 560 }); await pet.goto(desktop.url + '/pet.html');
  await pet.waitForFunction(() => document.getElementById('pet-canvas').width !== 1280); await pet.waitForTimeout(200);
  await pet.evaluate(() => window.__shellCallback({ type: 'record-toggle' }));
  await pet.waitForFunction(() => document.getElementById('pet-record').classList.contains('recording'));
  await pet.evaluate(() => window.__shellCallback({ type: 'record-toggle' }));
  await pet.waitForFunction(() => document.getElementById('pet-draft').value.length > 0, null, { timeout: 120000 });
  assert.match(await pet.locator('#pet-draft').inputValue(), /整理|頭髮|头发/);
  assert.equal(backend.store.messages('changli', retrySession).length, 2);
  mark('原生快捷键事件两次切换录音并识别为未发送草稿');
  await pet.screenshot({ path: join(output, 'pet-live.png') }); snapshots.push('pet-live.png');
  assert.deepEqual(errors, []); mark('目标修复与视觉检查无脚本异常'); result = 'passed';
} catch (error) { failure = { message: error.message, stack: error.stack }; console.error(error); }
finally {
  writeFileSync(join(output, targeted ? 'integrated-targeted-report.json' : 'integrated-visual-report.json'), JSON.stringify({ result, passed: checks.length, checks, errors, failure, snapshots, fixtureMessages: 'Clearly isolated visual fixture only; no production data', nativePointer: 'Synthetic event payload through actual adapter', actualWindowsDesktopTested: false }, null, 2));
  await browser.close(); await desktop.close(); await backend.close(); removeTempDir(temp);
}
if (result !== 'passed') process.exitCode = 1;
