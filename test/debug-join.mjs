// Try joining a Meet with different browser setups and report what Google does.
//   MODE=plain  : Playwright Chromium, no UA override, automation flags removed
//   MODE=cdp    : real Google Chrome started normally, Playwright attaches over CDP
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meet } from '../bot/platforms.mjs';

const url = process.argv[2];
const mode = process.env.MODE || 'plain';
let browser, chromeProc, page;
if (mode === 'cdp') {
  const port = 9300 + Math.floor(Math.random() * 500);
  chromeProc = spawn(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'mb-chrome-'))}`,
    '--no-first-run', '--no-default-browser-check', ...(process.env.FAKE === '0' ? [] : ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']), '--window-size=1280,800', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 40 && !browser; i++) { await new Promise((r) => setTimeout(r, 250)); browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null); }
  page = browser.contexts()[0].pages()[0];
} else {
  browser = await chromium.launch({ channel: 'chromium', headless: false, ignoreDefaultArgs: ['--enable-automation'], args: ['--use-fake-device-for-media-stream', '--disable-blink-features=AutomationControlled', '--window-size=1280,800'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['microphone', 'camera'], locale: 'en-US' });
  page = await ctx.newPage();
}
console.log('webdriver =', await page.evaluate(() => navigator.webdriver), '| ua =', (await page.evaluate(() => navigator.userAgent)).match(/Chrome\/[\d.]+/)?.[0]);
await page.goto(url, { waitUntil: 'domcontentloaded' });
if (process.env.FAKE === '0') {
  await page.waitForTimeout(3000);
  for (const name of [/Continue without microphone and camera/i, /without microphone/i, /Dismiss/i, /Got it/i]) {
    const b = page.getByRole('button', { name }).first();
    if (await b.isVisible().catch(() => false)) { await b.click(); console.log('clicked', name); }
  }
}
if (process.env.HUMAN === '1') {
  const wait = (a, b) => page.waitForTimeout(a + Math.random() * (b - a));
  const input = page.locator('input[aria-label="Your name"], input[placeholder="Your name"], input[type="text"]').first();
  await input.waitFor({ timeout: 30000 });
  const box = await input.boundingBox();
  await page.mouse.move(box.x - 120, box.y + 80, { steps: 12 }); await wait(300, 700);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 }); await wait(150, 400);
  await page.mouse.down(); await wait(40, 120); await page.mouse.up();
  await wait(400, 900);
  await page.keyboard.type('Notetaker', { delay: 90 + Math.random() * 80 });
  console.log('LOG typed name like a person');
  await wait(1200, 2500);
  const btn = page.getByRole('button', { name: /^Ask to join$|^Join now$/i }).first();
  await btn.waitFor({ timeout: 10000 });
  const bb = await btn.boundingBox();
  await page.mouse.move(bb.x + bb.width * 0.4, bb.y + bb.height * 0.6, { steps: 25 }); await wait(200, 500);
  await page.mouse.down(); await wait(60, 140); await page.mouse.up();
  console.log('LOG clicked Ask to join like a person');
} else {
  await meet.prejoin(page, 'Notetaker', (m) => console.log('LOG', m)).catch((e) => console.log('PREJOIN ERR', e.message.slice(0, 80)));
}
for (let i = 1; i <= 15; i++) {
  await page.waitForTimeout(3000);
  const st = await meet.state(page).catch((e) => 'err ' + e.message);
  const txt = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).replace(/\n+/g, ' | ').slice(0, 120);
  console.log(`[${mode}] t+${i * 3}s state=${st} | ${txt}`);
  if (st === 'in_call' || st === 'denied') break;
}
await page.screenshot({ path: 'data/debug-join.png' }).catch(() => {});
await browser.close().catch(() => {});
chromeProc?.kill();
