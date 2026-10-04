// Google sign-in (OAuth 2.0 code flow, no SDK) + Calendar sync + auto-join scheduler.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { db, q, detectPlatform } from './db.mjs';
import { homeWorkspace, signupAllowed, emailAllowed, domainError, allowedDomains } from './auth.mjs';

// Sign-in asks only for basic profile scopes (no Google review needed, so the Google app can be
// published for everyone). Calendar access is asked separately, only when connecting a calendar.
const LOGIN_SCOPES = ['openid', 'email', 'profile'];
const CALENDAR_SCOPES = [...LOGIN_SCOPES, 'https://www.googleapis.com/auth/calendar.events.readonly'];
const SYNC_EVERY_MS = 3 * 60_000;
const LOOKAHEAD_MS = 7 * 86400_000;
const JOIN_LEAD_MS = 60_000;          // send the bot 1 minute before start
const JOIN_LATE_MS = 10 * 60_000;     // still join if we're up to 10 minutes late

export const googleEnabled = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const baseUrl = () => (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4350}`).replace(/\/$/, '');
export const redirectUri = () => `${baseUrl()}/api/auth/google/callback`;
const newId = () => randomUUID().replace(/-/g, '').slice(0, 10);

// ---------- token encryption at rest (AES-256-GCM, key derived from TOKEN_KEY or the client secret) ----------
const key = () => createHash('sha256').update(process.env.TOKEN_KEY || `mb:${process.env.GOOGLE_CLIENT_SECRET}`).digest();
function seal(text) {
  if (!text) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
function open(sealed) {
  if (!sealed) return null;
  const [iv, tag, enc] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---------- OAuth ----------
export function authUrl(state, { calendar = false } = {}) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: (calendar ? CALENDAR_SCOPES : LOGIN_SCOPES).join(' '),
    // Calendar needs a refresh token (offline + consent); plain sign-in doesn't.
    ...(calendar ? { access_type: 'offline', prompt: 'consent' } : { prompt: 'select_account' }),
    include_granted_scopes: 'true',
    // Show only accounts from the company domain in Google's account picker.
    ...(allowedDomains().length === 1 ? { hd: allowedDomains()[0] } : {}),
    state,
  });
  return u.toString();
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(`Google: ${data.error_description || data.error || res.status}`), { code: data.error });
  return data;
}

// Exchange the callback code; returns { profile: {sub, email, name, email_verified}, tokens }.
export async function exchangeCode(code) {
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!res.ok) throw new Error('Google did not return your profile');
  return { profile: await res.json(), tokens };
}

const st = {
  userBySub: db.prepare(`SELECT * FROM users WHERE google_sub = ?`),
  userByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
  setSub: db.prepare(`UPDATE users SET google_sub = ? WHERE id = ?`),
  insertUser: db.prepare(`INSERT INTO users (id, email, name, google_sub) VALUES (?, ?, ?, ?)`),
  invitesFor: db.prepare(`SELECT * FROM invites WHERE email = ?`),
  addMember: db.prepare(`INSERT OR IGNORE INTO members (workspace_id, user_id, role) VALUES (?, ?, ?)`),
  deleteInvite: db.prepare(`DELETE FROM invites WHERE workspace_id = ? AND email = ?`),
  account: db.prepare(`SELECT * FROM google_accounts WHERE user_id = ?`),
  upsertAccount: db.prepare(`
    INSERT INTO google_accounts (user_id, email, refresh_token, access_token, expires_at, scope, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET email = excluded.email,
      refresh_token = COALESCE(excluded.refresh_token, google_accounts.refresh_token),
      access_token = excluded.access_token, expires_at = excluded.expires_at, scope = excluded.scope,
      workspace_id = COALESCE(google_accounts.workspace_id, excluded.workspace_id), sync_error = NULL`),
  firstWorkspace: db.prepare(`SELECT workspace_id FROM members WHERE user_id = ? ORDER BY rowid LIMIT 1`),
};

// Sign in or link. `currentUserId` set = linking Google to an existing signed-in account.
export function finishGoogleLogin({ profile, tokens }, currentUserId) {
  if (!profile.email_verified) throw new Error('Your Google email is not verified');
  // hd in the URL is only a hint; enforce the domain on the verified email.
  if (!emailAllowed(profile.email)) throw new Error(domainError());
  const email = profile.email.toLowerCase();
  let user = st.userBySub.get(profile.sub);
  if (currentUserId) {
    if (user && user.id !== currentUserId) throw new Error('That Google account is already linked to another user');
    user = { id: currentUserId };
    st.setSub.run(profile.sub, currentUserId);
  } else if (!user) {
    // Same email as a password account: link them (Google verified the email).
    user = st.userByEmail.get(email);
    if (user) st.setSub.run(profile.sub, user.id);
    else if (!signupAllowed(email)) throw new Error('Sign-up is invite-only. Ask a workspace owner to invite this email.');
    else {
      const id = newId();
      const name = profile.name || email.split('@')[0];
      st.insertUser.run(id, email, name, profile.sub);
      for (const inv of st.invitesFor.all(email)) {
        st.addMember.run(inv.workspace_id, id, inv.role);
        st.deleteInvite.run(inv.workspace_id, email);
      }
      homeWorkspace(id, name);
      user = { id };
    }
  }
  if (tokens.scope?.includes('calendar')) {
    st.upsertAccount.run(user.id, email, seal(tokens.refresh_token), seal(tokens.access_token),
      Date.now() + (tokens.expires_in - 60) * 1000, tokens.scope, st.firstWorkspace.get(user.id)?.workspace_id || null);
    syncUser(user.id).catch((e) => console.error('calendar sync', e.message));
  }
  return user.id;
}

async function accessToken(acc) {
  if (acc.access_token && acc.expires_at > Date.now()) return open(acc.access_token);
  const refresh = open(acc.refresh_token);
  if (!refresh) throw new Error('Calendar disconnected, reconnect Google');
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  db.prepare(`UPDATE google_accounts SET access_token = ?, expires_at = ? WHERE user_id = ?`)
    .run(seal(t.access_token), Date.now() + (t.expires_in - 60) * 1000, acc.user_id);
  return t.access_token;
}

export async function disconnect(userId) {
  const acc = st.account.get(userId);
  if (!acc) return;
  const token = open(acc.refresh_token);
  if (token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
  db.prepare(`DELETE FROM google_accounts WHERE user_id = ?`).run(userId);
  db.prepare(`DELETE FROM calendar_events WHERE user_id = ? AND meeting_id IS NULL`).run(userId);
}

// ---------- Calendar sync ----------
const MEET_RE = /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;
const ZOOM_RE = /https:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|my|w|s)\/[^\s"<>)]+/i;

export function meetingLink(ev) {
  const candidates = [
    ev.hangoutLink,
    ...(ev.conferenceData?.entryPoints || []).filter((e) => e.entryPointType === 'video').map((e) => e.uri),
  ];
  const text = `${ev.location || ''} ${ev.description || ''}`;
  candidates.push(text.match(MEET_RE)?.[0], text.match(ZOOM_RE)?.[0]?.replace(/&amp;/g, '&'));
  for (const url of candidates.filter(Boolean)) {
    try { if (detectPlatform(url)) return url; } catch {}
  }
  return null;
}

const upsertEvent = db.prepare(`
  INSERT INTO calendar_events (user_id, event_id, title, start_at, end_at, url, platform, organizer, is_organizer, response, attendees, cancelled)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id, event_id) DO UPDATE SET title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at,
    url = excluded.url, platform = excluded.platform, organizer = excluded.organizer, is_organizer = excluded.is_organizer,
    response = excluded.response, attendees = excluded.attendees, cancelled = excluded.cancelled`);

export async function syncUser(userId) {
  const acc = st.account.get(userId);
  if (!acc) return;
  try {
    const token = await accessToken(acc);
    const u = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    u.search = new URLSearchParams({
      timeMin: new Date(Date.now() - 2 * 3600_000).toISOString(),
      timeMax: new Date(Date.now() + LOOKAHEAD_MS).toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '250', showDeleted: 'true',
    });
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Calendar ${res.status}`);
    const seen = new Set();
    for (const ev of data.items || []) {
      if (!ev.start?.dateTime) continue; // all-day events have no meeting time
      const url = meetingLink(ev);
      const me = (ev.attendees || []).find((a) => a.self);
      const attendees = (ev.attendees || []).filter((a) => !a.resource).map((a) => ({ email: a.email, name: a.displayName || null }));
      seen.add(ev.id);
      upsertEvent.run(userId, ev.id, ev.summary || '(no title)', Date.parse(ev.start.dateTime), Date.parse(ev.end?.dateTime || ev.start.dateTime),
        url, url ? detectPlatform(url) : null, ev.organizer?.email || null, ev.organizer?.self ? 1 : 0,
        me?.responseStatus || (ev.organizer?.self ? 'accepted' : null), JSON.stringify(attendees), ev.status === 'cancelled' ? 1 : 0);
    }
    // Events that vanished from the window (deleted, moved far away) without a bot: drop them.
    const future = db.prepare(`SELECT event_id FROM calendar_events WHERE user_id = ? AND start_at > ? AND meeting_id IS NULL`).all(userId, Date.now());
    for (const { event_id } of future) if (!seen.has(event_id)) db.prepare(`DELETE FROM calendar_events WHERE user_id = ? AND event_id = ?`).run(userId, event_id);
    db.prepare(`UPDATE google_accounts SET synced_at = datetime('now'), sync_error = NULL WHERE user_id = ?`).run(userId);
  } catch (err) {
    db.prepare(`UPDATE google_accounts SET sync_error = ? WHERE user_id = ?`).run(err.message, userId);
    throw err;
  }
}

