// DOM helpers and the static parts (Films ui/dom.ts, status.ts, cells.ts,
// table.ts kvGrid). Every builder returns an element wearing the matching
// class from base.css. Interactive parts (buttons, menus) are in controls.js.

import { icon as lucide } from './icons.js';

/** createElement with attributes and children in one call.
 *  attrs: class (string or array), text, dataset {}, aria {} (aria-*),
 *  style {} (properties, custom ones too), on {} (event listeners), and
 *  anything else as an attribute (true for a bare attribute, false or
 *  null to leave it off). Strings in `kids` become text nodes. */
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'text') e.textContent = String(v);
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) { if (dv !== undefined && dv !== null) e.dataset[dk] = String(dv); }
    else if (k === 'aria') for (const [ak, av] of Object.entries(v)) { if (av !== undefined && av !== null) e.setAttribute(`aria-${ak}`, String(av)); }
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) e.style.setProperty(sk, sv); else e.style[sk] = sv; }
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid instanceof Node ? kid : String(kid));
  }
  return e;
}

/** Write text only when it changed (views update at 4 Hz). */
export function setText(node, text) {
  const s = text === null || text === undefined ? '' : String(text);
  if (node.textContent !== s) node.textContent = s;
  return node;
}

/** Set a number's text with each figure in a slot (.fig, 1ch wide), for
 *  the HUD's face, which has no tabular figures: a ticking clock keeps
 *  every figure in place. Only when it changed. */
export function setFigures(node, text) {
  const s = text === null || text === undefined ? '' : String(text);
  if (node.dataset.figures === s) return node;
  node.dataset.figures = s;
  node.replaceChildren(...[...s].map(ch => (/\d/.test(ch) ? el('span', { class: 'fig' }, ch) : ch)));
  return node;
}

/** Set or remove an attribute only when it changed. */
export function setAttr(node, name, value) {
  if (value === null || value === undefined || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else {
    const s = value === true ? '' : String(value);
    if (node.getAttribute(name) !== s) node.setAttribute(name, s);
  }
  return node;
}

/** A toggle's pressed state (aria-pressed, drawn by base.css). */
export function setPressed(b, on) {
  b.setAttribute('aria-pressed', String(Boolean(on)));
  return b;
}

/** A Lucide icon as an inline SVG (icons.js). */
export function icon(name, size = 14) {
  return lucide(name, size);
}

/** A custom property's value from :root, read once and kept (only the
 *  team colours change at runtime, and teams.js resets the cache when they
 *  do). For canvas code: token('--team-0') is a hex. */
const tokenCache = new Map();
export const resetTokens = () => tokenCache.clear();
export function token(name) {
  let v = tokenCache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    tokenCache.set(name, v);
  }
  return v;
}

// ── Format ──────────────────────────────────────────────────────────────

/** Copy rules: no dashes or ellipses as placeholders. An empty value is ''. */
const EMPTY = '';

export const fmt = {
  /** 12.4 -> '12.4 s', null -> ''. */
  seconds(s, digits = 1) {
    return Number.isFinite(s) ? `${s.toFixed(digits)} s` : EMPTY;
  },
  /** Whole seconds as m:ss, or null for nothing to show. */
  clock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  },
  /** An integer, or '' when unknown. */
  int(n) {
    return Number.isFinite(n) ? String(Math.round(n)) : EMPTY;
  },
  /** Feet (the snapshot's unit) as metres, like Films: '7.5 m'. */
  metres(ft, digits = 1) {
    if (!Number.isFinite(ft)) return EMPTY;
    const m = Number((ft * 0.3048).toFixed(digits));
    return `${(Object.is(m, -0) ? 0 : m).toFixed(digits)} m`;
  },
  /** A countdown: '1:05' from a minute, '14 s' from ten seconds (rounded
   *  up, as a countdown reads), '7.5 s' below that, and '' when unknown. */
  countdown(s) {
    if (!Number.isFinite(s)) return EMPTY;
    const v = Math.max(0, s);
    if (v >= 60) return fmt.clock(Math.ceil(v)) ?? EMPTY;
    return v >= 10 ? `${Math.ceil(v)} s` : `${v.toFixed(1)} s`;
  },
  /** First letter up, underscores as spaces: 'not_ready' -> 'Not ready'. */
  words(s) {
    if (!s) return EMPTY;
    const t = String(s).replaceAll('_', ' ');
    return t.charAt(0).toUpperCase() + t.slice(1);
  },
};

// ── Static parts ────────────────────────────────────────────────────────

/** Small-caps caption (Films CAPS). */
export const caps = (text, attrs = {}) => el('span', { ...attrs, class: ['caps', attrs.class] }, text);

/** Square colour sample, with `color` any CSS colour or var(). */
export const swatch = (color, size = 8) =>
  el('span', { class: 'swatch', style: { '--swatch': color, width: `${size}px`, height: `${size}px` }, 'aria-hidden': 'true' });

