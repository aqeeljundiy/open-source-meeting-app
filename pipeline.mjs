// After the bot leaves: make sure there's a transcript, write notes, create tasks, file the meeting.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { q, REC_DIR } from './db.mjs';
import { summarize, parseMmss, folderOverview } from './summarize.mjs';
import { aiFor, PROVIDERS } from './llm.mjs';
import { db } from './db.mjs';

const newId = () => randomUUID().replace(/-/g, '').slice(0, 10);

export async function finishMeeting(id, log, setStatus) {
  setStatus('processing');
  try {
    const m = q.getMeeting.get(id);
    let utterances = q.utterances.all(id);

    // No captions came through (e.g. Zoom host disabled them): transcribe the recording.
    if (!utterances.length && m.recording && process.env.DEEPGRAM_API_KEY) {
      log('Transcribing the recording with Deepgram');
      for (const u of await transcribeDeepgram(join(REC_DIR, m.recording))) {
        q.addUtterance.run(id, u.speaker, u.text, u.t_ms);
      }
      utterances = q.utterances.all(id);
    }
    log(`Transcript has ${utterances.length} lines`);

    if (!utterances.length) log('No transcript, so no notes');
    else if (!aiFor(m.workspace_id).apiKey) log('No AI key set (Settings → AI), so notes were skipped');
    else {
      const ai = aiFor(m.workspace_id);
      log(`Writing notes with ${PROVIDERS[ai.provider].label} (${ai.model})`);
      const folders = q.folders.all(m.workspace_id).map((f) => f.name);
      const attendees = m.attendees ? JSON.parse(m.attendees) : [];
      const notes = await summarize(utterances, { title: m.title, folders, attendees, ai });
      q.setSummary.run(JSON.stringify(notes), id);
      log('Notes ready');
      if (ai.autoTasks) {
        const n = createTasks(m, notes);
        if (n) log(`Created ${n} task${n > 1 ? 's' : ''}`);
      } else log('Automatic tasks are off (Settings → AI); action items stay in the summary only');
      fileMeeting(m, notes, log);
      const folderId = q.getMeeting.get(id).folder_id;
      if (folderId) await refreshFolderOverview(folderId).then(() => log('Folder overview updated')).catch((e) => log(`Folder overview not updated: ${e.message}`));
    }
    setStatus('done');
  } catch (err) {
    console.error(err);
    setStatus('failed', `Processing: ${err.message}`);
  }
}

// Action items -> tasks. Re-running notes replaces the AI tasks nobody has touched.
export function createTasks(m, notes) {
  const members = q.memberUsers.all(m.workspace_id);
  const attendees = m.attendees ? JSON.parse(m.attendees) : [];
  q.deleteAiTasks.run(m.id);
  // Tasks people already edited survive "Redo notes"; don't add a near-copy next to them.
  const kept = q.meetingTasks.all(m.id).map((t) => words(t.title));
  let n = 0;
  for (const a of notes.action_items || []) {
    if (kept.some((k) => similar(k, words(a.task)))) continue;
    const owner = a.owner && a.owner !== 'Unassigned' ? a.owner : null;
    q.insertTask.run(newId(), m.workspace_id, m.id, a.task, owner, matchMember(owner, members, attendees), a.due || null, parseMmss(a.said_at), 'ai');
    n++;
  }
  return n;
}

const words = (s) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !['the', 'and', 'for', 'with'].includes(w)));
function similar(a, b) {
  if (!a.size || !b.size) return false;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / Math.min(a.size, b.size) >= 0.75;
}

// "Budi" matches member "Budi Santoso"; full-name match wins over first-name match.
export function matchMember(name, members, attendees = []) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  // Calendar attendee with this name whose email belongs to a member.
  const att = attendees.find((a) => a.name?.toLowerCase() === n || a.name?.toLowerCase().split(/\s+/)[0] === n);
  const byEmail = att && members.find((u) => u.email.toLowerCase() === att.email?.toLowerCase());
  if (byEmail) return byEmail.id;
  const exact = members.find((u) => u.name.toLowerCase() === n);
  if (exact) return exact.id;
  const first = members.filter((u) => u.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]);
  return first.length === 1 ? first[0].id : null;
}

// Rules first (participants / keywords the user taught us), then the AI's suggestion.
export function fileMeeting(m, notes, log) {
  if (m.folder_id && m.filed_by === 'user') {
    // The user already chose the folder: keep it, but still record type and tags.
    q.setFiling.run(m.folder_id, 'user', notes.meeting_type, JSON.stringify(notes.tags || []), m.id);
    return;
  }
  const speakers = q.speakers.all(m.id).map((r) => r.speaker.toLowerCase());
  const haystack = `${m.title || ''} ${notes.title} ${notes.summary}`.toLowerCase();
  const domains = (m.attendees ? JSON.parse(m.attendees) : []).map((a) => a.email?.split('@')[1]?.toLowerCase()).filter(Boolean);
  const rule = q.rules.all(m.workspace_id).find((r) => {
    const v = r.value.toLowerCase();
    if (r.kind === 'participant') return speakers.includes(v);
    if (r.kind === 'domain') return domains.includes(v);
    return haystack.includes(v);
  });

  let folderId = null;
  let by = null;
  if (rule) {
    folderId = rule.folder_id;
    by = 'rule';
    log(`Filed in "${rule.folder_name}" (rule: ${rule.kind} "${rule.value}")`);
  } else if (notes.folder?.trim()) {
    const name = notes.folder.trim().slice(0, 60);
    let folder = q.folderByName.get(m.workspace_id, name);
    if (!folder) {
      folder = { id: newId() };
      q.insertFolder.run(folder.id, m.workspace_id, name, 'blue');
      log(`Created folder "${name}"`);
    }
    folderId = folder.id;
    by = 'ai';
    log(`Filed in "${name}"`);
  }
  q.setFiling.run(folderId, by, notes.meeting_type, JSON.stringify(notes.tags || []), m.id);
}

async function transcribeDeepgram(file) {
  if (!(await stat(file).catch(() => null))?.size) return [];
  const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&utterances=true&detect_language=true', {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'video/webm' },
    body: await readFile(file),
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.results?.utterances || []).map((u) => ({
    speaker: `Speaker ${u.speaker + 1}`,
    text: u.transcript,
    t_ms: Math.round(u.start * 1000),
  }));
}


// Re-summarize a folder from all its meetings' notes + tasks (called after each meeting, or on demand).
export async function refreshFolderOverview(folderId) {
  const folder = db.prepare(`SELECT * FROM folders WHERE id = ?`).get(folderId);
  const ai = folder && aiFor(folder.workspace_id);
  if (!folder || !ai.apiKey) return null;
  const meetings = db.prepare(`SELECT title, summary, created_at FROM meetings WHERE folder_id = ? AND summary IS NOT NULL ORDER BY created_at`).all(folderId)
    .map((m) => { const n = JSON.parse(m.summary); return { date: m.created_at.slice(0, 10), title: n.title || m.title, summary: n.summary, decisions: n.decisions }; });
  if (!meetings.length) return null;
  const tasks = db.prepare(`SELECT t.title, t.status, t.due, COALESCE(u.name, t.owner_name) AS owner FROM tasks t
                            JOIN meetings m ON m.id = t.meeting_id LEFT JOIN users u ON u.id = t.assignee_id WHERE m.folder_id = ?`).all(folderId);
  const overview = await folderOverview(folder.name, meetings, tasks, ai);
  db.prepare(`UPDATE folders SET overview = ?, overview_at = datetime('now') WHERE id = ?`).run(JSON.stringify(overview), folderId);
  return overview;
}
