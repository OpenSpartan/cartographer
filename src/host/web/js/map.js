// The map stage, in OpenSpartan Films' match viewer language: one canvas
// with the floor plan, the spawn pads as item badges, and the players as
// heads with vitals bars and point trails. Over it, top left, the status
// strips (feed trouble, paused, following, team filter), the hover card and
// the empty state. Drag pans, a click selects (or clears), the wheel, a
// pinch and + and - zoom, arrow keys pan, a double click fits.
//
// Heads move smoothly: each sample is timed by the snapshot's capture time
// (captured_unix_ms), and the map plays back about one and a half capture
// intervals behind the newest sample, interpolating between samples. It
// snaps instead of gliding across a respawn, a gap in the feed or a step too
// long to be running (a teleport), and holds still past the newest sample.
// The frame loop runs only while something still has to move.
//
// Every colour is a token (dom.js token()). Broadcast scales marks and
// labels by the stylesheet's --bc (a registered length, 1px at 1080). The
// map-only layout scales them by the view's size, never below the
// operator's.

import { state, setView, select, hover, subscribe, focusedPlayer, numbered, litPlayer, ZOOM } from './state.js';
import { el, icon, token, setText, swatch, fmt } from './dom.js';
import { button } from './controls.js';
import { itemImage, itemClass, isPowerItem } from './atlas.js';
import {
  isPad, isPlayer, padLabel, padTimer, playerLabel, playerColor, recordTitle,
  rosterPlayers, visibleObjects, elevationValue, trailKey, TRAIL_DRAW,
  targetOf, sameTarget, phaseOf, feedTag, objectiveMode, flagsOf, inPlay, teamColor, playerNumbers, inkOn,
} from './model.js';
import { drawZones } from '/ui/zones.js';
import { floorBands, floorPath, ringsAt, drawFloor, terrainOf, terrainStyle, drawTerrain } from '/ui/floor.js';
import { loadMarkers, markerImage } from '/ui/markers.js';
import { liveZones } from './zones-live.js';
import { sliceOf, lineOfFire, withHeights, clipOf } from './terrain.js';
import { paintData, dataLegend, hasKinds } from './dataview.js';
import { hud, hudFont, hudFontReady, brackets, HUD_FAMILY } from './hud.js';
import { alpha } from '/ui/tokens.js';

/** The HUD's tracking for the map's labels. */
const TRACKING = '0.6px';

// Films sizes (layers/paths.ts, badge.ts, focus.ts), CSS px at scale 1.
const HEAD_R = 7;
/** Where a player looks: a cone this long (CSS px at mark scale 1) and this
 *  wide either side of their aim, about the game's field of view. */
const CONE_LEN = 56;
const CONE_HALF = Math.PI / 6;
const BAR_W = 20;
/** A numbered head's radius, room for two figures, and its figures' size
 *  (CSS px at mark scale 1). */
const NUM_R = 9;
const NUM_FONT = 11;
/** A pointed head (marker=arrow), a teardrop along the aim as broadcast
 *  minimaps draw players: its tip this many radii from its centre, clear
 *  of the vitals under it whichever way it points. */
const TIP = 1.55;
/** The highlighted player's beam (the followed or observed player): longer
 *  and narrower than a cone, in white. */
const BEAM_LEN = 96;
const BEAM_HALF = Math.PI / 8;
/** A shot (stats.shots_fired going up between two samples) shows for this
 *  long from the sample that counted it, ms. */
const FIRE_MS = 450;
/** The dashed trace along a shooter's aim ends on the nearest player within
 *  this angle of the aim (rad) before the first wall, else at that wall,
 *  within this range (ft), else this long (CSS px at mark scale 1). */
const TRACE_HALF = 0.09;
const TRACE_RANGE_FT = 220;
const TRACE_LEN = 64;
/** In the stream layouts players' marks grow with the map: a mark scale of
 *  1 for every this many px of the whole map's size on screen (the mean of
 *  its sides, as fitted), so they keep their share of the map at any size. */
const MARK_SPAN = 600;
const FOLLOW_R = 15;
const SELECT_R = 13;
/** High contrast sets a mark on a dark band this wide round it (CSS px at
 *  mark scale 1), edged in white over a dark halo. */
const CONTRAST_BAND = 3.5;
/** Hit radius: mouse, touch (Films hover.ts). */
const PICK = 10;
const PICK_TOUCH = 22;
/** Marks this far off the view are not drawn. */
const CULL = 40;
/** A name tag's bottom edge sits this far above its head's centre, clear
 *  of the followed player's rings. */
const TAG_LIFT = 23;
/** A label fades only once an overlap has lasted this long, and comes back
 *  only once it has been this far clear (px) for this long, ms. */
const FADE_AFTER_MS = 250;
const CLEAR_AFTER_MS = 900;
const CLEAR_PX = 8;
/** The longest the map waits for its parts before showing what it has. */
const LOAD_MAX_MS = 5000;
/** Breathing room round the framed area, px. */
const FRAME_PAD = 24;
/** Orientation's turns: how many quarter turns anticlockwise from Y up. */
const TURNS = { y: 0, x: 1, '-y': 2, '-x': 3 };
/** The world to screen scale and turn at `s` px a foot and `q` quarter
 *  turns: [a, b, c, d], screen x = a x + c y, screen y = b x + d y. */
const turnOf = (q, s) => [[s, 0, 0, -s], [0, -s, -s, 0], [-s, 0, 0, s], [0, s, s, 0]][q];
/** A camera target that moves further than this many px in one frame (a
 *  respawn while following, focus moving to another player, a reframe) is
 *  glided to, ease-out cubic, instead of jumped to. The glide takes 400 ms,
 *  longer for a long way (1.3 ms a px, at most 1 s), so its fastest frame
 *  stays near 40 px. */
const CAM_JUMP_PX = 40;
const camEaseMs = px => clamp(1.3 * px, 400, 1000);

// Playback.
/** Samples kept per life: the trail plus a few to interpolate across. */
const KEEP = TRAIL_DRAW + 8;
/** A step longer than this between two samples is a teleport: snap, ft. */
const SNAP_FT = 35;
/** Samples further apart than this are not one move: snap, ms. */
const GAP_MS = 1500;

/** Fixed icon footprints by item class. */
const LOOK = {
  weapon: { h: 14, w: 48, scale: 1 },
  grenade: { h: 16, w: 22, scale: 1 },
  equipment: { h: 18, w: 24, scale: 1 },
  powerUp: { h: 20, w: 26, scale: 1.1 },
};
const CLASS_WORD = { weapon: 'Weapon', grenade: 'Grenade', equipment: 'Equipment', powerUp: 'Power-up' };

/** The canvas palette, from the tokens, read once. */
let palette = null;
const pal = () => palette ??= {
  bg: token('--bg'),
  bgAlpha: token('--bg-alpha'),
  bg80: token('--bg-80'),
  text: token('--text'),
  muted: token('--muted'),
  faint: token('--faint'),
  dim: token('--dim'),
  border: token('--border'),
  link: token('--link'),
  incoming: token('--timer-incoming'),
  floor: token('--map-floor'),
  wall: token('--map-wall'),
  shield: token('--vital-shield'),
  over: token('--vital-overshield'),
  health: token('--vital-health'),
  forge: token('--forge'),
  err: token('--err'),
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, f) => a + (b - a) * f;

/** Marker `name` (films-ui's marker atlas), `h` px tall,
 *  centred on (x, y) in `color` over a --bg copy of itself a little larger
 *  (Films' paths layer draws its facing arrow so). Returns the image drawn,
 *  or null before the atlas has loaded. */
function objectiveMark(ctx, name, x, y, h, color, P) {
  const back = markerImage(name, h + 3, P.bg);
  const img = markerImage(name, h, color);
  if (!img) return null;
  if (back) ctx.drawImage(back.canvas, x - back.w / 2, y - back.h / 2, back.w, back.h);
  ctx.drawImage(img.canvas, x - img.w / 2, y - img.h / 2, img.w, img.h);
  return img;
}

/** The floor's opacity over a transparent page (?bg=transparent), from
 *  ?alpha=0..255, 255 (opaque) by default. */
const FLOOR_ALPHA = (() => {
  const a = Number.parseInt(new URLSearchParams(location.search).get('alpha') ?? '', 10);
  return Number.isFinite(a) ? clamp(a, 0, 255) / 255 : 1;
})();

/** Health bar colour (Films healthColor): full, under half, under a quarter. */
const healthColor = (P, h) => h >= 0.5 ? P.health : h >= 0.25 ? P.forge : P.err;

/** The bounding box of floor rings as fit() makes it (20 ft margin, at
 *  least 80 ft square), without building point objects. */
function ringBox(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.p.length; i += 2) {
      const x = r.p[i], y = r.p[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: Math.max(80, maxX - minX + 40), height: Math.max(80, maxY - minY + 40) };
}

// ── The floor ───────────────────────────────────────────────────────────

/** How many height bands a plan without a terrain is shaded in. */
const BANDS = 6;

/** Each plan's terrain ready to draw (films-ui terrainOf), made once, with
 *  its height image (terrain.js) where it has one. */
const terrains = new WeakMap();
function terrainFor(plan) {
  if (!plan?.terrain) return null;
  if (!terrains.has(plan)) terrains.set(plan, withHeights(terrainOf(plan.terrain.data, plan.terrain.image), plan.terrain.heights));
  return terrains.get(plan);
}

/** A floor plan sliced at `height` (null: every floor), ready to draw: its
 *  bands and the floors the slice leaves out (films-ui floor.ts), its
 *  terrain when it has one (sliced at the height, terrain.js), and the box
 *  round the whole plan, the same at every height, so slicing never moves
 *  the camera. */
function floorOf(plan, height, zMin, zMax) {
  const inside = plan ? ringsAt(plan.rings, height) : [];
  const kept = new Set(inside);
  const outside = plan && height !== null ? plan.rings.filter(r => !kept.has(r)) : [];
  const path = inside.length ? floorPath(inside) : null;
  const terrain = terrainFor(plan);
  // The area players can be in: the plan's outline, a studio level's cut to
  // the mode in play (film-assets playable) or a Forge map's from its
  // navmesh. Its holes are left out, so a building inside it keeps its roof,
  // and so are the gaps its floors close round (terrain.js clipOf), so a rock
  // the floor runs round in pieces keeps its foot.
  const area = terrain ? clipOf(terrain, plan.rings) : null;
  return {
    plan,
    inside: path,
    bands: inside.length ? floorBands(inside, zMin, zMax, BANDS) : [],
    outside: outside.length ? floorPath(outside) : null,
    terrain,
    slice: terrain && height !== null ? sliceOf(terrain, plan.rings, height) : null,
    // The terrain keeps to it and its white outer edge runs round it, so
    // ground nobody reaches stays off the map.
    clip: area,
    box: plan ? ringBox(plan.rings) : null,
  };
}

