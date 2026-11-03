import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../.test-data/', import.meta.url));
export function tempDir(t) {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'test-'));
  if (t) t.after(() => removeTempDir(directory));
  return directory;
}
export function removeTempDir(directory) {
  if (!resolve(directory).startsWith(resolve(root) + sep)) throw new Error('测试目录超出范围');
  rmSync(directory, { recursive: true, force: true });
}
export const config = { apiKey: 'test-key', baseURL: 'https://api.example.test/v1', model: 'gpt-6.1-sol', contextLimit: 1_050_000, maxOutputTokens: 4096, timeoutMs: 5000, gui: {}, host: '127.0.0.1', port: 0 };
