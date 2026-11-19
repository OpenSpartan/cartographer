// Boot: mount the views, load the map catalogue and the icon atlas, poll
// /api/snapshot every 250 ms (unless paused), work out how fresh the feed
// is, and load the floor plan of the map in play (or the one picked).
//
// The body carries the page's state for CSS: data-layout (operator,
// broadcast), data-feed (state.feed) and data-stale (true when the last
// snapshot is over 3 s old and the feed is not paused).

import { state, set, setView, subscribe, mapOnly, broadcastMode } from './state.js';
import { mapKey, fit, ringPoints, lobbyPlayers } from './model.js';
import { loadAtlas } from './atlas.js';
import { initTeamColors } from './teams.js';
import { initFloorColor } from './floorcolor.js';
import * as chrome from './chrome.js';
import * as panel from './panel.js';
import * as map from './map.js';
import * as broadcast from './broadcast.js';

const POLL_MS = 250;
const STALE_S = 3;
const FETCH_TIMEOUT_MS = 2000;

const body = document.body;

function paintBody() {
  body.dataset.layout = state.view.layout;
  body.dataset.feed = state.feed;
  body.dataset.stale = String(state.feed === 'stale');
  body.dataset.synthetic = String(state.snapshot?.consistency === 'synthetic_replay');
}

// ── Snapshot ────────────────────────────────────────────────────────────

let lastMatch = false;
let lastMapKey = null;
let failure = null; // { kind: waiting|blocked|timeout|error, message } from the last poll, or null

/** How long a reading may stand in for one the server could not take. */
const HOLD_MS = 1500;
/** The stats a gap is judged on. Shots are left out: a server that keeps
 *  no shot counts gives null for them in every read (observer.rs
 *  PlayerStats), which is no gap. */
const HELD_STATS = ['kills', 'deaths', 'assists', 'objective_score'];
/** The last time each held reading was really read: 'clock', or a player handle. */
const readAt = new Map();

/** Fill one-off gaps in a live read from the previous snapshot. The reader
 *  sometimes misses, for a single sample, the game clock (and with it the
 *  round, so round scores, and every pad countdown) or a living player's
 *  vitality (a component caught mid-update). Drawn as is, the clock, scores,
 *  timers and health and shield bars blink. A reading missing for under
 *  HOLD_MS keeps its last real value. After that the gap shows. Nothing is
 *  estimated, and the same match only (same unit for vitality, same state
 *  and item for a pad). */
function holdGaps(snapshot, previous) {
  const now = Date.now();
  const recent = key => now - (readAt.get(key) ?? -Infinity) < HOLD_MS;
  const same = previous && previous.in_match && snapshot.in_match && mapKey(previous) === mapKey(snapshot);
  const known = value => value !== null && value !== undefined;
  if (snapshot.match_info) readAt.set('clock', now);
  else if (same && previous.match_info && recent('clock')) {
    snapshot.match_info = previous.match_info;
    snapshot.game_time_seconds ??= previous.game_time_seconds;
  }
  const players = same ? new Map(previous.players.map(p => [p.handle, p])) : new Map();
  for (const p of snapshot.players) {
    const last = players.get(p.handle);
    // Kills, deaths, assists and score: a read that missed some keeps the
    // last ones (and the last shot counts with them).
    if (p.stats && HELD_STATS.every(k => known(p.stats[k]))) readAt.set(`stats:${p.handle}`, now);
    else if (last?.stats && recent(`stats:${p.handle}`)) {
      p.stats = { ...last.stats, ...Object.fromEntries(Object.entries(p.stats ?? {}).filter(([, v]) => known(v))) };
    }
    if (p.vitality) { readAt.set(p.handle, now); continue; }
    if (p.alive && last?.alive && last.vitality && last.unit === p.unit && recent(p.handle)) p.vitality = last.vitality;
  }
  const scores = same ? new Map((previous.team_scores ?? []).map(s => [s.team, s])) : new Map();
  snapshot.team_scores ??= [];
  for (const s of snapshot.team_scores) {
    if (known(s.round_score)) { readAt.set(`score:${s.team}`, now); continue; }
    const last = scores.get(s.team);
    if (known(last?.round_score) && recent(`score:${s.team}`)) s.round_score = last.round_score;
  }
  for (const [team, last] of scores) {
    if (!snapshot.team_scores.some(s => s.team === team) && recent(`score:${team}`)) snapshot.team_scores.push(last);
  }
  // A pad the read missed this time (the object, or its spawner data) stays as it was.
  const padObjects = same ? previous.objects.filter(o => o.stock_spawner || o.dispenser) : [];
  const now_ = new Map(snapshot.objects.map(o => [o.handle, o]));
  for (const last of padObjects) {
    const current = now_.get(last.handle);
    if (current && (current.stock_spawner || current.dispenser)) { readAt.set(`padobj:${last.handle}`, now); continue; }
    if (!recent(`padobj:${last.handle}`)) continue;
    if (current) {
      current.stock_spawner ??= last.stock_spawner;
      current.dispenser ??= last.dispenser;
    } else {
      snapshot.objects.push(last);
    }
  }
  const pads = same ? new Map(previous.objects.filter(o => o.stock_spawner).map(o => [o.handle, o.stock_spawner])) : new Map();
  for (const o of snapshot.objects) {
    const spawn = o.stock_spawner;
    if (!spawn) continue;
    if (known(spawn.seconds_left)) { readAt.set(`pad:${o.handle}`, now); continue; }
    const last = pads.get(o.handle);
    if (known(last?.seconds_left) && last.state === spawn.state && last.item_name === spawn.item_name && recent(`pad:${o.handle}`)) {
      spawn.seconds_left = last.seconds_left;
    }
  }
  return snapshot;
}

