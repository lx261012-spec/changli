import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../foundation/src/server.mjs';
import { careLines, readCareAudio } from '../../foundation/src/care-audio.mjs';
import { config, tempDir, removeTempDir } from '../../foundation/test/helpers.mjs';
import { startDesktopServer } from '../server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/29436/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(desktopRoot, 'qa'); mkdirSync(output, { recursive: true });
const directory = tempDir();
writeFileSync(join(directory, 'proactive-care-policy.json'), JSON.stringify({ probabilities: [.2, .4, .7, 1], timeoutAction: 'ignore', entryEnabled: false }));
const audioDir = 'D:/GPT/背景项目/长离语音包/软件主动关心/第一轮试听_2026-10-28';
const wav = readFileSync(join(desktopRoot, 'wallpaper/media/T01.wav'));
const modelCalls = [], errors = [], outsideRequests = [], failedResponses = [], audioRequests = [], checks = [], snapshots = [];
let speechCalls = 0;
const model = {
  count: async (instructions, input) => { modelCalls.push({ instructions, input }); return 50; },
  stream: async (_, input, { onDelta }) => {
    const text = '我听见了，你说的事情我们慢慢来。';
    await onDelta(text.slice(0, 6)); await new Promise(done => setTimeout(done, 180)); await onDelta(text.slice(6));
    return { text };
  }, extractMemory: async () => [],
};
const speech = { status: () => ({ configured: true, ready: true }), stop() {}, async synthesize() { speechCalls++; return { audio: wav, seconds: 3.14, generationMs: 1, loadMs: 0 }; } };
const backend = createApp({ config: { ...config, dataDir: directory, proactiveCare: true, careAudioDir: audioDir }, model, speech, token: 'a'.repeat(64) });
backend.care.start = () => {};
const older = backend.store.createSession('changli'); backend.store.createSession('changli'); backend.store.setActiveSession('changli', older.id);
backend.server.listen(0, '127.0.0.1'); await once(backend.server, 'listening');
const desktop = await startDesktopServer({ port: 0, backendURL: `http://127.0.0.1:${backend.server.address().port}`, backendToken: 'a'.repeat(64), ensureBackend: false, backendRoot: join(desktopRoot, '../foundation') });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
await context.addInitScript(({ fixture }) => {
  if (location.protocol !== 'http:') return;
  localStorage.setItem('changli-click-sound', 'false');
  window.desktop = {
    async getState() { return { testMode: false, wallpaperStatus: 'attached', petVisible: true }; },
    onEvent(callback) { window.__shellCallback = callback; },
    async enterChat() { const greet = !window.__entered; window.__entered = true; return { greet }; },
    async setRecordingShortcut() { return { registered: true }; },
    async hidePet() {}, async showPet() {}, async movePet() {}, async setPetInteractive() {}, async showChat() {}, async openSettings() {},
    async setWallpaperEnabled() { return {}; }, close() {},
  };
  const recorded = Uint8Array.from(atob(fixture), char => char.charCodeAt(0));
  class FixtureRecorder extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() { super(); this.mimeType = 'audio/wav'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.dispatchEvent(new BlobEvent('dataavailable', { data: new Blob([recorded], { type: 'audio/wav' }) })); this.dispatchEvent(new Event('stop')); }
  }
  window.MediaRecorder = FixtureRecorder;
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => ({ getTracks: () => [{ stop() {} }] }) });
}, { fixture: wav.toString('base64') });
context.on('page', page => {
  page.on('pageerror', error => errors.push({ page: page.url(), message: error.message }));
  page.on('dialog', dialog => dialog.accept());
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(desktop.url + '/')) outsideRequests.push(request.url());
    if (/\/care\/audio\//.test(request.url())) audioRequests.push(request.url());
  });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push({ url: response.url(), status: response.status() }); });
});
const tick = setInterval(() => { backend.care.engine.sample({ foreground: null, running: Object.keys(careLines) }); }, 500);
function mark(name) { checks.push(name); console.log(JSON.stringify({ passed: name })); }
function messages() { return backend.store.messages('changli', older.id); }
function queue(id) {
  backend.care.engine.rounds[id] = { id: randomUUID(), activeMs: 1800000, checkpoint: 1, invitations: 0, rejections: 0, status: 'timing', absentSince: null, invitation: null };
  backend.care.engine.queue(backend.care.engine.rounds[id], id); backend.care.engine.persist();
}
async function owner(pages) {
  for (let i = 0; i < 70; i++) {
    const owners = [];
    for (const page of pages) if (await page.locator('#care').isVisible()) owners.push(page);
    if (owners.length === 1) return owners[0];
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('Expected exactly one visible pet invitation');
}
async function playing(page, id) { await page.waitForFunction(id => { const audio = document.getElementById(id); return audio && !audio.paused && audio.currentTime > .05; }, id); }
async function paused(page, id) { assert.equal(await page.locator('#' + id).evaluate(audio => audio.paused), true); }
let result = 'failed', failure;
try {
  for (const line of Object.values(careLines)) readCareAudio(audioDir, line);
  mark('13条主动关心原录音哈希验证');
  const page = await context.newPage(); await page.goto(desktop.url); await page.locator('#connection-label').filter({ hasText: '长离在此' }).waitFor({ state: 'attached' });
  await page.locator('#enter').click(); await page.locator('#workspace').waitFor({ state: 'visible' });
  await playing(page, 'speech-audio'); await page.locator('#stop-audio').click();
  await page.locator('#back-home').click(); await page.locator('#enter').click();
  await page.waitForTimeout(200); await paused(page, 'speech-audio');
  assert.equal(backend.store.getActiveSession('changli'), older.id); mark('首页入口一次问候、返回不重播并接续当前旧会话');
  await page.locator('#voice-enabled').uncheck();
  await page.locator('#chat-input').fill('今天想与你说说话'); await page.locator('#send').click();
  await page.locator('#stream-content').filter({ hasText: '我听见了' }).waitFor();
  await page.locator('#messages .assistant .bubble').filter({ hasText: '我听见了，你说的事情我们慢慢来。' }).waitFor();
  assert.equal(messages().length, 2); assert.equal(speechCalls, 0); mark('真实底基API与SSE流式显示、关闭朗读不请求合成');
  await page.locator('#messages .assistant button').getByText('播放', { exact: true }).click(); await playing(page, 'speech-audio');
  assert.equal(speechCalls, 1); await page.locator('#stop-audio').click(); mark('关闭自动朗读仍能手动播放真实WAV');

  const pet = await context.newPage(); await pet.goto(desktop.url + '/pet.html'); await pet.waitForFunction(() => document.querySelector('#pet-canvas').width !== 1280);
  await pet.locator('#pet-canvas').hover(); await pet.locator('#pet-type').click(); await pet.locator('#pet-draft').fill('这句来自桌宠'); await pet.locator('#pet-send').click();
  await pet.locator('#pet-text').filter({ hasText: '我听见了，你说的事情我们慢慢来。' }).waitFor();
  await page.locator('#messages .user .bubble').filter({ hasText: '这句来自桌宠' }).waitFor();
  assert.equal(messages().length, 4); assert.equal(backend.store.listSessions('changli').length, 2); mark('桌宠与聊天共用当前会话、不新建独立历史');
  await pet.locator('#close-bubble').click();
  await pet.mouse.move(20,20);
  assert.equal(await pet.locator('#pet-record').isVisible(),false);
  assert.equal(await pet.locator('#pet-menu').isVisible(),false);
  let petTouchRequests=0;
  pet.on('request',req=>{if(/wallpaper\/media\/T0[1-9]\.wav/.test(req.url()))petTouchRequests++;});
  await pet.locator('#pet-canvas').hover();
  assert.equal(await pet.locator('.pet-tools button').count(),2);
  assert.equal(await pet.locator('#pet-record').isVisible(),true);
  await pet.locator('#pet-canvas').click();
  await pet.waitForTimeout(250);
  assert.equal(petTouchRequests,0);
  await pet.locator('#pet-canvas').click({button:'right'});
  await pet.locator('#pet-menu').waitFor({state:'visible'});
  assert.equal(await pet.locator('#open-chat').isVisible(),true);
  assert.equal(await pet.locator('#pet-settings').isVisible(),true);
  await pet.locator('#pet-canvas').click();
  await pet.mouse.move(20,20);
  assert.equal(await pet.locator('#pet-record').isVisible(),false);
  mark('桌宠悬停仅双图标、右键其他入口、点击表情无壁纸台词且移出隐藏');
  const secondPet = await context.newPage(); await secondPet.goto(desktop.url + '/pet.html'); await secondPet.waitForFunction(() => document.querySelector('#pet-canvas').width !== 1280);

  queue('steam'); const rejected = await owner([pet, secondPet]); await rejected.locator('#care-reject').click();
  assert.equal(messages().length, 4); assert.equal(backend.care.engine.snapshot().rounds.steam.rejections, 1); mark('双桌宠窗口邀请仅一处显示、拒绝不写聊天');
  queue('douyin'); const timed = await owner([pet, secondPet]);
  assert.match(await timed.locator('#care-seconds').textContent(), /\d+ 秒/);
  await timed.locator('#care').waitFor({ state: 'hidden', timeout: 13000 }); await timed.waitForTimeout(600);
  for(let i=0;i<60 && backend.care.engine.snapshot().rounds.douyin.status==='shown';i++) await timed.waitForTimeout(100);
  assert.equal(backend.care.engine.snapshot().rounds.douyin.status, 'ignored'); assert.equal(backend.care.engine.snapshot().rounds.douyin.rejections, 0); assert.equal(messages().length, 4); mark('真实10秒倒计时、无人回应忽略且不计拒绝');
  queue('wps'); const accepted = await owner([pet, secondPet]); const beforeAudio = audioRequests.length;
  await accepted.locator('#care-accept').click(); await accepted.locator('#pet-text').filter({ hasText: careLines.wps.text }).waitFor();
  await accepted.waitForTimeout(200); assert.equal(audioRequests.length, beforeAudio); assert.equal(messages().length, 5); mark('接听加入同一会话、关闭自动朗读不读取录音');
  await accepted.locator('#pet-play').click(); await playing(accepted, 'pet-audio'); await page.locator('#messages .assistant .bubble').filter({ hasText: careLines.wps.text }).waitFor();
  await page.locator('#messages .assistant').filter({ hasText: careLines.wps.text }).getByText('播放', { exact: true }).click(); await playing(page, 'speech-audio'); await paused(accepted, 'pet-audio'); mark('桌宠后手动主窗口播放打断前一窗口');
  const wallpaper = await context.newPage(); await wallpaper.goto(desktop.url + '/wallpaper/'); await wallpaper.waitForFunction(() => window.wallpaperDebug?.ready || document.getElementById('wallpaper').readyState >= 2);
  await wallpaper.locator('.zone.head').dispatchEvent('click'); await playing(wallpaper, 'voice'); await paused(page, 'speech-audio');
  await wallpaper.locator('.zone.head').dispatchEvent('click'); await paused(wallpaper, 'voice'); mark('壁纸加入统一播放、播放中再点只停止');
  await accepted.locator('#pet-play').click(); await playing(accepted, 'pet-audio');
  await wallpaper.locator('.zone.hand').dispatchEvent('click'); await playing(wallpaper, 'voice'); await paused(accepted, 'pet-audio');
  await page.locator('#messages .assistant').filter({ hasText: careLines.wps.text }).getByText('播放', { exact: true }).click(); await playing(page, 'speech-audio'); await paused(wallpaper, 'voice'); await page.locator('#stop-audio').click(); mark('壁纸、桌宠、聊天三处按后触发打断、不叠音');

  await accepted.locator('#close-bubble').click(); await page.bringToFront(); await page.locator('#voice-enabled').check({force:true});
  queue('qqmusic'); const auto = await owner([pet, secondPet]); const automaticBefore = audioRequests.length;
  await auto.locator('#care-accept').click(); await playing(auto, 'pet-audio'); await auto.waitForTimeout(300);
  assert.equal(audioRequests.length - automaticBefore, 1); mark('开启朗读后接听仅自动播放一次');
  await page.locator('#voice-enabled').uncheck(); await paused(auto, 'pet-audio'); await auto.locator('#close-bubble').click();
  const countBeforeRecord = messages().length;
  await pet.locator('#pet-canvas').hover();
  await pet.locator('#pet-record').click(); await pet.waitForFunction(() => document.getElementById('pet-record').classList.contains('recording'));
  await pet.locator('#pet-record-again').click(); await pet.waitForFunction(() => document.getElementById('pet-draft').value.length > 0, null, { timeout: 120000 });
  assert.match(await pet.locator('#pet-draft').inputValue(), /整理|頭髮|头发/); assert.equal(messages().length, countBeforeRecord);
  await pet.locator('#pet-draft').fill('手工修改后的录音草稿'); assert.equal(messages().length, countBeforeRecord); await pet.locator('#close-editor').click(); mark('模拟麦克风采集→真实离线识别→可编辑草稿，不自动发送');

  await page.locator('#messages .user').first().getByText('编辑', { exact: true }).click(); await page.locator('#edit-content').fill('已修改的开场'); await page.locator('#edit-form button[type=submit], #edit-form button.ornament-button').click();
  await page.locator('#edit-dialog').waitFor({ state: 'hidden' }); assert.equal(messages().length, 1); assert.equal(messages()[0].content, '已修改的开场'); mark('历史编辑覆盖后续并同步另一显示端');
  await page.locator('#messages .user').first().getByText('删除', { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#messages .message')); assert.equal(messages().length, 0); mark('消息删除调用真实底基且界面同步');

  await page.locator('[data-page=settings]').click();
  const settings = { character: '角色设定', model: '模型连接', voice: '语音', display: '角色与壁纸显示', notifications: '通知', permissions: '电脑权限' };
  for (const [key, title] of Object.entries(settings)) { await page.locator(`[data-setting=${key}]`).click(); await page.locator('#settings-content h3').filter({ hasText: title }).waitFor(); }
  assert.equal(await page.locator('.settings-nav button').count(), 6); mark('六类设置均可打开，未扩充托盘约定');
  await page.locator('[data-setting=display]').click();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1180, height: 820 }, { width: 860, height: 650 }]) {
    await page.setViewportSize(viewport);
    for (const variant of ['A', 'B']) for (const scene of ['snow', 'courtyard']) {
      await page.evaluate(({ variant, scene }) => { localStorage.setItem('changli-variant', variant); localStorage.setItem('changli-scene', scene); window.__shellCallback({ type: 'navigate', page: 'settings', section: 'display' }); }, { variant, scene });
      await page.locator('#settings-content [data-scene]').first().waitFor();
      await page.locator(`#settings-content [data-scene=${scene}]`).click(); await page.locator(`#settings-content [data-variant=${variant}]`).click();
      await page.locator('#back-home').click(); await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      const file = `home-${variant}-${scene}-${viewport.width}x${viewport.height}.png`; await page.screenshot({ path: join(output, file) }); snapshots.push(file);
      await page.locator('#enter').click(); await page.locator('[data-page=settings]').click(); await page.locator('[data-setting=display]').click();
    }
    await page.locator('[data-page=chat]').click();
    const file = `chat-${viewport.width}x${viewport.height}.png`; await page.screenshot({ path: join(output, file) }); snapshots.push(file);
    await page.locator('[data-page=settings]').click(); await page.locator('[data-setting=display]').click();
  }
  mark('A/B与风雪亭/庭院在三种窗口截图，无横向溢出');
  await pet.screenshot({ path: join(output, 'pet-live.png') }); snapshots.push('pet-live.png');
  assert.deepEqual(outsideRequests, []); assert.deepEqual(errors, []); assert.deepEqual(failedResponses, []); mark('无外网请求、脚本异常或素材/接口失败');
  assert.deepEqual(backend.store.listSessions('aimisi'), []); mark('另一角色未产生会话或记忆');
  result = 'passed';
} catch (error) { failure = { message: error.message, stack: error.stack }; console.error(error); }
finally {
  writeFileSync(join(output, 'integrated-browser-report.json'), JSON.stringify({ result, passed: checks.length, checks, failure, errors, outsideRequests, failedResponses, snapshots, cloudModel: 'explicit test double', speechSynthesis: 'existing WAV fixture', careAudio: 'real checked WAV', transcription: 'real local Whisper with simulated microphone capture', productionHistoryWritten: false, windowsNativeDesktopTested: false }, null, 2));
  clearInterval(tick); await browser.close(); await desktop.close(); await backend.close(); removeTempDir(directory);
}
if (result !== 'passed') process.exitCode = 1;