/** `#rrggbb` `a` to `b` by `f`, 0 to 1. */
function mixHex(a, b, f) {
  const ch = (hex, i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `#${[0, 1, 2].map(i => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * f).toString(16).padStart(2, '0')).join('')}`;
}

/** The floor's colours: built from the operator's pick (floorcolor.js), or
 *  the HUD's deep blue. `terrain` for a map's terrain, `bands` for a plan's
 *  height bands. */
function floorLook() {
  const look = hud();
  const base = state.floorColor;
  if (!base) {
    return {
      terrain: { low: look.floorAway, mid: look.floorHigh, high: look.floorPeak, edge: look.edge, contour: look.floorContour, outline: look.floorRim },
      bands: { low: look.floorLow, high: look.floorHigh, edge: look.edge, away: look.floorAway },
    };
  }
  const terrain = terrainStyle(base);
  return {
    terrain,
    bands: { low: mixHex('#000000', base, 0.45), high: base, edge: terrain.edge, away: mixHex('#000000', base, 0.3) },
  };
}

/** Draw a floor (floorOf): its terrain shaded by height with its contour
 *  lines, edges and white outer edge (sliced: what is at the height in
 *  full, the rest faint), or without a terrain its height bands, ringed in
 *  white with the edges between them quiet. `ctx`'s transform maps feet to
 *  its pixels, `unit` is a foot in CSS px and `ratio` the pixels per CSS
 *  px, so lines and glow keep their weight at any resolution. */
function paintFloor(ctx, floor, unit, opacity, ratio) {
  const look = floorLook();
  const terrain = floor.slice ?? floor.terrain;
  if (terrain && floor.clip) {
    layer(ctx, opacity, c => paintEdged(c, terrain, floor.clip, look.terrain, unit));
    return;
  }
  if (terrain) {
    drawTerrain(ctx, terrain, look.terrain, { unit, opacity, edges: TERRAIN_EDGES, contours: TERRAIN_CONTOURS });
    return;
  }
  drawFloor(ctx, floor.bands, floor.outside, look.bands,
    { unit, opacity, glow: 4, ratio, outline: look.terrain.outline, inner: 0.5 });
}

/** The white outer edge round a terrain kept to its plan, CSS px. */
const TERRAIN_EDGE = 1.6;
/** How strong the terrain's edges are drawn, 0 to 1 (films-ui drawTerrain):
 *  in full, crisp round every structure and along every ledge, the lines a
 *  hand-made minimap draws, since the floor no longer darkens at a wall's
 *  foot where nothing drops. */
const TERRAIN_EDGES = 1;
/** And its contour lines: soft, as films-ui draws them by default. They lie
 *  only on sloped natural ground and never cross a flat floor, a ramp or
 *  stairs, and stronger ones read as clutter on rocky maps. */
const TERRAIN_CONTOURS = 0.35;

/** A terrain kept to its plan (`clip`, floor.clip), with a white edge round
 *  where the two meet, on a canvas of its own (nothing drawn under it yet).
 *  drawTerrain would ring each of the clip's rings, the borders between a
 *  plan's rings too. Here, as drawFloor's outline does, the clip's rings
 *  (inside the terrain) and the terrain's own edge (inside the clip) are
 *  stroked twice as wide first. What falls where the terrain is drawn is
 *  then cleared, so a slice's faint parts don't show it, which leaves the
 *  outer half round the floor. `draw` paints what goes inside (the terrain,
 *  or the data view's kinds), false when it painted nothing. */
function paintEdged(ctx, terrain, clip, style, unit, draw = () => drawTerrain(ctx, terrain, style, { unit, clip, outline: 0, edges: TERRAIN_EDGES, contours: TERRAIN_CONTOURS })) {
  ctx.save();
  ctx.strokeStyle = style.outline;
  ctx.lineJoin = 'round';
  ctx.lineWidth = (2 * TERRAIN_EDGE) / unit;
  ctx.save();
  ctx.clip(terrain.outline, 'evenodd');
  ctx.stroke(clip);
  ctx.restore();
  ctx.clip(clip, 'nonzero');
  ctx.stroke(terrain.outline);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fill(terrain.outline, 'evenodd');
  ctx.restore();
  return draw() !== false;
}

/** The canvas layer() draws on, kept between frames. */
let layerCanvas = null;

/** Draw on `ctx` at `opacity`: straight onto it when opaque, else on a
 *  canvas of its size with its transform, laid over it at `opacity` (as
 *  films-ui floor.ts does), so the edge doesn't show through the terrain. */
function layer(ctx, opacity, draw) {
  if (opacity >= 1) {
    draw(ctx);
    return;
  }
  const { width: cw, height: ch } = ctx.canvas;
  layerCanvas ??= document.createElement('canvas');
  if (layerCanvas.width !== cw || layerCanvas.height !== ch) {
    layerCanvas.width = cw;
    layerCanvas.height = ch;
  }
  const c = layerCanvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cw, ch);
  c.setTransform(ctx.getTransform());
  draw(c);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= opacity;
  ctx.drawImage(layerCanvas, 0, 0);
  ctx.restore();
}

// ── Saved image ─────────────────────────────────────────────────────────

/** A saved floor plan image's longer side, px: the choices. Each is drawn
 *  as a map IMAGE_CSS px long (about its size on a 1080p stream) scaled up,
 *  so edges and glow keep their weight at every size. */
export const IMAGE_SIZES = [2048, 4096, 8192];
const IMAGE_CSS = 1080;

/** The quarter turns the map's last frame was drawn at (Orientation), or
 *  null when it drew no map. */
let turned = null;

/** The height the map slices at for `view`, or null for every floor: in
 *  whole feet, so a followed player's footsteps don't redraw the floor. */
const sliceHeight = (view, snap) => {
  const h = elevationValue(view, snap);
  return h === null ? null : Math.round(h);
};

/** A map's name as a file name: 'live-fire-ranked'. */
const slugOf = t => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The floor plan in use, alone on a transparent canvas `long` px on its
 *  longer side: the map in play's or the one picked, at the elevation and
 *  in the colours the map uses, turned as it is shown (or as Orientation
 *  says, while the map draws none). It frames every floor, so the slices of
 *  one plan line up. Returns { canvas, name }, or null with no plan. The
 *  name is the map variant in play's when the plan is its own, else the
 *  map's, then the slice's height: 'live-fire-ranked',
 *  'live-fire-ranked-6m'. */
export function floorImage(long) {
  const g = state.geometry;
  const box = g.status === 'ready' && g.plan ? ringBox(g.plan.rings) : null;
  if (!box) return null;
  const snap = state.snapshot;
  const height = sliceHeight(state.view, snap);
  const q = turned ?? TURNS[state.view.orientation] ?? 0;
  const rot = q % 2 === 1;
  const s = long / Math.max(box.width, box.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((rot ? box.height : box.width) * s);
  canvas.height = Math.round((rot ? box.width : box.height) * s);
  const ctx = canvas.getContext('2d');
  const [a, b, c, d] = turnOf(q, s);
  ctx.setTransform(a, b, c, d, canvas.width / 2 - (a * box.x + c * box.y), canvas.height / 2 - (b * box.x + d * box.y));
  const ratio = long / IMAGE_CSS;
  paintFloor(ctx, floorOf(g.plan, height, g.zMin, g.zMax), s / ratio, 1, ratio);
  const own = state.view.level === 'auto' || state.view.level === snap?.geometry_id;
  const slug = slugOf(own ? snap?.map_variant?.name : null) || slugOf(g.title) || 'floor-plan';
  const m = height === null ? null : Math.round(height * 0.3048);
  return { canvas, name: m === null ? slug : `${slug}-${m < 0 ? 'minus-' : ''}${Math.abs(m)}m` };
}

// ── Badges (Films layers/badge.ts) ──────────────────────────────────────

/** A fixed marker size and its HUD icon at scale k. */
function badgeOf(pad, cls, power, k, P, ratio) {
  const look = LOOK[cls];
  const sc = look.scale * k;
  const ih = Math.round((look.h + (power && cls === 'weapon' ? 2 : 0)) * sc * 2) / 2;
  const w = look.w * sc, h = ih + 4 * sc;
  const img = itemImage(pad, ih, P.text, w, ratio);
  return { w, h, img, sc };
}

// ── Playback: samples timed by capture, interpolated ────────────────────

/** Per player handle: { key (trailKey), samples [{ t, x, y, z, s, h,
 *  fired }], died (capture ms) or null, ghost (the last life's end: { x,
 *  y, died }) or null, old (the last life's samples, fading out), shots
 *  (the last stats.shots_fired read, or null) }. A sample is `fired` when
 *  the count went up since the one before. */
const tracks = new Map();
/** The capture clock. target: capture ms minus performance.now() at the
 *  earliest of the recent arrivals (the max of `lags` over about 3 s, so
 *  it follows a poll that drifts against the feed). off: the offset
 *  playback uses, slewed towards the target by at most 5% of the time
 *  passing (playback runs 0.95 to 1.05 times real time and never jumps).
 *  at: when it was last slewed. interval: the median capture step. */
const clock = { target: null, off: null, at: 0, lags: [], lastC: null, steps: [], interval: 250 };
/** Arrivals the target looks back over. */
const LAG_WINDOW = 12;

/** How far behind the newest sample playback runs: one and a half capture
 *  intervals (375 ms at 4 Hz), which also absorbs the slew. */
const delayMs = () => clamp(clock.interval * 1.5, 150, 700);
/** The slew, as a share of the time passing. */
const SLEW = 0.05;
/** Further than this from the target, the offset snaps (a first sample, a
 *  resume after a long pause), ms. */
const SLEW_SNAP = 1500;

/** Once a frame: move the playback offset towards the target. */
function slewClock(now) {
  if (clock.target === null) return;
  const dt = clamp(now - clock.at, 0, 50);
  clock.at = now;
  if (clock.off === null || Math.abs(clock.target - clock.off) > SLEW_SNAP) { clock.off = clock.target; return; }
  const step = SLEW * dt;
  clock.off += clamp(clock.target - clock.off, -step, step);
}

/** The capture time the map shows now: behind the newest sample by the
 *  delay, never past it. */
function playTime() {
  if (clock.off === null) return Infinity;
  return Math.min(performance.now() + clock.off - delayMs(), clock.lastC);
}

/** What flagsOf has learned about the flags (their definition, their
 *  teams). A new map or match starts over. */
const flagMemory = { defs: new Set(), teams: new Map() };

function resetTracks() {
  tracks.clear();
  flagMemory.defs.clear();
  flagMemory.teams.clear();
  clock.target = null;
  clock.off = null;
  clock.lags = [];
  clock.lastC = null;
  clock.steps = [];
}

/** Take a snapshot's players into the tracks. False for a repeat of the
 *  last capture (the poll and the feed are not in step). */
function ingest(snap) {
  const C = Number.isFinite(snap.captured_unix_ms) ? snap.captured_unix_ms : Date.now();
  const L = performance.now();
  if (clock.lastC !== null && C === clock.lastC) return false;
  // The capture clock went back (a replay looped) or leapt: start over.
  if (clock.lastC !== null && (C < clock.lastC - 1000 || C > clock.lastC + 120000)) resetTracks();
  if (clock.lastC !== null) {
    const step = C - clock.lastC;
    if (step > 0 && step < 2000) {
      clock.steps.push(step);
      if (clock.steps.length > 9) clock.steps.shift();
      clock.interval = [...clock.steps].sort((a, b) => a - b)[clock.steps.length >> 1];
    }
  }
  // A late arrival lowers C - L. The earliest of the last few is the
  // truest. Playback follows the target through slewClock(), never in a
  // step.
  clock.lags.push(C - L);
  if (clock.lags.length > LAG_WINDOW) clock.lags.shift();
  clock.target = Math.max(...clock.lags);
  if (clock.off === null) { clock.off = clock.target; clock.at = L; }
  clock.lastC = C;

  const seen = new Set();
  for (const p of snap.players) {
    seen.add(p.handle);
    let tr = tracks.get(p.handle);
    if (p.alive && p.position && p.unit) {
      const key = trailKey(p);
      if (!tr) {
        tr = { key, samples: [], died: null, ghost: null, old: null, shots: null };
        tracks.set(p.handle, tr);
      } else if (tr.key !== key) {
        // A new life: the old one ends at its last sample, fading out.
        const last = tr.samples.at(-1);
        tr.ghost = last && tr.died !== null ? { x: last.x, y: last.y, died: tr.died } : null;
        tr.old = tr.samples.length ? tr.samples : null;
        tr.key = key;
        tr.samples = [];
        tr.died = null;
      } else if (tr.died !== null) {
        tr.died = null;
      }
      const v = p.vitality;
      const shots = Number.isFinite(p.stats?.shots_fired) ? p.stats.shots_fired : null;
      tr.samples.push({
        t: C, x: p.position.x, y: p.position.y, z: p.position.z ?? 0,
        yaw: Number.isFinite(p.facing) ? p.facing : null,
        s: Number.isFinite(v?.shield) ? v.shield : null,
        h: Number.isFinite(v?.health) ? v.health : null,
        fired: shots !== null && tr.shots !== null && shots > tr.shots,
      });
      if (shots !== null) tr.shots = shots;
      if (tr.samples.length > KEEP) tr.samples.shift();
    } else if (tr && tr.died === null && tr.samples.length && !(p.alive && p.unit)) {
      // Only a death ends a life. A living player the server can't place
      // this time (seated in a vehicle or mounted turret it didn't read)
      // keeps their last position, as libfilmshell's rides never end a life.
      tr.died = C;
    }
  }
  for (const handle of tracks.keys()) if (!seen.has(handle)) tracks.delete(handle);
  return true;
}

/** A track's position at capture time t: interpolated between the samples
 *  either side, the nearest end outside them, held then snapped across a
 *  gap or a teleport. */
function sampleAt(S, t) {
  const n = S.length;
  if (!n) return null;
  if (t >= S[n - 1].t) return S[n - 1];
  if (t <= S[0].t) return S[0];
  let i = n - 2;
  while (i > 0 && S[i].t > t) i--;
  const a = S[i], b = S[i + 1];
  const dt = b.t - a.t;
  if (dt > GAP_MS || Math.hypot(b.x - a.x, b.y - a.y) > SNAP_FT) return a;
  const f = (t - a.t) / dt;
  return {
    t, x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f),
    // The shorter way round, as libfilmshell's Life::yaw_at turns.
    yaw: a.yaw !== null && b.yaw !== null ? a.yaw + Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)) * f : b.yaw,
    s: a.s !== null && b.s !== null ? lerp(a.s, b.s, f) : b.s,
    h: a.h !== null && b.h !== null ? lerp(a.h, b.h, f) : b.h,
  };
}