/** Take a new snapshot: a fresh start when the map changes or the match
 *  ends, and drop a selection, focus or team filter that no longer
 *  exists. */
function receive(data) {
  const snapshot = holdGaps(data, state.snapshot);
  // Before the match the roster is the lobby's (members and bots per team).
  if (!snapshot.in_match && !snapshot.players.length && snapshot.lobby) snapshot.players = lobbyPlayers(snapshot.lobby);
  const key = mapKey(snapshot);
  const fresh = (!snapshot.in_match && lastMatch) || (lastMapKey !== null && key !== lastMapKey);
  lastMatch = snapshot.in_match;
  lastMapKey = key;
  const patch = { snapshot, receivedAt: Date.now(), age: 0, feedError: null };
  if (fresh) {
    patch.epoch = state.epoch + 1;
    patch.selected = null;
    patch.hovered = null;
  } else {
    const has = t => t && (t.kind === 'player' ? snapshot.players : snapshot.objects).some(r => r.handle === t.handle);
    if (state.selected && !has(state.selected)) patch.selected = null;
    if (state.hovered && !has(state.hovered)) patch.hovered = null;
  }
  failure = null;
  set(patch);

  const v = {};
  if (state.view.focus && !snapshot.players.some(p => p.handle === state.view.focus)) v.focus = null;
  if (state.view.team !== null && !snapshot.players.some(p => p.team === state.view.team)) v.team = null;
  if (Object.keys(v).length) setView(v);
  requestGeometry();
  requestObjectives();
}

/** The feed's state from the last poll and the snapshot's age (whole
 *  seconds). A server that says it has no game is waiting. An observer that
 *  can't be reached or answers with an error is an error, and stays one. A
 *  slow answer is only a hiccup until the snapshot is STALE_S old. */
function freshness() {
  const since = state.receivedAt ? (Date.now() - state.receivedAt) / 1000 : null;
  const feed = state.view.paused ? 'paused'
    : failure?.kind === 'waiting' ? 'waiting'
    : failure?.kind === 'blocked' ? 'blocked'
    : failure?.kind === 'error' ? 'error'
    : since !== null && since > STALE_S ? 'stale'
    : state.snapshot ? 'live'
    : 'connecting';
  set({ age: since === null ? null : Math.floor(since), feed, feedError: failure?.message ?? null });
}

