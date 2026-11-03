import { loadIdleAnimation } from './idle-animation.mjs';
import { $, json, report, characterPath, voiceEnabled, changes, changed, createPlayer, playMessage, Conversation, Recorder, applyAppearance, bindShell } from './service.mjs';

const player = createPlayer($('pet-audio'), text => status(text));
const chat = new Conversation(player), recorder = new Recorder();
const owner = crypto.randomUUID();
let drag, dragged = false, invitation, responding = false, carePolling = false, bubbleMessage, initial = true, latestAssistant;
let expressionUntil = 0, expressionName = 'rest', blinkUntil = 0, lastPointer = { x: .5, y: .5 }, interaction = false;
const gaze = { x: .5, y: .5 };
let baseBounds, staticBounds, idle, ready = false, savedAlpha, statusTimer, regionTimer;
let lastVideoOutline=0,lastEyeSample=-Infinity,videoEyes=[],lastPaint='',hitMask;
const silhouetteCanvas=document.createElement('canvas'), frameCanvas=document.createElement('canvas');
let opaqueStrips = [], lastRegionPaint = 0;
let taskNotice = false;
const shellState = await window.desktop?.getState();
const testMode = shellState?.testMode || new URLSearchParams(location.search).has('smoke');
const canvas = $('pet-canvas'), ctx = canvas.getContext('2d');
const images = {};
for (const [name, path] of [['rest', 'pet'], ['smile', 'pet-smile'], ['wink', 'pet-wink']]) { const img = new Image(); img.src = `/assets/${path}.png`; images[name] = img; img.onload = () => { if (name === 'rest') prepare(); }; img.onerror = () => { if (name === 'rest') status('桌宠图片加载失败，请重新打开程序。'); }; }

function status(text) { $('pet-status').textContent = text; $('pet-status').classList.add('visible'); clearTimeout(statusTimer); statusTimer = setTimeout(() => $('pet-status').classList.remove('visible'), 6000); }
document.addEventListener('notice', event => status(event.detail));
function on(id, action) { $(id).addEventListener('click', event => { event.stopPropagation(); void Promise.resolve().then(action).catch(report); }); }
function editorOpen() { return !$('pet-editor').hidden; }
function busy() { return Boolean(drag || chat.controller || recorder.state !== 'idle' || editorOpen() || !$('pet-bubble').hidden); }
function showEditor() { if (invitation && invitation.expiresAt > Date.now()) { status('请先接听或拒绝这次邀请，也可以等待倒计时结束。'); return false; } $('pet-editor').hidden = false; $('pet-bubble').hidden = true; $('pet-draft').focus(); return true; }
function showMessage(message) { taskNotice = false; bubbleMessage = message; $('pet-play').hidden = false; $('pet-continue').hidden = false; $('pet-view').textContent = '打开闲叙'; $('pet-text').textContent = message.content; $('pet-bubble').hidden = false; $('pet-editor').hidden = true; $('pet-reply-actions').hidden = false; }
on('pet-play', () => { return bubbleMessage && playMessage(player, bubbleMessage); });
on('pet-continue', showEditor);
on('pet-view', () => window.desktop?.showChat(taskNotice ? 'tasks' : 'chat'));
on('open-chat', () => window.desktop?.showChat('chat'));
on('pet-type', showEditor);
on('close-bubble', () => { $('pet-bubble').hidden = true; });
on('close-editor', () => { $('pet-editor').hidden = true; });
on('pet-record', async () => { if (showEditor()) await recorder.toggle(); });
on('pet-record-again', () => recorder.toggle());
on('hide-pet', async () => { $('pet-menu').hidden = true; await window.desktop?.hidePet(); });
on('pet-settings', () => { $('pet-menu').hidden = true; return window.desktop?.openSettings('display'); });
on('pet-send', async () => {
  const text = $('pet-draft').value; if (await chat.send(text)) { if ($('pet-draft').value === text) { $('pet-draft').value = ''; localStorage.removeItem('changli-pet-draft'); } }
});
$('pet-draft').value = localStorage.getItem('changli-pet-draft') || '';
$('pet-draft').addEventListener('input', () => localStorage.setItem('changli-pet-draft', $('pet-draft').value));
$('pet-draft').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('pet-send').click(); } });
recorder.addEventListener('state', event => { if (event.detail === 'starting') { player.stop(); } const recording = event.detail === 'recording'; $('pet-record').classList.toggle('recording', recording); $('pet-record-again').textContent = recording ? '结束录音' : '录音'; $('pet-record-label').textContent = { idle: '想对长离说', starting: '正在打开麦克风', recording: '录音中 · 再点结束', processing: '正在识别…' }[event.detail]; $('pet-send').disabled = event.detail !== 'idle'; });
recorder.addEventListener('text', event => { $('pet-draft').value += `${$('pet-draft').value ? '\n' : ''}${event.detail}`; localStorage.setItem('changli-pet-draft', $('pet-draft').value); status('识别完成，检查文字后点击发送。'); });
chat.addEventListener('busy', event => { $('pet-send').disabled = event.detail; if (event.detail) { $('pet-editor').hidden = true; $('pet-bubble').hidden = false; $('pet-text').textContent = '长离正在思量…'; $('pet-reply-actions').hidden = true; } });
chat.addEventListener('delta', event => { $('pet-text').textContent = event.detail; $('pet-text').scrollTop = $('pet-text').scrollHeight; });
chat.addEventListener('saved', event => showMessage(event.detail));
chat.addEventListener('refresh', event => {
  const latest = [...chat.messages].reverse().find(message => message.role === 'assistant');
  // Historical messages stay quiet on startup and polls never replay audio.
  if (!initial && latest && latest.id !== latestAssistant && !chat.controller && !$('pet-bubble').hidden && bubbleMessage?.id === latest.id) showMessage(latest);
  latestAssistant = latest?.id; initial = false;
});

