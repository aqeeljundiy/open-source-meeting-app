// Accounts: email + password (scrypt), cookie sessions, workspaces and roles.
import { scryptSync, randomBytes, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { db } from './db.mjs';

const SESSION_DAYS = 30;
const COOKIE = 'mb_session';
export const ROLES = ['owner', 'member', 'viewer'];
export const newId = () => randomUUID().replace(/-/g, '').slice(0, 10);
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function checkPassword(pw, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const a = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(a, Buffer.from(hash, 'hex'));
}

const st = {
  userByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
  insertUser: db.prepare(`INSERT INTO users (id, email, name, pass_hash) VALUES (?, ?, ?, ?)`),
  insertWorkspace: db.prepare(`INSERT INTO workspaces (id, name) VALUES (?, ?)`),
  insertMember: db.prepare(`INSERT OR IGNORE INTO members (workspace_id, user_id, role) VALUES (?, ?, ?)`),
  invitesFor: db.prepare(`SELECT * FROM invites WHERE email = ?`),
  deleteInvite: db.prepare(`DELETE FROM invites WHERE workspace_id = ? AND email = ?`),
  insertSession: db.prepare(`INSERT INTO sessions (token, user_id, workspace_id, expires_at) VALUES (?, ?, ?, datetime('now', '+${SESSION_DAYS} days'))`),
  session: db.prepare(`SELECT s.token, s.workspace_id, u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
                       WHERE s.token = ? AND s.expires_at > datetime('now')`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),
  setSessionWs: db.prepare(`UPDATE sessions SET workspace_id = ? WHERE token = ?`),
  workspacesOf: db.prepare(`SELECT w.id, w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at`),
  role: db.prepare(`SELECT role FROM members WHERE workspace_id = ? AND user_id = ?`),
};

export function createWorkspace(name, ownerId) {
  const id = newId();
  st.insertWorkspace.run(id, name);
  st.insertMember.run(id, ownerId, 'owner');
  return id;
}

// New user's home: a personal workspace, or in single-workspace mode the one company
// space (created by the first account; later accounts arrive through invites).
export const singleMode = () => process.env.SINGLE_WORKSPACE === '1';
export function homeWorkspace(userId, name) {
  if (!singleMode()) return createWorkspace(`${name.split(/\s+/)[0]}'s workspace`, userId);
  const first = db.prepare(`SELECT id FROM workspaces ORDER BY created_at LIMIT 1`).get();
  if (!first) return createWorkspace(process.env.BRAND_DISPLAY_NAME || 'Workspace', userId);
  // Open sign-up in single mode: join the company space as a member.
  if (!st.role.get(first.id, userId)) st.insertMember.run(first.id, userId, 'member');
  return first.id;
}

export function signup({ email, name, password }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
  if (!name) throw new HttpError(400, 'Enter your name');
  if (String(password || '').length < 8) throw new HttpError(400, 'Password needs at least 8 characters');
  if (st.userByEmail.get(email)) throw new HttpError(409, 'An account with this email already exists');
  if (!emailAllowed(email)) throw new HttpError(403, domainError());
  if (!signupAllowed(email)) throw new HttpError(403, 'Sign-up is invite-only. Ask a workspace owner to invite this email.');
  const id = newId();
  st.insertUser.run(id, email, name, hashPassword(password));
  // Accept pending invites; everyone also gets a personal workspace.
  for (const inv of st.invitesFor.all(email)) {
    st.insertMember.run(inv.workspace_id, id, inv.role);
    st.deleteInvite.run(inv.workspace_id, email);
  }
  homeWorkspace(id, name);
  return id;
}

// The first account can always sign up; after that only invited emails, unless OPEN_SIGNUP=1.
const countUsers = db.prepare(`SELECT COUNT(*) AS n FROM users`);
const hasInvite = db.prepare(`SELECT 1 FROM invites WHERE email = ?`);
// ALLOWED_EMAIL_DOMAINS=example.com,other.com locks every sign-in method to those domains.
export const allowedDomains = () => (process.env.ALLOWED_EMAIL_DOMAINS || '').toLowerCase().split(',').map((d) => d.trim().replace(/^@/, '')).filter(Boolean);
export function emailAllowed(email) {
  const domains = allowedDomains();
  return !domains.length || domains.includes(String(email).toLowerCase().split('@')[1]);
}
export const domainError = () => `Only ${allowedDomains().map((d) => `@${d}`).join(' / ')} accounts can use this app`;

// Who may create an account: anyone with OPEN_SIGNUP=1; the very first account; invited emails;
// and, when ALLOWED_EMAIL_DOMAINS is set, anyone from those company domains (no invite needed).
export function signupAllowed(email) {
  return process.env.OPEN_SIGNUP === '1' || countUsers.get().n === 0 || Boolean(hasInvite.get(email.toLowerCase()))
    || (allowedDomains().length > 0 && emailAllowed(email));
}

export function login({ email, password }) {
  if (!emailAllowed(String(email || '').trim())) throw new HttpError(403, domainError());
  const u = st.userByEmail.get(String(email || '').trim().toLowerCase());
  if (!u || !checkPassword(String(password || ''), u.pass_hash)) throw new HttpError(401, 'Wrong email or password');
  return u.id;
}

export function startSession(res, userId) {
  const raw = randomBytes(32).toString('base64url');
  const ws = st.workspacesOf.all(userId)[0]?.id || null;
  st.insertSession.run(sha(raw), userId, ws);
  setCookie(res, `${COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
}

export function endSession(req, res) {
  const raw = readCookie(req);
  if (raw) st.deleteSession.run(sha(raw));
  setCookie(res, `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Returns { user, workspace: {id, name, role}, workspaces, token } or null.
export function currentUser(req) {
  const raw = readCookie(req);
  if (!raw) return null;
  const s = st.session.get(sha(raw));
  if (!s) return null;
  const workspaces = st.workspacesOf.all(s.id);
  let workspace = workspaces.find((w) => w.id === s.workspace_id) || workspaces[0] || null;
  if (workspace && workspace.id !== s.workspace_id) st.setSessionWs.run(workspace.id, s.token);
  return { user: { id: s.id, email: s.email, name: s.name }, workspace, workspaces, token: s.token };
}

export function switchWorkspace(ctx, wsId) {
  if (!ctx.workspaces.some((w) => w.id === wsId)) throw new HttpError(403, 'Not a member of that workspace');
  st.setSessionWs.run(wsId, ctx.token);
}

export function roleIn(wsId, userId) {
  return st.role.get(wsId, userId)?.role || null;
}

// viewer < member < owner
export function requireRole(ctx, min) {
  if (!ctx?.workspace) throw new HttpError(401, 'Sign in first');
  if (ROLES.indexOf(ctx.workspace.role) > ROLES.indexOf(min)) {
    throw new HttpError(403, min === 'owner' ? 'Only workspace owners can do that' : 'Viewers can only look');
  }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readCookie(req) {
  return (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || null;
}
function setCookie(res, value) {
  res.setHeader('Set-Cookie', value);
}