// Should the bot join this event on its own?
export function wantsBot(ev, mode) {
  if (!ev.url || ev.cancelled || ev.response === 'declined') return false;
  if (ev.override !== null && ev.override !== undefined) return ev.override === 1;
  if (mode === 'all') return true;
  if (mode === 'organizer') return Boolean(ev.is_organizer);
  if (mode === 'accepted') return Boolean(ev.is_organizer) || ev.response === 'accepted';
  return false;
}

// ---------- scheduler ----------
export function startScheduler(launch) {
  if (!googleEnabled()) return;
  const syncAll = async () => {
    for (const { user_id } of db.prepare(`SELECT user_id FROM google_accounts`).all()) {
      await syncUser(user_id).catch((e) => console.error(`calendar sync ${user_id}: ${e.message}`));
    }
  };
  const tick = () => {
    const now = Date.now();
    const due = db.prepare(`
      SELECT e.*, g.auto_join, g.workspace_id FROM calendar_events e JOIN google_accounts g ON g.user_id = e.user_id
      WHERE e.meeting_id IS NULL AND e.start_at BETWEEN ? AND ?`).all(now - JOIN_LATE_MS, now + JOIN_LEAD_MS);
    for (const ev of due) {
      if (!ev.workspace_id || !wantsBot(ev, ev.auto_join)) continue;
      // Two teammates with the same meeting on their calendars: one bot per workspace.
      const dup = db.prepare(`SELECT id FROM meetings WHERE workspace_id = ? AND url = ? AND created_at > datetime('now', '-3 hours')`).get(ev.workspace_id, ev.url);
      const id = dup?.id || sendBot(ev, launch);
      db.prepare(`UPDATE calendar_events SET meeting_id = ? WHERE user_id = ? AND event_id = ?`).run(id, ev.user_id, ev.event_id);
    }
  };
  syncAll();
  setInterval(syncAll, SYNC_EVERY_MS);
  setInterval(tick, 15_000);
}

// Create the meeting row for a calendar event and launch the bot. Returns the meeting id.
export function sendBot(ev, launch, workspaceId = ev.workspace_id) {
  const id = newId();
  const botName = db.prepare(`SELECT bot_name FROM workspaces WHERE id = ?`).get(workspaceId)?.bot_name || process.env.BOT_NAME || 'Notetaker';
  q.insertMeeting.run(id, workspaceId, ev.user_id, ev.title, ev.url, ev.platform, botName);
  db.prepare(`UPDATE meetings SET attendees = ?, calendar_event = ? WHERE id = ?`).run(ev.attendees, `${ev.user_id}:${ev.event_id}`, id);
  q.addEvent.run(id, `Sent from Google Calendar: ${ev.title}`);
  launch(id);
  return id;
}
