// Interactive parts (Films ui/button.ts, controls.ts, menu.ts): the button
// factory, toggles, tabs, menus, dropdowns and the select that replaces
// native <select>. Looks come from base.css (.btn, .tabs, .menu,
// .panel-float). Nothing here wires hover listeners.

import { el, icon, setPressed } from './dom.js';

const ICON_SIZE = { xs: 11, sm: 12, md: 14, lg: 16 };

export const keycap = key => el('kbd', { class: 'keycap', 'aria-hidden': 'true' }, key === 'Escape' ? 'Esc' : key.toUpperCase());

/** The one button factory. o: label, icon (name), variant (secondary,
 *  primary, ghost, danger, tool), size (xs, sm, md, lg), title (tooltip, and
 *  the accessible name when there is no label), pressed (makes it a toggle:
 *  flip it with setPressed), onClick, iconSize (default by size). */
export function button(o = {}) {
  const variant = o.variant ?? 'secondary';
  const size = o.size ?? 'md';
  const b = el('button', { type: 'button', class: ['btn', o.label ? null : 'btn-icon', o.class], dataset: { variant, size } });
  if (o.icon) b.append(icon(o.icon, o.iconSize ?? ICON_SIZE[size]));
  if (o.label) b.append(el('span', { class: 'label' }, o.label));
  if (o.shortcut) {
    b.append(keycap(o.shortcut));
    b.dataset.shortcut = o.shortcut;
    b.setAttribute('aria-keyshortcuts', o.shortcut);
  }
  if (o.title) {
    b.title = o.title;
    if (!o.label) b.setAttribute('aria-label', o.title);
  }
  if (o.pressed !== undefined) setPressed(b, o.pressed);
  if (o.onClick) b.addEventListener('click', o.onClick);
  return b;
}

/** Square icon-only button. The `title` is its tooltip and accessible name. */
export const iconButton = (name, title, size = 'md', variant = 'secondary', onClick) =>
  button({ icon: name, title, size, variant, onClick });

/** A toggle button: flips aria-pressed on click and reports the new state.
 *  setPressed() changes it from outside without firing. Default size sm. */
export function toggle(o) {
  const b = button({ ...o, size: o.size ?? 'sm', pressed: Boolean(o.pressed), onClick: undefined });
  b.dataset.cmd = 'toggle';
  b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    setPressed(b, on);
    o.onChange?.(on);
  });
  return b;
}

let tabSeq = 0;

/** Tabs: a tablist that shows and hides its panels (Films tabs). items:
 *  [{ value, label, icon?, count?, panel }]. Returns { el, set(v),
 *  setCount(v, n) }. */
export function tabs(items, initial, onChange, o = {}) {
  const seq = ++tabSeq;
  const list = el('div', { class: 'tabs', role: 'tablist', dataset: { compact: o.compact ? '' : null } });
  let current = initial;
  const els = items.map((it, i) => {
    const id = `tab-${seq}-${i}`;
    const count = el('span', { class: 'count' }, it.count ?? '');
    const t = el('button', { type: 'button', class: 'tab', role: 'tab', id },
      it.icon ? icon(it.icon, 14) : null, el('span', { class: 'truncate' }, it.label), count);
    if (!it.panel.id) it.panel.id = `${id}-panel`;
    t.setAttribute('aria-controls', it.panel.id);
    it.panel.setAttribute('role', 'tabpanel');
    it.panel.setAttribute('aria-labelledby', id);
    t.addEventListener('click', () => pick(i, false));
    t.addEventListener('keydown', e => {
      const n = items.length;
      if (e.key === 'ArrowRight') { e.preventDefault(); pick((i + 1) % n, true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); pick((i - 1 + n) % n, true); }
      else if (e.key === 'Home') { e.preventDefault(); pick(0, true); }
      else if (e.key === 'End') { e.preventDefault(); pick(n - 1, true); }
    });
    list.append(t);
    return { t, count };
  });
  const sync = () => items.forEach((it, i) => {
    const on = it.value === current;
    els[i].t.setAttribute('aria-selected', String(on));
    els[i].t.tabIndex = on ? 0 : -1;
    it.panel.hidden = !on;
  });
  function pick(i, focus) {
    if (focus) els[i].t.focus();
    if (items[i].value === current) return;
    current = items[i].value;
    sync();
    onChange?.(current);
  }
  sync();
  return {
    el: list,
    set(v) { current = v; sync(); },
    setCount(v, n) {
      const i = items.findIndex(it => it.value === v);
      if (i >= 0) els[i].count.textContent = n === null || n === undefined ? '' : String(n);
    },
  };
}

