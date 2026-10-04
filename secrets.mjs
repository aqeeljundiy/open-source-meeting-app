// Encryption at rest for API keys people paste into Settings.
// Key: TOKEN_KEY env, else a random key generated once into the data folder.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './db.mjs';

let key;
function getKey() {
  if (key) return key;
  if (process.env.TOKEN_KEY) return (key = createHash('sha256').update(process.env.TOKEN_KEY).digest());
  const file = join(DATA_DIR, 'secret.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  return (key = createHash('sha256').update(readFileSync(file, 'utf8').trim()).digest());
}

export function seal(text) {
  if (!text) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function unseal(sealed) {
  if (!sealed) return null;
  try {
    const [iv, tag, enc] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', getKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null;   // key changed or data corrupted: treat as "no key saved"
  }
}

// "sk-ant-api03-abcd…wxyz" style hint, never the full key.
export const maskKey = (k) => (k ? `${k.slice(0, 7)}…${k.slice(-4)}` : null);
