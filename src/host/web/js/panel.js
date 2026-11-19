// The side panel and the legend bar (Films viewer sidebar and legend.ts).
//
// Side panel (#panel): compact tabs over three panes. Players is the
// scoreboard: a sticky column head, each team under its band (3px rule,
// name, score, how many are alive), a row per player (colour, name, Bot or
// Observer, K D A, with dead rows faint). Timers lists the spawn pads as feed
// rows (item icon, name, category and cycle, the countdown, a 2px progress
// line while incoming). Selection is the selected target's card (Films
// playerCard): who or what, its numbers, its details, the raw record.
// While the map numbers players (state.js numbered()), a player's colour
// square in the roster and the legend carries their number. The observed
// player's square is ringed in white, as their mark is on the map.
//
// Below 640px the panel is a persistent bottom sheet (Films sheet): a 44px
// peek with the tab's label, count and key line. The handle cycles peek,
// half and full, a drag snaps to the nearest, a tap away or Escape
// collapses it to the peek.
//
// Legend (#legend): one 36px row of team groups, each a header that shows
// only that team and a chip per player (colour, name, K-D, shield and
// health along its foot) that follows the player.
//
// A target picked on the map or in the legend brings Selection forward.
// Clearing it (Escape, the card's Close, an empty spot on the map) goes
// back to the tab it came from. A row picked in a list is selected in
// place. Rows and chips are kept by handle and updated in place, so focus,
// hover and scroll survive the 4 Hz refresh.

import { state, setView, select, hover, subscribe, selectedRecord, focusedPlayer, numbered, numberedPlayer } from './state.js';
import { el, icon, setText, setAttr, kvGrid, teamAttr, emptyState, skel, tag, setTag, stateDot, caps, fmt } from './dom.js';
import { button, iconButton, tabs } from './controls.js';
import { itemIcon } from './atlas.js';
import { teamEmblem } from './teams.js';
import { feedControls } from './chrome.js';
import {
  playerLabel, teamsOf, rosterPlayers, padLabel, padTimer, spawnLogicText, isPlayer, isPad,
  targetOf, sameTarget, phaseOf, recordTitle, feedTag, objectiveMode, playerNumbers,
} from './model.js';

const PHONE = matchMedia('(max-width: 639px)');
/** The sheet's peek height and the room it leaves above at full, px. */
const PEEK = 44;
const SHEET_TOP = 56;

// ── Formatting ──────────────────────────────────────────────────────────

/** What a pad's value column shows: { kind: count|ready|tag|word, text,
 *  title? }. Tags are short so the column keeps one width, and the longer
 *  note is the tag's tooltip. */
function padValue(t) {
  if (t.state === 'incoming' && Number.isFinite(t.remaining)) return { kind: 'count', text: fmt.countdown(t.remaining) };
  if (t.state === 'ready') return { kind: 'ready', text: 'Ready' };
  if (t.state === 'restricted') return { kind: 'tag', text: 'Restricted', title: 'The mode keeps this pad from spawning.' };
  if (t.note) return { kind: 'tag', text: 'Unknown', title: `${t.note}.` };
  return { kind: 'word', text: t.state === 'unknown' ? '' : fmt.words(t.state) };
}

/** A pad's second line: 'Weapon, respawns every 30 s'. */
const padSub = t => [fmt.words(t.category), t.cycle ? `respawns every ${Math.round(t.cycle)} s` : ''].filter(Boolean).join(', ');

/** Every pad with its timer in one fixed order for the whole match:
 *  weapons, then equipment, each by name, the handle breaking ties. A
 *  countdown or a state change never moves a row. */
function padsInOrder(snapshot) {
  const rank = t => (t.category === 'weapon' ? 0 : 1);
  return (snapshot?.objects ?? []).filter(isPad).map(pad => ({ pad, t: padTimer(pad) }))
    .sort((a, b) => rank(a.t) - rank(b.t)
      || padLabel(a.pad).localeCompare(padLabel(b.pad))
      || a.pad.handle.localeCompare(b.pad.handle));
}

/** The incoming pad that spawns soonest (with a known countdown), or null. */
function nextPad(pads) {
  let best = null;
  for (const x of pads) {
    if (x.t.state !== 'incoming' || !Number.isFinite(x.t.remaining)) continue;
    if (!best || x.t.remaining < best.t.remaining) best = x;
  }
  return best;
}

/** Players by slot, the order they keep in every list. */
const bySlot = (a, b) => a.slot - b.slot || a.handle.localeCompare(b.handle);

/** A player's team for the colour hooks: null for observers and no team. */
const teamOfPlayer = p => (p.observer || p.team === null || p.team === undefined ? null : p.team);

/** The match phase decides what alive means: only a live match has dead
 *  players (the lobby and post-match carry stale flags). */
const matchLive = snapshot => phaseOf(snapshot?.life_cycle) === 'Match live';

/** Kills hyphen deaths ('3-11', Films legend), or ''. */
const kd = p => (p.stats && Number.isFinite(p.stats.kills) && Number.isFinite(p.stats.deaths) ? `${p.stats.kills}-${p.stats.deaths}` : '');

/** True when the mode keeps a score apart from kills (objective modes). */
const scoreCounts = players => players.some(p => Number.isFinite(p.stats?.objective_score) && p.stats.objective_score !== p.stats.kills);

/** Whether the roster has a Score column: always in an objective mode, else
 *  once any score has differed from its kills. Once there it stays for the
 *  match, so the columns beside it never jump. */
let scoreEpoch = -1;
function scoreColumn(snapshot) {
  if (objectiveMode(snapshot, state.objectives.objects) !== null || scoreCounts(snapshot?.players ?? [])) scoreEpoch = state.epoch;
  return scoreEpoch === state.epoch;
}

// ── DOM helpers ─────────────────────────────────────────────────────────

/** Put `nodes` in `parent` in order, moving only what is out of place. */
function reorder(parent, nodes) {
  let at = parent.firstChild;
  for (const n of nodes) {
    if (n === at) { at = at.nextSibling; continue; }
    parent.insertBefore(n, at);
  }
  while (at) { const next = at.nextSibling; at.remove(); at = next; }
}

/** reorder() that keeps keyboard focus on the element that had it. */
function reorderKeepFocus(parent, nodes) {
  const focused = document.activeElement;
  reorder(parent, nodes);
  if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
}

/** Give a node its team's colour (data-team), writing only on change. */
function setTeam(node, team) {
  const want = Number.isInteger(team) ? String(((team % 8) + 8) % 8) : 'none';
  if (node.dataset.team !== want) teamAttr(node, team);
}

/** A fill scaled to a 0..1 value (transform only, so nothing reflows).
 *  Without one it is empty (data-empty, scale 0), and data-over above 1. */
