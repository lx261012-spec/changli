import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { loadConfig, enableConfiguredProxy } from './config.mjs';
import { ModelClient, ModelError } from './model.mjs';
import { DeepSeekClient } from './deepseek.mjs';
import { GeminiClient } from './gemini.mjs';
import { CodexAccountClient } from './codex-account.mjs';
import { Store } from './store.mjs';
import { Foundation } from './service.mjs';
import { TaskManager } from './tasks.mjs';
import { createUITarsOperator } from './ui-tars.mjs';
import { SpeechEngine } from './speech.mjs';
import { SoftwareCareService } from './software-observer.mjs';
import { careLines, careEntryLines, readCareAudio } from './care-audio.mjs';
import { openQQMusic, qqMusicAvailable } from './local-apps.mjs';


const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const staticFiles = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/speech-player.js', ['speech-player.js', 'text/javascript; charset=utf-8']], ['/care-panel.js', ['care-panel.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);

export function accessToken(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'access-token');
  try {
    const token = readFileSync(path, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('本机访问令牌文件损坏，请检查 data/access-token');
    return token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('hex');
    writeFileSync(path, token, { mode: 0o600, flag: 'wx' });
    return token;
  }
}

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ModelError('请求必须使用 JSON', 'invalid_content_type', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256_000) throw new ModelError('请求内容过大', 'body_too_large', 413);
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ModelError('JSON 格式无效', 'invalid_json', 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ModelError('请求需为 JSON 对象', 'invalid_json', 400);
  return data;
}