// ── Menus ───────────────────────────────────────────────────────────────

/** Fired (bubbling) by a menu that wants its container closed. */
export const MENU_CLOSE = 'menu-close';

/** A menu panel (Films menu). items: [{ value, label, icon?, hint?, checked?,
 *  disabled?, group?, title? }]. o.mode: action, radio or check. o.onPick(v,
 *  checked). Arrow keys, Home, End and a letter move. Enter and Space pick.
 *  Escape asks to close. Radio and action picks close, but check toggles in
 *  place. o.embedded: no frame of its own. */
export function menu(items, o) {
  const m = el('div', { class: ['menu', o.embedded ? null : 'panel-float'], role: 'menu', dataset: { embedded: o.embedded ? '' : null } });
  if (o.label) m.setAttribute('aria-label', o.label);
  const role = o.mode === 'check' ? 'menuitemcheckbox' : o.mode === 'radio' ? 'menuitemradio' : 'menuitem';
  const marks = o.mode !== 'action' || items.some(it => it.checked !== undefined);
  const state = items.map(it => Boolean(it.checked));
  const rows = [];
  let group;
  items.forEach((it, i) => {
    if (it.group !== group) {
      if (i > 0) m.append(el('div', { class: 'menu-sep', role: 'separator' }));
      if (it.group) m.append(el('div', { class: 'menu-group caps' }, it.group));
      group = it.group;
    }
    const r = el('button', { type: 'button', class: 'menuitem', role, tabindex: '-1', title: it.title, disabled: it.disabled });
    if (marks) r.append(el('span', { class: 'mark' }, icon('check', o.mode === 'check' ? 10 : 12)));
    if (it.icon) r.append(icon(it.icon, 14));
    r.append(el('span', { class: 'label' }, it.label));
    if (it.hint) r.append(el('span', { class: 'hint' }, it.hint));
    const paint = () => { if (o.mode !== 'action' || it.checked !== undefined) r.setAttribute('aria-checked', String(state[i])); };
    paint();
    r.addEventListener('click', () => {
      if (o.mode === 'check') {
        state[i] = !state[i];
        paint();
        o.onPick(it.value, state[i]);
        return;
      }
      if (o.mode === 'radio') {
        state.forEach((_, j) => { state[j] = j === i; rows[j].setAttribute('aria-checked', String(state[j])); });
      }
      o.onPick(it.value, true);
      m.dispatchEvent(new CustomEvent(MENU_CLOSE, { bubbles: true }));
    });
    rows.push(r);
    m.append(r);
  });
  if (o.footer) m.append(el('div', { class: 'menu-footer', style: { margin: '4px 0 -4px' } }, o.footer));

  const enabled = () => rows.filter(r => !r.disabled);
  const move = d => {
    const list = enabled();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement);
    const next = d === 'first' ? 0 : d === 'last' ? list.length - 1
      : at < 0 ? (d > 0 ? 0 : list.length - 1) : (at + d + list.length) % list.length;
    list[next].focus();
  };
  m.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); move('first'); }
    else if (e.key === 'End') { e.preventDefault(); move('last'); }
    else if (e.key === 'Escape') { e.preventDefault(); m.dispatchEvent(new CustomEvent(MENU_CLOSE, { bubbles: true })); }
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const list = enabled();
      const at = list.indexOf(document.activeElement);
      const k = e.key.toLowerCase();
      for (let s = 1; s <= list.length; s++) {
        const r = list[(at + s) % list.length];
        if ((r.textContent ?? '').trim().toLowerCase().startsWith(k)) { r.focus(); break; }
      }
    }
  });
  return m;
}

/** Place a fixed panel under (or above) `anchor`, inside the viewport. */
function place(panel, anchor, align) {
  const r = anchor.getBoundingClientRect();
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  let left = align === 'end' ? r.right - pw : r.left;
  left = Math.max(8, Math.min(left, vw - pw - 8));
  const below = r.bottom + 2, above = r.top - ph - 2;
  const top = below + ph > vh - 8 && above >= 8 ? above : below;
  panel.style.left = `${left}px`;
  panel.style.top = `${Math.max(8, Math.min(top, vh - ph - 8))}px`;
}

/** Open what `build()` returns under `trigger` on click. A second click,
 *  Escape, a pick or a press outside closes it. The trigger gets
 *  aria-haspopup, aria-expanded and a caret (unless o.caret is false).
 *  `build` brings its own surface: a menu(), or a .panel-float.
 *  Returns { open(), close(), refresh(), isOpen() }. */
