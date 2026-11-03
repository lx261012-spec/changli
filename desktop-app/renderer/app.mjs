import { $, el, button, json, request, report, characterPath, voiceEnabled, setVoiceEnabled, changes, changed, createPlayer, playMessage, Conversation, Recorder, preference, setPreference, applyAppearance, bindShell } from './service.mjs';

const player = createPlayer($('speech-audio'), text => { $('speech-status').textContent = text; });
const chat = new Conversation(player), recorder = new Recorder();
let page = 'chat', setting = 'character', edit, lastMessages = '', initialized = false, wasBusy = false;
let knownShortcut, poll;
let selectionMode = false, selectionSession;
const selectedMessages = new Set();
let shellStatus, startupNotice = '';
const scenes = { snow: { title: '听雪闲叙', place: '乘霄山', file: 'pavilion' }, courtyard: { title: '绯雾闲叙', place: '庭院', file: 'courtyard' } };
const titles = { chat: '此间闲叙', sessions: '往日留痕', memories: '心中所记', tasks: '与君协作', settings: '此间设置' };
const statusLabels = { running: '执行中', awaiting_approval: '等待确认', paused: '已暂停', completed: '已完成', failed: '未完成', cancelled: '已结束' };

function notice(text) { $('notice').textContent = text; }
document.addEventListener('notice', event => notice(event.detail));
function on(id, type, action) { $(id).addEventListener(type, event => { if (type === 'submit') event.preventDefault(); void Promise.resolve().then(() => action(event)).catch(report); }); }
function empty(container, title, text) { const node = el('div', undefined, 'empty-state'); node.append(el('span', '❧', 'empty-mark'), el('h3', title), el('p', text)); container.replaceChildren(node); }
function time(value) { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function applyScene() {
  applyAppearance(); const scene = scenes[preference('scene', 'snow')] || scenes.snow;
  const video = $('background'), source = `/assets/${scene.file}.mp4`;
  if (video.getAttribute('src') !== source) { video.src = source; video.poster = `/assets/${scene.file}.png`; video.play().catch(() => {}); }
  $('home-title').src = `/assets/title-${preference('scene', 'snow')}.png`; $('home-title').alt = scene.title;
  $('home-location').textContent = scene.place; $('fallback-title').textContent = scene.title;
  if (page === 'chat') $('page-title').textContent = scene.title;
  document.querySelectorAll('[data-scene]').forEach(node => node.classList.toggle('active', node.dataset.scene === preference('scene', 'snow')));
  document.querySelectorAll('[data-variant]').forEach(node => node.classList.toggle('active', node.dataset.variant === preference('variant', 'A')));
}
function appearanceSwitch() {
  const row = el('div', undefined, 'appearance-switch');
  for (const [value, label] of [['snow', '风雪亭'], ['courtyard', '庭院']]) { const b = button(label, () => { setPreference('scene', value); applyScene(); }, ''); b.dataset.scene = value; row.append(b); }
  row.append(el('i'));
  for (const [value, label] of [['A', 'A · 离火'], ['B', 'B · 凤翎']]) { const b = button(label, () => { setPreference('variant', value); applyScene(); }, ''); b.dataset.variant = value; row.append(b); }
  return row;
}
document.querySelectorAll('.home-switch button').forEach(node => node.addEventListener('click', () => { if (node.dataset.scene) setPreference('scene', node.dataset.scene); else setPreference('variant', node.dataset.variant); applyScene(); }));
$('home-title').addEventListener('error', () => { $('home-title').hidden = true; $('fallback-title').hidden = false; });
$('home-title').addEventListener('load', () => { $('home-title').hidden = false; $('fallback-title').hidden = true; });
$('background').addEventListener('error', () => notice('背景视频未能加载，已保留静态场景；可点击重新连接。'));

function showPage(next) {
  page = titles[next] ? next : 'chat';
  $('home').hidden = true; $('workspace').hidden = false; document.body.classList.remove('home-mode');
  for (const name of Object.keys(titles)) $(`${name}-page`).hidden = name !== page;
  document.querySelectorAll('[data-page]').forEach(node => node.classList.toggle('active', node.dataset.page === page));
  $('page-eyebrow').textContent = titles[page]; $('page-title').textContent = page === 'chat' ? scenes[preference('scene', 'snow')].title : titles[page];
  if (page === 'settings') renderSettings(); if (page === 'sessions') renderSessions(); if (page === 'memories') renderMemories(); if (page === 'tasks') renderTasks();
}
document.querySelectorAll('[data-page]').forEach(node => node.addEventListener('click', () => showPage(node.dataset.page)));
document.querySelectorAll('[data-setting]').forEach(node => node.addEventListener('click', () => { setting = node.dataset.setting; renderSettings(); }));
on('enter', 'click', async () => {
  const result = await window.desktop?.enterChat(); showPage('chat');
  if (result?.greet) { try { await player.playBlob(await (await request('/assets/greeting.wav')).blob()); } catch (error) { report(`问候语音暂不可用：${error.message}`); } }
});
on('back-home', 'click', () => { $('home').hidden = false; $('workspace').hidden = true; document.body.classList.add('home-mode'); });
on('window-close', 'click', () => window.desktop ? window.desktop.close() : window.close());
on('window-recycle','click',()=>window.desktop?.close());
on('window-minimize','click',()=>window.desktop?.minimize());
on('window-maximize','click',async()=>{if(!window.desktop?.toggleMaximize)throw new Error('请重新打开桌面程序后使用窗口放大。');updateWindowControls(await window.desktop.toggleMaximize());});
function updateWindowControls(state){
  const control=$('window-maximize'),maximized=Boolean(state?.maximized);
  control.classList.toggle('maximized',maximized);control.setAttribute('aria-pressed',String(maximized));
  control.title=maximized?'还原窗口':'最大化';control.setAttribute('aria-label',control.title);
}
on('refresh', 'click', async () => { await chat.refresh(); notice('已重新连接。'); });
on('new-chat', 'click', async () => { await chat.newSession(); showPage('chat'); $('chat-input').focus(); });
on('new-session', 'click', async () => { await chat.newSession(); showPage('chat'); });
on('stop', 'click', () => chat.stop());
on('stop-audio', 'click', () => player.stop());
on('select-messages', 'click', () => { selectionMode = !selectionMode; $('messages').classList.toggle('selecting', selectionMode); $('select-messages').textContent = selectionMode ? '取消选择' : '选择消息'; $('delete-selected').hidden = !selectionMode; if (!selectionMode) selectedMessages.clear(); lastMessages = ''; renderMessages(); });
on('delete-selected', 'click', async () => {
  if (!selectedMessages.size) throw new Error('请先选择要删除的消息。');
  if (confirm(`删除选中的${selectedMessages.size}条消息及关联记忆？此操作不能恢复。`)) { await json(chat.path('/messages/delete'), 'POST', { ids: [...selectedMessages] }); selectedMessages.clear(); await chat.refresh(); changed(); }
});
on('voice-enabled', 'change', () => { setVoiceEnabled($('voice-enabled').checked); notice(voiceEnabled() ? '已开启自动朗读。' : '已关闭自动朗读，仍可手动播放。'); });
$('voice-enabled').checked = voiceEnabled();
on('chat-form', 'submit', async () => {
  const value = $('chat-input').value;
  if (await chat.send(value)) { if ($('chat-input').value === value) { $('chat-input').value = ''; localStorage.removeItem('changli-chat-draft'); } }
});
$('chat-input').value = localStorage.getItem('changli-chat-draft') || '';
$('chat-input').addEventListener('input', () => localStorage.setItem('changli-chat-draft', $('chat-input').value));
$('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('chat-form').requestSubmit(); } });
on('context-check', 'click', async () => {
  if (!chat.sessionId) throw new Error('开始一段对话后可检查长度。');
  const result = await json(chat.path('/context'));
  $('context-label').textContent = `${result.unit === 'characters' ? '本机字符长度' : '上下文长度'} ${result.used} / ${result.limit}${result.blocked ? ' · 已达上限' : result.warning ? ' · 接近上限' : ''}`;
});

function renderMessages() {
  if (selectionSession !== chat.sessionId) { selectedMessages.clear(); selectionSession = chat.sessionId; }
  const signature = JSON.stringify([chat.sessionId, chat.messages]); if (signature === lastMessages) return; lastMessages = signature;
  if (!chat.messages.length) { empty($('messages'), '雪落无声，此间有你', '想聊近况，或把一件小事交给我。'); return; }
  const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 100;
  const nodes = chat.messages.map(message => {
    const article = el('article', undefined, `message ${message.role}`); article.dataset.messageId = message.id;
    const image = el('img', undefined, 'avatar'); image.src = message.role === 'user' ? '/assets/rover-avatar.jpg' : '/assets/changli-avatar.jpg'; image.alt = message.role === 'user' ? '你的头像' : '长离';
    const body = el('div', undefined, 'message-body'), head = el('div', undefined, 'message-meta'), tools = el('div', undefined, 'message-tools');
    head.append(el('span', message.role === 'user' ? '你' : '长离'), el('time', time(message.createdAt)));
    tools.append(button('编辑', () => openEdit('message', message.id, message.content), ''));
    if (message.role === 'user' && message.id === chat.messages.at(-1)?.id) tools.append(button('重试回复', async () => { if (await chat.retry(message.id) && $('chat-input').value === message.content) { $('chat-input').value = ''; localStorage.removeItem('changli-chat-draft'); } }, ''));
    if (selectionMode) { const label = el('label', '选择'); const check = el('input'); check.type = 'checkbox'; check.checked = selectedMessages.has(message.id); check.setAttribute('aria-label', '选择这条消息'); check.addEventListener('change', () => { if (check.checked) selectedMessages.add(message.id); else selectedMessages.delete(message.id); }); label.prepend(check); tools.prepend(label); }
    if (message.role === 'assistant') tools.append(button('播放', () => playMessage(player, message), ''), button('重答', async () => {
      if (confirm('重新生成将覆盖这条回复及后续对话，并清理关联记忆。已发生的电脑操作不会重做。继续吗？')) await chat.send(null, message.id);
    }, ''));
    tools.append(button('删除', async () => { if (confirm('删除这条消息及其关联记忆？此操作不能恢复。')) { await json(chat.path('/messages/delete'), 'POST', { ids: [message.id] }); await chat.refresh(); changed(); } }, ''));
    body.append(head, el('div', message.content, 'bubble'), tools); article.append(image, body); return article;
  });
  $('messages').replaceChildren(...nodes); if (nearBottom || !initialized) $('messages').scrollTop = $('messages').scrollHeight;
}
function renderSessions() {
  if (!chat.state) return;
  if (!chat.state.sessions.length) { empty($('sessions'), '尚无旧事', '点击新建对话，开始此间第一段闲叙。'); return; }
  $('sessions').replaceChildren(...chat.state.sessions.map(session => {
    const node = el('article', undefined, `card${session.id === chat.sessionId ? ' current' : ''}`); const actions = el('div', undefined, 'card-actions');
    node.append(el('h3', `${time(session.createdAt)}${session.id === chat.sessionId ? ' · 当前对话' : ''}`), el('small', '长离的独立会话'));
    actions.append(button('接续这段对话', async () => { await chat.select(session.id); showPage('chat'); }), button('删除', async () => {
      if (confirm('删除整个会话及由它产生的相关记忆？此操作不能恢复。')) { await json(characterPath(`/sessions/${session.id}`), 'DELETE'); await chat.refresh(); changed(); }
    }, 'small-button danger')); node.append(actions); return node;
  }));
}
function renderMemories() {
  if (!chat.state) return;
  $('review-status').textContent = chat.state.review?.due ? '本周整理时间到了，看看哪些点滴还想保留。' : '长离记得的点滴，由你随时整理。';
  if (!chat.state.memories.length) { empty($('memories'), '心事慢慢积攒', '对话中整理出的记忆会保存在这里。'); return; }
  $('memories').replaceChildren(...chat.state.memories.map(memory => {
    const node = el('article', undefined, 'card'), actions = el('div', undefined, 'card-actions');
    node.append(el('p', memory.text), el('small', time(memory.createdAt)));
    actions.append(button('修改', () => openEdit('memory', memory.id, memory.text)), button('删除', async () => { if (confirm('删除这条记忆？')) { await json(characterPath('/memories/delete'), 'POST', { ids: [memory.id] }); await chat.refresh(); changed(); } }, 'small-button danger')); node.append(actions); return node;
  }));
}
on('reviewed', 'click', async () => { await json(characterPath('/review'), 'POST', {}); await chat.refresh(); notice('本周整理已记下。'); });
function renderTasks() {
  if (!chat.state) return;
  $('gui-status').textContent = chat.state.guiConfigured ? '执行中可随时暂停；需要授权时会请你确认。' : '电脑操作模型尚未配置，请先检查模型连接。';
  if (!chat.state.tasks.length) { empty($('tasks'), '暂时无事', '需要帮忙时，在上方说明你的目标。'); return; }
  $('tasks').replaceChildren(...[...chat.state.tasks].reverse().map(task => {
    const node = el('article', undefined, 'card'); node.append(el('h3', `${task.appId} · ${statusLabels[task.status] || task.status}`), el('p', task.instruction));
    if (task.error) node.append(el('p', task.error.message, 'error'));
    if (task.approval) {
      const approval = el('div', undefined, 'approval'); approval.append(el('h3', '请你确认'), el('p', task.approval.description), el('p', task.approval.reason));
      if (task.approval.detail) { const d = el('details'); d.append(el('summary', '操作详情'), el('pre', task.approval.detail)); approval.append(d); }
      const row = el('div', undefined, 'card-actions');
      for (const mode of task.approval.allowAlways ? ['once', 'always'] : ['once']) row.append(button(mode === 'once' ? '仅本次允许' : '始终允许', async () => { await json(characterPath(`/tasks/${task.id}/approve`), 'POST', { approvalId: task.approval.id, mode }); await chat.refresh(); }));
      approval.append(row); node.append(approval);
    }
    const row = el('div', undefined, 'card-actions');
    for (const [action, label] of task.status === 'paused' ? [['resume', '继续'], ['cancel', '结束']] : ['running', 'awaiting_approval'].includes(task.status) ? [['interrupt', '暂停'], ['cancel', '结束']] : []) row.append(button(label, async () => { await json(characterPath(`/tasks/${task.id}/${action}`), 'POST', {}); await chat.refresh(); }));
    const details = el('details'); details.append(el('summary', '查看任务详情'), el('pre', JSON.stringify({ actions: task.actions, observations: task.observations }, null, 2))); node.append(row, details); return node;
  }));
}
on('task-form', 'submit', async () => { await json(characterPath('/tasks'), 'POST', { appId: $('task-app').value.trim(), instruction: $('task-instruction').value.trim() }); await chat.refresh(); changed(); notice('任务已创建，可在此查看状态。'); });

function field(label, node) { const wrapper = el('label', label); wrapper.append(node); return wrapper; }
function input(value = '', type = 'text') { const node = el('input'); node.type = type; node.value = value; return node; }
function toggle(label, value, action) { const node = input('', 'checkbox'); node.checked = value; const row = field(label, node); row.className = 'toggle-row'; node.addEventListener('change', () => void Promise.resolve().then(() => action(node.checked)).catch(report)); return row; }
function renderSettings() {
  if (!chat.state) return; const state = chat.state, root = $('settings-content'); root.replaceChildren();
  document.querySelectorAll('[data-setting]').forEach(node => node.classList.toggle('active', node.dataset.setting === setting));
  if (setting === 'character') {
    const text = el('textarea'); text.rows = 9; text.value = state.characters.find(item => item.id === 'changli')?.instructions || '';
    root.append(el('h3', '角色设定'), el('p', '长离的设定与记忆独立保存。你维护的资料，角色只会读取。'), field('角色表达与相处约定', text), button('保存角色设定', async () => { await json(characterPath(), 'PUT', { instructions: text.value }); await chat.refresh(); notice('长离的设定已保存。'); }, 'ornament-button'));
    const user = input(state.profile?.name || ''), nickname = input(state.profile?.nickname || ''), notes = el('textarea'); notes.rows = 3; notes.value = state.profile?.notes || '';
    root.append(field('你的名字', user), field('希望如何称呼你', nickname), field('希望角色了解的基础资料', notes), button('保存用户资料', async () => { await json('/api/profile', 'PUT', { profile: { ...state.profile, name: user.value.trim(), nickname: nickname.value.trim(), notes: notes.value } }); await chat.refresh(); notice('用户资料已保存。'); }, 'ornament-button'));
  } else if (setting === 'model') {
    root.append(el('h3', '模型连接'), el('p', '手动选择聊天通道，发生故障时保留消息，等待你重试。'));
    const select = el('select'); for (const provider of state.providers || []) { const option = el('option', `${provider.label} · ${provider.model}${provider.configured ? '' : '（未连接）'}`); option.value = provider.id; select.append(option); } select.value = state.provider;
    root.append(field('聊天模型', select), button('切换通道', async () => { await json(characterPath('/provider'), 'POST', { provider: select.value }); await chat.refresh(); changed(); renderSettings(); notice('聊天通道已切换。'); }, 'ornament-button'));
    const current = state.providers?.find(item => item.id === state.provider);
    root.append(el('p', current?.authMode === 'codex-account' ? '当前使用官方Codex的ChatGPT账号授权。账号失效时，请在官方客户端重新登录。' : state.modelConfigured ? '当前通道已提供连接配置。' : '当前通道未连接，请在本机底基目录填写模型配置。'));
    if (state.quotaPaused) root.append(button('已处理额度问题，重新尝试', async () => { await json('/api/model/retry', 'POST', { provider: state.provider }); await chat.refresh(); renderSettings(); }, 'ornament-button'));
    root.append(el('p', 'DeepSeek通道使用直接模型接口，尚不等于已接入DeepSeek Harness框架。'));
  } else if (setting === 'voice') {
    root.append(el('h3', '语音'), toggle('回复生成后自动朗读', voiceEnabled(), value => { setVoiceEnabled(value); $('voice-enabled').checked = value; }), el('p', '关闭后保留文字与手动播放。外部音乐可同时响；程序内的角色语音共用播放通道。'));
    const shortcut = input(state.speech?.recordingShortcut || ''); shortcut.placeholder = '点击这里，按组合键'; shortcut.readOnly = true;
    shortcut.addEventListener('keydown', event => {
      if (event.key === 'Tab') return; event.preventDefault();
      const key = /^(Key[A-Z]|Digit[0-9])$/.test(event.code) ? event.code.replace(/^(Key|Digit)/, '') : /^F(?:[1-9]|1\d|2[0-4])$/.test(event.code) ? event.code : null;
      if (!key || event.metaKey || !(event.ctrlKey || event.altKey || event.shiftKey)) { notice('请用Ctrl、Alt或Shift搭配字母、数字、功能键。'); return; }
      shortcut.value = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
    });
    root.append(field('录音快捷键', shortcut), button('保存快捷键', async () => { await json(characterPath('/recording-shortcut'), 'PUT', { recordingShortcut: shortcut.value || null }); const result = await window.desktop?.setRecordingShortcut(shortcut.value || null); await chat.refresh(); notice(result?.registered === false ? '设置已保存，但组合键被占用，请换一个快捷键。' : '录音快捷键已保存。'); }), button('清除', async () => { await json(characterPath('/recording-shortcut'), 'PUT', { recordingShortcut: null }); await window.desktop?.setRecordingShortcut(null); await chat.refresh(); renderSettings(); }));
    root.append(el('p', '点一下开始录音，再点结束。识别结果可修改，只有点击发送才进入会话。'), button('停止当前语音', () => player.stop()));
  } else if (setting === 'display') {
    const wallpaper = shellStatus?.wallpaperSettings || {};
    root.append(el('h3', '角色与壁纸显示'), el('p', '选择场景与按钮风格。桌宠、壁纸和聊天共享长离的会话及语音。'), appearanceSwitch());
    root.append(toggle('显示桌宠', shellStatus?.petVisible ?? preference('pet-visible', 'true') !== 'false', async value => { setPreference('pet-visible', String(value)); if (value) await window.desktop?.showPet(); else await window.desktop?.hidePet(); }));
    const pet = shellStatus?.petSettings || {scale:1,opacity:1};
    const size = input(String(Math.round(pet.scale*100)), 'range'), transparency = input(String(Math.round((1-pet.opacity)*100)), 'range');
    size.id='pet-size';size.min='50';size.max='200';size.step='5';
    transparency.id='pet-transparency';transparency.min='0';transparency.max='80';transparency.step='5';
    size.value=String(Math.round(pet.scale*100));transparency.value=String(Math.round((1-pet.opacity)*100));
    const sizeValue=el('output',`${size.value}%`),transparencyValue=el('output',`${transparency.value}%`);
    sizeValue.setAttribute('for',size.id);transparencyValue.setAttribute('for',transparency.id);
    const sizeRow=field('桌宠大小',size),transparencyRow=field('桌宠透明度',transparency);
    sizeRow.className=transparencyRow.className='pet-display-control';
    sizeRow.append(sizeValue);transparencyRow.append(transparencyValue);
    size.addEventListener('input',()=>{sizeValue.textContent=`${size.value}%`;void petSetting({scale:Number(size.value)/100}).catch(report);});
    transparency.addEventListener('input',()=>{transparencyValue.textContent=`${transparency.value}%`;void petSetting({opacity:Math.round(100-Number(transparency.value))/100}).catch(report);});
    root.append(sizeRow,transparencyRow,el('p','滑动即生效并自动保存。透明度0%为不透明；文字和按钮保持清晰。'),button('恢复桌宠默认显示',async()=>{await petSetting({scale:1,opacity:1});size.value='100';transparency.value='0';sizeValue.textContent='100%';transparencyValue.textContent='0%';}));
    root.append(toggle('使用长离动态壁纸', shellStatus?.wallpaperEnabled ?? preference('wallpaper-enabled', 'true') !== 'false', async value => { const result = await window.desktop?.setWallpaperEnabled(value); if (result?.wallpaperStatus === 'failed') throw new Error('壁纸加载失败，请检查后重试。'); setPreference('wallpaper-enabled', String(value)); }));
    if (shellStatus?.wallpaperStatus === 'failed') root.append(button('重试加载壁纸', () => window.desktop?.setWallpaperEnabled(true), 'ornament-button'));
    root.append(toggle('壁纸眼睛轻微跟随鼠标', wallpaper.follow ?? preference('wallpaper-follow', 'true') !== 'false', value => wallpaperSetting('follow', value)));
    root.append(toggle('播放壁纸原片声音', wallpaper.videoSound ?? preference('wallpaper-videoSound', 'false') === 'true', value => wallpaperSetting('videoSound', value)));
    root.append(toggle('暂停壁纸画面', wallpaper.paused ?? preference('wallpaper-paused', 'false') === 'true', value => wallpaperSetting('paused', value)));
    const volume = input(String(wallpaper.volume ?? preference('wallpaper-volume', '0.8')), 'range'); volume.min = '0'; volume.max = '1'; volume.step = '.05'; volume.addEventListener('change', () => void wallpaperSetting('volume', Number(volume.value)).catch(report)); root.append(field('点触台词音量', volume));
    applyScene();
  } else if (setting === 'notifications') {
    root.append(el('h3', '通知'), el('p', '任务完成后会显示带“查看”入口的通知。需要你授权或处理问题时，会打开对应确认页。'), el('p', '主动关心先显示10秒邀请，你可以接听或拒绝；无人回应时安静消失。接听台词进入当前会话，是否出声遵循自动朗读设置。'));
  } else {
    const local=state.localApps,qq=local?.apps?.find(app=>app.id==='qqmusic');
    root.append(el('h3', '电脑权限'),el('h4','打开本地软件'),el('p',local?.configured?'软件启动已连接，不需要电脑操作模型。当前支持按明确请求打开QQ音乐。':'软件启动尚未连接，请检查本机底基服务。'));
    root.append(toggle('允许按我的明确请求打开软件',local?.enabled??true,async enabled=>{await json(characterPath('/app-launch-permission'),'PUT',{enabled});await chat.refresh();renderSettings();}));
    root.append(el('p',qq?.available?'QQ音乐：已检测到本机程序。支持“幫我打開QQ音樂”“长离，帮我打开QQ音乐”等说法。':'QQ音乐：暂未检测到可启动的本机程序。'));
    const tryOpen=button('测试打开QQ音乐',async()=>{if(await chat.send('帮我打开QQ音乐'))showPage('chat');},'ornament-button');
    tryOpen.disabled=!local?.configured||!local.enabled||!qq?.available||Boolean(chat.controller);root.append(tryOpen);
    root.append(el('h4','其他电脑操作'),el('p', state.guiConfigured ? '电脑操作模型已配置。点击、输入和多步任务仍经过动作权限检查，敏感操作会请求授权。' : '电脑操作模型尚未配置，暂时不能代替你点击界面、输入或执行多步任务。打开QQ音乐可独立使用。'),el('h4','已保存的任务授权'), el('p', '暂停或结束任务不会删除聊天记录。意外退出后的任务需由你决定是否继续。'));
    for (const grant of state.grants || []) { const node = el('div', undefined, 'card'); node.append(el('p', `${grant.appId} · ${grant.capability}`), button('撤销这项授权', async () => { await json(characterPath(`/grants/${grant.id}`), 'DELETE'); await chat.refresh(); renderSettings(); })); root.append(node); }
    if (!state.grants?.length) root.append(el('p', '暂无已保存的任务授权；任务遇到需授权的动作时才会请求，并按你的选择在这里列出。'));
  }
}
async function wallpaperSetting(key, value) { const actual = await window.desktop?.setWallpaperSettings?.({ [key]: value }); if (shellStatus && actual) shellStatus.wallpaperSettings = actual; setPreference(`wallpaper-${key}`, String(value)); const channel = new BroadcastChannel('changli-preferences'); channel.postMessage({ type: 'wallpaper-settings', [key]: value }); channel.close(); }
async function petSetting(value) { if(!window.desktop?.setPetSettings)throw new Error('请重新打开桌面程序后调节桌宠显示。');const actual=await window.desktop.setPetSettings(value);if(shellStatus)shellStatus.petSettings=actual; }
function openEdit(kind, id, content) {
  if (chat.controller) throw new Error('请先停止当前回复，再修改历史。');
  edit = { kind, id, sessionId: chat.sessionId }; $('edit-title').textContent = kind === 'message' ? '修改这段对话' : '修改记忆';
  $('edit-warning').textContent = kind === 'message' ? '保存会覆盖此条及后续对话，并清理受影响的记忆。已经发生的电脑操作不会撤销。' : '只修改长离的这条记忆，不改写你的源资料。';
  $('edit-content').value = content; $('edit-error').textContent = ''; $('edit-dialog').showModal(); $('edit-content').focus();
}
on('cancel-edit', 'click', () => $('edit-dialog').close());
on('edit-form', 'submit', async () => {
  try { if (edit.kind === 'message' && edit.sessionId !== chat.sessionId) throw new Error('当前会话已改变，请重新打开编辑。');
    await json(edit.kind === 'message' ? chat.path(`/messages/${edit.id}`) : characterPath(`/memories/${edit.id}`), 'PATCH', edit.kind === 'message' ? { content: $('edit-content').value } : { text: $('edit-content').value });
    $('edit-dialog').close(); await chat.refresh(); changed(); notice('修改已保存。');
  } catch (error) { $('edit-error').textContent = error.message; }
});

on('record', 'click', () => recorder.toggle());
recorder.addEventListener('state', event => { const state = event.detail; if (state === 'starting') player.stop(); $('record').classList.toggle('recording', state === 'recording'); $('record-status').textContent = { idle: '', starting: '正在打开麦克风…', recording: '录音中，再点结束', processing: '正在识别，文字可修改后发送…' }[state]; });
recorder.addEventListener('text', event => { $('chat-input').value += `${$('chat-input').value ? '\n' : ''}${event.detail}`; localStorage.setItem('changli-chat-draft', $('chat-input').value); $('chat-input').focus(); notice('已识别为文字，请检查后手动发送。'); });
chat.addEventListener('busy', event => { wasBusy = event.detail; $('stop').hidden = !wasBusy; $('send').disabled = wasBusy; $('stream-message').hidden = !wasBusy; $('stream-content').textContent = '长离正在思量…'; $('stream-state').textContent = '正在回复'; });
chat.addEventListener('delta', event => { $('stream-content').textContent = event.detail; $('stream-message').scrollTop = $('stream-message').scrollHeight; });
chat.addEventListener('refresh', async event => {
  const state = event.detail; $('connection-dot').classList.add('connected'); $('connection-label').textContent = state.modelConfigured ? '长离在此' : '模型待连接';
  $('send').disabled = Boolean(chat.controller) || ((!state.modelConfigured || state.quotaPaused) && !state.localApps?.configured);
  renderMessages(); if (page === 'sessions') renderSessions(); if (page === 'memories') renderMemories(); if (page === 'tasks') renderTasks();
  if (state.speech?.recordingShortcut !== knownShortcut) { knownShortcut = state.speech?.recordingShortcut; await window.desktop?.setRecordingShortcut(knownShortcut || null); }
  if (!initialized) { initialized = true; notice(startupNotice || '已连接，接续上次对话。'); }
});
changes.addEventListener('message', event => { if (event.data?.type === 'appearance') applyScene(); else void chat.refresh().catch(report); });
window.addEventListener('storage', event => { if (event.key === 'changli-speech-enabled') $('voice-enabled').checked = voiceEnabled(); });
bindShell(event => {
    if (event.type === 'navigate') { if (event.page === 'settings') setting = event.section || 'character'; showPage(event.page || 'chat'); }
  else if(event.type==='window-state')updateWindowControls(event);
  else if (event.type === 'settings-section') { setting = event.section || 'character'; showPage('settings'); }
  else if (event.type === 'record-toggle' && !document.hidden) return recorder.toggle();
  else if (event.type === 'audio-toggle') { setVoiceEnabled(typeof event.enabled === 'boolean' ? event.enabled : !voiceEnabled()); $('voice-enabled').checked = voiceEnabled(); }
  else if (event.type === 'shell-state') { shellStatus = event; if (event.wallpaperStatus === 'failed') notice(event.message || '壁纸模块加载失败，可在显示设置中重试。聊天可继续。'); }
  else if (event.type === 'pet-settings') { if(shellStatus)shellStatus.petSettings=event.settings; }
  else if (event.type === 'shortcut-error') notice(event.message || '录音快捷键被占用，请重新选择。');
  else if (event.type === 'task-pause') return chat.refresh().then(async () => { const task = chat.state?.tasks.find(item => ['running', 'awaiting_approval'].includes(item.status)); if (task) await json(characterPath(`/tasks/${task.id}/interrupt`), 'POST', {}); await chat.refresh(); });
});
document.body.classList.add('home-mode'); applyScene();
void window.desktop?.setVoiceEnabled?.(voiceEnabled());
void window.desktop?.getState().then(state => {
  shellStatus = state;
  updateWindowControls(state.window);
  if (state.recovery && !state.recovery.clean && !state.recovery.ok) startupNotice = '上次退出后未能确认任务状态，请查看任务后手动处理。';
  else if (state.recovery && !state.recovery.clean && state.recovery.paused > 0) startupNotice = '上次程序意外退出，任务已中断并暂停，请到任务页决定是否继续。';
  if (startupNotice) notice(startupNotice);
}).catch(report);
void chat.refresh().catch(error => { $('connection-dot').classList.remove('connected'); $('connection-label').textContent = '连接待恢复'; report(error); });
poll = setInterval(() => { if (!document.hidden) void chat.refresh().catch(error => { $('connection-dot').classList.remove('connected'); $('connection-label').textContent = '连接待恢复'; report(error); }); }, 2500);
window.addEventListener('pagehide', () => clearInterval(poll));

const click = new Audio('/assets/click.wav'); click.volume = .16;
document.addEventListener('click', event => { if (event.target.closest('button') && preference('click-sound', 'true') !== 'false') { click.currentTime = 0; click.play().catch(() => {}); } });
