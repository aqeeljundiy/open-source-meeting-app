// Recordings after the meeting: make the file seekable with the right length, and (optionally)
// transcribe its audio with a speech-to-text service. Meet's live captions are weak outside
// English (e.g. Indonesian, or Indonesian mixed with English); Whisper-class models do much better.
// Speaker names still come from the captions: each transcribed line takes the name of whoever
// the captions showed talking at that moment.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from './db.mjs';
import { unseal } from './secrets.mjs';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export const LANGUAGES = {
  auto: { label: 'Detect automatically' },
  en: { label: 'English', meet: /^English/i },
  id: { label: 'Indonesian (also fine with English mixed in)', meet: /^(Indonesian|Bahasa Indonesia)/i },
  ms: { label: 'Malay', meet: /^(Malay|Bahasa Melayu)/i },
  nl: { label: 'Dutch', meet: /^Dutch/i },
  de: { label: 'German', meet: /^German/i },
  fr: { label: 'French', meet: /^French/i },
  es: { label: 'Spanish', meet: /^Spanish/i },
  pt: { label: 'Portuguese', meet: /^Portuguese/i },
  ar: { label: 'Arabic', meet: /^Arabic/i },
  hi: { label: 'Hindi', meet: /^Hindi/i },
  ja: { label: 'Japanese', meet: /^Japanese/i },
};

export const TRANSCRIBERS = {
  // Best published accuracy for Indonesian (and Indonesian mixed with English); speakers + word timings.
  elevenlabs: {
    label: 'ElevenLabs Scribe (most accurate for Indonesian, about $0.40 per hour)',
    short: 'ElevenLabs Scribe',
    envKey: 'ELEVENLABS_API_KEY',
    keyHint: 'sk_…  from elevenlabs.io → Developers → API Keys (needs Speech to Text access)',
    model: process.env.ELEVENLABS_STT_MODEL || 'scribe_v2',
  },
  groq: {
    label: 'Groq Whisper large-v3 (best value, about $0.11 per hour)',
    short: 'Groq Whisper',
    envKey: 'GROQ_API_KEY',
    keyHint: 'gsk_…  from console.groq.com → API Keys',
    base: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3',
  },
  openai: {
    label: 'OpenAI Whisper (about $0.36 per hour)',
    short: 'OpenAI Whisper',
    envKey: 'OPENAI_API_KEY',
    keyHint: 'sk-…  from platform.openai.com → API keys (same key as ChatGPT)',
    base: 'https://api.openai.com/v1',
    model: 'whisper-1',
  },
  deepgram: {
    label: 'Deepgram (about $0.26 to $0.35 per hour)',
    short: 'Deepgram',
    envKey: 'DEEPGRAM_API_KEY',
    keyHint: 'Token from console.deepgram.com → API Keys',
  },
};
// Keys live in ai_keys next to the AI keys; OpenAI shares the ChatGPT key.
export const sttKeyName = (provider) => (provider === 'openai' ? 'openai' : `stt_${provider}`);