export function dropdown(trigger, build, o = {}) {
  trigger.setAttribute('aria-haspopup', o.haspopup ?? 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  if (o.caret !== false && !trigger.querySelector('[data-role=caret]')) {
    const c = icon('caret', 10);
    c.dataset.role = 'caret';
    trigger.append(c);
  }
  let host = null;
  let unbind = null;
  const close = () => {
    unbind?.();
    unbind = null;
    host?.remove();
    host = null;
    trigger.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    if (host) return;
    host = el('div', { class: 'float', style: o.width ? { width: `${o.width}px` } : {} }, build());
    document.body.append(host);
    place(host, trigger, o.align ?? 'start');
    trigger.setAttribute('aria-expanded', 'true');
    const down = e => { if (!host?.contains(e.target) && !trigger.contains(e.target)) close(); };
    const key = e => { if (e.key === 'Escape') { close(); trigger.focus(); } };
    const req = () => { close(); trigger.focus(); };
    const away = () => close();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', away);
    host.addEventListener(MENU_CLOSE, req);
    unbind = () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', away);
    };
    (host.querySelector('[role^=menuitem][aria-checked=true]:not(:disabled)')
      ?? host.querySelector('[role^=menuitem]:not(:disabled)'))?.focus();
  };
  trigger.addEventListener('click', () => { if (host) close(); else open(); });
  trigger.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' && !host) { e.preventDefault(); open(); }
  });
  return {
    open,
    close,
    isOpen: () => Boolean(host),
    refresh() {
      if (!host) return;
      host.replaceChildren(build());
      place(host, trigger, o.align ?? 'start');
    },
  };
}

/** A radio dropdown whose trigger shows the current label, optionally after
 *  a muted lead ('View: Tactical') and an icon (Films select). options:
 *  [{ value, label, title?, group? }]. Returns the trigger with set(v) (no
 *  event) and setOptions(options) for lists that change (players, maps). */
export function select(options, value, onChange, o = {}) {
  let current = value;
  let opts = options;
  const b = button({ icon: o.icon, label: ' ', size: o.size ?? 'md', variant: o.variant ?? 'secondary', iconSize: o.iconSize });
  const text = b.querySelector('.label');
  const lead = o.label ? el('span', { style: { color: 'var(--muted)' } }, `${o.label}: `) : null;
  // Every option's label sits in one grid cell, only the current one
  // visible, so the trigger is as wide as the longest option and never
  // shifts the commands after it when the value changes. o.fixed: false
  // lets it size to the current label instead (long dynamic lists).
  const shown = el('span', { class: 'value', style: { display: 'inline-grid', gridTemplateColumns: 'minmax(0,auto)', minWidth: '0', maxWidth: '100%', textAlign: 'left' } });
  text.replaceChildren(...(lead ? [lead] : []), shown);
  let cells = [];
  const build = () => {
    const list = o.fixed === false ? [] : opts;
    cells = list.map(x => el('span', { class: 'truncate', style: { gridArea: '1/1', visibility: 'hidden' }, 'aria-hidden': 'true' }, x.label));
    shown.replaceChildren(...cells);
    if (o.fixed === false) shown.append(el('span', { class: 'truncate', style: { gridArea: '1/1' } }));
  };
  const paint = () => {
    const opt = opts.find(x => x.value === current);
    if (o.fixed === false) shown.lastElementChild.textContent = opt?.label ?? '';
    else opts.forEach((x, i) => { cells[i].style.visibility = x.value === current ? 'visible' : 'hidden'; });
    b.title = opt?.title ?? o.title ?? '';
    if (o.ariaLabel) b.setAttribute('aria-label', opt ? `${o.ariaLabel}, ${opt.label}` : o.ariaLabel);
  };
  build();
  paint();
  const dd = dropdown(b, () => menu(
    opts.map(x => ({ value: x.value, label: x.label, title: x.title, group: x.group, checked: x.value === current })),
    {
      mode: 'radio',
      label: o.ariaLabel,
      onPick: v => {
        if (v === current) return;
        current = v;
        paint();
        onChange(v);
      },
    }), { align: o.align });
  return Object.assign(b, {
    set(v) { current = v; paint(); },
    setOptions(next) {
      const key = JSON.stringify(next.map(x => [x.value, x.label, x.group ?? '']));
      if (key === b.dataset.options) return;
      b.dataset.options = key;
      opts = next;
      build();
      paint();
      dd.refresh();
    },
  });
}
