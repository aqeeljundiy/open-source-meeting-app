// API + dashboard. No framework: node:http, node:sqlite, child processes for bots.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';

try { process.loadEnvFile(join(import.meta.dirname, '.env')); } catch {}

const { q, db, REC_DIR, detectPlatform } = await import('./db.mjs');
const { finishMeeting, refreshFolderOverview } = await import('./pipeline.mjs');
const { transcriptText, MEETING_TYPES } = await import('./summarize.mjs');
const { PROVIDERS, aiFor, testAI, savedKey } = await import('./llm.mjs');
const { seal, unseal, maskKey } = await import('./secrets.mjs');
const assistant = await import('./assistant.mjs');
const demos = await import('./demo.mjs');
const auth = await import('./auth.mjs');
const cal = await import('./calendar.mjs');
const { loadBrand, brandHead } = await import('./brand.mjs');
const BRAND = loadBrand();
if (!process.env.BOT_NAME) process.env.BOT_NAME = BRAND.botName;   // bots inherit the brand's bot name
process.env.SINGLE_WORKSPACE = BRAND.singleWorkspace ? '1' : '0';
process.env.BRAND_DISPLAY_NAME = BRAND.name;
const { HttpError, requireRole, newId, ROLES } = auth;

const PORT = Number(process.env.PORT || 4350);
const BOT_NAME = process.env.BOT_NAME;
const wsBotName = (wsId) => db.prepare(`SELECT bot_name FROM workspaces WHERE id = ?`).get(wsId)?.bot_name || BOT_NAME;
const PUBLIC = join(import.meta.dirname, 'public');
const COLORS = ['blue', 'green', 'orange', 'purple', 'pink', 'gray'];
const bots = new Map(); // meetingId -> child process

// Bots die with the server, so anything mid-flight at startup is orphaned.
db.prepare(`UPDATE meetings SET status = 'failed', error = 'Server restarted during the meeting'
            WHERE status IN ('queued','joining','waiting_room','recording','stopping','processing')`).run();

function launchBot(id) {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'bot/run.mjs'), id], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  bots.set(id, child);
  child.on('exit', () => bots.delete(id));
}

// ---------- helpers ----------
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) throw new HttpError(413, 'Body too large'); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const PUBLIC_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'live.com', 'proton.me', 'protonmail.com']);
function externalDomains(m, ctx) {
  const mine = new Set(q.memberUsers.all(ctx.workspace.id).map((u) => u.email.split('@')[1]));
  const list = m.attendees ? JSON.parse(m.attendees) : [];
  return [...new Set(list.map((a) => a.email?.split('@')[1]?.toLowerCase()).filter((d) => d && !mine.has(d) && !PUBLIC_MAIL.has(d)))];
}

