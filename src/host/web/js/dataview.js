// The data view (?view=data, the Check group's Data toggle): what each part of
// a map's floor is, as film-assets' terrain tool reads it from the map's
// collision geometry and its navmesh, each kind one flat colour, with a
// legend. It is for checking the map data, not for a broadcast.
//
// The kinds come in the high four bits of the terrain's height image
// (terrain.js heightsOf, and film-assets tools/terrain layers.rs KIND_*, made by
// surface.rs). Hovering reads a point: what it is, its height and where that
// comes from, what was measured there, and the rule that made it so. Over
// them go the plan's limits (/api/access/<id>, the server's limits.rs, from
// film-assets' access files): the limiters players can't pass, and every area
// the plan leaves out with the rule that removed it, each marked as read from
// the map or inferred. Hovering one reads what it is and where it comes from.

import { el } from './dom.js';
import { heightsOf, pixelAt } from './terrain.js';

/** The height image's flags (its blue's low bits). */
const ON = 1, SOLID = 2, WALK = 4, ROOF = 8;

/** What a pixel is, by its kind code (the blue's high four bits): a name, a
 *  flat colour, whether its height is only the navmesh's (striped), and
 *  the rule that made it so. */
export const KINDS = [
  null,
  { key: 'floor', name: 'Floor', color: '#3f74a6', rule: 'Flat: its collision surface slopes less than 1 in 20 over 2 ft, and steps under 1 ft.' },
  { key: 'stairs', name: 'Stairs', color: '#f2c14e', rule: 'Along the climb, 3 or more risers of 0.3 to 1.6 ft, alike, with treads of 0.5 to 5 ft between them. A flight is 6 ft² and 2 ft wide or more.' },
  { key: 'ramp', name: 'Ramp', color: '#4fcf7f', rule: "A structure's smooth sloped surface, 1 in 16 or steeper, 12 to 2,500 ft² and 2.5 ft wide or more, that meets flat floor, walls or drops, not other slopes." },
  { key: 'ledge', name: 'Ledge', color: '#ffffff', rule: "The lip of a step of 1 ft or more down from a structure's floor, 3 ft long or more." },
  { key: 'drop', name: 'Drop', color: '#e8574e', rule: 'Flat floor on the low side of a ledge, near the step: half as far from it as the step is high, 1 to 5 ft.' },
  { key: 'ground', name: 'Natural ground', color: '#b9824c', rule: 'Sloped (natural ground from 1 in 33) and neither stairs nor a ramp: rock, terrain, a slope larger than a ramp. 40 ft² or more, rising 1.5 ft or more.' },
  { key: 'obstacle', name: 'Obstacle', color: '#8d939c', rule: 'A structure on the floor: a wall cut through 1.5 ft over the floor, cover, a block at its own top.' },
  { key: 'roof', name: 'Roof', color: '#c985d4', rule: "A building's roof over the floor: flat, facing up, at most 40 ft over the floor under it." },
  { key: 'navfloor', name: 'Floor, navmesh', color: '#3f74a6', nav: true, rule: 'No collision under it was read, so its height is the navmesh. Flat by the floor rule.' },
  { key: 'navground', name: 'Ground, navmesh', color: '#b9824c', nav: true, rule: "No collision under it was read: sloped as the navmesh's facets are." },
];

/** The limits drawn over the kinds, when a plan has them: the limiters, then
 *  the areas it leaves out, by the rule that removed each (film-assets
 *  tools/playable and tools/forge-geo). `read` says whether it comes from
 *  the map data itself (outlined in full), else from a rule with numbers
 *  the map data doesn't name (dashed). */
const LIMITS = [
  { key: 'limiter', name: 'Limiter', color: '#ff3b6b', read: true, rule: "An invisible wall or a Forge blocker players can't pass, its outline seen from above, from the map's collision and its Forge objects." },
  { key: 'limit', name: 'Closed by a limiter', color: '#ff3b6b', read: true, rule: 'Floor a limiter closes: under it, inside it, or with no way past it, where a crouching player meets it.' },
  { key: 'barrier', name: 'Cut off by a barrier', color: '#ff9f43', read: true, rule: "A mode's barrier cuts it off from where the mode is played: a door, a gate or a prop the mode's Forge labels place." },
  { key: 'shut', name: 'Shut in a mode', color: '#ffd166', read: false, rule: 'A floor of its own that the mode puts nothing on, with one of its barriers beside it.' },
  { key: 'unreachable', name: 'Out of reach', color: '#4cc9f0', read: false, rule: 'No walk, jump, clamber, drop or device gets there from the spawns, weapons and objectives.' },
  { key: 'elsewhere', name: 'Another part', color: '#b8c4d0', read: false, rule: 'Another part of the level, far from where the mode is played, its height counted.' },
  { key: 'footprint', name: 'Too small', color: '#e6e6e6', read: false, rule: "Floor a cut leaves smaller than a Spartan's footprint, a circle of radius 2 ft." },
];
const LIMIT = Object.fromEntries(LIMITS.map(k => [k.key, k]));