async function poll() {
  const started = performance.now();
  // A request that hangs fails after this long, so a stuck server still
  // turns the feed stale instead of freezing the poll loop.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    if (!state.view.paused) {
      const response = await fetch('/api/snapshot', { cache: 'no-store', signal: abort.signal });
      const data = await response.json();
      if (!response.ok) {
        // A transient miss (the match changed under the read) is a hiccup like a
        // slow answer: the snapshot stays until it is STALE_S old.
        failure = { kind: data.transient ? 'transient' : data.waiting_for_server ? 'waiting' : data.server_error ? 'blocked' : 'error', message: data.error || 'Snapshot unavailable' };
      } else {
        // Back after the observer was unreachable (restarted, maybe rebuilt): its icon
        // index and map catalogue may have changed, so the page loads them again.
        if (failure?.kind === 'error' || failure?.kind === 'blocked') loadCatalogues();
        receive(data);
      }
    }
  } catch (error) {
    failure = error?.name === 'AbortError'
      ? { kind: 'timeout', message: 'The observer did not answer in time.' }
      : { kind: 'error', message: error instanceof Error ? error.message : 'Snapshot unavailable' };
  } finally {
    clearTimeout(timer);
    freshness();
    // A steady cadence from each poll's start, so snapshots arrive evenly.
    setTimeout(poll, Math.max(0, POLL_MS - (performance.now() - started)));
  }
}

// Ages tick on their own clock too, not only when a slow poll settles.
setInterval(freshness, 500);

// ── Map catalogue and floor plans ───────────────────────────────────────

async function loadLevels() {
  try {
    const response = await fetch('/api/levels');
    if (!response.ok) throw new Error('Map catalogue unavailable');
    const levels = await response.json();
    set({ levels: Array.isArray(levels) ? levels : [], levelsError: false });
  } catch {
    set({ levelsError: true });
    if (state.geometry.status === 'none') set({ geometry: { ...state.geometry, message: 'Map catalogue unavailable' } });
  }
}

/** The map catalogue and the item icon atlas, both read from the observer. */
function loadCatalogues() {
  loadLevels();
  // false once it failed, so the map stops waiting for it.
  loadAtlas().then(atlas => set({ atlas: atlas ?? false }));
}

let objectivesRequest = 0;

/** Load the objective placements of the map variant in play, once per
 *  variant. A map with none (or an older server) has an empty list. */
async function requestObjectives() {
  const asset = state.snapshot?.map_variant?.asset_id ?? null;
  if (asset === state.objectives.asset) return;
  const request = ++objectivesRequest;
  set({ objectives: { asset, objects: [], loading: Boolean(asset) } });
  if (!asset) return;
  try {
    const response = await fetch(`/api/objectives/${encodeURIComponent(asset)}`);
    const found = response.ok ? await response.json() : null;
    if (request === objectivesRequest) set({ objectives: { asset, objects: found?.objects ?? [] } });
  } catch {
    // Unreachable for now: ask again with the next snapshot.
    if (request === objectivesRequest) set({ objectives: { asset: null, objects: [] } });
  }
}

let geometryRequest = 0;

/** A map's terrain (/api/terrain/<id>, films-ui floor.ts): { data, image,
 *  heights }, or null when it has none or it fails to load. heights: its
 *  height image (terrain.js) as its exact bytes, or null when it has none
 *  or it fails to load. */