/** What the map draws for a player at t: { dead, x, y, z, s, h, yaw, died } or null. */
function headOf(tr, t) {
  const S = tr.samples;
  if (tr.died !== null && t >= tr.died && S.length) {
    const last = S[S.length - 1];
    return { dead: true, x: last.x, y: last.y, died: tr.died };
  }
  if (S.length && t < S[0].t && tr.ghost) return { dead: true, x: tr.ghost.x, y: tr.ghost.y, died: tr.ghost.died };
  const p = sampleAt(S, t);
  return p ? { dead: false, x: p.x, y: p.y, z: p.z, s: p.s, h: p.h, yaw: p.yaw ?? null } : null;
}

/** How long ago, at t, the player last fired (ms), while that still shows
 *  (under FIRE_MS), else null. */
function firedAt(tr, t) {
  const S = tr.samples;
  for (let i = S.length - 1; i >= 0; i--) {
    const q = S[i];
    if (q.t > t) continue;
    if (t - q.t >= FIRE_MS) return null;
    if (q.fired) return t - q.t;
  }
  return null;
}

/** A glide's camera at `now`: from where it started towards the target,
 *  ease-out cubic, or null once it is over (or the view turned). */
function easedCam(ease, goal, now) {
  const p = (now - ease.t0) / ease.ms;
  if (p >= 1 || p < 0 || ease.from.q !== goal.q) return null;
  const q = 1 - (1 - p) ** 3;
  const m = ease.from;
  return {
    a: lerp(m.a, goal.a, q), b: lerp(m.b, goal.b, q), c: lerp(m.c, goal.c, q), d: lerp(m.d, goal.d, q),
    e: lerp(m.e, goal.e, q), f: lerp(m.f, goal.f, q), s: lerp(m.s, goal.s, q),
  };
}

// ── The view ────────────────────────────────────────────────────────────

