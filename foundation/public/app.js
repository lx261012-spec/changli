import { SpeechPlayer } from './speech-player.js';
import { CarePanel } from './care-panel.js';
const $ = id => document.getElementById(id);
const storageKey = 'foundation-local-token';
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token') || sessionStorage.getItem(storageKey) || '';
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
if (token) sessionStorage.setItem(storageKey, token);

let characterId = 'changli';
let sessionId = null;
let state;
let messages = [];
let controller;
let streamDone = Promise.resolve();
let savedReply = false;
let edit;
let polling = false;
let taskSnapshot = '';
const suggested = new Set();
const audioChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('foundation-role-audio') : null;
const speech = new SpeechPlayer({ request: (...args) => api(...args), audio: $('speech-audio'), channel: audioChannel, locks: navigator.locks, status: text => { $('speech-status').textContent = text; } });
function voiceEnabled() { return characterId === 'changli' && $('speech-enabled').checked; }
function playMessage(message) { return message.careAppId ? speech.recording(characterId, message.id) : speech.speak(characterId, message.content); }
const carePanel = new CarePanel({
  root: $('care-panel'), json, character: () => characterId, session: () => sessionId,
  busy: () => Boolean(controller || $('edit-dialog').open || $('chat-input').value.trim()),
  voiceEnabled, play: playMessage,
  delivered: async (delivery, context) => {
    if (characterId !== context.characterId || sessionId !== context.sessionId) return false;
    sessionId = delivery.sessionId; await refresh();
    return characterId === context.characterId && sessionId === delivery.sessionId;
  },
});
window.addEventListener('pagehide', () => { speech.stop(false); audioChannel?.close(); });

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}
function announce(message) { $('notice').textContent = message; }
function showError(error) { ($('edit-dialog').open ? $('edit-error') : $('error')).textContent = error.message || '操作失败，请检查本机服务。'; }
function guarded(action) {
  return async event => {
    event?.preventDefault(); $('error').textContent = '';
    try { await action(event); } catch (error) { if (error.name !== 'AbortError') showError(error); }
  };
}
function on(id, event, action) { $(id).addEventListener(event, guarded(action)); }
function button(label, action, className) {
  const node = element('button', label, className);
  node.type = 'button'; node.addEventListener('click', guarded(action));
  return node;
}
function path(suffix = '') { return `/api/characters/${encodeURIComponent(characterId)}${suffix}`; }
function sessionPath(suffix = '') { return path(`/sessions/${encodeURIComponent(sessionId)}${suffix}`); }
async function api(url, method = 'GET', data, signal) {
  const response = await fetch(url, {
    method, signal, headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error?.message || `本机服务返回 ${response.status}`);
  }
  return response;
}
async function json(url, method, data) { return (await api(url, method, data)).json(); }
function time(value) { return new Date(value).toLocaleString('zh-CN'); }
function selected(container) { return [...$(container).querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value); }
function selection(value, label) {
  const container = element('label', undefined, 'selection');
  const input = document.createElement('input'); input.type = 'checkbox'; input.value = value;
  container.append(input, document.createTextNode(label));
  return container;
}
function renderStatus() {
  const accountMode = state.providers?.find(provider => provider.id === state.provider)?.authMode === 'codex-account';
  const modelStatus = state.modelConfigured ? accountMode ? 'ChatGPT账号已登录，使用账号额度；完整回复后显示文字' : '模型配置已提供，真实响应待验证' : accountMode ? '请先在官方Codex客户端登录ChatGPT账号' : '当前通道未配置，聊天暂不可用';
  $('capabilities').textContent = `当前聊天：${state.provider || 'openai'} / ${state.model} · ${modelStatus} · ${state.speechConnected ? '长离语音模型已加载' : state.speech?.configured ? '长离语音已配置，首次使用自动加载' : '当前角色未配置音色'}${state.quotaPaused ? ' · 额度耗尽，当前通道已暂停' : ''}`;
  $('speech-enabled').disabled = characterId !== 'changli';
  $('speech-test-button').disabled = !state.speech?.configured;
  $('gui-status').textContent = state.guiConfigured ? '电脑操作配置已提供；实际软件兼容性需要验证。' : '电脑操作模型未配置，尚不能执行真实桌面任务。';
  $('retry-model').hidden = !state.quotaPaused;
  $('send').disabled = Boolean(controller) || !sessionId || !state.modelConfigured || state.quotaPaused;
  $('check-context').disabled = !sessionId || !state.modelConfigured;
  $('delete-session').disabled = !sessionId;
  $('delete-messages').disabled = !sessionId;
  $('review-status').textContent = state.review.due ? '本周整理提醒：请查看记录与记忆，自行决定删减。' : `下次整理提醒：${time(state.review.nextReviewAt)}`;
  if (!suggested.has(characterId)) {
    $('startup-suggestion').textContent = `开始使用建议：${state.startupSuggestion}`;
    suggested.add(characterId);
  }
}
function renderProviders() {
  if (state.providers) {
    $('provider').replaceChildren(...state.providers.map(provider => {
      const modelName = provider.id === 'deepseek' && provider.model === 'deepseek-flash' ? 'DeepSeek-V4.1-Flash · deepseek-flash' : provider.model;
      const option = element('option', `${provider.label} · ${modelName}${provider.configured ? '' : '（未配置）'}`);
      option.value = provider.id; return option;
    }));
  }
  $('provider').value = state.provider || 'openai';
}
function renderSessions() {
  $('session').replaceChildren();
  if (!state.sessions.length) {
    const option = element('option', '尚无会话，请新建'); option.value = ''; $('session').append(option);
  }
  for (const session of state.sessions) {
    const option = element('option', `${time(session.createdAt)} · ${session.id.slice(0, 8)}`);
    option.value = session.id; $('session').append(option);
  }
  $('session').value = sessionId || '';
}
function openEdit(kind, id, content) {
  edit = { kind, id, characterId, sessionId };
  $('edit-error').textContent = '';
  $('edit-title').textContent = kind === 'message' ? '编辑历史消息' : '修改自动记忆';
  $('edit-warning').textContent = kind === 'message' ? '保存后将覆盖这条消息，删除其后全部对话，并清理受影响的自动记忆。旧分支不保留；已发生的电脑操作不能撤销。' : '仅修改当前角色的这条记忆，不会改写你的用户源资料。';
  $('save-edit').textContent = kind === 'message' ? '覆盖后续并保存' : '保存记忆';
  $('edit-content').value = content; $('edit-dialog').showModal(); $('edit-content').focus();
}
function renderMessages() {
  const nodes = messages.map(message => {
    const article = element('article', undefined, `message ${message.role}`);
    const head = element('div', undefined, 'message-head');
    head.append(element('strong', message.role === 'user' ? '你' : state.characters.find(character => character.id === characterId)?.name || '角色'), element('small', time(message.createdAt)), selection(message.id, '选择这条消息'));
    const controls = element('div', undefined, 'row');
    controls.append(button('编辑', () => openEdit('message', message.id, message.content)));
    if (message.role === 'assistant' && (message.careAppId || state.speech?.configured)) controls.append(button('播放 / 重试语音', () => playMessage(message)));
    if (message.role === 'assistant') controls.append(button('重新生成', async () => {
      if (!confirm('重新生成会删除这条回复及其后全部对话和相关记忆，再生成新回复；不会重做电脑操作。继续吗？')) return;
      await streamChat('/regenerate', { messageId: message.id });
    }));
    article.append(head, element('p', message.content, 'message-content'), controls);
    return article;
  });
  $('messages').replaceChildren(...(nodes.length ? nodes : [element('p', sessionId ? '这段会话还没有消息。' : '先新建或选择会话。', 'hint')]));
}
function renderMemories() {
  $('memories').replaceChildren(...(state.memories.length ? state.memories.map(memory => {
    const article = element('article', undefined, 'memory');
    article.append(selection(memory.id, '选择这条记忆'), element('p', memory.text, 'memory-content'), element('small', `${time(memory.createdAt)} · 关联 ${memory.sourceMessageIds.length} 条源消息`), button('编辑', () => openEdit('memory', memory.id, memory.text)));
    return article;
  }) : [element('p', '当前角色暂无自动记忆。', 'hint')]));
}
const statuses = { running: '执行中', awaiting_approval: '等待确认', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消' };
function renderTasks() {
  const snapshot = JSON.stringify([characterId, state.tasks, state.grants]);
  if (snapshot === taskSnapshot) return;
  taskSnapshot = snapshot;
  $('tasks').replaceChildren(...(state.tasks.length ? [...state.tasks].reverse().map(task => {
    const article = element('article', undefined, 'task');
    article.append(element('h3', `${task.appId} · ${statuses[task.status] || task.status}`), element('p', task.instruction), element('small', `更新于 ${time(task.updatedAt)}`));
    if (task.error) article.append(element('p', `${task.error.message}（${task.error.code}）`));
    if (task.approval) {
      const approval = element('div', undefined, 'approval');
      approval.append(element('h3', '操作需要你确认'), element('p', task.approval.description), element('p', task.approval.reason));
      if (task.approval.detail) approval.append(element('pre', task.approval.detail));
      const controls = element('div', undefined, 'row');
      for (const mode of task.approval.allowAlways ? ['once', 'always'] : ['once']) {
        controls.append(button(mode === 'once' ? '仅本次允许' : '始终允许', async () => {
          await json(path(`/tasks/${task.id}/approve`), 'POST', { approvalId: task.approval.id, mode }); await refresh();
        }));
      }
      if (!task.approval.allowAlways) approval.append(element('p', '此类原始操作只能逐次确认。', 'hint'));
      approval.append(controls); article.append(approval);
    }
    const controls = element('div', undefined, 'row');
    const actions = task.status === 'paused' ? [['resume', '恢复任务'], ['cancel', '取消任务']] : ['running', 'awaiting_approval'].includes(task.status) ? [['interrupt', '暂停任务'], ['cancel', '取消任务']] : [];
    for (const [action, label] of actions) controls.append(button(label, async () => { await json(path(`/tasks/${task.id}/${action}`), 'POST', {}); await refresh(); }));
    const details = document.createElement('details');
    details.append(element('summary', '操作与观察记录'), element('pre', JSON.stringify({ actions: task.actions, observations: task.observations }, null, 2)));
    article.append(controls, details); return article;
  }) : [element('p', '当前角色暂无电脑任务。', 'hint')]));
  $('grants').replaceChildren(...(state.grants.length ? state.grants.map(grant => {
    const row = element('div', undefined, 'grant');
    row.append(element('span', `${grant.appId} · ${grant.capability} `), button('撤销授权', async () => { await json(path(`/grants/${grant.id}`), 'DELETE'); await refresh(); }, 'danger'));
    return row;
  }) : [element('p', '尚无持久授权。', 'hint')]));
}
function showLocalLength() {
  const length = messages.reduce((total, message) => total + message.content.length, 0);
  $('context-status').textContent = `当前 ${messages.length} 条消息，${length} 个文字字符。模型上下文长度${state.modelConfigured ? '可点击检查' : '在配置模型后读取'}。`;
  $('context-meter').hidden = true;
}
function renderContext(context) {
  const label = context.unit === 'characters' ? '本机字符保护长度（不是模型 token 上限）' : '模型上下文长度（服务端计数）';
  $('context-status').textContent = `${label}：${context.used} / ${context.limit}${context.blocked ? ' · 已达到上限，请删减或新开会话' : context.warning ? ' · 已接近上限，请准备整理' : ''}`;
  $('context-meter').hidden = false; $('context-meter').max = Math.max(1, context.limit); $('context-meter').value = context.used;
}
async function loadMessages() {
  const id = characterId; const session = sessionId;
  const result = session ? (await json(sessionPath())).messages : [];
  if (id !== characterId || session !== sessionId) return;
  messages = result;
  renderMessages(); showLocalLength();
}
async function refresh() {
  const id = characterId;
  const result = await json(`/api/state?character=${encodeURIComponent(id)}`);
  if (id !== characterId) return;
  state = result;
  if (!state.sessions.some(session => session.id === sessionId)) sessionId = state.activeSessionId || state.sessions[0]?.id || null;
  renderSessions(); renderProviders(); renderStatus(); renderMemories(); renderTasks();
  $('instructions').value = state.characters.find(character => character.id === characterId).instructions;
  $('profile').value = JSON.stringify(state.profile, null, 2);
  $('recording-shortcut').value = state.speech?.recordingShortcut || '';
  $('recording-shortcut-status').textContent = state.speech?.recordingShortcut ? `已保存：${state.speech.recordingShortcut}（录音触发待接入）` : '尚未设置录音快捷键。';
  await loadMessages();
  void carePanel.poll();
}
async function connect() {
  await refresh();
  $('connection').hidden = true; $('workspace').hidden = false; $('disconnect').hidden = false;
  $('token').value = ''; announce('已连接本机服务。');
}
async function stopChat() {
  speech.stop();
  const active = controller;
  const done = streamDone;
  if (active) active.abort();
  try { await json(path('/interrupt'), 'POST', {}); }
  finally { if (active) await done; }
  if (state) renderStatus();
}
function streamEvent(name, data) {
  if (name === 'delta') $('stream').textContent += data.text;
  else if (name === 'saved') { savedReply = true; if (voiceEnabled()) void speech.speak(characterId, data.message.content); }
  else if (name === 'context') renderContext(data);
  else if (name === 'latency') $('latency').textContent = `文字首响应 ${(data.firstTextMs / 1000).toFixed(2)} 秒 · ${data.achieved ? '达到 6 秒文字起始目标' : '超过 6 秒文字起始目标'}；语音同步尚未验证。`;
  else if (name === 'warning') announce(data.message);
  else if (name === 'error') throw new Error(data.message || '模型调用失败。');
  else if (name === 'interrupted') announce(data.message);
  else if (name === 'memory' && data.added) announce(`已自动整理 ${data.added} 条当前角色记忆，可在记忆区管理。`);
}
function parseEvent(block) {
  let event = 'message'; const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length) streamEvent(event, JSON.parse(data.join('\n')));
}
async function streamChat(suffix, data) {
  if (controller) throw new Error('已有回复正在生成，请先停止。');
  if (!sessionId) throw new Error('请先新建会话。');
  if (!state.modelConfigured) throw new Error('聊天模型尚未配置，请按说明填写本机 .env。');
  speech.stop();
  const active = new AbortController(); controller = active;
  let finishStream;
  streamDone = new Promise(resolve => { finishStream = resolve; });
  savedReply = false;
  const id = characterId; const session = sessionId;
  $('stream').textContent = ''; $('stream-title').textContent = '正在回复'; $('latency').textContent = '等待文字首响应…'; $('stream-panel').hidden = false; $('chat-state').textContent = '正在生成'; renderStatus();
  try {
    const response = await api(sessionPath(suffix), 'POST', data, active.signal);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop();
        for (const block of blocks) parseEvent(block);
        if (done) { if (buffer.trim()) parseEvent(buffer); break; }
      }
    } finally { reader.releaseLock(); }
    if (suffix === '/messages') $('chat-input').value = '';
  } catch (error) {
    if (active.signal.aborted) announce('已停止回复。已完成的内容保留，未完成内容不写入历史。');
    else throw error;
  } finally {
    if (controller === active) controller = undefined;
    try {
      if (id === characterId && session === sessionId) {
        $('chat-state').textContent = ''; await refresh();
        if (savedReply || !$('stream').textContent) $('stream-panel').hidden = true;
        else $('stream-title').textContent = '未完成内容（未保存到历史）';
      }
    } finally { finishStream(); }
  }
}

