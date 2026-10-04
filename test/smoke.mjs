// Fake "meeting" page: captions region that grows like Meet's, plus audio. Checks recorder + caption assembly.
import { chromium } from 'playwright';
import { createWriteStream, statSync } from 'node:fs';
import { startRecorder, stopRecorder, captionSnapshot, CaptionAssembler } from '../bot/page.mjs';
import { zoom } from '../bot/platforms.mjs';

console.log('zoom url:', zoom.joinUrl('https://us02web.zoom.us/j/81234567890?pwd=abc123'));
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const port = 9800 + Math.floor(Math.random() * 100);
const proc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [`--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'mb-s-'))}`, '--auto-accept-this-tab-capture', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let browser; for (let i = 0; i < 40 && !browser; i++) { await new Promise((r) => setTimeout(r, 250)); browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null); }
const _unused = () => chromium.launch({ channel: 'chromium', headless: process.env.BOT_HEADLESS === '1', args: ['--auto-accept-this-tab-capture', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream'] });
const page = browser.contexts()[0].pages()[0];
const html = `<title>Fake meeting</title><h1>Fake meeting</h1>
<div role="region" aria-label="Captions"><div id="c"></div></div>
<script>
  const ctx = new AudioContext(); const o = ctx.createOscillator(); o.connect(ctx.destination); o.start();
  const lines = [['Alex','Hi everyone'],['Alex','Hi everyone, let us review the launch'],['Sam','Sounds good. I will send the deck by Friday']];
  let i = 0; const c = document.getElementById('c'); let cur = {};
  setInterval(() => { if (i >= lines.length) return; const [who, txt] = lines[i++];
    if (cur.who !== who) { cur = { who, el: document.createElement('div') }; cur.el.innerHTML = '<img alt=""><span class="n"></span><div class="t"></div>'; cur.el.querySelector('.n').textContent = who; c.appendChild(cur.el); }
    cur.el.querySelector('.t').textContent = txt; }, 1500);
</script>`;
await page.route('https://meet.test/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
await page.goto('https://meet.test/');
const out = createWriteStream('data/recordings/smoke.webm');
let done; const stopped = new Promise((r) => (done = r));
await page.exposeFunction('__mbChunk', (b) => out.write(Buffer.from(b, 'base64')));
await page.exposeFunction('__mbRecStopped', () => out.end(done));
await page.exposeFunction('__mbRecState', (s, d) => console.log('recorder', s, d));
await startRecorder(page);
const t0 = Date.now();
const asm = new CaptionAssembler((s, t, at) => console.log('UTT', ((at - t0) / 1000).toFixed(1) + 's', s, '|', t), 2500);
for (let k = 0; k < 10; k++) { await new Promise((r) => setTimeout(r, 1000)); asm.push(await page.evaluate(captionSnapshot, ['[role="region"][aria-label*="aption" i]']), Date.now()); }
asm.flush();
await stopRecorder(page); await Promise.race([stopped, new Promise((r) => setTimeout(r, 8000))]);
console.log('recording bytes:', statSync('data/recordings/smoke.webm').size);
await browser.close(); proc.kill();