/** `#rrggbb` as [r, g, b]. */
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

/** Each terrain's kinds as a canvas (the relief's size), or null without them. */
const canvases = new WeakMap();
function kindCanvas(t) {
  if (canvases.has(t)) return canvases.get(t);
  const layer = heightsOf(t);
  let canvas = null;
  if (layer && layer.flags.some(f => f >> 4)) {
    const { w, h } = t.data;
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext('2d');
    const img = c.createImageData(w, h);
    const px = img.data;
    const colours = KINDS.map(k => (k ? rgb(k.color) : null));
    for (let p = 0, q = 0; p < layer.flags.length; p++, q += 4) {
      const f = layer.flags[p];
      const kind = KINDS[f >> 4];
      if (!(f & ON) || !kind) continue;
      let [r, g, b] = colours[f >> 4];
      // The navmesh's heights striped, a little darker.
      if (kind.nav && ((p % w) + Math.floor(p / w)) % 4 < 2) { r *= 0.6; g *= 0.6; b *= 0.6; }
      px[q] = r;
      px[q + 1] = g;
      px[q + 2] = b;
      px[q + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }
  canvases.set(t, canvas);
  return canvas;
}

/** Whether terrain `t` says what each pixel is (newer map data does). */
export const hasKinds = t => Boolean(t && kindCanvas(t));

/** Rings (each a flat list of points) as one path. */
function ringsPath(rings) {
  const path = new Path2D();
  for (const p of rings ?? []) {
    if (!Array.isArray(p) || p.length < 6) continue;
    path.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) path.lineTo(p[i], p[i + 1]);
    path.closePath();
  }
  return path;
}

/** `[lo, hi]` when it is two numbers. */
const span = z => (Array.isArray(z) && z.length === 2 && z.every(Number.isFinite) ? z : null);

/** A plan's limits as the view draws and reads them: the limiters (`what`,
 *  `from`, its map variant, labels and heights, and whether it closes floor
 *  in this plan), the areas left out (their rule, what did it and where
 *  that comes from, their heights), each with its path, lowest first, and
 *  the rules present. */
function limitsFrom(j) {
  const all = (Array.isArray(j?.limits) ? j.limits : []).map(l => (Array.isArray(l?.p) && l.p.length >= 6 ? {
    what: String(l.what ?? ''), from: String(l.from ?? ''), variant: l.variant ? String(l.variant) : null,
    labels: Array.isArray(l.labels) ? l.labels.map(String) : [], z: span(l.z), path: ringsPath([l.p]), closes: false,
  } : null));
  const limiters = all.filter(Boolean);
  const removed = [];
  for (const r of Array.isArray(j?.removed) ? j.removed : []) {
    const kind = LIMIT[r?.rule];
    if (!kind || kind.key === 'limiter' || !Array.isArray(r.p) || !r.p.length) continue;
    // A limit's row names its limiter by index (limits.rs).
    const limiter = Number.isInteger(r.limit) ? all[r.limit] : null;
    if (limiter) limiter.closes = true;
    removed.push({
      kind, what: String((limiter ?? r).what ?? ''), from: String((limiter ?? r).from ?? ''), z: span(r.z), path: ringsPath(r.p),
    });
  }
  removed.sort((a, b) => (a.z?.[1] ?? 0) - (b.z?.[1] ?? 0));
  const rules = new Set(removed.map(r => r.kind.key));
  if (limiters.length) rules.add('limiter');
  const m = j?.movement ?? {};
  const movement = ['clamber', 'jump'].every(k => Number.isFinite(m[k])) ? { clamber: m.clamber, jump: m.jump } : null;
  return rules.size ? { limiters, removed, rules, movement } : null;
}

/** Each plan's limits (/api/access/<id>), by geometry id: as limitsFrom
 *  gives them, null without them, or 'loading'. */
const limits = new Map();
function limitsOf(id, onLoad) {
  if (!id) return null;
  if (!limits.has(id)) {
    limits.set(id, 'loading');
    fetch(`/api/access/${encodeURIComponent(id)}`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(j => {
        limits.set(id, j ? limitsFrom(j) : null);
        onLoad();
      });
  }
  const l = limits.get(id);
  return l === 'loading' ? null : l;
}

/** The areas left out (`removed`), dark and tinted in their rule's colour,
 *  where the plan holds no floor (`clip`): one under or over floor the plan
 *  keeps (a copy of the map far above it, a canvas floor far below) would
 *  hide that floor, so there it is only outlined. Then every outline, in
 *  full where the map data says so, dashed where a rule infers it. */
function paintRemoved(ctx, removed, clip, unit) {
  const fills = document.createElement('canvas');
  fills.width = ctx.canvas.width;
  fills.height = ctx.canvas.height;
  const f = fills.getContext('2d');
  f.setTransform(ctx.getTransform());
  for (const r of removed) {
    f.fillStyle = 'rgba(11, 16, 22, 0.7)';
    f.fill(r.path, 'nonzero');
    const [cr, cg, cb] = rgb(r.kind.color);
    f.fillStyle = `rgba(${cr}, ${cg}, ${cb}, 0.16)`;
    f.fill(r.path, 'nonzero');
  }
  if (clip) {
    // Opaque, so the plan's area is cut out whole.
    f.globalCompositeOperation = 'destination-out';
    f.fillStyle = '#000';
    f.fill(clip, 'nonzero');
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(fills, 0, 0);
  ctx.restore();
  ctx.lineWidth = 1.25 / unit;
  for (const r of removed) {
    ctx.strokeStyle = r.kind.color;
    ctx.setLineDash(r.kind.read ? [] : [4 / unit, 3 / unit]);
    ctx.stroke(r.path);
  }
}

/** Draw terrain `t`'s kinds on `ctx` (its transform maps world units to the
 *  canvas, `unit` a world unit in CSS px), kept to `clip` (the plan's area,
 *  nonzero), then the plan's limits (`id`'s, `repaint` called once they
 *  load) over them and past the clip, since what a plan leaves out lies
 *  outside it. False when the terrain has no kinds (older map data), and
 *  nothing is drawn. */
export function paintData(ctx, t, clip, unit, id, repaint) {
  const canvas = kindCanvas(t);
  if (!canvas) return false;
  const { x, y, res, w, h } = t.data;
  ctx.save();
  if (clip) ctx.clip(clip, 'nonzero');
  ctx.imageSmoothingEnabled = false;
  ctx.transform(res, 0, 0, -res, x, y);
  ctx.drawImage(canvas, 0, 0, w, h);
  ctx.restore();
  const l = limitsOf(id, repaint);
  if (!l) return true;
  ctx.save();
  ctx.lineJoin = 'round';
  paintRemoved(ctx, l.removed, clip, unit);
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5 / unit;
  for (const b of l.limiters) {
    ctx.fillStyle = b.closes ? 'rgba(255, 59, 107, 0.35)' : 'rgba(255, 59, 107, 0.18)';
    ctx.fill(b.path, 'nonzero');
    ctx.strokeStyle = LIMIT.limiter.color;
    ctx.stroke(b.path);
  }
  ctx.restore();
  return true;
}

/** What lies at world point (x, y) among limits `l`: the limiters, then the
 *  areas left out from the highest, a limiter's edge counted within `slop`
 *  world units. */
let hitContext = null;
function limitsAt(l, x, y, slop) {
  if (!l || !Number.isFinite(x)) return [];
  hitContext ??= document.createElement('canvas').getContext('2d');
  const c = hitContext;
  c.lineWidth = slop * 2;
  const hits = l.limiters.filter(b => c.isPointInPath(b.path, x, y, 'nonzero') || c.isPointInStroke(b.path, x, y));
  for (let i = l.removed.length - 1; i >= 0; i--) if (c.isPointInPath(l.removed[i].path, x, y, 'nonzero')) hits.push(l.removed[i]);
  return hits;
}

/** Feet with one decimal, and metres. */
const feet = v => `${v.toFixed(1)} ft (${(v * 0.3048).toFixed(1)} m)`;

/** What was measured at pixel `p` of a terrain's heights for its kind: the
 *  slope of a ramp or ground, the step of a ledge or below a drop. */
function measured(t, layer, p, kind) {
  const { w, h, res } = t.data;
  const i = p % w, j = Math.floor(p / w);
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h && layer.flags[y * w + x] & ON ? layer.height[y * w + x] : null);
  const here = layer.height[p];
  if (kind.key === 'ramp' || kind.key === 'ground' || kind.key === 'navground' || kind.key === 'stairs') {
    const e = at(i + 2, j), wv = at(i - 2, j), n = at(i, j - 2), s = at(i, j + 2);
    if ([e, wv, n, s].some(v => v === null)) return null;
    const g = Math.hypot((e - wv) / (4 * res), (n - s) / (4 * res));
    if (g < 0.005) return 'Level here';
    return `Slope ${(Math.atan(g) * 180 / Math.PI).toFixed(0)}°, 1 in ${(1 / g).toFixed(1)}`;
  }
  if (kind.key === 'ledge' || kind.key === 'drop') {
    // The highest and lowest floor within 5 ft.
    const r = Math.max(1, Math.round(5 / res));
    let hi = here, lo = here;
    for (let y = j - r; y <= j + r; y++) for (let x = i - r; x <= i + r; x++) {
      const v = at(x, y);
      if (v !== null && Math.hypot(x - i, y - j) <= r) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
    }
    return kind.key === 'ledge' ? `Drops ${(here - lo).toFixed(1)} ft within 5 ft` : `${(hi - here).toFixed(1)} ft below the step`;
  }
  return null;
}

/** Heights `[lo, hi]` in feet, one or a range. */
const heights = z => (z[1] - z[0] < 0.05 ? `${z[0].toFixed(1)} ft` : `${z[0].toFixed(1)} to ${z[1].toFixed(1)} ft`);

/** The legend and the hover readout, a fixed size so nothing moves as the
 *  pointer does. read(t, x, y, slop) reads world point (x, y) of terrain
 *  `t`, a limit first (its edge within `slop` world units), or clears the
 *  readout with no terrain. show(on, t, id) shows it or hides it, with the
 *  kinds and limits the map has. */
export function dataLegend() {
  const swatch = (k, small) => el('span', { class: `map-data-swatch${small ? ' small' : ''}${k.nav ? ' nav' : ''}`, style: { '--swatch': k.color } });
  const limitSwatch = k => el('span', { class: `map-data-swatch small limit${k.read ? '' : ' inferred'}`, style: { '--swatch': k.color } });
  const source = k => (k.read ? 'Read' : 'Inferred');
  const rows = [
    ...KINDS.filter(Boolean).map(k => ({ k, row: el('div', { class: 'map-data-key', title: k.rule }, swatch(k, true), el('span', { class: 'truncate' }, k.name)) })),
    ...LIMITS.map(k => ({
      k,
      row: el('div', { class: 'map-data-key', title: k.rule }, limitSwatch(k), el('span', { class: 'truncate' }, k.name),
        el('span', { class: 'map-data-source' }, source(k))),
    })),
  ];
  const kindRows = rows.filter(r => !LIMITS.includes(r.k));
  const limitRows = rows.filter(r => LIMITS.includes(r.k));
  const note = el('div', { class: 'map-data-note' });
  const moves = el('div', { class: 'map-data-moves truncate' });
  const head = el('div', { class: 'map-data-head' });
  const name = el('span', { class: 'map-data-name truncate' });
  const tag = el('span', { class: 'map-data-source' });
  const height = el('div', { class: 'map-data-line truncate' });
  const extra = el('div', { class: 'map-data-line truncate' });
  const rule = el('div', { class: 'map-data-rule' });
  const readSwatch = el('span', { class: 'map-data-swatch' });
  head.append(readSwatch, name, tag);
  const readout = el('div', { class: 'map-data-read' }, head, height, extra, rule);
  const node = el('div', { class: 'map-data', hidden: true, dataset: { occlude: '' } },
    el('div', { class: 'map-data-title' }, 'Map data'),
    el('div', { class: 'map-data-keys' }, ...kindRows.map(r => r.row)),
    el('div', { class: 'map-data-limits' }, ...limitRows.map(r => r.row)),
    moves, note, readout);
  const look = k => {
    readSwatch.style.setProperty('--swatch', k.color);
    readSwatch.classList.toggle('nav', Boolean(k.nav));
    readSwatch.classList.toggle('limit', LIMITS.includes(k));
    readSwatch.classList.toggle('inferred', LIMITS.includes(k) && !k.read);
    name.textContent = k.name;
    tag.textContent = LIMITS.includes(k) ? source(k) : '';
  };
  const empty = () => {
    readSwatch.style.removeProperty('--swatch');
    readSwatch.classList.remove('nav', 'limit', 'inferred');
    name.textContent = 'Point at the map';
    tag.textContent = '';
    height.textContent = '';
    extra.textContent = '';
    rule.textContent = 'What each part of the floor is, from the collision geometry and the navmesh, and what the plan leaves out.';
  };
  empty();
  let last = null;
  let shown = null;
  return {
    el: node,
    show(on, t, id) {
      const l0 = limits.get(id);
      if (shown && shown.on === on && shown.t === t && shown.id === id && shown.l === l0) return;
      shown = { on, t, id, l: l0 };
      last = null;
      node.hidden = !on;
      if (!on) return;
      const layer = t ? heightsOf(t) : null;
      const kinds = new Set();
      if (layer) for (const f of layer.flags) if (f & ON) kinds.add(f >> 4);
      const l = l0 && l0 !== 'loading' ? l0 : null;
      for (const { k, row } of rows) {
        const have = LIMITS.includes(k) ? Boolean(l?.rules.has(k.key)) : kinds.has(KINDS.indexOf(k));
        row.toggleAttribute('data-absent', !have);
      }
      // The moves reach is inferred by.
      moves.textContent = l?.movement
        ? `Inferred reach: clamber ${l.movement.clamber}, jump ${l.movement.jump}, device 100 ft`
        : 'This plan has no limits in the map data.';
      note.textContent = !t ? 'This map has no terrain to read.' : !layer || ![...kinds].some(Boolean) ? 'This map data predates the kinds: rebuild its terrain.' : '';
      note.hidden = !note.textContent;
    },
    read(t, x, y, slop = 1) {
      const l = shown && limits.get(shown.id);
      const hits = t && l && l !== 'loading' ? limitsAt(l, x, y, slop) : [];
      const layer = t ? heightsOf(t) : null;
      const p = layer && Number.isFinite(x) ? pixelAt(t, x, y) : -1;
      const f = p >= 0 ? layer.flags[p] : 0;
      const key = hits.length ? hits : p >= 0 && f & ON ? p : null;
      if (key === last || (Array.isArray(key) && Array.isArray(last) && key.length === last.length && key.every((h, i) => h === last[i]))) return;
      last = key;
      if (key === null) { empty(); return; }
      if (hits.length) {
        const hit = hits[0];
        const more = hits.length > 1 ? `, ${hits.length - 1} more here` : '';
        if (hit.kind) {
          look(hit.kind);
          height.textContent = `${hit.z ? heights(hit.z) : 'Height not given'}${more}`;
          extra.textContent = hit.what || hit.from;
          rule.textContent = `${hit.what && hit.from ? `${hit.from}. ` : ''}${hit.kind.rule}`;
        } else {
          look(LIMIT.limiter);
          name.textContent = `Limiter: ${hit.what}`;
          height.textContent = `${hit.z ? `Solid ${heights(hit.z)}` : 'Height not given'}${more}`;
          extra.textContent = [hit.variant ? `On ${hit.variant}` : null, hit.labels.length ? hit.labels.join(', ') : null,
            hit.closes ? 'closes floor in this plan' : 'closes no floor in this plan'].filter(Boolean).join(', ');
          rule.textContent = `${hit.from}. ${LIMIT.limiter.rule}`;
        }
        return;
      }
      const kind = KINDS[f >> 4] ?? { name: 'Unread', color: '#000000', rule: 'This map data predates the kinds.' };
      look(kind);
      const v = layer.height[p];
      const facts = [f & WALK ? (kind.nav ? 'navmesh floor' : 'walkable, collision height') : 'top surface', f & SOLID ? 'solid at eye height' : null, f & ROOF ? 'roofed' : null].filter(Boolean);
      height.textContent = `${feet(v)}, ${facts.join(', ')}`;
      extra.textContent = measured(t, layer, p, kind) ?? '';
      rule.textContent = kind.rule;
    },
  };
}
