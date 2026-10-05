import './select.js';
// Single-page app: sidebar + views. Plain JS, re-renders a view on navigation / poll.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = (ms) => { const s = Math.floor((ms || 0) / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const when = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
const day = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';

// Brand (injected by the server into app.html; see brand.mjs).
// Which AI the workspace uses (Settings → AI), for wording like "ChatGPT picks the folder".
const aiName = () => me?.aiName || 'the AI';
// Older browser recordings don't store their length, so players show a wrong, growing time.
// Seeking far past the end makes the browser work out the real length, then jump back.
function fixDuration(v) {
  v?.addEventListener('loadedmetadata', function once() {
    if (v.duration !== Infinity && !Number.isNaN(v.duration)) return;
    v.addEventListener('durationchange', function back() {
      if (v.duration === Infinity) return;
      v.removeEventListener('durationchange', back);
      v.currentTime = 0;
    });
    v.currentTime = 1e7;
  }, { once: true });
}
const BRAND = window.__BRAND || { name: 'Meeting Bot', tagline: '', logo: null };
const brandMark = () => `${BRAND.logo ? `<img class="logo" src="${esc(BRAND.logo)}" alt="">` : '<span class="mark">◆</span>'}<span class="bname"><span>${esc(BRAND.name)}</span>${BRAND.tagline ? `<small>${esc(BRAND.tagline)}</small>` : ''}</span>`;

const STATUS = { queued: 'Queued', joining: 'Joining', waiting_room: 'Waiting to be let in', recording: 'Recording', stopping: 'Stopping', processing: 'Writing notes', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
const LIVE = ['queued', 'joining', 'waiting_room', 'recording', 'stopping', 'processing'];
const TYPE = { sales: 'Sales', client: 'Client', internal: 'Internal', hiring: 'Hiring', partner: 'Partner', one_on_one: '1:1', other: 'Other' };
const ROLE = { owner: 'Owner', member: 'Member', viewer: 'Viewer' };

let me = null;           // { user, workspace, workspaces, meetingTypes, colors }
let folders = { folders: [], unfiled: 0, rules: [] };
let pollTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body !== undefined || (opts.method && opts.method !== 'GET') ? { 'Content-Type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : (opts.method && opts.method !== 'GET' ? '{}' : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) { me = null; go('/login'); throw new Error('Sign in first'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ''), 2600);
}
const attempt = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function go(path, replace = false) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  route();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || a.target || e.metaKey || e.ctrlKey || a.hasAttribute('download') || a.getAttribute('href').startsWith('/recordings') || a.getAttribute('href').startsWith('/api')) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
addEventListener('popstate', () => route());
addEventListener('resize', () => moveIndicator(true));

const canEdit = () => me?.workspace && me.workspace.role !== 'viewer';
const isOwner = () => me?.workspace?.role === 'owner';
const dot = (color) => `<span class="fdot c-${esc(color || 'gray')}"></span>`;

// ---------- shell ----------
async function refreshShell() {
  me = await api('/api/me');
  folders = me.workspace ? await api('/api/folders') : { folders: [], unfiled: 0, rules: [] };
}

let animateNext = true;   // set on navigation; polls re-render without animating
let sideSig = '';

