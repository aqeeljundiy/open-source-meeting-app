// Placeholder recording for the demo meeting: a fake 4-person call drawn on a canvas,
// captions from the transcript, recorded with MediaRecorder (real-time, ~45 s).
//   node test/demo-video.mjs demo0001
import { chromium } from 'playwright';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
const { q, REC_DIR } = await import('../db.mjs');
const id = process.argv[2] || 'demo0001';
const lines = q.utterances.all(id).slice(0, 9).map((u) => [u.speaker, u.text]);
const people = [...new Set(lines.map((l) => l[0]))].slice(0, 4);
const SECONDS = 45;

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage();
await page.route('https://demo.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<canvas id=c width=1280 height=720></canvas>' }));
await page.goto('https://demo.test/');
const out = createWriteStream(join(REC_DIR, `${id}.webm`));
let done; const finished = new Promise((r) => (done = r));
await page.exposeFunction('chunk', (b) => out.write(Buffer.from(b, 'base64')));
await page.exposeFunction('end', () => out.end(done));
await page.evaluate(async ({ lines, people, SECONDS }) => {
  const c = document.getElementById('c'), x = c.getContext('2d');
  const colors = ['#ee6351', '#83b271', '#5b8def', '#c084fc'];
  const per = (SECONDS * 1000) / lines.length;
  const t0 = performance.now();
  const wrap = (text, max) => { const w = text.split(' '); const out = []; let l = ''; for (const s of w) { if (x.measureText(l + s).width > max) { out.push(l); l = ''; } l += s + ' '; } out.push(l); return out; };
  const draw = () => {
    const t = performance.now() - t0, i = Math.min(lines.length - 1, Math.floor(t / per)), [who, text] = lines[i];
    x.fillStyle = '#0d0d0d'; x.fillRect(0, 0, 1280, 720);
    people.forEach((p, k) => {
      const tx = 24 + (k % 2) * 624, ty = 24 + Math.floor(k / 2) * 300, w = 608, h = 284;
      x.fillStyle = '#1b1b1b'; x.beginPath(); x.roundRect(tx, ty, w, h, 16); x.fill();
      if (p === who) { x.strokeStyle = '#83b271'; x.lineWidth = 4; x.stroke(); }
      const pulse = p === who ? 6 * Math.sin(t / 120) : 0;
      x.fillStyle = colors[k]; x.beginPath(); x.arc(tx + w / 2, ty + h / 2 - 10, 56 + pulse, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#fff'; x.font = '600 44px sans-serif'; x.textAlign = 'center'; x.fillText(p.split(' ').map((s) => s[0]).join(''), tx + w / 2, ty + h / 2 + 4);
      x.textAlign = 'left'; x.font = '500 18px sans-serif'; x.fillStyle = '#e8e8e3'; x.fillText(p, tx + 16, ty + h - 18);
    });
    x.fillStyle = 'rgba(0,0,0,.72)'; x.beginPath(); x.roundRect(140, 610, 1000, 92, 12); x.fill();
    x.font = '600 17px sans-serif'; x.fillStyle = '#83b271'; x.fillText(who, 164, 638);
    x.font = '400 19px sans-serif'; x.fillStyle = '#fff'; wrap(text, 950).slice(0, 2).forEach((l, n) => x.fillText(l, 164, 664 + n * 24));
    if (t < SECONDS * 1000) requestAnimationFrame(draw);
  };
  draw();
  const rec = new MediaRecorder(c.captureStream(24), { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 900000 });
  let queue = Promise.resolve();
  rec.ondataavailable = (e) => { queue = queue.then(async () => { const b = new Uint8Array(await e.data.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); await window.chunk(btoa(s)); }); };
  rec.onstop = () => queue.then(() => window.end());
  rec.start(3000);
  setTimeout(() => rec.stop(), SECONDS * 1000 + 300);
}, { lines, people, SECONDS });
await Promise.race([finished, page.waitForTimeout((SECONDS + 20) * 1000)]);
await browser.close();
q.setRecording.run(`${id}.webm`, id);
console.log('placeholder video saved for', id);
