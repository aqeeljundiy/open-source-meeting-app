// One bot = one process = one meeting.  Usage: node bot/run.mjs <meetingId>
// The server spawns this. The DB is the control channel: the server sets
// status 'stopping' and the bot notices on its next tick.
import { chromium } from 'playwright';
import { createWriteStream, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { q, REC_DIR } from '../db.mjs';
import { platforms } from './platforms.mjs';
import { startRecorder, stopRecorder, startCompositeRecorder, grabTabAudio, audioLevel, hookAudioTracks, captionSnapshot, CaptionAssembler } from './page.mjs';
import { finishMeeting } from '../pipeline.mjs';

const id = process.argv[2];
const meeting = q.getMeeting.get(id);
if (!meeting) { console.error(`No meeting ${id}`); process.exit(1); }
const platform = platforms[meeting.platform];

const ADMIT_TIMEOUT_MS = Number(process.env.ADMIT_TIMEOUT_MIN || 10) * 60_000;
const MAX_MEETING_MS = Number(process.env.MAX_MEETING_MIN || 180) * 60_000;
const ALONE_TIMEOUT_MS = Number(process.env.ALONE_TIMEOUT_MIN || 1) * 60_000;   // leave this long after everyone else has gone
// Headless records very few video frames; run headed (a real window, or Xvfb in Docker).
const HEADLESS = process.env.BOT_HEADLESS === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => { console.log(`[${id}] ${msg}`); q.addEvent.run(id, msg); };
const setStatus = (s, err = null) => { q.setStatus.run(s, err, id); log(`Status: ${s}${err ? ` (${err})` : ''}`); };
const stopRequested = () => q.getMeeting.get(id)?.status === 'stopping';

let browser;
let chromeProc;
let profileDir;
let recFile;
let recStart = 0;
let recDone;

function chromePath() {
  return [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']
    .find((p) => p && existsSync(p));
}

async function launchBrowser() {
  const flags = [
    '--auto-accept-this-tab-capture',      // auto-accept recording our own tab
    '--autoplay-policy=no-user-gesture-required',
    // Keep timers, video and audio running even when the bot's window is covered or in the background.
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
    '--lang=en-US', '--accept-lang=en-US,en',
    // No tab strip or address bar: the recording is exactly the meeting, nothing cut off.
    // Servers: kiosk fills the whole 1280x720 virtual screen. Desktop: an app window that size.
    process.platform === 'linux' ? '--kiosk' : '--window-size=1280,807',
    '--window-position=0,0',
  ];
  if (HEADLESS) flags.push('--headless=new');
  // In Docker: Chrome runs as root and /dev/shm is tiny.
  if (process.getuid?.() === 0) flags.push('--no-sandbox');
  if (process.platform === 'linux') flags.push('--disable-dev-shm-usage');
  const exe = chromePath() || chromium.executablePath();
  profileDir = mkdtempSync(join(tmpdir(), 'mb-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  chromeProc = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, ...flags, '--app=about:blank'], { stdio: 'ignore', env: { ...process.env, LANG: 'en_US.UTF-8', LANGUAGE: 'en_US:en' } });
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(250);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  }
  if (!browser) throw new Error('Could not start Chrome');
  log(`Browser: ${exe.includes('Google Chrome') || exe.includes('google-chrome') ? 'Google Chrome' : 'Chromium'}`);
  const context = browser.contexts()[0];
  // Let the meeting site use the (virtual) mic/speaker without a permission prompt.
  for (const origin of ['https://meet.google.com', 'https://app.zoom.us', 'https://zoom.us']) {
    await context.grantPermissions(['microphone', 'camera'], { origin }).catch(() => {});
  }
  return context;
}

async function main() {
  setStatus('joining');
  // Anonymous guest, no account. Google Meet rejects browsers that look automated, so:
  // start a real Chrome the normal way (no Playwright launch flags), attach over CDP,
  // no fake camera/mic, and type/click like a person (see platforms.mjs).
  const context = await launchBrowser();
  const page = context.pages()[0] || await context.newPage();

  // Bridge from the page to Node.
  recFile = `${id}.webm`;
  const out = createWriteStream(join(REC_DIR, recFile));
  let resolveRec;
  recDone = new Promise((r) => { resolveRec = r; });
  await page.exposeFunction('__mbChunk', (b64) => { out.write(Buffer.from(b64, 'base64')); });
  await page.exposeFunction('__mbRecStopped', () => out.end(resolveRec));
  await page.exposeFunction('__mbRecState', (state, detail) => log(`Recorder ${state}: ${detail}`));

  await page.addInitScript(hookAudioTracks);
  const url = platform.joinUrl(meeting.url);
  log(`Opening ${platform.name}: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await platform.prejoin(page, meeting.bot_name, log);

  // Wait to be admitted.
  const admitDeadline = Date.now() + ADMIT_TIMEOUT_MS;
  let state;
  for (;;) {
    if (stopRequested()) return finish(page, 'stopped');
    state = await platform.state(page);
    if (state === 'in_call') break;
    if (state === 'denied') throw new Error(meeting.platform === 'meet' ? 'Google Meet refused the bot. Meetings hosted from a personal @gmail.com account block guests; use a Workspace-hosted Meet or Zoom' : 'The meeting refused to let the bot in');
    if (state === 'ended') throw new Error('The meeting ended before the bot was admitted');
    if (state === 'waiting' && q.getMeeting.get(id).status !== 'waiting_room') setStatus('waiting_room');
    if (Date.now() > admitDeadline) throw new Error('Nobody let the bot in');
    await platform.dismissDialogs?.(page, log);   // pop-ups that appear right after being admitted
    await sleep(2000);
  }

  log('Admitted to the meeting');
  await sleep(2000);
  await platform.afterJoin(page, log);
  await platform.announce(page, `Hi, I'm ${meeting.bot_name}. I'm recording this meeting and taking notes.`, log);

  // Default: our own clean video built from the call's video feeds + mixed meeting audio.
  // RECORD_MODE=tab records the whole tab instead (shows Meet's UI); RECORD_VIDEO=0 = audio only.
  const wantVideo = process.env.RECORD_VIDEO !== '0';
  if (wantVideo && process.env.RECORD_MODE === 'tab' && await startRecorder(page)) {
    log('Recording the whole tab');
  } else {
    await grabTabAudio(page);
    const r = await startCompositeRecorder(page, { video: wantVideo });
    log(`Recording ${wantVideo ? 'video (participants and screen shares only, no meeting UI)' : 'audio only'}; audio from ${r.tabAudio ? 'the tab' : `${r.audioTracks} call stream${r.audioTracks === 1 ? '' : 's'}`} (${r.ctxState})`);
    // Check a little later that sound is actually coming through (people may be quiet at first).
    setTimeout(async () => {
      const lvl = await audioLevel(page, 8000).catch(() => null);
      if (lvl != null) log(lvl > 0.002 ? `Audio OK (level ${lvl.toFixed(3)})` : 'Audio looks silent so far (nobody talking yet, or no sound reaching the bot)');
    }, 20000);
  }
  recStart = Date.now();
  q.setRecording.run(recFile, id);
  q.setStarted.run(id);
  setStatus('recording');

  const assembler = new CaptionAssembler((speaker, text, at) => {
    q.addUtterance.run(id, speaker, text, Math.max(0, at - recStart));
  });

  let aloneSince = null;
  let noCaptionsLogged = false;
  let tick = 0;
  for (;;) {
    await sleep(1000);
    tick++;

    // Captions can live in the main page or (old Zoom) an iframe.
    let snapshot = null;
    for (const frame of page.frames()) {
      snapshot = await frame.evaluate(captionSnapshot, platform.captionSelectors).catch(() => null);
      if (snapshot) break;
    }
    if (!snapshot && !noCaptionsLogged && tick === 30) {
      log('No captions on screen yet; the transcript will come from the recording if a transcription key is set');
      noCaptionsLogged = true;
    }
    assembler.push(snapshot, Date.now());

    if (tick % 5) continue;
    await platform.ensureMuted?.(page, log);
    await platform.dismissDialogs?.(page);
    if (stopRequested()) { assembler.flush(); return finish(page, 'stopped'); }
    const s = await platform.state(page);
    if (s === 'ended' || s === 'denied') {
      const why = (await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
      log(`Meeting ended (page says: ${why})`);
      assembler.flush();
      return finish(page);
    }
    if (Date.now() - recStart > MAX_MEETING_MS) { log('Hit the maximum meeting length'); assembler.flush(); return finish(page); }

    const n = await platform.participants(page);
    if (n !== null && n <= 1) {
      aloneSince ??= Date.now();
      if (Date.now() - aloneSince > ALONE_TIMEOUT_MS) { log('Everyone else left'); assembler.flush(); return finish(page); }
    } else aloneSince = null;
  }
}

async function finish(page, finalStatus) {
  if (recStart) {
    await stopRecorder(page);
    await Promise.race([recDone, sleep(15000)]);
  }
  await platform.leave(page).catch(() => {});
  log('Left the meeting');
  q.setEnded.run(id);
  await browser.close().catch(() => {});
  if (finalStatus === 'stopped' && !recStart) return setStatus('stopped');
  await finishMeeting(id, log, setStatus);
}

main()
  .catch(async (err) => {
    // Leave evidence for debugging: what the page looked like when the bot gave up.
    const page = browser?.contexts?.()[0]?.pages?.()[0];
    if (page) {
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (text) log(`Page said: ${text.replace(/\s+/g, ' ').slice(0, 1500)}`);
      const buttons = await page.getByRole('button').evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-label') || e.innerText.trim()}${e.disabled || e.getAttribute('aria-disabled') === 'true' ? ' (disabled)' : ''}`).filter(Boolean)).catch(() => []);
      if (buttons.length) log(`Buttons: ${buttons.join(' | ').slice(0, 800)}`);
      await page.screenshot({ path: join(REC_DIR, `${id}-error.png`) }).catch(() => {});
    }
    setStatus('failed', err.message.split('\n')[0]);
    console.error(err);
    await browser?.close().catch(() => {});
  })
  .finally(() => {
    chromeProc?.kill();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
    process.exit(0);
  });
