import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDesktopServer } from '../server.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/29436/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const host = await startDesktopServer({ port: 0, ensureBackend: false });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const states = [];
try {
  await page.goto(host.url); await page.waitForTimeout(1900);
  for (let i = 0; i < 3; i++) {
    if (i) { await page.locator('#enter').click(); await page.locator('#back-home').click(); await page.waitForTimeout(1900); }
    states.push(await page.locator('#home-title').evaluate(img => ({ iteration: window.__iteration = (window.__iteration || 0) + 1, hidden: img.hidden, complete: img.complete, naturalWidth: img.naturalWidth, image: { opacity: getComputedStyle(img).opacity, rect: img.getBoundingClientRect().toJSON() }, parent: { opacity: getComputedStyle(img.parentElement).opacity, clip: getComputedStyle(img.parentElement).clipPath, animations: img.parentElement.getAnimations().map(a => ({ state: a.playState, time: a.currentTime })) } })));
    await page.screenshot({ path: fileURLToPath(new URL(`../qa/title-cycle-${i}.png`, import.meta.url)) });
  }
  writeFileSync(new URL('../qa/title-cycle-debug.json', import.meta.url), JSON.stringify(states, null, 2));
  console.log(JSON.stringify(states));
} finally { await browser.close(); await host.close(); }
