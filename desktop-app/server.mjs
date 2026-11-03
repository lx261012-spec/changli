import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream, realpathSync } from 'node:fs';
import { resolve, dirname, join, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { once } from 'node:events';
import { LocalTranscriber, minimalEnvironment } from './backend/transcribe.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const workspace = dirname(root);
const installedFoundation = 'D:/GPT/背景项目通用功能/智能底基/底基1.0';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2' };

function problem(message, code = 'invalid_request', status = 400) { return Object.assign(new Error(message), { code, status }); }
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function localURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw problem('底基必须使用本机HTTP地址。', 'invalid_backend');
  return url.origin;
}
function readJSON(url, headers = {}) {
  return new Promise((resolveResult, reject) => {
    const req = httpRequest(url, { headers, timeout: 1200 }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (text.length > 2_000_000) req.destroy(); });
      res.on('end', () => { try { resolveResult({ status: res.statusCode, value: JSON.parse(text) }); } catch { reject(new Error('invalid_backend')); } });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end();
  });
}

async function requestBackend(backend, path, { method = 'GET', body } = {}) {
  if (!path.startsWith('/api/') || path.includes('\\') || path.includes('\0') || !backend.token) throw problem('底基请求无效。', 'backend_unavailable', 503);
  return new Promise((resolveResult, reject) => {
    const encoded = body === undefined ? null : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${backend.token}`, Origin: backend.backendURL };
    if (encoded !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(encoded); }
    const req = httpRequest(new URL(path, backend.backendURL), { method, headers, timeout: 10_000 }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (text.length > 4_000_000) req.destroy(); });
      res.on('end', () => {
        try {
          const value = JSON.parse(text);
          if (res.statusCode >= 400) reject(problem(value.error?.message || '底基请求失败。', value.error?.code || 'backend_error', res.statusCode));
          else resolveResult(value);
        } catch { reject(problem('底基返回无效。', 'backend_error', 502)); }
      }); res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', () => reject(problem('底基连接失败。', 'backend_unavailable', 503)));
    req.end(encoded);
  });
}

export async function connectFoundation(options = {}) {
  const foundationRoot = resolve(options.backendRoot || (existsSync(join(installedFoundation, '.env')) ? installedFoundation : join(workspace, 'foundation')));
  const values = existsSync(join(foundationRoot, '.env')) ? parseEnv(readFileSync(join(foundationRoot, '.env'), 'utf8')) : {};
  const backendURL = localURL(options.backendURL || `http://127.0.0.1:${values.PORT || 4317}`);
  const tokenPath = join(resolve(foundationRoot, values.FOUNDATION_DATA_DIR || 'data'), 'access-token');
  let token = options.backendToken;
  const getToken = () => {
    if (token) return token;
    try { const value = readFileSync(tokenPath, 'utf8').trim(); if (/^[a-f0-9]{64}$/i.test(value)) token = value; } catch { /* Created by foundation on first launch. */ }
    return token;
  };
  const probe = async () => {
    try {
      const health = await readJSON(backendURL + '/health');
      if (!health.value.ok || health.value.speechBridge !== 1 || !getToken()) return false;
      const state = await readJSON(backendURL + '/api/state?character=changli', { Authorization: `Bearer ${getToken()}` });
      return state.status === 200 && Array.isArray(state.value.characters);
    } catch { return false; }
  };
  let child;
  if (!await probe() && options.ensureBackend !== false && !options.backendURL) {
    const runtime = [join(foundationRoot, 'runtime/node.exe'), process.execPath].find(path => existsSync(path));
    if (runtime && existsSync(join(foundationRoot, 'src/server.mjs'))) {
      child = spawn(runtime, [join(foundationRoot, 'src/server.mjs')], {
        cwd: foundationRoot, windowsHide: true, stdio: 'ignore', detached: false,
        env: { ...minimalEnvironment(), ELECTRON_RUN_AS_NODE: '1' },
      });
      child.on('error', () => {});
      for (let i = 0; i < 25 && child.exitCode === null; i++) {
        await new Promise(done => setTimeout(done, 200));
        if (await probe()) break;
      }
    }
  }
  return { backendURL, get token() { return getToken(); }, probe, child, foundationRoot };
}

function safeFile(directory, relative) {
  if (!relative || relative.includes('\0') || relative.includes('\\') || relative.split('/').some(part => part === '..' || part.startsWith('.'))) return null;
  const base = resolve(directory), path = resolve(base, relative);
  if (!path.startsWith(base + sep)) return null;
  try {
    const realBase = realpathSync(base), real = realpathSync(path);
    if (!real.startsWith(realBase + sep) || !statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}

function serveFile(req, res, path) {
  const { size } = statSync(path);
  const headers = { 'Content-Type': types[extname(path).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); res.end(); return; }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size || size === 0) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); res.end(); return; }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy()); res.once('close', () => stream.destroy()); stream.pipe(res);
}

