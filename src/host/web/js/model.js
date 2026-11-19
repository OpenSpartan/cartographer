// Pure helpers over the snapshot (observer.rs Snapshot, Player, Object,
// StockSpawner): labels, timers, teams, player numbers, what the view
// shows, trails and framing. No DOM except teamColor(), which reads the
// team tokens. playerNumbers() alone keeps state: the numbers it has handed
// out this match.
//
// Copy rules: no slashes as separators, no dash placeholders, sentence
// case. An unknown value is '' (or 'Unknown' where a word is needed).

import { token, fmt } from './dom.js';

/** Snapshot records: players have a slot, objects do not. */
export const isPlayer = record => Boolean(record) && 'slot' in record;

/** Spawn pads: objects with a stock spawner or a dispenser. */
export const isPad = object => Boolean(object?.stock_spawner || object?.dispenser);

export const playerLabel = player => player.name || `Player ${player.slot + 1}`;

/** The game's team names by team id (observer.rs TeamId::name). */
const TEAM_NAMES = ['Eagle', 'Cobra', 'Hades', 'Valkyrie', 'Rampart', 'Cutlass', 'Valor', 'Hazard'];

/** The lobby's roster as players (observer.rs Lobby): the session's members
 *  on their assigned teams, and as many bots per team as the game variant
 *  asks for, numbered (bots are named only once the match spawns them). The
 *  views draw them like a match's players. They have no position. */
export function lobbyPlayers(lobby) {
  const players = lobby.members.map(m => ({
    handle: `lobby:${m.slot}`, slot: m.slot, name: m.name, team: m.observer ? null : m.team ?? null,
    team_name: m.team_name, observer: m.observer, host: m.host, bot_handle: null, unit: null, position: null,
    alive: true, stats: null, vitality: null, average_life_seconds: null, lobby: true,
  }));
  let slot = 32;
  (lobby.bots?.per_team ?? []).forEach((count, team) => {
    for (let n = 1; n <= count; n++) {
      players.push({
        handle: `lobby-bot:${team}:${n}`, slot: slot++, name: `Bot ${n}`, team, team_name: TEAM_NAMES[team] ?? null, observer: false,
        host: false, bot_handle: `lobby-bot:${team}:${n}`, unit: null, position: null, alive: true, stats: null,
        vitality: null, average_life_seconds: null, lobby: true,
      });
    }
  });
  return players;
}

/** A pad's name: the game's display name, else a usable item name, else
 *  'Weapon 1234'. Dispensers without a spawner fall back to the handle. */
export function padLabel(pad) {
  const spawn = pad.stock_spawner;
  if (!spawn) return pad.handle;
  if (spawn.display_name) return spawn.display_name;
  if (spawn.item_name && !/^unused|^unknown|^none$/i.test(spawn.item_name)) return spawn.item_name;
  return `${spawn.category === 'weapon' ? 'Weapon' : 'Equipment'} ${spawn.item_identifier}`;
}

/** A record's title: a player's name, a pad's label, an object's kind. */
export function recordTitle(record) {
  if (isPlayer(record)) return playerLabel(record);
  if (isPad(record)) return padLabel(record);
  return fmt.words(record?.kind) || 'Object';
}

/** A spawner's countdown or state: '12.4 s', 'Ready', 'Restricted', or ''
 *  while incoming with no known countdown (padTimer's note says so). */
function stockTimerText(spawn) {
  if (spawn.state === 'ready') return 'Ready';
  if (spawn.state === 'restricted') return 'Restricted';
  if (spawn.seconds_left !== null && Number.isFinite(spawn.seconds_left)) return fmt.seconds(spawn.seconds_left);
  return spawn.state === 'incoming' ? '' : fmt.words(spawn.state);
}

/** observer.rs spawn_logic values as words. */
const SPAWN_LOGIC = {
  kit: 'Loadout kit',
  on_pickup: 'After pickup',
  on_expire: 'When it expires',
  fixed_interval: 'Fixed interval',
  external_trigger: 'Scripted trigger',
  unknown: 'Unknown',
};
export const spawnLogicText = logic => SPAWN_LOGIC[logic] ?? fmt.words(logic);

/** A pad's timer as one record, from its stock spawner or else the first
 *  dispenser slot in use: { category: 'weapon'|'equipment', state,
 *  remaining (s or null), cycle (s), duration (s, for progress), text (the
 *  value: '12.4 s', 'Ready', or '' when not known), note ('Timing not
 *  available' while incoming without a countdown, else ''), progress
 *  (0..1 while incoming with a known countdown, else null) }. */
