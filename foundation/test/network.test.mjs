import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { enableConfiguredProxy } from '../src/config.mjs';

test('保存后动态启用代理，远端请求走代理而本机服务按NO_PROXY直连', async () => {
  assert.equal(enableConfiguredProxy({}), undefined);
  const requests = [];
  const proxy = createServer((req, res) => { requests.push(req.url); res.end('via-proxy'); });
  proxy.on('connect', (req, socket) => {
    requests.push(req.url);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nvia-proxy'));
  });
  const local = createServer((_, res) => res.end('local-service'));
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  let restore;
  try {
    restore = enableConfiguredProxy({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: '127.0.0.1,localhost' });
    assert.equal(await (await fetch('http://unreachable.example.test/probe', { signal: AbortSignal.timeout(5000) })).text(), 'via-proxy');
    assert.equal(await (await fetch(`http://127.0.0.1:${local.address().port}/health`, { signal: AbortSignal.timeout(5000) })).text(), 'local-service');
    assert.equal(requests.length, 1); assert.match(requests[0], /unreachable\.example\.test/);
  } finally {
    restore?.();
    proxy.closeAllConnections(); local.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => local.close(resolve))]);
  }
});
