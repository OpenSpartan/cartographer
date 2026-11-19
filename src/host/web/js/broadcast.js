// The broadcast layout's match strip (body[data-layout=broadcast]), a
// stream overlay: the map and the mode on the left, the score in the
// middle as Films' joined cells (a team's tint and 3px rule, the leader's
// brighter, 'Won' once the match is over, a pip per player: filled alive,
// hollow dead, and while the map numbers players each pip holds the
// player's number, in number order, the highlighted player's ringed) with
// the clock as a neutral cell between two teams, and on
// the right the feed's state as a dot and a word. When the feed is down
// the strip says so calmly in place of the operator's notice. Nothing
// technical reaches the stream. broadcast.css hides the operator chrome
// in this layout and sizes everything from --bc. A link back to the
// operator view sits bottom right, unseen until hovered or focused.
//
// Also the map-only layout (body[data-layout=map], ?layout=map, M and
// Escape in main.js): broadcast.css hides everything but the stage. This
// adds its exit button (bottom right, unseen until hovered or focused) and
// the transparent background (?bg=transparent, T in main.js), which drops
// the page's background in that layout so the map can sit over a scene in
// OBS (the floor plan stays opaque, or as opaque as ?alpha=0..255 says:
// map.js).

import { state, subscribe, mapOnly, broadcastMode, numbered, litPlayer } from './state.js';
import { el, setText, setFigures, setAttr, icon, cellRow, scoreCell } from './dom.js';
import { mapTitle, matchContext, modeName, teamsOf, clockText, feedTag, playerNumbers } from './model.js';
import { modeIcon } from './modes.js';
import { teamEmblem } from './teams.js';
import { keycap } from './controls.js';

/** life_cycle to the strip's phase (model.js phaseOf, as keys). */
const PHASES = { 7: 'lobby', 8: 'lobby', 9: 'live', 10: 'post', 11: 'loading' };
const phaseKey = snapshot => PHASES[snapshot?.life_cycle] ?? 'other';

/** More teams than this and the cells drop the names (the rule's colour
 *  still says whose cell it is). */
const NAMED_TEAMS = 4;

/** The teams to draw, with the leader (one team ahead of the rest, else
 *  null: everybody is bright on a tie) and the winner (the leader once the
 *  match is over). */
function standings(snapshot, phase) {
  const teams = teamsOf(snapshot);
  const scored = teams.filter(t => Number.isFinite(t.score));
  const top = scored.length ? Math.max(...scored.map(t => t.score)) : null;
  const ahead = top === null ? [] : scored.filter(t => t.score === top);
  const leader = teams.length > 1 && ahead.length === 1 ? ahead[0] : null;
  return { teams, leader, winner: phase === 'post' ? leader : null };
}

/** One team's cell: the name over a line of pips (or, for the winner
 *  once the match is over, 'Won'), then the score. Every part keeps its
 *  width while the numbers change: the pip line is as wide as the biggest
 *  team's (--bs-n), the score three figures wide. Pips go alive first, or
 *  with `nums` (handle to number) by number, each holding its number, the
 *  `lit` player's ringed. */
function teamCell(team, bright, won, named, nums, lit) {
  const players = nums
    ? [...team.players].sort((a, b) => (nums.get(a.handle) ?? Infinity) - (nums.get(b.handle) ?? Infinity))
    : [...team.players].sort((a, b) => Number(b.alive) - Number(a.alive));
  const said = nums ? `, ${players.map(p => `${nums.get(p.handle) ?? ''} ${p.alive ? 'alive' : 'dead'}`).join(', ')}` : '';
  const sub = won
    ? el('span', { class: 'bs-sub' }, el('span', { class: 'bs-won caps' }, 'Won'))
    : el('span', { class: 'bs-sub', role: 'img', 'aria-label': `${team.alive} of ${players.length} alive${said}` },
      players.map(p => el('span', {
        class: 'bs-pip num', dataset: { alive: p.alive ? '' : null, lit: nums && p.handle === lit ? '' : null },
      }, nums ? String(nums.get(p.handle) ?? '') : null)));
  const emblem = teamEmblem(18);
  emblem.set(team.id);
  return scoreCell(team.id, bright, emblem.el,
    el('span', { class: 'bs-team' }, named ? el('span', { class: 'bs-name truncate' }, team.name) : null, sub),
    el('span', { class: 'bs-value num' }, Number.isFinite(team.score) ? String(team.score) : ''));
}

