// Team colours: Halo Infinite's selectable team colours (okom.one's
// observer guide lists them with their hex), picked per team. The picks
// live in the page address (?team1=vermillion&team2=cerulean, 1-based like
// the game's Team 1 and Team 2), so a browser source given the same address
// shows the same colours. A team with no pick keeps its token (tokens.css).
//
// A pick sets --team-N and its two tints (-08, -22) on <html>, clears the
// token cache the canvas reads through, and sets state.teamColors so the
// views repaint. Every team also gets --team-N-ink, the text colour that
// reads on its colour (a player's number on its tile).

import { state, set } from './state.js';
import { resetTokens, token } from './dom.js';
import { inkOn } from './model.js';
import { setTeamColor as setSharedTeamColor } from '/ui/tokens.js';

/** In the guide's order (pairs of a lighter and a deeper shade). */
export const TEAM_COLORS = [
  { key: 'carrot', name: 'Carrot', hex: '#682616' },
  { key: 'tangelo', name: 'Tangelo', hex: '#671601' },
  { key: 'salmon', name: 'Salmon', hex: '#791616' },
  { key: 'vermillion', name: 'Vermillion', hex: '#661a1a' },
  { key: 'cottoncandy', name: 'Cotton Candy', hex: '#77476e' },
  { key: 'cerise', name: 'Cerise', hex: '#5c1650' },
  { key: 'lavender', name: 'Lavender', hex: '#412d4f' },
  { key: 'aubergine', name: 'Aubergine', hex: '#40165c' },
  { key: 'sky', name: 'Sky', hex: '#1e5679' },
  { key: 'cerulean', name: 'Cerulean', hex: '#17497a' },
  { key: 'jade', name: 'Jade', hex: '#3f7a59' },
  { key: 'mint', name: 'Mint', hex: '#0b7138' },
  { key: 'grass', name: 'Grass', hex: '#4b672b' },
  { key: 'lime', name: 'Lime', hex: '#41710b' },
  { key: 'sunshine', name: 'Sunshine', hex: '#fcf55c' },
  { key: 'pineapple', name: 'Pineapple', hex: '#ffea00' },
];

/** Teams that can be given a colour: the eight team tokens. */
export const COLORED_TEAMS = 8;

/** 'Cotton Candy', 'cotton-candy' and 'cottoncandy' are one colour. */
const keyOf = name => String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
export const teamColorByKey = key => TEAM_COLORS.find(c => c.key === keyOf(key)) ?? null;

/** The address's picks: { teamId: key }. */
function fromUrl() {
  const params = new URLSearchParams(location.search);
  const picks = {};
  for (let id = 0; id < COLORED_TEAMS; id++) {
    const c = teamColorByKey(params.get(`team${id + 1}`));
    if (c) picks[id] = c.key;
  }
  return picks;
}

/** Tints as tokens.css precomputes them: 0.08 and 0.22 as hex alpha. */
function paint(picks) {
  const root = document.documentElement.style;
  for (let id = 0; id < COLORED_TEAMS; id++) {
    const c = teamColorByKey(picks[id]);
    setSharedTeamColor(id, c ? c.hex : null);
    if (c) {
      root.setProperty(`--team-${id}`, c.hex);
      root.setProperty(`--team-${id}-08`, `${c.hex}14`);
      root.setProperty(`--team-${id}-22`, `${c.hex}38`);
    } else {
      for (const name of [`--team-${id}`, `--team-${id}-08`, `--team-${id}-22`]) root.removeProperty(name);
    }
  }
  resetTokens();
  for (let id = 0; id < COLORED_TEAMS; id++) {
    root.setProperty(`--team-${id}-ink`, inkOn(token(`--team-${id}`), token('--hud-text'), token('--hud-ink')));
  }
}

/** Apply the address's picks, before the views mount. */
export function initTeamColors() {
  const picks = fromUrl();
  paint(picks);
  set({ teamColors: picks });
}

/** Give a team a colour by key, or its own back (null), and keep it in
 *  the address. */
export function setTeamColor(teamId, key) {
  const c = teamColorByKey(key);
  const picks = { ...state.teamColors };
  if (c) picks[teamId] = c.key;
  else delete picks[teamId];
  paint(picks);
  const url = new URL(location.href);
  if (c) url.searchParams.set(`team${teamId + 1}`, c.key);
  else url.searchParams.delete(`team${teamId + 1}`);
  history.replaceState(null, '', url);
  set({ teamColors: picks });
}

// ── Emblems ─────────────────────────────────────────────────────────────

let emblems;
/** Team id to its emblem's URL (/api/teams), fetched once. Empty when the
 *  server has none. */
const loadEmblems = () => emblems ??= fetch('/api/teams')
  .then(response => response.ok ? response.json() : null)
  .then(index => new Map((index?.icons ?? []).map(icon => [icon.index, icon.url])))
  .catch(() => new Map());

/** A team's emblem (Eagle, Cobra, ..., with 8 the observers'), `size`
 *  px square and decorative, the team's name beside it. It keeps its square
 *  while it loads and between teams, so nothing beside it moves. Its set(id)
 *  points it at a team, set(null) leaves the square empty. */
export function teamEmblem(size) {
  const img = document.createElement('img');
  img.className = 'team-emblem';
  img.alt = '';
  img.decoding = 'async';
  img.width = img.height = size;
  img.style.visibility = 'hidden';
  img.addEventListener('load', () => { img.style.visibility = ''; });
  let shown;
  return {
    el: img,
    set(teamId) {
      const id = Number.isInteger(teamId) && teamId >= 0 && teamId <= 8 ? teamId : null;
      if (id === shown) return;
      shown = id;
      img.style.visibility = 'hidden';
      if (id === null) { img.removeAttribute('src'); return; }
      void loadEmblems().then(map => {
        const url = map.get(id);
        if (shown !== id) return;
        if (url) img.src = url; else img.removeAttribute('src');
      });
    },
  };
}