// The workspace's transcription choice (Settings → AI → Transcript).
export function sttFor(workspaceId) {
  const row = workspaceId && db.prepare(`SELECT language, stt_provider FROM ai_settings WHERE workspace_id = ?`).get(workspaceId);
  const provider = TRANSCRIBERS[row?.stt_provider] ? row.stt_provider : null;
  const k = provider && db.prepare(`SELECT api_key FROM ai_keys WHERE workspace_id = ? AND provider = ?`).get(workspaceId, sttKeyName(provider));
  const saved = k ? unseal(k.api_key) : null;
  return {
    provider,
    language: LANGUAGES[row?.language] ? row.language : 'auto',
    apiKey: provider ? saved || process.env[TRANSCRIBERS[provider].envKey] || null : null,
    keySource: saved ? 'settings' : provider && process.env[TRANSCRIBERS[provider].envKey] ? 'server' : null,
  };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed: ${err.trim().split('\n').pop()}`))));
  });
}

let ffmpegOk;
export async function hasFfmpeg() {
  ffmpegOk ??= await run(FFMPEG, ['-version']).then(() => true, () => false);
  return ffmpegOk;
}

export async function durationSec(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).catch(() => '');
  const n = Number(out.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const hms = (sec) => {
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
};

// Browser recordings (MediaRecorder) have no length or seek index in the file, so players show
// a wrong length (often about a minute that keeps growing) and can't jump ahead. A copy-only
// remux writes both. Returns the real length in seconds.
export async function fixRecording(file) {
  if (!(await stat(file).catch(() => null))?.size) return null;
  if (!(await hasFfmpeg())) throw new Error('ffmpeg is not installed');
  const tmp = `${file}.fixing.webm`;
  try {
    await run(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-fflags', '+genpts', '-i', file, '-map', '0', '-c', 'copy', tmp]);
    if (!(await stat(tmp).catch(() => null))?.size) throw new Error('remux produced an empty file');
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
  return durationSec(file);
}

// Each recording is fixed once (meetings.rec_fixed); also catches up older recordings at startup.
export async function fixPendingRecordings(recDir, log = console.log) {
  if (!(await hasFfmpeg())) return;
  const rows = db.prepare(`SELECT id, recording FROM meetings WHERE recording IS NOT NULL AND rec_fixed IS NULL
                           AND status IN ('done', 'failed', 'stopped')`).all();
  for (const m of rows) {
    try {
      const sec = await fixRecording(join(recDir, m.recording));
      await fixRecording(join(recDir, m.recording.replace(/\.webm$/, '.audio.webm'))).catch(() => {});
      db.prepare(`UPDATE meetings SET rec_fixed = 1, rec_seconds = ? WHERE id = ?`).run(sec, m.id);
      if (sec) db.prepare(`INSERT INTO events (meeting_id, message) VALUES (?, ?)`).run(m.id, `Recording made seekable (${hms(sec)} long)`);
    } catch (err) {
      db.prepare(`UPDATE meetings SET rec_fixed = 0 WHERE id = ?`).run(m.id);
      log(`[${m.id}] Could not fix the recording: ${err.message}`);
    }
  }
}

// Audio only, mono 16 kHz Opus, cut into pieces small enough for any provider's upload limit.
async function audioChunks(file, chunkSec) {
  const dir = await mkdtemp(join(tmpdir(), 'mb-audio-'));
  await run(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k',
    '-f', 'segment', '-segment_time', String(chunkSec), '-reset_timestamps', '1', join(dir, 'part%03d.ogg')]);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ogg')).sort().map((f) => join(dir, f));
  return { dir, files };
}

// Whisper's well-known inventions on silence or music (it learned them from video subtitles).
const HALLUCINATION = /^(terima kasih( telah| sudah)? (menonton|menyaksikan)|thanks? (you )?for watching|subtitles? by|sampai jumpa( lagi)?( di video (berikutnya|selanjutnya))?|jangan lupa (like|subscribe)|please subscribe|\[?(musik|music|tepuk tangan|applause)\]?)[.!\s]*$/i;

async function whisper(t, apiKey, path, { language, prompt }) {
  const form = new FormData();
  form.append('file', new Blob([await readFile(path)], { type: 'audio/ogg' }), 'audio.ogg');
  form.append('model', t.model);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (language !== 'auto') form.append('language', language);
  if (prompt) form.append('prompt', prompt);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${t.base}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return (data.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text?.trim(), noSpeech: s.no_speech_prob, logprob: s.avg_logprob }));
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise((r) => setTimeout(r, 5000 * attempt)); continue; }
    throw new Error(`${t.short}: ${data.error?.message || `HTTP ${res.status}`}`);
  }
}

// ISO 639-1 → 639-3 for ElevenLabs.
const ISO3 = { en: 'eng', id: 'ind', ms: 'msa', nl: 'nld', de: 'deu', fr: 'fra', es: 'spa', pt: 'por', ar: 'ara', hi: 'hin', ja: 'jpn' };

async function elevenlabs(t, apiKey, path, { language }) {
  const form = new FormData();
  form.append('file', new Blob([await readFile(path)], { type: 'audio/ogg' }), 'audio.ogg');
  form.append('model_id', t.model);
  form.append('diarize', 'true');
  form.append('tag_audio_events', 'false');
  form.append('timestamps_granularity', 'word');
  if (language !== 'auto') form.append('language_code', ISO3[language] || language);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return wordsToSegments(data.words || []);
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise((r) => setTimeout(r, 5000 * attempt)); continue; }
    const msg = data.detail?.message || (typeof data.detail === 'string' ? data.detail : null) || `HTTP ${res.status}`;
    throw new Error(`${t.short}: ${msg}`);
  }
}

// Word timings → sentence-ish segments: split on a new speaker, a pause, or a long run.
function wordsToSegments(words) {
  const segs = [];
  let cur = null;
  for (const w of words) {
    if (w.type === 'audio_event') continue;
    if (w.type === 'spacing') { if (cur) cur.text += w.text; continue; }
    const spk = w.speaker_id != null ? Number(String(w.speaker_id).replace(/\D/g, '')) : null;
    const brk = !cur || spk !== cur.dgSpeaker || w.start - cur.end > 1.2 || (w.start - cur.end > 0.5 && /[.?!]$/.test(cur.text.trim())) || cur.end - cur.start > 40;
    if (brk) { if (cur) segs.push(cur); cur = { start: w.start, end: w.end, text: w.text, dgSpeaker: spk }; }
    else { cur.text += w.text; cur.end = w.end; }
  }
  if (cur) segs.push(cur);
  return segs.map((s) => ({ ...s, text: s.text.trim() }));
}

async function deepgram(apiKey, path, { language, prompt }) {
  // nova-3 for English / auto; Indonesian and some others are on nova-2.
  const nova3 = ['auto', 'en', 'nl', 'de', 'fr', 'es', 'pt', 'ja', 'hi'].includes(language);
  const params = new URLSearchParams({ model: nova3 ? 'nova-3' : 'nova-2', smart_format: 'true', punctuate: 'true', diarize: 'true', utterances: 'true' });
  if (language === 'auto') params.set('detect_language', 'true'); else params.set('language', language);
  if (prompt && nova3) for (const w of prompt.split(', ').slice(0, 50)) params.append('keyterm', w);
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST', headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/ogg' }, body: await readFile(path),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Deepgram: ${data.err_msg || data.error || `HTTP ${res.status}`}`);
  return (data.results?.utterances || []).map((u) => ({ start: u.start, end: u.end, text: u.transcript?.trim(), dgSpeaker: u.speaker }));
}

