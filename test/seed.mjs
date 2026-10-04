// Demo data for local testing: two accounts, a workspace, folders, a finished meeting with notes + tasks.
// Usage: node test/seed.mjs   (test credentials below are for localhost only)
import { copyFileSync, existsSync } from 'node:fs';
process.env.OPEN_SIGNUP = '1';   // demo accounts bypass invite-only sign-up
import { join } from 'node:path';
import { db, q, REC_DIR } from '../db.mjs';
import { signup, createWorkspace } from '../auth.mjs';
import { createTasks, fileMeeting } from '../pipeline.mjs';

export const DEMO = [
  { email: 'demo@meetingbot.test', name: 'Alex Demo', password: 'demo-pass-123' },
  { email: 'sam@meetingbot.test', name: 'Sam Demo', password: 'demo-pass-123' },
];
if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(DEMO[0].email)) { console.log('Already seeded'); process.exit(0); }

const [alex, sam] = DEMO.map((u) => signup(u));
const ws = createWorkspace('Acme', alex);
db.prepare(`INSERT INTO members (workspace_id, user_id, role) VALUES (?, ?, 'member')`).run(ws, sam);
q.insertFolder.run('fold_nw', ws, 'Northwind', 'purple');

const id = 'demo0001';
q.insertMeeting.run(id, ws, alex, 'Launch sync', 'https://meet.google.com/abc-defg-hij', 'meet', 'Notetaker');
q.setStatus.run('done', null, id);
if (existsSync(join(REC_DIR, 'smoke.webm'))) { copyFileSync(join(REC_DIR, 'smoke.webm'), join(REC_DIR, `${id}.webm`)); q.setRecording.run(`${id}.webm`, id); }
for (const [s, t, ms] of [['Alex', 'Hi everyone, let us review the Northwind launch', 2000], ['Sam', 'Sounds good. I will send the deck by Friday', 5000], ['Alex', 'And I will book the photographer', 8000]]) q.addUtterance.run(id, s, t, ms);
const notes = {
  title: 'Northwind launch sync', summary: 'Quick check-in on the Northwind launch. Sam will share the deck; Alex books the photographer.',
  key_points: ['Launch review is on track'], decisions: ['Shoot product photos next week'],
  action_items: [{ task: 'Send the launch deck', owner: 'Sam', due: 'Friday', said_at: '00:05' }, { task: 'Book the photographer', owner: 'Alex', due: '', said_at: '00:08' }],
  open_questions: [], topics: [{ name: 'Launch review', start: '00:02' }],
  meeting_type: 'client', tags: ['launch'], folder: 'Northwind',
};
q.setSummary.run(JSON.stringify(notes), id);
const m = q.getMeeting.get(id);
createTasks(m, notes);
fileMeeting(m, notes, (msg) => q.addEvent.run(id, msg));
console.log('Seeded. Sign in with', DEMO[0].email);
