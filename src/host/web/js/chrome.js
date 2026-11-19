// The chrome around the stage, Films' bars stacked edge to edge:
//   app bar   brand, LAN tag, Broadcast view (Films appHeader)
//   masthead  map and mode on two fixed lines, facts and Session info. The
//             team scores and the elapsed clock as joined cells, the feed's
//             state as a tag (Films masthead, cells)
//   ribbon    captioned groups of commands, toggles, selects and drops that
//             fold into More, or into [Layers] [Filter] sheets on phones
//             (Films ribbon)
//   live bar  in the timeline's slot: pause, elapsed, feed state, freshness
//
// Nothing here may move while values change: every live value sits in a
// fixed slot (fixed()), every set of words in one stacked cell (stack()).
// The feed's trouble is said by the live bar and the map's stage strip, so
// nothing is ever inserted into the column (no notice bar). Paints write to
// the DOM only what changed.

import { state, setView, subscribe, mapOnly, broadcastMode, labelMode } from './state.js';
import { el, icon, setText, setAttr, setPressed, tag, swatch, stateDot, skel, cellRow, scoreCell, cellName, kvGrid, fmt } from './dom.js';
import { button, toggle, select, menu, dropdown, MENU_CLOSE } from './controls.js';
import { phaseOf, matchContext, mapTitle, teamsOf, playerLabel, isPad, elevationValue, clockText, feedTag } from './model.js';
import { modeIcon } from './modes.js';
import { TEAM_COLORS, COLORED_TEAMS, teamColorByKey, setTeamColor, teamEmblem } from './teams.js';
import { FLOOR_COLORS, floorPresetOf, setFloorColor } from './floorcolor.js';
import { floorImage, IMAGE_SIZES } from './map.js';

const PHONE = matchMedia('(max-width: 639px)');
const FT_TO_M = 0.3048;
/** One zoom step (Films ZOOM_STEP). */
const ZOOM_STEP = 1.4;

// ── Format ──────────────────────────────────────────────────────────────

/** Feet as whole metres: '12 m'. */
const metres = ft => (Number.isFinite(ft) ? `${Math.round(ft * FT_TO_M)} m` : '');

/** A duration since something, whole units (state.age is whole seconds):
 *  '0 s', '12 s', '4 min', '2 h'. */
function since(age) {
  if (!Number.isFinite(age)) return '';
  if (age < 60) return `${Math.floor(age)} s`;
  if (age < 3600) return `${Math.floor(age / 60)} min`;
  return `${Math.floor(age / 3600)} h`;
}

/** Show or hide a node, touching the DOM only on a change. */
function shown(node, on) {
  if (node.hidden === !on) return;
  node.hidden = !on;
}

/** Set an inline visibility only on a change. */
function visible(node, on) {
  const v = on ? 'visible' : 'hidden';
  if (node.style.visibility !== v) node.style.visibility = v;
}

/** feedTag()'s tones as state dot tones. */
const dotTone = tone => (tone === 'info' ? 'accent' : tone);

