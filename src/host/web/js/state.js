// The single store. Every view reads `state` and subscribes. Writes go
// through set(), setView(), select() and hover(), which tell subscribers
// which keys changed so a view can skip work it does not need.
//
// Changed keys are top-level names ('snapshot', 'feed', 'selected', ...),
// plus 'view' and 'view.<option>' ('view.zoom') for view changes.

import { resolveTarget, sameTarget, playerNumbers } from './model.js';

/** View options with fixed choices (the first is the default). */
const VIEW_CHOICES = {
  layout: ['operator', 'broadcast', 'map'],
  filter: ['tactical', 'all', 'players', 'pads'],
  framing: ['auto', 'locked'],
  orientation: ['auto', 'y', 'x', '-y', '-x'],
  heightMode: ['all', 'player', 'slice'],
  labels: [null, 'names', 'numbers'],
  marker: ['disc', 'arrow'],
  firing: ['lines', 'trace', 'off'],
};

/** Zoom limits and the slider's step. */
export const ZOOM = { min: 0.5, max: 5, step: 0.1 };

/** The highest player number the observed pick takes. */
const MAX_NUMBER = 99;

/** The view's defaults. focus: a player handle or null, team: a team id or
 *  null, level: 'auto' or a level id, elevation: feet (the slice),
 *  transparent: no page background while the map stands alone. labels:
 *  what names a player on the map, 'names' or 'numbers', or null for the
 *  layout's own (labelMode()). marker: a player's mark, 'disc' (with a soft
 *  cone along the aim) or 'arrow' (a teardrop pointing along the aim).
 *  firing: what a shot draws, 'lines' round the mark, 'trace' (the lines
 *  and a dashed line along the aim) or 'off'. contrast: marks outlined to
 *  stand out on any floor. observed: the number (playerNumbers) of the
 *  player the operator says the game's observer watches, or null. data:
 *  the floor drawn as what each part of it is (dataview.js), for checking
 *  the map data. */
const DEFAULT_VIEW = Object.freeze({
  layout: 'operator',
  filter: 'tactical',
  framing: 'auto',
  zoom: 1,
  trails: true,
  vitals: true,
  paused: false,
  focus: null,
  team: null,
  level: 'auto',
  orientation: 'auto',
  floor: true,
  objectives: true,
  heightMode: 'all',
  elevation: 0,
  transparent: false,
  labels: null,
  marker: 'disc',
  firing: 'lines',
  contrast: false,
  observed: null,
  data: false,
});

/** The view options kept in the page address, by URL parameter. Each is
 *  left out while it holds its default. */
const URL_OPTIONS = { labels: 'labels', marker: 'marker', firing: 'firing', orientation: 'orientation' };

/** A player number from a key, a pick or the address, or null. */
function playerNumber(v) {
  const n = Number(v);
  return v !== null && v !== '' && Number.isInteger(n) && n >= 1 && n <= MAX_NUMBER ? n : null;
}

function viewFromUrl() {
  const params = new URLSearchParams(location.search);
  const layout = params.get('layout');
  const view = {
    layout: layout === 'broadcast' || layout === 'map' ? layout : 'operator',
    vitals: params.get('vitals') !== 'off',
    transparent: params.get('bg') === 'transparent',
    contrast: params.get('contrast') === 'high',
    observed: playerNumber(params.get('observed')),
    data: params.get('view') === 'data',
  };
  for (const [k, name] of Object.entries(URL_OPTIONS)) {
    const v = params.get(name);
    if (v && VIEW_CHOICES[k].includes(v)) view[k] = v;
  }
  return view;
}