// Meeting in the caller's current workspace, or 404.
function ownMeeting(ctx, id) {
  const m = q.getMeeting.get(id);
  if (!m || m.workspace_id !== ctx.workspace.id) throw new HttpError(404, 'Meeting not found');
  return m;
}
function ownRow(table, ctx, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND workspace_id = ?`).get(id, ctx.workspace.id);
  if (!row) throw new HttpError(404, 'Not found');
  return row;
}
function checkFolder(ctx, folderId) {
  if (folderId) ownRow('folders', ctx, folderId);
  return folderId || null;
}
function checkAssignee(ctx, userId) {
  if (userId && !auth.roleIn(ctx.workspace.id, userId)) throw new HttpError(400, 'Assignee is not in this workspace');
  return userId || null;
}

function meetingDetail(m) {
  return {
    ...m,
    summary: m.summary ? JSON.parse(m.summary) : null,
    tags: m.tags ? JSON.parse(m.tags) : [],
    attendees: m.attendees ? JSON.parse(m.attendees) : [],
    utterances: q.utterances.all(m.id),
    events: q.events.all(m.id),
    tasks: q.meetingTasks.all(m.id),
    live: bots.has(m.id),
  };
}

// Naive in-memory brake on password guessing.
const attempts = new Map();
function throttle(req) {
  const key = req.socket.remoteAddress;
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < 15 * 60_000);
  if (a.length >= 20) throw new HttpError(429, 'Too many attempts, try again in a few minutes');
  a.push(now);
  attempts.set(key, a);
}

// ---------- routes ----------
// Each route: [method, pattern, handler(ctx, params, body, req, res), { public?, role? }]
const routes = [];
const on = (method, path, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, opts });
};

// Auth
on('POST', '/api/auth/signup', (ctx, p, body, req, res) => {
  throttle(req);
  auth.startSession(res, auth.signup(body));
  return { ok: true };
}, { public: true });

on('POST', '/api/auth/login', (ctx, p, body, req, res) => {
  throttle(req);
  auth.startSession(res, auth.login(body));
  return { ok: true };
}, { public: true });

// GOOGLE_LOGIN=0 hides the "Continue with Google" button (calendar connect still works).
on('GET', '/api/brand', () => ({ name: BRAND.name, tagline: BRAND.tagline, logo: BRAND.logo, theme: BRAND.theme, botName: BRAND.botName }), { public: true });

on('GET', '/api/auth/config', () => ({ domains: auth.allowedDomains(), google: cal.googleEnabled(), googleLogin: cal.googleEnabled() && process.env.GOOGLE_LOGIN !== '0' }), { public: true });

// Google: /start sets a one-time state cookie and redirects to Google; /callback finishes sign-in or linking.
on('GET', '/api/auth/google/start', (ctx, p, body, req, res) => {
  if (!cal.googleEnabled()) throw new HttpError(404, 'Google sign-in is not set up');
  const connect = new URL(req.url, 'http://x').searchParams.get('connect') === '1' && ctx ? '1' : '0';
  const state = `${randomBytes(16).toString('hex')}.${connect}`;
  res.writeHead(302, {
    Location: cal.authUrl(state),
    'Set-Cookie': `mb_oauth=${state}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`,
  });
  res.end();
}, { public: true });

on('GET', '/api/auth/google/callback', async (ctx, p, body, req, res) => {
  const u = new URL(req.url, 'http://x').searchParams;
  const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)mb_oauth=([^;]+)/)?.[1];
  const fail = (msg) => { res.writeHead(302, { Location: `/login?error=${encodeURIComponent(msg)}` }); res.end(); };
  if (u.get('error')) return fail(u.get('error') === 'access_denied' ? 'Google sign-in was cancelled' : `Google: ${u.get('error')}`);
  if (!cookie || cookie !== u.get('state')) return fail('Sign-in expired, try again');
  const connect = cookie.endsWith('.1') && ctx;
  try {
    const userId = cal.finishGoogleLogin(await cal.exchangeCode(u.get('code')), connect ? ctx.user.id : null);
    if (!connect) auth.startSession(res, userId);
    res.setHeader('Set-Cookie', [res.getHeader('Set-Cookie'), 'mb_oauth=; Path=/api/auth/google; Max-Age=0'].flat().filter(Boolean));
    res.writeHead(302, { Location: connect ? '/settings?google=connected' : '/upcoming' });
    res.end();
  } catch (err) {
    console.error(err);
    fail(err.message);
  }
}, { public: true });

on('POST', '/api/auth/logout', (ctx, p, body, req, res) => { auth.endSession(req, res); return { ok: true }; }, { public: true });

on('GET', '/api/me', (ctx) => ({ aiName: PROVIDERS[aiFor(ctx.workspace?.id).provider].short, botName: ctx.workspace ? wsBotName(ctx.workspace.id) : BOT_NAME, defaultBotName: BOT_NAME, singleWorkspace: BRAND.singleWorkspace, user: ctx.user, workspace: ctx.workspace, workspaces: ctx.workspaces, meetingTypes: MEETING_TYPES, colors: COLORS }));

// Workspaces
on('POST', '/api/workspaces', (ctx, p, body) => {
  if (BRAND.singleWorkspace) throw new HttpError(403, 'This app has a single company workspace');
  const name = str(body.name, 60);
  if (!name) throw new HttpError(400, 'Name the workspace');
  const id = auth.createWorkspace(name, ctx.user.id);
  auth.switchWorkspace({ ...ctx, workspaces: [...ctx.workspaces, { id }] }, id);
  return { id };
}, { noWorkspace: true });

on('POST', '/api/workspaces/switch', (ctx, p, body) => { auth.switchWorkspace(ctx, body.id); return { ok: true }; }, { noWorkspace: true });

on('PATCH', '/api/workspace', (ctx, p, body) => {
  if ('name' in body) {
    const name = str(body.name, 60);
    if (!name) throw new HttpError(400, 'Name the workspace');
    db.prepare(`UPDATE workspaces SET name = ? WHERE id = ?`).run(name, ctx.workspace.id);
  }
  // The name the bot joins meetings with. Empty = back to the default.
  if ('bot_name' in body) db.prepare(`UPDATE workspaces SET bot_name = ? WHERE id = ?`).run(str(body.bot_name, 40) || null, ctx.workspace.id);
  return { ok: true };
}, { role: 'owner' });

on('GET', '/api/workspace/members', (ctx) => ({
  members: q.memberUsers.all(ctx.workspace.id),
  invites: db.prepare(`SELECT email, role, created_at FROM invites WHERE workspace_id = ? ORDER BY created_at`).all(ctx.workspace.id),
}));

on('POST', '/api/workspace/invites', (ctx, p, body) => {
  const email = str(body.email, 200).toLowerCase();
  const role = ROLES.includes(body.role) ? body.role : 'member';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
  if (!auth.emailAllowed(email)) throw new HttpError(400, auth.domainError());
  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (existing) {
    db.prepare(`INSERT INTO members (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET role = excluded.role`)
      .run(ctx.workspace.id, existing.id, role);
    return { added: true };
  }
  db.prepare(`INSERT INTO invites (workspace_id, email, role, invited_by) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET role = excluded.role`)
    .run(ctx.workspace.id, email, role, ctx.user.id);
  return { invited: true };
}, { role: 'owner' });

on('DELETE', '/api/workspace/invites/:email', (ctx, p) => {
  db.prepare(`DELETE FROM invites WHERE workspace_id = ? AND email = ?`).run(ctx.workspace.id, decodeURIComponent(p.email));
  return { ok: true };
}, { role: 'owner' });

function ownersLeft(wsId, exceptUser) {
  return db.prepare(`SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND role = 'owner' AND user_id != ?`).get(wsId, exceptUser).n;
}
on('PATCH', '/api/workspace/members/:userId', (ctx, p, body) => {
  if (!ROLES.includes(body.role)) throw new HttpError(400, 'Unknown role');
  if (body.role !== 'owner' && !ownersLeft(ctx.workspace.id, p.userId)) throw new HttpError(400, 'A workspace needs at least one owner');
  db.prepare(`UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?`).run(body.role, ctx.workspace.id, p.userId);
  return { ok: true };
}, { role: 'owner' });

on('DELETE', '/api/workspace/members/:userId', (ctx, p) => {
  if (!ownersLeft(ctx.workspace.id, p.userId)) throw new HttpError(400, 'A workspace needs at least one owner');
  db.prepare(`DELETE FROM members WHERE workspace_id = ? AND user_id = ?`).run(ctx.workspace.id, p.userId);
  return { ok: true };
}, { role: 'owner' });

// Meetings
on('GET', '/api/meetings', (ctx, p, body, req) => {
  const u = new URL(req.url, 'http://x').searchParams;
  const where = ['m.workspace_id = ?'];
  const args = [ctx.workspace.id];
  if (u.get('folder') === 'none') where.push('m.folder_id IS NULL');
  else if (u.get('folder')) { where.push('m.folder_id = ?'); args.push(u.get('folder')); }
  if (u.get('type')) { where.push('m.meeting_type = ?'); args.push(u.get('type')); }
  if (u.get('q')) {
    where.push(`(m.title LIKE ? OR m.summary LIKE ? OR EXISTS (SELECT 1 FROM utterances x WHERE x.meeting_id = m.id AND x.text LIKE ?))`);
    const like = `%${u.get('q').replace(/[%_]/g, '')}%`;
    args.push(like, like, like);
  }
  const sql = `SELECT m.id, m.title, m.url, m.platform, m.status, m.error, m.recording, m.created_at, m.started_at, m.ended_at,
                 m.folder_id, m.filed_by, m.meeting_type, m.tags, f.name AS folder_name, f.color AS folder_color,
                 json_extract(m.summary, '$.title') AS ai_title,
                 (SELECT COUNT(*) FROM utterances x WHERE x.meeting_id = m.id) AS utterance_count,
                 (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id = m.id AND t.status = 'open') AS open_tasks
               FROM meetings m LEFT JOIN folders f ON f.id = m.folder_id
               WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT 300`;
  return db.prepare(sql).all(...args).map((m) => ({ ...m, tags: m.tags ? JSON.parse(m.tags) : [], live: bots.has(m.id) }));
});

on('POST', '/api/meetings', (ctx, p, body) => {
  let platform;
  try { platform = detectPlatform(body.url); } catch {}
  if (!platform) throw new HttpError(400, 'Paste a Google Meet or Zoom link');
  const id = newId();
  q.insertMeeting.run(id, ctx.workspace.id, ctx.user.id, str(body.title, 120) || null, str(body.url, 500), platform, str(body.botName, 40) || wsBotName(ctx.workspace.id));
  if (body.folder_id) q.setFiling.run(checkFolder(ctx, body.folder_id), 'user', null, null, id);
  launchBot(id);
  return meetingDetail(q.getMeeting.get(id));
}, { role: 'member' });

on('GET', '/api/meetings/:id', (ctx, p) => meetingDetail(ownMeeting(ctx, p.id)));

on('PATCH', '/api/meetings/:id', (ctx, p, body) => {
  const m = ownMeeting(ctx, p.id);
  if ('title' in body) db.prepare(`UPDATE meetings SET title = ? WHERE id = ?`).run(str(body.title, 120) || null, m.id);
  if ('meeting_type' in body) {
    if (body.meeting_type && !MEETING_TYPES.includes(body.meeting_type)) throw new HttpError(400, 'Unknown meeting type');
    db.prepare(`UPDATE meetings SET meeting_type = ? WHERE id = ?`).run(body.meeting_type || null, m.id);
  }
  if ('folder_id' in body) {
    const folderId = checkFolder(ctx, body.folder_id);
    db.prepare(`UPDATE meetings SET folder_id = ?, filed_by = 'user' WHERE id = ?`).run(folderId, m.id);
    // "Always file meetings with these people here": one rule per speaker.
    if (folderId && body.remember) {
      for (const { speaker } of q.speakers.all(m.id)) {
        if (speaker !== m.bot_name) q.insertRule.run(ctx.workspace.id, folderId, 'participant', speaker);
      }
      // Plus outside companies from the calendar invite (gmail etc. are too generic to mean anything).
      for (const d of externalDomains(m, ctx)) q.insertRule.run(ctx.workspace.id, folderId, 'domain', d);
    }
  }
  return meetingDetail(q.getMeeting.get(m.id));
}, { role: 'member' });

on('GET', '/api/meetings/:id/transcript', (ctx, p, body, req, res) => {
  const m = ownMeeting(ctx, p.id);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="transcript-${m.id}.txt"` });
  res.end(transcriptText(q.utterances.all(m.id)));
});

