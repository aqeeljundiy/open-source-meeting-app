// Open a meeting URL the way the bot does and dump what the page says.
import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chromium', headless: false, args: ['--use-fake-device-for-media-stream', '--disable-blink-features=AutomationControlled'] });
const ctx = await b.newContext({ permissions: ['microphone', 'camera'], locale: 'en-US', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' });
const p = await ctx.newPage();
await p.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(Number(process.argv[3] || 8000));
await p.screenshot({ path: 'data/peek.png' });
console.log(p.url(), '\n---\n', (await p.evaluate(() => document.body.innerText)).slice(0, 1500));
console.log('---inputs', await p.locator('input').evaluateAll((els) => els.map((e) => [e.type, e.ariaLabel, e.placeholder, e.id])));
console.log('---buttons', await p.getByRole('button').evaluateAll((els) => els.map((e) => e.ariaLabel || e.innerText).filter(Boolean).slice(0, 30)));
await b.close();