function setBar(fill, v) {
  const ok = Number.isFinite(v);
  setAttr(fill, 'data-empty', ok ? null : true);
  setAttr(fill, 'data-over', ok && v > 1 ? true : null);
  const s = `scaleX(${ok ? Math.max(0, Math.min(1, v)).toFixed(3) : 0})`;
  if (fill.style.transform !== s) fill.style.transform = s;
}

/** Show or hide a node without changing any box (visibility). */
function setShown(node, on) {
  setAttr(node, 'data-off', on ? null : true);
}

/** Copy text: the clipboard API where the page may use it (localhost),
 *  else the old selection route (a LAN address is not a secure context). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea', { style: { position: 'fixed', top: '0', left: '0', opacity: '0' }, 'aria-hidden': 'true' });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

/** Films copyValue's button: ghost xs, a green check for a moment after a
 *  copy, a red x when the clipboard refuses. `value` is read at click. */
function copyButton(name, value) {
  const title = `Copy the ${name}.`;
  const b = button({ icon: 'copy', title, size: 'xs', variant: 'ghost', class: 'copy-btn' });
  let timer;
  b.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyText(value());
    b.replaceChildren(icon(ok ? 'check' : 'x', 11));
    b.dataset.copied = ok ? 'ok' : 'err';
    b.title = ok ? 'Copied.' : 'Copy failed. Select the text and copy it.';
    clearTimeout(timer);
    timer = setTimeout(() => {
      b.replaceChildren(icon('copy', 11));
      delete b.dataset.copied;
      b.title = title;
    }, ok ? 1200 : 2500);
  });
  return b;
}

/** A Films statStrip with values to fill in later: { el, values }. */
function statStrip(cells) {
  const strip = el('div', { class: 'stat-strip', style: { '--n': String(cells.length) } });
  const values = cells.map(c => {
    const v = el('div', { class: 'stat-value num truncate' });
    strip.append(el('div', { class: 'stat', title: c.title }, v, el('div', { class: 'caps truncate' }, c.label)));
    return v;
  });
  return { el: strip, values };
}

/** A Films band: a CAPS caption over its content, a hairline above. */
const band = (title, ...kids) => el('section', { class: 'band' }, el('h3', { class: 'caps' }, title), ...kids);

/** What an empty list says: the feed's own line while there is no
 *  snapshot (feedTag, so every view says it the same way), 'Waiting for a
 *  match' in the lobby and while loading, else `empty`. */
function emptyTitle(empty) {
  if (!state.snapshot) return feedTag(state).line ?? empty;
  const phase = phaseOf(state.snapshot.life_cycle);
  return phase === 'Match live' || phase === 'Post-match' ? empty : 'Waiting for a match';
}

/** The placeholder a list shows while there is nothing to list: skeleton
 *  rows while connecting, else an empty state. */
function placeholder(iconName, empty) {
  if (!state.snapshot && state.feed === 'connecting') {
    return el('div', { class: 'pane-skel', 'aria-hidden': 'true' },
      ...[64, 48, 72, 56, 40, 60].map(w => el('div', { class: 'skel-row' }, skel(8, 8), skel(`${w}%`, 10))));
  }
  return emptyState({ icon: iconName, title: emptyTitle(empty) });
}

// ── Roster (Players tab) ────────────────────────────────────────────────