on('POST', '/api/meetings/:id/stop', (ctx, p) => {
  const m = ownMeeting(ctx, p.id);
  if (!bots.has(m.id)) throw new HttpError(409, 'Bot is not running');
  q.setStatus.run('stopping', null, m.id);
  return { ok: true };
}, { role: 'member' });

// Re-run transcription fallback + notes + tasks + filing (e.g. after adding an API key).
on('POST', '/api/meetings/:id/notes', (ctx, p) => {
  const m = ownMeeting(ctx, p.id);
  if (bots.has(m.id)) throw new HttpError(409, 'Meeting is still running');
  finishMeeting(m.id, (msg) => q.addEvent.run(m.id, msg), (s, e = null) => q.setStatus.run(s, e, m.id));
  return { ok: true };
}, { role: 'member' });

on('DELETE', '/api/meetings/:id', async (ctx, p) => {
  const m = ownMeeting(ctx, p.id);
  bots.get(m.id)?.kill();
  if (m.recording) await rm(join(REC_DIR, m.recording), { force: true });
  q.deleteMeeting.run(m.id);
  return { ok: true };
}, { role: 'member' });

// Calendar (per user; events go to the workspace chosen for the account)
const calAccount = db.prepare(`SELECT g.email, g.auto_join, g.workspace_id, g.synced_at, g.sync_error, w.name AS workspace_name
                               FROM google_accounts g LEFT JOIN workspaces w ON w.id = g.workspace_id WHERE g.user_id = ?`);
