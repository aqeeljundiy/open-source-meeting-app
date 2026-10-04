// "Ask AI": a chat assistant that answers from the workspace's meetings.
// Scope decides what it reads: one meeting, one folder, or everything (recent + keyword matches).
import { randomUUID } from 'node:crypto';
import { db } from './db.mjs';
import { aiFor, generateText } from './llm.mjs';

const newId = () => randomUUID().replace(/-/g, '').slice(0, 10);
const mmss = (ms) => { const s = Math.floor((ms || 0) / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const MAX_CONTEXT = 120_000;   // characters of meeting material sent per question

const st = {
  meeting: db.prepare(`SELECT m.*, f.name AS folder_name FROM meetings m LEFT JOIN folders f ON f.id = m.folder_id WHERE m.id = ? AND m.workspace_id = ?`),
  folder: db.prepare(`SELECT * FROM folders WHERE id = ? AND workspace_id = ?`),
  folderMeetings: db.prepare(`SELECT id, title, summary, created_at FROM meetings WHERE folder_id = ? ORDER BY created_at`),
  recentMeetings: db.prepare(`SELECT m.id, m.title, m.summary, m.created_at, f.name AS folder_name FROM meetings m LEFT JOIN folders f ON f.id = m.folder_id
                              WHERE m.workspace_id = ? AND m.summary IS NOT NULL ORDER BY m.created_at DESC LIMIT 25`),
  tasksForMeeting: db.prepare(`SELECT t.title, t.status, t.due, COALESCE(u.name, t.owner_name) AS owner FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.meeting_id = ?`),
  tasksForFolder: db.prepare(`SELECT t.title, t.status, t.due, COALESCE(u.name, t.owner_name) AS owner, t.meeting_id FROM tasks t
                              JOIN meetings m ON m.id = t.meeting_id LEFT JOIN users u ON u.id = t.assignee_id WHERE m.folder_id = ?`),
  openTasks: db.prepare(`SELECT t.title, t.due, COALESCE(u.name, t.owner_name) AS owner, t.meeting_id, f.name AS folder_name FROM tasks t
                         LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN meetings m ON m.id = t.meeting_id LEFT JOIN folders f ON f.id = m.folder_id
                         WHERE t.workspace_id = ? AND t.status = 'open' ORDER BY t.created_at DESC LIMIT 60`),
  utterances: db.prepare(`SELECT speaker, text, t_ms FROM utterances WHERE meeting_id = ? ORDER BY t_ms`),
  chat: db.prepare(`SELECT * FROM assistant_chats WHERE id = ? AND user_id = ?`),
  messages: db.prepare(`SELECT role, content, at FROM assistant_messages WHERE chat_id = ? ORDER BY id`),
};

const title = (m) => { try { return JSON.parse(m.summary).title || m.title || 'Meeting'; } catch { return m.title || 'Meeting'; } };
function notesBlock(m) {
  let n = {};
  try { n = JSON.parse(m.summary || '{}'); } catch {}
  return [
    `### Meeting [M:${m.id}] "${title(m)}", ${m.created_at.slice(0, 10)}${m.folder_name ? `, folder ${m.folder_name}` : ''}`,
    n.summary ? `Summary: ${n.summary}` : '',
    n.decisions?.length ? `Decisions: ${n.decisions.join('; ')}` : '',
    n.key_points?.length ? `Key points: ${n.key_points.join('; ')}` : '',
    n.open_questions?.length ? `Open questions: ${n.open_questions.join('; ')}` : '',
  ].filter(Boolean).join('\n');
}
const taskLine = (t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.owner ? ` (${t.owner})` : ''}${t.due ? `, due ${t.due}` : ''}${t.meeting_id ? ` [M:${t.meeting_id}]` : ''}`;
const transcriptBlock = (id, max = 60_000) => {
  const lines = st.utterances.all(id).map((u) => `[M:${id}@${mmss(u.t_ms)}] ${u.speaker || 'Unknown'}: ${u.text}`).join('\n');
  return lines.length > max ? `${lines.slice(0, max)}\n…(transcript truncated)` : lines;
};

// Transcript lines across the workspace that share words with the question.
function keywordHits(workspaceId, question, limit = 30) {
  const words = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [])].slice(0, 8);
  if (!words.length) return [];
  const where = words.map(() => `u.text LIKE ?`).join(' OR ');
  return db.prepare(`SELECT u.meeting_id, u.speaker, u.text, u.t_ms FROM utterances u JOIN meetings m ON m.id = u.meeting_id
                     WHERE m.workspace_id = ? AND (${where}) ORDER BY m.created_at DESC LIMIT ${limit}`)
    .all(workspaceId, ...words.map((w) => `%${w}%`));
}

export function buildContext(workspaceId, scope, question) {
  const parts = [];
  let label = 'All meetings';
  if (scope?.type === 'meeting') {
    const m = st.meeting.get(scope.id, workspaceId);
    if (!m) throw Object.assign(new Error('Meeting not found'), { status: 404 });
    label = `Meeting: ${title(m)}`;
    parts.push(notesBlock(m), '#### Tasks', st.tasksForMeeting.all(m.id).map(taskLine).join('\n') || '(none)', '#### Transcript', transcriptBlock(m.id));
  } else if (scope?.type === 'folder') {
    const f = st.folder.get(scope.id, workspaceId);
    if (!f) throw Object.assign(new Error('Folder not found'), { status: 404 });
    label = `Folder: ${f.name}`;
    if (f.overview) {
      const o = JSON.parse(f.overview);
      parts.push(`## Account overview for ${f.name}\n${o.headline}\n${o.summary}\nProgress: ${o.progress}\nRisks: ${(o.risks || []).join('; ')}\nNext steps: ${(o.next_steps || []).join('; ')}`);
    }
    const meetings = st.folderMeetings.all(f.id).map((m) => ({ ...m, folder_name: f.name }));
    parts.push(`## Meetings in ${f.name} (${meetings.length}, oldest first)`, ...meetings.map(notesBlock));
    parts.push('## Tasks', st.tasksForFolder.all(f.id).map(taskLine).join('\n') || '(none)');
    // Transcripts of the most recent meetings, as much as fits.
    let budget = 50_000;
    for (const m of [...meetings].reverse()) {
      if (budget < 5_000) break;
      const t = transcriptBlock(m.id, Math.min(budget, 20_000));
      parts.push(`#### Transcript of [M:${m.id}]`, t);
      budget -= t.length;
    }
  } else {
    parts.push('## Recent meetings (newest first)', ...st.recentMeetings.all(workspaceId).map(notesBlock));
    parts.push('## Open tasks', st.openTasks.all(workspaceId).map((t) => `${taskLine(t)}${t.folder_name ? ` {${t.folder_name}}` : ''}`).join('\n') || '(none)');
    const hits = keywordHits(workspaceId, question);
    if (hits.length) parts.push('## Transcript lines matching the question', hits.map((h) => `[M:${h.meeting_id}@${mmss(h.t_ms)}] ${h.speaker || 'Unknown'}: ${h.text}`).join('\n'));
  }
  let text = parts.join('\n\n');
  if (text.length > MAX_CONTEXT) text = `${text.slice(0, MAX_CONTEXT)}\n…(material truncated)`;
  return { label, text };
}

