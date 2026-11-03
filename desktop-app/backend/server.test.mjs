import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { startDesktopServer } from '../server.mjs';

function raw(url, path, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request({ hostname: target.hostname, port: target.port, path, method, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(body);
  });
}

test('desktop origin preserves API auth, streaming and local assets without exposing token', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'changli-desktop-test-'));
  const token = 'a'.repeat(64); let lastRequest, disconnected = false;
  const api = createServer((req, res) => {
    if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, speechBridge: 1 })); return; }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      lastRequest = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      if (req.url === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: text\ndata: "第一字"\n\n');
        res.on('close', () => { disconnected = true; }); return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url.startsWith('/api/state') ? { characters: [{ id: 'changli' }] } : { ok: true }));
    });
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const backendURL = `http://127.0.0.1:${api.address().port}`;
  for (const name of ['renderer', 'assets', 'wallpaper', 'foundation/public']) mkdirSync(join(temp, name), { recursive: true });
  writeFileSync(join(temp, 'renderer/index.html'), '<!doctype html><title>长离</title>');
  writeFileSync(join(temp, 'renderer/pet.html'), '<!doctype html><title>桌宠</title>');
  writeFileSync(join(temp, 'assets/movie.mp4'), '0123456789');
  writeFileSync(join(temp, 'wallpaper/preview.html'), '<title>壁纸</title>');
  writeFileSync(join(temp, 'foundation/public/speech-player.js'), 'export class SpeechPlayer {}');
  let transcriptionInput;
  const transcriber = { status: () => ({ available: true, offline: true }), close() {}, async transcribe(buffer, ext) { transcriptionInput = { buffer, ext }; return { text: '可修改的识别文字', duration: 1, offline: true }; } };
  const app = await startDesktopServer({ port: 0, backendURL, backendToken: token, backendRoot: join(temp, 'foundation'), ensureBackend: false,
    rendererDir: join(temp, 'renderer'), assetsDir: join(temp, 'assets'), wallpaperDir: join(temp, 'wallpaper'), transcriber, maxAudioBytes: 32 });
  t.after(async () => { await app.close(); api.closeAllConnections(); await new Promise(done => api.close(done)); rmSync(temp, { recursive: true, force: true }); });

  await t.test('serves main, pet, wallpaper and shared player with no credential', async () => {
    for (const path of ['/', '/pet.html', '/wallpaper/', '/speech-player.js']) {
      const response = await fetch(app.url + path); assert.equal(response.status, 200); assert.ok(!(await response.text()).includes(token));
    }
    const health = await fetch(app.url + '/desktop/health').then(r => r.json());
    assert.equal(health.backend.connected, true); assert.equal(health.transcription.offline, true);
  });
  await t.test('injects server credential, rewrites origin and keeps request body/query', async () => {
    const response = await fetch(app.url + '/api/change?q=1', { method: 'PUT', headers: { Authorization: 'Bearer attacker', 'Content-Type': 'application/json', Origin: app.url }, body: '{"choice":"keep"}' });
    assert.equal(response.status, 200); assert.equal(lastRequest.headers.authorization, `Bearer ${token}`);
    assert.equal(lastRequest.headers.origin, backendURL); assert.equal(lastRequest.url, '/api/change?q=1');
    assert.equal(lastRequest.body, '{"choice":"keep"}');
    const result = await app.requestBackend('/api/change', { method: 'POST', body: { from: 'main' } });
    assert.equal(result.ok, true); assert.equal(lastRequest.body, '{"from":"main"}');
  });
  await t.test('rejects other origins, same-site ports and forged host', async () => {
    assert.equal((await raw(app.url, '/', { Host: 'evil.test' })).status, 403);
    assert.equal((await raw(app.url, '/api/state', { Origin: 'https://evil.test' })).status, 403);
    assert.equal((await raw(app.url, '/api/state', { Origin: 'http://127.0.0.1:1' })).status, 403);
    assert.equal((await raw(app.url, '/api/state', { 'Sec-Fetch-Site': 'same-site' })).status, 403);
  });
  await t.test('rejects traversal, hidden source and malformed escaped paths', async () => {
    for (const path of ['/assets/%2e%2e/server.mjs', '/assets/..%5Cserver.mjs', '/assets/%00.png', '/assets/%zz']) assert.equal((await raw(app.url, path)).status, 400);
    assert.equal((await raw(app.url, '/assets/.env')).status, 404);
    assert.equal((await raw(app.url, '/server.mjs')).status, 404);
  });
  await t.test('supports video ranges, suffixes, HEAD and rejects invalid ranges', async () => {
    const ranged = await raw(app.url, '/assets/movie.mp4', { Range: 'bytes=2-5' });
    assert.equal(ranged.status, 206); assert.equal(ranged.body, '2345'); assert.equal(ranged.headers['content-range'], 'bytes 2-5/10');
    assert.equal((await raw(app.url, '/assets/movie.mp4', { Range: 'bytes=-3' })).body, '789');
    const head = await raw(app.url, '/assets/movie.mp4', {}, 'HEAD'); assert.equal(head.headers['content-length'], '10'); assert.equal(head.body, '');
    for (const range of ['bytes=10-', 'bytes=6-2', 'bytes=1-2,4-5', 'bytes=-0']) assert.equal((await raw(app.url, '/assets/movie.mp4', { Range: range })).status, 416);
  });
  await t.test('microphone upload is local, bounded and produces editable text only', async () => {
    const result = await fetch(app.url + '/desktop/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/webm;codecs=opus' }, body: 'recording' }).then(r => r.json());
    assert.equal(result.text, '可修改的识别文字'); assert.equal(transcriptionInput.ext, 'webm'); assert.equal(transcriptionInput.buffer.toString(), 'recording');
    assert.equal((await fetch(app.url + '/desktop/transcribe', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'invalid' })).status, 415);
    assert.equal((await fetch(app.url + '/desktop/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: '' })).status, 422);
    assert.equal((await fetch(app.url + '/desktop/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: 'x'.repeat(33) })).status, 413);
  });
  await t.test('SSE emits before completion and cancellation reaches backend', async () => {
    const controller = new AbortController();
    const response = await fetch(app.url + '/api/stream', { signal: controller.signal });
    const chunk = await response.body.getReader().read();
    assert.match(new TextDecoder().decode(chunk.value), /第一字/); controller.abort();
    for (let i = 0; i < 30 && !disconnected; i++) await new Promise(done => setTimeout(done, 10));
    assert.equal(disconnected, true);
  });
});