on('GET', '/api/calendar', (ctx) => {
  const account = calAccount.get(ctx.user.id);
  if (!account) return { enabled: cal.googleEnabled(), connected: false, events: [] };
  const events = db.prepare(`
    SELECT e.*, m.status AS meeting_status FROM calendar_events e LEFT JOIN meetings m ON m.id = e.meeting_id
    WHERE e.user_id = ? AND e.end_at > ? AND e.cancelled = 0 ORDER BY e.start_at LIMIT 200`).all(ctx.user.id, Date.now());
  return {
    enabled: true, connected: true, account,
    events: events.map((e) => ({ ...e, attendees: JSON.parse(e.attendees || '[]'), will_join: cal.wantsBot(e, account.auto_join), rule_join: cal.wantsBot({ ...e, override: null }, account.auto_join) })),
  };
}, { noWorkspace: true });

on('PATCH', '/api/calendar', (ctx, p, body) => {
  if (!calAccount.get(ctx.user.id)) throw new HttpError(404, 'Connect Google Calendar first');
  if (body.auto_join) {
    if (!['all', 'accepted', 'organizer', 'off'].includes(body.auto_join)) throw new HttpError(400, 'Unknown auto-join setting');
    db.prepare(`UPDATE google_accounts SET auto_join = ? WHERE user_id = ?`).run(body.auto_join, ctx.user.id);
  }
  if (body.workspace_id) {
    if (!['owner', 'member'].includes(auth.roleIn(body.workspace_id, ctx.user.id))) throw new HttpError(403, 'You need to be a member of that workspace');
    db.prepare(`UPDATE google_accounts SET workspace_id = ? WHERE user_id = ?`).run(body.workspace_id, ctx.user.id);
  }
  return { ok: true };
}, { noWorkspace: true });

