// SQLite store (Node's built-in node:sqlite, no native deps).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || join(import.meta.dirname, 'data');
export const REC_DIR = join(DATA_DIR, 'recordings');
mkdirSync(REC_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'meetings.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name        TEXT NOT NULL,
    pass_hash   TEXT,                   -- null for Google-only accounts
    google_sub  TEXT UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token        TEXT PRIMARY KEY,      -- sha256 of the cookie value
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT,                  -- currently selected workspace
    expires_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL,          -- owner | member | viewer
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS invites (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email        TEXT NOT NULL COLLATE NOCASE,
    role         TEXT NOT NULL,
    invited_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_id, email)
  );
  CREATE TABLE IF NOT EXISTS folders (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    color        TEXT NOT NULL DEFAULT 'blue',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (workspace_id, name)
  );
  -- "Always file meetings like this here": matched before asking Claude.
  CREATE TABLE IF NOT EXISTS folder_rules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    folder_id    TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,          -- participant | keyword | domain
    value        TEXT NOT NULL COLLATE NOCASE,
    UNIQUE (folder_id, kind, value)
  );
  CREATE TABLE IF NOT EXISTS meetings (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    folder_id    TEXT REFERENCES folders(id) ON DELETE SET NULL,
    filed_by     TEXT,                   -- rule | ai | user
    attendees    TEXT,                   -- JSON [{email, name}] from the calendar event
    calendar_event TEXT,                 -- user_id:event_id that launched it
    meeting_type TEXT,                   -- sales | client | internal | hiring | partner | one_on_one | other
    tags         TEXT,                   -- JSON array
    title        TEXT,
    url          TEXT NOT NULL,
    platform     TEXT NOT NULL,          -- meet | zoom
    bot_name     TEXT NOT NULL,
    status       TEXT NOT NULL,          -- queued | joining | waiting_room | recording | stopping | processing | done | failed | stopped
    error        TEXT,
    recording    TEXT,                   -- file name in data/recordings
    summary      TEXT,                   -- JSON from Claude
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    started_at   TEXT,
    ended_at     TEXT
  );
  CREATE TABLE IF NOT EXISTS utterances (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker     TEXT,
    text        TEXT NOT NULL,
    t_ms        INTEGER NOT NULL        -- ms since recording start
  );
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    message     TEXT NOT NULL,
    at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    meeting_id   TEXT REFERENCES meetings(id) ON DELETE SET NULL,
    title        TEXT NOT NULL,
    owner_name   TEXT,                   -- name as said in the meeting
    assignee_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
    due          TEXT,                   -- free text ("Friday") or YYYY-MM-DD
    status       TEXT NOT NULL DEFAULT 'open',  -- open | done
    t_ms         INTEGER,                -- where in the recording it was said
    source       TEXT NOT NULL DEFAULT 'ai',    -- ai | user
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    done_at      TEXT
  );
  -- One Google login per user; tokens are encrypted (see calendar.mjs).
  CREATE TABLE IF NOT EXISTS google_accounts (
    user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email         TEXT NOT NULL,
    refresh_token TEXT,
    access_token  TEXT,
    expires_at    INTEGER,               -- ms epoch
    scope         TEXT,
    workspace_id  TEXT REFERENCES workspaces(id) ON DELETE SET NULL,  -- where calendar meetings go
    auto_join     TEXT NOT NULL DEFAULT 'accepted',   -- all | accepted | organizer | off
    synced_at     TEXT,
    sync_error    TEXT
  );
  CREATE TABLE IF NOT EXISTS calendar_events (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id     TEXT NOT NULL,          -- Google event id (instance id for recurring)
    title        TEXT,
    start_at     INTEGER NOT NULL,       -- ms epoch
    end_at       INTEGER,
    url          TEXT,                   -- Meet / Zoom link, null if none
    platform     TEXT,
    organizer    TEXT,
    is_organizer INTEGER NOT NULL DEFAULT 0,
    response     TEXT,                   -- accepted | tentative | declined | needsAction
    attendees    TEXT,                   -- JSON [{email, name}]
    override     INTEGER,                -- null = follow rule, 1 = always join, 0 = skip
    meeting_id   TEXT REFERENCES meetings(id) ON DELETE SET NULL,
    cancelled    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, event_id)
  );
  -- Which AI writes the notes for a workspace (Settings → AI). api_key is encrypted (secrets.mjs).
  CREATE TABLE IF NOT EXISTS ai_settings (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL DEFAULT 'anthropic',   -- anthropic | openai | deepseek
    model        TEXT,
    api_key      TEXT,
    auto_tasks   INTEGER NOT NULL DEFAULT 1           -- 0 = notes only, no tasks
  );
  CREATE TABLE IF NOT EXISTS ai_keys (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL,
    api_key      TEXT NOT NULL,                       -- encrypted (secrets.mjs)
    PRIMARY KEY (workspace_id, provider)
  );
  -- Ask AI conversations (private to each user).
  CREATE TABLE IF NOT EXISTS assistant_chats (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title        TEXT,
    scope_type   TEXT NOT NULL DEFAULT 'all',   -- all | folder | meeting
    scope_id     TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS assistant_messages (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL REFERENCES assistant_chats(id) ON DELETE CASCADE,
    role    TEXT NOT NULL,                       -- user | assistant
    content TEXT NOT NULL,
    at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- One-time email sign-in links (token = sha256 of the link's secret).
  CREATE TABLE IF NOT EXISTS magic_links (
    token      TEXT PRIMARY KEY,
    email      TEXT NOT NULL COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS cal_start ON calendar_events(start_at);
  CREATE INDEX IF NOT EXISTS utt_meeting ON utterances(meeting_id, t_ms);
  CREATE INDEX IF NOT EXISTS meetings_ws ON meetings(workspace_id, created_at);
  CREATE INDEX IF NOT EXISTS tasks_ws ON tasks(workspace_id, status);
`);

// Folder overview (Claude's running summary of everything in the folder).
const fcols = new Set(db.prepare(`PRAGMA table_info(folders)`).all().map((c) => c.name));
for (const [name, type] of [['overview', 'TEXT'], ['overview_at', 'TEXT']]) {
  if (!fcols.has(name)) db.exec(`ALTER TABLE folders ADD COLUMN ${name} ${type}`);
}

// Public share links for single meetings (read-only page at /s/<token>).
{
  const mc = new Set(db.prepare(`PRAGMA table_info(meetings)`).all().map((c) => c.name));
  if (!mc.has('share_token')) db.exec(`ALTER TABLE meetings ADD COLUMN share_token TEXT`);
  if (!mc.has('share_opts')) db.exec(`ALTER TABLE meetings ADD COLUMN share_opts TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS meetings_share ON meetings(share_token) WHERE share_token IS NOT NULL`);
}

// Meeting language + transcription service (Settings → AI → Transcript).
{
  const ac = new Set(db.prepare(`PRAGMA table_info(ai_settings)`).all().map((c) => c.name));
  if (!ac.has('language')) db.exec(`ALTER TABLE ai_settings ADD COLUMN language TEXT`);
  if (!ac.has('stt_provider')) db.exec(`ALTER TABLE ai_settings ADD COLUMN stt_provider TEXT`);
  if (!ac.has('stt_model')) db.exec(`ALTER TABLE ai_settings ADD COLUMN stt_model TEXT`);
}

// Per-workspace bot name (falls back to BOT_NAME / the brand's bot name).
if (!db.prepare(`PRAGMA table_info(workspaces)`).all().some((c) => c.name === 'bot_name')) db.exec(`ALTER TABLE workspaces ADD COLUMN bot_name TEXT`);

// Older databases (pre-accounts) lack these columns.
const cols = new Set(db.prepare(`PRAGMA table_info(meetings)`).all().map((c) => c.name));
for (const [name, type] of [['workspace_id', 'TEXT'], ['created_by', 'TEXT'], ['folder_id', 'TEXT'], ['filed_by', 'TEXT'], ['meeting_type', 'TEXT'], ['tags', 'TEXT'], ['attendees', 'TEXT'], ['calendar_event', 'TEXT'],
  // Recording remuxed for length + seeking (1 = done, 0 = failed), its real length, and where the transcript came from.
  ['rec_fixed', 'INTEGER'], ['rec_seconds', 'REAL'], ['transcript_source', 'TEXT'], ['captions', 'TEXT']]) {
  if (!cols.has(name)) db.exec(`ALTER TABLE meetings ADD COLUMN ${name} ${type}`);
}

export const q = {
  // meetings (used by the bot + pipeline too)
  insertMeeting: db.prepare(`INSERT INTO meetings (id, workspace_id, created_by, title, url, platform, bot_name, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`),
  getMeeting: db.prepare(`SELECT * FROM meetings WHERE id = ?`),
  setStatus: db.prepare(`UPDATE meetings SET status = ?, error = ? WHERE id = ?`),
  setStarted: db.prepare(`UPDATE meetings SET started_at = datetime('now') WHERE id = ?`),
  setEnded: db.prepare(`UPDATE meetings SET ended_at = datetime('now') WHERE id = ?`),
  setRecording: db.prepare(`UPDATE meetings SET recording = ? WHERE id = ?`),
  setSummary: db.prepare(`UPDATE meetings SET summary = ? WHERE id = ?`),
  setFiling: db.prepare(`UPDATE meetings SET folder_id = ?, filed_by = ?, meeting_type = ?, tags = ? WHERE id = ?`),
  addUtterance: db.prepare(`INSERT INTO utterances (meeting_id, speaker, text, t_ms) VALUES (?, ?, ?, ?)`),
  utterances: db.prepare(`SELECT speaker, text, t_ms FROM utterances WHERE meeting_id = ? ORDER BY t_ms, id`),
  speakers: db.prepare(`SELECT DISTINCT speaker FROM utterances WHERE meeting_id = ? AND speaker IS NOT NULL`),
  addEvent: db.prepare(`INSERT INTO events (meeting_id, message) VALUES (?, ?)`),
  events: db.prepare(`SELECT message, at FROM events WHERE meeting_id = ? ORDER BY id`),
  deleteMeeting: db.prepare(`DELETE FROM meetings WHERE id = ?`),

  // folders
  folders: db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM meetings m WHERE m.folder_id = f.id) AS meeting_count
                       FROM folders f WHERE workspace_id = ? ORDER BY name`),
  folderByName: db.prepare(`SELECT * FROM folders WHERE workspace_id = ? AND name = ? COLLATE NOCASE`),
  insertFolder: db.prepare(`INSERT INTO folders (id, workspace_id, name, color) VALUES (?, ?, ?, ?)`),
  rules: db.prepare(`SELECT r.*, f.name AS folder_name FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE r.workspace_id = ?`),
  insertRule: db.prepare(`INSERT OR IGNORE INTO folder_rules (workspace_id, folder_id, kind, value) VALUES (?, ?, ?, ?)`),

  // tasks
  insertTask: db.prepare(`INSERT INTO tasks (id, workspace_id, meeting_id, title, owner_name, assignee_id, due, t_ms, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  deleteAiTasks: db.prepare(`DELETE FROM tasks WHERE meeting_id = ? AND source = 'ai' AND status = 'open'`),
  meetingTasks: db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE meeting_id = ? ORDER BY t.created_at`),

  // people
  memberUsers: db.prepare(`SELECT u.id, u.name, u.email, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.name`),
};

export function detectPlatform(url) {
  const h = new URL(url).hostname;
  if (h === 'meet.google.com') return 'meet';
  if (h === 'zoom.us' || h.endsWith('.zoom.us')) return 'zoom';
  return null;
}
