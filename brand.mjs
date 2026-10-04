// White-label branding. Pick a preset with BRAND=<name> (a file in brands/), then override any field with env vars.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Everything the UI shows (name, logo, colors, theme) comes from here.

const DEFAULT = {
  name: 'Meeting Bot',
  tagline: '',
  logo: null,                 // null = built-in diamond mark; or a URL / path under public/
  color: '#0158cb',           // buttons, links, focus, active states
  color2: '#2f7bff',          // lighter stop for button gradients
  accent: '#0158cb',          // soft highlights and the page glow
  buttonText: '#ffffff',
  theme: 'auto',              // auto | light | dark
  neutrals: null,             // optional surface overrides, e.g. { bg, surface, side, border, soft, 'soft-2', ink, 'ink-2', muted }
  botName: 'Notetaker',
  singleWorkspace: false,     // true = one company space, no workspace switcher
};

// Brand presets are JSON files in brands/ (e.g. brands/acme.json, picked with BRAND=acme).
// The open-source repo ships none; a white-label build adds its own file + logo in public/brands/.
function preset(name) {
  if (!name || name === 'default') return DEFAULT;
  if (!/^[a-z0-9-]+$/.test(name)) return DEFAULT;
  const file = join(import.meta.dirname, 'brands', `${name}.json`);
  if (!existsSync(file)) { console.warn(`Brand preset "${name}" not found in brands/; using the default look`); return DEFAULT; }
  return { ...DEFAULT, ...JSON.parse(readFileSync(file, 'utf8')) };
}

const HEX = /^#[0-9a-f]{3,8}$/i;
const env = (k) => process.env[k]?.trim() || undefined;

export function loadBrand() {
  const base = preset(env('BRAND'));
  const b = {
    ...base,
    name: env('BRAND_NAME') ?? base.name,
    tagline: env('BRAND_TAGLINE') ?? base.tagline,
    logo: env('BRAND_LOGO_URL') ?? base.logo,
    color: env('BRAND_COLOR') ?? base.color,
    color2: env('BRAND_COLOR_2') ?? (env('BRAND_COLOR') ? env('BRAND_COLOR') : base.color2),
    accent: env('BRAND_ACCENT') ?? (env('BRAND_COLOR') && !env('BRAND') ? env('BRAND_COLOR') : base.accent),
    theme: ['auto', 'light', 'dark'].includes(env('BRAND_THEME')) ? env('BRAND_THEME') : base.theme,
    botName: env('BOT_NAME') ?? base.botName,
    singleWorkspace: env('SINGLE_WORKSPACE') ? env('SINGLE_WORKSPACE') === '1' : base.singleWorkspace,
  };
  for (const k of ['color', 'color2', 'accent', 'buttonText']) if (!HEX.test(b[k])) b[k] = DEFAULT[k];
  return b;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Inline into app.html so the right brand paints on first frame (no flash of the default look).
export function brandHead(b) {
  const vars = [
    `--blue:${b.color}`, `--blue-2:${b.color2}`, `--btn-text:${b.buttonText}`, `--accent:${b.accent}`,
    `--blue-soft:color-mix(in srgb, ${b.accent} 16%, var(--surface))`,
    `--sky-1:color-mix(in srgb, ${b.accent} 16%, var(--bg))`,
    ...Object.entries(b.neutrals || {}).map(([k, v]) => `--${k}:${v}`),
  ].join(';');
  const pub = { name: b.name, tagline: b.tagline, logo: b.logo, theme: b.theme };
  return [
    `<title>${esc(b.name)}</title>`,
    b.logo ? `<link rel="icon" href="${esc(b.logo)}">` : '',
    `<meta name="theme-color" content="${esc(b.neutrals?.bg || b.color)}">`,
    // :root:root:root outranks the theme blocks in style.css, so brand values always win.
    `<style>:root:root:root{${vars}}</style>`,
    `<script>window.__BRAND=${JSON.stringify(pub).replace(/</g, '\\u003c')};${b.theme !== 'auto' ? `document.documentElement.dataset.theme=${JSON.stringify(b.theme)};` : ''}</script>`,
  ].join('\n');
}