on('POST', '/api/calendar/sync', async (ctx) => { await cal.syncUser(ctx.user.id); return { ok: true }; }, { noWorkspace: true });
on('DELETE', '/api/calendar', async (ctx) => { await cal.disconnect(ctx.user.id); return { ok: true }; }, { noWorkspace: true });

const calEvent = (ctx, id) => {
  const e = db.prepare(`SELECT * FROM calendar_events WHERE user_id = ? AND event_id = ?`).get(ctx.user.id, id);
  if (!e) throw new HttpError(404, 'Event not found');
  return e;
};
on('PATCH', '/api/calendar/events/:id', (ctx, p, body) => {
  calEvent(ctx, p.id);
  const override = body.override === 1 || body.override === 0 ? body.override : null;
  db.prepare(`UPDATE calendar_events SET override = ? WHERE user_id = ? AND event_id = ?`).run(override, ctx.user.id, p.id);
  return { ok: true };
}, { noWorkspace: true });

// "Send bot now" for a calendar meeting (e.g. it already started).
on('POST', '/api/calendar/events/:id/send', (ctx, p) => {
  const e = calEvent(ctx, p.id);
  if (!e.url) throw new HttpError(400, 'This event has no Meet or Zoom link');
  if (e.meeting_id && bots.has(e.meeting_id)) throw new HttpError(409, 'The bot is already in this meeting');
  const id = cal.sendBot(e, launchBot, ctx.workspace.id);
  db.prepare(`UPDATE calendar_events SET meeting_id = ? WHERE user_id = ? AND event_id = ?`).run(id, ctx.user.id, p.id);
  return { id };
}, { role: 'member' });

// Folders
on('GET', '/api/folders', (ctx) => ({
  folders: q.folders.all(ctx.workspace.id),
  unfiled: db.prepare(`SELECT COUNT(*) AS n FROM meetings WHERE workspace_id = ? AND folder_id IS NULL`).get(ctx.workspace.id).n,
  rules: q.rules.all(ctx.workspace.id),
}));

on('POST', '/api/folders', (ctx, p, body) => {
  const name = str(body.name, 60);
  if (!name) throw new HttpError(400, 'Name the folder');
  if (q.folderByName.get(ctx.workspace.id, name)) throw new HttpError(409, 'A folder with that name exists');
  const id = newId();
  q.insertFolder.run(id, ctx.workspace.id, name, COLORS.includes(body.color) ? body.color : 'blue');
  if (str(body.keyword)) q.insertRule.run(ctx.workspace.id, id, 'keyword', str(body.keyword, 60));
  return { id };
}, { role: 'member' });

// Folder overview: stats, progress, the AI's account summary, open tasks, meeting timeline.
on('GET', '/api/folders/:id/overview', (ctx, p) => {
  const f = ownRow('folders', ctx, p.id);
  const meetings = db.prepare(`SELECT id, title, json_extract(summary, '$.title') AS ai_title, json_extract(summary, '$.summary') AS ai_summary,
      meeting_type, created_at, status FROM meetings WHERE folder_id = ? ORDER BY created_at DESC`).all(f.id);
  const tasks = db.prepare(`SELECT t.*, u.name AS assignee_name, json_extract(m.summary, '$.title') AS meeting_ai_title, m.title AS meeting_title, m.created_at AS meeting_date
      FROM tasks t JOIN meetings m ON m.id = t.meeting_id LEFT JOIN users u ON u.id = t.assignee_id WHERE m.folder_id = ? ORDER BY t.status, t.created_at DESC`).all(f.id);
  const done = tasks.filter((t) => t.status === 'done').length;
  return {
    folder: { id: f.id, name: f.name, color: f.color },
    stats: { meetings: meetings.length, tasks: tasks.length, done, open: tasks.length - done, first: meetings.at(-1)?.created_at || null, last: meetings[0]?.created_at || null },
    overview: f.overview ? JSON.parse(f.overview) : null,
    overview_at: f.overview_at,
    meetings, tasks,
  };
});

