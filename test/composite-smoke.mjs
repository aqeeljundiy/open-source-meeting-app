// Fake call: two <video> tiles (canvas streams) + a remote WebRTC audio tone; check the composite recorder.
import { chromium } from 'playwright';
import { createWriteStream, statSync } from 'node:fs';
import { hookAudioTracks, startCompositeRecorder } from '../bot/page.mjs';
const b = await chromium.launch({ channel: 'chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(hookAudioTracks);
await page.route('https://call.test/**', (r) => r.fulfill({ contentType: 'text/html', body: `
  <div data-participant-id="a" style="position:absolute;left:0;top:0;width:900px;height:600px"><video id="v1" autoplay muted playsinline style="width:100%;height:100%"></video><span>Jordan Lee</span></div>
  <div data-participant-id="b" style="position:absolute;left:920px;top:0;width:300px;height:200px"><video id="v2" autoplay muted playsinline style="width:100%;height:100%"></video><span>Sam Demo</span></div>` }));
await page.goto('https://call.test/');
await page.evaluate(async () => {
  const feed = (color, label) => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d'); let t = 0;
    setInterval(() => { x.fillStyle = color; x.fillRect(0, 0, 640, 360); x.fillStyle = '#fff'; x.font = '40px sans-serif'; x.fillText(`${label} ${t++}`, 40, 200); }, 66); return c.captureStream(15); };
  document.getElementById('v1').srcObject = feed('#335', 'SPEAKER');
  document.getElementById('v2').srcObject = feed('#353', 'other');
  const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start();
  const a = new RTCPeerConnection(), z = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && z.addIceCandidate(e.candidate); z.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  d.stream.getTracks().forEach((t) => a.addTrack(t, d.stream));
  await a.setLocalDescription(); await z.setRemoteDescription(a.localDescription); await z.setLocalDescription(); await a.setRemoteDescription(z.localDescription);
  await new Promise((r) => setTimeout(r, 1500));
});
const out = createWriteStream('data/recordings/composite-smoke.webm');
let done; const stopped = new Promise((r) => (done = r));
await page.exposeFunction('__mbChunk', (x) => out.write(Buffer.from(x, 'base64')));
await page.exposeFunction('__mbRecStopped', () => out.end(done));
console.log('recorder:', await startCompositeRecorder(page, { video: true }));
await page.waitForTimeout(6000);
// grab a frame of what is being recorded
const frame = await page.evaluate(() => { const v = document.createElement('video'); return new Promise((res) => { const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const s = window.__mbRecorder.stream; v.srcObject = s; v.muted = true; v.onplaying = () => setTimeout(() => { c.getContext('2d').drawImage(v, 0, 0); res(c.toDataURL('image/jpeg', 0.7)); }, 300); v.play(); }); });
await page.evaluate(() => window.__mbRecorder.stop());
await Promise.race([stopped, page.waitForTimeout(5000)]);
const { writeFileSync } = await import('node:fs');
writeFileSync('data/recordings/composite-frame.jpg', Buffer.from(frame.split(',')[1], 'base64'));
console.log('bytes for ~6s:', statSync('data/recordings/composite-smoke.webm').size);
await b.close();