/** The feed's state as the strip shows it: model.js feedTag's word and
 *  tone (the one wording every view uses), its tone as a state-dot tone,
 *  and its line under the word while the feed is down. The age is counted
 *  here to the second, in feedTag's whole-second format, so the stale line
 *  ticks between polls (a hung request takes two seconds to fail). */
function feedLine(s) {
  const age = s.receivedAt ? Math.floor((Date.now() - s.receivedAt) / 1000) : s.age;
  const tag = feedTag({ ...s, age });
  const down = s.feed === 'stale' || s.feed === 'error' || s.feed === 'waiting';
  return {
    text: tag.text,
    tone: tag.tone === 'info' ? 'accent' : tag.tone,
    busy: Boolean(tag.busy),
    detail: down && tag.line && tag.line !== tag.text ? tag.line : '',
  };
}

export function mount(root) {
  const title = el('strong', { class: 'bs-title truncate' });
  // The mode's Films icon (modes.js), hidden until it loads, by
  // the mode and round.
  const modeSlot = el('span', { class: 'bs-mode' });
  const contextText = el('span', { class: 'caps truncate' });
  const context = el('span', { class: 'bs-context' }, modeSlot, contextText);
  const identity = el('div', { class: 'bs-id' }, title, context);
  let modeKey = null;

  const score = el('div', { class: 'bs-score' });
  const clockValue = el('span', { class: 'bs-clock-value num' });
  const clock = el('span', { class: 'cell bs-clock', title: 'Elapsed' },
    el('span', { class: 'sr-only' }, 'Elapsed'), clockValue);

  const lead = el('span', { class: 'bs-lead' });
  const word = el('span', { class: 'bs-word' });
  const detail = el('span', { class: 'bs-detail truncate' });
  const status = el('div', { class: 'bs-status' },
    el('span', { class: 'bs-state', role: 'status' }, lead, word), detail);

  root.replaceChildren(identity, score, status);

  // Back to the operator view: out of sight until hovered or focused, so
  // the stream never shows it.
  const back = el('button', {
    type: 'button', class: 'btn bs-return', dataset: { variant: 'secondary', size: 'sm' },
    title: 'Exit broadcast. B or Escape.', 'aria-keyshortcuts': 'B Escape',
  }, icon('operator', 12), el('span', { class: 'label' }, 'Exit broadcast'), keycap('B'), keycap('Escape'));
  back.addEventListener('click', () => broadcastMode(false));
  document.body.append(back);

  let rowKey = '';
  let leadKey = '';

  const paintStatus = () => {
    const f = feedLine(state);
    // The score may be old: dim it (broadcast.css).
    setAttr(root, 'data-down', state.feed === 'stale' || state.feed === 'error' ? '' : null);
    const key = `${f.busy ? 'busy' : f.tone}`;
    if (key !== leadKey) {
      leadKey = key;
      if (f.busy) {
        const s = icon('sync', 16);
        s.classList.add('spin');
        lead.replaceChildren(s);
      } else {
        lead.replaceChildren(el('span', { class: 'state-dot', dataset: { tone: f.tone }, 'aria-hidden': 'true' }));
      }
    }
    setText(word, f.text);
    setText(detail, f.detail);
  };

  const paint = () => {
    if (state.view.layout !== 'broadcast') return;
    const snap = state.snapshot;
    // No session to show: nothing has arrived yet, or the server says the
    // game is not running. An old snapshot's score would mislead.
    const idle = !snap || state.feed === 'waiting';
    const phase = idle ? 'idle' : phaseKey(snap);

    setText(title, idle ? 'Waiting for match' : mapTitle(snap) || state.geometry.title || 'Waiting for match');
    setText(contextText, idle ? '' : matchContext(snap).join(', '));
    const mode = idle ? null : modeName(snap);
    const gameMode = idle ? null : snap.match_info?.game_mode ?? null;
    if (`${gameMode}|${mode}` !== modeKey) {
      modeKey = `${gameMode}|${mode}`;
      modeSlot.replaceChildren(...(mode ? [modeIcon(gameMode, 18)] : []));
    }
    context.hidden = !contextText.textContent;

    const c = idle ? null : clockText(snap.match_info?.elapsed_seconds);
    setFigures(clockValue, c ?? '');

    const { teams, leader, winner } = idle ? { teams: [], leader: null, winner: null } : standings(snap, phase);
    const named = teams.length <= NAMED_TEAMS;
    const nums = !idle && numbered() ? playerNumbers(snap, state.epoch) : null;
    const lit = nums ? litPlayer(snap) : null;
    const key = JSON.stringify([
      teams.map(t => [t.id, t.name, t.score, t.players.map(p => [p.alive, nums?.get(p.handle) ?? null])]),
      leader?.id ?? null, winner?.id ?? null, c !== null, lit,
    ]);
    if (key !== rowKey) {
      rowKey = key;
      const cells = teams.map(t => teamCell(t, !leader || leader === t, winner === t, named, nums, lit));
      if (c !== null) cells.splice(teams.length === 2 ? 1 : cells.length, 0, clock);
      if (!cells.length) {
        score.replaceChildren();
      } else {
        const row = cellRow({}, ...cells);
        row.classList.add('bs-cells');
        row.setAttribute('role', 'group');
        const said = teams.filter(t => Number.isFinite(t.score)).map(t => `${t.name} ${t.score}`);
        row.setAttribute('aria-label', said.length
          ? `Score: ${said.join(', ')}.${winner ? ` ${winner.name} won.` : ''}` : 'Teams');
        // Teams share the width evenly, the clock takes what it needs, so
        // between two teams it sits in the middle of the strip.
        row.style.gridTemplateColumns = cells.map(x => (x === clock ? 'auto' : '1fr')).join(' ');
        row.style.setProperty('--bs-n', String(Math.max(1, ...teams.map(t => t.players.length))));
        setAttr(row, 'data-many', named ? null : '');
        setAttr(row, 'data-numbers', nums ? '' : null);
        score.replaceChildren(row);
      }
    }

    paintStatus();
  };

  // Map only: the way out, and the transparent background on request.
  const exit = el('button', {
    type: 'button', class: 'btn mo-exit', dataset: { variant: 'secondary', size: 'sm' },
    title: 'Exit map only. M or Escape. T turns the background transparent.', 'aria-keyshortcuts': 'M Escape',
  }, icon('x', 12), el('span', { class: 'label' }, 'Exit map only'), keycap('M'), keycap('Escape'));
  exit.addEventListener('click', () => mapOnly(false));
  document.body.append(exit);
  // On <html> too (its background is the page's first paint), and only
  // while the map stands alone: the other layouts keep theirs.
  const paintBackground = () => {
    const on = state.view.transparent && state.view.layout === 'map';
    setAttr(document.documentElement, 'data-bg', on ? 'transparent' : null);
    setAttr(document.body, 'data-bg', on ? 'transparent' : null);
  };

  paint();
  paintBackground();
  subscribe(changed => {
    if (changed.has('snapshot') || changed.has('feed') || changed.has('geometry') || changed.has('view.layout')
      || changed.has('view.labels') || changed.has('view.focus') || changed.has('view.observed')) paint();
    if (changed.has('view.layout') || changed.has('view.transparent')) paintBackground();
  });
  // While the feed is stale, count the seconds between polls.
  setInterval(() => {
    if (state.view.layout === 'broadcast' && state.feed === 'stale') paintStatus();
  }, 1000);
}