on('POST', '/api/folders/:id/overview', async (ctx, p) => {
  const f = ownRow('folders', ctx, p.id);
  if (!aiFor(ctx.workspace.id).apiKey) throw new HttpError(400, 'Add an AI key in Settings → AI to write overviews');
  const overview = await refreshFolderOverview(f.id);
  if (!overview) throw new HttpError(400, 'No meetings with notes in this folder yet');
  return { ok: true };
}, { role: 'member' });

on('PATCH', '/api/folders/:id', (ctx, p, body) => {
  const f = ownRow('folders', ctx, p.id);
  const name = 'name' in body ? str(body.name, 60) : f.name;
  if (!name) throw new HttpError(400, 'Name the folder');
  const color = COLORS.includes(body.color) ? body.color : f.color;
  try { db.prepare(`UPDATE folders SET name = ?, color = ? WHERE id = ?`).run(name, color, f.id); }
  catch { throw new HttpError(409, 'A folder with that name exists'); }
  if (str(body.keyword)) q.insertRule.run(ctx.workspace.id, f.id, 'keyword', str(body.keyword, 60));
  return { ok: true };
}, { role: 'member' });

on('DELETE', '/api/folders/:id', (ctx, p) => {
  const f = ownRow('folders', ctx, p.id);
  db.prepare(`DELETE FROM folders WHERE id = ?`).run(f.id); // meetings fall back to Unfiled
  return { ok: true };
}, { role: 'member' });

on('DELETE', '/api/rules/:id', (ctx, p) => {
  db.prepare(`DELETE FROM folder_rules WHERE id = ? AND workspace_id = ?`).run(p.id, ctx.workspace.id);
  return { ok: true };
}, { role: 'member' });

// AI settings (per workspace): provider, model, API key, automatic tasks.
const aiRow = db.prepare(`SELECT * FROM ai_settings WHERE workspace_id = ?`);
on('GET', '/api/ai', (ctx) => {
  const ai = aiFor(ctx.workspace.id);
  return {
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => {
      const saved = savedKey(ctx.workspace.id, k) || (k === ai.provider && ai.keySource === 'settings' ? ai.apiKey : null);
      return [k, { label: p.label, models: p.models, keyHint: p.keyHint, serverKey: Boolean(process.env[p.envKey]), savedKey: saved ? maskKey(saved) : null }];
    })),
    provider: ai.provider, model: ai.model, autoTasks: ai.autoTasks,
    key: PROVIDERS[ai.provider] && ai.keySource === 'settings' ? maskKey(ai.apiKey) : null, keySource: ai.keySource,
  };
});

on('PATCH', '/api/ai', (ctx, p, body) => {
  const cur = aiRow.get(ctx.workspace.id) || { provider: 'anthropic', model: null, api_key: null, auto_tasks: 1 };
  const provider = body.provider ?? cur.provider;
  if (!PROVIDERS[provider]) throw new HttpError(400, 'Unknown AI provider');
  const switched = provider !== cur.provider;
  const model = 'model' in body ? str(body.model, 80) || null : switched ? null : cur.model;
  const autoTasks = 'auto_tasks' in body ? (body.auto_tasks ? 1 : 0) : cur.auto_tasks;
  // Move an older single saved key into the per-provider table.
  if (cur.api_key) {
    db.prepare(`INSERT OR IGNORE INTO ai_keys (workspace_id, provider, api_key) VALUES (?, ?, ?)`).run(ctx.workspace.id, cur.provider, cur.api_key);
  }
  if (body.clear_key) db.prepare(`DELETE FROM ai_keys WHERE workspace_id = ? AND provider = ?`).run(ctx.workspace.id, provider);
  if (typeof body.api_key === 'string' && body.api_key.trim()) {
    db.prepare(`INSERT INTO ai_keys (workspace_id, provider, api_key) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET api_key = excluded.api_key`)
      .run(ctx.workspace.id, provider, seal(body.api_key.trim()));
  }
  db.prepare(`INSERT INTO ai_settings (workspace_id, provider, model, api_key, auto_tasks) VALUES (?, ?, ?, NULL, ?)
              ON CONFLICT (workspace_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, api_key = NULL, auto_tasks = excluded.auto_tasks`)
    .run(ctx.workspace.id, provider, model, autoTasks);
  return { ok: true };
}, { role: 'owner' });