function mountRoster(pane, pick, collapse) {
  const head = el('div', { class: 'roster-head', 'aria-hidden': 'true' },
    caps('Player'), caps('K', { title: 'Kills' }), caps('D', { title: 'Deaths' }), caps('A', { title: 'Assists' }),
    caps('Score', { class: 'col-score' }),
    caps('Life', { title: 'Average life, over the completed lives the observer saw' }));
  // Each row is the same height in every state: the status slot (following,
  // dead) is a fixed column whose icons only turn visible, and the vitals
  // tracks (phones) are always drawn, empty without a reading.
  const list = el('div', { class: 'roster-list' });
  pane.classList.add('roster');
  pane.append(head, list);
  const rows = new Map();
  const bands = new Map();
  let holder = '';

  const makeRow = handle => {
    const name = el('span', { class: 'name truncate' });
    const ptag = el('span', { class: 'ptag', hidden: true });
    const eye = icon('follow', 12);
    eye.classList.add('rs-follow');
    const skull = icon('skull', 12);
    skull.classList.add('rs-dead');
    const status = el('span', { class: 'rstatus', 'aria-hidden': 'true' }, eye, skull);
    const k = el('span', { class: 'num' });
    const d = el('span', { class: 'num' });
    const a = el('span', { class: 'num' });
    const s = el('span', { class: 'num col-score' });
    const life = el('span', { class: 'num' });
    const shield = el('i', { class: 'shield' });
    const health = el('i', { class: 'health' });
    const vitals = el('span', { class: 'vitals', 'aria-hidden': 'true' },
      el('span', { class: 'vtrack-s' }, shield), el('span', { class: 'vtrack-h' }, health));
    const swatch = el('span', { class: 'swatch num', 'aria-hidden': 'true' });
    const b = el('button', { type: 'button', class: 'roster-row', dataset: { handle } },
      swatch, el('span', { class: 'rname' }, name, ptag), status, k, d, a, s, life, vitals);
    b.addEventListener('click', () => {
      const p = state.snapshot?.players.find(x => x.handle === handle);
      if (!p) return;
      if (!p.observer) setView({ focus: state.view.focus === p.handle ? null : p.handle });
      pick(targetOf(p));
      collapse();
    });
    b.addEventListener('pointerenter', () => hover({ kind: 'player', handle }));
    b.addEventListener('pointerleave', () => { if (state.hovered?.handle === handle) hover(null); });
    return { b, swatch, name, ptag, eye, skull, k, d, a, s, life, shield, health, vitals };
  };

  const paintRow = (r, p, live, n, observed) => {
    const label = playerLabel(p);
    setText(r.name, label);
    setText(r.swatch, n === null ? '' : String(n));
    setAttr(r.name, 'title', label);
    const kind = p.observer ? 'Observer' : p.bot_handle ? 'Bot' : p.host ? 'Host' : '';
    setText(r.ptag, kind);
    r.ptag.hidden = !kind;
    const dead = live && !p.observer && !p.alive;
    setAttr(r.b, 'data-dead', dead ? true : null);
    const following = state.view.focus === p.handle;
    setAttr(r.b, 'aria-pressed', String(following));
    // One mark in the status slot: following first, else dead.
    setShown(r.eye, following);
    setShown(r.skull, dead && !following);
    setAttr(r.b, 'data-selected', state.selected?.kind === 'player' && state.selected.handle === p.handle ? true : null);
    setAttr(r.b, 'data-observed', observed ? true : null);
    setTeam(r.b, teamOfPlayer(p));
    const st = p.stats;
    setText(r.k, fmt.int(st?.kills));
    setText(r.d, fmt.int(st?.deaths));
    setText(r.a, fmt.int(st?.assists));
    setText(r.s, fmt.int(st?.objective_score));
    const averageLife = !p.observer && Number.isFinite(p.average_life_seconds) && p.average_life_seconds > 0
      ? fmt.clock(Math.round(p.average_life_seconds)) : '';
    setText(r.life, averageLife);
    const v = dead ? null : p.vitality;
    setShown(r.vitals, !p.observer);
    setBar(r.shield, v?.shield);
    setBar(r.health, v?.health);
    const parts = [n === null ? label : `${n}, ${label}`];
    if (kind) parts.push(kind);
    if (st) parts.push(`${fmt.int(st.kills) || 'unknown'} kills, ${fmt.int(st.deaths) || 'unknown'} deaths, ${fmt.int(st.assists) || 'unknown'} assists`);
    if (dead) parts.push('dead');
    if (averageLife) parts.push(`average observed life ${averageLife}`);
    if (following) parts.push('following');
    if (observed) parts.push('observed');
    setAttr(r.b, 'aria-label', parts.join(', '));
    setAttr(r.b, 'title', p.observer ? `Select ${label}.` : following ? `Stop following ${label}.` : `Follow ${label}.`);
  };

  const makeBand = () => {
    const name = el('span', { class: 'caps tname truncate' });
    const score = el('span', { class: 'tscore num' });
    const won = el('span', { class: 'caps twon', 'data-off': '' }, 'Won');
    const alive = el('span', { class: 'talive num' });
    const emblem = teamEmblem(14);
    const b = el('div', { class: 'team-band roster-band' }, emblem.el, name, score, el('span', { class: 'spacer' }), won, alive);
    return { b, emblem, name, score, won, alive };
  };

  return () => {
    const snap = state.snapshot;
    const players = rosterPlayers(snap, state.view);
    if (!players.length) {
      rows.clear();
      bands.clear();
      head.hidden = true;
      const key = state.feed === 'connecting' && !snap ? 'skel' : emptyTitle('No players');
      if (key !== holder) {
        holder = key;
        list.replaceChildren(placeholder('players', 'No players'));
      }
      return snap ? 0 : null;
    }
    holder = '';
    head.hidden = false;
    setAttr(pane, 'data-score', scoreColumn(state.snapshot) ? true : null);
    const nums = numbered() ? playerNumbers(snap, state.epoch) : null;
    setAttr(pane, 'data-numbers', nums ? true : null);
    const observed = numberedPlayer(state.view.observed, snap);
    const live = matchLive(snap);
    const teams = teamsOf(snap);
    // The winner, once the match is over: the one team with the top score.
    let winner = null;
    if (phaseOf(snap.life_cycle) === 'Post-match') {
      const scored = teams.filter(t => Number.isFinite(t.score));
      const top = Math.max(...scored.map(t => t.score));
      const leaders = scored.filter(t => t.score === top);
      if (leaders.length === 1) winner = leaders[0].id;
    }
    const groups = [
      ...teams.map(t => ({ key: `t${t.id}`, team: t, members: players.filter(p => !p.observer && p.team === t.id).sort(bySlot) })),
      { key: 'none', team: null, members: players.filter(p => teamOfPlayer(p) === null).sort(bySlot) },
    ].filter(g => g.members.length);
    const order = [];
    const seenBands = new Set();
    for (const g of groups) {
      let b = bands.get(g.key);
      if (!b) { b = makeBand(); bands.set(g.key, b); }
      setTeam(b.b, g.team ? g.team.id : null);
      const observers = !g.team && g.members.every(p => p.observer);
      b.emblem.set(g.team ? g.team.id : observers ? 8 : null);
      setText(b.name, g.team ? g.team.name : observers ? 'Observers' : 'No team');
      setText(b.score, g.team ? fmt.int(g.team.score) : '');
      setShown(b.won, Boolean(g.team) && g.team.id === winner);
      setText(b.alive, g.team && live ? `${g.team.alive} alive` : '');
      order.push(b.b);
      seenBands.add(g.key);
      for (const p of g.members) {
        let r = rows.get(p.handle);
        if (!r) { r = makeRow(p.handle); rows.set(p.handle, r); }
        paintRow(r, p, live, nums?.get(p.handle) ?? null, p.handle === observed);
        order.push(r.b);
      }
    }
    for (const key of [...bands.keys()]) if (!seenBands.has(key)) bands.delete(key);
    const present = new Set(players.map(p => p.handle));
    for (const h of [...rows.keys()]) if (!present.has(h)) rows.delete(h);
    reorderKeepFocus(list, order);
    return players.length;
  };
}

// ── Spawn timers (Timers tab) ───────────────────────────────────────────