export function mount(root) {
  // The map appears whole. Its floor plan, the mode's placements, the
  // markers, the item icons and the HUD's typeface load apart. The
  // canvas stays hidden behind the loading line until all have (or failed,
  // or LOAD_MAX_MS has passed), then fades in, so nothing pops in piece by
  // piece. A new map or match loads again.
  let markersReady = false, fontReady = false, loadingSince = performance.now();
  void loadMarkers('/api/markers/markers.json').then(() => { markersReady = true; schedule(); });
  void hudFontReady().then(() => { fontReady = true; fitCache.clear(); schedule(); });
  const loaded = () => markersReady && fontReady && state.atlas !== null
    && state.geometry.status !== 'loading' && !state.objectives.loading;
  const canvas = el('canvas', {
    class: 'map-canvas', tabindex: '0', role: 'img',
    'aria-label': 'Live map of players and spawn pads. Drag to pan, scroll or pinch to zoom, arrow keys pan, Escape clears the selection.',
  });
  const ctx = canvas.getContext('2d');

  // Status strips, top left (Films stageStrip): feed trouble, paused,
  // following, team filter.
  const strips = el('div', { class: 'map-strips', dataset: { occlude: '' } });
  const feedStrip = strip(null);
  const pausedStrip = strip(button({ label: 'Resume', size: 'sm', variant: 'ghost', title: 'Resume the live feed.', onClick: () => setView({ paused: false }) }));
  const followStrip = strip(button({ label: 'Stop', size: 'sm', variant: 'ghost', title: 'Stop following.', onClick: () => setView({ focus: null }) }));
  const teamStrip = strip(button({ label: 'Clear', size: 'sm', variant: 'ghost', title: 'Show every team.', onClick: () => setView({ team: null }) }));
  strips.append(feedStrip.node, pausedStrip.node, followStrip.node, teamStrip.node);

  const empty = el('div', { class: 'map-empty', hidden: true });
  // The HUD's line: 'Loading map' while the map's parts load. In the stream
  // layouts, where the operator's empty state is hidden, it also stands by
  // between matches ('Awaiting match', data-standby, stage.css).
  const loadingWord = el('span', { class: 'map-loading-word' }, 'Loading map');
  const loading = el('div', { class: 'map-loading', hidden: true, role: 'status' },
    loadingWord, el('span', { class: 'map-loading-bar', 'aria-hidden': 'true' }));
  const showLoading = (word, standby) => {
    loading.hidden = !word;
    if (!word) return;
    if (loadingWord.textContent !== word) loadingWord.textContent = word;
    if (loading.hasAttribute('data-standby') !== standby) loading.toggleAttribute('data-standby', standby);
  };
  // The TACMAP's frame: corner brackets and the centre lines (stage.css).
  const frame = el('div', { class: 'map-frame', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'), el('i'));
  const tip = hoverCard();
  // The data view's legend and readout (dataview.js), bottom left.
  const data = dataLegend();
  root.replaceChildren(frame, canvas, strips, empty, loading, tip.el, data.el);

  // ── State local to the map ───────────────────────────────────────────
  let size = { w: 0, h: 0 };
  let bc = 1;
  let framing = null;           // the world box in view: { x, y, width, height }
  let pan = { x: 0, y: 0 };     // CSS px
  let anchor = null;            // zoom about a point: { sx, sy, wx, wy }
  let aff = null;               // the last draw's world to screen affine
  let lastGoal = null;          // the camera's target last frame: { a..f, s, q }
  let lastDrawn = null;         // the camera drawn last frame
  let camEase = null;           // a glide in flight: { from, t0 }
  let camUser = false;          // the user moved the camera since the last frame
  let floor = { key: null };    // cached floor paths
  // The floor as last drawn (its glow blurs every edge, too dear to redo
  // each frame), by everything it was drawn with.
  const floorLayer = { canvas: document.createElement('canvas'), key: '' };
  let targets = [];             // hit targets from the last draw: { x, y, r, record, rank }
  let pickScale = 1;            // hit reach scale (the players' mark scale)
  let emptyKey = '';
  let pointer = null;           // { x, y, touch } over the canvas
  const touches = new Map();    // pointer id -> { x, y }
  let drag = null;              // { x, y, total, moved }
  let pinch = null;             // { d0, zoom0, mx, my }
  let tipTarget = null;         // what the hover card shows
  let tipDirty = false;
  let deadTimer = 0;
  let loadTimer = 0;
  const fitCache = new Map();   // trimmed label text by font, width, text
  const labelState = new Map(); // label key -> { alpha, faded, since, draw, seen }
  let labelClock = performance.now();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // ── Frame loop ───────────────────────────────────────────────────────
  let raf = 0;
  const schedule = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(tick); };
  function tick() {
    raf = 0;
    const moving = draw();
    if (moving) schedule();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });

  function measure() {
    const r = root.getBoundingClientRect();
    size = { w: r.width, h: r.height };
    const broadcast = state.view.layout === 'broadcast';
    root.toggleAttribute('data-broadcast', broadcast);
    bc = broadcast ? parseFloat(getComputedStyle(document.body).getPropertyValue('--bc')) || 1 : 1;
  }

  function showEmpty(o) {
    const k = `${o.icon}|${o.title}|${o.body ?? ''}|${o.busy ? 1 : 0}`;
    if (empty.hidden) empty.hidden = false;
    if (k === emptyKey) return;
    emptyKey = k;
    const lead = icon(o.busy ? 'sync' : o.icon, 24);
    if (o.busy) lead.classList.add('spin');
    empty.replaceChildren(el('div', { class: 'empty-state', role: 'status' },
      lead, el('div', { class: 'title' }, o.title), o.body ? el('div', { class: 'body' }, o.body) : null));
  }

  /** Why there is nothing to draw, or null. */
  function emptyReason(snap) {
    if (!snap) {
      const tag = feedTag(state);
      if (state.feed === 'waiting' || state.feed === 'error') return { icon: 'offline', title: tag.line, stream: 'Offline' };
      return { busy: true, title: tag.line || 'Connecting to the observer', stream: 'Connecting' };
    }
    if (!snap.in_match) {
      if (phaseOf(snap.life_cycle) === 'Loading') return { busy: true, title: 'Loading the match', stream: 'Loading match' };
      // The lobby's map, when its plan is known, is drawn: the next match's.
      if (snap.geometry_id && state.geometry.id === snap.geometry_id && state.geometry.status === 'ready') return null;
      return { icon: 'users', title: 'Waiting for a LAN match', stream: 'Awaiting match' };
    }
    return null;
  }

  // ── Draw ─────────────────────────────────────────────────────────────

  /** Paint one frame. Returns true while heads still have to move. */
  function draw() {
    turned = null;
    const { w, h } = size;
    if (w < 1 || h < 1) return false;
    const ratio = Math.max(1, Math.min(4, Math.round((window.devicePixelRatio || 1) * 1000) / 1000));
    const cw = Math.round(w * ratio), ch = Math.round(h * ratio);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    targets = [];
    const P = pal();
    const look = hud();
    const snap = state.snapshot;
    const view = state.view;
    const g = state.geometry;

    const why = emptyReason(snap);
    if (why) {
      showEmpty(why);
      showLoading(why.stream, true);
      aff = null;
      lastGoal = lastDrawn = camEase = null;
      settleTip();
      return false;
    }
    const ready = loaded() || performance.now() - loadingSince > LOAD_MAX_MS;
    // In the lobby the next match's map stands by under the HUD's line.
    showLoading(!ready ? 'Loading map' : snap.in_match ? null : 'Awaiting match', ready && !snap.in_match);
    if (ready !== !canvas.hasAttribute('data-loading')) canvas.toggleAttribute('data-loading', !ready);
    if (!ready) {
      clearTimeout(loadTimer);
      loadTimer = setTimeout(schedule, 250);
      return false;
    }

    slewClock(performance.now());
    const t = playTime();

    // The floor plan, sliced at the elevation and cached per plan and slice.
    const plan = g.status === 'ready' && view.floor ? g.plan : null;
    const height = sliceHeight(view, snap);
    const floorKey = `${g.id}|${height}|${plan ? 1 : 0}`;
    if (floor.key !== floorKey || floor.plan !== plan) floor = { key: floorKey, ...floorOf(plan, height, g.zMin, g.zMax) };
    data.show(view.data && Boolean(plan), floor.terrain, g.id);

    // Who is on the map, and where at t.
    const players = view.filter === 'pads' ? [] : rosterPlayers(snap, view);
    const heads = [];
    let moving = false;
    for (const p of players) {
      const tr = tracks.get(p.handle);
      if (!tr) continue;
      const hd = headOf(tr, t);
      if (!hd) continue;
      const fire = hd.dead ? null : firedAt(tr, t);
      heads.push({ p, tr, hd, fire, ang: null });
      // A shot showing, or still to come in playback.
      if (fire !== null || (!hd.dead && tr.samples.some(q => q.fired && q.t > t))) moving = true;
      const last = tr.samples.at(-1);
      if (last && last.t > t && !hd.dead && (Math.abs(hd.x - last.x) > 0.01 || Math.abs(hd.y - last.y) > 0.01
        || hd.s !== last.s || hd.h !== last.h)) moving = true;
      // A death or a respawn still to come in playback.
      if ((tr.died !== null && tr.died > t) || (tr.samples[0] && tr.samples[0].t > t)) moving = true;
    }
    const objects = visibleObjects(snap, view);

    if (!floor.inside && !floor.slice && !heads.some(x => !x.hd.dead) && !objects.length) {
      showEmpty({ icon: 'map', title: 'No positions yet' });
      aff = null;
      lastGoal = lastDrawn = camEase = null;
      settleTip();
      return moving;
    }
    if (!empty.hidden) { empty.hidden = true; emptyKey = ''; }

    // The camera: the floor plan's box (or what is on the map), or the
    // followed player, turned as Orientation says. Auto turns it a quarter
    // when that fits the view better, judged by the level's frame (round
    // every mode's plan), so a map turns the same way in every mode.
    const box = floor.box ?? boxOf([...heads.map(x => x.hd), ...objects.map(o => o.position)]);
    if (!box) { aff = null; return moving; }
    if (!framing || view.framing === 'auto') framing = box;
    let frame = framing;
    const followed = heads.find(x => x.p.handle === view.focus);
    if (followed) frame = { x: followed.hd.x, y: followed.hd.y, width: 180, height: 180 };
    const basis = g.status === 'ready' && g.bounds ? g.bounds : box;
    const q = view.orientation === 'auto' ? Number((basis.height > basis.width) !== (h > w)) : TURNS[view.orientation];
    const rot = q % 2 === 1;
    turned = q;

    // Mark scale: Films' sizes in the operator view, 1.4 times --bc in
    // broadcast, and with the view's size in the map-only layout. In the
    // stream layouts players' marks (km) also grow with the whole map's size
    // on screen as fitted (MARK_SPAN), which zoom, focus and slices leave be.
    const k = view.layout === 'broadcast' ? 1.4 * bc
      : view.layout === 'map' ? Math.max(1, Math.min(w, h) / 760) : 1;
    let km = k;
    if (view.layout !== 'operator' && floor.box) {
      const fits = Math.min((w - 2 * FRAME_PAD * k) / (rot ? box.height : box.width), (h - 2 * FRAME_PAD * k) / (rot ? box.width : box.height));
      km = Math.max(k, (Math.sqrt(box.width * box.height) * fits) / MARK_SPAN);
    }
    const padPx = FRAME_PAD * k;
    let s = Math.min(
      (w - 2 * padPx) / (rot ? frame.height : frame.width),
      (h - 2 * padPx) / (rot ? frame.width : frame.height)) * view.zoom;
    let [a, b, c, d] = turnOf(q, s);
    let e = w / 2 - (a * frame.x + c * frame.y), f = h / 2 - (b * frame.x + d * frame.y);
    const anchored = Boolean(anchor);
    if (anchor) {
      pan.x = anchor.sx - (a * anchor.wx + c * anchor.wy + e);
      pan.y = anchor.sy - (b * anchor.wx + d * anchor.wy + f);
      anchor = null;
    }
    e += pan.x;
    f += pan.y;

    // Glide, don't jump: when the camera's target leaps (the followed
    // player respawns, focus moves to another player, the view reframes),
    // the camera eases from where it was drawn to the moving target. The
    // user's own drag, pinch and wheel never ease, and stop a glide in
    // flight (keeping where it had got to as pan). Reduced motion snaps.
    const nowMs = performance.now();
    const goal = { a, b, c, d, e, f, s, q };
    if (camUser) {
      camUser = false;
      const cur = camEase && !anchored ? easedCam(camEase, goal, nowMs) : null;
      if (cur) {
        pan.x += cur.e - e;
        pan.y += cur.f - f;
        goal.e = e = cur.e;
        goal.f = f = cur.f;
      }
      camEase = null;
    } else if (lastGoal && lastDrawn && lastGoal.q === q && !reducedMotion.matches) {
      const det = lastGoal.a * lastGoal.d - lastGoal.b * lastGoal.c;
      if (det) {
        // Where the world point at the view's centre goes.
        const dx = w / 2 - lastGoal.e, dy = h / 2 - lastGoal.f;
        const wx = (lastGoal.d * dx - lastGoal.c * dy) / det, wy = (-lastGoal.b * dx + lastGoal.a * dy) / det;
        const moved = Math.hypot(a * wx + c * wy + e - w / 2, b * wx + d * wy + f - h / 2);
        if (moved > CAM_JUMP_PX || Math.abs(Math.log(s / lastGoal.s)) > 0.12) camEase = { from: lastDrawn, t0: nowMs, ms: camEaseMs(moved) };
      }
    }
    lastGoal = goal;
    if (camEase) {
      const cur = easedCam(camEase, goal, nowMs);
      if (cur) {
        ({ a, b, c, d, e, f, s } = cur);
        moving = true;
      } else {
        camEase = null;
      }
    }
    lastDrawn = { a, b, c, d, e, f, s, q };
    aff = { a, b, c, d, e, f, s, px: pan.x, py: pan.y };
    const X = (x, y) => a * x + c * y + e;
    const Y = (x, y) => b * x + d * y + f;
    const off = (x, y) => x < -CULL || y < -CULL || x > w + CULL || y > h + CULL;

    if (floor.inside || floor.slice) {
      // The map's terrain as a hand-made minimap draws it (paintFloor,
      // films-ui floor.ts): lighter higher, contour lines on slopes, crisp
      // edges, a white outer edge. A slice keeps that look for what is at
      // its height, the rest faint (terrain.js). A plan without a terrain
      // keeps its height bands, and a slice of it the rest of the level
      // faint. Over a transparent page (the map over a scene) the whole
      // floor takes FLOOR_ALPHA. Drawn once into floorLayer while the camera holds still,
      // then copied each frame.
      const bare = document.documentElement.dataset.bg === 'transparent';
      // The data view draws what each part of the floor is instead, in flat
      // colours, where the map data says (dataview.js).
      const dataView = view.data && floor.terrain;
      const key = [floor.key, cw, ch, ratio, a, b, c, d, e, f, bare, look.floorLow, look.floorHigh, look.edge, look.floorAway, state.floorColor, dataView ? 'data' : ''].join('|');
      const layer = floorLayer.canvas;
      if (floorLayer.key !== key) {
        floorLayer.key = key;
        layer.width = cw;
        layer.height = ch;
        const lc = layer.getContext('2d');
        lc.clearRect(0, 0, cw, ch);
        lc.setTransform(ratio * a, ratio * b, ratio * c, ratio * d, ratio * e, ratio * f);
        const repaint = () => { floorLayer.key = null; schedule(); };
        const painted = dataView && floor.clip && hasKinds(floor.terrain)
          && paintEdged(lc, floor.terrain, floor.clip, floorLook().terrain, s, () => paintData(lc, floor.terrain, floor.clip, s, g.id, repaint));
        if (!painted) paintFloor(lc, floor, s, bare ? FLOOR_ALPHA : 1, ratio);
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
    }

    const sel = state.selected, hov = state.hovered;
    const marks = [];   // heads and badges, which labels give way to: { x, y, w, h, owner, dead?, pad? }
    const labels = [];

    // Type: pad names in --t-mark, countdowns and name tags in Films'
    // 600 11px, scaled with the marks, never smaller.
    const nameFont = hudFont(600, Math.max(11, Math.round(11 * k)));
    const countFont = hudFont(600, Math.max(12, Math.round(12 * k)));
    const noteH = Math.max(16, Math.round(16 * k));
    const tagFont = countFont;
    const tagH = Math.max(18, Math.round(18 * k));
    pickScale = Math.max(1, km);

    // The mode's objectives (objectives.rs): zones and hills through
    // films-ui's zone layer, live (zones-live.js), and flag stands, plates
    // and ball stands as Films draws them (its devices layer: the flag marker,
    // a ring and dot, a ring). The flags themselves come after the
    // players.
    const mode = view.objectives && view.filter !== 'pads' ? objectiveMode(snap, state.objectives.objects) : null;
    const placed = mode ? inPlay(snap, state.objectives.objects.filter(o => o.modes.includes(mode))) : [];
    const flags = mode === 'ctf' ? flagsOf(snap, placed.filter(o => o.kind === 'flag_spawn'), flagMemory)
      : mode === 'oddball' ? flagsOf(snap, [], flagMemory, true) : [];
    const zones = mode ? liveZones(snap, placed, mode) : [];
    // The objects on screen, and each spawn pad's badge, ahead of the
    // zones: a zone's badge keeps clear of a pad's badge and the timer under
    // it (room for a countdown always, so the zone's badge never moves when
    // a timer starts).
    const items = [];
    const padBoxes = [];
    for (const o of objects) {
      const x = X(o.position.x, o.position.y), y = Y(o.position.x, o.position.y);
      if (off(x, y)) continue;
      if (!isPad(o)) { items.push({ o, x, y, bd: null }); continue; }
      const power = isPowerItem(o);
      const bd = badgeOf(o, itemClass(o), power, k, P, ratio);
      items.push({ o, x, y, bd, power });
      const nw = Math.max(bd.w, 36 * k);
      padBoxes.push({ x: x - nw / 2, y: y - bd.h / 2, w: nw, h: bd.h + 9 * k + noteH });
    }
    if (zones.length) {
      ctx.save();
      drawZones(ctx, (x, y) => [X(x, y), Y(x, y)], s, zones, { width: w, height: h },
        { text: look.text, muted: look.muted, bg: look.bg, family: HUD_FAMILY }, padBoxes);
      ctx.restore();
    }
    for (const o of placed) {
      if (o.b) continue;
      const x = X(o.x, o.y), y = Y(o.x, o.y);
      const color = o.team === undefined ? P.text : teamColor(o.team);
      ctx.lineWidth = 1;
      if (o.kind === 'flag_spawn') {
        // Home with its flag: the flag stands on it (after the players).
        // Away: the empty stand, its flag faint.
        if (flags.some(f => f.state === 'home' && f.stand === o)) continue;
        ctx.globalAlpha = 0.35;
        objectiveMark(ctx, 'flag', x, y, 13 * k, color, P);
        ctx.globalAlpha = 1;
      } else if (o.kind === 'flag_plate') {
        ctx.strokeStyle = color;
        ctx.beginPath(); ctx.arc(x, y, 6 * k, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, y, 2 * k, 0, Math.PI * 2); ctx.fill();
      } else {
        // Ball stands and bomb spawns and sites: a ring.
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = color;
        ctx.beginPath(); ctx.arc(x, y, 5 * k, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    // Spawn pads (item badges) and other objects.
    for (const { o, x, y, bd, power } of items) {
      const owner = `o:${o.handle}`;
      if (!bd) {
        // Films World layer's device: a small dim square.
        const q = 5 * k;
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = P.muted;
        ctx.lineWidth = 1;
        ctx.strokeRect(x - q / 2, y - q / 2, q, q);
        ctx.globalAlpha = 1;
        targets.push({ x, y, r: 0, record: o, rank: 2 });
        continue;
      }
      const tm = padTimer(o);
      const target = targetOf(o);
      const selected = sameTarget(sel, target);
      const hot = selected || sameTarget(hov, target);
      const incoming = tm.state === 'incoming';
      const ready = tm.state === 'ready';
      const ring = incoming ? P.incoming : ready ? (power ? P.text : P.muted) : P.dim;
      const quiet = !ready && !incoming;

      if (hot) {
        // Selected or pointed at: the TACMAP's corner brackets round it.
        const gw = bd.w + 10 * k, gh = bd.h + 8 * k;
        brackets(ctx, x - gw / 2, y - gh / 2, gw, gh, 5 * k, selected ? look.edge : look.muted, (selected ? 2 : 1.5) * k);
      }
      ctx.globalAlpha = quiet ? 0.4 : 1;
      if (bd.img) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.shadowColor = look.shadow;
        ctx.shadowBlur = 4 * ratio;
        ctx.drawImage(bd.img.canvas,
          Math.round(x * ratio - bd.img.canvas.width / 2),
          Math.round(y * ratio - bd.img.canvas.height / 2));
        ctx.restore();
      } else {
        ctx.fillStyle = ring;
        ctx.beginPath();
        ctx.arc(x, y, 3 * k, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      const below = bd.h / 2 + 6 * k;
      if (incoming && tm.progress !== null) {
        const by = y + bd.h / 2 + 2 * k, bx = x - bd.w / 2;
        ctx.fillStyle = P.dim;
        ctx.fillRect(bx, by, bd.w, 2 * k);
        ctx.fillStyle = P.incoming;
        ctx.fillRect(bx, by, bd.w * tm.progress, 2 * k);
      }
      const hw = bd.w / 2;
      const hh = below;
      marks.push({ x: x - hw, y: y - hh, w: hw * 2, h: hh * 2, owner, pad: true });
      targets.push({ x, y, r: Math.max(bd.w, bd.h) / 2 + 2, record: o, rank: 1 });

      // Its label, fixed, centred under the badge: the countdown while
      // incoming, and the name too when it is pointed at or every pad is
      // labelled. It never moves, but it fades when a name tag is over it.
      const count = incoming ? fmt.countdown(tm.remaining) : '';
      const named = hot || view.filter === 'pads' || !bd.img;
      if (count || named) {
        const text = named ? [padLabel(o).toUpperCase(), count].filter(Boolean).join('  ') : count;
        const font = named ? nameFont : countFont;
        const fitted = fitText(text, font, 180 * k, true);
        const W = fitted.width + 8 * k, H = noteH;
        labels.push({
          key: owner, kind: 'note', owner, text: fitted.text, font, color: look.text, fill: look.plate,
          accent: incoming ? P.incoming : null,
          x: x - W / 2, y: y + hh + 3 * k, w: W, h: H, prio: hot ? 0 : 4, order: labels.length, base: 1,
        });
      }
    }

    // Trails: one square dot per sample (Films drawTrail, never a line),
    // fading with age. The last life's trail fades out after a respawn.
    if (view.trails && heads.length) {
      const r = clamp(s * 0.35, 0.9, 2.2) * km, dd = r * 2;
      const fade = TRAIL_DRAW * clock.interval;
      for (const { p, tr } of heads) {
        ctx.fillStyle = playerColor(p);
        for (const list of [tr.old, tr.samples]) {
          if (!list) continue;
          let lx = Infinity, ly = Infinity;
          for (let i = 0; i < list.length; i++) {
            const q = list[i];
            if (q.t > t) break;
            const age = t - q.t;
            if (age >= fade) continue;
            const x = X(q.x, q.y), y = Y(q.x, q.y);
            if (Math.abs(x - lx) < r && Math.abs(y - ly) < r) continue;
            if (off(x, y)) continue;
            ctx.globalAlpha = 0.85 * (1 - age / fade);
            ctx.fillRect(x - r, y - r, dd, dd);
            lx = x; ly = y;
          }
        }
        if (tr.old && tr.old.at(-1).t < t - fade) tr.old = null;
      }
      ctx.globalAlpha = 1;
    }

    // Heads: the dead first (hollow 'last seen' rings), then the living, the
    // highlighted player on top: the one the operator observes, else the one
    // followed, else the one the snapshot says a spectator watches.
    const lit = litPlayer(snap, view);
    const rank = x => (x.hd.dead ? 0 : x.p.handle === lit ? 2 : 1);
    heads.sort((m, n) => rank(m) - rank(n));
    // Numbers: each in its head, so a head is bigger, and no name tags but
    // the hovered or selected player's.
    const nums = numbered(view) ? playerNumbers(snap, state.epoch) : null;
    const arrows = view.marker === 'arrow';
    // Where shots meet walls, for the traces: the plan's, drawn or not.
    const fireLine = view.firing === 'trace' && g.status === 'ready' && g.plan ? lineOfFire(g.plan, terrainFor(g.plan)) : null;
    const R = (nums ? NUM_R : HEAD_R) * km;
    const numFont = hudFont(700, Math.max(NUM_FONT, Math.round(NUM_FONT * km)));
    // A world yaw as a screen angle.
    const aim = yaw => Math.atan2(b * Math.cos(yaw) + d * Math.sin(yaw), a * Math.cos(yaw) + c * Math.sin(yaw));

    // Under every head, so none covers another player: where each living
    // player looks (with discs, a soft cone in their colour along their
    // aim), the highlighted player's beam, and a shot's dashed trace and
    // the lines round the shooter (under their own head and bars too).
    for (const hx of heads) {
      const { p, hd } = hx;
      if (hd.dead || hd.yaw === null) continue;
      const x = X(hd.x, hd.y), y = Y(hd.x, hd.y);
      if (off(x, y)) continue;
      hx.ang = aim(hd.yaw);
      if (p.handle === lit) beam(x, y, hx.ang);
      else if (!arrows) cone(x, y, hx.ang, playerColor(p));
      if (hx.fire !== null && view.firing === 'trace') trace(hx, x, y);
    }
    if (view.firing !== 'off') for (const hx of heads) if (hx.fire !== null) shot(hx);
    let deadShown = false;
    for (const hx of heads) {
      const { p, hd } = hx;
      const x = X(hd.x, hd.y), y = Y(hd.x, hd.y);
      if (off(x, y)) continue;
      const color = playerColor(p);
      const owner = `p:${p.handle}`;
      const target = targetOf(p);
      const focused = view.focus === p.handle;
      const selected = sameTarget(sel, target);
      const hovered = sameTarget(hov, target);
      const n = nums?.get(p.handle) ?? null;
      if (hd.dead) {
        // Where they died: a hollow ring in their colour, their number in it.
        if (view.contrast) ring(x, y, R, look.ink, 5 * km, 0.85);
        ring(x, y, R, color, 2 * km, 0.6);
        if (n !== null) { ctx.globalAlpha = 0.6; number(x, y, n, color, true); ctx.globalAlpha = 1; }
        marks.push({ x: x - R - km, y: y - R - km, w: 2 * R + 2 * km, h: 2 * R + 2 * km, owner, dead: true });
        // Seconds since the death, Films' countdown plate fixed beside the
        // ring (x + 10, a 16px plate on --bg-80).
        // Counted from 1, as 'ago' reads ('0 s ago' would say nothing).
        const since = Math.max(1, Math.ceil((t - hd.died) / 1000));
        deadShown = true;
        const fitted = fitText(`${since} s ago`, countFont, 90 * k, true);
        labels.push({
          key: `${owner}:dead`, kind: 'note', owner, text: fitted.text, font: countFont, color: look.muted, fill: look.plate,
          x: x + R + 3 * km, y: y - noteH / 2, w: fitted.width + 4 * k, h: noteH, prio: 4, order: p.slot, base: 1,
        });
      } else {
        // The living: a disc in their team's colour, ringed in white, glowing
        // in its colour (in white for the highlighted player). With arrows
        // the whole mark points along the aim, a teardrop with the number in
        // its round end. High contrast sets it on a dark band edged in white
        // over a dark halo, which stands out on any floor, light or dark, and
        // over any scene. The highlighted player's has a white ring of its
        // shape round it.
        const isLit = p.handle === lit;
        const ang = arrows ? hx.ang : null;
        // How far the mark reaches past its head.
        const rim = view.contrast ? CONTRAST_BAND * km : 0;
        ctx.lineJoin = 'round';
        if (view.contrast) {
          const band = head(x, y, R + rim, ang);
          ctx.shadowColor = alpha(look.ink, 0.9);
          ctx.shadowBlur = 9 * km;
          ctx.fillStyle = look.ink;
          ctx.fill(band);
          ctx.shadowBlur = 0;
          ctx.strokeStyle = look.text;
          ctx.lineWidth = 1.25 * km;
          ctx.stroke(band);
        }
        const shape = head(x, y, R, ang);
        ctx.shadowColor = isLit ? look.text : color;
        ctx.shadowBlur = isLit ? 14 * km : view.contrast ? 0 : 10 * km;
        ctx.fillStyle = color;
        ctx.fill(shape);
        ctx.shadowBlur = 0;
        ctx.strokeStyle = look.text;
        ctx.lineWidth = 1.75 * km;
        ctx.stroke(shape);
        if (isLit) {
          ctx.globalAlpha = 0.9;
          ctx.lineWidth = 1.5 * km;
          ctx.stroke(head(x, y, R + rim + 3.5 * km, ang));
          ctx.globalAlpha = 1;
        }
        ctx.lineJoin = 'miter';
        if (n !== null) number(x, y, n, color, false);
        let bottom = R + rim + 2 * km;
        if (hd.s !== null || hd.h !== null) {
          const bw = BAR_W * km, bh = 2 * km, bx = x - bw / 2;
          let by = y + R + rim + 5 * km;
          const bar = (v, color2) => {
            if (!view.vitals) return;
            ctx.fillStyle = P.bg;
            ctx.fillRect(bx - km, by - km, bw + 2 * km, bh + 2 * km);
            ctx.fillStyle = color2;
            ctx.fillRect(bx, by, bw * clamp(v, 0, 1), bh);
          };
          if (hd.s !== null) {
            bar(hd.s, P.shield);
            if (view.vitals && hd.s > 1) {
              ctx.fillStyle = P.over;
              ctx.fillRect(bx, by, bw * clamp(hd.s - 1, 0, 1), bh);
            }
            by += 4 * km;
          }
          if (hd.h !== null) { bar(hd.h, healthColor(P, hd.h)); by += 4 * km; }
          bottom = by - y;
        }
        if (hovered && !focused && !selected) {
          const r = R + 6 * km;
          brackets(ctx, x - r, y - r, 2 * r, 2 * r, 5 * km, look.muted, 1.5 * km);
        }
        // What the mark covers, the tip included.
        const tx = ang === null ? x : x + Math.cos(ang) * TIP * R, ty = ang === null ? y : y + Math.sin(ang) * TIP * R;
        const edge = rim + 3 * km;
        const x0 = Math.min(x - R, tx) - edge, y0 = Math.min(y - R, ty) - edge;
        marks.push({ x: x0, y: y0, w: Math.max(x + R, tx) + edge - x0, h: Math.max(y + bottom, ty + edge) - y0, owner });
      }
      targets.push({ x, y, r: 0, record: p, rank: 0 });

      // The followed player (Films drawFollowed, before the marker atlas):
      // rings round the head and the name on a tag above.
      if (focused || selected) {
        // Followed or selected: the TACMAP's corner brackets, the HUD's
        // highlight blue for the followed player, cyan for a selection.
        const r = (focused ? FOLLOW_R : SELECT_R) * km;
        brackets(ctx, x - r, y - r, 2 * r, 2 * r, 6 * km, focused ? look.accent : look.edge, 2 * km);
        marks.push({ x: x - r - 2 * km, y: y - r - 2 * km, w: 2 * r + 4 * km, h: 2 * r + 4 * km, owner });
      }

      // The name tag (Films drawFollowed's tag): centred above the head at
      // one fixed offset, riding the same smoothed position, one width per
      // name. Nothing moves it. An overlap fades the lesser tag instead.
      // The dead keep theirs on the ring, dimmed, fading out over a second.
      // With numbers only the hovered or selected player has one.
      const strong = focused || selected || hovered;
      let base = 1;
      if (hd.dead) base = strong ? 0.8 : 0.6 * clamp(1 - (t - hd.died) / 1000, 0, 1);
      if (nums && !hovered && !selected) base = 0;
      if (base > 0.01) {
        const fitted = fitText(playerLabel(p), tagFont, 140 * k);
        const W = fitted.width + 12 * k, H = tagH;
        labels.push({
          key: `${owner}:tag`, kind: 'tag', owner, text: fitted.text, font: tagFont,
          // The HUD's plates: a team-coloured edge, and the followed player on
          // the highlight blue, like a selected row in the game's menus.
          color: focused ? look.ink : hd.dead ? look.muted : look.text, fill: focused ? look.accent : look.plate, accent: focused ? null : color,
          x: x - W / 2, y: y - TAG_LIFT * km - H, w: W, h: H,
          prio: hovered ? 0 : focused || selected ? 1 : hd.dead ? 3 : 2, order: p.slot, base,
        });
      }
    }

    /** A shot: short lines flaring out round the shooter's head, either
     *  side of the aim (all round while the aim isn't known), fading. */
    function shot(hx) {
      const x = X(hx.hd.x, hx.hd.y), y = Y(hx.hd.x, hx.hd.y);
      if (off(x, y)) return;
      const f = hx.fire / FIRE_MS;
      // Clear of the highlighted player's white ring and high contrast's band.
      const r0 = R + (view.contrast ? CONTRAST_BAND * km : 0) + ((hx.p.handle === lit ? 6 : 4) + 3 * f) * km, r1 = r0 + 6 * km;
      const spokes = hx.ang === null ? [0, 1, 2, 3, 4, 5].map(i => i * Math.PI / 3)
        : [0.6, 1.05, 1.5].flatMap(o => [hx.ang - o, hx.ang + o]);
      ctx.lineCap = 'round';
      for (const [color, width, strength] of [[look.ink, 3.5, 0.6], [look.text, 1.75, 1]]) {
        ctx.globalAlpha = strength * (1 - f * f);
        ctx.strokeStyle = color;
        ctx.lineWidth = width * km;
        ctx.beginPath();
        for (const o of spokes) {
          ctx.moveTo(x + Math.cos(o) * r0, y + Math.sin(o) * r0);
          ctx.lineTo(x + Math.cos(o) * r1, y + Math.sin(o) * r1);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.lineCap = 'butt';
    }

    /** A ring round (x, y). */
    function ring(x, y, r, color, width, strength) {
      ctx.globalAlpha = strength;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /** A player's number centred in their head: in the ink that reads on
     *  their colour, or (`faint`, the dead's) in their colour. White figures
     *  get a dark edge. */
    function number(x, y, n, color, faint) {
      const text = String(n);
      const ink = faint ? color : inkOn(color, look.text, look.ink);
      ctx.font = numFont;
      ctx.letterSpacing = '0px';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (ink === look.text) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = 2.5 * km;
        ctx.strokeStyle = alpha(look.ink, view.contrast ? 0.9 : 0.55);
        ctx.strokeText(text, x, y + 0.5 * km);
      }
      ctx.fillStyle = ink;
      ctx.fillText(text, x, y + 0.5 * km);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }

    /** The soft cone along a player's aim, in their colour. */
    function cone(x, y, ang, color) {
      const len = CONE_LEN * km;
      const fade = ctx.createRadialGradient(x, y, R, x, y, len);
      fade.addColorStop(0, alpha(color, 0.22));
      fade.addColorStop(0.6, alpha(color, 0.09));
      fade.addColorStop(1, alpha(color, 0));
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, len, ang - CONE_HALF, ang + CONE_HALF);
      ctx.closePath();
      ctx.fillStyle = fade;
      ctx.fill();
      const rim = ctx.createRadialGradient(x, y, R, x, y, len);
      rim.addColorStop(0, alpha(color, 0.45));
      rim.addColorStop(0.7, alpha(color, 0.16));
      rim.addColorStop(1, alpha(color, 0));
      ctx.strokeStyle = rim;
      ctx.lineWidth = km;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ang - CONE_HALF) * R, y + Math.sin(ang - CONE_HALF) * R);
      ctx.lineTo(x + Math.cos(ang - CONE_HALF) * len, y + Math.sin(ang - CONE_HALF) * len);
      ctx.moveTo(x + Math.cos(ang + CONE_HALF) * R, y + Math.sin(ang + CONE_HALF) * R);
      ctx.lineTo(x + Math.cos(ang + CONE_HALF) * len, y + Math.sin(ang + CONE_HALF) * len);
      ctx.stroke();
    }

    /** The highlighted player's beam: a white light along the aim, a soft
     *  wide spill under a brighter core (CS:GO's observed player). */
    function beam(x, y, ang) {
      const len = BEAM_LEN * km;
      for (const [half, strength] of [[BEAM_HALF * 1.6, 0.14], [BEAM_HALF, 0.4]]) {
        const g = ctx.createRadialGradient(x, y, R, x, y, len);
        g.addColorStop(0, alpha(look.text, strength));
        g.addColorStop(0.5, alpha(look.text, strength * 0.4));
        g.addColorStop(1, alpha(look.text, 0));
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, len, ang - half, ang + half);
        ctx.closePath();
        ctx.fillStyle = g;
        ctx.fill();
      }
    }

    /** A head's outline, radius `r` round (x, y): a circle, or with `ang`
     *  a teardrop pointing that way, its tip TIP radii out. Grown by a
     *  margin it keeps its shape, so a ring round it runs parallel. */
    function head(x, y, r, ang) {
      const path = new Path2D();
      if (ang === null) {
        path.arc(x, y, r, 0, Math.PI * 2);
        return path;
      }
      const tip = TIP * r, side = Math.acos(1 / TIP);
      path.moveTo(x + Math.cos(ang) * tip, y + Math.sin(ang) * tip);
      path.arc(x, y, r, ang + side, ang - side + Math.PI * 2);
      path.closePath();
      return path;
    }

    /** A shot's dashed trace: from the shooter's head along the aim to the
     *  nearest other living player within TRACE_HALF of it before the first
     *  wall in its way (terrain.js lineOfFire), else to that wall, in range,
     *  else TRACE_LEN long, white on a dark edge, fading, its dashes running
     *  outward. A short bar across its end marks where a wall stopped it. */
    function trace(hx, x, y) {
      const { hd } = hx;
      const wall = fireLine && Number.isFinite(hd.z) ? fireLine.reach(hd.x, hd.y, hd.z, hd.yaw, TRACE_RANGE_FT) : TRACE_RANGE_FT;
      let to = null, best = wall;
      for (const o of heads) {
        if (o === hx || o.hd.dead) continue;
        const dx = o.hd.x - hd.x, dy = o.hd.y - hd.y, dist = Math.hypot(dx, dy);
        if (dist < 1 || dist >= best) continue;
        const bearing = Math.atan2(dy, dx) - hd.yaw;
        const turn = Math.abs(Math.atan2(Math.sin(bearing), Math.cos(bearing)));
        // A little wider up close, where a body spans more of the view.
        if (turn > TRACE_HALF + Math.atan2(1.5, dist)) continue;
        best = dist;
        to = o.hd;
      }
      const from = (arrows ? TIP * R : R) + (view.contrast ? CONTRAST_BAND * km : 0) + 2 * km;
      let ang = hx.ang, len = from + TRACE_LEN * km, stopped = false;
      if (to) {
        const tx = X(to.x, to.y), ty = Y(to.x, to.y);
        ang = Math.atan2(ty - y, tx - x);
        len = Math.hypot(tx - x, ty - y) - R - 2 * km;
      } else if (wall < TRACE_RANGE_FT) {
        len = wall * s;
        stopped = true;
      }
      if (len <= from + 2 * km) return;
      const f = hx.fire / FIRE_MS;
      const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
      const nx = -Math.sin(ang) * 3 * km, ny = Math.cos(ang) * 3 * km;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ang) * from, y + Math.sin(ang) * from);
      ctx.lineTo(ex, ey);
      if (stopped) {
        ctx.moveTo(ex - nx, ey - ny);
        ctx.lineTo(ex + nx, ey + ny);
      }
      ctx.globalAlpha = 0.55 * (1 - f);
      ctx.strokeStyle = look.ink;
      ctx.lineWidth = 3.5 * km;
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.setLineDash([5 * km, 4 * km]);
      ctx.lineDashOffset = reducedMotion.matches ? 0 : -(performance.now() / 25) % (9 * km);
      ctx.globalAlpha = 1 - f;
      ctx.strokeStyle = look.text;
      ctx.lineWidth = 1.75 * km;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ang) * from, y + Math.sin(ang) * from);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      if (stopped) {
        ctx.setLineDash([]);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(ex - nx, ey - ny);
        ctx.lineTo(ex + nx, ey + ny);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Flags: on their stand, on their carrier (riding the drawn head), or
    // where they were dropped.
    for (const flag of flags) {
      const carried = flag.state === 'carried' ? heads.find(x => x.p.handle === flag.carrier.handle && !x.hd.dead) : null;
      const at = carried ? carried.hd : flag.object.position;
      const x = X(at.x, at.y) + (carried ? R : 0), y = Y(at.x, at.y) - (carried ? R : 0);
      if (off(x, y)) continue;
      // Larger than Films' 13px static stands: a flag in play must read at a
      // glance. The skull, the one thing an Oddball game is about, larger still.
      const size = (mode === 'oddball' ? (carried ? 24 : 26) : (carried ? 17 : 20)) * k;
      const fill = mode === 'oddball' || flag.team === null ? P.text : teamColor(flag.team);
      const img = objectiveMark(ctx, mode === 'oddball' ? 'skull' : 'flag', x, y, size, fill, P);
      if (img) marks.push({ x: x - img.w / 2 - 2 * k, y: y - img.h / 2 - 2 * k, w: img.w + 4 * k, h: img.h + 4 * k, owner: `flag:${flag.object.handle}` });
    }

    if (resolveLabels(labels, marks)) moving = true;

    // A dead player's seconds tick on even while nothing moves.
    clearTimeout(deadTimer);
    if (deadShown && !moving && !view.paused && state.feed === 'live') deadTimer = setTimeout(schedule, 1000);

    rehover();
    return moving;
  }

  /** The box round what is on the map when there is no floor plan. */
  function boxOf(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (!p) continue;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    if (minX === Infinity) return null;
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: Math.max(80, maxX - minX + 40), height: Math.max(80, maxY - minY + 40) };
  }

  /** Text cut to `max` px without an ellipsis (copy rules): { text, width }.
   *  With `figures`, its figures in slots (a note's count: figuresWidth). */
  function fitText(text, font, max, figures = false) {
    const key = `${font}|${max}|${figures ? 1 : 0}|${text}`;
    let v = fitCache.get(key);
    if (!v) {
      ctx.font = font;
      ctx.letterSpacing = TRACKING;
      let s = text;
      const measure = figures ? figuresWidth : x => ctx.measureText(x).width;
      while (s.length > 1 && measure(s) > max) s = s.slice(0, -1);
      s = s.trimEnd();
      v = { text: s, width: Math.ceil(measure(s)) };
      if (fitCache.size > 600) fitCache.clear();
      fitCache.set(key, v);
    }
    return v;
  }

  /** Labels never move off their anchors: an overlap is resolved by
   *  opacity. Most important first (hovered, then focused or selected,
   *  which always show, then the living, the dead, then pad notes, with ties
   *  by slot), a label that overlaps one already shown (a name tag: or
   *  another living head, other than one stood on its own, and a note: or
   *  another pad's badge) for FADE_AFTER_MS fades out over about 200 ms (a
   *  ghost of it would smudge what it overlaps), and comes back once it has
   *  been CLEAR_PX clear for CLEAR_AFTER_MS, so players brushing past don't
   *  make tags blink.
   *  Labels that go fade out where they were. Returns true while anything
   *  still fades or waits to. */
  function resolveLabels(labels, heads) {
    const nowMs = performance.now();
    const dt = Math.min(100, Math.max(0, nowMs - labelClock));
    labelClock = nowMs;
    const still = reducedMotion.matches;
    const ease = still ? 1 : 1 - Math.exp(-dt / 70);
    let busy = false;
    const over = (m, n, gap) => m.x < n.x + n.w + gap && m.x + m.w + gap > n.x && m.y < n.y + n.h + gap && m.y + m.h + gap > n.y;

    labels.sort((m, n) => m.prio - n.prio || m.order - n.order);
    const shown = [];
    for (const L of labels) {
      let st = labelState.get(L.key);
      const gap = st?.faded ? CLEAR_PX : 0;
      // Name tags give way to living heads, but not to those on their own
      // head (of players stood together the first tag shows, over them
      // all). Notes give way to tags and to other pads' badges.
      const own = L.kind === 'tag' ? heads.find(m => m.owner === L.owner && !m.dead && !m.pad) : null;
      const blocked = L.prio > 1 && (shown.some(o => over(L, o, gap))
        || heads.some(m => m.owner !== L.owner && over(L, m, gap)
          && (L.kind === 'tag' ? !m.dead && !m.pad && !(own && over(own, m, 0)) : m.pad)));
      if (!st) {
        st = { alpha: 0, faded: blocked, pending: null };
        labelState.set(L.key, st);
      } else if (blocked !== st.faded) {
        // The change waits its time. Hovered, focused and selected show at once.
        st.pending ??= nowMs;
        const wait = L.prio <= 1 ? 0 : blocked ? FADE_AFTER_MS : CLEAR_AFTER_MS;
        if (nowMs - st.pending >= wait) { st.faded = blocked; st.pending = null; } else busy = true;
      } else {
        st.pending = null;
      }
      if (!st.faded) shown.push(L);
      const target = st.faded ? 0 : L.base;
      st.alpha = still ? target : st.alpha + (target - st.alpha) * ease;
      if (Math.abs(target - st.alpha) < 0.01) st.alpha = target; else busy = true;
      st.draw = L;
      st.seen = true;
    }
    // Draw the least important first, so the hovered tag is on top. What
    // went fades out where it last was.
    const order = [];
    for (const [key, st] of labelState) {
      if (!st.seen) {
        st.alpha = still ? 0 : st.alpha * (1 - ease);
        if (st.alpha < 0.02) { labelState.delete(key); continue; }
        busy = true;
      }
      order.push(st);
    }
    order.sort((m, n) => n.draw.prio - m.draw.prio || n.draw.order - m.draw.order);
    for (const st of order) {
      drawLabel(st.draw, st.alpha);
      st.seen = false;
    }
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';
    return busy;
  }

  /** The HUD's face has no tabular figures, so a countdown's plate would
   *  change width each second: every figure takes a slot as wide as a 0.
   *  The width of `text` so, in ctx's font. */
  function figuresWidth(text) {
    if (!/\d/.test(text)) return ctx.measureText(text).width;
    const slot = ctx.measureText('0').width;
    let w = 0;
    for (const run of text.split(/(\d)/)) if (run) w += /\d/.test(run) ? slot : ctx.measureText(run).width;
    return w;
  }

  /** `text` centred on (x, y), with `figures` each figure centred in its slot. */
  function fillFigures(text, x, y, figures) {
    if (!figures || !/\d/.test(text)) { ctx.textAlign = 'center'; ctx.fillText(text, x, y); return; }
    const slot = ctx.measureText('0').width;
    let at = x - figuresWidth(text) / 2;
    ctx.textAlign = 'left';
    for (const run of text.split(/(\d)/)) {
      if (!run) continue;
      const rw = ctx.measureText(run).width;
      if (/\d/.test(run)) { ctx.fillText(run, at + (slot - rw) / 2, y); at += slot; } else { ctx.fillText(run, at, y); at += rw; }
    }
  }

  /** One label plate and its text at `alpha`, at its exact (sub-pixel)
   *  place, so a tag and its head never drift apart. */
  function drawLabel(d, alpha) {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = d.fill;
    ctx.fillRect(d.x, d.y, d.w, d.h);
    if (d.accent) {
      // The HUD's edge: a bar in the team's (or the timer's) colour.
      ctx.fillStyle = d.accent;
      ctx.fillRect(d.x, d.y, 2, d.h);
    }
    ctx.font = d.font;
    ctx.letterSpacing = TRACKING;
    ctx.fillStyle = d.color;
    ctx.textBaseline = 'middle';
    fillFigures(d.text, d.x + d.w / 2 + (d.accent ? 1 : 0), d.y + d.h / 2 + 0.5, d.kind === 'note');
    ctx.textAlign = 'start';
    ctx.letterSpacing = '0px';
  }

  // ── Strips ───────────────────────────────────────────────────────────

  function paintStrips() {
    const before = stripSig();
    // Broadcast and map only show no strips: the broadcast strip says the
    // feed's state, and map only is the map alone.
    const broadcast = state.view.layout !== 'operator';
    const snap = state.snapshot;
    let feed = null;
    if (snap && !broadcast) {
      const line = feedTag(state).line;
      if (state.feed === 'stale') feed = { tone: 'warn', icon: 'alert', text: line };
      else if (state.feed === 'error' || state.feed === 'waiting') feed = { tone: 'err', icon: 'offline', text: line };
    }
    feedStrip.set(feed);
    pausedStrip.set(!broadcast && state.view.paused && snap ? { tone: 'muted', icon: 'pause', text: 'Paused' } : null);
    const p = focusedPlayer();
    followStrip.set(!broadcast && p ? { tone: 'link', icon: 'follow', text: `Following ${playerLabel(p)}`, swatch: playerColor(p) } : null);
    const team = state.view.team;
    let teamName = null;
    if (team !== null && snap) teamName = snap.players.find(x => x.team === team)?.team_name || `Team ${team + 1}`;
    teamStrip.set(!broadcast && teamName ? { tone: 'link', icon: 'filter', text: `Showing ${teamName}` } : null);
    if (stripSig() !== before) schedule();
  }
  const stripSig = () => [feedStrip, pausedStrip, followStrip, teamStrip].map(x => (x.node.hidden ? 0 : x.node.offsetWidth)).join(',');

  // ── Pointer ──────────────────────────────────────────────────────────

  /** What is under (x, y): a head first, then a pad, then anything else.
   *  A finger reaches further than a mouse (Films 22 px and 10 px). */
  function hitAt(x, y, touch) {
    const reach = (touch ? PICK_TOUCH : PICK) * pickScale;
    let best = null, bestRank = Infinity, bestD = Infinity;
    for (const tg of targets) {
      const dd = Math.hypot(tg.x - x, tg.y - y);
      if (dd > Math.max(tg.r, reach)) continue;
      if (tg.rank < bestRank || (tg.rank === bestRank && dd < bestD)) { best = tg.record; bestRank = tg.rank; bestD = dd; }
    }
    return best;
  }

  /** The world point under a screen point, by the last draw's camera with
   *  the pan since. */
  function worldAt(sx, sy) {
    if (!aff) return null;
    const e = aff.e + (pan.x - aff.px), f = aff.f + (pan.y - aff.py);
    const det = aff.a * aff.d - aff.b * aff.c;
    if (!det) return null;
    const dx = sx - e, dy = sy - f;
    return { wx: (aff.d * dx - aff.c * dy) / det, wy: (-aff.b * dx + aff.a * dy) / det };
  }

  function zoomAbout(sx, sy, zoom) {
    const wpt = worldAt(sx, sy);
    const z = clamp(zoom, ZOOM.min, ZOOM.max);
    if (wpt) anchor = { sx, sy, ...wpt };
    if (!setView({ zoom: z }).size) anchor = null;
  }

  /** After a draw or a move: what is under a resting mouse. */
  function rehover() {
    if (!pointer || pointer.touch || drag || pinch) return;
    if (state.view.data) {
      // A limiter's edge counts within 4 CSS px, in world units.
      const at = worldAt(pointer.x, pointer.y);
      const scale = aff ? Math.sqrt(Math.abs(aff.a * aff.d - aff.b * aff.c)) : 0;
      data.read(floor.terrain, at?.wx, at?.wy, scale > 0 ? 4 / scale : 1);
    }
    const record = hitAt(pointer.x, pointer.y, false);
    const target = targetOf(record);
    if (!sameTarget(target, state.hovered)) hover(target);
    const cursor = record ? 'pointer' : '';
    if (canvas.dataset.cursor !== cursor) canvas.dataset.cursor = cursor;
    if (!record) { tipTarget = null; tip.hide(); return; }
    const fresh = !sameTarget(target, tipTarget);
    if (fresh || tipDirty) {
      tip.fill(record, headInfo(record));
      tipDirty = false;
    }
    // Placed once per target, so it never jitters.
    if (fresh) {
      tipTarget = target;
      tip.place(pointer.x, pointer.y, size.w, size.h);
    }
  }

  /** The hover card's playback facts for a player: dead, and since when. */
  function headInfo(record) {
    if (!isPlayer(record)) return null;
    const tr = tracks.get(record.handle);
    const t = playTime();
    const hd = tr ? headOf(tr, t) : null;
    if (hd?.dead && Number.isFinite(t)) return { dead: true, since: Math.max(0, Math.floor((t - hd.died) / 1000)) };
    return { dead: hd ? hd.dead : !record.alive };
  }

  function settleTip() {
    if (tipTarget) { tipTarget = null; tip.hide(); }
  }

  const local = ev => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const pinchOf = () => {
    const [p, q] = [...touches.values()];
    return { d: Math.hypot(p.x - q.x, p.y - q.y), mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2 };
  };

  canvas.addEventListener('pointerdown', ev => {
    canvas.setPointerCapture(ev.pointerId);
    const at = local(ev);
    touches.set(ev.pointerId, at);
    pointer = { ...at, touch: ev.pointerType !== 'mouse' };
    if (touches.size === 2) {
      drag = null;
      const p = pinchOf();
      pinch = { d0: Math.max(1, p.d), zoom0: state.view.zoom, mx: p.mx, my: p.my };
    } else if (touches.size === 1) {
      drag = { x: ev.clientX, y: ev.clientY, total: 0, moved: false };
    }
    camUser = true;
    settleTip();
  });
  canvas.addEventListener('pointermove', ev => {
    const at = local(ev);
    if (touches.has(ev.pointerId)) touches.set(ev.pointerId, at);
    if (pinch && touches.size >= 2) {
      const p = pinchOf();
      camUser = true;
      pan.x += p.mx - pinch.mx;
      pan.y += p.my - pinch.my;
      pinch.mx = p.mx;
      pinch.my = p.my;
      zoomAbout(p.mx, p.my, pinch.zoom0 * p.d / pinch.d0);
      schedule();
      return;
    }
    if (drag) {
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      drag.total += Math.abs(dx) + Math.abs(dy);
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      if (!drag.moved && drag.total > 4) { drag.moved = true; canvas.dataset.cursor = 'grabbing'; }
      if (drag.moved) { pan.x += dx; pan.y += dy; camUser = true; schedule(); }
      return;
    }
    pointer = { ...at, touch: ev.pointerType !== 'mouse' };
    rehover();
  });
  const release = ev => {
    const wasDrag = drag;
    touches.delete(ev.pointerId);
    if (touches.size < 2) pinch = null;
    if (ev.type === 'pointerup' && wasDrag && !wasDrag.moved && touches.size === 0) {
      const at = local(ev);
      pointer = { ...at, touch: ev.pointerType !== 'mouse' };
      select(targetOf(hitAt(at.x, at.y, ev.pointerType !== 'mouse')));
    }
    if (touches.size === 0) drag = null;
    if (canvas.dataset.cursor === 'grabbing') canvas.dataset.cursor = '';
    if (ev.pointerType !== 'mouse') { pointer = null; settleTip(); }
    else rehover();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', ev => {
    if (touches.has(ev.pointerId)) return;
    pointer = null;
    settleTip();
    data.read(null);
    if (state.hovered) hover(null);
  });
  canvas.addEventListener('wheel', ev => {
    ev.preventDefault();
    const at = local(ev);
    const lines = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
    camUser = true;
    zoomAbout(at.x, at.y, state.view.zoom * Math.exp(-ev.deltaY * lines * 0.0015));
  }, { passive: false });
  canvas.addEventListener('dblclick', () => {
    pan = { x: 0, y: 0 };
    framing = null;
    if (!setView({ zoom: 1 }).size) schedule();
  });
  canvas.addEventListener('keydown', ev => {
    const step = ev.shiftKey ? 120 : 40;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[ev.key]) {
      ev.preventDefault();
      pan.x += moves[ev.key][0];
      pan.y += moves[ev.key][1];
      schedule();
    } else if (ev.key === '+' || ev.key === '=') {
      ev.preventDefault();
      setView({ zoom: state.view.zoom * 1.25 });
    } else if (ev.key === '-' || ev.key === '_') {
      ev.preventDefault();
      setView({ zoom: state.view.zoom / 1.25 });
    } else if (ev.key === 'Escape') {
      // The selection first, then the focus (then the page's own Escape).
      if (state.selected) { select(null); ev.stopPropagation(); }
      else if (state.view.focus) { setView({ focus: null }); ev.stopPropagation(); }
    }
  });

  new ResizeObserver(() => { measure(); schedule(); }).observe(root);

  // ── Store ────────────────────────────────────────────────────────────

  const RESET = ['epoch', 'geometry', 'view.filter', 'view.framing', 'view.floor', 'view.heightMode',
    'view.orientation', 'view.focus', 'view.team', 'view.level'];
  subscribe(changed => {
    if (changed.has('epoch')) { resetTracks(); loadingSince = performance.now(); }
    if (RESET.some(key => changed.has(key))) { framing = null; pan = { x: 0, y: 0 }; anchor = null; }
    if (changed.has('view.layout')) requestAnimationFrame(() => { measure(); paintStrips(); schedule(); });
    if (changed.has('snapshot') && state.snapshot) {
      if (ingest(state.snapshot)) tipDirty = true;
    }
    if (changed.has('snapshot') || changed.has('feed') || changed.has('age') || changed.has('view.paused')
      || changed.has('view.focus') || changed.has('view.team') || changed.has('view.layout') || changed.has('teamColors')) paintStrips();
    if (changed.has('snapshot') || changed.has('view') || changed.has('selected') || changed.has('hovered')
      || changed.has('geometry') || changed.has('atlas') || changed.has('epoch') || changed.has('feed')
      || changed.has('teamColors') || changed.has('floorColor')) schedule();
  });
  if (state.snapshot) ingest(state.snapshot);
  measure();
  paintStrips();
  schedule();

  // ── Strip and hover card builders ─────────────────────────────────────

  /** One status strip (Films stageStrip), hidden until set(). */
  function strip(action) {
    const lead = el('span', { class: 'map-strip-icon' });
    const sw = swatch('var(--muted)');
    sw.hidden = true;
    const text = el('span', { class: 'map-strip-text truncate' });
    const node = el('div', { class: 'map-strip', role: 'status', hidden: true, dataset: { plain: action ? null : '' } }, lead, sw, text, action);
    let iconName = '';
    return {
      node,
      set(o) {
        if (!o) { if (!node.hidden) node.hidden = true; return; }
        if (node.hidden) node.hidden = false;
        if (node.dataset.tone !== o.tone) node.dataset.tone = o.tone;
        if (iconName !== o.icon) { iconName = o.icon; lead.replaceChildren(icon(o.icon, 12)); }
        sw.hidden = !o.swatch;
        if (o.swatch) sw.style.setProperty('--swatch', o.swatch);
        setText(text, o.text);
      },
    };
  }
}