/** Text as a sentence: first letter up, a full stop at the end. */
function sentence(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** A poll error as a sentence the page can show. */
function causeOf(error) {
  if (!error) return '';
  if (/failed to fetch|networkerror|load failed/i.test(error)) return 'The observer is not reachable.';
  if (/json|unexpected token|unexpected end/i.test(error)) return 'The observer sent a reply that is not a snapshot.';
  return sentence(error);
}

// ── Fixed slots ─────────────────────────────────────────────────────────

/** One grid cell that every child shares, set inline so the stacking holds
 *  even before chrome.css applies. */
const GRID = { display: 'inline-grid', gridTemplateColumns: 'max-content', alignItems: 'center' };
const CELL = { gridArea: '1 / 1' };

/** A text slot that never changes width: invisible templates in the same
 *  grid cell size it ('000', '00:00'). A longer value grows it once, to the
 *  value with its digits zeroed, and it never shrinks back. The templates
 *  are drawn by CSS (content: attr(data-t)), so they are not text: the
 *  element's text is its value alone ('41', never '00041'), and without the
 *  stylesheet the slot only loses its fixed width. */
function fixed(templates, cls) {
  const value = el('span', { class: 'fx-value', style: CELL });
  const sizer = t => el('span', { class: 'fx-size', 'aria-hidden': 'true', dataset: { t }, style: { ...CELL, visibility: 'hidden' } });
  const node = el('span', { class: ['fx', cls], style: GRID }, ...templates.map(sizer), value);
  let widest = Math.max(0, ...templates.map(t => t.length));
  return {
    el: node,
    set(text) {
      const s = text ?? '';
      if (s.length > widest) {
        widest = s.length;
        node.prepend(sizer(s.replace(/\d/g, '0')));
      }
      setText(value, s);
    },
  };
}

/** Words stacked in one grid cell, only the current one visible, so the
 *  slot is as wide as its longest word (Films select's trick). A word not
 *  in the list is added the first time it shows (the slot grows once). The
 *  words are drawn by CSS (content: attr(data-t)). The caller keeps the
 *  current word as text in a hidden span, so only one word is ever read. */
function stack(words, cls) {
  const items = new Map();
  const node = el('span', { class: ['fx', cls], 'aria-hidden': 'true', style: GRID });
  const add = w => {
    const item = el('span', { class: 'fx-opt', dataset: { t: w }, style: { ...CELL, visibility: 'hidden' } });
    items.set(w, item);
    node.append(item);
    return item;
  };
  words.forEach(add);
  let current = null;
  return {
    el: node,
    set(word) {
      if (word === current) return;
      const was = items.get(current);
      if (was) { was.removeAttribute('data-on'); was.style.visibility = 'hidden'; }
      const now = items.get(word) ?? add(word);
      now.setAttribute('data-on', '');
      now.style.visibility = 'visible';
      current = word;
    },
  };
}

// ── Floating parts: placement, popover, bottom sheet ────────────────────

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

let closePopover = null;

/** Show `content` in the floating layer next to `anchor` (Films popover):
 *  closes on a press outside, Escape, a menu's close request or a resize. */
function popover(anchor, content, align = 'end') {
  closePopover?.();
  const host = el('div', { class: 'float' }, content);
  document.body.append(host);
  place(host, anchor, align);
  const down = e => { if (!host.contains(e.target)) close(); };
  const key = e => { if (e.key === 'Escape') { close(); anchor.focus(); } };
  function close() {
    document.removeEventListener('pointerdown', down, true);
    document.removeEventListener('keydown', key);
    window.removeEventListener('resize', close);
    host.remove();
    if (closePopover === close) closePopover = null;
  }
  document.addEventListener('pointerdown', down, true);
  document.addEventListener('keydown', key);
  window.addEventListener('resize', close);
  host.addEventListener(MENU_CLOSE, () => { close(); anchor.focus(); });
  closePopover = close;
  (host.querySelector('[role^=menuitem][aria-checked=true]:not(:disabled)')
    ?? host.querySelector('[role^=menuitem]:not(:disabled), input:not(:disabled)'))?.focus();
  return close;
}

let openSheet = null;

/** A modal bottom sheet (Films sheet): half height, a handle that toggles
 *  full height on tap and snaps on drag (dragged low, it closes), a head
 *  with the title and Close, a scrim that closes it. One at a time. */
function sheet(title, content) {
  openSheet?.close();
  const opener = document.activeElement;
  const handle = el('button', { type: 'button', class: 'ch-sheet-handle', 'aria-label': `${title}. Resize` }, el('span'));
  const x = button({ icon: 'x', title: 'Close', size: 'sm', variant: 'ghost' });
  const head = el('div', { class: 'ch-sheet-head' }, el('h2', { class: 'truncate' }, title), x);
  const body = el('div', { class: 'ch-sheet-body' }, content);
  const panel = el('div', { class: 'ch-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, dataset: { size: 'half' } }, handle, head, body);
  const scrim = el('div', { class: 'ch-scrim' });
  const key = e => { if (e.key === 'Escape') { e.preventDefault(); api.close(); } };
  const api = {
    el: panel,
    close() {
      if (!panel.isConnected) return;
      panel.remove();
      scrim.remove();
      document.removeEventListener('keydown', key);
      if (openSheet === api) openSheet = null;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    },
  };
  x.addEventListener('click', () => api.close());
  scrim.addEventListener('click', () => api.close());
  panel.addEventListener(MENU_CLOSE, () => api.close());

  let startY = 0, startH = 0, dragging = false, moved = false;
  handle.addEventListener('pointerdown', e => {
    dragging = true;
    moved = false;
    startY = e.clientY;
    startH = panel.offsetHeight;
    handle.setPointerCapture(e.pointerId);
    panel.style.transition = 'none';
  });
  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    if (moved) panel.style.height = `${Math.max(44, Math.min(window.innerHeight - 56, startH - dy))}px`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    const h = panel.offsetHeight;
    panel.style.height = '';
    if (!moved) { panel.dataset.size = panel.dataset.size === 'full' ? 'half' : 'full'; return; }
    if (h < window.innerHeight * 0.25) { api.close(); return; }
    panel.dataset.size = h > window.innerHeight * 0.72 ? 'full' : 'half';
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  document.body.append(scrim, panel);
  document.addEventListener('keydown', key);
  openSheet = api;
  (body.querySelector('[aria-checked=true], [aria-pressed=true]') ?? body.querySelector('button:not(:disabled), input:not(:disabled)'))
    ?.focus({ preventScroll: true });
  return api;
}

/** A 44px sheet row (Films' phone command list): a 16px icon, the label
 *  over its description, an optional value and caret. */
function sheetRow(o) {
  const value = o.value !== undefined ? el('span', { class: 'ch-row-value truncate' }, o.value) : null;
  const r = el('button', { type: 'button', class: 'ch-row', role: o.role, title: o.tip },
    o.icon ? icon(o.icon, 16) : el('span', { class: 'ch-row-icon' }),
    o.color ? swatch(o.color) : null,
    el('span', { class: 'ch-row-text' }, el('span', { class: 'truncate' }, o.label), o.sub ? el('span', { class: 'ch-row-sub' }, o.sub) : null),
    value,
    o.caret ? icon('caret', 10) : null);
  return { el: r, value };
}

// ── App bar ─────────────────────────────────────────────────────────────

function mountAppbar(root) {
  const brand = el('a', { class: 'brand', href: '/', 'aria-label': 'OpenSpartan Cartographer home' },
    icon('brand', 16), el('span', {}, 'OpenSpartan Cartographer'));
  const lan = tag('LAN', 'accent');
  lan.classList.add('brand-tag', 'hide-sm');
  const broadcast = button({
    icon: 'broadcast', label: 'Broadcast view', size: 'sm', variant: 'tool',
    title: 'Broadcast view. B.', shortcut: 'B',
    onClick: () => broadcastMode(true),
  });
  broadcast.setAttribute('aria-label', 'Broadcast view');
  const mapOnlyBtn = button({
    icon: 'fit', label: 'Map only', size: 'sm', variant: 'tool',
    title: 'Map only. M.', shortcut: 'M', onClick: () => mapOnly(true),
  });
  mapOnlyBtn.setAttribute('aria-label', 'Map only');
  root.replaceChildren(brand, lan, el('div', { class: 'appbar-end' }, mapOnlyBtn, broadcast));
}

// ── Masthead ────────────────────────────────────────────────────────────

/** Every word feedTag() gives (model.js): the phase while the feed is
 *  live, else the feed's state. The masthead tag and the live bar show the
 *  same word, each in a slot as wide as the longest. */
const FEED_WORDS = ['Live', 'Lobby', 'Loading', 'Post-match', 'Paused', 'Stale', 'Waiting', 'Blocked', 'Offline', 'Connecting'];

/** The masthead tag's tooltip, by word. */
const FEED_TIPS = {
  Live: 'The match is in progress.',
  Lobby: 'The server is in its lobby.',
  Loading: 'The server is loading the match.',
  'Post-match': 'The match is over.',
  Paused: 'The feed is paused. The map keeps the last snapshot.',
  Stale: 'The feed has stopped updating.',
  Waiting: 'Waiting for the LAN server.',
  Offline: 'The observer is not reachable.',
  Connecting: 'Connecting to the observer.',
};
const feedTip = f => FEED_TIPS[f.text] ?? (f.line ? sentence(f.line) : '');

/** Up to this many players a team's alive count is pips (two rows of four). */
const PIP_MAX = 8;

/** A team's score cell: name, score (three digits reserved) and an end slot
 *  of a fixed width holding the alive pips, or 'Won' once the match is over
 *  (Films scoreCell, cellLine, cellWon). Built once per team, updated in place. */
function teamCell(team) {
  const score = fixed(['000'], 'cell-value');
  const pips = el('span', { class: 'pips', 'aria-hidden': 'true' });
  // Drawn by CSS like the templates: always there to give the slot its
  // baseline, never text while it is hidden. The cell's title says 'Won'.
  const won = el('span', { class: 'caps won', dataset: { t: 'Won' }, 'aria-hidden': 'true' });
  const end = el('span', { class: 'cell-end' }, pips, won);
  const name = cellName(team.name);
  const emblem = teamEmblem(16);
  emblem.set(team.id);
  const cell = scoreCell(team.id, true, el('span', { class: 'cell-line' }, emblem.el, name, score.el, end));
  let pipKey = '';
  return {
    cell,
    update(t, bright, winner, over) {
      cell.toggleAttribute('data-bright', bright);
      // Phones show the slot only for the winner's 'Won' (chrome.css).
      end.toggleAttribute('data-won', over && winner);
      setText(name, t.name);
      score.set(t.score === null ? '' : String(t.score));
      const n = t.players.length;
      const key = n > PIP_MAX ? `n${t.alive}` : t.players.map(p => (p.alive ? 1 : 0)).join('');
      if (key !== pipKey) {
        pipKey = key;
        if (n > PIP_MAX) pips.replaceChildren(el('span', { class: 'pips-count num' }, String(t.alive)));
        else pips.replaceChildren(...t.players.map(p => el('i', { dataset: { alive: p.alive ? '' : null } })));
      }
      visible(pips, !over);
      visible(won, over && winner);
      const scoreText = t.score === null ? 'no score' : String(t.score);
      setAttr(cell, 'title', over && winner ? `${t.name}, ${scoreText}. Won.` : `${t.name}, ${scoreText}. ${t.alive} alive, ${n - t.alive} out.`);
    },
  };
}

/** A free-for-all leader's cell (Films' top three by kills): rank, name in
 *  a fixed width, kills with three digits reserved. */
function playerCell() {
  const rank = el('span', { class: 'caps cell-rank' });
  const name = el('span', { class: 'cell-name cell-name-fixed' });
  const score = fixed(['000'], 'cell-value');
  const cell = scoreCell(null, false, el('span', { class: 'cell-line' }, rank, name, score.el));
  return {
    cell,
    update(p, r) {
      cell.toggleAttribute('data-bright', r === 0);
      setText(rank, String(r + 1));
      setText(name, playerLabel(p));
      score.set(String(p.stats?.kills ?? 0));
      setAttr(cell, 'title', `${playerLabel(p)}, ${p.stats?.kills ?? 0} kills.`);
    },
  };
}

function mountMasthead(root) {
  // Left: the title, and under it the mode, round, counts and Session info.
  const title = el('h1', { class: 'mast-title truncate' });
  const modeSlot = el('span', { class: 'mast-mode' });
  const modeText = el('span', { class: 'truncate' });
  const lead = el('span', { class: 'mast-lead' }, modeSlot, modeText);
  const round = el('span', { class: 'mast-round' });
  const playersN = fixed(['00'], 'num');
  const padsN = fixed(['00'], 'num');
  const players = el('span', { class: 'chip' }, icon('players', 12), playersN.el);
  const pads = el('span', { class: 'chip' }, icon('timers', 12), padsN.el);
  const facts = el('span', { class: 'mast-facts hide-sm' }, round, players, pads);
  const info = sessionInfo();
  const line = el('div', { class: 'mast-line' }, lead, facts, info.el);
  const skeleton = el('div', { class: 'mast-skel', 'aria-hidden': 'true' }, skel(160, 14), skel(240, 10));
  const left = el('div', { class: 'mast-left' }, title, line, skeleton);

  // Right: the joined cells (teams, then the clock) and the state tag.
  const cellsHost = el('span', { class: 'mast-cells' });
  const clockValue = fixed(['00:00'], 'cell-value');
  const clock = el('span', { class: 'cell mast-clock', title: 'Elapsed' }, el('span', { class: 'cell-line' }, clockValue.el));
  const row = cellRow({}, cellsHost, clock);
  row.classList.add('mast-score');
  row.setAttribute('role', 'group');
  const words = stack(FEED_WORDS);
  const stateText = el('span', { class: 'sr-only' });
  const feed = el('span', { class: 'tag mast-tag', dataset: { mast: '', tone: 'muted' } }, words.el, stateText);
  const right = el('div', { class: 'mast-right' }, row, feed);
  root.replaceChildren(left, right);

  let modeKey;
  let cellsKey = '';
  let cells = [];
  return () => {
    const snap = state.snapshot;
    const loading = !snap && state.feed === 'connecting';
    shown(skeleton, loading);
    shown(title, !loading);
    shown(line, !loading);
    shown(right, !loading);

    // The snapshot's map whenever it names one (lobby and post-match too).
    const name = mapTitle(snap) || 'Waiting for a match';
    setText(title, name);
    setAttr(title, 'title', name);
    const [mode, roundText] = matchContext(snap);
    const gameMode = snap?.match_info?.game_mode ?? null;
    if (`${gameMode}|${mode}` !== modeKey) {
      modeKey = `${gameMode}|${mode}`;
      modeSlot.replaceChildren(...(mode ? [modeIcon(gameMode, 14)] : []));
    }
    setText(modeText, mode ?? '');
    shown(lead, Boolean(mode));
    setText(round, roundText ?? '');
    shown(round, Boolean(roundText));
    // No snapshot, no counts (never a '0' for nothing known).
    shown(facts, Boolean(snap));
    shown(players, Boolean(snap));
    shown(pads, Boolean(snap));
    if (snap) {
      const nPlayers = snap.players.length;
      const nPads = snap.objects.filter(isPad).length;
      playersN.set(String(nPlayers));
      padsN.set(String(nPads));
      setAttr(players, 'title', nPlayers === 1 ? '1 player' : `${nPlayers} players`);
      setAttr(pads, 'title', nPads === 1 ? '1 spawn pad' : `${nPads} spawn pads`);
    }
    info.paint();

    // Score cells: rebuilt only when the teams themselves change.
    const teams = teamsOf(snap);
    const over = snap?.life_cycle === 10;
    let label = '';
    if (teams.length) {
      const key = `t:${teams.map(t => t.id).join(',')}`;
      if (key !== cellsKey) {
        cellsKey = key;
        cells = teams.map(teamCell);
        cellsHost.replaceChildren(...cells.map(c => c.cell));
      }
      const top = Math.max(...teams.map(t => t.score ?? -Infinity));
      const leaders = teams.filter(t => (t.score ?? -Infinity) === top);
      const leader = leaders.length === 1 && Number.isFinite(top) ? leaders[0] : null;
      teams.forEach((t, i) => cells[i].update(t, !leader || leader === t, leader === t, over));
      label = `Score: ${teams.map(t => `${t.name} ${t.score ?? 'unknown'}`).join(', ')}.${over && leader ? ` ${leader.name} won.` : ''}`;
    } else {
      // Free for all: the top three by kills, as Films shows it.
      const ranked = (snap?.players ?? []).filter(p => !p.observer && p.stats)
        .sort((a, b) => (b.stats.kills ?? 0) - (a.stats.kills ?? 0) || a.slot - b.slot).slice(0, 3);
      const key = `p:${ranked.length}`;
      if (key !== cellsKey) {
        cellsKey = key;
        cells = ranked.map(playerCell);
        cellsHost.replaceChildren(...cells.map(c => c.cell));
      }
      ranked.forEach((p, i) => cells[i].update(p, i));
      if (ranked.length) label = `Most kills: ${ranked.map(p => `${playerLabel(p)} ${p.stats.kills ?? 0}`).join(', ')}.`;
    }
    const c = clockText(snap?.match_info?.elapsed_seconds);
    clockValue.set(c ?? '');
    shown(clock, c !== null);
    shown(row, cells.length > 0 || c !== null);
    row.toggleAttribute('data-over', over);
    setAttr(row, 'aria-label', [label, c ? `Elapsed ${c}.` : ''].filter(Boolean).join(' '));

    const f = feedTag(state);
    words.set(f.text);
    setAttr(feed, 'data-tone', f.tone);
    setAttr(feed, 'data-word', f.text);
    setAttr(feed, 'title', feedTip(f));
    setText(stateText, f.text);
  };
}

/** Session info (Films' Match info): an inline button in the masthead line
 *  that opens the process, feed, map and sample details. A warn dot marks
 *  warnings or skipped entries, and its slot is always there. */
function sessionInfo() {
  const dot = stateDot('warn');
  dot.classList.add('mast-info-dot');
  const b = el('button', { type: 'button', class: 'mast-info', title: 'The server process, the feed and the last snapshot.', 'aria-label': 'Session info' },
    icon('info', 12), el('span', { class: 'label hide-sm' }, 'Session info'), dot);
  let key = '';
  const groups = () => {
    const s = state.snapshot;
    const g = state.geometry;
    const f = feedTag(state);
    const feed = [{ key: 'State', value: f.text, state: dotTone(f.tone) }];
    if (state.feedError) feed.push({ key: 'Last error', value: causeOf(state.feedError) });
    if (!s) return [{ title: 'Feed', rows: feed }];
    const nPads = s.objects.filter(isPad).length;
    const geometry = g.status === 'ready' ? ['ok', g.message] : g.status === 'loading' ? ['accent', 'Loading floor plan'] : ['warn', sentence(g.message).replace(/\.$/, '')];
    const warnings = s.warnings ?? [];
    const sample = [
      { key: 'Players', value: String(s.players.length) },
      { key: 'Objects', value: String(s.objects.length) },
      { key: 'Spawn pads', value: String(nPads) },
      { key: 'Skipped entries', value: String(s.skipped_entries ?? 0), state: s.skipped_entries ? 'warn' : null },
      {
        key: 'Warnings',
        value: warnings.length ? el('span', { class: 'ch-lines' }, ...warnings.map(w => el('span', {}, sentence(w)))) : 'None',
        state: warnings.length ? 'warn' : null,
      },
    ];
    return [
      { title: 'Feed', rows: feed },
      {
        title: 'Server',
        rows: [
          { key: 'Process ID', value: String(s.pid), mono: true },
          { key: 'Phase', value: phaseOf(s.life_cycle) },
          { key: 'Life cycle', value: s.life_cycle === null || s.life_cycle === undefined ? 'Unknown' : String(s.life_cycle) },
          { key: 'World', value: String(s.world) },
          { key: 'Reads', value: fmt.words(s.consistency) },
        ],
      },
      {
        title: 'Map',
        rows: [
          { key: 'Map', value: mapTitle(s) || 'None' },
          ...(s.map?.level_id ? [{ key: 'Level', value: s.map.level_id, mono: true }] : []),
          ...(s.map_variant ? [{ key: 'Map asset', value: s.map_variant.asset_id, mono: true }] : []),
          ...(s.game_variant ? [{ key: 'Mode asset', value: s.game_variant.asset_id, mono: true }] : []),
          { key: 'Floor plan', value: geometry[1], state: geometry[0] },
          { key: 'Units', value: s.units === 'world_units_feet' ? 'Feet, shown in metres' : fmt.words(s.units) || 'Unknown' },
        ],
      },
      { title: 'Sample', summary: warnings.length ? (warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`) : undefined, rows: sample },
    ];
  };
  const build = () => el('div', { class: 'panel-float ch-pop', role: 'dialog', 'aria-label': 'Session info' },
    el('div', { class: 'ch-pop-head' }, el('h2', {}, 'Session info')),
    kvGrid(groups(), { compact: true, keyWidth: 128 }));
  const dd = dropdown(b, build, { caret: false, haspopup: 'dialog' });
  return {
    el: b,
    paint() {
      const s = state.snapshot;
      const warn = Boolean(s?.warnings?.length || s?.skipped_entries);
      visible(dot, warn);
      setAttr(b, 'aria-label', warn ? 'Session info, with warnings' : 'Session info');
      if (!dd.isOpen()) return;
      const k = JSON.stringify([state.feed, state.feedError, s?.pid, s?.life_cycle, s?.world, s?.map, s?.players.length,
        s?.objects.length, s?.skipped_entries, s?.warnings, state.geometry.status, state.geometry.message]);
      if (k !== key) { key = k; dd.refresh(); }
    },
  };
}

// ── Ribbon ──────────────────────────────────────────────────────────────
//
// Each command is an entry the More menu and the phone sheets can replay:
// { kind: toggle|action|select|drop, key, label, icon, title, el, sync(),
//   pressed() (toggle), run() (toggle, action), value() (shown value),
//   options(), current(), pick(v) (select, drop), menu() (its panel) }.

/** A toggle command: flat tool button, 14px icon, label, aria-pressed. */
function toggleCmd(o) {
  const b = toggle({ icon: o.icon, iconSize: 14, label: o.label, title: o.title, pressed: o.get(), variant: 'tool', onChange: on => o.set(on) });
  b.setAttribute('aria-label', o.label);
  return { ...o, kind: 'toggle', el: b, pressed: o.get, run: () => o.set(!o.get()), sync: () => setPressed(b, o.get()) };
}

/** An action command: `iconOnly` drops the visible label at every width. */
function actionCmd(o) {
  const b = button({ icon: o.icon, iconSize: 14, label: o.iconOnly ? undefined : o.label, title: o.title, size: 'sm', variant: o.variant ?? 'tool', onClick: () => o.run() });
  b.dataset.cmd = 'action';
  b.setAttribute('aria-label', o.label);
  const entry = { ...o, kind: 'action', el: b };
  entry.sync = () => { b.disabled = o.disabled?.() ?? false; };
  return entry;
}

/** A radio menu of an entry's options. Options with a `color` get a swatch. */
function radioMenu(entry) {
  const items = entry.options();
  const cur = entry.current();
  const m = menu(items.map(x => ({ value: x.value, label: x.label, title: x.title, group: x.group, checked: x.value === cur })),
    { mode: 'radio', label: entry.label, onPick: v => entry.pick(v) });
  const rows = m.querySelectorAll('.menuitem');
  items.forEach((x, i) => { if (x.color) rows[i]?.querySelector('.label')?.before(swatch(x.color)); });
  return m;
}

/** A value picker in Films' select look: 'Label: value', bordered, as wide
 *  as its longest option. */
function selectCmd(o) {
  let opts = o.options;
  const s = select(opts, o.get(), v => o.set(v), { size: 'sm', label: o.label, ariaLabel: o.label, title: o.title });
  s.dataset.cmd = 'select';
  s.classList.add('rselect');
  const entry = {
    ...o, kind: 'select', el: s,
    options: () => opts,
    current: o.get,
    pick: o.set,
    value: () => opts.find(x => x.value === o.get())?.label ?? '',
    sync: () => s.set(o.get()),
    setOptions(next) { opts = next; s.setOptions(next); },
  };
  entry.menu = () => radioMenu(entry);
  return entry;
}

/** A command that opens a menu or a panel, with an accent badge while it
 *  holds a value (Films dropCommand): one or two characters are printed,
 *  longer values leave a marker and go to the name and tooltip. An
 *  `o.disabled()` that holds turns the button off. */
function dropCmd(o) {
  const b = button({ icon: o.icon, iconSize: 14, label: o.label, size: 'sm', variant: 'tool' });
  b.dataset.cmd = 'drop';
  b.classList.add('rdrop');
  const mark = el('span', { class: 'rbadge', 'aria-hidden': 'true', hidden: true });
  b.append(mark);
  const entry = { ...o, kind: 'drop', el: b };
  entry.menu = o.panel ?? (() => radioMenu(entry));
  dropdown(b, () => entry.menu(), { align: 'start' });
  entry.sync = () => {
    const v = o.badge();
    const short = v && v.length <= 2 ? v : '';
    setAttr(mark, 'hidden', !v);
    setText(mark, short);
    setAttr(mark, 'data-count', Boolean(short));
    setAttr(b, 'aria-label', v ? `${o.label}, ${v}` : o.label);
    setAttr(b, 'title', v ? `${o.title} Now: ${v}.` : o.title);
    b.disabled = o.disabled?.() ?? false;
  };
  entry.sync();
  return entry;
}

/** A captioned group: a full-height column closed by a hairline. */
function group(caption, ...cmds) {
  const g = el('div', { class: 'rgroup', role: 'group', 'aria-label': caption, dataset: { key: caption.toLowerCase() } },
    el('div', { class: 'rcmds' }, ...cmds.map(c => c.el)),
    el('div', { class: 'rcaption', 'aria-hidden': 'true' }, caption));
  return { key: caption.toLowerCase(), caption, el: g, cmds };
}

const VIEW_OPTIONS = [
  { value: 'tactical', label: 'Tactical', title: 'Players and spawn pads.' },
  { value: 'all', label: 'All entities', title: 'Every object the server reports.' },
  { value: 'players', label: 'Players', title: 'Players only.' },
  { value: 'pads', label: 'Spawn pads', title: 'Spawn pads only.' },
];

// Four turns, a quarter apart, so any map can be shown the way its players
// know it.
const ORIENTATION_OPTIONS = [
  { value: 'auto', label: 'Auto', title: "The map's longer side along the screen's longer side." },
  { value: 'y', label: 'Y up', title: 'The world Y axis points up the screen.' },
  { value: 'x', label: 'X up', title: 'The world X axis points up the screen, a quarter turn left of Y up.' },
  { value: '-y', label: 'Y down', title: 'The world Y axis points down the screen, a half turn from Y up.' },
  { value: '-x', label: 'X down', title: 'The world X axis points down the screen, a quarter turn right of Y up.' },
];

const HEIGHT_OPTIONS = [
  { value: 'all', label: 'All floors', title: 'Draw every floor.' },
  { value: 'player', label: 'Follow focus', title: "Draw the floors at the focused player's height." },
  { value: 'slice', label: 'Slice', title: 'Draw the floors at a height you set.' },
];

/** The Elevation panel: the floor mode as an embedded radio menu over the
 *  slice slider and its readout in metres. Built once and
 *  updated in place, so dragging the slider never rebuilds it. */
function elevationPanel() {
  const menuSlot = el('div');
  const range = el('input', { type: 'range', class: 'ch-range', min: '0', max: '100', step: '1', 'aria-label': 'Slice height' });
  const readout = fixed(['000 m', 'Unknown'], 'ch-elev-value num');
  range.addEventListener('input', () => setView({ heightMode: 'slice', elevation: Number(range.value) }));
  const content = el('div', { class: 'ch-elev' }, menuSlot,
    el('div', { class: 'ch-elev-range' },
      el('div', { class: 'ch-elev-head' }, el('span', { class: 'caps' }, 'Height'), readout.el),
      range));
  // A pick keeps the panel open (the slider is next). Escape still closes
  // it through the dropdown's own key handler.
  content.addEventListener(MENU_CLOSE, e => e.stopPropagation());
  let shown = null;
  return {
    content,
    sync() {
      const v = state.view;
      const g = state.geometry;
      if (v.heightMode !== shown) {
        const had = menuSlot.contains(document.activeElement);
        shown = v.heightMode;
        menuSlot.replaceChildren(menu(HEIGHT_OPTIONS.map(x => ({ ...x, checked: x.value === v.heightMode })),
          { mode: 'radio', embedded: true, label: 'Elevation', onPick: val => setView({ heightMode: val }) }));
        if (had) menuSlot.querySelector('[aria-checked=true]')?.focus();
      }
      const ready = g.status === 'ready';
      range.disabled = !ready;
      range.min = String(ready ? g.zMin : 0);
      range.max = String(ready ? g.zMax : 100);
      const h = elevationValue(v, state.snapshot);
      const at = v.heightMode === 'player' && h !== null ? h : v.elevation;
      if (document.activeElement !== range || v.heightMode !== 'slice') range.value = String(Math.round(at));
      const lo = Number(range.min), hi = Number(range.max);
      range.style.setProperty('--fill', `${hi > lo ? ((Number(range.value) - lo) / (hi - lo)) * 100 : 0}%`);
      readout.set(v.heightMode === 'player' && h === null ? 'Unknown' : ready || v.heightMode === 'player' ? metres(at) : '');
      readout.el.dataset.mode = v.heightMode;
    },
  };
}

const LABEL_OPTIONS = [
  { value: 'names', label: 'Names', title: 'Each player by name, on a tag above them.' },
  { value: 'numbers', label: 'Numbers', title: 'Each player by number, in their mark: the first team 1 to 4, the next 5 to 8, and so on. The roster, the legend and the broadcast strip show the same numbers.' },
];

const MARKER_OPTIONS = [
  { value: 'disc', label: 'Discs', title: 'A disc with a soft cone along the aim.' },
  { value: 'arrow', label: 'Arrows', title: 'A teardrop pointing along the aim, the number in its round end.' },
];

const FIRING_OPTIONS = [
  { value: 'lines', label: 'Lines', title: 'Short lines flare round a player who fires.' },
  { value: 'trace', label: 'Lines and trace', title: 'The lines, and a dashed line along the aim to the first player in its way.' },
  { value: 'off', label: 'Off', title: 'Nothing shows when a player fires.' },
];

/** What the Markers command says has changed from the layout's own look:
 *  'Numbers, Arrows', or null while nothing has. */
function markersText() {
  const v = state.view;
  const own = labelMode({ ...v, labels: null });
  const parts = [];
  if (labelMode(v) !== own) parts.push(LABEL_OPTIONS.find(x => x.value === labelMode(v)).label);
  if (v.marker !== 'disc') parts.push(MARKER_OPTIONS.find(x => x.value === v.marker).label);
  if (v.firing === 'trace') parts.push('Shot traces');
  if (v.firing === 'off') parts.push('No shots');
  if (v.contrast) parts.push('High contrast');
  return parts.length ? parts.join(', ') : null;
}

/** The Markers panel: how players are marked on the map. Labels (names or
 *  numbers), the mark (discs or arrows), what a shot draws, and high
 *  contrast, each an embedded menu. Built once, rebuilt in place only when
 *  a value changes, keeping focus on the row that had it. */
function markersPanel() {
  const slot = el('div');
  const content = el('div', { class: 'ch-markers' }, slot);
  // A pick keeps the panel open, for the next one. Escape still closes it.
  content.addEventListener(MENU_CLOSE, e => e.stopPropagation());
  let shown = '';
  const radio = (caption, options, current, pick) =>
    menu(options.map(x => ({ ...x, group: caption, checked: x.value === current })),
      { mode: 'radio', embedded: true, label: caption, onPick: pick });
  return {
    content,
    sync() {
      const v = state.view;
      const key = [labelMode(v), v.marker, v.firing, v.contrast].join('|');
      if (key === shown) return;
      shown = key;
      const rows = () => [...slot.querySelectorAll('.menuitem')];
      const had = rows().indexOf(document.activeElement);
      slot.replaceChildren(
        radio('Labels', LABEL_OPTIONS, labelMode(v), val => setView({ labels: val })),
        radio('Markers', MARKER_OPTIONS, v.marker, val => setView({ marker: val })),
        radio('Shots', FIRING_OPTIONS, v.firing, val => setView({ firing: val })),
        menu([{ value: 'contrast', label: 'High contrast', group: 'Look', checked: v.contrast, title: 'Outline every mark in dark, so it stands out on any floor.' }],
          { mode: 'check', embedded: true, label: 'Look', onPick: (_, on) => setView({ contrast: on }) }));
      if (had >= 0) rows()[had]?.focus();
    },
  };
}

/** The Colors panel: per team, its colour and name, what it is set to,
 *  Reset (its own colour back), and Halo Infinite's sixteen team colours
 *  (teams.js) as swatches, in two rows of lighter and deeper pairs. Teams 1 and 2
 *  always, and any other team in the match. Under them the map floor's
 *  colour (floorcolor.js): the presets, and any colour from the picker.
 *  Built once and updated in place. The rows are rebuilt only when the
 *  teams change. */
function teamColorPanel() {
  const list = el('div', { class: 'ch-colors-list' });
  const floor = floorColorRow();
  const content = el('div', { class: 'ch-colors' }, list, floor.node,
    el('p', { class: 'ch-colors-note' }, 'Kept in the page address: give OBS the same address.'));
  const names = ['Default', ...TEAM_COLORS.map(c => c.name)];
  let shown = '';
  let rows = [];
  const teams = () => {
    const named = new Map(teamsOf(state.snapshot).map(t => [t.id, t.name]));
    return [...new Set([0, 1, ...named.keys()])]
      .filter(id => id >= 0 && id < COLORED_TEAMS).sort((a, b) => a - b)
      .map(id => ({ id, name: named.get(id) ?? `Team ${id + 1}` }));
  };
  const row = t => {
    const value = fixed(names, 'ch-colors-value');
    const reset = button({ label: 'Reset', size: 'sm', variant: 'ghost', title: `Give ${t.name} its own color back.`, onClick: () => setTeamColor(t.id, null) });
    const swatches = TEAM_COLORS.map(c => {
      const b = el('button', { type: 'button', class: 'ch-color', title: c.name, 'aria-label': `${t.name}: ${c.name}`, style: { '--swatch': c.hex } });
      b.addEventListener('click', () => setTeamColor(t.id, c.key));
      return { key: c.key, el: b };
    });
    const node = el('div', { class: 'ch-colors-team', role: 'group', 'aria-label': `${t.name} color` },
      el('div', { class: 'ch-colors-head' }, swatch(`var(--team-${t.id})`), el('span', { class: 'ch-colors-name truncate' }, t.name), value.el, reset),
      el('div', { class: 'ch-colors-grid' }, ...swatches.map(x => x.el)));
    return { id: t.id, node, value, reset, swatches };
  };
  return {
    content,
    sync() {
      const ts = teams();
      const key = JSON.stringify(ts);
      if (key !== shown) {
        shown = key;
        rows = ts.map(row);
        list.replaceChildren(...rows.map(r => r.node));
      }
      for (const r of rows) {
        const pick = state.teamColors[r.id] ?? null;
        r.value.set(teamColorByKey(pick)?.name ?? 'Default');
        r.reset.disabled = !pick;
        for (const x of r.swatches) setPressed(x.el, x.key === pick);
      }
      floor.sync();
    },
  };
}

/** What the floor's colour is called: its preset's name, 'Custom' and its
 *  hex, or 'Default'. */
const floorColorName = hex => (hex === null ? 'Default' : floorPresetOf(hex)?.name ?? `Custom ${hex}`);

/** The Colors panel's map floor row: a head like a team's (the colour, the
 *  name, what it is set to, Reset) over the presets and a picker for any
 *  other colour, one more swatch in the row. */
function floorColorRow() {
  const presets = FLOOR_COLORS.filter(c => c.hex);
  // Every hex letter's width, so a custom value never widens the slot.
  const value = fixed(['Default', ...presets.map(c => c.name), ...[...'0abcdef'].map(d => `Custom #${d.repeat(6)}`)], 'ch-colors-value');
  const reset = button({ label: 'Reset', size: 'sm', variant: 'ghost', title: 'Give the map floor its own color back.', onClick: () => setFloorColor(null) });
  const head = swatch('var(--hud-floor-high)');
  const swatches = presets.map(c => {
    const b = el('button', { type: 'button', class: 'ch-color', title: c.name, 'aria-label': `Map floor: ${c.name}`, style: { '--swatch': c.hex } });
    b.addEventListener('click', () => setFloorColor(c.key));
    return { hex: c.hex, el: b };
  });
  // The picker sits invisible over its swatch, so a click opens it and the
  // swatch shows the colour picked (a spectrum until there is one).
  const input = el('input', { type: 'color', class: 'ch-color-input', value: '#2f7fc1', title: 'Any color', 'aria-label': 'Map floor: any color' });
  input.addEventListener('input', () => setFloorColor(input.value));
  const custom = el('label', { class: 'ch-color ch-color-custom', title: 'Any color' }, input);
  const node = el('div', { class: 'ch-colors-team ch-colors-floor', role: 'group', 'aria-label': 'Map floor color' },
    el('div', { class: 'ch-colors-head' }, head, el('span', { class: 'ch-colors-name truncate' }, 'Map floor'), value.el, reset),
    el('div', { class: 'ch-colors-grid ch-colors-row' }, ...swatches.map(x => x.el), custom));
  return {
    node,
    sync() {
      const hex = state.floorColor;
      const preset = hex === null ? null : floorPresetOf(hex);
      value.set(floorColorName(hex));
      reset.disabled = hex === null;
      head.style.setProperty('--swatch', hex ?? 'var(--hud-floor-high)');
      for (const x of swatches) setPressed(x.el, x.hex === hex);
      const own = hex !== null && !preset;
      custom.toggleAttribute('data-pressed', own);
      if (own) {
        custom.style.setProperty('--swatch', hex);
        if (document.activeElement !== input) input.value = hex;
      } else {
        custom.style.removeProperty('--swatch');
      }
    },
  };
}

/** Download the floor plan as a PNG `long` px on its longer side (map.js
 *  floorImage), named after the map. */
async function saveFloorImage(long) {
  const image = floorImage(long);
  if (!image) return;
  const blob = await new Promise(resolve => image.canvas.toBlob(resolve, 'image/png'));
  if (!blob) { console.error(`Could not encode a ${long} px floor plan image.`); return; }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `${image.name}.png`, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function mountRibbon(root) {
  const view = () => state.view;
  const zoomBy = k => setView({ zoom: view().zoom * k });

  // View: what the map draws and how it is framed.
  const floor = toggleCmd({ key: 'floor', icon: 'geometry', label: 'Floor plan', title: "Draw the level's floor plan under the map.", get: () => view().floor, set: on => setView({ floor: on }) });
  const objectives = toggleCmd({ key: 'objectives', icon: 'objectives', label: 'Objectives', title: "Draw the mode's flags, hills and zones.", get: () => view().objectives, set: on => setView({ objectives: on }) });
  const autoFit = toggleCmd({ key: 'framing', icon: 'scan', label: 'Auto fit', title: 'Keep every player in view as they move.', get: () => view().framing === 'auto', set: on => setView({ framing: on ? 'auto' : 'locked' }) });
  const zoomOut = actionCmd({ key: 'zoomOut', icon: 'zoomOut', label: 'Zoom out', title: 'Zoom out.', iconOnly: true, run: () => zoomBy(1 / ZOOM_STEP), disabled: () => view().zoom <= 0.5 });
  const zoomIn = actionCmd({ key: 'zoomIn', icon: 'zoomIn', label: 'Zoom in', title: 'Zoom in.', iconOnly: true, run: () => zoomBy(ZOOM_STEP), disabled: () => view().zoom >= 5 });
  const zoomText = () => `${view().zoom.toFixed(1)}×`;
  const zoomFx = fixed(['0.0×'], 'num');
  const zoomValue = actionCmd({ key: 'zoom', icon: 'search', label: 'Reset zoom', title: 'Reset the zoom to 1×.', run: () => setView({ zoom: 1 }), value: zoomText });
  // In the bar it is the readout itself ('1.4×'). The icon and the label
  // 'Reset zoom' are for the More menu and the phone sheet.
  zoomValue.el.replaceChildren(el('span', { class: 'label' }, zoomFx.el));
  zoomValue.el.classList.add('zoom-value');
  const filter = selectCmd({ key: 'filter', label: 'View', title: 'What the map shows.', options: VIEW_OPTIONS, get: () => view().filter, set: v => setView({ filter: v }) });

  // Players: trails and the followed player.
  const trails = toggleCmd({ key: 'trails', icon: 'paths', label: 'Trails', title: 'Draw where each player has been.', get: () => view().trails, set: on => setView({ trails: on }) });
  const vitals = toggleCmd({ key: 'vitals', icon: 'vitals', label: 'Vitals', title: 'Show health and shield under map markers.', get: () => view().vitals, set: on => setView({ vitals: on }) });
  const focusOptions = () => {
    // Grouped as the roster groups them: teams, then no team, then observers.
    const rank = p => (p.observer ? 1001 : p.team ?? 1000);
    const players = (state.snapshot?.players ?? []).slice().sort((a, b) => rank(a) - rank(b) || a.slot - b.slot);
    const groupOf = p => (p.observer ? 'Observers'
      : p.team_name || (p.team !== null && p.team !== undefined ? `Team ${p.team + 1}` : 'No team'));
    return [{ value: '', label: 'None', title: 'Follow nobody.' },
      ...players.map(p => ({ value: p.handle, label: playerLabel(p), group: groupOf(p) }))];
  };
  const focused = () => {
    const p = view().focus ? state.snapshot?.players.find(x => x.handle === view().focus) : null;
    return p ? playerLabel(p) : null;
  };
  const focus = dropCmd({
    key: 'focus', icon: 'follow', label: 'Focus', title: 'Keep the map on one player.',
    options: focusOptions, current: () => view().focus ?? '', pick: v => setView({ focus: v || null }),
    value: () => focused() ?? 'None', badge: focused,
  });
  const look = markersPanel();
  const markers = dropCmd({
    key: 'markers', icon: 'markers', label: 'Markers', title: 'How players are marked on the map: names or numbers, discs or arrows, shots, contrast.',
    value: () => markersText() ?? 'Default', badge: markersText,
    panel: () => {
      look.sync();
      return el('div', { class: 'panel-float ch-markers-pop' }, look.content);
    },
  });
  const palette = teamColorPanel();
  const colorText = () => {
    const picks = Object.entries(state.teamColors).sort(([a], [b]) => a - b);
    const named = new Map(teamsOf(state.snapshot).map(t => [t.id, t.name]));
    const parts = picks.map(([id, key]) => `${named.get(Number(id)) ?? `Team ${Number(id) + 1}`} ${teamColorByKey(key)?.name}`);
    if (state.floorColor !== null) parts.push(`Floor ${floorColorName(state.floorColor)}`);
    return parts.length ? parts.join(', ') : null;
  };
  const colors = dropCmd({
    key: 'colors', icon: 'colors', label: 'Colors', title: "Each team's color, from Halo Infinite's team colors, and the map floor's.",
    value: () => colorText() ?? 'Default', badge: colorText,
    panel: () => {
      palette.sync();
      return el('div', { class: 'panel-float ch-colors-pop' }, palette.content);
    },
  });

  // Map: which floor plan, which way up, which floors.
  const level = selectCmd({ key: 'level', icon: 'map', label: 'Map', title: 'Which floor plan to draw: the map in play, or one picked here.', options: [{ value: 'auto', label: 'Automatic', title: 'The floor plan of the map in play.' }], get: () => view().level, set: v => setView({ level: v }) });
  level.el.classList.add('rselect-map');
  const orientation = selectCmd({ key: 'orientation', icon: 'orientation', label: 'Orientation', title: 'Which world axis points up the screen.', options: ORIENTATION_OPTIONS, get: () => view().orientation, set: v => setView({ orientation: v }) });
  const data = toggleCmd({ key: 'data', icon: 'data', label: 'Data', title: 'Draw what each part of the floor is (floor, stairs, ramps, ledges, ground), read from the map data, to check it. Not for a broadcast.', get: () => view().data, set: on => setView({ data: on }) });
  const elev = elevationPanel();
  const heightText = () => {
    const v = view();
    if (v.heightMode === 'all') return null;
    const h = elevationValue(v, state.snapshot);
    return v.heightMode === 'slice' ? `Slice at ${metres(h)}` : h === null ? 'Follow focus' : `Follow focus at ${metres(h)}`;
  };
  const elevation = dropCmd({
    key: 'elevation', icon: 'elevation', label: 'Elevation', title: 'Which floors the map draws.',
    value: () => HEIGHT_OPTIONS.find(x => x.value === view().heightMode)?.label ?? '',
    badge: heightText,
    panel: () => {
      elev.sync();
      return el('div', { class: 'panel-float ch-elev-pop' }, elev.content);
    },
  });

  // Filter: one team. Clear is always there so the bar keeps its width.
  const teamName = () => (view().team === null ? null : teamsOf(state.snapshot).find(t => t.id === view().team)?.name ?? `Team ${view().team + 1}`);
  const team = dropCmd({
    key: 'team', icon: 'players', label: 'Team', title: 'Show one team only.',
    options: () => [{ value: '', label: 'All teams', title: 'Show every team.' },
      ...teamsOf(state.snapshot).filter(t => t.players.length).map(t => ({ value: String(t.id), label: t.name, color: `var(--team-${((t.id % 8) + 8) % 8})` }))],
    current: () => (view().team === null ? '' : String(view().team)),
    pick: v => setView({ team: v === '' ? null : Number(v) }),
    value: () => teamName() ?? 'All teams', badge: teamName,
  });
  const clear = actionCmd({ key: 'clear', icon: 'x', label: 'Clear', title: 'Show every team again.', variant: 'ghost', run: () => setView({ team: null }), disabled: () => view().team === null });

  // Export: the floor plan alone as an image, for a stream's graphics or a
  // Forge map's portfolio, at a size picked from the menu.
  let saving = false;
  const sizes = () => IMAGE_SIZES.map(px => ({ value: px, label: `${px} px`, title: `${px} px on the longer side.` }));
  const saveImage = dropCmd({
    key: 'image', icon: 'image', label: 'Save image',
    title: 'Save the floor plan alone as a PNG with a transparent background, at the elevation and in the colors shown.',
    options: sizes, current: () => null, badge: () => null,
    disabled: () => saving || state.geometry.status !== 'ready',
    pick: px => {
      saving = true;
      saveImage.sync();
      void saveFloorImage(px).finally(() => { saving = false; saveImage.sync(); });
    },
    panel: () => menu(sizes(), { mode: 'action', label: 'Save image', onPick: px => saveImage.pick(px) }),
  });

  const groups = [
    group('View', floor, objectives, autoFit, zoomOut, zoomValue, zoomIn, filter),
    group('Players', trails, vitals, markers, focus, colors),
    // Filter before Map: Map is set once a match and is the widest group.
    // Export comes after it, as in Films, and Check, the data view for
    // checking the map data, last, so they fold into More first, then Map.
    group('Filter', team, clear),
    group('Map', level, orientation, elevation),
    group('Export', saveImage),
    group('Check', data),
  ];
  const entries = groups.flatMap(g => g.cmds);
  const wrap = el('div', { class: 'rgroups' }, ...groups.map(g => g.el));

  // More: the folded groups' commands, in a column built like a group.
  const more = button({ label: 'More', title: 'Commands that do not fit.', size: 'sm', variant: 'tool' });
  dropdown(more, () => moreMenu(), { align: 'end' });
  const rend = el('div', { class: 'rend', hidden: true }, el('div', { class: 'rcmds' }, more), el('div', { class: 'rend-spacer' }));

  // Phones: [Layers] [Filter] open sheets. The View select stays in the bar.
  const filterMark = el('span', { class: 'rbadge', 'aria-hidden': 'true', hidden: true, dataset: { count: '' } });
  const layersBtn = button({ icon: 'geometry', label: 'Layers', size: 'sm', onClick: () => openList('Layers', groups.filter(g => g.key !== 'filter')) });
  const filterBtn = button({ icon: 'filter', label: 'Filter', size: 'sm', onClick: () => openList('Filter', groups.filter(g => g.key === 'filter')) });
  filterBtn.classList.add('rdrop');
  filterBtn.append(filterMark);
  const viewPhone = select(VIEW_OPTIONS, view().filter, v => setView({ filter: v }), { size: 'sm', label: 'View', ariaLabel: 'View', title: 'What the map shows.' });
  viewPhone.classList.add('rselect');
  const slot = el('div', { class: 'rsheet-slot' }, viewPhone);
  // Below 640 a select opens as a bottom sheet (Films dropdown on phones).
  slot.addEventListener('click', e => {
    if (!PHONE.matches || !viewPhone.contains(e.target)) return;
    e.stopPropagation();
    optionsSheet(filter);
  }, true);
  const sheetBar = el('div', { class: 'rsheet' }, el('div', { class: 'rsheet-cmds' }, layersBtn, filterBtn), slot);

  root.replaceChildren(wrap, sheetBar, rend);

  function moreMenu() {
    const items = [];
    const targets = [];
    for (const g of groups.filter(x => x.el.dataset.overflow)) {
      for (const c of g.cmds) {
        items.push({
          value: targets.length, label: c.label, icon: c.icon, group: g.caption, title: c.title,
          checked: c.kind === 'toggle' ? c.pressed() : undefined,
          hint: c.value?.() || undefined, disabled: c.disabled?.() ?? false,
        });
        targets.push(c);
      }
    }
    return menu(items, {
      mode: 'action', label: 'More',
      onPick: i => {
        const c = targets[i];
        if (!c) return;
        if (c.kind === 'toggle' || c.kind === 'action') c.run();
        // After the More menu has closed and given focus back.
        else setTimeout(() => popover(more, c.menu()), 0);
      },
    });
  }

  /** Phones: every command of `gs` as a 44px row (Films openList). */
  function openList(title, gs) {
    const list = el('div', { class: 'ch-list' });
    const paints = [];
    for (const g of gs) {
      list.append(el('div', { class: 'caps ch-cap' }, g.caption));
      for (const c of g.cmds) {
        if (c === filter) continue; // in the bar itself
        const pick = c.kind === 'select' || c.kind === 'drop';
        const repeats = c.title.replace(/\.$/, '').toLowerCase() === c.label.toLowerCase();
        const r = sheetRow({ icon: c.icon, label: c.label, sub: repeats ? null : c.title, value: c.value ? c.value() : undefined, caret: pick });
        const paint = () => {
          if (c.kind === 'toggle') setPressed(r.el, c.pressed());
          if (r.value) setText(r.value, c.value());
          r.el.disabled = c.disabled?.() ?? false;
        };
        paint();
        paints.push(paint);
        r.el.addEventListener('click', () => {
          if (!pick) { c.run(); paints.forEach(p => p()); return; }
          if (c === elevation) { sheet('Elevation', elev.content); elev.sync(); return; }
          if (c === colors) { sheet('Colors', palette.content); palette.sync(); return; }
          if (c === markers) { sheet('Markers', look.content); look.sync(); return; }
          optionsSheet(c);
        });
        list.append(r.el);
      }
    }
    sheet(title, list);
  }

  /** Phones: an entry's options as radio rows in a sheet of their own. */
  function optionsSheet(c) {
    const list = el('div', { class: 'ch-list', role: 'menu', 'aria-label': c.label });
    const cur = c.current();
    let caption;
    for (const x of c.options()) {
      if (x.group !== caption) {
        caption = x.group;
        if (caption) list.append(el('div', { class: 'caps ch-cap' }, caption));
      }
      const on = x.value === cur;
      const r = sheetRow({ icon: on ? 'check' : null, color: x.color, label: x.label, sub: x.title, role: 'menuitemradio' });
      r.el.setAttribute('aria-checked', String(on));
      r.el.addEventListener('click', () => { c.pick(x.value); s.close(); });
      list.append(r.el);
    }
    const s = sheet(c.label, list);
  }

  // Width modes (Films ribbon): full with captions from 1180, compact from
  // 900, icon-only toggles from 640, sheet below. Groups that overflow fold
  // right to left into More (never View), recomputed from scratch.
  const modeFor = w => (w >= 1180 ? 'full' : w >= 900 ? 'compact' : w >= 640 ? 'icons' : 'sheet');
  let mode = null;
  const overflowing = () => wrap.scrollWidth > wrap.clientWidth + 1;
  function layout() {
    for (const g of groups) {
      if (g.el.dataset.overflow) { delete g.el.dataset.overflow; g.el.hidden = false; }
    }
    rend.hidden = true;
    if (mode === 'sheet' || !overflowing()) return;
    rend.hidden = false;
    for (let i = groups.length - 1; i > 0 && overflowing(); i--) {
      groups[i].el.dataset.overflow = '1';
      groups[i].el.hidden = true;
    }
  }
  function applyMode(m) {
    mode = m;
    root.dataset.mode = m;
    layout();
  }
  applyMode(modeFor(root.clientWidth));
  new ResizeObserver(() => {
    const m = modeFor(root.clientWidth);
    if (m !== mode) applyMode(m); else layout();
  }).observe(root);

  return changed => {
    const v = view();
    if (changed.has('view')) {
      for (const c of entries) c.sync?.();
      viewPhone.set(v.filter);
      zoomFx.set(zoomText());
      filterMark.hidden = v.team === null;
      setText(filterMark, v.team === null ? '' : '1');
      filterBtn.setAttribute('aria-label', v.team === null ? 'Filter' : 'Filter, 1 active');
    } else if (changed.has('snapshot')) {
      focus.sync();
      team.sync();
      elevation.sync();
      colors.sync();
    }
    if (changed.has('teamColors') || changed.has('floorColor')) colors.sync();
    if (changed.has('geometry')) saveImage.sync();
    if (changed.has('levels')) {
      level.setOptions([
        { value: 'auto', label: 'Automatic', title: 'The floor plan of the map in play.' },
        // Only levels with a real title. The rest carry their internal name.
        ...state.levels.filter(l => l.floor_available && l.title && l.title !== l.name && l.title !== l.id)
          .sort((a, b) => a.title.localeCompare(b.title))
          .map(l => ({ value: l.id, label: l.title, group: 'Catalogue' })),
      ]);
      level.sync();
      layout();
    }
    if (elev.content.isConnected && (changed.has('view') || changed.has('snapshot') || changed.has('geometry'))) elev.sync();
    if (palette.content.isConnected && (changed.has('teamColors') || changed.has('floorColor') || changed.has('snapshot'))) palette.sync();
    if (look.content.isConnected && changed.has('view')) look.sync();
  };
}

// ── Live bar ────────────────────────────────────────────────────────────

/** What the freshness readout can say, for its fixed width. */
const FRESH_TEMPLATES = ['Updated 00 s ago', 'Updated 00 min ago', 'No update for 00 s', 'No update for 00 min'];

/** The feed's state word with its dot (the masthead tag's word, drawn by
 *  CSS in one slot as wide as the longest word, the dot in the tone) and
 *  the pause toggle: the live bar's, and on phones the panel sheet's head.
 *  `variant` is the pause button's ('secondary' in the bar, 'ghost' in the
 *  sheet). Returns { words, status, pause, paint() }. */
export function feedControls(variant = 'secondary') {
  const pause = button({ icon: 'pause', size: 'sm', variant, title: 'Pause the feed. Space.', onClick: () => setView({ paused: !state.view.paused }) });
  pause.setAttribute('aria-label', 'Pause the feed');
  setPressed(pause, false);
  const words = stack(FEED_WORDS, 'live-state');
  const status = el('span', { class: 'sr-only', role: 'status' });
  let paused = null;
  return {
    words: words.el,
    status,
    pause,
    paint() {
      const p = state.view.paused;
      if (p !== paused) {
        paused = p;
        setPressed(pause, p);
        pause.querySelector('.icon')?.replaceWith(icon(p ? 'play' : 'pause', 12));
        pause.title = p ? 'Resume the feed. Space.' : 'Pause the feed. Space.';
        pause.setAttribute('aria-label', p ? 'Resume the feed' : 'Pause the feed');
      }
      const f = feedTag(state);
      words.set(f.text);
      setAttr(words.el, 'data-tone', f.tone);
      setAttr(words.el, 'data-busy', Boolean(f.busy));
      setText(status, f.text);
    },
  };
}

function mountLivebar(root) {
  const feed = feedControls();
  const clock = fixed(['00:00'], 'live-clock num');
  clock.el.title = 'Elapsed';
  const left = fixed(['00:00 left'], 'live-left num hide-sm');
  left.el.title = 'Time left in the round.';
  const fresh = fixed(FRESH_TEMPLATES, 'live-fresh num');
  // Left the transport and the clocks, right the feed: how fresh it is,
  // then its state, which stays at the bar's right edge (the freshness
  // grows leftward from it when it has something to say).
  root.replaceChildren(feed.pause, clock.el, left.el, el('span', { class: 'spacer' }), fresh.el, feed.words, feed.status);

  // Space pauses and resumes while nothing has the focus.
  document.addEventListener('keydown', e => {
    if (e.key !== ' ' || e.repeat || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target !== document.body && e.target !== document.documentElement) return;
    if (state.view.layout !== 'operator') return;
    e.preventDefault();
    setView({ paused: !state.view.paused });
  });

  return () => {
    shown(root, state.view.layout === 'operator');
    feed.paint();

    const m = state.snapshot?.match_info;
    clock.set(clockText(m?.elapsed_seconds) ?? '');
    const t = m?.round_timer;
    const playing = state.snapshot?.life_cycle === 9;
    const remaining = playing && t && t.start_seconds > 0 && t.seconds_left > 0 ? fmt.clock(t.seconds_left) : null;
    left.set(remaining ? `${remaining} left` : '');

    const age = state.age;
    const trouble = state.feed === 'stale' || state.feed === 'error' || state.feed === 'waiting';
    // A healthy feed says nothing here (the state word says it). The age
    // shows once updates fall a second behind, or while paused.
    fresh.set(age === null ? '' : trouble ? `No update for ${since(age)}` : age >= 1 ? `Updated ${since(age)} ago` : '');
    setAttr(fresh.el, 'data-tone', trouble && age !== null ? 'warn' : null);
    // Before the first snapshot there is no age at all: the slot goes, so
    // the state word keeps to the edge.
    shown(fresh.el, age !== null);
  };
}

// ── Mount ───────────────────────────────────────────────────────────────

/** Fill the app bar, masthead, ribbon and live bar. */
export function mount({ appbar, masthead, ribbon, livebar }) {
  mountAppbar(appbar);
  const paintMast = mountMasthead(masthead);
  const paintRibbon = mountRibbon(ribbon);
  const paintLive = mountLivebar(livebar);
  paintMast();
  paintRibbon(new Set(['snapshot', 'view', 'levels', 'geometry', 'teamColors', 'floorColor']));
  paintLive();
  subscribe(changed => {
    const any = (...keys) => keys.some(k => changed.has(k));
    if (any('snapshot', 'feed', 'feedError', 'geometry')) paintMast();
    if (any('snapshot', 'view', 'levels', 'geometry', 'teamColors', 'floorColor')) paintRibbon(changed);
    if (any('snapshot', 'feed', 'age', 'view')) paintLive();
  });
}
