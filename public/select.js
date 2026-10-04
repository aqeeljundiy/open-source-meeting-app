// Custom dropdowns in the app's style, layered over every native <select>.
// The native select stays in the DOM (hidden) and keeps the value, so forms,
// FormData and existing `change` handlers work unchanged.
const ENHANCED = new WeakSet();
let openMenu = null; // { menu, btn, select, close }

const chevron = '<svg viewBox="0 0 24 24" class="sel-chev" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>';
const check = '<svg viewBox="0 0 24 24" class="sel-check" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
let uid = 0;

export function enhanceSelects(root = document) {
  root.querySelectorAll('select').forEach(enhance);
}

function enhance(select) {
  if (ENHANCED.has(select) || select.multiple || select.dataset.native !== undefined) return;
  ENHANCED.add(select);

  const cs = getComputedStyle(select);
  const wrap = document.createElement('span');
  wrap.className = 'sel';
  const parentDisplay = getComputedStyle(select.parentElement).display;
  if (parentDisplay.includes('grid') || select.parentElement.tagName === 'LABEL' || cs.width === select.parentElement.clientWidth + 'px') wrap.classList.add('sel-block');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sel-btn';
  btn.setAttribute('role', 'combobox');
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const label = select.getAttribute('aria-label') || select.closest('label')?.firstChild?.textContent?.trim();
  if (label) btn.setAttribute('aria-label', label);
  // Inherit the size the page gave this select (sidebar, chips, task rows...).
  for (const p of ['height', 'fontSize', 'fontWeight', 'borderRadius', 'backgroundColor', 'color', 'maxWidth']) btn.style[p] = cs[p];
  btn.style.paddingLeft = cs.paddingLeft;
  if (cs.borderColor === 'rgba(0, 0, 0, 0)' || cs.borderStyle === 'none') btn.style.borderColor = 'transparent';

  select.parentNode.insertBefore(wrap, select);
  wrap.append(btn, select);
  select.classList.add('sel-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const sync = () => {
    const opt = select.options[select.selectedIndex];
    btn.innerHTML = `<span class="sel-text">${escapeHtml(opt?.text ?? '')}</span>${chevron}`;
    btn.disabled = select.disabled;
    btn.classList.toggle('sel-placeholder', !opt || opt.value === '');
  };
  sync();
  select.addEventListener('change', () => setTimeout(sync));   // after handlers that revert the value
  select.__mbSync = sync;

  btn.addEventListener('click', () => (openMenu?.select === select ? closeMenu() : open(select, btn)));
  btn.addEventListener('keydown', (e) => {
    if (openMenu?.btn === btn) return;   // the open menu handles keys itself
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(select, btn); }
  });
}

function open(select, btn) {
  closeMenu();
  select.__mbSync?.();
  const menu = document.createElement('div');
  menu.className = 'sel-menu';
  menu.setAttribute('role', 'listbox');
  menu.id = `sel-${++uid}`;
  btn.setAttribute('aria-controls', menu.id);

  const items = [];
  const addOption = (opt) => {
    const el = document.createElement('div');
    el.className = 'sel-opt';
    el.setAttribute('role', 'option');
    el.id = `${menu.id}-${items.length}`;
    el.setAttribute('aria-selected', String(opt.selected));
    if (opt.disabled) el.setAttribute('aria-disabled', 'true');
    el.innerHTML = `<span>${escapeHtml(opt.text)}</span>${check}`;
    el.addEventListener('mousedown', (e) => e.preventDefault());   // keep focus on the button
    el.addEventListener('click', () => !opt.disabled && choose(opt));
    el.addEventListener('mousemove', () => setActive(items.findIndex((i) => i.el === el)));
    menu.appendChild(el);
    items.push({ el, opt });
  };
  for (const child of select.children) {
    if (child.tagName === 'OPTGROUP') {
      const h = document.createElement('div');
      h.className = 'sel-group';
      h.textContent = child.label;
      menu.appendChild(h);
      [...child.children].forEach(addOption);
    } else addOption(child);
  }

  let active = Math.max(0, items.findIndex((i) => i.opt.selected));
  const setActive = (i) => {
    if (i < 0 || i >= items.length) return;
    items[active]?.el.classList.remove('active');
    active = i;
    items[i].el.classList.add('active');
    btn.setAttribute('aria-activedescendant', items[i].el.id);
    const el = items[i].el;
    if (el.offsetTop < menu.scrollTop) menu.scrollTop = el.offsetTop - 4;
    else if (el.offsetTop + el.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = el.offsetTop + el.offsetHeight - menu.clientHeight + 4;
  };

  const choose = (opt) => {
    const changed = select.value !== opt.value;
    select.value = opt.value;
    closeMenu();
    btn.focus();
    select.__mbSync();
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  // Inside a modal <dialog> the menu must live in the dialog (top layer), else on <body>.
  (btn.closest('dialog') || document.body).appendChild(menu);
  place(menu, btn);
  setActive(active);
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('open');

  let typed = '', typedAt = 0;
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(nextEnabled(items, active, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(nextEnabled(items, active, -1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(nextEnabled(items, -1, 1)); }
    else if (e.key === 'End') { e.preventDefault(); setActive(nextEnabled(items, items.length, -1)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const it = items[active]; if (it && !it.opt.disabled) choose(it.opt); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); btn.focus(); }
    else if (e.key === 'Tab') closeMenu();
    else if (e.key.length === 1) {
      // Type to jump to an option.
      typed = Date.now() - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = Date.now();
      const i = items.findIndex((it) => it.opt.text.toLowerCase().startsWith(typed));
      if (i >= 0) setActive(i);
    }
  };
  const onDown = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) closeMenu(); };
  const onMove = () => place(menu, btn);
  btn.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  addEventListener('resize', onMove);
  addEventListener('scroll', onMove, true);

  openMenu = {
    menu, btn, select,
    close: () => {
      btn.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      removeEventListener('resize', onMove);
      removeEventListener('scroll', onMove, true);
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('aria-activedescendant');
      btn.classList.remove('open');
      menu.classList.add('closing');
      setTimeout(() => menu.remove(), 140);
    },
  };
}

function nextEnabled(items, from, dir) {
  for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (!items[i].opt.disabled) return i;
  return from;
}

function place(menu, btn) {
  const r = btn.getBoundingClientRect();
  if (!r.width) return closeMenu();
  const below = innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const want = Math.min(menu.scrollHeight, 300);
  const up = below < Math.min(want, 200) && above > below;
  menu.style.minWidth = `${Math.max(r.width, 180)}px`;
  menu.style.maxHeight = `${Math.max(120, Math.min(300, up ? above : below))}px`;
  const left = Math.min(r.left, innerWidth - Math.max(r.width, 180) - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = up ? '' : `${r.bottom + 6}px`;
  menu.style.bottom = up ? `${innerHeight - r.top + 6}px` : '';
  menu.classList.toggle('up', up);
}

function closeMenu() {
  if (!openMenu) return;
  const m = openMenu;
  openMenu = null;
  m.close();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Enhance selects as views render (the app re-renders with innerHTML).
new MutationObserver((records) => {
  for (const r of records) for (const n of r.addedNodes) {
    if (n.nodeType !== 1) continue;
    if (n.tagName === 'SELECT') enhance(n);
    else if (n.querySelector?.('select')) enhanceSelects(n);
  }
  // A re-render can remove the button an open menu belongs to.
  if (openMenu && !openMenu.btn.isConnected) closeMenu();
}).observe(document.documentElement, { childList: true, subtree: true });
enhanceSelects();