// "Test connection": the typed key if given, else the saved/server key.
on('POST', '/api/ai/test', async (ctx, p, body) => {
  const base = aiFor(ctx.workspace.id);
  const provider = PROVIDERS[body.provider] ? body.provider : base.provider;
  const typed = typeof body.api_key === 'string' && body.api_key.trim();
  const ai = {
    provider,
    model: str(body.model, 80) || (provider === base.provider ? base.model : PROVIDERS[provider].models[0]),
    apiKey: typed || savedKey(ctx.workspace.id, provider) || (provider === base.provider ? base.apiKey : process.env[PROVIDERS[provider].envKey]) || null,
  };
  try {
    const out = await testAI(ai);
    return { ok: true, message: `Connected: ${PROVIDERS[provider].label}, model ${ai.model}${out.model ? ` (says it is ${out.model})` : ''}` };
  } catch (err) {
    throw new HttpError(400, err.message.slice(0, 300));
  }
}, { role: 'owner' });

// Demo clients (files in demos/; the open-source repo ships none)
on('GET', '/api/demos', (ctx) => ({ demos: demos.listDemos(), status: demos.demoStatus(ctx.workspace.id) }), { role: 'owner' });
on('POST', '/api/demos/:name/load', (ctx, p) => {
  if (!aiFor(ctx.workspace.id).apiKey) throw new HttpError(400, 'Add an AI key in Settings → AI first: the demo meetings are written by the AI');
  try { return demos.loadDemo(p.name, { workspaceId: ctx.workspace.id, userId: ctx.user.id, botName: wsBotName(ctx.workspace.id) }); }
  catch (err) { throw new HttpError(400, err.message); }
}, { role: 'owner' });

// Ask AI assistant (chats are private to each user)
on('POST', '/api/assistant', async (ctx, p, body) => {
  const message = str(body.message, 4000);
  if (!message) throw new HttpError(400, 'Ask something');
  const scope = ['meeting', 'folder'].includes(body.scope?.type) && typeof body.scope.id === 'string' ? { type: body.scope.type, id: body.scope.id } : { type: 'all' };
  if (!aiFor(ctx.workspace.id).apiKey) throw new HttpError(400, 'Add an AI key in Settings → AI to use Ask AI');
  try {
    return await assistant.ask({ workspaceId: ctx.workspace.id, userId: ctx.user.id, brandName: BRAND.name, chatId: body.chatId, scope, message });
  } catch (err) {
    if (err.status) throw new HttpError(err.status, err.message);
    throw new HttpError(502, err.message.slice(0, 300));
  }
});
on('GET', '/api/assistant/chats', (ctx) => assistant.listChats(ctx.user.id, ctx.workspace.id));
on('GET', '/api/assistant/chats/:id', (ctx, p) => assistant.getChat(ctx.user.id, p.id) || (() => { throw new HttpError(404, 'Chat not found'); })());
on('DELETE', '/api/assistant/chats/:id', (ctx, p) => { assistant.deleteChat(ctx.user.id, p.id); return { ok: true }; });

// Tasks
on('POST', '/api/tasks/bulk', (ctx, p, body) => {
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 1000) : [];
  if (!ids.length) throw new HttpError(400, 'Select some tasks first');
  const marks = ids.map(() => '?').join(',');
  const args = [...ids, ctx.workspace.id];
  if (body.action === 'delete') db.prepare(`DELETE FROM tasks WHERE id IN (${marks}) AND workspace_id = ?`).run(...args);
  else if (body.action === 'done') db.prepare(`UPDATE tasks SET status = 'done', source = 'user', done_at = COALESCE(done_at, datetime('now')) WHERE id IN (${marks}) AND workspace_id = ?`).run(...args);
  else if (body.action === 'open') db.prepare(`UPDATE tasks SET status = 'open', source = 'user', done_at = NULL WHERE id IN (${marks}) AND workspace_id = ?`).run(...args);
  else throw new HttpError(400, 'Unknown action');
  return { ok: true, count: ids.length };
}, { role: 'member' });

on('DELETE', '/api/meetings/:id/tasks', (ctx, p) => {
  const m = ownMeeting(ctx, p.id);
  const r = db.prepare(`DELETE FROM tasks WHERE meeting_id = ?`).run(m.id);
  return { ok: true, count: r.changes };
}, { role: 'member' });

