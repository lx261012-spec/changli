import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('管理台不使用可执行HTML插值、内联脚本或内联事件处理器', () => {
  assert.doesNotMatch(script, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|eval)\b|document\.write\s*\(|new\s+Function\s*\(/);
  assert.doesNotMatch(html, /\son\w+\s*=|\sstyle\s*=|javascript:/i);
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(match[1], /\bsrc="\/app\.js"/);
    assert.equal(match[2].trim(), '');
  }
});

test('管理台不向持久localStorage写令牌，也不向控制台记录凭据', () => {
  assert.doesNotMatch(script, /\bconsole\s*\./);
  assert.doesNotMatch(script, /\blocalStorage[^\n]*(?:\btoken\b|\bstorageKey\b)/);
  for (const call of script.matchAll(/\blocalStorage\.(?:getItem|setItem|removeItem)\(\s*([^,\n)]+)/g)) {
    assert.equal(call[1], "'changli-speech-enabled'", '持久存储只允许语音播放偏好');
  }
  assert.match(script, /localStorage\.setItem\('changli-speech-enabled', String\(\$\('speech-enabled'\)\.checked\)\)/);
  assert.doesNotMatch(html, /<input[^>]+(?:name|id)="(?:api[-_]?key|secret)"/i);
});