/** 8x8 square in a tone: ok, err, warn, muted, accent (Films statusDot). */
export const stateDot = (tone = 'muted') => el('span', { class: 'state-dot', dataset: { tone }, 'aria-hidden': 'true' });

/** Status label (Films tag): tone muted, ok, err, warn, info, accent.
 *  o.icon: a lead icon name (11px), o.small: 16px, o.mast: masthead height,
 *  o.busy: a spinner first. */
export function tag(text, tone = 'muted', o = {}) {
  const t = el('span', { class: 'tag', dataset: { tone, small: o.small ? '' : null, mast: o.mast ? '' : null } });
  if (o.busy) {
    const s = icon('sync', 12);
    s.classList.add('spin');
    t.append(s);
  } else if (o.icon) t.append(icon(o.icon, 11));
  t.append(text);
  return t;
}

/** Repaint a tag made by tag() in place. */
export function setTag(t, text, tone = 'muted', o = {}) {
  setAttr(t, 'data-tone', tone);
  const key = `${tone}|${text}|${o.busy ? 1 : 0}|${o.icon ?? ''}`;
  if (t.dataset.key === key) return t;
  t.dataset.key = key;
  t.replaceChildren();
  if (o.busy) {
    const s = icon('sync', 12);
    s.classList.add('spin');
    t.append(s);
  } else if (o.icon) t.append(icon(o.icon, 11));
  t.append(text);
  return t;
}

/** Loading block sized to what it stands in for (Films skel). */
export const skel = (w, h = 12) =>
  el('span', { class: 'skel', style: { width: typeof w === 'number' ? `${w}px` : w, height: `${h}px` }, 'aria-hidden': 'true' });

/** Centred placeholder (Films emptyState). */
export function emptyState({ icon: name, title, body }) {
  return el('div', { class: 'empty-state' },
    name ? icon(name, 24) : null,
    el('div', { class: 'title' }, title),
    body ? el('div', { class: 'body' }, body) : null);
}

/** Groups of key-value pairs (Films kvGrid). groups: [{ title?, summary?,
 *  rows: [{ key, value (string or Node), mono?, state? (dot tone), note? }] }].
 *  o.compact: the panel size, o.keyWidth: px. */
export function kvGrid(groups, o = {}) {
  const wrap = el('div', { class: 'kv', dataset: { compact: o.compact ? '' : null } });
  if (o.keyWidth) wrap.style.setProperty('--kv-key', `${o.keyWidth}px`);
  for (const g of groups) {
    const s = el('section');
    if (g.title) {
      s.append(el('h3', { class: 'kv-band' }, el('span', { class: 'truncate' }, g.title),
        g.summary !== undefined ? el('span', { style: { marginLeft: 'auto', font: 'var(--t-sm)', color: 'var(--muted)' } }, g.summary) : null));
    }
    const dl = el('dl');
    for (const r of g.rows) {
      const dd = el('dd', {}, r.state ? stateDot(r.state) : null, r.value ?? '',
        r.note ? el('span', { style: { font: 'var(--t-sm)', color: 'var(--muted)' } }, r.note) : null);
      if (r.value === '' || r.value === null || r.value === undefined) dd.setAttribute('aria-label', 'Unknown');
      if (r.mono) dd.classList.add('mono');
      dl.append(el('dt', { class: r.mono ? 'mono' : null }, r.key), dd);
    }
    s.append(dl);
    wrap.append(s);
  }
  return wrap;
}

/** A row of joined cells (Films cellRow). o.height px (default the
 *  masthead's 32), o.fill: equal cells across the width, o.flush: only a
 *  hairline above. */
export function cellRow(o = {}, ...cells) {
  return el('div', {
    class: 'cells',
    dataset: { fill: o.fill ? '' : null, flush: o.flush ? '' : null },
    style: o.height ? { '--cells-h': `${o.height}px` } : {},
  }, ...cells);
}

/** Give a node its team's colour for base.css: data-team="N" (team id mod
 *  8, any integer) or "none" (null, observers). A string instead is a CSS
 *  colour for --team-color, with no tint. Returns the node. */
export function teamAttr(node, team) {
  if (typeof team === 'string') {
    delete node.dataset.team;
    node.style.setProperty('--team-color', team);
  } else {
    node.style.removeProperty('--team-color');
    node.dataset.team = Number.isInteger(team) ? String(((team % 8) + 8) % 8) : 'none';
  }
  return node;
}

/** A cell on a tint of its team's colour with the 3px rule (Films
 *  scoreCell). Its `team` is as in teamAttr, and `bright` is the leader's. */
export function scoreCell(team, bright, ...kids) {
  return teamAttr(el('span', { class: 'cell', dataset: { bright: bright ? '' : null } }, ...kids), team);
}

/** A name in a cell (it hides on phones). */
export const cellName = (text) => el('span', { class: 'cell-name' }, text);