function shell(active, content) {
  const path = location.pathname;
  const link = (href, label, icon, extra = '') =>
    `<a class="nav ${path === href ? 'on' : ''}" href="${href}">${icon}<span>${label}</span>${extra}</a>`;
  const sig = JSON.stringify([me.user, me.workspace, me.workspaces, folders.folders, folders.unfiled]);
  // Same sidebar as last time: only swap the page, so the sidebar doesn't flash.
  if (sig === sideSig && $('#side') && $('#view')) {
    $$('.nav', $('#side')).forEach((a) => a.classList.toggle('on', a.getAttribute('href') === path));
    moveIndicator();
    $('#side').classList.remove('open');
    setView(content);
    afterShell();
    return;
  }
  sideSig = sig;
  $('#root').innerHTML = `
  <div class="app">
    <aside class="side" id="side">
      <div class="side-top">
        <a class="brand" href="/">${brandMark()}</a>
        <button class="icon-btn only-mobile" id="closeSide" aria-label="Close menu">✕</button>
      </div>
${me.singleWorkspace ? '' : `      <label class="ws">
        <span class="sr">Workspace</span>
        <select id="wsSelect">
          ${me.workspaces.map((w) => `<option value="${w.id}" ${w.id === me.workspace?.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
          <option value="__new">+ New workspace…</option>
        </select>
      </label>`}
      ${canEdit() ? `<button class="btn btn-blue btn-block" id="newMeeting">+ Send bot to a meeting</button>` : ''}
      <nav><span class="nav-ind" aria-hidden="true"></span>
        ${link('/', 'Meetings', ICON.meet)}
        ${link('/upcoming', 'Upcoming', ICON.cal)}
        ${link('/tasks', 'Tasks', ICON.task)}
        <button class="nav nav-ask" type="button" data-ask>${ICON.spark}<span>Ask AI</span></button>
        <div class="nav-head"><span>Folders</span>${canEdit() ? '<button class="icon-btn" id="newFolder" aria-label="New folder">+</button>' : ''}</div>
        ${folders.folders.map((f) => link(`/folders/${f.id}`, esc(f.name), dot(f.color), `<em>${f.meeting_count}</em>`)).join('')}
        ${link('/folders/none', 'Unfiled', dot('gray'), `<em>${folders.unfiled}</em>`)}
      </nav>
      <div class="side-bottom">
        ${link('/settings', 'Settings', ICON.gear)}
        <div class="me"><span class="avatar">${esc(me.user.name[0] || '?')}</span><span class="me-name">${esc(me.user.name)}<small>${ROLE[me.workspace?.role] || ''}</small></span>
          <button class="icon-btn" id="logout" aria-label="Sign out" title="Sign out">${ICON.out}</button></div>
      </div>
    </aside>
    <main class="main">
      <div class="mobile-bar only-mobile"><button class="icon-btn" id="openSide" aria-label="Open menu">☰</button><span class="brand">${brandMark()}</span></div>
      <div class="content" id="view"></div>
    </main>
  </div>`;

  setView(content);
  afterShell();
  requestAnimationFrame(() => moveIndicator(true));
  $('#openSide')?.addEventListener('click', () => $('#side').classList.add('open'));
  $('#closeSide')?.addEventListener('click', () => $('#side').classList.remove('open'));
  $('#logout').onclick = attempt(async () => { await api('/api/auth/logout', { method: 'POST' }); me = null; go('/login'); });
  if ($('#wsSelect')) $('#wsSelect').onchange = attempt(async (e) => {
    if (e.target.value === '__new') {
      const name = prompt('Name the new workspace (e.g. a company or team)');
      if (!name) { e.target.value = me.workspace?.id; return; }
      await api('/api/workspaces', { body: { name } });
    } else await api('/api/workspaces/switch', { body: { id: e.target.value } });
    await refreshShell();
    go('/');
  });
  $('#newMeeting')?.addEventListener('click', openNewMeeting);
  $('#newFolder')?.addEventListener('click', attempt(async () => {
    const name = prompt('Folder name (a client, project or company)');
    if (!name) return;
    const { id } = await api('/api/folders', { body: { name } });
    await refreshShell();
    go(`/folders/${id}`);
  }));
}

// Page content rises in, children staggered.
function setView(html) {
  const v = $('#view');
  v.innerHTML = html;
  if (!animateNext) return;
  animateNext = false;
  v.classList.remove('enter');
  void v.offsetWidth;
  [...v.children].forEach((el, i) => el.style.setProperty('--i', Math.min(i, 8)));
  stagger(v);
  v.classList.add('enter');
}
// Rows inside lists come in one after another.
function stagger(root) {
  $$('.list > *, .tasks > *, .events > .event, .people > .person, .task-group > .task, .days > section, .stats > *, .timeline > *', root)
    .forEach((el, i, all) => el.style.setProperty('--j', Math.min(Array.prototype.indexOf.call(el.parentNode.children, el), 12)));
}
// The highlight behind the active sidebar item glides to it.
function moveIndicator(instant = false) {
  const ind = $('.nav-ind');
  const on = $('.side .nav.on');
  if (!ind) return;
  if (!on || !on.closest('nav')) { ind.style.opacity = 0; return; }
  ind.classList.toggle('instant', instant);
  ind.style.opacity = 1;
  ind.style.transform = `translateY(${on.offsetTop}px)`;
  ind.style.height = `${on.offsetHeight}px`;
}

const ICON = {
  spark: '<svg viewBox="0 0 24 24" class="ic"><path d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.5l-1.8-5L5 9.7l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
  send: '<svg viewBox="0 0 24 24" class="ic"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg>',
  history: '<svg viewBox="0 0 24 24" class="ic"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg>',
  cal: '<svg viewBox="0 0 24 24" class="ic"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  google: '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>',
  meet: '<svg viewBox="0 0 24 24" class="ic"><rect x="3" y="6" width="13" height="12" rx="3"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
  task: '<svg viewBox="0 0 24 24" class="ic"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  out: '<svg viewBox="0 0 24 24" class="ic"><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H4"/></svg>',
};

// ---------- new meeting dialog ----------
function openNewMeeting() {
  const d = document.createElement('dialog');
  d.className = 'modal';
  d.innerHTML = `
    <form method="dialog" id="nm">
      <h2>Send the bot to a meeting</h2>
      <p class="muted">Paste a Google Meet or Zoom link. Someone in the call has to let the bot in.</p>
      <label>Meeting link<input name="url" type="url" required placeholder="https://meet.google.com/abc-defg-hij"></label>
      <label><span>Title <span class="muted">(optional)</span></span><input name="title" placeholder="Weekly sync with…"></label>
      <label><span>Bot name <span class="muted">(optional, for this meeting)</span></span><input name="botName" maxlength="40" placeholder="${esc(me.botName)}"></label>
      <label><span>Folder <span class="muted">(optional, otherwise filed automatically)</span></span>
        <select name="folder_id"><option value="">Auto</option>${folders.folders.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></label>
      <p class="form-error" id="nmErr"></p>
      <div class="row-end"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn btn-blue" value="go">Send bot</button></div>
    </form>`;
  document.body.appendChild(d);
  d.showModal();
  d.addEventListener('close', () => d.remove());
  // Animate out instead of vanishing.
  d.addEventListener('cancel', (e) => { e.preventDefault(); closeAnimated(d); });
  d.addEventListener('click', (e) => { if (e.target === d) closeAnimated(d); });
  $('#nm', d).addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'go') { e.preventDefault(); closeAnimated(d); return; }
    e.preventDefault();
    try {
      const m = await api('/api/meetings', { body: Object.fromEntries(new FormData(e.target)) });
      d.close();
      go(`/m/${m.id}`);
    } catch (err) { $('#nmErr', d).textContent = err.message; }
  });
}

function closeAnimated(d) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return d.close();
  d.classList.add('closing');
  setTimeout(() => { if (d.open) d.close(); d.remove(); }, 210);   // after the .2s pop-out
}

// ---------- auth ----------
async function viewAuth(mode) {
  $('#askFab')?.remove(); $('#askPanel')?.remove(); ask.open = false; document.body.classList.remove('ask-open');
  const cfg = await fetch('/api/auth/config').then((r) => r.json()).catch(() => ({}));
  const err = new URLSearchParams(location.search).get('error');
  sideSig = '';
  $('#root').innerHTML = `
  <div class="auth enter">
    <a class="brand" href="/login">${brandMark()}</a>
    <div class="card auth-card">
      <h1>${mode === 'signup' ? 'Create your account' : 'Welcome back'}</h1>
      <p class="muted">${mode === 'signup' ? `Your ${esc(BRAND.name)} notetaker for Google Meet and Zoom.` : 'Sign in to your meetings, notes and tasks.'}</p>
      ${cfg.googleLogin ? `<a class="btn btn-block btn-google" href="/api/auth/google/start">${ICON.google} Continue with Google</a>
      <div class="or"><span>or with email</span></div>` : ''}
      ${cfg.magic && mode === 'login' ? `<form id="magicForm" class="magic">
        <label>Work email<input name="email" type="email" required autocomplete="email" ${cfg.domains?.length ? `placeholder="you@${esc(cfg.domains[0])}"` : ''}></label>
        <button class="btn btn-blue btn-block">Email me a sign-in link</button>
        <p class="muted small center" id="magicMsg"></p>
      </form>
      <div class="or"><span>or with a password</span></div>` : ''}
      <form id="authForm">
        ${mode === 'signup' ? '<label>Name<input name="name" required autocomplete="name"></label>' : ''}
        <label>Email<input name="email" type="email" required autocomplete="email" ${cfg.domains?.length ? `placeholder="you@${esc(cfg.domains[0])}"` : ''}></label>
        ${cfg.domains?.length ? `<p class="muted small" style="margin:-6px 0 12px">Only ${cfg.domains.map((d) => '@' + esc(d)).join(' / ')} accounts.</p>` : ''}
        <label>Password<input name="password" type="password" required minlength="${mode === 'signup' ? 8 : 1}" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"></label>
        <p class="form-error" id="authErr">${esc(err || '')}</p>
        <button class="btn btn-blue btn-block">${mode === 'signup' ? 'Create account' : 'Sign in'}</button>
      </form>
      <p class="muted center">${mode === 'signup' ? 'Have an account? <a href="/login">Sign in</a>' : 'New here? <a href="/signup">Create an account</a>'}</p>
    </div>
  </div>`;
  $('#magicForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', e.target);
    btn.disabled = true;
    try {
      await api('/api/auth/magic', { body: { email: new FormData(e.target).get('email') } });
      e.target.innerHTML = `<div class="magic-sent"><b>Check your inbox</b><p class="muted small">If that address can use this app, a sign-in link is on its way. It works once and expires in 15 minutes.</p></div>`;
    } catch (err) { $('#magicMsg').textContent = err.message; $('#magicMsg').classList.add('bad'); btn.disabled = false; }
  });
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', e.target);
    btn.disabled = true;
    try {
      await api(`/api/auth/${mode}`, { body: Object.fromEntries(new FormData(e.target)) });
      await refreshShell();
      go('/', true);
    } catch (err) { $('#authErr').textContent = err.message; btn.disabled = false; }
  });
}

// ---------- meetings list ----------
async function viewMeetings(folderId, asTab = false) {
  const params = new URLSearchParams(location.search);
  const folder = folderId === 'none' ? { name: 'Unfiled' } : folders.folders.find((f) => f.id === folderId);
  if (folderId && !folder) return viewMissing();
  const qs = new URLSearchParams();
  if (folderId) qs.set('folder', folderId);
  if (params.get('q')) qs.set('q', params.get('q'));
  if (params.get('type')) qs.set('type', params.get('type'));
  const rows = await api(`/api/meetings?${qs}`);
  const rules = folderId && folderId !== 'none' ? folders.rules.filter((r) => r.folder_id === folderId) : [];

  const head = asTab
    ? `${folderHead(folder, folderId)}<div class="tabs">${folderTab('Overview', 'overview', 'meetings', folderId)}${folderTab(`Meetings ${rows.length}`, 'meetings', 'meetings', folderId)}${folderTab('Tasks', 'tasks', 'meetings', folderId)}</div>`
    : null;
  shell('meetings', head ? `${head}
    <form class="filters" id="filters">
      <input name="q" type="search" placeholder="Search this folder" value="${esc(params.get('q') || '')}">
      <select name="type"><option value="">All types</option>${Object.entries(TYPE).map(([k, v]) => `<option value="${k}" ${params.get('type') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <input type="hidden" name="tab" value="meetings">
    </form>
    <div class="list">${rows.length ? rows.map(meetingRow).join('') : '<div class="card empty">Nothing matches.</div>'}</div>` : `
    <div class="page-head">
      <div><h1>${folder ? `${folderId !== 'none' ? dot(folder.color) : ''} ${esc(folder.name)}` : 'Meetings'}</h1>
        <p class="muted">${folderId === 'none' ? 'Meetings that did not fit a folder yet.' : folder ? `${rows.length} meeting${rows.length === 1 ? '' : 's'}` : 'Every meeting the bot has joined in this workspace.'}</p></div>
      ${folder && folderId !== 'none' && canEdit() ? `<div class="row-end"><button class="btn btn-sm" id="renameFolder">Rename</button><button class="btn btn-sm btn-danger" id="deleteFolder">Delete folder</button></div>` : ''}
    </div>
    ${rules.length ? `<div class="soft rules"><b>Auto-filed here when</b> ${rules.map((r) => `<span class="chip">${r.kind === 'participant' ? 'with' : 'mentions'} ${esc(r.value)}${canEdit() ? `<button data-rule="${r.id}" aria-label="Remove rule">✕</button>` : ''}</span>`).join('')}</div>` : ''}
    <form class="filters" id="filters">
      <input name="q" type="search" placeholder="Search titles, notes and transcripts" value="${esc(params.get('q') || '')}">
      <select name="type"><option value="">All types</option>${Object.entries(TYPE).map(([k, v]) => `<option value="${k}" ${params.get('type') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    </form>
    <div class="list">${rows.length ? rows.map(meetingRow).join('') : `<div class="card empty">${params.get('q') || params.get('type') ? 'Nothing matches.' : canEdit() ? 'No meetings here yet. Use “Send bot to a meeting”.' : 'No meetings here yet.'}</div>`}</div>`);

  const f = $('#filters');
  let t;
  f.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { const p = new URLSearchParams(new FormData(f)); [...p].forEach(([k, v]) => !v && p.delete(k)); go(`${location.pathname}${p.size ? '?' + p : ''}`, true); }, 300); });
  f.addEventListener('submit', (e) => e.preventDefault());
  $$('[data-rule]').forEach((b) => b.onclick = attempt(async () => { await api(`/api/rules/${b.dataset.rule}`, { method: 'DELETE' }); await refreshShell(); route(); }));
  $('#renameFolder')?.addEventListener('click', attempt(async () => {
    const name = prompt('Folder name', folder.name);
    if (!name) return;
    await api(`/api/folders/${folderId}`, { method: 'PATCH', body: { name } });
    await refreshShell(); route();
  }));
  $('#deleteFolder')?.addEventListener('click', attempt(async () => {
    if (!confirm(`Delete “${folder.name}”? Its meetings move to Unfiled.`)) return;
    await api(`/api/folders/${folderId}`, { method: 'DELETE' });
    await refreshShell(); go('/');
  }));
  const s = $('input[name=q]');
  if (params.get('q')) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  if (rows.some((r) => LIVE.includes(r.status))) poll(() => viewMeetings(folderId), 4000);
}

function meetingRow(m) {
  return `
    <a class="row" href="/m/${m.id}">
      <span class="plat ${m.platform}">${m.platform === 'zoom' ? 'Zm' : 'GM'}</span>
      <span class="row-main">
        <span class="title">${esc(m.ai_title || m.title || m.url)}</span>
        <span class="meta">${when(m.created_at)}${m.meeting_type ? ` · ${TYPE[m.meeting_type]}` : ''}${m.open_tasks ? ` · ${m.open_tasks} open task${m.open_tasks > 1 ? 's' : ''}` : ''}${m.error ? ` · <span class="bad">${esc(m.error)}</span>` : ''}</span>
      </span>
      <span class="row-side">
        ${m.folder_name ? `<span class="chip">${dot(m.folder_color)}${esc(m.folder_name)}</span>` : ''}
        ${m.status !== 'done' ? `<span class="pill ${m.status}">${STATUS[m.status] || m.status}</span>` : ''}
      </span>
    </a>`;
}

// ---------- folder (client / project) ----------
async function viewFolder(folderId) {
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab') || 'overview';
  if (tab === 'meetings') return viewMeetings(folderId, true);
  const [data, { members }] = await Promise.all([api(`/api/folders/${folderId}/overview`).catch(() => null), api('/api/workspace/members')]);
  if (!data) return viewMissing();
  const { folder, stats, overview: o } = data;
  const pct = stats.tasks ? Math.round(stats.done / stats.tasks * 100) : 0;
  const list = (items, empty) => items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : `<p class="muted">${empty}</p>`;
  const body = tab === 'tasks'
    ? `${data.tasks.length ? bulkBar() : ''}<div class="tasks">${data.tasks.length ? groupTasks(data.tasks, members) : '<div class="card empty">No tasks from these meetings yet.</div>'}</div>`
    : `
      <div class="stats">
        <div class="card stat"><span>Meetings</span><b>${stats.meetings}</b><small>${stats.first ? `since ${day(stats.first)}` : '—'}</small></div>
        <div class="card stat"><span>Open tasks</span><b>${stats.open}</b><small>${stats.done} done</small></div>
        <div class="card stat"><span>Progress</span><b>${pct}%</b><div class="bar"><i style="width:${pct}%"></i></div></div>
        <div class="card stat"><span>Last meeting</span><b class="stat-sm">${stats.last ? day(stats.last) : '—'}</b><small>${stats.last ? when(stats.last).split(',').slice(-1)[0].trim() : ''}</small></div>
      </div>
      <div class="card overview">
        <div class="ov-head">
          <div><h2>${o ? esc(o.headline) : 'Account overview'}</h2>
            <p class="muted small">${data.overview_at ? `Written by ${esc(aiName())} from ${stats.meetings} meeting${stats.meetings === 1 ? '' : 's'} · updated ${when(data.overview_at)}` : `${esc(aiName())} writes this from all meetings in this folder.`}</p></div>
          ${canEdit() && stats.meetings ? `<button class="btn btn-sm" id="ovRefresh">${o ? 'Refresh overview' : 'Write overview'}</button>` : ''}
        </div>
        ${o ? `
          <p class="lead">${esc(o.summary)}</p>
          <p class="ov-progress"><b>Progress</b> ${esc(o.progress)}</p>
          <div class="ov-cols">
            <section><h3>Wins</h3>${list(o.wins, 'Nothing yet')}</section>
            <section><h3>Risks</h3>${list(o.risks, 'None flagged')}</section>
            <section><h3>Next steps</h3>${list(o.next_steps, 'None')}</section>
          </div>` : `<p class="muted">${stats.meetings ? 'No overview yet.' : 'No meetings in this folder yet.'}</p>`}
      </div>
      <h3 class="section-h">Timeline</h3>
      <div class="timeline">${data.meetings.map((m) => `
        <a class="tl-item" href="/m/${m.id}"><span class="tl-dot"></span>
          <span class="tl-date">${day(m.created_at)}</span>
          <span class="tl-main"><b>${esc(m.ai_title || m.title || 'Meeting')}</b>${m.ai_summary ? `<small>${esc(m.ai_summary.slice(0, 180))}${m.ai_summary.length > 180 ? '…' : ''}</small>` : ''}</span>
        </a>`).join('') || '<p class="muted">No meetings yet.</p>'}</div>`;

  shell('folder', `
    ${folderHead(folder, folderId)}
    <div class="tabs">${folderTab('Overview', 'overview', tab, folderId)}${folderTab(`Meetings ${stats.meetings}`, 'meetings', tab, folderId)}${folderTab(`Tasks ${stats.open || ''}`, 'tasks', tab, folderId)}</div>
    ${body}`);
  bindFolderHead(folder, folderId);
  if (tab === 'tasks') { bindTasks(members, () => route()); bindBulk($('#view'), () => route()); }
  $('#ovRefresh')?.addEventListener('click', attempt(async (e) => {
    e.target.disabled = true; e.target.textContent = 'Writing…';
    await api(`/api/folders/${folderId}/overview`, { method: 'POST' });
    route(); toast('Overview updated');
  }));
}
const folderTab = (label, key, tab, id) => `<a class="tab ${tab === key ? 'on' : ''}" href="/folders/${id}${key === 'overview' ? '' : `?tab=${key}`}">${label}</a>`;
function folderHead(folder, folderId) {
  return `<div class="page-head">
    <div><h1>${dot(folder.color)} ${esc(folder.name)}</h1><p class="muted">Client / project folder</p></div>
    ${canEdit() ? `<div class="row-end"><button class="btn btn-sm" id="renameFolder">Rename</button><button class="btn btn-sm btn-danger" id="deleteFolder">Delete folder</button></div>` : ''}
  </div>`;
}
function bindFolderHead(folder, folderId) {
  $('#renameFolder')?.addEventListener('click', attempt(async () => {
    const name = prompt('Folder name', folder.name);
    if (!name) return;
    await api(`/api/folders/${folderId}`, { method: 'PATCH', body: { name } });
    await refreshShell(); route();
  }));
  $('#deleteFolder')?.addEventListener('click', attempt(async () => {
    if (!confirm(`Delete “${folder.name}”? Its meetings move to Unfiled.`)) return;
    await api(`/api/folders/${folderId}`, { method: 'DELETE' });
    await refreshShell(); go('/');
  }));
}

// ---------- tasks ----------
async function viewTasks() {
  const params = new URLSearchParams(location.search);
  const status = params.get('status') || 'open';
  const mine = params.get('mine') === '1';
  const [tasks, { members }] = await Promise.all([
    api(`/api/tasks?status=${status}${mine ? '&mine=1' : ''}`),
    api('/api/workspace/members'),
  ]);
  const tab = (label, s, m) => `<a class="tab ${status === s && mine === m ? 'on' : ''}" href="/tasks?status=${s}${m ? '&mine=1' : ''}">${label}</a>`;

  shell('tasks', `
    <div class="page-head"><div><h1>Tasks</h1><p class="muted">Action items from every meeting, plus your own.</p></div></div>
    <div class="tabs">${tab('Open', 'open', false)}${tab('Mine', 'open', true)}${tab('Done', 'done', false)}${tab('All', 'all', false)}</div>
    ${canEdit() ? `<form class="add-task card" id="addTask">
      <input name="title" placeholder="Add a task…" required>
      <select name="assignee_id"><option value="">Unassigned</option>${members.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      <input name="due" placeholder="Due (e.g. Friday)">
      <button class="btn btn-blue">Add</button>
    </form>` : ''}
    ${tasks.length ? bulkBar() : ''}
    <div class="tasks">${tasks.length ? groupTasks(tasks, members) : `<div class="card empty">${status === 'done' ? 'Nothing finished yet.' : 'No open tasks. Nice.'}</div>`}</div>`);

  $('#addTask')?.addEventListener('submit', attempt(async (e) => {
    e.preventDefault();
    await api('/api/tasks', { body: Object.fromEntries(new FormData(e.target)) });
    route();
  }));
  bindTasks(members, () => route());
  bindBulk($('#view'), () => route());
}

function groupTasks(tasks, members) {
  // Group by meeting; manual tasks without a meeting go first.
  const groups = new Map();
  for (const t of tasks) {
    const key = t.meeting_id || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups].map(([mid, list]) => {
    const t0 = list[0];
    const head = mid
      ? `<a href="/m/${mid}" class="group-head">${esc(t0.meeting_ai_title || t0.meeting_title || 'Meeting')}<span class="muted">${day(t0.meeting_date)}${t0.folder_name ? ` · ${esc(t0.folder_name)}` : ''}</span></a>`
      : `<div class="group-head">Added by hand</div>`;
    return `<section class="card task-group">${head}${list.map((t) => taskRow(t, members)).join('')}</section>`;
  }).join('');
}

function taskRow(t, members) {
  const edit = canEdit();
  return `
    <div class="task ${t.status === 'done' ? 'done' : ''}" data-task="${t.id}">
      ${edit ? `<input type="checkbox" class="pick" aria-label="Select task">` : ''}
      <input type="checkbox" class="check" ${t.status === 'done' ? 'checked' : ''} ${edit ? '' : 'disabled'} aria-label="Done">
      <div class="task-main">
        <div class="task-title" ${edit ? 'contenteditable="plaintext-only" spellcheck="false"' : ''}>${esc(t.title)}</div>
        <div class="task-meta">
          ${edit ? `<select class="assignee" aria-label="Assignee"><option value="">${t.owner_name ? `${esc(t.owner_name)} (not a member)` : 'Unassigned'}</option>${members.map((u) => `<option value="${u.id}" ${u.id === t.assignee_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>`
            : `<span>${esc(t.assignee_name || t.owner_name || 'Unassigned')}</span>`}
          ${edit ? `<input class="due" value="${esc(t.due || '')}" placeholder="No due date" aria-label="Due">` : t.due ? `<span>Due ${esc(t.due)}</span>` : ''}
          ${t.meeting_id && t.t_ms != null ? `<a href="/m/${t.meeting_id}?t=${t.t_ms}" class="jump">▶ ${mmss(t.t_ms)}</a>` : ''}
        </div>
      </div>
      ${edit ? `<button class="icon-btn del" aria-label="Delete task">✕</button>` : ''}
    </div>`;
}

// Bulk actions: "Select" turns on checkboxes; then select all / mark done / reopen / delete.
function bulkBar(extra = '') {
  if (!canEdit()) return '';
  return `<div class="bulkbar" data-bulk>
    <button class="btn btn-sm" data-b="select">Select</button>
    <span class="bulk-on">
      <label class="pick-all"><input type="checkbox" data-b="all"> All</label>
      <span class="muted small" data-b="count">0 selected</span>
      <button class="btn btn-sm" data-b="done">Mark done</button>
      <button class="btn btn-sm" data-b="open">Reopen</button>
      <button class="btn btn-sm btn-danger" data-b="delete">Delete</button>
      <button class="btn btn-sm" data-b="cancel">Cancel</button>
    </span>
    ${extra}
  </div>`;
}
function bindBulk(root, after) {
  const bar = $('[data-bulk]', root);
  if (!bar) return;
  const picks = () => $$('.pick', root);
  const chosen = () => picks().filter((p) => p.checked).map((p) => p.closest('[data-task]').dataset.task);
  const update = () => {
    const n = chosen().length;
    $('[data-b=count]', bar).textContent = `${n} selected`;
    $('[data-b=all]', bar).checked = n > 0 && n === picks().length;
    $('[data-b=all]', bar).indeterminate = n > 0 && n < picks().length;
    $$('[data-b=done],[data-b=open],[data-b=delete]', bar).forEach((b) => (b.disabled = !n));
  };
  const mode = (on) => { root.classList.toggle('selecting', on); if (!on) picks().forEach((p) => (p.checked = false)); update(); };
  $('[data-b=select]', bar).onclick = () => mode(true);
  $('[data-b=cancel]', bar).onclick = () => mode(false);
  $('[data-b=all]', bar).onchange = (e) => { picks().forEach((p) => (p.checked = e.target.checked)); update(); };
  root.addEventListener('change', (e) => { if (e.target.classList.contains('pick')) update(); });
  root.addEventListener('click', (e) => {
    if (!root.classList.contains('selecting')) return;
    const row = e.target.closest('[data-task]');
    if (!row || e.target.closest('input, select, button, a, .sel, [contenteditable]')) return;
    const pick = $('.pick', row);
    pick.checked = !pick.checked;
    update();
  });
  for (const action of ['done', 'open', 'delete']) {
    $(`[data-b=${action}]`, bar).onclick = attempt(async () => {
      const ids = chosen();
      if (action === 'delete' && !confirm(`Delete ${ids.length} task${ids.length > 1 ? 's' : ''}?`)) return;
      await api('/api/tasks/bulk', { body: { ids, action } });
      toast(`${ids.length} task${ids.length > 1 ? 's' : ''} ${action === 'delete' ? 'deleted' : action === 'done' ? 'marked done' : 'reopened'}`);
      after();
    });
  }
  update();
}

function bindTasks(members, after) {
  $$('[data-task]').forEach((row) => {
    const id = row.dataset.task;
    const save = attempt(async (body) => { await api(`/api/tasks/${id}`, { method: 'PATCH', body }); });
    $('.check', row)?.addEventListener('change', attempt(async (e) => {
      row.classList.toggle('done', e.target.checked);
      await save({ status: e.target.checked ? 'done' : 'open' });
      setTimeout(after, 400);
    }));
    const title = $('.task-title', row);
    if (title?.isContentEditable) {
      title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
      title.addEventListener('blur', () => { const v = title.textContent.trim(); if (v) save({ title: v }); });
    }
    $('.assignee', row)?.addEventListener('change', (e) => save({ assignee_id: e.target.value || null }));
    $('.due', row)?.addEventListener('change', (e) => save({ due: e.target.value }));
    $('.del', row)?.addEventListener('click', attempt(async () => {
      await api(`/api/tasks/${id}`, { method: 'DELETE' });
      row.remove();
    }));
  });
}

// ---------- meeting detail ----------
let meetingState = { id: null, utt: -1, log: -1, tab: 'summary' };

async function viewMeeting(id) {
  const [m, { members }] = await Promise.all([api(`/api/meetings/${id}`).catch(() => null), api('/api/workspace/members')]);
  if (!m) return viewMissing();
  const fresh = meetingState.id !== id || !$('#mView');
  if (fresh) {
    meetingState = { id, utt: -1, log: -1, tab: 'summary', tasks: '' };
    shell('meeting', `<div id="mView"></div>`);
  }
  renderMeeting(m, members, fresh);
  if (m.live || LIVE.includes(m.status)) poll(() => viewMeeting(id), 2000);
}

function renderMeeting(m, members, fresh) {
  const n = m.summary;
  const title = n?.title || m.title || (m.platform === 'zoom' ? 'Zoom meeting' : 'Google Meet');
  document.title = title;
  const edit = canEdit();
  const v = $('#mView');
  if (fresh) {
    v.innerHTML = `
      <div class="mhead">
        <div class="mhead-main">
          <div class="crumbs"><span class="pill" id="mStatus"></span><span id="mFiling"></span></div>
          <h1 id="mTitle"></h1>
          <div class="muted" id="mSub"></div>
        </div>
        <div class="row-end" id="mActions"></div>
      </div>
      <div class="m-top">
        <div class="card video-card">
          <video id="video" controls preload="metadata" hidden></video>
          <div class="audio-row" id="audioRow" hidden><span class="muted small">Audio only</span><audio id="audioOnly" controls preload="none"></audio><a class="btn btn-sm" id="audioDl" download>Download</a></div>
          <div class="video-empty" id="videoEmpty"><span>${ICON.meet}</span><b>No recording</b><small id="videoEmptyWhy">The recording appears here after the meeting.</small></div>
        </div>
        <div class="card glance" id="glance"></div>
      </div>
      <div class="card m-tabs">
        <div class="m-tabbar">
          <div class="tabs small" role="tablist">
            <button role="tab" data-tab="summary">Summary</button>
            <button role="tab" data-tab="tasks">Tasks <em id="taskCount"></em></button>
            <button role="tab" data-tab="transcript">Transcript</button>
            <button role="tab" data-tab="log">Bot log</button>
          </div>
          <div class="row-end">
            <a class="btn btn-sm" id="dlTranscript" download hidden>Download .txt</a>
            <button class="btn btn-sm" id="copyTab">Copy</button>
          </div>
        </div>
        <div id="notes" class="notes" role="tabpanel"></div>
        <div id="mTasks" role="tabpanel" hidden></div>
        <div id="transcript" class="transcript" role="tabpanel" hidden></div>
        <div id="log" class="log" role="tabpanel" hidden></div>
      </div>`;
    $$('[data-tab]', v).forEach((b) => b.addEventListener('click', () => { meetingState.tab = b.dataset.tab; syncTabs(); }));
    syncTabs();
    $('#transcript').addEventListener('click', (e) => { const u = e.target.closest('.utt'); if (u) seek(Number(u.dataset.t)); });
    $('#copyTab').addEventListener('click', attempt(async () => {
      await navigator.clipboard.writeText(meetingState.copy?.[meetingState.tab] || '');
      toast(`${{ summary: 'Summary', tasks: 'Tasks', transcript: 'Transcript', log: 'Bot log' }[meetingState.tab]} copied`);
    }));
    $('#video').addEventListener('loadedmetadata', () => {
      // MediaRecorder webm files have no duration header; seeking to the end makes Chrome compute it.
      const vid = $('#video');
      if (vid.duration === Infinity) {
        vid.addEventListener('timeupdate', function back() { vid.removeEventListener('timeupdate', back); vid.currentTime = (Number(new URLSearchParams(location.search).get('t')) || 0) / 1000; }, { once: true });
        vid.currentTime = 1e101;
      }
    });
  }

  $('#mStatus').className = `pill ${m.status}`;
  $('#mStatus').textContent = STATUS[m.status] || m.status;
  $('#mTitle').textContent = title;
  $('#mSub').innerHTML = `${when(m.created_at)} · ${m.platform === 'zoom' ? 'Zoom' : 'Google Meet'}${m.error ? ` · <span class="bad">${esc(m.error)}</span>` : ''}${m.attendees.length ? ` · ${m.attendees.length} invited` : ''}${m.tags.length ? ' · ' + m.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join(' ') : ''}`;

  // Folder + type pickers (only re-render when not focused, so polling doesn't fight the user).
  if (!$('#mFiling').contains(document.activeElement)) {
    $('#mFiling').innerHTML = edit ? `
      <select id="mFolder" aria-label="Folder"><option value="">Unfiled</option>${folders.folders.map((f) => `<option value="${f.id}" ${f.id === m.folder_id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}<option value="__new">+ New folder…</option></select>
      <select id="mType" aria-label="Meeting type"><option value="">Type…</option>${Object.entries(TYPE).map(([k, l]) => `<option value="${k}" ${k === m.meeting_type ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${m.filed_by === 'ai' ? '<span class="muted small">auto-filed</span>' : m.filed_by === 'rule' ? '<span class="muted small">filed by rule</span>' : ''}`
      : `${m.folder_id ? `<span class="chip">${esc(folders.folders.find((f) => f.id === m.folder_id)?.name || '')}</span>` : ''}${m.meeting_type ? `<span class="chip">${TYPE[m.meeting_type]}</span>` : ''}`;
    $('#mFolder')?.addEventListener('change', attempt(async (e) => {
      let folderId = e.target.value;
      if (folderId === '__new') {
        const name = prompt('Folder name');
        if (!name) { e.target.value = m.folder_id || ''; return; }
        folderId = (await api('/api/folders', { body: { name } })).id;
      }
      const speakers = [...new Set(m.utterances.map((u) => u.speaker).filter(Boolean))];
      const remember = folderId && speakers.length && confirm(`Always file meetings with ${speakers.slice(0, 4).join(', ')}${speakers.length > 4 ? '…' : ''} in this folder?`);
      await api(`/api/meetings/${m.id}`, { method: 'PATCH', body: { folder_id: folderId || null, remember } });
      await refreshShell();
      meetingState.id = null;
      route();
      toast('Moved');
    }));
    $('#mType')?.addEventListener('change', attempt(async (e) => { await api(`/api/meetings/${m.id}`, { method: 'PATCH', body: { meeting_type: e.target.value } }); toast('Saved'); }));
  }

  $('#mActions').innerHTML = `
    ${edit && m.live && !['stopping', 'processing'].includes(m.status) ? '<button class="btn btn-sm" id="stop">Make bot leave</button>' : ''}
    ${edit && !m.live && (m.utterances.length || m.recording) && m.status !== 'processing' ? (m.stt && m.recording && !m.transcript_source
      ? `<button class="btn btn-sm" id="renotes" data-stt title="Transcribe the recording with ${esc(m.stt)}, then write the summary and tasks again">Transcribe and regenerate</button>`
      : `<button class="btn btn-sm" id="renotes" title="Ask ${esc(aiName())} to write the summary and tasks again from the transcript">Regenerate notes</button>`) : ''}
    ${edit && !m.live && m.stt && m.recording && m.transcript_source && m.status !== 'processing' ? `<button class="btn btn-sm" id="retranscribe" title="Transcribe the recording again with ${esc(m.stt)}, e.g. after changing the meeting language">Transcribe again</button>` : ''}
    ${edit ? `<button class="btn btn-sm" id="shareBtn">${m.share ? 'Shared' : 'Share'}</button>` : ''}
    ${edit ? '<button class="btn btn-sm btn-danger" id="del">Delete</button>' : ''}`;
  $('#stop')?.addEventListener('click', attempt(async () => { await api(`/api/meetings/${m.id}/stop`, { method: 'POST' }); route(); }));
  $('#renotes')?.addEventListener('click', attempt(async () => {
    const stt = $('#renotes').hasAttribute('data-stt');
    if (!confirm(stt ? `Transcribe the recording with ${m.stt}, then regenerate the summary and tasks? Tasks you edited are kept. Long meetings take a few minutes.` : 'Regenerate the summary and tasks from the transcript? Tasks you edited are kept.')) return;
    await api(`/api/meetings/${m.id}/notes`, { method: 'POST' }); route();
  }));
  $('#retranscribe')?.addEventListener('click', attempt(async () => {
    if (!confirm(`Transcribe the recording again with ${m.stt} and regenerate the notes? Tasks you edited are kept.`)) return;
    await api(`/api/meetings/${m.id}/notes`, { body: { retranscribe: true } }); route();
  }));
  $('#shareBtn')?.addEventListener('click', () => openShare(m));
  $('#del')?.addEventListener('click', attempt(async () => {
    if (!confirm('Delete this meeting, its recording, transcript and tasks?')) return;
    await api(`/api/meetings/${m.id}`, { method: 'DELETE' });
    await refreshShell(); go('/');
  }));

  if (m.recording && !m.live && $('#video').hidden) {
    $('#video').hidden = false;
    $('#videoEmpty').hidden = true;
    $('#video').src = `/recordings/${m.recording}`;
    fixDuration($('#video'));
    if (m.audio) { $('#audioRow').hidden = false; $('#audioOnly').src = m.audio; $('#audioDl').href = m.audio; fixDuration($('#audioOnly')); }
  } else if (!m.recording) {
    $('#videoEmptyWhy').textContent = m.live ? 'Recording in progress. It appears here when the meeting ends.' : 'There is no recording for this meeting.';
  }
  $('#dlTranscript').href = `/api/meetings/${m.id}/transcript`;

  // At a glance: who was there, how long, task progress.
  const done = m.tasks.filter((t) => t.status === 'done').length;
  const people = m.attendees.length ? m.attendees.map((a) => a.name || a.email) : [...new Set(m.utterances.map((u) => u.speaker).filter(Boolean))];
  const mins = m.started_at && m.ended_at ? Math.max(1, Math.round((Date.parse(m.ended_at + 'Z') - Date.parse(m.started_at + 'Z')) / 60000)) : null;
  $('#glance').innerHTML = `
    <div class="g-row"><span>Tasks</span><b>${done}/${m.tasks.length} done</b></div>
    <div class="bar"><i style="width:${m.tasks.length ? Math.round(done / m.tasks.length * 100) : 0}%"></i></div>
    <div class="g-row"><span>Length</span><b>${mins ? `${mins} min` : '—'}</b></div>
    <div class="g-row"><span>Speakers</span><b>${new Set(m.utterances.map((u) => u.speaker).filter(Boolean)).size || '—'}</b></div>
    <div class="g-people"><span>People</span>${people.length ? people.map((p) => `<span class="person-chip"><i>${esc(p[0] || '?')}</i>${esc(p)}</span>`).join('') : '<small class="muted">—</small>'}</div>`;
  $('#taskCount').textContent = m.tasks.filter((t) => t.status === 'open').length || '';

  // Plain-text versions for the Copy button.
  const bullets = (items) => (items || []).map((i) => `- ${i}`).join('\n') || '- None';
  meetingState.copy = {
    summary: n ? [`${title}`, '', n.summary, '', 'Key points', bullets(n.key_points), '', 'Decisions', bullets(n.decisions), '', 'Open questions', bullets(n.open_questions)].join('\n') : '',
    tasks: m.tasks.map((t) => `${t.status === 'done' ? '[x]' : '[ ]'} ${t.title}${t.assignee_name || t.owner_name ? ` (${t.assignee_name || t.owner_name})` : ''}${t.due ? `, due ${t.due}` : ''}`).join('\n'),
    transcript: m.utterances.map((u) => `[${mmss(u.t_ms)}] ${u.speaker || 'Unknown'}: ${u.text}`).join('\n'),
    log: m.events.map((e) => `${e.at.slice(11)}  ${e.message}`).join('\n'),
  };

  if (m.utterances.length !== meetingState.utt) {
    meetingState.utt = m.utterances.length;
    const el = $('#transcript');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = m.utterances.length ? m.utterances.map((u) => `
      <div class="utt" data-t="${u.t_ms}"><time>${mmss(u.t_ms)}</time><div><b>${esc(u.speaker || 'Unknown')}</b>${esc(u.text)}</div></div>`).join('')
      : `<p class="muted">${m.live ? 'Waiting for people to talk… (captions must be on in the meeting)' : 'No transcript.'}</p>`;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }
  if (m.events.length !== meetingState.log) {
    meetingState.log = m.events.length;
    $('#log').innerHTML = m.events.map((e) => `<div>${esc(e.at.slice(11))}  ${esc(e.message)}</div>`).join('');
  }

  const list = (items) => items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="muted">None</p>';
  $('#notes').innerHTML = !n
    ? `<p class="muted">${['done', 'failed', 'stopped'].includes(m.status) ? 'No notes. The bot log says why (notes need a transcript and an AI key in Settings → AI).' : 'Notes appear here when the meeting ends.'}</p>`
    : `<section><p class="lead">${esc(n.summary)}</p></section>
      <section><h3>Key points</h3>${list(n.key_points)}</section>
      <section><h3>Decisions</h3>${list(n.decisions)}</section>
      <section><h3>Open questions</h3>${list(n.open_questions)}</section>
      <section><h3>Topics</h3>${n.topics.length ? n.topics.map((t) => `<button class="chip" data-seek="${t.start}">${esc(t.start)} ${esc(t.name)}</button>`).join('') : '<p class="muted">None</p>'}</section>`;
  $$('[data-seek]', $('#notes')).forEach((b) => b.onclick = () => { const [mm, ss] = b.dataset.seek.split(':').map(Number); seek((mm * 60 + ss) * 1000); });

  const sig = JSON.stringify(m.tasks);
  if (sig !== meetingState.tasks && !$('#mTasks').contains(document.activeElement)) {
    meetingState.tasks = sig;
    $('#mTasks').innerHTML = `
      ${m.tasks.length ? bulkBar(`<button class="btn btn-sm btn-danger" data-b="clear">Clear all tasks</button>`) : ''}
      ${m.tasks.length ? m.tasks.map((t) => taskRow(t, members)).join('')
        : n?.action_items?.length ? `<p class="muted">No tasks (automatic tasks are off or were cleared). Action items mentioned in the meeting:</p><ul>${n.action_items.map((a) => `<li>${esc(a.task)}${a.owner && a.owner !== 'Unassigned' ? ` <span class="muted">· ${esc(a.owner)}</span>` : ''}</li>`).join('')}</ul>`
        : '<p class="muted">No action items.</p>'}
      ${edit ? `<form class="inline-add" id="mAddTask"><input name="title" placeholder="Add a task from this meeting…" required><button class="btn btn-sm">Add</button></form>` : ''}`;
    bindTasks(members, () => { meetingState.tasks = ''; viewMeeting(m.id); });
    bindBulk($('#mTasks'), () => { meetingState.tasks = ''; viewMeeting(m.id); });
    $('#mTasks [data-b=clear]')?.addEventListener('click', attempt(async () => {
      if (!confirm(`Remove all ${m.tasks.length} tasks from this meeting? The summary stays.`)) return;
      await api(`/api/meetings/${m.id}/tasks`, { method: 'DELETE' });
      meetingState.tasks = ''; viewMeeting(m.id); toast('Tasks cleared');
    }));
    $('#mAddTask')?.addEventListener('submit', attempt(async (e) => {
      e.preventDefault();
      await api('/api/tasks', { body: { title: new FormData(e.target).get('title'), meeting_id: m.id } });
      meetingState.tasks = '';
      viewMeeting(m.id);
    }));
  }
}

function syncTabs() {
  const t = meetingState.tab;
  $$('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === t));
  $('#notes').hidden = t !== 'summary';
  $('#mTasks').hidden = t !== 'tasks';
  $('#transcript').hidden = t !== 'transcript';
  $('#log').hidden = t !== 'log';
  $('#dlTranscript').hidden = t !== 'transcript';
  // Fade the new panel in.
  const panel = { summary: '#notes', tasks: '#mTasks', transcript: '#transcript', log: '#log' }[t];
  $(panel).classList.remove('panel-in'); void $(panel).offsetWidth; $(panel).classList.add('panel-in');
}

function seek(ms) {
  const v = $('#video');
  if (!v || v.hidden) return;
  v.currentTime = ms / 1000;
  v.play();
}

// ---------- upcoming (Google Calendar) ----------
const AUTO = { accepted: 'Meetings I organize or accept', organizer: 'Only meetings I organize', all: 'Every meeting with a link', off: 'Off: I pick each one' };

async function viewUpcoming() {
  const c = await api('/api/calendar');
  if (!c.connected) {
    shell('upcoming', `
      <div class="page-head"><div><h1>Upcoming</h1><p class="muted">Let the bot join your calendar meetings on its own.</p></div></div>
      <div class="card empty connect">
        ${ICON.cal}
        <h2>Connect Google Calendar</h2>
        <p>The bot looks for Meet and Zoom links in your calendar and joins a minute before each meeting starts. Read-only: it never changes your calendar.</p>
        ${c.enabled ? `<a class="btn btn-blue" href="/api/auth/google/start?connect=1">${ICON.google} Connect Google Calendar</a>` : '<p class="bad">Google sign-in is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).</p>'}
      </div>`);
    return;
  }
  const a = c.account;
  const writable = me.workspaces.filter((w) => w.role !== 'viewer');
  const days = new Map();
  for (const e of c.events) {
    const k = new Date(e.start_at).toDateString();
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(e);
  }
  const dayLabel = (k) => {
    const d = new Date(k), t = new Date();
    const diff = Math.round((d - new Date(t.toDateString())) / 86400000);
    return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  };
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  shell('upcoming', `
    <div class="page-head">
      <div><h1>Upcoming</h1><p class="muted">From ${esc(a.email)}${a.synced_at ? ` · synced ${when(a.synced_at)}` : ''}${a.sync_error ? ` · <span class="bad">${esc(a.sync_error)}</span>` : ''}</p></div>
      <div class="row-end"><button class="btn btn-sm" id="syncNow">Sync now</button></div>
    </div>
    <div class="card cal-settings">
      <label>Bot joins automatically<select id="autoJoin">${Object.entries(AUTO).map(([k, v]) => `<option value="${k}" ${k === a.auto_join ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label ${me.singleWorkspace ? 'hidden' : ''}>Save calendar meetings in<select id="calWs">${writable.map((w) => `<option value="${w.id}" ${w.id === a.workspace_id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label>
    </div>
    <div class="days">
      ${days.size ? [...days].map(([k, list]) => `
        <section>
          <h3 class="day">${dayLabel(k)}</h3>
          <div class="card events">${list.map((e) => eventRow(e, time)).join('')}</div>
        </section>`).join('') : '<div class="card empty">No meetings in the next 7 days.</div>'}
    </div>`);

  $('#syncNow').onclick = attempt(async () => { await api('/api/calendar/sync', { method: 'POST' }); route(); toast('Synced'); });
  $('#autoJoin').onchange = attempt(async (e) => { await api('/api/calendar', { method: 'PATCH', body: { auto_join: e.target.value } }); route(); toast('Saved'); });
  $('#calWs').onchange = attempt(async (e) => { await api('/api/calendar', { method: 'PATCH', body: { workspace_id: e.target.value } }); toast('Saved'); });
  $$('[data-join]').forEach((b) => b.onchange = attempt(async () => {
    const ev = c.events.find((x) => x.event_id === b.dataset.join);
    // Matching what the auto-join rule would do anyway clears the override.
    const override = b.checked === ev.rule_join ? null : (b.checked ? 1 : 0);
    await api(`/api/calendar/events/${encodeURIComponent(ev.event_id)}`, { method: 'PATCH', body: { override } });
    route();
  }));
  $$('[data-send]').forEach((b) => b.onclick = attempt(async () => {
    const { id } = await api(`/api/calendar/events/${encodeURIComponent(b.dataset.send)}/send`, { method: 'POST' });
    go(`/m/${id}`);
  }));
  poll(viewUpcoming, 30000);
}

function eventRow(e, time) {
  const now = Date.now();
  const started = e.start_at <= now;
  const others = e.attendees.filter((x) => x.email !== me.user.email);
  const status = e.meeting_id
    ? `<a class="pill ${e.meeting_status || ''}" href="/m/${e.meeting_id}">${STATUS[e.meeting_status] || 'Open'}</a>`
    : '';
  return `
    <div class="event ${e.url ? '' : 'nolink'}">
      <div class="when"><b>${time(e.start_at)}</b><span>${time(e.end_at)}</span></div>
      <div class="event-main">
        <div class="title">${esc(e.title)}</div>
        <div class="meta">${e.url ? `${e.platform === 'zoom' ? 'Zoom' : 'Google Meet'}` : 'No meeting link'}${others.length ? ` · ${others.length} other${others.length > 1 ? 's' : ''}` : ''}${e.response && e.response !== 'accepted' && !e.is_organizer ? ` · ${e.response === 'needsAction' ? 'not answered' : esc(e.response)}` : ''}${e.override !== null ? ' · set by you' : ''}</div>
      </div>
      <div class="event-side">
        ${status}
        ${e.url && !e.meeting_id && canEdit() && (started || e.start_at - now < 15 * 60000) ? `<button class="btn btn-sm" data-send="${esc(e.event_id)}">Send now</button>` : ''}
        ${e.url && !e.meeting_id ? `<label class="switch" title="Bot joins this meeting"><input type="checkbox" data-join="${esc(e.event_id)}" ${e.will_join ? 'checked' : ''}><span></span><em class="sr">Bot joins</em></label>` : ''}
      </div>
    </div>`;
}

// ---------- settings ----------
async function viewSettings() {
  const { members, invites } = await api('/api/workspace/members');
  const owner = isOwner();
  shell('settings', `
    <div class="page-head"><div><h1>Settings</h1><p class="muted">${esc(me.workspace.name)}</p></div></div>
    <div class="settings">
      <section class="card">
        <h2>Workspace</h2>
        <form id="wsForm" class="inline-add"><input name="name" value="${esc(me.workspace.name)}" ${owner ? '' : 'disabled'} aria-label="Workspace name">${owner ? '<button class="btn btn-sm">Save</button>' : ''}</form>
        ${me.singleWorkspace ? '' : '<p class="muted small">Use one workspace per company or team. Meetings, folders and tasks stay inside their workspace.</p>'}
      </section>
      <section class="card" id="aiCard"><h2>AI</h2><p class="muted">Loading…</p></section>
      <section class="card" id="sttCard"><h2>Transcript</h2><p class="muted">Loading…</p></section>
      ${owner ? '<section class="card" id="demoCard" hidden></section>' : ''}
      <section class="card">
        <h2>Meeting bot</h2>
        <form id="botForm" class="inline-add"><input name="bot_name" value="${esc(me.botName)}" placeholder="${esc(me.defaultBotName)}" maxlength="40" ${owner ? '' : 'disabled'} aria-label="Bot name">${owner ? '<button class="btn btn-sm">Save</button>' : ''}</form>
        <p class="muted small">The name everyone sees when the bot asks to join and in the participant list. You can still change it for a single meeting when you send the bot.</p>
      </section>
      <section class="card">
        <h2>People</h2>
        <div class="people">
          ${members.map((u) => `
            <div class="person">
              <span class="avatar">${esc(u.name[0])}</span>
              <span class="person-main"><b>${esc(u.name)}${u.id === me.user.id ? ' (you)' : ''}</b><small>${esc(u.email)}</small></span>
              ${owner ? `<select data-role="${u.id}" aria-label="Role">${Object.entries(ROLE).map(([k, l]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${l}</option>`).join('')}</select>
                <button class="icon-btn" data-remove="${u.id}" aria-label="Remove">✕</button>` : `<span class="chip">${ROLE[u.role]}</span>`}
            </div>`).join('')}
          ${invites.map((i) => `
            <div class="person pending">
              <span class="avatar">?</span>
              <span class="person-main"><b>${esc(i.email)}</b><small>Invited as ${ROLE[i.role].toLowerCase()} · joins when they sign up with this email</small></span>
              ${owner ? `<button class="icon-btn" data-uninvite="${esc(i.email)}" aria-label="Cancel invite">✕</button>` : ''}
            </div>`).join('')}
        </div>
        ${owner ? `<form id="invite" class="add-task">
          <input name="email" type="email" placeholder="colleague@company.com" required>
          <select name="role"><option value="member">Member</option><option value="viewer">Viewer</option><option value="owner">Owner</option></select>
          <button class="btn btn-blue">Invite</button>
        </form>
        <p class="muted small">Owners manage people and settings. Members send bots, edit notes, folders and tasks. Viewers can only look.</p>` : ''}
      </section>
      <section class="card" id="calCard"><h2>Google Calendar</h2><p class="muted">Loading…</p></section>
      <section class="card">
        <h2>Auto-filing rules</h2>
        ${folders.rules.length ? `<div class="people">${folders.rules.map((r) => `
          <div class="person"><span class="person-main"><b>${r.kind === 'participant' ? `Meetings with ${esc(r.value)}` : `Meetings that mention “${esc(r.value)}”`}</b><small>go to ${esc(r.folder_name)}</small></span>
          ${canEdit() ? `<button class="icon-btn" data-rule="${r.id}" aria-label="Remove rule">✕</button>` : ''}</div>`).join('')}</div>`
          : `<p class="muted">No rules yet. When you move a meeting to a folder you can tell it to always file meetings with those people there. Otherwise ${esc(aiName())} picks the folder.</p>`}
        ${canEdit() && folders.folders.length ? `<form id="ruleForm" class="add-task">
          <input name="keyword" placeholder="Keyword, e.g. a client name" required>
          <select name="folder">${folders.folders.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select>
          <button class="btn">Add rule</button></form>` : ''}
      </section>
    </div>`);

  renderAICard(owner);
  if (owner) renderDemoCard();
  api('/api/calendar').then((c) => {
    $('#calCard').innerHTML = `<h2>Google Calendar</h2>${c.connected
      ? `<p>Connected as <b>${esc(c.account.email)}</b>. Auto-join: ${AUTO[c.account.auto_join]}. Meetings are saved in ${esc(c.account.workspace_name || '—')}.</p>
         <div class="row-end" style="justify-content:flex-start"><a class="btn btn-sm" href="/upcoming">Upcoming meetings</a><button class="btn btn-sm btn-danger" id="calOff">Disconnect</button></div>`
      : c.enabled ? `<p class="muted">Let the bot join your calendar meetings automatically.</p><a class="btn btn-sm btn-blue" href="/api/auth/google/start?connect=1">${ICON.google} Connect Google Calendar</a>`
      : '<p class="muted">Google is not configured on this server.</p>'}`;
    $('#calOff')?.addEventListener('click', attempt(async () => {
      if (!confirm('Disconnect Google Calendar? The bot stops joining calendar meetings.')) return;
      await api('/api/calendar', { method: 'DELETE' }); route();
    }));
  }).catch(() => {});
  if (new URLSearchParams(location.search).get('google') === 'connected') toast('Google Calendar connected');

  $('#wsForm')?.addEventListener('submit', attempt(async (e) => { e.preventDefault(); await api('/api/workspace', { method: 'PATCH', body: { name: new FormData(e.target).get('name') } }); await refreshShell(); route(); toast('Saved'); }));
  $('#botForm')?.addEventListener('submit', attempt(async (e) => {
    e.preventDefault();
    await api('/api/workspace', { method: 'PATCH', body: { bot_name: new FormData(e.target).get('bot_name') } });
    await refreshShell(); route(); toast('Bot name saved');
  }));
  $('#invite')?.addEventListener('submit', attempt(async (e) => {
    e.preventDefault();
    const r = await api('/api/workspace/invites', { body: Object.fromEntries(new FormData(e.target)) });
    toast(r.added ? 'Added to the workspace' : 'Invite saved. They join when they sign up.');
    route();
  }));
  $$('[data-role]').forEach((s) => s.onchange = attempt(async () => { await api(`/api/workspace/members/${s.dataset.role}`, { method: 'PATCH', body: { role: s.value } }); await refreshShell(); route(); toast('Role updated'); }));
  $$('[data-remove]').forEach((b) => b.onclick = attempt(async () => { if (!confirm('Remove this person from the workspace?')) return; await api(`/api/workspace/members/${b.dataset.remove}`, { method: 'DELETE' }); await refreshShell(); route(); }));
  $$('[data-uninvite]').forEach((b) => b.onclick = attempt(async () => { await api(`/api/workspace/invites/${encodeURIComponent(b.dataset.uninvite)}`, { method: 'DELETE' }); route(); }));
  $$('[data-rule]').forEach((b) => b.onclick = attempt(async () => { await api(`/api/rules/${b.dataset.rule}`, { method: 'DELETE' }); await refreshShell(); route(); }));
  $('#ruleForm')?.addEventListener('submit', attempt(async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api(`/api/folders/${fd.get('folder')}`, { method: 'PATCH', body: { keyword: fd.get('keyword') } });
    await refreshShell(); route(); toast('Rule added');
  }));
}

// Demo clients: shown only when the install has demo files (demos/*.json).
async function renderDemoCard() {
  const card = $('#demoCard');
  if (!card) return;
  const d = await api('/api/demos').catch(() => null);
  if (!d?.demos.length) return;
  card.hidden = false;
  const s = d.status;
  const running = s && !s.done;
  card.innerHTML = `
    <h2>Demo client</h2>
    <p class="muted small">Loads a fictional client folder with realistic meetings, written by your AI (uses a few cents of AI credit). Delete the folder any time to remove it.</p>
    ${d.demos.map((x) => `<div class="person"><span class="person-main"><b>${esc(x.title)}</b><small>${x.meetings} meetings · folder “${esc(x.folder)}”</small></span>
      <button class="btn btn-sm" data-demo="${esc(x.name)}" ${running ? 'disabled' : ''}>Load</button></div>`).join('')}
    ${s ? `<p class="small ${s.error ? 'bad' : 'muted'}" style="margin:10px 0 0">${s.error ? `Stopped: ${esc(s.error)}` : s.done ? `Loaded “${esc(s.demo)}”. ${s.folderId ? `<a href="/folders/${s.folderId}">Open the folder</a>` : ''}` : `${esc(s.step)}…`}</p>` : ''}
    ${running ? `<div class="bar" style="margin-top:8px"><i style="width:${Math.round((s.current - 1) / s.total * 100)}%"></i></div>` : ''}`;
  $$('[data-demo]', card).forEach((b) => b.onclick = attempt(async () => {
    await api(`/api/demos/${b.dataset.demo}/load`, { method: 'POST' });
    renderDemoCard();
  }));
  if (running) setTimeout(async () => { if (location.pathname === '/settings') { await renderDemoCard(); if (!(await api('/api/demos')).status?.done) return; await refreshShell(); } }, 3000);
}

const keyPlaceholder = (p) => p.savedKey ? `Saved: ${p.savedKey} (leave empty to keep)` : p.serverKey ? 'Using the server key (paste one to override)' : p.keyHint;

async function renderAICard(owner) {
  const a = await api('/api/ai').catch(() => null);
  if (!a || !$('#aiCard')) return;
  const p = a.providers[a.provider];
  const custom = !p.models.includes(a.model);
  $('#aiCard').innerHTML = `
    <h2>AI</h2>
    <p class="muted small">This AI writes every summary, task list, folder choice and folder overview.</p>
    <form id="aiForm" class="ai-form">
      <label>Provider<select name="provider" ${owner ? '' : 'disabled'}>${Object.entries(a.providers).map(([k, v]) => `<option value="${k}" ${k === a.provider ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
      <label>Model<select name="model_pick" ${owner ? '' : 'disabled'}>${p.models.map((m) => `<option ${m === a.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}<option value="__custom" ${custom ? 'selected' : ''}>Other model…</option></select></label>
      <label class="ai-custom" ${custom ? '' : 'hidden'}>Model name<input name="model_custom" value="${custom ? esc(a.model) : ''}" placeholder="exact model id" ${owner ? '' : 'disabled'}></label>
      <label class="ai-key">API key
        <input name="api_key" type="password" autocomplete="off" placeholder="${esc(keyPlaceholder(p))}" ${owner ? '' : 'disabled'}>
      </label>
      <label class="switch-row"><span><b>Create tasks automatically</b><small>Off: the summary still lists action items, but no tasks are added.</small></span>
        <span class="switch"><input type="checkbox" name="auto_tasks" ${a.autoTasks ? 'checked' : ''} ${owner ? '' : 'disabled'}><span></span></span></label>
      <p class="form-error" id="aiMsg"></p>
      ${owner ? `<div class="row-end" style="justify-content:flex-start">
        <button class="btn btn-blue btn-sm" value="save">Save</button>
        <button class="btn btn-sm" value="test" type="button" id="aiTest">Test connection</button>
        <button class="btn btn-sm btn-danger" type="button" id="aiClear" ${p.savedKey ? '' : 'hidden'}>Remove saved key</button>
      </div>` : '<p class="muted small">Only owners can change the AI.</p>'}
    </form>`;
  const f = $('#aiForm');
  const model = () => f.model_pick.value === '__custom' ? f.model_custom.value.trim() : f.model_pick.value;
  f.provider.onchange = () => {
    const np = a.providers[f.provider.value];
    f.model_pick.innerHTML = np.models.map((m) => `<option>${esc(m)}</option>`).join('') + '<option value="__custom">Other model…</option>';
    $('.ai-custom', f).hidden = true;
    f.api_key.placeholder = keyPlaceholder(np);
    $('#aiMsg').textContent = f.provider.value !== a.provider && !np.savedKey && !np.serverKey ? 'Paste this provider\'s API key, then Save.' : '';
    $('#aiClear') && ($('#aiClear').hidden = !np.savedKey);
  };
  f.model_pick.onchange = () => { $('.ai-custom', f).hidden = f.model_pick.value !== '__custom'; };
  const msg = (t, ok) => { $('#aiMsg').textContent = t; $('#aiMsg').style.color = ok ? 'var(--ok)' : ''; };
  f.addEventListener('submit', attempt(async (e) => {
    e.preventDefault();
    await api('/api/ai', { method: 'PATCH', body: { provider: f.provider.value, model: model(), api_key: f.api_key.value, auto_tasks: f.auto_tasks.checked } });
    toast('AI settings saved'); await refreshShell(); route();
  }));
  $('#aiTest')?.addEventListener('click', async (e) => {
    e.target.disabled = true; msg('Testing…', true);
    try {
      const r = await api('/api/ai/test', { body: { provider: f.provider.value, model: model(), api_key: f.api_key.value } });
      msg(r.message, true);
    } catch (err) { msg(err.message, false); }
    e.target.disabled = false;
  });
  $('#aiClear')?.addEventListener('click', attempt(async () => {
    if (!confirm(`Remove the saved ${a.providers[f.provider.value].label} key?`)) return;
    await api('/api/ai', { method: 'PATCH', body: { provider: f.provider.value, model: model(), clear_key: true } });
    toast('Key removed'); renderAICard(owner);
  }));
  renderSttCard(owner, a);
}

// Meeting language + optional transcription of the recording (Meet's captions are weak outside English).
function renderSttCard(owner, a) {
  const t = a.transcript;
  if (!t || !$('#sttCard')) return;
  const dis = owner ? '' : 'disabled';
  const sp = (k) => t.providers[k];
  $('#sttCard').innerHTML = `
    <h2>Transcript</h2>
    <p class="muted small">By default the transcript comes from the meeting's live captions. They work well in English but often mis-hear other languages, such as Indonesian or Indonesian mixed with English. For those, let a speech-to-text service transcribe the recording after the meeting. Speaker names still come from the captions.</p>
    <form id="sttForm" class="ai-form">
      <label>Meeting language<select name="language" ${dis}>${Object.entries(t.languages).map(([k, l]) => `<option value="${k}" ${k === t.language ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label>Transcribe with<select name="stt_provider" ${dis}>
        <option value="">Live captions only (free)</option>
        ${Object.entries(t.providers).map(([k, v]) => `<option value="${k}" ${k === t.provider ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
      </select></label>
      <label class="ai-key stt-key" ${t.provider ? '' : 'hidden'}>API key
        <input name="stt_api_key" type="password" autocomplete="off" placeholder="${t.provider ? esc(keyPlaceholder(sp(t.provider))) : ''}" ${dis}>
      </label>
      ${t.ffmpeg ? '' : '<p class="form-error">This server has no ffmpeg, so recordings can\'t be transcribed. Rebuild with the current Dockerfile.</p>'}
      <p class="muted small">The bot also asks Meet to caption in the meeting language. Older meetings: open one and click "Transcribe and regenerate".</p>
      <p class="form-error" id="sttMsg"></p>
      ${owner ? `<div class="row-end" style="justify-content:flex-start">
        <button class="btn btn-blue btn-sm">Save</button>
        <button class="btn btn-sm btn-danger" type="button" id="sttClear" ${t.provider && sp(t.provider).savedKey ? '' : 'hidden'}>Remove saved key</button>
      </div>` : '<p class="muted small">Only owners can change this.</p>'}
    </form>`;
  const f = $('#sttForm');
  f.stt_provider.onchange = () => {
    const k = f.stt_provider.value;
    $('.stt-key', f).hidden = !k;
    if (k) f.stt_api_key.placeholder = keyPlaceholder(sp(k));
    $('#sttClear') && ($('#sttClear').hidden = !(k && sp(k).savedKey));
    $('#sttMsg').textContent = k && !sp(k).savedKey && !sp(k).serverKey ? 'Paste this service\'s API key, then Save.' : '';
  };
  f.addEventListener('submit', attempt(async (e) => {
    e.preventDefault();
    await api('/api/ai', { method: 'PATCH', body: { language: f.language.value, stt_provider: f.stt_provider.value || null, stt_api_key: f.stt_api_key.value } });
    toast('Transcript settings saved'); renderAICard(owner);
  }));
  $('#sttClear')?.addEventListener('click', attempt(async () => {
    const k = f.stt_provider.value;
    if (!confirm(`Remove the saved ${sp(k).label.split(' (')[0]} key?`)) return;
    await api('/api/ai', { method: 'PATCH', body: { stt_clear_key: k } });
    toast('Key removed'); renderAICard(owner);
  }));
}

function viewMissing() {
  shell('', `<div class="card empty"><h2>Not found</h2><p>This page doesn't exist in this workspace.</p><a class="btn" href="/">Back to meetings</a></div>`);
}

function viewNoWorkspace() {
  sideSig = '';
  shell('', `<div class="card empty"><h2>No workspace</h2><p>You're not in any workspace. Create one from the workspace menu.</p></div>`);
}

// ---------- router ----------
function poll(fn, ms) {
  clearTimeout(pollTimer);
  const path = location.pathname + location.search;
  pollTimer = setTimeout(() => { if (location.pathname + location.search === path && !document.querySelector('dialog[open]')) fn().catch(() => {}); }, ms);
}

async function route() {
  clearTimeout(pollTimer);
  animateNext = true;
  const p = location.pathname;
  const shared = p.match(/^\/s\/([\w-]{16,})$/);
  if (shared) return viewShared(shared[1]);
  if (p !== '/login' && p !== '/signup' && !me) {
    try { await refreshShell(); } catch { return; }
  }
  if (p === '/login' || p === '/signup') {
    if (me) return go('/', true);
    document.title = BRAND.name;
    return viewAuth(p.slice(1));
  }
  if (!me.workspace) return viewNoWorkspace();
  if (!p.startsWith('/m/')) { meetingState.id = null; document.title = BRAND.name; }
  try {
    if (p === '/') return await viewMeetings();
    if (p === '/tasks') return await viewTasks();
    if (p === '/upcoming') return await viewUpcoming();
    if (p === '/settings') return await viewSettings();
    let m;
    if (p === '/folders/none') return await viewMeetings('none');
    if ((m = p.match(/^\/folders\/([\w-]+)$/))) return await viewFolder(m[1]);
    if ((m = p.match(/^\/m\/([\w-]+)$/))) return await viewMeeting(m[1]);
    viewMissing();
  } catch (e) {
    if (me) toast(e.message, true);
  }
}

// ---------- sharing ----------
function openShare(m) {
  const d = document.createElement('dialog');
  d.className = 'modal';
  const render = () => {
    const sh = m.share;
    d.innerHTML = `<form method="dialog" class="share-form">
      <h2>Share this meeting</h2>
      <p class="muted">Anyone with the link can view a read-only page: summary and tasks, plus the parts you allow below. No login needed.</p>
      <label class="switch-row"><span><b>Include transcript</b><small>The full conversation, line by line</small></span>
        <span class="switch"><input type="checkbox" name="transcript" ${sh ? (sh.opts.transcript ? 'checked' : '') : 'checked'}><span></span></span></label>
      <label class="switch-row"><span><b>Include recording</b><small>${m.recording ? 'The meeting video' : 'This meeting has no recording'}</small></span>
        <span class="switch"><input type="checkbox" name="video" ${m.recording ? '' : 'disabled'} ${sh ? (sh.opts.video ? 'checked' : '') : (m.recording ? 'checked' : '')}><span></span></span></label>
      ${sh ? `<div class="share-link"><input readonly value="${esc(sh.url)}" aria-label="Share link"><button type="button" class="btn btn-sm btn-blue" id="copyShare">Copy link</button></div>` : ''}
      <p class="form-error" id="shareErr"></p>
      <div class="row-end">
        ${sh ? '<button type="button" class="btn btn-danger" id="stopShare">Turn off link</button>' : ''}
        <button type="button" class="btn" id="closeShare">Close</button>
        <button type="button" class="btn btn-blue" id="saveShare">${sh ? 'Save' : 'Create link'}</button>
      </div>
    </form>`;
    const f = $('form', d);
    $('#closeShare', d).onclick = () => closeAnimated(d);
    $('#saveShare', d).onclick = attempt(async () => {
      const r = await api(`/api/meetings/${m.id}/share`, { body: { transcript: f.transcript.checked, video: f.video.checked } });
      m.share = { url: r.url.startsWith('http') ? r.url : location.origin + r.url, opts: r.opts };
      render(); toast('Link ready');
    });
    $('#copyShare', d)?.addEventListener('click', attempt(async () => { await navigator.clipboard.writeText(m.share.url); toast('Link copied'); }));
    $('#stopShare', d)?.addEventListener('click', attempt(async () => {
      if (!confirm('Turn off this link? People who have it will no longer see the meeting.')) return;
      await api(`/api/meetings/${m.id}/share`, { method: 'DELETE' });
      m.share = null; render(); toast('Link turned off');
    }));
  };
  if (m.share && !m.share.url.startsWith('http')) m.share.url = location.origin + m.share.url;
  render();
  document.body.appendChild(d);
  d.showModal();
  d.addEventListener('cancel', (e) => { e.preventDefault(); closeAnimated(d); });
  d.addEventListener('close', () => { d.remove(); if ($('#shareBtn')) $('#shareBtn').textContent = m.share ? 'Shared' : 'Share'; });
}

// Public read-only meeting page (/s/<token>), no login, no sidebar.
async function viewShared(token) {
  $('#askFab')?.remove(); $('#askPanel')?.remove();
  sideSig = '';
  const r = await fetch(`/api/share/${token}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    $('#root').innerHTML = `<div class="auth enter"><a class="brand">${brandMark()}</a><div class="card auth-card"><h1>Link unavailable</h1><p class="muted">${esc(data.error || 'This link is not valid.')}</p></div></div>`;
    return;
  }
  document.title = `${data.title} · ${BRAND.name}`;
  const n = data.summary;
  const list = (items) => items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="muted">None</p>';
  $('#root').innerHTML = `
    <div class="shared enter">
      <header class="shared-top"><span class="brand">${brandMark()}</span><span class="muted small">Shared meeting · read only</span></header>
      <main class="shared-main">
        <h1>${esc(data.title)}</h1>
        <p class="muted">${when(data.date)}${data.minutes ? ` · ${data.minutes} min` : ''}${data.people.length ? ` · ${data.people.map(esc).join(', ')}` : ''}</p>
        ${data.video ? `<div class="card video-card"><video id="video" controls preload="metadata" src="${esc(data.video)}"></video></div>` : ''}
        <div class="card notes">
          ${n ? `<p class="lead">${esc(n.summary)}</p>
            <section><h3>Key points</h3>${list(n.key_points)}</section>
            <section><h3>Decisions</h3>${list(n.decisions)}</section>
            <section><h3>Open questions</h3>${list(n.open_questions)}</section>` : '<p class="muted">No summary for this meeting.</p>'}
        </div>
        ${data.tasks.length ? `<div class="card"><h2>Action items</h2>${data.tasks.map((t) => `<div class="shared-task ${t.done ? 'done' : ''}"><span class="tick">${t.done ? '✓' : ''}</span><span>${esc(t.title)}${t.owner ? ` <span class="muted">· ${esc(t.owner)}</span>` : ''}${t.due ? ` <span class="muted">· ${esc(t.due)}</span>` : ''}</span></div>`).join('')}</div>` : ''}
        ${data.transcript ? `<div class="card"><h2>Transcript</h2><div class="transcript">${data.transcript.map((u) => `<div class="utt" data-t="${u.t_ms}"><time>${mmss(u.t_ms)}</time><div><b>${esc(u.speaker || 'Unknown')}</b>${esc(u.text)}</div></div>`).join('')}</div></div>` : ''}
      </main>
    </div>`;
  const v = $('#video');
  if (v) {
    fixDuration(v);
    $$('.utt').forEach((u) => u.onclick = () => { v.currentTime = Number(u.dataset.t) / 1000; v.play(); });
  }
}

// ---------- Ask AI ----------
function afterShell() {
  mountAsk();
  if (ask.open) setTimeout(syncAskScope, 0);   // after the page set document.title
}
// A chat drawer that lives outside the page views, so it stays open while you navigate.
const ask = { open: false, chatId: null, messages: [], refs: {}, busy: false, scope: null };

function routeScope() {
  const p = location.pathname;
  let m;
  if ((m = p.match(/^\/m\/([\w-]+)/))) return { type: 'meeting', id: m[1], label: document.title || 'This meeting' };
  if ((m = p.match(/^\/folders\/([\w-]+)/)) && m[1] !== 'none') {
    const f = folders.folders.find((x) => x.id === m[1]);
    return { type: 'folder', id: m[1], label: f ? f.name : 'This folder' };
  }
  return null;
}

function mountAsk() {
  if ($('#askFab') || !me?.workspace) return;
  document.body.insertAdjacentHTML('beforeend', `
    <button class="ask-fab" id="askFab" type="button" aria-label="Ask AI">${ICON.spark}<span>Ask AI</span></button>
    <aside class="ask-panel" id="askPanel" aria-label="Ask AI" hidden>
      <header class="ask-head">
        <div class="ask-title">${ICON.spark}<b>Ask AI</b></div>
        <div class="ask-tools">
          <button class="icon-btn" id="askHistory" title="Past chats" aria-label="Past chats">${ICON.history}</button>
          <button class="icon-btn" id="askNew" title="New chat" aria-label="New chat">${ICON.plus}</button>
          <button class="icon-btn" id="askClose" aria-label="Close">✕</button>
        </div>
      </header>
      <div class="ask-scope"><span class="muted small">Looking at</span><select id="askScope" aria-label="What Ask AI looks at"></select></div>
      <div class="ask-body" id="askBody"></div>
      <form class="ask-input" id="askForm">
        <textarea id="askText" rows="1" placeholder="Ask about a client, a meeting, open tasks…" aria-label="Your question"></textarea>
        <button class="btn btn-blue ask-send" aria-label="Send">${ICON.send}</button>
      </form>
    </aside>`);
  $('#askFab').onclick = () => toggleAsk(true);
  $('#askClose').onclick = () => toggleAsk(false);
  $('#askNew').onclick = () => { ask.chatId = null; ask.messages = []; ask.refs = {}; renderAsk(); $('#askText').focus(); };
  $('#askHistory').onclick = attempt(showAskHistory);
  $('#askScope').onchange = (e) => { ask.scope = e.target.value === 'all' ? { type: 'all' } : JSON.parse(e.target.value); };
  const ta = $('#askText');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#askForm').requestSubmit(); } });
  $('#askForm').addEventListener('submit', (e) => { e.preventDefault(); sendAsk(ta.value); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ask.open && !document.querySelector('dialog[open]')) toggleAsk(false); });
}

function toggleAsk(open) {
  ask.open = open;
  $('#askPanel').hidden = !open;
  $('#askFab').hidden = open;
  document.body.classList.toggle('ask-open', open);
  if (open) { syncAskScope(); renderAsk(); setTimeout(() => $('#askText').focus(), 50); }
}

function syncAskScope() {
  const r = routeScope();
  const sel = $('#askScope');
  if (!sel) return;
  const opts = [];
  if (r) opts.push(`<option value='${esc(JSON.stringify({ type: r.type, id: r.id }))}'>${r.type === 'meeting' ? 'This meeting' : 'Folder'}: ${esc(r.label)}</option>`);
  opts.push(`<option value="all">All meetings</option>`);
  sel.innerHTML = opts.join('');
  ask.scope = r ? { type: r.type, id: r.id } : { type: 'all' };
}

const ASK_SUGGEST = {
  meeting: ['Summarize this meeting in 3 bullets', 'What did we promise the client?', 'Draft a follow-up email'],
  folder: ['Where do things stand with this client?', 'What is still open, and who owns it?', 'What are the biggest risks right now?'],
  all: ['What did we promise clients this week?', 'Which tasks are overdue?', 'Which meetings talked about budget?'],
};

function renderAsk() {
  const body = $('#askBody');
  if (!body) return;
  if (!ask.messages.length) {
    const kind = ask.scope?.type || 'all';
    body.innerHTML = `<div class="ask-empty">
      <div class="ask-orb">${ICON.spark}</div>
      <b>Ask anything about your meetings</b>
      <p class="muted small">Answers come from your notes, tasks and transcripts, with links to the source.</p>
      <div class="ask-suggest">${ASK_SUGGEST[kind].map((q) => `<button type="button" class="chip">${esc(q)}</button>`).join('')}</div>
    </div>`;
    $$('.ask-suggest .chip', body).forEach((b) => b.onclick = () => sendAsk(b.textContent));
    return;
  }
  body.innerHTML = ask.messages.map((m) => `<div class="msg ${m.role}">${m.role === 'assistant' ? mdLite(m.content) : esc(m.content).replace(/\n/g, '<br>')}</div>`).join('')
    + (ask.busy ? `<div class="msg assistant typing"><i></i><i></i><i></i></div>` : '');
  body.scrollTop = body.scrollHeight;
}

// Small, safe markdown: escape first, then bold, code, lists, headings, paragraphs, and source links.
function mdLite(text) {
  let h = esc(text);
  h = h.replace(/\[M:([\w-]+)@(\d+):(\d{2})\]/g, (_, id, mm, ss) => {
    const t = (Number(mm) * 60 + Number(ss)) * 1000;
    return `<a class="src" href="/m/${id}?t=${t}">${esc(ask.refs[id]?.title || 'Meeting')} · ${mm}:${ss}</a>`;
  });
  h = h.replace(/\[M:([\w-]+)\]/g, (_, id) => `<a class="src" href="/m/${id}">${esc(ask.refs[id]?.title || 'Meeting')}</a>`);
  h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  for (const line of h.split('\n')) {
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (li) { if (!list) { list = []; } list.push(`<li>${li[1]}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    const hd = line.match(/^#{1,4}\s+(.*)/);
    if (hd) out.push(`<h4>${hd[1]}</h4>`);
    else if (line.trim()) out.push(`<p>${line}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

async function sendAsk(text) {
  text = String(text || '').trim();
  if (!text || ask.busy) return;
  $('#askText').value = ''; $('#askText').style.height = 'auto';
  ask.messages.push({ role: 'user', content: text });
  ask.busy = true; renderAsk();
  try {
    const r = await api('/api/assistant', { body: { message: text, chatId: ask.chatId, scope: ask.scope } });
    ask.chatId = r.chatId;
    Object.assign(ask.refs, r.refs || {});
    ask.messages.push({ role: 'assistant', content: r.answer });
  } catch (e) {
    ask.messages.push({ role: 'assistant', content: `**Couldn't answer:** ${e.message}` });
  }
  ask.busy = false; renderAsk();
}

async function showAskHistory() {
  const chats = await api('/api/assistant/chats');
  const body = $('#askBody');
  body.innerHTML = `<div class="ask-history"><h4>Past chats</h4>${chats.length ? chats.map((c) => `
    <div class="ask-chat" data-chat="${c.id}"><button type="button" class="ask-chat-open"><b>${esc(c.title || 'Chat')}</b><small>${when(c.updated_at)}${c.scope_type !== 'all' ? ` · ${c.scope_type}` : ''}</small></button>
    <button type="button" class="icon-btn" data-del="${c.id}" aria-label="Delete chat">✕</button></div>`).join('') : '<p class="muted small">No chats yet.</p>'}</div>`;
  $$('.ask-chat-open', body).forEach((b) => b.onclick = attempt(async () => {
    const c = await api(`/api/assistant/chats/${b.closest('[data-chat]').dataset.chat}`);
    ask.chatId = c.id; ask.messages = c.messages; ask.refs = c.refs || {};
    renderAsk();
  }));
  $$('[data-del]', body).forEach((b) => b.onclick = attempt(async () => {
    await api(`/api/assistant/chats/${b.dataset.del}`, { method: 'DELETE' });
    if (ask.chatId === b.dataset.del) { ask.chatId = null; ask.messages = []; }
    showAskHistory();
  }));
}

// Sidebar "Ask AI" button (rendered with the shell) opens the drawer.
document.addEventListener('click', (e) => { if (e.target.closest('[data-ask]')) { mountAsk(); toggleAsk(true); } });

route();