function mountTimers(pane, pick, collapse) {
  const list = el('div', { class: 'timer-list' });
  pane.append(list);
  const rows = new Map();
  let holder = '';

  const makeRow = handle => {
    const glyph = el('span', { class: 'ticon', 'aria-hidden': 'true' });
    const name = el('span', { class: 'tname truncate' });
    // The sub line in parts, so the 260px panel can drop 'respawns'.
    const subKind = el('span');
    const subWord = el('span', { class: 'tsub-word' });
    const subCycle = el('span');
    const sub = el('span', { class: 'tsub truncate' }, subKind, subWord, subCycle);
    const value = el('span', { class: 'tvalue num' });
    const fill = el('i');
    const progress = el('span', { class: 'tprogress', 'aria-hidden': 'true', 'data-off': '' }, fill);
    const b = el('button', { type: 'button', class: 'timer-row', dataset: { handle } },
      glyph, el('span', { class: 'ttext' }, name, sub), value, progress);
    b.addEventListener('click', () => {
      pick({ kind: 'object', handle });
      collapse();
    });
    b.addEventListener('pointerenter', () => hover({ kind: 'object', handle }));
    b.addEventListener('pointerleave', () => { if (state.hovered?.handle === handle) hover(null); });
    return { b, glyph, name, subKind, subWord, subCycle, value, progress, fill, iconKey: null, valueKey: null, valueTag: null };
  };

  const paintRow = (r, pad, t, next) => {
    const label = padLabel(pad);
    setText(r.name, label);
    const cycle = t.cycle ? Math.round(t.cycle) : 0;
    setText(r.subKind, fmt.words(t.category) + (cycle ? ', ' : ''));
    setText(r.subWord, cycle ? 'respawns ' : '');
    setText(r.subCycle, cycle ? `every ${cycle} s` : '');
    setAttr(r.b, 'data-state', t.state);
    setAttr(r.b, 'data-category', t.category);
    setAttr(r.b, 'data-next', next ? true : null);
    setAttr(r.b, 'data-selected', state.selected?.kind === 'object' && state.selected.handle === pad.handle ? true : null);
    const v = padValue(t);
    if (v.kind === 'tag') {
      if (r.valueKey !== 'tag') { r.valueTag = tag(v.text, 'muted', { small: true }); r.value.replaceChildren(r.valueTag); r.valueKey = 'tag'; }
      setTag(r.valueTag, v.text, 'muted', { small: true });
      setAttr(r.valueTag, 'title', v.title ?? null);
    } else {
      if (r.valueKey === 'tag') { r.value.replaceChildren(); r.valueTag = null; }
      r.valueKey = 'text';
      setText(r.value, v.text);
    }
    setAttr(r.b, 'data-value', v.kind);
    // The icon is rebuilt only when the item or the atlas changes.
    const iconKey = `${state.atlas ? 1 : 0}:${pad.stock_spawner?.display_name ?? ''}:${pad.stock_spawner?.item_name ?? ''}`;
    if (iconKey !== r.iconKey) {
      r.iconKey = iconKey;
      r.glyph.replaceChildren(itemIcon(pad, 36, 20) ?? icon(t.category === 'weapon' ? 'crosshair' : 'package', 14));
    }
    setShown(r.progress, t.progress !== null);
    const s = `scaleX(${(t.progress ?? 0).toFixed(3)})`;
    if (r.fill.style.transform !== s) r.fill.style.transform = s;
    setAttr(r.b, 'aria-label', [label, padSub(t), v.text, next ? 'next to spawn' : ''].filter(Boolean).join(', '));
    setAttr(r.b, 'title', `Select ${label}.`);
  };

  return () => {
    const snap = state.snapshot;
    const pads = padsInOrder(snap);
    if (!pads.length) {
      rows.clear();
      const key = state.feed === 'connecting' && !snap ? 'skel' : emptyTitle('No spawn pads');
      if (key !== holder) {
        holder = key;
        list.replaceChildren(placeholder('timers', 'No spawn pads'));
      }
      return snap ? 0 : null;
    }
    holder = '';
    const next = nextPad(pads);
    const order = pads.map(({ pad, t }) => {
      let r = rows.get(pad.handle);
      if (!r) { r = makeRow(pad.handle); rows.set(pad.handle, r); }
      paintRow(r, pad, t, next?.pad === pad);
      return r.b;
    });
    const present = new Set(pads.map(x => x.pad.handle));
    for (const h of [...rows.keys()]) if (!present.has(h)) rows.delete(h);
    reorderKeepFocus(list, order);
    return pads.length;
  };
}

// ── Selection (Selection tab) ───────────────────────────────────────────

/** The card's head: a team band (or a rule in `--team-color`) holding an
 *  optional lead (an item icon), the name over a CAPS line, and Close. */
function cardHead(lead) {
  const name = el('div', { class: 'card-name truncate' });
  const sub = el('div', { class: 'card-sub caps' });
  const close = iconButton('x', 'Clear the selection.', 'sm', 'ghost', () => select(null));
  const head = el('div', { class: 'team-band card-head' },
    lead ? el('span', { class: 'card-lead', 'aria-hidden': 'true' }, lead) : null,
    el('div', { class: 'card-title' }, name, sub), close);
  return { head, name, sub };
}

/** The raw record behind a disclosure, with a copy button beside it. */
let rawSeq = 0;
function rawBlock() {
  const pre = el('pre', { class: 'raw-pre mono', id: `raw-record-${++rawSeq}`, hidden: true, tabindex: '0' });
  const toggle = el('button', { type: 'button', class: 'raw-toggle', aria: { expanded: 'false', controls: pre.id } },
    icon('caret', 12), el('span', { class: 'caps' }, 'Raw record'));
  const copy = copyButton('raw record', () => JSON.stringify(selectedRecord(), null, 2));
  const paint = () => { if (!pre.hidden) setText(pre, JSON.stringify(selectedRecord(), null, 2)); };
  toggle.addEventListener('click', () => {
    pre.hidden = !pre.hidden;
    toggle.setAttribute('aria-expanded', String(!pre.hidden));
    paint();
  });
  return {
    el: el('section', { class: 'raw' }, el('div', { class: 'raw-head' }, toggle, el('span', { class: 'spacer' }), copy), pre),
    update: paint,
  };
}

/** A framed compact kvGrid whose values are spans to fill in later.
 *  rows: [{ key, mono?, copy? (name) }]. Returns { el, values, set(key,
 *  text) }: set() writes a value and hides its row while it is empty
 *  (Films: empty values render nothing). Rows that can empty out go last
 *  in a card, so the rows above them never move. */
function factGrid(rows) {
  const values = {};
  const grid = kvGrid([{
    rows: rows.map(r => {
      const v = el('span', { class: r.mono ? 'kv-value mono' : 'kv-value' });
      values[r.key] = v;
      const handleOf = () => v.textContent ?? '';
      return { key: r.key, value: r.copy ? el('span', { class: 'kv-copy' }, v, copyButton(r.copy, handleOf)) : v };
    }),
  }], { compact: true, keyWidth: 110 });
  const kids = [...grid.querySelector('dl').children];
  const cells = {};
  rows.forEach((r, i) => { cells[r.key] = [kids[i * 2], kids[i * 2 + 1]]; });
  // The last shown row draws no rule (the frame closes it).
  const lastRule = () => {
    for (const k of kids) setAttr(k, 'data-last', null);
    for (const k of kids.filter(x => !x.hidden).slice(-2)) setAttr(k, 'data-last', true);
  };
  lastRule();
  return {
    el: el('div', { class: 'frame' }, grid),
    values,
    set(key, text) {
      setText(values[key], text);
      const off = !text;
      const [dt, dd] = cells[key];
      if (dt.hidden === off) return;
      dt.hidden = off;
      dd.hidden = off;
      lastRule();
    },
  };
}

/** A state dot and a word for a fact's value. */
function setState(span, tone, text) {
  const key = `${tone}|${text}`;
  if (span.dataset.key === key) return;
  span.dataset.key = key;
  span.replaceChildren(...(text ? [stateDot(tone), text] : []));
  span.classList.add('kv-state');
}

