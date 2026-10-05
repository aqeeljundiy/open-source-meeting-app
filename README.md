# Open Source Meeting App

A self-hosted meeting notetaker, like Read.ai or Otter, that you run yourself.
A bot joins your **Google Meet** or **Zoom** call, records it, turns the live
captions into a transcript, and **Claude** writes the summary, action items and
files the meeting into the right folder.

- **Bot joins as an anonymous guest.** No Google or Zoom account, no Zoom SDK. Someone in the call clicks *Admit*.
- **Transcript from the meeting's own captions** (with speaker names), or, for better accuracy in other languages (e.g. Indonesian), transcription of the recording with Gemini through SumoPod, ElevenLabs Scribe, Groq Whisper, OpenAI Whisper or Deepgram (Settings → Transcript). Speaker names still come from the captions.
- **Audio-only copy** of every recording next to the video, so the sound survives even if the video stutters.
- **Notes with the AI you choose:** Claude, ChatGPT (OpenAI) or DeepSeek, set in Settings → AI. Summary, key points, decisions, open questions, topics.
- **Tasks:** action items become tasks, matched to workspace members, with a link to the moment they were said.
- **Auto-folders:** Claude picks the meeting type, tags and folder; your rules (people, keywords, email domains) win.
- **Google Calendar auto-join (optional):** the bot joins your calendar meetings a minute before they start.
- **Accounts and workspaces:** email + password or Google sign-in; owner / member / viewer roles.
- One small Node app, SQLite, no framework. Everything runs on your server.

## Run with Docker (recommended)

```bash
docker build -t meeting-app .
docker run -d -p 4350:4350 -v meeting-data:/app/data \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e COOKIE_SECURE=1 -e PUBLIC_URL=https://notes.example.com \
  --shm-size=1g meeting-app
```

Open `http://localhost:4350`, create an account, and use **Send bot to a meeting**.

The image contains Google Chrome, a virtual screen (Xvfb) and a virtual audio
device, so bots record video and audio on a headless server. Plan for roughly
**1–1.5 CPU cores and 1–1.5 GB RAM per meeting in progress**.

**Dokploy / Coolify / any Docker host:** deploy the repo with its Dockerfile, expose port `4350`,
mount a volume at `/app/data`, and set the environment variables below.

## Run locally (macOS / Linux)

```bash
cp .env.example .env          # add ANTHROPIC_API_KEY
pnpm install
node server.mjs               # http://localhost:4350
```

Google Chrome must be installed. Bots open a visible Chrome window.

## Configuration

| Variable | Needed | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` | for notes | Server-wide AI keys. Or paste a key in **Settings → AI** (stored encrypted) |
| `TOKEN_KEY` | no | Encrypts keys saved in Settings (default: a key generated in the data folder) |
| `ANTHROPIC_WORKSPACE_ID` | sometimes | Only if your key isn't tied to an Anthropic workspace |
| `PUBLIC_URL` | in production | Your app's URL, e.g. `https://notes.example.com` (used for Google sign-in) |
| `COOKIE_SECURE` | in production | `1` behind HTTPS |
| `OPEN_SIGNUP` | no | `1` lets anyone sign up. Default: only the first account, then invited emails |
| `BOT_NAME` | no | Name the bot joins with (default `Notetaker`) |
| `RECORD_VIDEO` | no | `0` = audio only (much lighter) |
| `DEEPGRAM_API_KEY` | no | Transcribe the recording when a meeting has no captions (or pick Deepgram in Settings → Transcript) |
| `ELEVENLABS_API_KEY`, `GROQ_API_KEY` | no | Server-wide keys for transcribing recordings (each workspace can also paste its own in Settings) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | Google sign-in + Calendar auto-join |
| `GOOGLE_LOGIN` | no | `0` hides "Continue with Google" (calendar connect still works) |
| `ADMIT_TIMEOUT_MIN`, `ALONE_TIMEOUT_MIN`, `MAX_MEETING_MIN` | no | Bot timing |

### Branding (white-label)

Every install can carry its own brand, no code changes:

| Variable | Example | What it does |
|---|---|---|
| `BRAND` | `example` | Start from a preset file in `brands/` (see `brands/example.json`) |
| `BRAND_NAME` / `BRAND_TAGLINE` | `Acme` / `Meetings` | Name in the sidebar, login page and browser tab |
| `BRAND_LOGO_URL` | `https://acme.com/logo.svg` | Square logo (also the favicon) |
| `BRAND_COLOR` / `BRAND_COLOR_2` | `#ee6351` / `#f27a6a` | Buttons, links, focus (and the gradient's light stop) |
| `BRAND_ACCENT` | `#83b271` | Soft highlights and the page glow |
| `BRAND_THEME` | `dark` | `auto` (follow the system), `light` or `dark` |
| `BOT_NAME` | `Acme Notetaker` | Name the bot joins meetings with |

Add your own preset as `brands/<name>.json` (any of the fields above, plus `theme`, `neutrals`, `singleWorkspace`) and put the logo in `public/brands/`.

### Google sign-in and Calendar (optional)

1. In Google Cloud, create a project and enable the **Google Calendar API**.
2. Google Auth Platform → set up the consent screen (External), add scopes `openid`, `userinfo.email`,
   `userinfo.profile`, `calendar.events.readonly`, and add yourself as a test user.
3. Clients → create a **Web application** client with redirect URI `https://YOUR_DOMAIN/api/auth/google/callback`.
4. Put the client ID and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

Each installation uses its own Google client. Public use needs Google's app verification.

## How it works

```
server.mjs       API + dashboard (node:http), spawns one bot process per meeting
bot/run.mjs      starts Chrome, joins, records, reads captions, leaves when the meeting ends
bot/platforms.mjs  the Meet / Zoom clicking steps  ← fix here when a platform changes its UI
bot/page.mjs     in-page recorder (tab video, or audio straight from WebRTC) + caption reader
pipeline.mjs     after the call: transcript fallback, Claude notes, tasks, filing
calendar.mjs     Google sign-in, calendar sync, auto-join scheduler
auth.mjs         accounts, sessions, workspaces, roles
db.mjs           SQLite schema (node:sqlite)
public/          the dashboard (plain JS)
```

Notes on bot behaviour:
- Google Meet rejects browsers that look automated, so the bot starts a normal Chrome,
  attaches over the DevTools protocol, uses no fake camera/mic, and types and clicks with human timing.
- Screen recording needs the bot window to have focus. On a server (Xvfb) it does; on a
  desktop the bot falls back to recording audio.
- Some meetings block guests (e.g. hosts who only allow invited or signed-in users).

## Recording consent

The bot posts *"I'm recording this meeting and taking notes"* in the meeting chat when it joins.
Recording laws differ by country; make sure everyone in the call agrees to be recorded.

## License

[AGPL-3.0](LICENSE). You can use, change and self-host it freely. If you offer a modified
version as a hosted service, you must publish your changes under the same license.
