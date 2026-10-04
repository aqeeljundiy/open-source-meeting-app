// Demo clients: load a folder of realistic meetings from demos/<name>.json and run them
// through the real pipeline (AI notes, tasks, filing, folder overview). Useful for showing the app.
// The open-source repo ships no demo files; add your own JSON in demos/.
import { existsSync, readdirSync, readFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, q, REC_DIR } from './db.mjs';
import { finishMeeting, refreshFolderOverview } from './pipeline.mjs';

const DIR = join(import.meta.dirname, 'demos');
const newId = () => randomUUID().replace(/-/g, '').slice(0, 10);
const status = new Map();   // workspaceId -> { demo, step, total, done, error }

export function listDemos() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => {
    const d = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
    return { name: f.replace(/\.json$/, ''), title: d.title, folder: d.folder, meetings: d.meetings.length };
  });
}

export const demoStatus = (workspaceId) => status.get(workspaceId) || null;

export function loadDemo(name, { workspaceId, userId, botName }) {
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(join(DIR, `${name}.json`))) throw new Error('Demo not found');
  const cur = status.get(workspaceId);
  if (cur && !cur.done) throw new Error('A demo is already loading');
  const demo = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));
  const s = { demo: demo.title, step: 'Creating folder', total: demo.meetings.length, current: 0, done: false, error: null };
  status.set(workspaceId, s);
  run(demo, s, { workspaceId, userId, botName }).catch((err) => { s.error = err.message; s.done = true; });
  return s;
}

async function run(demo, s, { workspaceId, userId, botName }) {
  // Folder (reuse if it exists, e.g. a second load).
  let folder = db.prepare(`SELECT id FROM folders WHERE workspace_id = ? AND name = ? COLLATE NOCASE`).get(workspaceId, demo.folder);
  if (!folder) {
    folder = { id: newId() };
    q.insertFolder.run(folder.id, workspaceId, demo.folder, demo.color || 'blue');
  }
  const attendees = JSON.stringify(demo.attendees || []);
  const created = [];
  for (const [i, m] of demo.meetings.entries()) {
    s.current = i + 1;
    s.step = `Writing notes for meeting ${i + 1} of ${demo.meetings.length}: ${m.title}`;
    // Loading again continues where it stopped: finished meetings are kept, failed ones redone.
    const existing = db.prepare(`SELECT id, status FROM meetings WHERE folder_id = ? AND title = ?`).get(folder.id, m.title);
    if (existing?.status === 'done') { created.push({ id: existing.id, video: m.video, title: m.title }); continue; }
    if (existing) q.deleteMeeting.run(existing.id);
    const id = newId();
    q.insertMeeting.run(id, workspaceId, userId, m.title, demo.url || 'https://meet.google.com/demo-meet-ing', 'meet', botName);
    const start = `datetime('now', '-${Number(m.days_ago) || 0} days')`;
    db.prepare(`UPDATE meetings SET folder_id = ?, filed_by = 'user', attendees = ?, created_at = ${start},
                started_at = ${start}, ended_at = datetime('now', '-${Number(m.days_ago) || 0} days', '+${Number(m.minutes) || 30} minutes') WHERE id = ?`)
      .run(folder.id, attendees, id);
    let t = 3000;
    const spread = ((Number(m.minutes) || 30) * 60000) / Math.max(1, m.lines.length);
    for (const [speaker, text] of m.lines) { q.addUtterance.run(id, speaker, text, Math.round(t)); t += spread * (0.7 + Math.random() * 0.6); }
    q.addEvent.run(id, `Demo meeting loaded from "${demo.title}" (fictional transcript)`);
    // AI calls occasionally fail on a network blip: try up to 3 times.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await finishMeeting(id, (msg) => q.addEvent.run(id, msg), (st, e = null) => q.setStatus.run(st, e, id));
      if (q.getMeeting.get(id).status !== 'failed') break;
      if (attempt < 3) { s.step = `Retrying meeting ${i + 1} (${attempt + 1}/3)`; await new Promise((r) => setTimeout(r, 4000 * attempt)); }
    }
    const after = q.getMeeting.get(id);
    if (after.status === 'failed') throw new Error(`Meeting ${i + 1} failed: ${after.error}`);
    // Mark the share of tasks the story says are finished.
    const tasks = db.prepare(`SELECT id FROM tasks WHERE meeting_id = ? ORDER BY created_at`).all(id);
    const doneCount = Math.round(tasks.length * (m.done_ratio ?? 0));
    for (const task of tasks.slice(0, doneCount)) {
      db.prepare(`UPDATE tasks SET status = 'done', source = 'user', done_at = datetime('now', '-${Math.max(0, (Number(m.days_ago) || 0) - 3)} days') WHERE id = ?`).run(task.id);
    }
    created.push({ id, video: m.video, title: m.title });
  }
  s.step = 'Writing the folder overview';
  await refreshFolderOverview(folder.id);
  // Placeholder recordings for a few meetings (needs Chrome; skipped quietly if unavailable).
  for (const m of created.filter((x) => x.video)) {
    s.step = `Making a placeholder recording for "${m.title}"`;
    await placeholderVideo(m.id).catch((e) => q.addEvent.run(m.id, `Placeholder video skipped: ${e.message}`));
  }
  s.step = 'Done';
  s.folderId = folder.id;
  s.done = true;
}

