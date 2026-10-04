// Turns a transcript into meeting notes, tasks and a filing suggestion with the workspace's AI.
import { z } from 'zod';
import { generateObject } from './llm.mjs';

export const MEETING_TYPES = ['sales', 'client', 'internal', 'hiring', 'partner', 'one_on_one', 'other'];

const Notes = z.object({
  title: z.string().describe('Short title for the meeting, max 8 words'),
  summary: z.string().describe('3-6 sentence overview of what the meeting was about and where it landed'),
  key_points: z.array(z.string()),
  decisions: z.array(z.string()),
  action_items: z.array(z.object({
    task: z.string().describe('Starts with a verb, e.g. "Send the pricing deck to Budi"'),
    owner: z.string().describe('Person responsible, exactly as named in the transcript, or "Unassigned"'),
    due: z.string().describe('Due date or timeframe if mentioned, else ""'),
    said_at: z.string().describe('mm:ss in the transcript where it was agreed'),
  })),
  open_questions: z.array(z.string()),
  topics: z.array(z.object({ name: z.string(), start: z.string().describe('mm:ss when the topic starts') })),
  meeting_type: z.enum(MEETING_TYPES).describe(
    'sales = selling to a prospect; client = existing customer/agency client; internal = own team; hiring = interview; ' +
    'partner = partners, investors, suppliers; one_on_one = two colleagues 1:1; other'),
  tags: z.array(z.string()).describe('0-5 short lowercase tags, e.g. "pricing", "complaint", "deal at risk", "launch"'),
  folder: z.string().describe(
    'Folder to file this meeting in. Reuse an existing folder name exactly when one fits (usually a client, company or project). ' +
    'Otherwise propose a short new name (the client/company/project; attendee email domains are a strong hint), or "" if nothing specific fits.'),
});

const fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
export const parseMmss = (s) => {
  const m = /^(\d+):(\d{2})$/.exec(s || '');
  return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : null;
};

export function transcriptText(utterances) {
  return utterances.map((u) => `[${fmt(u.t_ms)}] ${u.speaker || 'Unknown'}: ${u.text}`).join('\n');
}

export async function summarize(utterances, { title, folders = [], attendees = [], ai } = {}) {
  if (!utterances.length) return null;
  const context = [
    title ? `Meeting title given by the user: ${title}` : null,
    attendees.length ? `Invited (from the calendar): ${attendees.map((a) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}` : null,
    `Existing folders: ${folders.length ? folders.map((f) => `"${f}"`).join(', ') : '(none yet)'}`,
  ].filter(Boolean).join('\n');
  return generateObject({
    ai, schema: Notes, name: 'meeting_notes', effort: 'medium',
    system:
      'You write meeting notes from auto-generated captions. Captions can mis-hear words and names; ' +
      'fix obvious errors silently, never invent facts that are not in the transcript. ' +
      'Only list action items someone actually committed to or was asked to do. ' +
      'Write the notes in the language the meeting was held in.',
    prompt: `${context}\n\n<transcript>\n${transcriptText(utterances)}\n</transcript>`,
  });
}

// ---------- folder overview: one client/project across all its meetings ----------
const Overview = z.object({
  headline: z.string().describe('One sentence: where things stand with this client/project right now'),
  summary: z.string().describe('4-7 sentences: the story so far across the meetings, most recent first in importance'),
  progress: z.string().describe('One or two sentences on progress against what was agreed (what got done, what is pending)'),
  wins: z.array(z.string()).describe('Concrete results or decisions so far, max 5'),
  risks: z.array(z.string()).describe('Blockers, risks or things slipping, max 5'),
  next_steps: z.array(z.string()).describe('The most important next steps, max 5'),
});

export async function folderOverview(folderName, meetings, tasks, ai) {
  const meetingText = meetings.map((m) => [
    `## ${m.date} - ${m.title}`,
    m.summary,
    m.decisions?.length ? `Decisions: ${m.decisions.join('; ')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  const taskText = tasks.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.owner ? ` (${t.owner})` : ''}${t.due ? `, due ${t.due}` : ''}`).join('\n');
  return generateObject({
    ai, schema: Overview, name: 'folder_overview', effort: 'low', maxTokens: 8000,
    system: 'You keep an account overview for an agency team: a short, factual status of one client or project across all its meetings. ' +
      'Only use what is in the notes and tasks. Write in the language the meetings were held in.',
    prompt: `Folder: ${folderName}\n\n<meetings>\n${meetingText}\n</meetings>\n\n<tasks>\n${taskText || '(none)'}\n</tasks>`,
  });
}