function playerCard() {
  const { head, name, sub } = cardHead(null);
  const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' });
  const teamName = el('span', { class: 'truncate' });
  const kindTag = el('span', { class: 'ptag' });
  sub.append(swatch, teamName, kindTag);

  const follow = button({ icon: 'follow', label: 'Follow', size: 'md', variant: 'ghost', pressed: false, title: 'Keep the map on this player.' });
  follow.addEventListener('click', () => {
    const p = selectedRecord();
    if (!p) return;
    setView({ focus: state.view.focus === p.handle ? null : p.handle });
  });
  // Observe: the player the game's observer watches, by their number. The
  // map highlights them and stays where it is (Follow moves it).
  const observe = button({ icon: 'observe', label: 'Observe', size: 'md', variant: 'ghost', pressed: false });
  const numberOf = p => (p && !p.observer ? playerNumbers(state.snapshot, state.epoch).get(p.handle) ?? null : null);
  observe.addEventListener('click', () => {
    const n = numberOf(selectedRecord());
    if (n === null) return;
    setView({ observed: state.view.observed === n ? null : n });
  });
  const only = button({ icon: 'filter', label: 'Only', size: 'md', variant: 'ghost', pressed: false });
  only.addEventListener('click', () => {
    const p = selectedRecord();
    if (!p || teamOfPlayer(p) === null) return;
    setView({ team: state.view.team === p.team ? null : p.team });
  });
  const acts = el('div', { class: 'card-acts', role: 'group', 'aria-label': 'Player actions' }, follow, observe, only);

  const withScore = scoreColumn(state.snapshot);
  const strip = statStrip([
    { label: 'Kills' }, { label: 'Deaths' },
    { label: 'Assists', title: 'Kills by another player this player helped with.' },
    ...(withScore ? [{ label: 'Score' }] : []),
  ]);
  const numbers = el('div', { class: 'card-stats' }, strip.el);

  const vital = label => {
    const fill = el('i');
    const num = el('span', { class: 'vnum num' });
    const row = el('div', { class: 'vrow' }, el('span', { class: 'caps vlabel' }, label),
      el('span', { class: 'vtrack', 'aria-hidden': 'true' }, fill), num);
    return { row, fill, num };
  };
  const shield = vital('Shield');
  const health = vital('Health');
  shield.fill.classList.add('shield');
  health.fill.classList.add('health');
  const vitals = band('Vitals', el('div', { class: 'vrows' }, shield.row, health.row));

  // The facts that empty out when a player dies (elevation, unit) go last,
  // and Vitals (hidden while dead) comes after them, so a death only
  // shortens the card's foot.
  const facts = factGrid([
    { key: 'Status' }, { key: 'Team' }, { key: 'Slot' },
    { key: 'Handle', mono: true, copy: 'handle' }, { key: 'Elevation' }, { key: 'Unit', mono: true },
  ]);
  const details = band('Details', facts.el);
  const raw = rawBlock();

  const elCard = el('div', { class: 'card' }, head, acts, numbers, details, vitals, raw.el);

  return {
    el: elCard,
    update(p) {
      const label = playerLabel(p);
      setText(name, label);
      setAttr(name, 'title', label);
      setAttr(elCard, 'aria-label', label);
      const team = teamOfPlayer(p);
      setTeam(head, team);
      setTeam(swatch, team);
      setText(teamName, p.observer ? 'Observer' : p.team_name || (team === null ? 'No team' : `Team ${team + 1}`));
      setText(kindTag, p.bot_handle ? 'Bot' : '');
      kindTag.hidden = !p.bot_handle;

      follow.hidden = Boolean(p.observer);
      const following = state.view.focus === p.handle;
      setAttr(follow, 'aria-pressed', String(following));
      setAttr(follow, 'title', following ? 'Stop following this player.' : 'Keep the map on this player.');
      const n = numberOf(p);
      observe.hidden = n === null;
      const observing = n !== null && state.view.observed === n;
      setAttr(observe, 'aria-pressed', String(observing));
      setAttr(observe, 'title', observing ? 'Stop observing this player.'
        : `Highlight this player as the one the game's observer watches, without moving the map.${n !== null && n <= 9 ? ` Key ${n}.` : ''}`);
      only.hidden = team === null;
      if (team !== null) {
        const tn = p.team_name || `Team ${team + 1}`;
        const on = state.view.team === team;
        setText(only.querySelector('.label'), `Only ${tn}`);
        setAttr(only, 'aria-pressed', String(on));
        setAttr(only, 'title', on ? 'Show every team.' : `Show only ${tn}.`);
      }
      acts.hidden = follow.hidden && observe.hidden && only.hidden;

      // The numbers keep their place in every state (empty values).
      const st = p.stats;
      setText(strip.values[0], fmt.int(st?.kills));
      setText(strip.values[1], fmt.int(st?.deaths));
      setText(strip.values[2], fmt.int(st?.assists));
      if (strip.values[3]) setText(strip.values[3], fmt.int(st?.objective_score));

      const live = matchLive(state.snapshot);
      const dead = live && !p.observer && !p.alive;
      const v = dead ? null : p.vitality;
      vitals.hidden = !v;
      setBar(shield.fill, v?.shield);
      setBar(health.fill, v?.health);
      setText(shield.num, Number.isFinite(v?.shield) ? String(Math.round(v.shield * 100)) : '');
      setText(health.num, Number.isFinite(v?.health) ? String(Math.round(v.health * 100)) : '');

      if (p.observer) setState(facts.values.Status, 'muted', 'Observer');
      else if (live) setState(facts.values.Status, p.alive ? 'ok' : 'muted', p.alive ? 'Alive' : 'Dead');
      else setState(facts.values.Status, p.alive ? 'ok' : 'muted', p.alive ? 'Alive' : 'Inactive');
      facts.set('Team', p.observer ? 'Observer' : p.team_name || (team === null ? 'None' : `Team ${team + 1}`));
      facts.set('Slot', String(p.slot + 1));
      facts.set('Handle', p.handle);
      facts.set('Elevation', dead ? '' : fmt.metres(p.position?.z));
      facts.set('Unit', dead ? '' : p.unit ?? '');
      raw.update();
    },
  };
}

function padCard() {
  const lead = el('span', { class: 'card-icon' });
  const { head, name, sub } = cardHead(lead);
  const strip = statStrip([{ label: 'Next spawn' }, { label: 'Cycle' }]);
  const fill = el('i');
  const progress = el('span', { class: 'card-progress', 'aria-hidden': 'true' }, fill);
  const numbers = el('div', { class: 'card-stats' }, strip.el, progress);
  const facts = factGrid([
    { key: 'State' }, { key: 'Logic' }, { key: 'Handle', mono: true, copy: 'handle' },
    { key: 'Item', mono: true }, { key: 'Elevation' },
  ]);
  setTeam(head, null);
  const details = band('Details', facts.el);
  const raw = rawBlock();
  const elCard = el('div', { class: 'card' }, head, numbers, details, raw.el);
  let iconKey = null;
  const TONE = { incoming: 'accent', ready: 'ok', restricted: 'warn' };

  return {
    el: elCard,
    update(o) {
      const t = padTimer(o);
      const spawn = o.stock_spawner;
      const label = padLabel(o);
      setText(name, label);
      setAttr(name, 'title', label);
      setAttr(elCard, 'aria-label', label);
      setText(sub, fmt.words(t.category));
      setAttr(head, 'data-state', t.state);
      const key = `${state.atlas ? 1 : 0}:${spawn?.display_name ?? ''}:${spawn?.item_name ?? ''}`;
      if (key !== iconKey) {
        iconKey = key;
        lead.replaceChildren(itemIcon(o, 36, 20) ?? icon(t.category === 'weapon' ? 'crosshair' : 'package', 16));
      }
      setAttr(lead, 'data-category', t.category);
      const v = padValue(t);
      setText(strip.values[0], v.text);
      setAttr(strip.values[0], 'data-incoming', v.kind === 'count' ? true : null);
      setText(strip.values[1], t.cycle ? `${Math.round(t.cycle)} s` : '');
      setAttr(progress, 'data-active', t.progress !== null ? true : null);
      const s = `scaleX(${(t.progress ?? 0).toFixed(3)})`;
      if (fill.style.transform !== s) fill.style.transform = s;
      setState(facts.values.State, TONE[t.state] ?? 'muted', t.state === 'unknown' ? 'Unknown' : fmt.words(t.state));
      facts.set('Logic', spawn ? spawnLogicText(spawn.spawn_logic) : 'Unknown');
      facts.set('Handle', o.handle);
      facts.set('Item', spawn?.item_name ?? '');
      facts.set('Elevation', fmt.metres(o.position?.z));
      raw.update();
    },
  };
}

