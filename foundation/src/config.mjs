import { resolve } from 'node:path';
import { setGlobalProxyFromEnv } from 'node:http';

export function enableConfiguredProxy(env = process.env) {
  if (env.NODE_USE_ENV_PROXY === '1') return setGlobalProxyFromEnv(env);
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const number = (name, fallback, min, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 数值无效`);
    return value;
  };
  const validateURL = value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('模型地址必须为 HTTPS 或本机 HTTP');
    if (url.username || url.password || url.search || url.hash) throw new Error('模型地址不能包含凭据或查询参数');
    return value.replace(/\/$/, '');
  };
  const baseURL = validateURL(env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
  const deepseekURL = validateURL(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com');
  const geminiURL = validateURL(env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta');
  const guiURL = env.GUI_BASE_URL ? validateURL(env.GUI_BASE_URL) : '';
  const voiceRoot = env.CHANGLI_VOICE_ROOT || 'D:/GPT/背景项目/长离语音包';
  const runtime = resolve(voiceRoot, 'GPT-SoVITS试听');
  const openaiAuth = env.OPENAI_AUTH_MODE || 'api-key';
  if (!['api-key', 'codex-account'].includes(openaiAuth)) throw new Error('OPENAI_AUTH_MODE仅支持api-key或codex-account');
  return {
    host: '127.0.0.1',
    proactiveCare: true,
    localApps: true,
    careAudioDir: resolve(voiceRoot, '软件主动关心/第一轮试听_2026-10-28'),
    port: number('PORT', 4317, 0, 65535),
    dataDir: resolve(cwd, env.FOUNDATION_DATA_DIR || 'data'),
    defaultProvider: 'openai',
    account: { executable: env.CODEX_EXECUTABLE || 'codex.exe', cwd: resolve(cwd, env.FOUNDATION_DATA_DIR || 'data', 'account-chat-empty'), model: 'gpt-6.1-sol', timeoutMs: number('MODEL_TIMEOUT_MS', 120000, 1000, 600000) },
    speech: {
      runtime, python: resolve(runtime, 'python-env/Scripts/python.exe'),
      s1: resolve(voiceRoot, '专属权重/2026-10-24_首轮v2/权重/changli-v2-pure1-s1-e1.ckpt'),
      s2: resolve(voiceRoot, '专属权重/2026-10-24_首轮v2/权重/changli-v2-pure1-s2-e1.pth'),
      reference: resolve(voiceRoot, '令人满意的生成/此间当下.wav'),
      cache: resolve(cwd, env.FOUNDATION_DATA_DIR || 'data', 'speech'),
    },
    apiKey: env.OPENAI_API_KEY || '',
    baseURL: baseURL.replace(/\/$/, ''),
    model: 'gpt-6.1-sol',
    contextLimit: 1_050_000,
    maxOutputTokens: 4096,
    timeoutMs: number('MODEL_TIMEOUT_MS', 120000, 1000, 600000),
    providers: {
      openai: { label: openaiAuth === 'codex-account' ? 'GPT（ChatGPT账号）' : 'OpenAI', authMode: openaiAuth, model: 'gpt-6.1-sol', apiKey: env.OPENAI_API_KEY || '', baseURL: baseURL.replace(/\/$/, ''), contextLimit: 1_050_000, maxOutputTokens: 4096, timeoutMs: number('MODEL_TIMEOUT_MS', 120000, 1000, 600000) },
      deepseek: { label: 'DeepSeek', model: env.DEEPSEEK_MODEL || 'deepseek-flash', apiKey: env.DEEPSEEK_API_KEY || '', baseURL: deepseekURL, contextLimit: 1_000_000, maxOutputTokens: 4096, timeoutMs: number('MODEL_TIMEOUT_MS', 120000, 1000, 600000) },
      gemini: { label: 'Gemini', model: env.GEMINI_MODEL || 'gemini-3.8-flash', apiKey: env.GEMINI_API_KEY || '', baseURL: geminiURL, contextLimit: number('GEMINI_CONTEXT_LIMIT', 1_048_576, 8192, 10_000_000), maxOutputTokens: 4096, timeoutMs: number('MODEL_TIMEOUT_MS', 120000, 1000, 600000) },
    },
    gui: {
      baseURL: guiURL,
      apiKey: env.GUI_API_KEY || '',
      model: env.GUI_MODEL || '',
      uiTarsVersion: env.GUI_MODEL_VERSION || '1.5',
      maxLoopCount: number('GUI_MAX_STEPS', 25, 1, 100),
    },
  };
}