export function padTimer(pad) {
  const spawn = pad.stock_spawner;
  const slot = pad.dispenser?.slots?.find(s => s.state !== 'none');
  const state = spawn?.state || slot?.state || 'unknown';
  const remaining = spawn?.seconds_left ?? slot?.seconds_left ?? null;
  const cycle = spawn?.respawn_seconds ?? slot?.start_seconds ?? 0;
  const duration = spawn?.incoming?.duration_seconds ?? spawn?.respawn_seconds ?? slot?.start_seconds ?? 0;
  const text = spawn ? stockTimerText(spawn)
    : state === 'ready' ? 'Ready'
    : Number.isFinite(remaining) ? fmt.seconds(remaining) : fmt.words(state === 'unknown' ? '' : state);
  const progress = state === 'incoming' && Number.isFinite(remaining)
    ? (duration > 0 ? Math.max(0, Math.min(1, 1 - remaining / duration)) : 0)
    : null;
  const note = state === 'incoming' && !Number.isFinite(remaining) ? 'Timing not available' : '';
  return { category: spawn?.category || 'equipment', state, remaining, cycle, duration, text, note, progress };
}

/** Whole seconds as m:ss, or null when there is nothing to show. */
export const clockText = seconds => fmt.clock(seconds);

/** The life cycle as a phase word. */
export function phaseOf(lifeCycle) {
  if (lifeCycle === 9) return 'Match live';
  if (lifeCycle === 10) return 'Post-match';
  if (lifeCycle === 11) return 'Loading';
  if (lifeCycle === 7 || lifeCycle === 8) return 'Lobby';
  return 'Transition';
}

/** The match's mode and round as text parts: ['Slayer', 'Round 2']. */
export function matchContext(snapshot) {
  const m = snapshot?.match_info;
  const parts = [];
  const mode = modeName(snapshot);
  if (mode) parts.push(mode);
  if (m?.round_index !== null && m?.round_index !== undefined) parts.push(`Round ${m.round_index + 1}`);
  return parts;
}

/** The one wording of each feed state, for every view. `text` is the short
 *  word (masthead tag, live bar, broadcast strip), `line` the sentence said
 *  once (the stage strip, or the map's empty state), `tone` its colour,
 *  `busy` a spinner. While the feed is live the word is the match phase. */
export function feedTag(s) {
  switch (s.feed) {
    case 'live': {
      if (s.snapshot?.consistency === 'synthetic_replay') return { text: 'Synthetic', tone: 'warn', line: null };
      const phase = phaseOf(s.snapshot?.life_cycle);
      if (phase === 'Match live') return { text: 'Live', tone: 'ok', line: null };
      return { text: phase === 'Transition' ? 'Loading' : phase, tone: 'muted', line: null };
    }
    case 'paused': return { text: 'Paused', tone: 'info', line: 'Paused' };
    case 'stale': return { text: 'Stale', tone: 'warn', line: `No update for ${s.age ?? 0} s` };
    case 'waiting': return { text: 'Waiting', tone: 'muted', line: 'Waiting for the LAN server' };
    case 'blocked': return { text: 'Blocked', tone: 'err', line: s.feedError || 'The LAN server could not be read' };
    case 'error': return { text: 'Offline', tone: 'err', line: 'The observer is not reachable' };
    default: return { text: 'Connecting', tone: 'muted', busy: true, line: 'Connecting to the observer' };
  }
}

/** The map's name as the snapshot gives it, or null. */
export const mapTitle = snapshot => snapshot?.map_variant?.name || snapshot?.map?.title || snapshot?.map?.engine_path || null;

/** What identifies the map, for noticing a change. */
export const mapKey = snapshot => snapshot?.map_variant?.asset_id ?? snapshot?.map?.level_id ?? snapshot?.map?.engine_path ?? null;

// ── Objectives ──────────────────────────────────────────────────────────

/** The placements' modes (objectives.rs) each game mode uses, by
 *  libfilmshell's GameMode (match_info.game_mode: the mode the variant's
 *  scripts run, as libfilmshell reads a film's), whatever the variant is
 *  called. Land Grab runs Strongholds' scripts and libfilmshell doesn't tell
 *  Total Control apart ('other'), so where a mode has more than one set the
 *  live zones pick it (zoneSet). Slayer and the rest show none. */