export const state = {
  /** The latest snapshot (observer.rs Snapshot), or null before the first. */
  snapshot: null,
  /** Date.now() when that snapshot arrived, or 0 before the first. */
  receivedAt: 0,
  /** Seconds since then, to 0.1 s, or null before the first. */
  age: null,
  /** 'connecting' | 'live' | 'paused' | 'stale' | 'waiting' | 'blocked' | 'error' */
  feed: 'connecting',
  /** The last poll's error message, or null. */
  feedError: null,
  /** { kind: 'player'|'object', handle } or null. Resolve with selectedRecord(). */
  selected: null,
  /** The same for what the pointer is over (map or list). */
  hovered: null,
  /** View options: see DEFAULT_VIEW. */
  view: { ...DEFAULT_VIEW, ...viewFromUrl() },
  /** /api/levels: [{ id, name, title, floor_available }]. */
  levels: [],
  /** True when the level catalogue failed to load. */
  levelsError: false,
  /** The floor plan in use. status: 'none' | 'loading' | 'ready' | 'error'.
   *  plan: /api/geometry/<id> ({ level, rings: [{ p, z }] }), with terrain:
   *  its terrain ({ data, image }, main.js loadTerrain) or null. bounds: fit()
   *  of its rings. zMin, zMax: its height range, ft. title: the map's name.
   *  message: what to say about it ('Loading floor plan', ...). */
  geometry: { id: null, status: 'none', plan: null, bounds: null, zMin: 0, zMax: 0, title: null, message: 'Geometry unavailable' },
  /** The map variant's objective placements (/api/objectives/<asset>):
   *  { asset, objects: [{ modes, kind, x, y, z, team?, b?, yaw?, order? }],
   *  loading } (loading while the request is out). */
  objectives: { asset: null, objects: [], loading: false },
  /** Team colour picks (teams.js): { teamId: colour key }. */
  teamColors: {},
  /** The map floor's base colour (floorcolor.js): '#rrggbb', or null for
   *  the HUD's own. */
  floorColor: null,
  /** The item icon atlas once loaded (atlas.js), null before, false if it failed. */
  atlas: null,
  /** Bumped when the map changes or a match ends: trails, framing, pan and
   *  selection start over. */
  epoch: 0,
};

const subscribers = new Set();

/** Call `fn(changed, state)` after every change, where `changed` is a Set
 *  of keys. Returns the unsubscribe function. */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function notify(changed) {
  if (!changed.size) return;
  for (const fn of [...subscribers]) {
    try {
      fn(changed, state);
    } catch (error) {
      console.error(error);
    }
  }
}

/** Replace top-level keys (not 'view': use setView). Equal values are
 *  skipped, so set({ feed: 'live' }) every poll costs nothing. */
export function set(patch) {
  const changed = new Set();
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'view') throw new Error('Use setView() for view options');
    if (Object.is(state[k], v)) continue;
    state[k] = v;
    changed.add(k);
  }
  notify(changed);
  return changed;
}

function clean(k, v) {
  if (VIEW_CHOICES[k]) return VIEW_CHOICES[k].includes(v) ? v : state.view[k];
  if (k === 'zoom') return Math.round(Math.min(ZOOM.max, Math.max(ZOOM.min, Number(v) || 1)) * 100) / 100;
  if (k === 'trails' || k === 'vitals' || k === 'paused' || k === 'floor' || k === 'objectives' || k === 'transparent' || k === 'contrast' || k === 'data') return Boolean(v);
  if (k === 'focus') return v || null;
  if (k === 'team') return v === null || v === undefined || v === '' ? null : Number(v);
  if (k === 'level') return v || 'auto';
  // A slice stays within the plan's floors.
  if (k === 'elevation') {
    const g = state.geometry;
    const e = Number(v) || 0;
    return g.status === 'ready' ? Math.min(g.zMax, Math.max(g.zMin, e)) : e;
  }
  if (k === 'observed') return playerNumber(v);
  return v;
}

/** Change view options. A team filter that excludes the followed player
 *  stops following. The layout, vitals, background, the markers' options,
 *  the orientation, the observed player and the data view are kept in the
 *  URL (?layout=broadcast|map, ?vitals=off, ?bg=transparent,
 *  ?labels=names|numbers, ?marker=arrow, ?firing=trace|off,
 *  ?orientation=y|x|-y|-x, ?contrast=high, ?observed=3, ?view=data). */