async function loadTerrain(id) {
  try {
    const response = await fetch(`/api/terrain/${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    const data = await response.json();
    const image = new Image();
    image.src = `/api/terrain/${encodeURIComponent(id)}.png`;
    const heights = data.height ? loadHeights(id) : null;
    await image.decode();
    return { data, image, heights: await heights };
  } catch {
    return null;
  }
}

/** A map's height image (/api/terrain/<id>.height.png), its bytes as they
 *  are (no colour management), or null. */
async function loadHeights(id) {
  try {
    const response = await fetch(`/api/terrain/${encodeURIComponent(id)}.height.png`);
    if (!response.ok) return null;
    return await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  } catch {
    return null;
  }
}

/** Load the floor plan of the picked map, or the one in play when the pick
 *  is Automatic. Does nothing while that plan is already the current one. */
async function requestGeometry() {
  // The server names the plan to load (a Forge map's own, else the level's).
  // Replayed captures predate geometry_id and fall back to the level.
  const id = state.view.level === 'auto' ? state.snapshot?.geometry_id ?? state.snapshot?.map?.level_id ?? null : state.view.level;
  if (id === state.geometry.id && state.geometry.status !== 'none') return;
  if (id === null && state.geometry.id === null && state.geometry.status === 'none' && state.geometry.plan === null) {
    // Still nothing to load. Only the message can change.
    const message = state.levelsError ? 'Map catalogue unavailable'
      : state.snapshot?.map?.engine_path ? 'No catalogued floor plan' : 'Geometry unavailable';
    if (message !== state.geometry.message) set({ geometry: { ...state.geometry, message } });
    return;
  }
  const request = ++geometryRequest;
  if (!id) {
    set({
      geometry: {
        id: null, status: 'none', plan: null, bounds: null, zMin: 0, zMax: 0, title: null,
        message: state.snapshot?.map?.engine_path ? 'No catalogued floor plan' : 'Geometry unavailable',
      },
    });
    return;
  }
  set({ geometry: { id, status: 'loading', plan: null, bounds: null, zMin: 0, zMax: 0, title: null, message: 'Loading floor plan' } });
  // The terrain comes with the plan, so the floor is drawn once, in its
  // final look. Without one the plan's own bands stand in.
  const terrain = loadTerrain(id);
  try {
    const response = await fetch(`/api/geometry/${encodeURIComponent(id)}`);
    const plan = await response.json();
    if (!response.ok) throw new Error('Floor plan unavailable');
    plan.terrain = await terrain;
    if (request !== geometryRequest) return;
    // The floors' height range (their holes left out), the elevation slider's.
    const heights = plan.rings.filter(r => !r.hole).flatMap(r => r.z);
    const zMin = Math.floor(Math.min(...heights));
    const zMax = Math.ceil(Math.max(...heights));
    // A studio level's plan for one mode is the level's id and the mode: c7d52145.infection.
    const title = state.levels.find(l => l.id === id.split('.')[0])?.title ?? plan.level;
    // Orientation goes by the level's frame, round every mode's plan, so a
    // map turns the same way whichever mode is in play.
    const f = plan.frame;
    const bounds = f ? fit([{ x: f[0], y: f[1] }, { x: f[2], y: f[3] }]) : fit(plan.rings.flatMap(ringPoints));
    set({
      geometry: {
        id, status: 'ready', plan, bounds,
        zMin, zMax, title, message: 'Navigation floor',
      },
    });
    setView({ elevation: Math.round((zMin + zMax) / 2) });
  } catch (error) {
    if (request !== geometryRequest) return;
    set({ geometry: { id, status: 'error', plan: null, bounds: null, zMin: 0, zMax: 0, title: null, message: error.message || 'Floor plan unavailable' } });
  }
}

// ── Boot ────────────────────────────────────────────────────────────────

subscribe(changed => {
  if (changed.has('view.layout') || changed.has('feed')) paintBody();
  if (changed.has('view.level')) requestGeometry();
  // Pausing or resuming shows at once rather than on the next poll.
  if (changed.has('view.paused')) freshness();
});

// Layout shortcuts leave editable controls and modified keys alone. The
// number keys pick the observed player by number (1 to 9, 0 for nobody),
// so an OBS browser source takes them through Interact. In an open menu or
// panel a figure is the menu's own (a size, a type-ahead), so it is left
// alone there. Escape lets go of the observed player first, then leaves
// the layout.
document.addEventListener('keydown', e => {
  if (e.repeat || e.isComposing || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]')) return;
  const popup = e.target instanceof HTMLElement && Boolean(e.target.closest('.float, [role=menu], [role=dialog]'));
  if (e.key === 'm' || e.key === 'M') mapOnly();
  else if (e.key === 'b' || e.key === 'B') broadcastMode();
  // The transparent background is the map-only layout's alone.
  else if ((e.key === 't' || e.key === 'T') && state.view.layout === 'map') setView({ transparent: !state.view.transparent });
  else if (/^[0-9]$/.test(e.key) && !popup) setView({ observed: e.key === '0' ? null : Number(e.key) });
  else if (e.key === 'Escape' && state.view.observed !== null && !popup) setView({ observed: null });
  else if (e.key === 'Escape' && state.view.layout === 'map') mapOnly(false);
  else if (e.key === 'Escape' && state.view.layout === 'broadcast') broadcastMode(false);
  else return;
  e.preventDefault();
});

paintBody();
initTeamColors();
initFloorColor();
chrome.mount({
  appbar: document.getElementById('appbar'),
  masthead: document.getElementById('masthead'),
  ribbon: document.getElementById('ribbon'),
  livebar: document.getElementById('livebar'),
});
map.mount(document.getElementById('stage'));
panel.mount(document.getElementById('panel'), document.getElementById('legend'));
broadcast.mount(document.getElementById('broadcast'));

loadCatalogues();
poll();