const PLACEMENT_MODES = {
  capture_the_flag: ['ctf'],
  oddball: ['oddball'],
  king_of_the_hill: ['koth'],
  firefight_king_of_the_hill: ['koth'],
  strongholds: ['strongholds', 'landgrab'],
  extraction: ['extraction'],
  other: ['totalcontrol', 'landgrab', 'strongholds'],
};

/** How near a zone's marker sits to its placement's centre, world units. */
export const ZONE_NEAR = 12;

/** Of `modes`' zone placements, the set the game's live zone markers stand
 *  on (the most of them). With no markers yet, the first mode's, unless the
 *  mode isn't known for its zones ('other'). */
function zoneSet(snapshot, placements, modes, known) {
  const markers = (snapshot?.navpoints ?? []).filter(n => n.kind === 'mp_control_area' && n.position);
  let best = known ? modes[0] : null, most = 0;
  for (const mode of modes) {
    const zones = placements.filter(o => o.kind === 'zone' && o.modes.includes(mode));
    const on = markers.filter(n => zones.some(o => Math.hypot(n.position.x - o.x, n.position.y - o.y) < ZONE_NEAR)).length;
    if (on > most) { best = mode; most = on; }
  }
  return best;
}

/** The placements' mode the match uses ('ctf', 'oddball', 'koth', ...), or
 *  null: from the game mode, and for zones from `placements` too. */
export function objectiveMode(snapshot, placements = []) {
  const modes = PLACEMENT_MODES[snapshot?.match_info?.game_mode];
  if (!modes) return null;
  return modes.length === 1 ? modes[0] : zoneSet(snapshot, placements, modes, snapshot.match_info.game_mode !== 'other');
}

/** The mode's name to show: the game mode's own (as Films shows a match's
 *  category, not its variant's name, which a custom variant can make
 *  anything: 'CPC'), else the variant's. */
export function modeName(snapshot) {
  const info = snapshot?.match_info;
  return (info?.game_mode !== 'other' && info?.game_mode_name) || info?.mode || null;
}

/** What an object is when carried, as libfilmshell names it (the server's
 *  tag.carried): flag, skull, ball, power_seed. */
const carriedAs = o => o.tag?.carried ?? null;

/** The machines that stand for a placement in a match, by name, as Films
 *  names its map devices (map.ts DEVICE_NAMES). */
const PLACED_NAMES = { flag_spawn: /Flag Spawn/, flag_plate: /^Flag Delivery Plate$/, ball_stand: /^Ball Stand/ };
const isStand = o => PLACED_NAMES.flag_spawn.test(o.tag?.name ?? '') || PLACED_NAMES.ball_stand.test(o.tag?.name ?? '');

/** The placements a match really uses: a flag stand, plate or ball stand
 *  only where the game has spawned its machine (a two-flag game leaves a
 *  map's neutral flag spawn empty, a one-flag game the teams'). A server
 *  too old to name tags shows every placement. */
export function inPlay(snapshot, placed) {
  if (!snapshot?.objects.some(o => o.tag)) return placed;
  return placed.filter(p => {
    const named = PLACED_NAMES[p.kind];
    return !named || snapshot.objects.some(o => o.position && named.test(o.tag?.name ?? '')
      && Math.hypot(o.position.x - p.x, o.position.y - p.y) < 4);
  });
}

/** The flags (or Oddball skulls, `balls`) in play: at home on a stand
 *  (attached to a machine at a flag spawn), carried (attached to a player's
 *  unit) or dropped (on its own). Known by what they are when carried
 *  (libfilmshell's Carried, the server's tag.carried). A server too old to
 *  name tags still works: whatever sits on a stand is a flag, and its
 *  definition then names every flag. `memory` keeps what was learned across
 *  snapshots: { defs: Set of definition handles, teams: Map of flag handle
 *  to its stand's team }. Returns [{ object, team, state:
 *  home|carried|dropped, carrier, stand }]. */