async function pollCare() {
  if (testMode || carePolling || responding || document.hidden || !ready) return;
  carePolling = true;
  try {
    const result = await json(characterPath('/care'));
    const rounds = Object.values(result.rounds || {}), shown = rounds.find(round => round.status === 'shown');
    const next = shown?.invitation?.owner === owner ? shown : !shown && !busy() ? rounds.find(round => round.status === 'queued') : null;
    if (!next) { invitation = null; tickCare(); return; }
    if (invitation?.id === next.invitation.id) return;
    $('care').hidden = false;
    invitation = await json(characterPath('/care/present'), 'POST', { invitationId: next.invitation.id, consumerId: owner });
    tickCare();
  } catch (error) { invitation = null; tickCare(); if (error.status !== 409) report(error); }
  finally { carePolling = false; }
}
function tickCare() {
  const remaining = Math.max(0, (invitation?.expiresAt || 0) - Date.now());
  $('care').hidden = !remaining || document.hidden;
  $('care-progress').style.width = `${Math.min(100, remaining / 100)}%`;
  $('care-seconds').textContent = `${Math.ceil(remaining / 1000)} 秒`;
  $('care-accept').disabled = responding || !remaining; $('care-reject').disabled = responding || !remaining;
}
async function respond(choice) {
  if (!invitation || responding || Date.now() >= invitation.expiresAt) return;
  responding = true; tickCare();
  try {
    const result = await json(characterPath('/care/respond'), 'POST', { invitationId: invitation.id, consumerId: owner, choice, sessionId: chat.sessionId || null });
    invitation = null; tickCare();
    if (result.delivery) { await chat.refresh(); showMessage(result.delivery.message); changed(); if (voiceEnabled()) void playMessage(player, result.delivery.message); }
  } catch (error) { report(error); invitation = null; tickCare(); }
  finally { responding = false; tickCare(); }
}
on('care-accept', () => respond('accept')); on('care-reject', () => respond('reject'));