export function createApp({ config = loadConfig(), store = new Store(config.dataDir, { defaultProvider: config.defaultProvider }), model = config.providers?.openai?.authMode === 'codex-account' ? new CodexAccountClient(config.account) : new ModelClient(config.providers?.openai || config), models, tasks, speech = new SpeechEngine(config.speech), token = accessToken(config.dataDir), openLocalApp = config.localApps ? openQQMusic : null } = {}) {
  tasks ||= new TaskManager({ dataDir: config.dataDir, operatorFactory: () => createUITarsOperator(config.gui) });
  models ||= { openai: model, deepseek: new DeepSeekClient(config.providers?.deepseek || { ...config, apiKey: '', model: 'deepseek-flash' }), gemini: new GeminiClient(config.providers?.gemini) };
  const service = new Foundation({ store, model, models, tasks, config, openLocalApp });
  const care = config.proactiveCare ? new SoftwareCareService({ store, dataDir: config.dataDir }) : null;
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const port = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) throw new ModelError('仅允许本机访问', 'invalid_host', 403);
      const origin = req.headers.origin;
      if (origin && !allowedHosts.some(host => origin === `http://${host}`)) throw new ModelError('拒绝跨站请求', 'invalid_origin', 403);
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type }); res.end(readFileSync(join(publicDir, file))); return;
      }
      if (req.method === 'GET' && url.pathname === '/health') { json({ ok: true, version: '1.0.0', speechBridge: 1 }); return; }
      const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new ModelError('需要本机访问令牌', 'unauthorized', 401);
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const id = url.searchParams.get('character') || 'changli';
        store.getCharacter(id);
        const provider = store.getProvider(id);
        const providers = await Promise.all(Object.entries(models).map(async ([providerId, client]) => ({ id: providerId, label: config.providers?.[providerId]?.label || { openai: 'OpenAI', deepseek: 'DeepSeek', gemini: 'Gemini' }[providerId] || providerId, model: client.config?.model || config.model, authMode: config.providers?.[providerId]?.authMode || 'api-key', configured: client.configured ? await client.configured() : Boolean(client.config?.apiKey || (providerId === 'openai' && config.apiKey)) })));
        const speechStatus = { ...speech.status(id), recordingShortcut: store.getRecordingShortcut(id) };
        const localApps={configured:Boolean(openLocalApp),enabled:store.getAppLaunchEnabled(id),apps:openLocalApp?[{id:'qqmusic',name:'QQ音乐',available:openLocalApp===openQQMusic?qqMusicAvailable():true}]:[]};
        json({ activeSessionId: store.getActiveSession(id), characters: store.characters(), profile: store.getProfile(), sessions: store.listSessions(id), memories: store.listMemories(id), review: store.reviewStatus(id), tasks: tasks.list(id), grants: tasks.grants(id), localApps, provider, providers, model: providers.find(item => item.id === provider)?.model, modelConfigured: providers.find(item => item.id === provider)?.configured, guiConfigured: Boolean(config.gui?.model && config.gui?.apiKey && config.gui?.baseURL), quotaPaused: service.isPaused(id), startupSuggestion: '想聊聊近况，还是需要我帮你处理电脑上的一件事？', speechConnected: speechStatus.ready, speech: speechStatus }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/model/retry') { const data = await body(req); service.retryProvider(data.provider); json({ resumed: true }); return; }
      if (req.method === 'PUT' && url.pathname === '/api/profile') {
        const data = await body(req);
        await service.mutateProfile(() => store.setProfile(data.profile, { actor: 'user' })); json(store.getProfile()); return;
      }
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts[0] !== 'api' || parts[1] !== 'characters' || !parts[2]) throw new ModelError('接口不存在', 'not_found', 404);
      const id = parts[2]; store.getCharacter(id);
      const route = parts.slice(3).join('/');
      if (route === 'active-session' && req.method === 'PUT') { const data = await body(req); json(store.setActiveSession(id, data.sessionId)); return; }
      if (route === 'app-launch-permission' && req.method === 'PUT') { const data = await body(req); json(store.setAppLaunchEnabled(id,data.enabled,{actor:'user'})); return; }
      if (route === 'care' && req.method === 'GET') { json(id === 'changli' && care ? care.snapshot() : { observer: 'not_configured', rounds: {} }); return; }
      if (parts[3] === 'care' && parts[4] === 'audio' && parts.length === 6 && req.method === 'GET') {
        if (id !== 'changli') throw new ModelError('此角色未配置主动关心录音', 'care_unconfigured', 409);
        const message = store.getCareMessage(id, parts[5]);
        const line = message.appId.endsWith('_entry') ? careEntryLines[message.appId.slice(0, -6)] : careLines[message.appId];
        if (!line || message.content !== line.text) throw new ModelError('消息已修改，请使用普通语音试读', 'care_audio_changed', 409);
        const audio = readCareAudio(config.careAudioDir, line);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length }); res.end(audio); return;
      }
      if (route.startsWith('care/') && req.method === 'POST') {
        if (id !== 'changli' || !care) throw new ModelError('当前角色未配置软件主动关心', 'care_unconfigured', 409);
        const data = await body(req);
        const owner = data.consumerId ?? null;
        if (owner !== null && (typeof owner !== 'string' || !/^[a-f0-9-]{36}$/i.test(owner))) throw new ModelError('显示窗口标识无效', 'invalid_consumer', 400);
        if (route === 'care/present') json(care.engine.present(data.invitationId, owner));
        else if (route === 'care/respond') json(await service.serial(id, () => {
          const invitation = care.engine.locate(data.invitationId).invitation;
          const line = (invitation.kind === 'entry' ? careEntryLines : careLines)[invitation.appId];
          if (data.choice === 'accept' && !line) throw new ModelError('对应台词尚未配置', 'care_line_unavailable', 503);
          return care.engine.respond(data.invitationId, data.choice, { owner, sessionId: data.sessionId, line });
        }));
        else throw new ModelError('接口不存在', 'not_found', 404);
        return;
      }
      if (route === 'speech' && req.method === 'POST') {
        const data = await body(req);
        const controller = new AbortController();
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', disconnected);
        try {
          const result = await speech.synthesize(id, data.text, controller.signal);
          if (res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': result.audio.length, 'X-Audio-Seconds': String(result.seconds), 'X-Synthesis-Ms': String(result.generationMs), 'X-Model-Load-Ms': String(result.loadMs) });
          res.end(result.audio);
        } finally { res.off('close', disconnected); }
        return;
      }
      if (route === 'recording-shortcut' && req.method === 'PUT') { const data = await body(req); json(store.setRecordingShortcut(id, data.recordingShortcut, { actor: 'user' })); return; }
      if (route === 'provider' && req.method === 'POST') { const data = await body(req); json(await service.mutate(id, () => store.setProvider(id, data.provider, { actor: 'user' }))); return; }
      if (!route && req.method === 'PUT') { const data = await body(req); json(await service.mutate(id, () => store.updateCharacter(id, { instructions: data.instructions }, { actor: 'user' }))); return; }
      if (route === 'interrupt' && req.method === 'POST') { json(service.interrupt(id)); return; }
      if (route === 'review' && req.method === 'POST') { store.markReviewed(id); json(store.reviewStatus(id)); return; }
      if (route === 'memories' && req.method === 'POST') { const data = await body(req); json(store.addMemory(id, data.text, data.sourceMessageIds, { actor: 'user' }), 201); return; }
      if (route === 'memories/delete' && req.method === 'POST') { const data = await body(req); await service.mutate(id, () => store.deleteMemories(id, data.ids)); json({ deleted: true }); return; }
      if (parts[3] === 'memories' && parts.length === 5 && req.method === 'PATCH') { const data = await body(req); json(await service.mutate(id, () => store.updateMemory(id, parts[4], data.text))); return; }
      if (route === 'sessions' && req.method === 'POST') { json(store.createSession(id), 201); return; }
      if (route === 'tasks' && req.method === 'POST') {
        const data = await body(req);
        json(await service.mutate(id, () => tasks.start({ characterId: id, appId: data.appId, instruction: data.instruction })), 202); return;
      }
      if (parts[3] === 'tasks' && parts[4]) {
        const taskId = parts[4], action = parts[5];
        if (req.method === 'GET' && !action) { json(tasks.get(id, taskId)); return; }
        if (req.method === 'POST') {
          if (action === 'interrupt') { json(tasks.interrupt(id, taskId)); return; }
          if (action === 'resume') { json(tasks.resume(id, taskId)); return; }
          if (action === 'cancel') { json(tasks.cancel(id, taskId)); return; }
          if (action === 'approve') { const data = await body(req); json(tasks.approve(id, taskId, data.approvalId, data.mode)); return; }
        }
      }
      if (parts[3] === 'grants' && parts.length === 5 && req.method === 'DELETE') { tasks.revokeGrant(id, parts[4]); json({ revoked: true }); return; }
      if (parts[3] !== 'sessions' || !parts[4]) throw new ModelError('接口不存在', 'not_found', 404);
      const sessionId = parts[4]; store.getSession(id, sessionId);
      const action = parts.slice(5).join('/');
      if (!action && req.method === 'GET') { json({ ...store.getSession(id, sessionId), messages: store.messages(id, sessionId) }); return; }
      if (!action && req.method === 'DELETE') { await service.mutate(id, () => store.deleteSession(id, sessionId)); json({ deleted: true }); return; }
      if (action === 'context' && req.method === 'GET') { const context = await service.context(id, sessionId); json({ used: context.used, unit: context.unit, limit: context.limit, warning: context.warning, blocked: context.blocked }); return; }
      if (action === 'messages/delete' && req.method === 'POST') { const data = await body(req); await service.mutate(id, () => store.deleteMessages(id, sessionId, data.ids)); json({ deleted: true }); return; }
      if (parts[5] === 'messages' && parts.length === 7 && req.method === 'PATCH') {
        const data = await body(req); json(await service.mutate(id, () => store.editMessage(id, sessionId, parts[6], data.content))); return;
      }
      if (['messages', 'regenerate', 'retry'].includes(action) && req.method === 'POST') {
        const data = await body(req);
        if (action === 'retry' && (typeof data.messageId !== 'string' || !data.messageId)) throw new ModelError('请指定需要重试的用户消息。', 'invalid_retry', 400);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('client_disconnected')); });
        const emit = async (event, value) => {
          if (res.destroyed) return;
          if (!res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
        };
        try { await service.chat(id, sessionId, data.content, emit, controller.signal, { regenerateId: action === 'regenerate' ? data.messageId : undefined, retryId: action === 'retry' ? data.messageId : undefined }); }
        catch (error) { await emit('error', { code: error.code || 'internal_error', message: error.code ? error.message : '处理失败，未自动重试' }); }
        res.end(); return;
      }
      throw new ModelError('接口不存在', 'not_found', 404);
    } catch (error) {
      const status = error.status || ({ not_found: 404, invalid_input: 400, invalid_state: 409, desktop_busy: 409, opaque_action: 403 }[error.code]) || (error instanceof URIError ? 400 : 500);
      if (!res.headersSent) json({ error: { code: error.code || 'internal_error', message: error.code ? error.message : '请求处理失败' } }, status);
      else res.end();
    }
  });
  server.once('listening', () => care?.start());
  return { server, store, service, token, tasks, speech, care, async close() {
    care?.stop();
    speech.stop();
    for (const character of store.characters()) { service.bump(character.id); service.interrupt(character.id); }
    await Promise.allSettled([...service.locks.values()]);
    await tasks.close?.();
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    store.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  enableConfiguredProxy();
  const config = loadConfig(process.env, root);
  const app = createApp({ config });
  app.server.listen(config.port, config.host, () => {
    const port = app.server.address().port;
    console.log(`底基1.0 已启动：http://127.0.0.1:${port}`);
    console.log(`访问令牌文件：${join(config.dataDir, 'access-token')}（启动器会自动带入）`);
    const defaultModel = config.providers[config.defaultProvider];
    console.log(`默认聊天：${defaultModel.model}；API ${defaultModel.apiKey ? '已配置，待实际验证' : '未配置'}；本地语音按需加载`);
  });
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { app.close().then(() => process.exit(0)).catch(() => process.exit(1)); });
}