export function flagsOf(snapshot, spawns, memory, balls = false) {
  if (!snapshot) return [];
  const wanted = balls ? 'skull' : 'flag';
  const stands = new Map();
  for (const o of snapshot.objects) {
    if (o.kind !== 'machine' || !o.position) continue;
    const spawn = spawns.find(s => Math.hypot(o.position.x - s.x, o.position.y - s.y) < 4);
    if (spawn || isStand(o)) stands.set(o.handle, spawn ?? null);
  }
  for (const o of snapshot.objects) {
    if (o.kind !== 'weapon' || !stands.has(o.parent) || (o.tag && carriedAs(o) !== wanted)) continue;
    memory.defs.add(o.definition_handle);
    const team = stands.get(o.parent)?.team;
    if (team !== undefined) memory.teams.set(o.handle, team);
  }
  const units = new Map(snapshot.players.filter(p => p.unit).map(p => [p.unit, p]));
  // The game's own marker on a flag (or ball) names its team, wherever it is.
  const marked = new Map((snapshot.navpoints ?? []).filter(n => n.kind === 'mp_deliver_object' && n.team !== null && n.object)
    .map(n => [n.object, n.team]));
  return snapshot.objects
    .filter(o => o.kind === 'weapon' && o.position && (o.tag ? carriedAs(o) === wanted : memory.defs.has(o.definition_handle)))
    .map(o => ({
      object: o,
      team: marked.get(o.handle) ?? memory.teams.get(o.handle) ?? null,
      state: stands.has(o.parent) ? 'home' : units.has(o.parent) ? 'carried' : 'dropped',
      carrier: units.get(o.parent) ?? null,
      stand: stands.get(o.parent) ?? null,
    }));
}

// ── Teams and colours ───────────────────────────────────────────────────

/** A team's colour, resolved from --team-N (N = id mod 8). */
export const teamColor = teamId =>
  Number.isInteger(teamId) ? token(`--team-${((teamId % 8) + 8) % 8}`) : token('--team-none');

/** A player's colour: their team's, or the neutral one for observers and
 *  players with no team. */
export const playerColor = player =>
  player.observer || player.team === null || player.team === undefined ? token('--team-none') : teamColor(player.team);

/** The teams in play, by id: [{ id, name, color, score, players, alive }].
 *  From the players' teams and the scoreboard's, whichever has them. */