on('token-form', 'submit', async () => { token = $('token').value.trim(); sessionStorage.setItem(storageKey, token); await connect(); });
on('stop-speech', 'click', () => speech.stop());
on('speech-enabled', 'change', () => {
  if (!$('speech-enabled').checked) speech.stop();
  try {
    localStorage.setItem('changli-speech-enabled', String($('speech-enabled').checked));
    sessionStorage.removeItem('changli-speech-enabled');
    announce($('speech-enabled').checked ? '已开启回复生成后自动播放语音。' : '已关闭自动播放，可在回复下方手动播放语音。');
  } catch { announce('语音设置已在本页生效；浏览器未允许保存，重新打开后需再次设置。'); }
});
window.addEventListener('storage', event => {
  if (event.key !== 'changli-speech-enabled') return;
  $('speech-enabled').checked = event.newValue !== 'false';
  if (!$('speech-enabled').checked) speech.stop();
});
on('speech-test-form', 'submit', () => speech.speak(characterId, $('speech-text').value));
try { $('speech-enabled').checked = (localStorage.getItem('changli-speech-enabled') ?? sessionStorage.getItem('changli-speech-enabled')) !== 'false'; }
catch { $('speech-enabled').checked = true; }
on('disconnect', 'click', async () => {
  speech.stop(); if (controller) await stopChat(); token = ''; sessionStorage.removeItem(storageKey);
  $('workspace').hidden = true; $('connection').hidden = false; $('disconnect').hidden = true; announce('已退出本机连接。');
});
on('refresh', 'click', refresh);
$('recording-shortcut').addEventListener('keydown', event => {
  if (event.key === 'Tab') return;
  event.preventDefault();
  if (event.repeat || event.isComposing) return;
  const key = /^(?:Key[A-Z]|Digit[0-9])$/.test(event.code) ? event.code.replace(/^(?:Key|Digit)/, '') : /^F(?:[1-9]|1\d|2[0-4])$/.test(event.code) ? event.code : null;
  if (!key || event.metaKey || !(event.ctrlKey || event.altKey || event.shiftKey)) {
    $('recording-shortcut-status').textContent = '请按 Ctrl、Alt 或 Shift 搭配字母、数字或功能键。'; return;
  }
  $('recording-shortcut').value = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
  $('recording-shortcut-status').textContent = '组合键已选，请点击保存。';
});
async function saveRecordingShortcut(shortcut) {
  const id = characterId;
  const result = await json(path('/recording-shortcut'), 'PUT', { recordingShortcut: shortcut });
  if (id !== characterId) return;
  state.speech.recordingShortcut = result.recordingShortcut;
  $('recording-shortcut').value = result.recordingShortcut || '';
  $('recording-shortcut-status').textContent = result.recordingShortcut ? `已保存：${result.recordingShortcut}（录音触发待接入）` : '已清除录音快捷键。';
}
on('recording-shortcut-form', 'submit', () => {
  if (!$('recording-shortcut').value) throw new Error('请先点击录音快捷键输入框，按下要使用的组合键。');
  return saveRecordingShortcut($('recording-shortcut').value);
});
on('clear-recording-shortcut', 'click', () => saveRecordingShortcut(null));
on('provider-form', 'submit', async () => {
  const provider = $('provider').value;
  await stopChat(); await json(path('/provider'), 'POST', { provider }); await refresh();
  announce(`已切换到 ${provider}。历史和当前角色记忆继续保留；不会自动切换其他通道。`);
});
on('character', 'change', async () => { await stopChat(); characterId = $('character').value; sessionId = null; $('stream-panel').hidden = true; await refresh(); });
on('session', 'change', async () => { await stopChat(); sessionId = $('session').value || null; if (sessionId) await json(path('/active-session'), 'PUT', { sessionId }); $('stream-panel').hidden = true; await loadMessages(); renderStatus(); });
on('new-session', 'click', async () => { await stopChat(); sessionId = (await json(path('/sessions'), 'POST', {})).id; await refresh(); });
on('delete-session', 'click', async () => { if (!sessionId || !confirm('删除整个会话和由其消息产生的相关记忆？此操作不能恢复。')) return; await stopChat(); await json(sessionPath(), 'DELETE'); sessionId = null; await refresh(); });
on('chat-form', 'submit', () => streamChat('/messages', { content: $('chat-input').value }));
on('stop', 'click', async () => { await stopChat(); announce('已发出打断请求；电脑任务保留进度，等待你决定恢复或取消。'); await refresh(); });
on('check-context', 'click', async () => renderContext(await json(sessionPath('/context'))));
on('character-form', 'submit', async () => { await stopChat(); await json(path(), 'PUT', { instructions: $('instructions').value }); announce('已保存当前角色设定。'); await refresh(); });
on('profile-form', 'submit', async () => { let profile; try { profile = JSON.parse($('profile').value); } catch { throw new Error('用户资料 JSON 格式无效，请检查引号与逗号。'); } await json('/api/profile', 'PUT', { profile }); announce('已保存共享用户资料；角色只能读取。'); await refresh(); });
on('delete-messages', 'click', async () => { const ids = selected('messages'); if (!ids.length) throw new Error('请先勾选消息。'); if (!confirm(`删除选中的 ${ids.length} 条消息及依赖记忆？不能恢复。`)) return; await stopChat(); await json(sessionPath('/messages/delete'), 'POST', { ids }); await refresh(); });
on('delete-memories', 'click', async () => { const ids = selected('memories'); if (!ids.length) throw new Error('请先勾选记忆。'); if (!confirm(`删除选中的 ${ids.length} 条记忆？`)) return; await json(path('/memories/delete'), 'POST', { ids }); await refresh(); });
on('reviewed', 'click', async () => { await json(path('/review'), 'POST', {}); await refresh(); announce('本次整理已确认，七天后再次提醒。'); });
on('retry-model', 'click', async () => { await json('/api/model/retry', 'POST', { provider: state.provider || 'openai' }); await refresh(); announce('已恢复当前通道调用；下一次请求将检验额度状态。'); });
on('task-form', 'submit', async () => { await json(path('/tasks'), 'POST', { appId: $('app-id').value.trim(), instruction: $('task-instruction').value }); await refresh(); announce('任务已创建，请查看进度或确认请求。'); });
on('cancel-edit', 'click', () => $('edit-dialog').close());
on('edit-form', 'submit', async () => {
  if (edit.characterId !== characterId || edit.sessionId !== sessionId) throw new Error('当前会话已改变，请重新打开编辑。');
  const content = $('edit-content').value;
  if (!content.trim()) throw new Error('修改后的内容不能为空。');
  if (edit.kind === 'message') { await stopChat(); await json(sessionPath(`/messages/${edit.id}`), 'PATCH', { content }); }
  else await json(path(`/memories/${edit.id}`), 'PATCH', { text: content });
  $('edit-dialog').close(); await refresh(); announce('已保存修改，受影响的旧记忆已按来源清理。');
});

setInterval(async () => {
  if (!token || $('workspace').hidden || polling || document.hidden) return;
  polling = true; const id = characterId;
  try {
    const result = await json(`/api/state?character=${encodeURIComponent(id)}`);
    if (id === characterId) {
      state = result; renderStatus(); renderTasks();
      if (!controller) {
        if (!sessionId && state.activeSessionId) { sessionId = state.activeSessionId; renderSessions(); }
        if (sessionId) {
          const session = sessionId;
          const fresh = (await json(sessionPath())).messages;
          if (id === characterId && session === sessionId && !controller && JSON.stringify(fresh) !== JSON.stringify(messages)) { messages = fresh; renderMessages(); showLocalLength(); }
        }
      }
      await carePanel.poll();
    }
  } catch (error) { showError(error); }
  finally { polling = false; }
}, 2500);

setInterval(() => carePanel.tick(), 100);

if (token) guarded(connect)();