// A fake call drawn on a canvas (participant tiles + captions), recorded to webm.
async function placeholderVideo(id, seconds = 30) {
  const { chromium } = await import('playwright');
  const lines = q.utterances.all(id).slice(0, 8).map((u) => [u.speaker, u.text]);
  const people = [...new Set(lines.map((l) => l[0]))].slice(0, 4);
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH) ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' }),
    args: process.getuid?.() === 0 ? ['--no-sandbox'] : [],
  });
  try {
    const page = await browser.newPage();
    await page.route('https://demo.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<canvas id=c width=1280 height=720></canvas>' }));
    await page.goto('https://demo.test/');
    const out = createWriteStream(join(REC_DIR, `${id}.webm`));
    let done; const finished = new Promise((r) => (done = r));
    await page.exposeFunction('chunk', (b) => out.write(Buffer.from(b, 'base64')));
    await page.exposeFunction('end', () => out.end(done));
    await page.evaluate(({ lines, people, seconds }) => {
      const c = document.getElementById('c'), x = c.getContext('2d');
      const colors = ['#ee6351', '#83b271', '#5b8def', '#c084fc'];
      const per = (seconds * 1000) / lines.length, t0 = performance.now();
      const wrap = (text, max) => { const w = text.split(' '); const out = []; let l = ''; for (const s of w) { if (x.measureText(l + s).width > max) { out.push(l); l = ''; } l += s + ' '; } out.push(l); return out; };
      const draw = () => {
        const t = performance.now() - t0, i = Math.min(lines.length - 1, Math.floor(t / per)), [who, text] = lines[i];
        x.fillStyle = '#0d0d0d'; x.fillRect(0, 0, 1280, 720);
        people.forEach((p, k) => {
          const tx = 24 + (k % 2) * 624, ty = 24 + Math.floor(k / 2) * 300, w = 608, h = 284;
          x.fillStyle = '#1b1b1b'; x.beginPath(); x.roundRect(tx, ty, w, h, 16); x.fill();
          if (p === who) { x.strokeStyle = '#83b271'; x.lineWidth = 4; x.stroke(); }
          x.fillStyle = colors[k]; x.beginPath(); x.arc(tx + w / 2, ty + h / 2 - 10, 56 + (p === who ? 6 * Math.sin(t / 120) : 0), 0, Math.PI * 2); x.fill();
          x.fillStyle = '#fff'; x.font = '600 44px sans-serif'; x.textAlign = 'center'; x.fillText(p.split(' ').map((s) => s[0]).join('').slice(0, 2), tx + w / 2, ty + h / 2 + 4);
          x.textAlign = 'left'; x.font = '500 18px sans-serif'; x.fillStyle = '#e8e8e3'; x.fillText(p, tx + 16, ty + h - 18);
        });
        x.fillStyle = 'rgba(0,0,0,.72)'; x.beginPath(); x.roundRect(140, 610, 1000, 92, 12); x.fill();
        x.font = '600 17px sans-serif'; x.fillStyle = '#83b271'; x.fillText(who, 164, 638);
        x.font = '400 19px sans-serif'; x.fillStyle = '#fff'; wrap(text, 950).slice(0, 2).forEach((l, n) => x.fillText(l, 164, 664 + n * 24));
        if (t < seconds * 1000) requestAnimationFrame(draw);
      };
      draw();
      const rec = new MediaRecorder(c.captureStream(24), { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 900000 });
      let queue = Promise.resolve();
      rec.ondataavailable = (e) => { queue = queue.then(async () => { const b = new Uint8Array(await e.data.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); await window.chunk(btoa(s)); }); };
      rec.onstop = () => queue.then(() => window.end());
      rec.start(3000);
      setTimeout(() => rec.stop(), seconds * 1000 + 300);
    }, { lines, people, seconds });
    await Promise.race([finished, page.waitForTimeout((seconds + 20) * 1000)]);
    q.setRecording.run(`${id}.webm`, id);
  } finally {
    await browser.close();
  }
}