// Who was talking at [start, end]? Caption lines (speaker + time) close to that window vote.
function speakerAt(captions, startMs, endMs) {
  if (!captions.length) return null;
  const votes = new Map();
  for (const c of captions) {
    if (c.t_ms < startMs - 4000) continue;
    if (c.t_ms > endMs + 1500) break;
    // Captions inside the window count fully; ones just before or after count less.
    const gap = c.t_ms < startMs ? startMs - c.t_ms : c.t_ms > endMs ? c.t_ms - endMs : 0;
    votes.set(c.speaker, (votes.get(c.speaker) || 0) + 1 / (1 + gap / 1000));
  }
  if (votes.size) return [...votes].sort((a, b) => b[1] - a[1])[0][0];
  // Nothing nearby: the last caption speaker before this line, if recent.
  let last = null;
  for (const c of captions) { if (c.t_ms > startMs) break; last = c; }
  return last && startMs - last.t_ms < 60_000 ? last.speaker : null;
}

// Transcribe a recording. captions: [{ speaker, text, t_ms }] from Meet (for names and vocabulary).
// Returns utterances [{ speaker, text, t_ms }].
export async function transcribeRecording(file, stt, captions = [], { names = [], log = () => {} } = {}) {
  if (!(await hasFfmpeg())) throw new Error('ffmpeg is not installed');
  const t = TRANSCRIBERS[stt.provider];
  const caps = captions.filter((c) => c.speaker).sort((a, b) => a.t_ms - b.t_ms);
  // Vocabulary hint: people's names help the model spell them.
  const people = [...new Set([...caps.map((c) => c.speaker), ...names].filter(Boolean))];
  const prompt = people.length ? people.join(', ') : '';
  // ElevenLabs takes up to 10 hours in one file (better speaker tracking); the others get 10-minute pieces.
  const chunkSec = stt.provider === 'elevenlabs' ? 36_000 : 600;
  const { dir, files } = await audioChunks(file, chunkSec);
  try {
    const segs = [];
    for (const [i, part] of files.entries()) {
      log(`Transcribing part ${i + 1} of ${files.length} with ${t.short}`);
      const offset = i * chunkSec;
      const got = stt.provider === 'deepgram' ? await deepgram(stt.apiKey, part, { language: stt.language, prompt })
        : stt.provider === 'elevenlabs' ? await elevenlabs(t, stt.apiKey, part, { language: stt.language })
        : await whisper(t, stt.apiKey, part, { language: stt.language, prompt });
      for (const s of got) segs.push({ ...s, start: s.start + offset, end: s.end + offset });
    }
    // Drop silence guesses and repeats.
    const clean = segs.filter((s, i) => s.text && !(s.noSpeech > 0.6 && s.logprob < -0.7) && !HALLUCINATION.test(s.text)
      && !(i > 1 && s.text === segs[i - 1].text && s.text === segs[i - 2].text));
    // Services that tell voices apart: give each voice the name the captions most often showed
    // while it spoke, over the whole meeting (steadier than guessing line by line).
    const voiceName = new Map();
    if (clean.some((s) => s.dgSpeaker != null) && caps.length) {
      const votes = new Map();
      for (const s of clean) {
        if (s.dgSpeaker == null) continue;
        const n = speakerAt(caps, Math.round(s.start * 1000), Math.round(s.end * 1000));
        if (!n) continue;
        const v = votes.get(s.dgSpeaker) || new Map();
        v.set(n, (v.get(n) || 0) + (s.end - s.start));
        votes.set(s.dgSpeaker, v);
      }
      for (const [voice, v] of votes) {
        const total = [...v.values()].reduce((a, b) => a + b, 0);
        const [name, sec] = [...v].sort((a, b) => b[1] - a[1])[0];
        if (sec / total >= 0.4) voiceName.set(voice, name);
      }
    }
    // Name each line, then join neighbours from the same person into one utterance.
    const out = [];
    for (const s of clean) {
      const startMs = Math.round(s.start * 1000), endMs = Math.round(s.end * 1000);
      const speaker = (s.dgSpeaker != null ? voiceName.get(s.dgSpeaker) || `Speaker ${s.dgSpeaker + 1}` : null)
        || speakerAt(caps, startMs, endMs) || out.at(-1)?.speaker || 'Unknown';
      const prev = out.at(-1);
      if (prev && prev.speaker === speaker && startMs - prev.endMs < 2500 && prev.text.length < 600) {
        prev.text += ` ${s.text}`;
        prev.endMs = endMs;
      } else out.push({ speaker, text: s.text, t_ms: startMs, endMs });
    }
    return out.map(({ speaker, text, t_ms }) => ({ speaker, text, t_ms }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