export function setView(patch) {
  const next = { ...state.view };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_VIEW)) throw new Error(`Unknown view option: ${k}`);
    next[k] = clean(k, v);
  }
  if ('team' in patch && next.team !== null && next.focus) {
    const followed = state.snapshot?.players.find(p => p.handle === next.focus);
    if (followed && followed.team !== next.team) next.focus = null;
  }
  const changed = new Set();
  for (const k of Object.keys(next)) {
    if (!Object.is(next[k], state.view[k])) changed.add(`view.${k}`);
  }
  if (!changed.size) return changed;
  changed.add('view');
  state.view = next;
  const kept = Object.keys(URL_OPTIONS).some(k => changed.has(`view.${k}`)) || changed.has('view.contrast') || changed.has('view.observed') || changed.has('view.data');
  if (kept || changed.has('view.layout') || changed.has('view.vitals') || changed.has('view.transparent')) {
    const url = new URL(location.href);
    if (next.layout === 'operator') url.searchParams.delete('layout');
    else url.searchParams.set('layout', next.layout);
    if (changed.has('view.vitals')) url.searchParams.set('vitals', next.vitals ? 'on' : 'off');
    if (next.transparent) url.searchParams.set('bg', 'transparent');
    else url.searchParams.delete('bg');
    for (const [k, name] of Object.entries(URL_OPTIONS)) {
      if (next[k] === DEFAULT_VIEW[k]) url.searchParams.delete(name);
      else url.searchParams.set(name, next[k]);
    }
    if (next.contrast) url.searchParams.set('contrast', 'high');
    else url.searchParams.delete('contrast');
    if (next.observed !== null) url.searchParams.set('observed', String(next.observed));
    else url.searchParams.delete('observed');
    if (next.data) url.searchParams.set('view', 'data');
    else url.searchParams.delete('view');
    history.replaceState(null, '', url);
  }
  notify(changed);
  return changed;
}

let beforeMapOnly = 'operator';
/** Enter the map-only layout (true), go back to the layout it was entered
 *  from (false), or flip between them (no argument). The M key and the
 *  Map only buttons use this. */
export function mapOnly(on = state.view.layout !== 'map') {
  if (on && state.view.layout !== 'map') {
    beforeMapOnly = state.view.layout;
    setView({ layout: 'map' });
  } else if (!on && state.view.layout === 'map') {
    setView({ layout: beforeMapOnly });
  }
}

let beforeBroadcast = 'operator';
export function broadcastMode(on = state.view.layout !== 'broadcast') {
  if (on && state.view.layout !== 'broadcast') {
    beforeBroadcast = state.view.layout;
    setView({ layout: 'broadcast' });
  } else if (!on && state.view.layout === 'broadcast') {
    setView({ layout: beforeBroadcast });
  }
}

/** Select a target ({ kind, handle }) or nothing (null). */
export function select(target) {
  const t = target ? { kind: target.kind, handle: target.handle } : null;
  if (sameTarget(t, state.selected)) return;
  state.selected = t;
  notify(new Set(['selected']));
}

/** Mark what the pointer is over, or nothing. */
export function hover(target) {
  const t = target ? { kind: target.kind, handle: target.handle } : null;
  if (sameTarget(t, state.hovered)) return;
  state.hovered = t;
  notify(new Set(['hovered']));
}

/** The selected record in the latest snapshot, or null. */
export const selectedRecord = () => resolveTarget(state.snapshot, state.selected);

/** What names a player on the map: the pick, else the layout's own.
 *  Numbers stand alone in the map-only layout (a minimap source, where
 *  names are too small to read and crowd the marks), names everywhere
 *  else. */
export const labelMode = (view = state.view) => view.labels ?? (view.layout === 'map' ? 'numbers' : 'names');

/** True while players carry their numbers (the map, the roster, the
 *  legend and the broadcast strip all show them). */
export const numbered = (view = state.view) => labelMode(view) === 'numbers';

/** The handle of the player with number `n` (playerNumbers) in the latest
 *  snapshot, or null. */
export function numberedPlayer(n, snap = state.snapshot) {
  if (n === null || !snap) return null;
  for (const [handle, m] of playerNumbers(snap, state.epoch)) if (m === n) return handle;
  return null;
}

/** The player the map highlights with a white beam and ring: the one the
 *  operator observes (view.observed), else the followed player, else the
 *  one the snapshot says a spectator watches (snapshot.observed). A
 *  handle, or null. Observing never moves the camera, following does. */
export const litPlayer = (snap = state.snapshot, view = state.view) =>
  numberedPlayer(view.observed, snap) ?? view.focus ?? snap?.observed ?? null;

/** The followed player's record, or null. */
export const focusedPlayer = () =>
  state.view.focus ? state.snapshot?.players.find(p => p.handle === state.view.focus) ?? null : null;