export function teamsOf(snapshot) {
  if (!snapshot) return [];
  const byId = new Map();
  const ensure = (id, name) => {
    if (!byId.has(id)) byId.set(id, { id, name: name || `Team ${id + 1}`, color: teamColor(id), score: null, players: [], alive: 0 });
    return byId.get(id);
  };
  for (const p of snapshot.players) {
    if (p.team === null || p.team === undefined) continue;
    const t = ensure(p.team, p.team_name);
    t.players.push(p);
    if (p.alive) t.alive++;
  }
  // The scoreboard's teams count only when no player has a team yet.
  const fromScores = byId.size === 0;
  for (const s of snapshot.team_scores ?? []) {
    const t = byId.get(s.team) ?? (fromScores ? ensure(s.team, s.name) : null);
    if (t) t.score = s.round_score ?? null;
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** The text colour that reads on a mark in `color` (#rgb or #rrggbb):
 *  `light` on the darker team colours (blue, red, purple, pink and the
 *  game's deep shades), `dark` on the light ones (amber, green, cyan, lime,
 *  the yellows), by whether `light` keeps a 3:1 contrast. */
export function inkOn(color, light, dark) {
  let hex = /^#([0-9a-f]{3,8})$/i.exec(String(color ?? '').trim())?.[1];
  if (!hex) return light;
  if (hex.length < 6) hex = [...hex.slice(0, 3)].map(c => c + c).join('');
  const lin = i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  return 1.05 / (lum + 0.05) >= 3 ? light : dark;
}

// ── Player numbers ──────────────────────────────────────────────────────

/** What playerNumbers() has handed out: per player handle { n, group },
 *  the block size, each group's block, for one epoch and phase (the
 *  lobby's roster and the match's are told apart, their handles differ). */
const numbering = { epoch: null, live: null, size: 0, blocks: new Map(), given: new Map(), snapshot: null, out: new Map() };

/** Each player's number on the map, by handle: one scheme for the whole
 *  match, in roster order. Each team takes a block as big as the biggest
 *  team, by team id (with two teams of four, the first is 1 to 4 and the
 *  next 5 to 8), and players with no team come after the teams, a free for
 *  all from 1. Within a block players go by slot. A number never changes
 *  in a match: a player who joins later takes the lowest free number in
 *  their team's block, then one a player who has left held, then one
 *  past every block. A player who changes team takes a number in the new
 *  team's block. Observers have none. A new epoch (another map, the end
 *  of a match) or the match starting after the lobby starts over. */
export function playerNumbers(snapshot, epoch) {
  const n = numbering;
  if (!snapshot) return new Map();
  if (n.snapshot === snapshot && n.epoch === epoch) return n.out;
  n.snapshot = snapshot;
  const live = Boolean(snapshot.in_match);
  if (n.epoch !== epoch || n.live !== live) {
    n.epoch = epoch;
    n.live = live;
    n.size = 0;
    n.blocks.clear();
    n.given.clear();
  }
  const players = snapshot.players.filter(p => !p.observer);
  const groupOf = p => (p.team === null || p.team === undefined ? 'none' : `t${p.team}`);
  const groups = new Map();
  for (const p of [...players].sort((a, b) => (a.team ?? Infinity) - (b.team ?? Infinity) || a.slot - b.slot || a.handle.localeCompare(b.handle))) {
    const key = groupOf(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  if (!n.size) n.size = Math.max(1, ...[...groups.values()].map(g => g.length));
  for (const key of groups.keys()) if (!n.blocks.has(key)) n.blocks.set(key, n.blocks.size);
  const present = new Set(players.map(p => p.handle));
  for (const [key, members] of groups) {
    const base = n.blocks.get(key) * n.size;
    for (const p of members) {
      const had = n.given.get(p.handle);
      if (had && had.group === key) continue;
      const taken = new Set([...n.given.values()].map(g => g.n));
      let pick = null;
      for (let i = base + 1; i <= base + n.size && pick === null; i++) if (!taken.has(i)) pick = i;
      if (pick === null) {
        // The block is full: a number a player who has left this team held.
        const gone = [...n.given].filter(([h, g]) => g.group === key && !present.has(h)).sort((a, b) => a[1].n - b[1].n)[0];
        if (gone) { pick = gone[1].n; n.given.delete(gone[0]); }
      }
      if (pick === null) pick = Math.max(n.blocks.size * n.size, ...taken) + 1;
      n.given.set(p.handle, { n: pick, group: key });
    }
  }
  n.out = new Map(players.map(p => [p.handle, n.given.get(p.handle).n]));
  return n.out;
}

// ── What the view shows ─────────────────────────────────────────────────

/** Players in the roster: all, or the team filter's. */
export const rosterPlayers = (snapshot, view) =>
  (snapshot?.players ?? []).filter(p => view.team === null || p.team === view.team);

/** Objects on the map: every object in the all view, pads in the tactical
 *  and pads views, none in the players view. */
export const visibleObjects = (snapshot, view) =>
  (snapshot?.objects ?? []).filter(o => o.position && (view.filter === 'all' || ((view.filter === 'pads' || view.filter === 'tactical') && isPad(o))));

/** The elevation the map slices at, in feet, or null for every floor:
 *  the slider's value, or the followed player's height (player slot 0's
 *  when nobody is followed). */
export function elevationValue(view, snapshot) {
  if (view.heightMode === 'slice') return Number(view.elevation);
  if (view.heightMode === 'player') {
    const p = snapshot?.players.find(x => view.focus ? x.handle === view.focus : x.slot === 0);
    return p?.position?.z ?? null;
  }
  return null;
}

// ── Selection targets ───────────────────────────────────────────────────

/** The store keeps { kind, handle }. This is the target of a record. */
export const targetOf = record => record ? { kind: isPlayer(record) ? 'player' : 'object', handle: record.handle } : null;

/** The record a target names in this snapshot, or null. */
export function resolveTarget(snapshot, target) {
  if (!snapshot || !target) return null;
  const list = target.kind === 'player' ? snapshot.players : snapshot.objects;
  return list.find(r => r.handle === target.handle) ?? null;
}

export const sameTarget = (a, b) => (a?.kind ?? null) === (b?.kind ?? null) && (a?.handle ?? null) === (b?.handle ?? null);

// ── Trails ──────────────────────────────────────────────────────────────

/** How many samples back the map draws a trail. */
export const TRAIL_DRAW = 90;

/** A player's trail key: a new unit (a respawn) starts a new trail. */
export const trailKey = player => `${player.handle}:${player.unit}`;

// ── Framing ─────────────────────────────────────────────────────────────

/** A floor ring's flat [x, y, x, y, ...] as points. */
export function ringPoints(ring) {
  const points = [];
  for (let i = 0; i < ring.p.length; i += 2) points.push({ x: ring.p[i], y: ring.p[i + 1] });
  return points;
}

/** The box around `points` with a 20 ft margin, at least 80 ft square:
 *  { x, y (centre), width, height }, or null. */
export function fit(points) {
  if (!points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: Math.max(80, maxX - minX + 40), height: Math.max(80, maxY - minY + 40) };
}