function objectCard() {
  const lead = icon('devices', 16);
  const { head, name, sub } = cardHead(lead);
  const facts = factGrid([{ key: 'Type' }, { key: 'Handle', mono: true, copy: 'handle' }, { key: 'Elevation' }]);
  const details = band('Details', facts.el);
  const raw = rawBlock();
  const elCard = el('div', { class: 'card' }, head, details, raw.el);
  setTeam(head, null);
  return {
    el: elCard,
    update(o) {
      const label = recordTitle(o);
      setText(name, label);
      setAttr(elCard, 'aria-label', label);
      setText(sub, 'Object');
      facts.set('Type', fmt.words(o.kind) || 'Unknown');
      facts.set('Handle', o.handle);
      facts.set('Elevation', fmt.metres(o.position?.z));
      raw.update();
    },
  };
}

function mountSelection(pane) {
  const empty = emptyState({ icon: 'selection', title: 'Nothing selected', body: 'Click a player or a spawn pad on the map.' });
  let key = null;
  let card = null;
  pane.append(empty);
  return () => {
    const record = selectedRecord();
    const k = record ? `${state.selected.kind}:${record.handle}` : null;
    if (k !== key) {
      key = k;
      card = !record ? null : isPlayer(record) ? playerCard() : isPad(record) ? padCard() : objectCard();
      pane.replaceChildren(card ? card.el : empty);
      pane.scrollTop = 0;
    }
    card?.update(record);
    return null;
  };
}

// ── Legend bar ──────────────────────────────────────────────────────────

function mountLegend(bar) {
  bar.setAttribute('aria-label', 'Teams and players');
  // The bar stays in the page in every phase, so the stage above it never
  // changes height at a match boundary. With nobody to show it holds a
  // quiet line.
  bar.hidden = false;
  const empty = el('span', { class: 'lg-empty' });
  const groups = new Map();
  const chips = new Map();
  // A vertical wheel scrolls the bar sideways when it overflows.
  bar.addEventListener('wheel', e => {
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY) || bar.scrollWidth <= bar.clientWidth) return;
    e.preventDefault();
    bar.scrollLeft += e.deltaY;
  }, { passive: false });

  const makeGroup = key => {
    const name = el('span', { class: 'caps lg-name-team truncate' });
    const score = el('span', { class: 'lg-score num' });
    const emblem = teamEmblem(12);
    const head = el('button', { type: 'button', class: 'lg-head team-band', 'aria-pressed': 'false' }, emblem.el, name, score);
    head.addEventListener('click', () => {
      const id = Number(key.slice(1));
      setView({ team: state.view.team === id ? null : id });
    });
    const list = el('span', { class: 'lg-chips' });
    const g = el('div', { class: 'lg-group', role: 'group' }, head, list);
    return { g, head, emblem, name, score, list };
  };

  const makeChip = handle => {
    const name = el('span', { class: 'lg-name' });
    const kdEl = el('span', { class: 'lg-kd num' });
    const shield = el('i', { class: 'lg-bar shield', 'data-empty': '' });
    const health = el('i', { class: 'lg-bar health', 'data-empty': '' });
    const swatch = el('span', { class: 'swatch num', 'aria-hidden': 'true' });
    const b = el('button', { type: 'button', class: 'lg-chip', 'aria-pressed': 'false', dataset: { handle } },
      swatch, name, kdEl, shield, health);
    b.addEventListener('click', () => {
      const p = state.snapshot?.players.find(x => x.handle === handle);
      if (!p) return;
      const target = targetOf(p);
      if (state.view.focus === handle) {
        setView({ focus: null });
        if (sameTarget(state.selected, target)) select(null);
        return;
      }
      // Following a player the team filter hides shows every team again.
      const hidden = state.view.team !== null && state.view.team !== p.team;
      setView(hidden ? { focus: handle, team: null } : { focus: handle });
      select(target);
    });
    b.addEventListener('pointerenter', () => hover({ kind: 'player', handle }));
    b.addEventListener('pointerleave', () => { if (state.hovered?.handle === handle) hover(null); });
    return { b, swatch, name, kdEl, shield, health };
  };

  const paintChip = (c, p, live, n, observed) => {
    const label = playerLabel(p);
    setText(c.name, label);
    setText(c.swatch, n === null ? '' : String(n));
    setText(c.kdEl, kd(p));
    setTeam(c.b, teamOfPlayer(p));
    const dead = live && !p.alive;
    setAttr(c.b, 'data-dead', dead ? true : null);
    setAttr(c.b, 'data-out', state.view.team !== null && state.view.team !== p.team ? true : null);
    setAttr(c.b, 'aria-pressed', String(state.view.focus === p.handle));
    setAttr(c.b, 'data-selected', state.selected?.kind === 'player' && state.selected.handle === p.handle ? true : null);
    setAttr(c.b, 'data-observed', observed ? true : null);
    setBar(c.shield, dead ? null : p.vitality?.shield);
    setBar(c.health, dead ? null : p.vitality?.health);
    const st = p.stats;
    const title = `${[n === null ? label : `${n}, ${label}`, st ? `${fmt.int(st.kills) || 0} kills, ${fmt.int(st.deaths) || 0} deaths` : ''].filter(Boolean).join(', ')}.`;
    setAttr(c.b, 'title', title);
  };

  return () => {
    const snap = state.snapshot;
    const players = (snap?.players ?? []).filter(p => !p.observer);
    if (!players.length) {
      groups.clear();
      chips.clear();
      setText(empty, snap ? 'No players' : '');
      if (bar.firstChild !== empty || bar.childNodes.length !== 1) bar.replaceChildren(empty);
      return;
    }
    const live = matchLive(snap);
    const nums = numbered() ? playerNumbers(snap, state.epoch) : null;
    setAttr(bar, 'data-numbers', nums ? true : null);
    const observed = numberedPlayer(state.view.observed, snap);
    const teams = teamsOf(snap);
    const sets = [
      ...teams.map(t => ({ key: `t${t.id}`, team: t, members: players.filter(p => p.team === t.id).sort(bySlot) })),
      { key: 'none', team: null, members: players.filter(p => teamOfPlayer(p) === null).sort(bySlot) },
    ].filter(s => s.members.length);
    const order = [];
    const seen = new Set();
    for (const s of sets) {
      let g = groups.get(s.key);
      if (!g) { g = makeGroup(s.key); groups.set(s.key, g); }
      seen.add(s.key);
      g.head.hidden = !s.team;
      if (s.team) {
        setTeam(g.head, s.team.id);
        g.emblem.set(s.team.id);
        setText(g.name, s.team.name);
        setText(g.score, fmt.int(s.team.score));
        const on = state.view.team === s.team.id;
        setAttr(g.head, 'aria-pressed', String(on));
        const title = on ? 'Show every team.' : `Show only ${s.team.name}.`;
        setAttr(g.head, 'title', title);
        const score = Number.isFinite(s.team.score) ? `, ${s.team.score}` : '';
        setAttr(g.head, 'aria-label', `${s.team.name}${score}. ${title}`);
        setAttr(g.g, 'aria-label', `${s.team.name}${score}`);
      } else {
        setAttr(g.g, 'aria-label', 'Players');
      }
      const chipEls = s.members.map(p => {
        let c = chips.get(p.handle);
        if (!c) { c = makeChip(p.handle); chips.set(p.handle, c); }
        paintChip(c, p, live, nums?.get(p.handle) ?? null, p.handle === observed);
        return c.b;
      });
      g.g.style.setProperty('--n', String(chipEls.length));
      setAttr(g.g, 'data-nohead', s.team ? null : true);
      reorderKeepFocus(g.list, chipEls);
      order.push(g.g);
    }
    for (const key of [...groups.keys()]) if (!seen.has(key)) groups.delete(key);
    const present = new Set(players.map(p => p.handle));
    for (const h of [...chips.keys()]) if (!present.has(h)) chips.delete(h);
    reorderKeepFocus(bar, order);
  };
}