on('GET', '/api/tasks', (ctx, p, body, req) => {
  const u = new URL(req.url, 'http://x').searchParams;
  const where = ['t.workspace_id = ?'];
  const args = [ctx.workspace.id];
  const status = u.get('status') || 'open';
  if (status !== 'all') { where.push('t.status = ?'); args.push(status); }
  if (u.get('mine') === '1') { where.push('t.assignee_id = ?'); args.push(ctx.user.id); }
  if (u.get('meeting')) { where.push('t.meeting_id = ?'); args.push(u.get('meeting')); }
  if (u.get('folder')) { where.push('m.folder_id = ?'); args.push(u.get('folder')); }
  return db.prepare(`
    SELECT t.*, u.name AS assignee_name, m.title AS meeting_title, json_extract(m.summary, '$.title') AS meeting_ai_title,
           m.created_at AS meeting_date, f.name AS folder_name, f.color AS folder_color
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN meetings m ON m.id = t.meeting_id
    LEFT JOIN folders f ON f.id = m.folder_id
    WHERE ${where.join(' AND ')} ORDER BY t.status, t.created_at DESC LIMIT 500`).all(...args);
});

on('POST', '/api/tasks', (ctx, p, body) => {
  const title = str(body.title, 300);
  if (!title) throw new HttpError(400, 'Write the task');
  if (body.meeting_id) ownMeeting(ctx, body.meeting_id);
  const id = newId();
  q.insertTask.run(id, ctx.workspace.id, body.meeting_id || null, title, null, checkAssignee(ctx, body.assignee_id), str(body.due, 40) || null, null, 'user');
  return { id };
}, { role: 'member' });

on('PATCH', '/api/tasks/:id', (ctx, p, body) => {
  const t = ownRow('tasks', ctx, p.id);
  const next = {
    title: 'title' in body ? str(body.title, 300) || t.title : t.title,
    due: 'due' in body ? str(body.due, 40) || null : t.due,
    assignee_id: 'assignee_id' in body ? checkAssignee(ctx, body.assignee_id) : t.assignee_id,
    status: body.status === 'done' || body.status === 'open' ? body.status : t.status,
  };
  // Any edit makes it the user's task, so "Redo notes" won't overwrite it.
  db.prepare(`UPDATE tasks SET title = ?, due = ?, assignee_id = ?, status = ?, source = 'user',
              done_at = CASE WHEN ? = 'done' THEN COALESCE(done_at, datetime('now')) ELSE NULL END WHERE id = ?`)
    .run(next.title, next.due, next.assignee_id, next.status, next.status, t.id);
  return { ok: true };
}, { role: 'member' });

on('DELETE', '/api/tasks/:id', (ctx, p) => {
  ownRow('tasks', ctx, p.id);
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(p.id);
  return { ok: true };
}, { role: 'member' });

// ---------- server ----------
function serveRecording(req, res, ctx, file) {
  const m = db.prepare(`SELECT workspace_id FROM meetings WHERE recording = ?`).get(file);
  const path = join(REC_DIR, file);
  if (!ctx?.workspace || !m || m.workspace_id !== ctx.workspace.id || !/^[\w-]+\.webm$/.test(file) || !existsSync(path)) {
    return json(res, 404, { error: 'Not found' });
  }
  const size = statSync(path).size;
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': size });
  createReadStream(path).pipe(res);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const ctx = auth.currentUser(req);

  if (path.startsWith('/api/')) {
    // Mutations must be JSON: blocks cross-site form posts riding on the cookie.
    if (req.method !== 'GET' && !String(req.headers['content-type']).startsWith('application/json')) {
      throw new HttpError(415, 'Send JSON');
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.re.exec(path);
      if (!match) continue;
      if (!r.opts.public) {
        if (!ctx) throw new HttpError(401, 'Sign in first');
        if (!r.opts.noWorkspace && !ctx.workspace) throw new HttpError(400, 'Create a workspace first');
        if (r.opts.role) requireRole(ctx, r.opts.role);
      }
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await r.handler(ctx, params, body, req, res);
      if (!res.headersSent) json(res, 200, out ?? { ok: true });
      return;
    }
    throw new HttpError(404, 'Not found');
  }

  const rec = path.match(/^\/recordings\/([^/]+)$/);
  if (rec) return serveRecording(req, res, ctx, rec[1]);

  // Static assets, else the single-page app (it routes on the client).
  const file = path.slice(1);
  if (file && !file.includes('..') && extname(file) && extname(file) !== '.html') {
    const data = await readFile(join(PUBLIC, file)).catch(() => null);
    if (data) { res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }); return res.end(data); }
    return json(res, 404, { error: 'Not found' });
  }
  res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
  const html = await readFile(join(PUBLIC, 'app.html'), 'utf8');
  res.end(html.replace('<title>Meeting Bot</title>', brandHead(BRAND)));
}

createServer((req, res) => handle(req, res).catch((err) => {
  if (!(err instanceof HttpError)) console.error(err);
  if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong' });
})).listen(PORT, () => {
  console.log(`Meeting bot dashboard on http://localhost:${PORT}`);
  cal.startScheduler(launchBot);
});
