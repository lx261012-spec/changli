import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('默认GPT与DeepSeek/Gemini通道分别配置，拒绝明文公网地址和URL内凭据', () => {
  const config = loadConfig({ OPENAI_API_KEY: 'openai-test', DEEPSEEK_API_KEY: 'deepseek-test', GEMINI_API_KEY: 'gemini-test' });
  assert.equal(config.model, 'gpt-6.1-sol'); assert.equal(config.providers.deepseek.model, 'deepseek-flash');
  assert.equal(config.defaultProvider, 'openai');
  assert.equal(loadConfig({ OPENAI_AUTH_MODE: 'codex-account' }).providers.openai.authMode, 'codex-account');
  assert.throws(() => loadConfig({ OPENAI_AUTH_MODE: 'unknown' }), /OPENAI_AUTH_MODE/);
  assert.equal(config.providers.openai.apiKey, 'openai-test'); assert.equal(config.providers.deepseek.apiKey, 'deepseek-test');
  assert.equal(config.providers.gemini.apiKey, 'gemini-test'); assert.equal(config.providers.gemini.model, 'gemini-3.8-flash');
  assert.equal(loadConfig({ GEMINI_MODEL: 'other-model', GEMINI_CONTEXT_LIMIT: '10000' }).providers.gemini.contextLimit, 10000);
  assert.throws(() => loadConfig({ GEMINI_CONTEXT_LIMIT: 'nope' }), /GEMINI_CONTEXT_LIMIT/);
  for (const name of ['OPENAI_BASE_URL', 'DEEPSEEK_BASE_URL', 'GEMINI_BASE_URL', 'GUI_BASE_URL']) {
    assert.throws(() => loadConfig({ [name]: 'http://public.example/v1' }), /HTTPS/);
    assert.throws(() => loadConfig({ [name]: 'https://key@example.com' }), /凭据/);
    assert.doesNotThrow(() => loadConfig({ [name]: 'http://127.0.0.1:8000/v1' }));
  }
});