// ── Phone sheet ─────────────────────────────────────────────────────────

/** The persistent bottom sheet the panel becomes below 640px (Films sheet):
 *  peek, half and full. The handle cycles them on a tap and snaps to the
 *  nearest after a drag. The scrim, Escape and a picked row collapse it.
 *  Returns { collapse(), size() }. */
function mountSheet(root, sheet, handle, head, scrim) {
  const ORDER = ['peek', 'half', 'full'];
  let size = 'peek';
  const fullPx = () => Math.max(PEEK, Math.round(root.getBoundingClientRect().bottom - SHEET_TOP));
  const px = s => (s === 'peek' ? PEEK : s === 'half' ? Math.min(fullPx(), Math.round(window.innerHeight * 0.5)) : fullPx());

  const apply = s => {
    size = s;
    root.dataset.sheet = s;
    const phone = PHONE.matches;
    handle.setAttribute('aria-expanded', String(phone && s !== 'peek'));
    scrim.hidden = !phone || s === 'peek';
    sheet.style.height = phone ? `${px(s)}px` : '';
  };

  let drag = null;
  handle.addEventListener('pointerdown', e => {
    drag = { y: e.clientY, h: sheet.offsetHeight, moved: false };
    handle.setPointerCapture(e.pointerId);
    sheet.style.transition = 'none';
  });
  handle.addEventListener('pointermove', e => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) sheet.style.height = `${Math.max(PEEK, Math.min(fullPx(), drag.h - dy))}px`;
  });
  const end = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    sheet.style.transition = '';
    if (!moved) { apply(ORDER[(ORDER.indexOf(size) + 1) % ORDER.length]); return; }
    const h = sheet.offsetHeight;
    let best = 'peek';
    for (const s of ORDER) if (Math.abs(px(s) - h) < Math.abs(px(best) - h)) best = s;
    apply(best);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  // Keyboard: Enter and Space on the handle cycle as a tap does.
  handle.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(ORDER[(ORDER.indexOf(size) + 1) % ORDER.length]); }
  });
  head.addEventListener('click', () => { if (PHONE.matches && size === 'peek') apply('half'); });
  scrim.addEventListener('click', () => apply('peek'));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && PHONE.matches && size !== 'peek') apply('peek');
  });
  window.addEventListener('resize', () => { if (PHONE.matches && size !== 'peek') apply(size); });
  PHONE.addEventListener('change', () => apply('peek'));
  apply('peek');

  return {
    collapse() { if (PHONE.matches && size !== 'peek') apply('peek'); },
    size: () => size,
  };
}

// ── Mount ───────────────────────────────────────────────────────────────

