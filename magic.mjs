// Passwordless sign-in: email a one-time link (15 minutes, single use).
// Needs SMTP: SMTP_URL (smtp://user:pass@host:587 or smtps://…:465) or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS, plus MAIL_FROM.
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { db } from './db.mjs';
import { emailAllowed, domainError, signupAllowed, homeWorkspace, HttpError } from './auth.mjs';

const TTL_MIN = 15;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const magicEnabled = () => Boolean((process.env.SMTP_URL || process.env.SMTP_HOST) && process.env.MAIL_FROM);

let transport;
function mailer() {
  if (transport) return transport;
  // SMTP_URL=log: don't send, print the link to the server log (local testing).
  if (process.env.SMTP_URL === 'log') return (transport = { sendMail: async (m) => console.log(`[magic link for ${m.to}] ${m.text.split('\n')[2]}`) });
  transport = process.env.SMTP_URL
    ? nodemailer.createTransport(process.env.SMTP_URL)
    : nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  return transport;
}

const st = {
  insert: db.prepare(`INSERT INTO magic_links (token, email, expires_at) VALUES (?, ?, datetime('now', '+${TTL_MIN} minutes'))`),
  take: db.prepare(`SELECT * FROM magic_links WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')`),
  use: db.prepare(`UPDATE magic_links SET used_at = datetime('now') WHERE token = ?`),
  recent: db.prepare(`SELECT COUNT(*) AS n FROM magic_links WHERE email = ? AND created_at > datetime('now', '-15 minutes')`),
  cleanup: db.prepare(`DELETE FROM magic_links WHERE expires_at < datetime('now', '-1 day')`),
  userByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
  insertUser: db.prepare(`INSERT INTO users (id, email, name) VALUES (?, ?, ?)`),
};

// Send a link. Always answers the same way whether or not the account exists (no email probing).
export async function sendMagicLink(email, { baseUrl, brandName, brandColor }) {
  if (!magicEnabled()) throw new HttpError(400, 'Email sign-in links are not set up on this server');
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
  if (!emailAllowed(email)) throw new HttpError(403, domainError());
  if (!st.userByEmail.get(email) && !signupAllowed(email)) return;   // silently: no account and can't create one
  if (st.recent.get(email).n >= 5) throw new HttpError(429, 'Too many links requested. Try again in a few minutes.');
  st.cleanup.run();
  const raw = randomBytes(32).toString('base64url');
  st.insert.run(sha(raw), email);
  const link = `${baseUrl}/api/auth/magic/verify?token=${raw}`;
  await mailer().sendMail({
    from: process.env.MAIL_FROM,
    to: email,
    subject: `Your ${brandName} sign-in link`,
    text: `Sign in to ${brandName}:\n\n${link}\n\nThis link works once and expires in ${TTL_MIN} minutes. If you didn't ask for it, ignore this email.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:460px;margin:auto;padding:24px;color:#111">
      <h2 style="margin:0 0 8px;font-size:20px">Sign in to ${esc(brandName)}</h2>
      <p style="margin:0 0 20px;color:#555">Click the button to sign in. The link works once and expires in ${TTL_MIN} minutes.</p>
      <a href="${esc(link)}" style="display:inline-block;background:${esc(brandColor)};color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">Sign in</a>
      <p style="margin:24px 0 0;font-size:12px;color:#888">If you didn't ask for this, you can ignore this email.</p></div>`,
  });
}

// Check a link and return the user id to sign in (creating the account if allowed).
export function useMagicLink(raw) {
  const row = raw && st.take.get(sha(raw));
  if (!row) throw new HttpError(400, 'This sign-in link is invalid or expired. Request a new one.');
  st.use.run(row.token);
  if (!emailAllowed(row.email)) throw new HttpError(403, domainError());
  const user = st.userByEmail.get(row.email);
  if (user) return user.id;
  if (!signupAllowed(row.email)) throw new HttpError(403, 'Sign-up is invite-only. Ask a workspace owner to invite this email.');
  const id = randomUUID().replace(/-/g, '').slice(0, 10);
  const name = row.email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  st.insertUser.run(id, row.email, name);
  // Accept pending invites, then the normal home workspace.
  for (const inv of db.prepare(`SELECT * FROM invites WHERE email = ?`).all(row.email)) {
    db.prepare(`INSERT OR IGNORE INTO members (workspace_id, user_id, role) VALUES (?, ?, ?)`).run(inv.workspace_id, id, inv.role);
    db.prepare(`DELETE FROM invites WHERE workspace_id = ? AND email = ?`).run(inv.workspace_id, row.email);
  }
  homeWorkspace(id, name);
  return id;
}