function proxyAPI(req, res, backend, rawPath) {
  if (!backend.token) { json(res, { error: { code: 'backend_unavailable', message: '底基尚未连接，请检查本机服务后重试。' } }, 503); return; }
  const upstream = new URL(rawPath, backend.backendURL);
  const headers = { Authorization: `Bearer ${backend.token}`, Origin: backend.backendURL };
  for (const name of ['content-type', 'accept', 'content-length', 'range']) if (req.headers[name]) headers[name] = req.headers[name];
  const request = httpRequest(upstream, { method: req.method, headers, timeout: 600_000 }, response => {
    const outgoing = {};
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'x-accel-buffering']) if (response.headers[name]) outgoing[name] = response.headers[name];
    res.writeHead(response.statusCode, outgoing);
    response.on('error', () => res.destroy()); response.pipe(res);
  });
  request.on('timeout', () => request.destroy());
  request.on('error', () => { if (!res.headersSent) json(res, { error: { code: 'backend_unavailable', message: '底基连接中断，内容仍保留，可手动重试。' } }, 503); else res.end(); });
  req.once('aborted', () => request.destroy());
  res.once('close', () => { if (!res.writableEnded) request.destroy(); });
  req.pipe(request);
}

async function audioBody(req, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (declared > maxBytes) throw problem('录音文件过大，请缩短到两分钟以内。', 'body_too_large', 413);
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > maxBytes) throw problem('录音文件过大。', 'body_too_large', 413); chunks.push(chunk); }
  if (bytes === 0) throw problem('录音为空，请重新录制。', 'audio_empty', 422);
  return Buffer.concat(chunks);
}

export async function startDesktopServer(options = {}) {
  const backend = await connectFoundation(options);
  const transcriber = options.transcriber || new LocalTranscriber(options.transcription);
  const rendererDir = options.rendererDir || join(root, 'renderer');
  const assetsDir = options.assetsDir || join(root, 'assets');
  const wallpaperDir = options.wallpaperDir || join(root, 'wallpaper');
  const sharedPlayer = join(backend.foundationRoot, 'public/speech-player.js');
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const port = server.address().port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host)) throw problem('仅允许本机访问。', 'invalid_host', 403);
      if (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) throw problem('拒绝跨站请求。', 'invalid_origin', 403);
      if (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site'])) throw problem('拒绝跨站请求。', 'invalid_origin', 403);
      const rawPath = req.url.split('?')[0];
      const path = decodeURIComponent(rawPath);
      if (path.includes('\\') || path.includes('\0') || path.split('/').some(value => value === '..')) throw problem('路径无效。', 'invalid_path');
      if (path === '/desktop/health' && req.method === 'GET') {
        json(res, { ok: true, version: '1.0.0', backend: { connected: await backend.probe() }, transcription: transcriber.status() }); return;
      }
      if (path === '/desktop/transcribe' && req.method === 'POST') {
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const extension = { 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a' }[type];
        if (!extension) throw problem('录音格式不受支持。', 'unsupported_audio', 415);
        const buffer = await audioBody(req, options.maxAudioBytes || 16 * 1024 * 1024);
        const controller = new AbortController();
        res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        json(res, await transcriber.transcribe(buffer, extension, controller.signal)); return;
      }
      if (path.startsWith('/api/')) { proxyAPI(req, res, backend, req.url); return; }
      if (!['GET', 'HEAD'].includes(req.method)) throw problem('方法不支持。', 'method_not_allowed', 405);
      let file;
      if (path === '/speech-player.js') file = existsSync(sharedPlayer) ? sharedPlayer : null;
      else if (path.startsWith('/assets/')) file = safeFile(assetsDir, path.slice(8));
      else if (path.startsWith('/wallpaper/')) file = safeFile(wallpaperDir, path.slice(11) || 'preview.html');
      else if (path === '/wallpaper') { res.writeHead(302, { Location: '/wallpaper/' }); res.end(); return; }
      else file = safeFile(rendererDir, path === '/' ? 'index.html' : path.slice(1));
      if (!file) throw problem('文件不存在。', 'not_found', 404);
      serveFile(req, res, file);
    } catch (error) {
      if (!res.headersSent) json(res, { error: { code: error.code || 'request_failed', message: error.code ? error.message : '请求处理失败，请重试。' } }, error.status || (error instanceof URIError ? 400 : 500));
      else res.end();
    }
  });
  // A stable local origin preserves the user's voice and visual preferences across launches.
  server.listen(options.port ?? 4341, '127.0.0.1');
  try { await once(server, 'listening'); }
  catch (error) { transcriber.close(); backend.child?.kill(); throw error; }
  let closed = false;
  return { url: `http://127.0.0.1:${server.address().port}`, backendURL: backend.backendURL, server,
    requestBackend: (path, options) => requestBackend(backend, path, options),
    async close() { if (closed) return; closed = true; transcriber.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); backend.child?.kill(); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startDesktopServer({ port: 4341 });
  console.log(`长离桌面服务：${app.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().finally(() => process.exit()));
}