const SYSTEM = (brand, label, today) => `You are the meeting assistant inside ${brand}'s meeting notes app. Today is ${today}.
You answer questions from the team using ONLY the meeting material provided (summaries, decisions, tasks, transcripts). Scope: ${label}.
- If the material does not contain the answer, say so plainly and suggest what to check. Never invent facts, numbers or commitments.
- Be concise and practical: short paragraphs or bullet points. Drafts (emails, messages, agendas) are welcome when asked.
- Cite your sources inline with the exact markers from the material, e.g. [M:abc123] for a meeting or [M:abc123@04:12] for a moment in a transcript.
- Reply in the language the user writes in.`;

// Titles for the [M:id] markers in an answer, so the UI can label its source links.
export function refTitles(workspaceId, ...texts) {
  const ids = [...new Set(texts.join(' ').match(/\[M:([\w-]+)/g)?.map((x) => x.slice(3)) || [])];
  const out = {};
  for (const id of ids) {
    const m = db.prepare(`SELECT id, title, summary, created_at FROM meetings WHERE id = ? AND workspace_id = ?`).get(id, workspaceId);
    if (m) out[id] = { title: title(m), date: m.created_at.slice(0, 10) };
  }
  return out;
}

export async function ask({ workspaceId, userId, brandName, chatId, scope, message }) {
  const ai = aiFor(workspaceId);
  let chat = chatId ? st.chat.get(chatId, userId) : null;
  if (!chat) {
    chat = { id: newId() };
    db.prepare(`INSERT INTO assistant_chats (id, user_id, workspace_id, title, scope_type, scope_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(chat.id, userId, workspaceId, message.slice(0, 80), scope?.type || 'all', scope?.id || null);
  }
  const history = st.messages.all(chat.id).slice(-12).map((m) => ({ role: m.role, content: m.content }));
  const ctx = buildContext(workspaceId, scope, message);
  const answer = await generateText({
    ai,
    system: SYSTEM(brandName, ctx.label, new Date().toISOString().slice(0, 10)),
    messages: [
      ...history,
      { role: 'user', content: `<material>\n${ctx.text}\n</material>\n\nQuestion: ${message}` },
    ],
  });
  const add = db.prepare(`INSERT INTO assistant_messages (chat_id, role, content) VALUES (?, ?, ?)`);
  add.run(chat.id, 'user', message);
  add.run(chat.id, 'assistant', answer);
  db.prepare(`UPDATE assistant_chats SET updated_at = datetime('now'), scope_type = ?, scope_id = ? WHERE id = ?`).run(scope?.type || 'all', scope?.id || null, chat.id);
  return { chatId: chat.id, answer, scopeLabel: ctx.label, refs: refTitles(workspaceId, answer) };
}

export function listChats(userId, workspaceId) {
  return db.prepare(`SELECT id, title, scope_type, scope_id, updated_at FROM assistant_chats WHERE user_id = ? AND workspace_id = ? ORDER BY updated_at DESC LIMIT 50`).all(userId, workspaceId);
}
export function getChat(userId, chatId) {
  const chat = st.chat.get(chatId, userId);
  if (!chat) return null;
  const messages = st.messages.all(chatId);
  return { ...chat, messages, refs: refTitles(chat.workspace_id, ...messages.map((m) => m.content)) };
}
export function deleteChat(userId, chatId) {
  db.prepare(`DELETE FROM assistant_chats WHERE id = ? AND user_id = ?`).run(chatId, userId);
}