/** The map hover card (Films viewer/hover.ts): built once, slots written in
 *  place. Players: name, alive or dead, team, shield and health, kills,
 *  deaths and assists. Pads: name, timer, class and cycle, state, progress. */
function hoverCard() {
  const name = el('span', { class: 'map-tip-name truncate' });
  const side = el('span', { class: 'map-tip-side num' });
  const head = el('div', { class: 'map-tip-head' }, name, side);
  const sub = el('div', { class: 'map-tip-line' });
  const meter = (cls, label) => {
    const fill = el('span', { class: 'map-tip-fill' });
    const track = el('span', { class: ['map-tip-bar', cls], title: label }, fill);
    const num = el('span', { class: 'map-tip-num num' });
    return { track, fill, num };
  };
  const sh = meter('shield', 'Shield');
  const hp = meter('health', 'Health');
  const vitals = el('div', { class: 'map-tip-vitals' }, sh.track, sh.num, hp.track, hp.num);
  const stat = label => {
    const v = el('span', { class: 'map-tip-stat-v num' });
    return { v, node: el('span', { class: 'map-tip-stat' }, el('span', { class: 'caps' }, label), v) };
  };
  const kills = stat('K'), deaths = stat('D'), assists = stat('A');
  const kda = el('div', { class: 'map-tip-kda' }, kills.node, deaths.node, assists.node);
  const note = el('div', { class: 'map-tip-line' });
  const progFill = el('span', { class: 'map-tip-fill' });
  const prog = el('div', { class: 'map-tip-vitals' }, el('span', { class: 'map-tip-bar incoming', title: 'Progress to the next spawn' }, progFill));
  const card = el('div', { class: 'map-tip', role: 'status', hidden: true }, head, sub, vitals, kda, note, prog);

  const show = (node, on) => { if (node.hidden === on) node.hidden = !on; };
  const bar = (fill, num, v) => {
    const tx = `scaleX(${clamp(v ?? 0, 0, 1).toFixed(3)})`;
    if (fill.style.transform !== tx) fill.style.transform = tx;
    if (num) setText(num, Number.isFinite(v) ? String(Math.round(v * 100)) : '');
  };

  return {
    el: card,
    /** Write the record's facts. For players, `info` is { dead, since }. */
    fill(record, info) {
      setText(name, recordTitle(record));
      if (isPlayer(record)) {
        card.style.borderTopColor = playerColor(record);
        setText(side, info?.dead ? (info.since !== undefined ? `Dead, ${info.since} s` : 'Dead') : 'Alive');
        setText(sub, record.team_name || (record.observer ? 'Observer' : 'No team'));
        show(sub, true);
        const v = record.vitality;
        show(vitals, Boolean(v) && !info?.dead);
        if (v) {
          bar(sh.fill, sh.num, v.shield);
          bar(hp.fill, hp.num, v.health);
        }
        const st = record.stats;
        show(kda, Boolean(st));
        if (st) {
          setText(kills.v, fmt.int(st.kills));
          setText(deaths.v, fmt.int(st.deaths));
          setText(assists.v, fmt.int(st.assists));
        }
        show(note, false);
        show(prog, false);
      } else if (isPad(record)) {
        const tm = padTimer(record);
        card.style.borderTopColor = tm.state === 'incoming' ? 'var(--timer-incoming)' : 'var(--border)';
        setText(side, tm.state === 'incoming' && Number.isFinite(tm.remaining) ? fmt.countdown(tm.remaining) : tm.text);
        const cycle = tm.cycle ? `respawns every ${fmt.seconds(tm.cycle, 0)}` : '';
        setText(sub, [CLASS_WORD[itemClass(record)], cycle].filter(Boolean).join(', '));
        show(sub, true);
        show(vitals, false);
        show(kda, false);
        const extra = tm.note || (tm.state !== 'ready' && tm.state !== 'incoming' ? fmt.words(tm.state === 'unknown' ? '' : tm.state) : '');
        setText(note, extra);
        show(note, Boolean(extra));
        show(prog, tm.progress !== null);
        if (tm.progress !== null) bar(progFill, null, tm.progress);
      } else {
        card.style.borderTopColor = 'var(--border)';
        setText(side, '');
        setText(sub, record.handle);
        show(sub, true);
        show(vitals, false);
        show(kda, false);
        show(note, false);
        show(prog, false);
      }
      show(card, true);
    },
    /** Right of and below (x, y), flipped when it would overflow (Films). */
    place(x, y, w, h) {
      const cw = card.offsetWidth, ch = card.offsetHeight;
      const left = x + 12 + cw > w ? x - 12 - cw : x + 12;
      const top = y + 12 + ch > h ? y - 12 - ch : y + 12;
      card.style.left = `${Math.max(0, Math.round(left))}px`;
      card.style.top = `${Math.max(0, Math.round(top))}px`;
    },
    hide() { show(card, false); },
  };
}