function prepare() {
  const image = images.rest, work = document.createElement('canvas'); work.width = image.naturalWidth; work.height = image.naturalHeight;
  const context = work.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0); const pixels = context.getImageData(0, 0, work.width, work.height);
  let left = work.width, top = work.height, right = 0, bottom = 0;
  for (let y = 0; y < work.height; y++) for (let x = 0; x < work.width; x++) if (pixels.data[(y * work.width + x) * 4 + 3] > 25) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  baseBounds = { left, top, width: right - left + 1, height: bottom - top + 1 };
  opaqueStrips = [];
  for (let row = 0; row < baseBounds.height; row += 24) {
    let min = baseBounds.width, max = -1;
    for (let y = row; y < Math.min(row + 24, baseBounds.height); y++) for (let x = 0; x < baseBounds.width; x++) {
      if (pixels.data[((baseBounds.top + y) * pixels.width + baseBounds.left + x) * 4 + 3] > 25) { min = Math.min(min, x); max = Math.max(max, x); }
    }
    if (max >= min) opaqueStrips.push({ x: min, y: row, width: max - min + 1, height: Math.min(24, baseBounds.height - row) });
  }
  staticBounds={...baseBounds};
  canvas.width = baseBounds.width; canvas.height = baseBounds.height; savedAlpha = pixels; ready = true; draw(); queueRegions();
  void startIdle().catch(error=>{console.warn(error.message);});
}
async function startIdle(){
  const result=await loadIdleAnimation('/assets/pet-idle.json');
  if(!result)return;
  idle=result;baseBounds={...result.bounds};canvas.width=baseBounds.width;canvas.height=baseBounds.height;lastPaint='';
  draw();refreshSilhouette();queueRegions();
}
function refreshSilhouette(){
  const width=180,height=Math.ceil(canvas.height/canvas.width*width);
  silhouetteCanvas.width=width;silhouetteCanvas.height=height;
  const sample=silhouetteCanvas.getContext('2d',{willReadFrequently:true});sample.drawImage(canvas,0,0,width,height);
  const pixels=sample.getImageData(0,0,width,height).data,scale=canvas.width/width;
  hitMask={data:pixels,width,height};
  opaqueStrips=[];
  for(let row=0;row<height;row+=3){
    let min=width,max=-1;
    for(let y=row;y<Math.min(height,row+3);y++)for(let x=0;x<width;x++)if(pixels[(y*width+x)*4+3]>25){min=Math.min(min,x);max=Math.max(max,x);}
    if(max>=min)opaqueStrips.push({x:min*scale,y:row*scale,width:(max-min+1)*scale,height:Math.min(3,height-row)*scale});
  }
  lastVideoOutline=performance.now();publishRegions();
}
function videoGaze(blink){
  if(!blink&&Math.abs(gaze.x-.5)+Math.abs(gaze.y-.5)<.002)return;
  if(performance.now()-lastEyeSample>200){
    const sample=frameCanvas.getContext('2d',{willReadFrequently:true});
    if(frameCanvas.width!==48||frameCanvas.height!==64){frameCanvas.width=48;frameCanvas.height=64;}
    videoEyes=[];
    for(const region of idle.config.eyeRegions||[]){
      sample.clearRect(0,0,48,64);sample.drawImage(idle.video,region.x,region.y,region.width,region.height,0,0,48,64);
      const data=sample.getImageData(0,0,48,64).data;
      let minX=48,maxX=0,minY=64,maxY=0,count=0;
      for(let j=0;j<64;j++)for(let i=0;i<48;i++){
        const k=(j*48+i)*4,r=data[k],g=data[k+1],b=data[k+2];
        if(r>170&&g>95&&g-b>25&&r-g>3){minX=Math.min(minX,i);maxX=Math.max(maxX,i);minY=Math.min(minY,j);maxY=Math.max(maxY,j);count++;}
      }
      if(count>12)videoEyes.push({x:region.x-baseBounds.left+(minX+maxX)/2/48*region.width,y:region.y-baseBounds.top+(minY+maxY)/2/64*region.height,w:(maxX-minX)/48*region.width,h:(maxY-minY)/64*region.height,index:videoEyes.length});
    }
    lastEyeSample=performance.now();
  }
  for(const eye of videoEyes){
    ctx.save();ctx.beginPath();ctx.ellipse(eye.x,eye.y,eye.w*(blink?.65:.43),eye.h*(blink?.65:.43),0,0,Math.PI*2);ctx.clip();
    if(blink&&images.smile.complete){
      const scale=eye.w/120,cx=eye.index===0?484:791;
      ctx.drawImage(images.smile,eye.x-cx*scale,eye.y-812*scale,images.smile.naturalWidth*scale,images.smile.naturalHeight*scale);
    }else{ctx.drawImage(idle.video,baseBounds.left-(gaze.x-.5)*3.8,baseBounds.top-(gaze.y-.5)*2.1,baseBounds.width,baseBounds.height,0,0,canvas.width,canvas.height);}
    ctx.restore();
  }
}
function publishRegions() {
  if (!ready || !window.desktop?.setPetRegions) return;
  const rect = canvas.getBoundingClientRect(), scaleX = rect.width / baseBounds.width, scaleY = rect.height / baseBounds.height;
  const regions = opaqueStrips.map(strip => ({ x: Math.floor(rect.x + strip.x * scaleX) - 1, y: Math.floor(rect.y + strip.y * scaleY) - 1, width: Math.ceil(strip.width * scaleX) + 2, height: Math.ceil(strip.height * scaleY) + 2 }));
  for (const node of document.querySelectorAll('.pet-bubble:not([hidden]),.pet-tools,#pet-menu:not([hidden])')) {
    const rect = node.getBoundingClientRect(); if (!rect.width || !rect.height || getComputedStyle(node).visibility === 'hidden' || getComputedStyle(node).pointerEvents === 'none') continue;
    regions.push({ x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
  }
  void Promise.resolve(window.desktop.setPetRegions(regions)).catch(report); lastRegionPaint = performance.now();
}
function queueRegions() { clearTimeout(regionTimer); regionTimer = setTimeout(publishRegions, 16); }
new MutationObserver(queueRegions).observe(document.querySelector('.pet-stage'), { attributes: true, attributeFilter: ['hidden', 'class'], childList: true, subtree: true });
window.addEventListener('resize', queueRegions);
function placePet(position) {
  const stage=document.querySelector('.pet-stage');
  stage.style.left=`${position.x}px`; stage.style.top=`${position.y}px`;
  stage.classList.toggle('panels-below',Boolean(position.below));
  stage.classList.toggle('panels-left',Boolean(position.alignLeft));
  queueRegions();
}
function applyPetSettings(settings,position) {
  document.documentElement.style.setProperty('--pet-width',`${250*settings.scale}px`);
  $('pet-figure').style.opacity=String(settings.opacity);
  if(position)placePet(position);else queueRegions();
}
if(shellState?.petSettings)applyPetSettings(shellState.petSettings);
if(shellState?.petPosition) placePet(shellState.petPosition);
const stage=document.querySelector('.pet-stage');
stage.addEventListener('pointerenter',()=>{stage.classList.add('hovered');queueRegions();});
stage.addEventListener('pointerleave',()=>{stage.classList.remove('hovered');queueRegions();});
stage.addEventListener('focusin',queueRegions);stage.addEventListener('focusout',queueRegions);

function draw() {
  if (!ready||document.hidden) return;
  const now = performance.now(), base = images.rest, bounds = baseBounds;
  if ($('pet-figure').classList.contains('hop') && now - lastRegionPaint > 90) publishRegions();
  gaze.x += (lastPointer.x - gaze.x) * .16; gaze.y += (lastPointer.y - gaze.y) * .16;
  const state = now < expressionUntil ? expressionName : 'rest',blink=state==='rest'&&now<blinkUntil;
  // A temporarily buffering video keeps its last painted frame; never insert the old portrait.
  if(idle&&state==='rest'&&idle.video.readyState<2)return;
  const frame=idle?(idle.video.requestVideoFrameCallback?idle.frame:Math.floor(idle.video.currentTime*24)):0;
  const paintKey=`${state}/${blink}/${frame}/${Math.round(gaze.x*500)}/${Math.round(gaze.y*500)}`;
  if(paintKey===lastPaint)return;lastPaint=paintKey;
  const image = images[state]?.complete && images[state].naturalWidth ? images[state] : base;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if(idle&&state==='rest'&&idle.video.readyState>=2){
    ctx.drawImage(idle.video,bounds.left,bounds.top,bounds.width,bounds.height,0,0,canvas.width,canvas.height);videoGaze(blink);
  }else{const source=staticBounds, target=idle?.config.expressionBounds||{left:0,top:0,width:canvas.width,height:canvas.height};ctx.drawImage(image,source.left,source.top,source.width,source.height,target.left,target.top,target.width,target.height);}
  if(idle&&now-lastVideoOutline>250)refreshSilhouette();
  if (state === 'rest'&&!idle) {
    if(blink&&images.smile.complete){
      for(const cx of [484,791]){const x=cx-bounds.left,y=812-bounds.top;ctx.save();ctx.beginPath();ctx.ellipse(x,y,105,90,0,0,Math.PI*2);ctx.clip();ctx.drawImage(images.smile,bounds.left,bounds.top,bounds.width,bounds.height,0,0,canvas.width,canvas.height);ctx.restore();}
    }
    if(blink||Math.abs(gaze.x-.5)+Math.abs(gaze.y-.5)<.002)return;
    // Keep the inked eye borders fixed; shift only the gold interior/highlight.
    for (const [cx, cy, rx, ry] of [[.405, .645, .037, .053], [.619, .646, .037, .053]]) {
      const x = cx * base.naturalWidth - bounds.left, y = cy * base.naturalHeight - bounds.top;
      ctx.save(); ctx.beginPath(); ctx.ellipse(x, y, rx * base.naturalWidth, ry * base.naturalHeight, 0, 0, Math.PI * 2); ctx.clip();
      const dx = (gaze.x - .5) * 3.8, dy = (gaze.y - .5) * 2.1;
      ctx.drawImage(base, bounds.left - dx, bounds.top - dy, bounds.width, bounds.height, 0, 0, canvas.width, canvas.height); ctx.restore();
    }
  }
}
function expression() { expressionName = Math.random() > .5 ? 'smile' : 'wink'; expressionUntil = performance.now() + 1700; $('pet-figure').classList.add('expression'); setTimeout(() => $('pet-figure').classList.remove('expression'), 1700); }
canvas.addEventListener('pointerdown', event => { if (event.button !== 0) return; drag = { x: event.screenX, y: event.screenY, startX: event.screenX, startY: event.screenY }; dragged = false; canvas.setPointerCapture(event.pointerId); });
canvas.addEventListener('pointermove', event => {
  const rect = canvas.getBoundingClientRect(); lastPointer = { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  if (!drag) return;
  if (Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) > 4) dragged = true;
  if (dragged) { const dx = event.screenX - drag.x, dy = event.screenY - drag.y; drag.x = event.screenX; drag.y = event.screenY; void window.desktop?.movePet({ dx, dy }).then(position => { if(position) placePet(position); }).catch(report); }
});
canvas.addEventListener('pointerup', event => {
  const click = drag && !dragged; drag = null; if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (click) expression();
});
canvas.addEventListener('pointercancel', () => { drag = null; });
canvas.addEventListener('pointerleave', () => { lastPointer = { x: .5, y: .5 }; });
canvas.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); expression(); } });
document.addEventListener('contextmenu', event => { event.preventDefault(); $('pet-menu').hidden = false; });
document.addEventListener('pointerdown', event => { if (!event.target.closest('#pet-menu')) $('pet-menu').hidden = true; });
function hitTest(event) {
  const target = document.elementFromPoint(event.clientX, event.clientY) || event.target;
  const interactive = target.closest('button,textarea,.pet-bubble,.pet-menu');
  let hit = Boolean(interactive);
  if (target === canvas && ready) {
    const rect=canvas.getBoundingClientRect(),nx=(event.clientX-rect.left)/rect.width,ny=(event.clientY-rect.top)/rect.height;
    if(hitMask){const x=Math.floor(nx*hitMask.width),y=Math.floor(ny*hitMask.height);hit=x>=0&&y>=0&&x<hitMask.width&&y<hitMask.height&&hitMask.data[(y*hitMask.width+x)*4+3]>25;}
    else{const x=Math.floor(nx*baseBounds.width+baseBounds.left),y=Math.floor(ny*baseBounds.height+baseBounds.top);hit=(savedAlpha.data[(y*savedAlpha.width+x)*4+3]||0)>25;}
  }
  hit ||= Boolean(drag);
  if (interaction !== hit) { interaction = hit; void window.desktop?.setPetInteractive(hit); }
}
document.addEventListener('mousemove', hitTest);
function scheduleHop() { setTimeout(() => { if (!busy() && $('care').hidden) { $('pet-figure').classList.add('hop'); setTimeout(() => $('pet-figure').classList.remove('hop'), 750); } scheduleHop(); }, 16000 + Math.random() * 20000); }
function scheduleBlink() { setTimeout(() => { if (performance.now() > expressionUntil) blinkUntil = performance.now() + 170; scheduleBlink(); }, 3600 + Math.random() * 4900); }
scheduleHop(); scheduleBlink();
function paintLoop(){draw();requestAnimationFrame(paintLoop);}
requestAnimationFrame(paintLoop);
setInterval(tickCare, 100);
setInterval(() => { if (!document.hidden) { void chat.refresh().catch(report); void pollCare(); } }, 2500);
changes.addEventListener('message', event => { if (event.data?.type === 'appearance') applyAppearance(); else void chat.refresh().catch(report); });
bindShell(event => {
  if (event.type === 'pet-settings') { applyPetSettings(event.settings,event.petPosition); return; }
  if (event.type === 'pet-position') { placePet(event); return; }
  if (event.type === 'record-toggle') { if (showEditor()) return recorder.toggle(); }
  if (event.type === 'audio-toggle') return;
  if (event.type === 'task-complete') { taskNotice = true; $('pet-text').textContent = event.status === 'completed' ? '交给我的事情已经办妥了。' : '这件事需要你再看一眼。'; $('pet-bubble').hidden = false; $('pet-reply-actions').hidden = false; $('pet-play').hidden = true; $('pet-continue').hidden = true; $('pet-view').textContent = '查看'; }
});
void chat.refresh().catch(report); applyAppearance();
