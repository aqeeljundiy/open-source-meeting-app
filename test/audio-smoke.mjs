// Two peer connections in one page: one sends a tone, the hooked one receives it.
// Checks that the audio-only recorder captures real audio from a remote WebRTC track.
import { chromium } from 'playwright';
import { createWriteStream, statSync } from 'node:fs';
import { hookAudioTracks, startAudioRecorder } from '../bot/page.mjs';
const b = await chromium.launch({ channel: 'chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await b.newPage();
await page.addInitScript(hookAudioTracks);
await page.route('https://rtc.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>rtc</p>' }));
await page.goto('https://rtc.test/');
const out = createWriteStream('data/recordings/audio-smoke.webm');
let done; const stopped = new Promise((r) => (done = r));
await page.exposeFunction('__mbChunk', (x) => out.write(Buffer.from(x, 'base64')));
await page.exposeFunction('__mbRecStopped', () => out.end(done));
await page.evaluate(async () => {
  const ac = new AudioContext(); const osc = ac.createOscillator(); const d = ac.createMediaStreamDestination(); osc.connect(d); osc.start();
  const a = new RTCPeerConnection(), z = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && z.addIceCandidate(e.candidate);
  z.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  d.stream.getTracks().forEach((t) => a.addTrack(t, d.stream));
  await a.setLocalDescription(); await z.setRemoteDescription(a.localDescription);
  await z.setLocalDescription(); await a.setRemoteDescription(z.localDescription);
  await new Promise((r) => setTimeout(r, 1500));
});
console.log('tracks seen:', await startAudioRecorder(page));
await page.waitForTimeout(8000);
await page.evaluate(() => window.__mbRecorder.stop());
await Promise.race([stopped, page.waitForTimeout(5000)]);
console.log('audio bytes for ~8s:', statSync('data/recordings/audio-smoke.webm').size);
await b.close();