/** Fill the side panel (`root`, the <aside>) and the legend bar. */
export function mount(root, legendBar) {
  const TABS = [
    { value: 'players', label: 'Players', icon: 'players' },
    { value: 'timers', label: 'Timers', icon: 'timers' },
    { value: 'selection', label: 'Selection', icon: 'selection' },
  ];
  const panes = {};
  for (const t of TABS) {
    panes[t.value] = el('div', { class: 'pane', dataset: { pane: t.value }, tabindex: '-1' });
    t.panel = panes[t.value];
  }

  let tab = 'players';
  /** The tab Selection came forward from, to go back to when it clears. */
  let autoFrom = null;
  /** Set while the panel itself selects (a row), so Selection stays put. */
  let origin = null;
  const counts = { players: null, timers: null, selection: null };

  const tabCtl = tabs(TABS, tab, v => { autoFrom = null; setTab(v); }, { compact: true });
  tabCtl.el.setAttribute('aria-label', 'Panel');
  const tabEls = [...tabCtl.el.querySelectorAll('.tab')];

  // The sheet's parts (shown below 640px only).
  const grip = el('span', { class: 'sheet-grip' });
  const handle = el('button', { type: 'button', class: 'sheet-handle', title: 'Resize the panel.', 'aria-label': 'Resize panel' }, grip);
  // The head on phones, one row: the tab (its icon, name and a count chip),
  // what it is about (the followed player, the next pad, the selection),
  // then the feed's state and the pause toggle at the right edge. The live
  // bar's place goes to the map on phones (chrome.css).
  const peekIcon = el('span', { class: 'peek-icon', 'aria-hidden': 'true' });
  const peekLabel = el('span', { class: 'peek-label' });
  const peekCount = el('span', { class: 'peek-count num' });
  const peekMark = el('span', { class: 'peek-mark', 'aria-hidden': 'true' });
  const peekText = el('span', { class: 'peek-text truncate' });
  const peekValue = el('span', { class: 'peek-value num' });
  const feed = feedControls('ghost');
  // The toggle pauses. It doesn't open the sheet as a tap on the head does.
  feed.pause.addEventListener('click', e => e.stopPropagation());
  const head = el('div', { class: 'sheet-head' },
    el('span', { class: 'peek-title' }, peekIcon, peekLabel, peekCount),
    el('span', { class: 'peek-detail' }, peekMark, peekText, peekValue),
    el('span', { class: 'peek-feed' }, feed.words, feed.status, el('span', { class: 'peek-rule', 'aria-hidden': 'true' }), feed.pause));
  const body = el('div', { class: 'sheet-body' }, tabCtl.el, panes.players, panes.timers, panes.selection);
  const sheetEl = el('div', { class: 'sheet' }, handle, head, body);
  const scrim = el('div', { class: 'sheet-scrim', hidden: true, 'aria-hidden': 'true' });
  root.replaceChildren(sheetEl, scrim);
  const sheet = mountSheet(root, sheetEl, handle, head, scrim);

  const pick = target => {
    origin = 'panel';
    try { select(target); } finally { origin = null; }
  };
  const collapse = () => sheet.collapse();

  const paintRoster = mountRoster(panes.players, pick, collapse);
  const paintTimers = mountTimers(panes.timers, pick, collapse);
  const paintSelection = mountSelection(panes.selection);
  const paintLegend = mountLegend(legendBar);

  function syncTabs() {
    TABS.forEach((t, i) => {
      const n = counts[t.value];
      const text = n === null || n === undefined ? '' : String(n);
      const count = tabEls[i].querySelector('.count');
      if (count.textContent !== text) tabCtl.setCount(t.value, n);
      const name = text ? `${t.label}, ${text}` : t.label;
      setAttr(tabEls[i], 'aria-label', name);
      setAttr(tabEls[i], 'title', t.value === tab ? null : name);
    });
  }

  function setTab(v) {
    tab = v;
    tabCtl.set(v);
    syncTabs();
    paintPeek();
  }

  // The peek: the tab's icon, label and count, then its key line.
  let markKey = null;
  let iconKey = null;
  function setMark(key, build) {
    if (key === markKey) return;
    markKey = key;
    // The slot stays whether or not it holds a mark, so the text after it
    // never moves.
    peekMark.replaceChildren(...(build ? [build()] : []));
  }
  function paintPeek() {
    const t = TABS.find(x => x.value === tab);
    const n = counts[tab];
    if (t.icon !== iconKey) {
      iconKey = t.icon;
      peekIcon.replaceChildren(icon(t.icon, 14));
    }
    setText(peekLabel, t.label);
    setText(peekCount, n === null || n === undefined ? '' : String(n));
    let text = '';
    let value = '';
    let tone = null;
    const snap = state.snapshot;
    if (tab === 'players') {
      const p = focusedPlayer();
      if (p) {
        setMark(`p:${teamOfPlayer(p)}`, () => setTeamSwatch(teamOfPlayer(p)));
        text = playerLabel(p);
        value = kd(p);
      } else {
        // Nobody followed: the masthead already has the score.
        setMark('', null);
      }
    } else if (tab === 'timers') {
      const pads = padsInOrder(snap);
      const next = nextPad(pads);
      if (next) {
        setMark('next', () => icon('timers', 12));
        text = padLabel(next.pad);
        value = fmt.countdown(next.t.remaining);
        tone = 'incoming';
      } else {
        setMark('', null);
        const ready = pads.filter(x => x.t.state === 'ready').length;
        text = pads.length ? `${ready} ready` : '';
      }
    } else {
      const r = selectedRecord();
      if (r && isPlayer(r)) {
        setMark(`p:${teamOfPlayer(r)}`, () => setTeamSwatch(teamOfPlayer(r)));
        text = playerLabel(r);
        value = r.observer ? 'Observer' : matchLive(snap) ? (r.alive ? 'Alive' : 'Dead') : kd(r);
      } else if (r && isPad(r)) {
        const tm = padTimer(r);
        setMark(`c:${tm.category}`, () => icon(tm.category === 'weapon' ? 'crosshair' : 'package', 12));
        text = padLabel(r);
        value = padValue(tm).text;
        if (tm.state === 'incoming') tone = 'incoming';
      } else if (r) {
        setMark('', null);
        text = recordTitle(r);
      } else {
        setMark('', null);
      }
    }
    setText(peekText, text);
    setText(peekValue, value);
    setAttr(peekValue, 'data-tone', tone);
  }
  const setTeamSwatch = team => {
    const s = el('span', { class: 'swatch' });
    setTeam(s, team);
    return s;
  };

  /** Selection comes forward for a target picked outside the lists, and
   *  goes back to where it came from when the selection clears. */
  function onSelected() {
    if (state.selected) {
      if (origin !== 'panel' && tab !== 'selection') {
        autoFrom = tab;
        setTab('selection');
      }
    } else if (autoFrom) {
      const back = autoFrom;
      autoFrom = null;
      setTab(back);
    }
  }

  // Escape in the panel: collapse the sheet, else clear the selection.
  root.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (PHONE.matches && sheet.size() !== 'peek') return; // the sheet's own handler collapses it
    if (state.selected) {
      e.preventDefault();
      select(null);
    }
  });

  // The map's hover lights the matching row and chip.
  let hovered = null;
  function paintHover() {
    const h = state.hovered?.handle ?? null;
    if (h === hovered) return;
    for (const node of root.querySelectorAll('[data-hovered]')) node.removeAttribute('data-hovered');
    for (const node of legendBar.querySelectorAll('[data-hovered]')) node.removeAttribute('data-hovered');
    hovered = h;
    if (!h) return;
    const sel = `[data-handle="${CSS.escape(h)}"]`;
    for (const node of root.querySelectorAll(sel)) node.setAttribute('data-hovered', '');
    for (const node of legendBar.querySelectorAll(sel)) node.setAttribute('data-hovered', '');
  }

  function paintAll() {
    counts.players = paintRoster();
    counts.timers = paintTimers();
    paintSelection();
    paintLegend();
    syncTabs();
    paintPeek();
  }

  paintAll();
  subscribe(changed => {
    if (changed.has('selected')) onSelected();
    const snap = changed.has('snapshot') || changed.has('feed');
    const view = changed.has('view.team') || changed.has('view.focus') || changed.has('view.labels') || changed.has('view.layout')
      || changed.has('view.observed');
    if (snap || view || changed.has('selected')) counts.players = paintRoster();
    if (snap || changed.has('selected') || changed.has('atlas')) counts.timers = paintTimers();
    if (snap || view || changed.has('selected') || changed.has('atlas')) paintSelection();
    if (snap || view || changed.has('selected')) paintLegend();
    if (snap || view || changed.has('selected') || changed.has('atlas')) { syncTabs(); paintPeek(); }
    if (snap || changed.has('age') || changed.has('view.paused')) feed.paint();
    if (snap || changed.has('hovered')) paintHover();
  });
}
