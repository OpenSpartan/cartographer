// A map's terrain (films-ui floor.ts) as heights, for what the map draws by
// height: an elevation slice that keeps the terrain's look, and where a shot
// meets a wall.
//
// A map's heights come as an image of their own beside its terrain
// (`<id>.height.png`, named by the terrain's `height`: { image, z0, step }),
// the relief's size and frame. Each pixel's height is z0 + (256 R + G) step
// ft: the floor a player stands on (the highest where floors stack), else the
// top of what is there. Its blue's low four bits are flags: ON the map, SOLID
// at eye height (something stands 3 to 6 ft over the floor), WALK a floor
// players walk on, ROOF a roof standing over that floor (more than 6 ft over
// it). Off the map all four are 0. In newer map data its high four bits say
// what the pixel is (floor, stairs, a ramp, a ledge, ..., dataview.js KINDS),
// which only the data view reads. With it comes the relief film-assets draws today (tools/
// terrain, relief()): open floor is FLOOR_GREY of the way from black at the
// low end of the terrain's z range to white at the high end, in a straight
// ramp.
//
// A map without one is older map data, whose relief had another ramp: on
// flat ground the grey was 0.16 + 0.70 t^0.85 of the way from black, raised
// to the power 1/1.6, where t is the height's place in the terrain's z
// range. Such a map falls back on that grey read back as heights, to under a
// foot on floors and a few feet off on slopes the light falls away from,
// close enough to tell one storey from the next.

/** The height image's flags (its blue). */
const ON = 1, SOLID = 2, WALK = 4, ROOF = 8;

/** The grey of the lowest open floor in a relief with heights, 0 to 1. */
const FLOOR_GREY = 0.22;

/** An older relief's grey, 0 to 255, as a height in the terrain's range, ft. */
function heightLut(z) {
  const lut = new Float32Array(256);
  for (let g = 0; g < 256; g++) {
    const t = Math.min(1, Math.max(0, ((g / 255) ** 1.6 - 0.16) / 0.7)) ** (1 / 0.85);
    lut[g] = z[0] + t * (z[1] - z[0]);
  }
  return lut;
}

/** A height in the terrain's range `z` as the grey an older relief gives
 *  flat ground there. */
function greyAt(z, height) {
  const t = Math.min(1, Math.max(0, (height - z[0]) / (z[1] - z[0] || 1)));
  return Math.round(255 * (0.16 + 0.7 * t ** 0.85) ** (1 / 1.6));
}

/** A height in the terrain's range `z` as the grey a relief with heights
 *  gives open floor there. */
function floorGrey(z, height) {
  const t = Math.min(1, Math.max(0, (height - z[0]) / (z[1] - z[0] || 1)));
  return Math.round(255 * (FLOOR_GREY + (1 - FLOOR_GREY) * t));
}

/** `v` (w by h) averaged over a (2r + 1) square round each pixel, counting
 *  only those `alpha` covers: running sums along the rows, then down the
 *  columns. */
function smooth(v, alpha, w, h, r) {
  const sum = new Float32Array(w * h), cnt = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const row = j * w;
    let s = 0, c = 0;
    for (let i = -r; i < w; i++) {
      const add = i + r, drop = i - r - 1;
      if (add < w && alpha[row + add]) { s += v[row + add]; c++; }
      if (drop >= 0 && alpha[row + drop]) { s -= v[row + drop]; c--; }
      if (i >= 0) { sum[row + i] = s; cnt[row + i] = c; }
    }
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w; i++) {
    let s = 0, c = 0;
    for (let j = -r; j < h; j++) {
      const add = j + r, drop = j - r - 1;
      if (add < h) { s += sum[add * w + i]; c += cnt[add * w + i]; }
      if (drop >= 0) { s -= sum[drop * w + i]; c -= cnt[drop * w + i]; }
      if (j >= 0) out[j * w + i] = c > 0 ? s / c : v[j * w + i];
    }
  }
  return out;
}

/** Each terrain's relief as pixels, read once: { w, h, grey, alpha,
 *  height() }, the heights worked out on first use, a little smoothed, so
 *  rough rock doesn't speckle a slice. */
const reliefs = new WeakMap();
function reliefOf(t) {
  let r = reliefs.get(t);
  if (r) return r;
  const { w, h, z } = t.data;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.drawImage(t.relief, 0, 0, w, h);
  const px = c.getImageData(0, 0, w, h).data;
  const grey = new Uint8Array(w * h), alpha = new Uint8Array(w * h);
  for (let p = 0, q = 0; p < grey.length; p++, q += 4) {
    grey[p] = px[q];
    alpha[p] = px[q + 3];
  }
  let height = null;
  r = {
    w, h, grey, alpha,
    height() {
      if (!height) {
        const lut = heightLut(z), raw = new Float32Array(w * h);
        for (let p = 0; p < raw.length; p++) raw[p] = lut[grey[p]];
        height = smooth(raw, alpha, w, h, 2);
      }
      return height;
    },
  };
  reliefs.set(t, r);
  return r;
}

/** Each terrain's height image, as withHeights gave it. */
const heightImages = new WeakMap();

/** Terrain `t` (films-ui terrainOf) with its height image, an ImageBitmap of
 *  its bytes as they are (no colour management), where it has one. */
export function withHeights(t, image) {
  if (t && image && t.data.height) heightImages.set(t, image);
  return t;
}

/** Each terrain's heights from its height image, read once: { height, flags }
 *  per pixel of the relief, or null without one (or one of another size). */
const layers = new WeakMap();
function layerOf(t) {
  if (layers.has(t)) return layers.get(t);
  const image = heightImages.get(t);
  const { w, h, height: code } = t.data;
  let layer = null;
  if (image && image.width === w && image.height === h && Number.isFinite(code?.z0) && code?.step > 0) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext('2d', { willReadFrequently: true });
    c.drawImage(image, 0, 0);
    const px = c.getImageData(0, 0, w, h).data;
    const height = new Float32Array(w * h), flags = new Uint8Array(w * h);
    for (let p = 0, q = 0; p < flags.length; p++, q += 4) {
      height[p] = code.z0 + (256 * px[q] + px[q + 1]) * code.step;
      flags[p] = px[q + 2];
    }
    layer = { height, flags };
  }
  layers.set(t, layer);
  return layer;
}

/** Terrain `t`'s heights for reading points (dataview.js): { height, flags }
 *  per pixel of its relief, or null for a terrain without them. */
export const heightsOf = t => (t ? layerOf(t) : null);

/** `m` (w by h, 0 or 1) spread `r` pixels each way: 1 where any of the
 *  (2r + 1) square round a pixel is. Running counts along the rows, then
 *  down the columns a row at a time. */
function spread(m, w, h, r) {
  const rows = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const row = j * w;
    let c = 0;
    for (let i = -r; i < w; i++) {
      const add = i + r, drop = i - r - 1;
      if (add < w && m[row + add]) c++;
      if (drop >= 0 && m[row + drop]) c--;
      if (i >= 0) rows[row + i] = c > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h), count = new Int32Array(w);
  for (let j = -r; j < h; j++) {
    const add = j + r, drop = j - r - 1;
    if (add < h) for (let i = 0, p = add * w; i < w; i++, p++) count[i] += rows[p];
    if (drop >= 0) for (let i = 0, p = drop * w; i < w; i++, p++) count[i] -= rows[p];
    if (j >= 0) for (let i = 0, p = j * w; i < w; i++, p++) out[p] = count[i] > 0 ? 1 : 0;
  }
  return out;
}

/** The relief pixel under world point (x, y), or -1 off it. */
export function pixelAt(t, x, y) {
  const { x: x0, y: y1, res, w, h } = t.data;
  const i = Math.floor((x - x0) / res), j = Math.floor((y1 - y) / res);
  return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
}

/** Whether (x, y) is inside the ring of flat points `p` (even-odd). */
function ringHas(p, x, y) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if ((p[i + 1] > y) !== (p[j + 1] > y) && x < ((p[j] - p[i]) * (y - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) inside = !inside;
  }
  return inside;
}

/** A ring's area (shoelace). */
function ringArea(p) {
  let a = 0;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) a += p[j] * p[i + 1] - p[i] * p[j + 1];
  return Math.abs(a / 2);
}

/** A plan's floors, each with its holes: [{ ring, holes }]. A hole goes
 *  with the smallest floor holding its first point, as films-ui's
 *  floorBands pairs them. */
function floorsOf(rings) {
  const floors = rings.filter(r => !r.hole && r.p.length >= 6).map(ring => ({ ring, holes: [], area: ringArea(ring.p) }));
  for (const hole of rings) {
    if (!hole.hole || hole.p.length < 6) continue;
    let best = null;
    for (const f of floors) if ((!best || f.area < best.area) && ringHas(f.ring.p, hole.p[0], hole.p[1])) best = f;
    best?.holes.push(hole);
  }
  return floors;
}

/** Rings as one path, holes and all (filled even-odd). */
function ringsPath(rings) {
  const path = new Path2D();
  for (const r of rings) {
    path.moveTo(r.p[0], r.p[1]);
    for (let i = 2; i < r.p.length; i += 2) path.lineTo(r.p[i], r.p[i + 1]);
    path.closePath();
  }
  return path;
}

// ── The elevation slice ─────────────────────────────────────────────────

/** A slice shows in full what stands within BAND ft of its height, fading
 *  out over FADE ft past that: a storey, with its steps and ramps. */
const BAND = 5;
const FADE = 1.5;
/** How much shows of the rest of the map: the floors under the slice, seen
 *  from above, and those over it, cut away to a trace. */
const BELOW = 0.28;
const ABOVE = 0.1;
/** A floor in the slice is drawn level, in the colour of its height, where
 *  the heights flag a roof over it (ROOF), so the slice cuts through to it.
 *  Without heights, a floor this flat (its rings' height range, ft) is. */
const FLAT = 2 * BAND;
/** What stands on a floor in the slice, this near it (ft), is in the slice
 *  too: a wall, cover, a pillar, whatever its height. */
const NEAR = 2;

/** The last slices made of each terrain, by height. */
const slices = new WeakMap();
const KEEP_SLICES = 3;

/** Terrain `t` (films-ui terrainOf) sliced at `height` (ft) with its plan's
 *  `rings`, as a terrain films-ui's drawTerrain draws: what stands in the
 *  slice in full, with its contour lines and edges, the floors under it
 *  faint and those over it fainter still. A floor in the slice under a roof
 *  or another floor shows through it, level, in the colour of its height.
 *  Its outline is the terrain's, so the map keeps its white edge. */
export function sliceOf(t, rings, height) {
  let made = slices.get(t);
  if (!made) slices.set(t, made = []);
  const key = `${Math.round(height * 2) / 2}|${rings.length}`;
  const found = made.find(m => m.key === key && m.rings === rings);
  if (found) return found.terrain;

  const r = reliefOf(t);
  const { w, h, grey, alpha } = r;
  const { res, z } = t.data;
  const lo = height - BAND, hi = height + BAND;
  // How fully a height is in the slice, 1 within the band to 0 past its fade.
  const weight = v => Math.max(0, v < lo ? 1 - (lo - v) / FADE : v > hi ? 1 - (v - hi) / FADE : 1);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d', { willReadFrequently: true });
  // Where the slice's lines are kept: 1 in it.
  const keep = new Uint8Array(w * h);
  const layer = layerOf(t);
  if (layer) sliceHeights(c, r, layer, t.data, height, weight, keep);
  else sliceRelief(c, r, t.data, rings, height, weight, keep);

  // The lines in the slice: a contour where its middle is, an edge where
  // either side of it is.
  const inBand = (x, y) => {
    const p = pixelAt(t, x, y);
    return p >= 0 && keep[p] === 1;
  };
  const lines = (list, sides) => {
    const path = new Path2D();
    const step = res * 1.5;
    for (const l of list) {
      if (l.length < 4) continue;
      let px0 = l[0] / 10, py0 = l[1] / 10, open = false;
      for (let i = 2; i < l.length; i += 2) {
        const px1 = px0 + l[i] / 10, py1 = py0 + l[i + 1] / 10;
        const mx = (px0 + px1) / 2, my = (py0 + py1) / 2;
        let kept;
        if (sides) {
          const len = Math.hypot(px1 - px0, py1 - py0) || 1;
          const nx = (-(py1 - py0) / len) * step, ny = ((px1 - px0) / len) * step;
          kept = inBand(mx + nx, my + ny) || inBand(mx - nx, my - ny);
        } else {
          kept = inBand(mx, my);
        }
        if (kept) {
          if (!open) path.moveTo(px0, py0);
          path.lineTo(px1, py1);
        }
        open = kept;
        px0 = px1;
        py0 = py1;
      }
    }
    return path;
  };
  const sliced = {
    data: t.data,
    relief: canvas,
    outline: t.outline,
    edges: lines(t.data.edges, true),
    contours: lines(t.data.contours, false),
    treads: lines(t.data.treads ?? [], false),
    tinted: null,
  };
  made.unshift({ key, rings, terrain: sliced });
  made.length = Math.min(made.length, KEEP_SLICES);
  return sliced;
}

/** Paint the slice at `height` onto `c` (the relief's size) from the map's
 *  heights: a floor by its own height, what stands near a floor in the slice
 *  with it, anything else by its top. A floor in the slice under a roof is
 *  drawn level. Marks `keep` where the slice's lines go. */
function sliceHeights(c, r, layer, data, height, weight, keep) {
  const { w, h, grey, alpha } = r;
  const { height: lh, flags } = layer;
  const floorIn = new Uint8Array(w * h);
  for (let p = 0; p < floorIn.length; p++) floorIn[p] = flags[p] & WALK && weight(lh[p]) > 0.5 ? 1 : 0;
  const near = spread(floorIn, w, h, Math.max(1, Math.round(NEAR / data.res)));
  const img = c.createImageData(w, h);
  const px = img.data;
  for (let p = 0, q = 0; p < flags.length; p++, q += 4) {
    const f = flags[p], v = lh[p];
    const a0 = alpha[p] / 255;
    const walk = (f & WALK) !== 0;
    let inside = 0, g = grey[p];
    if (f & ON) {
      inside = walk || !near[p] || v < height ? weight(v) : 1;
      // A roof over this floor: in the slice, the floor.
      if (walk && inside > 0 && f & ROOF) g += (floorGrey(data.z, v) - g) * inside;
      else if (inside > 0.5) keep[p] = 1;
    }
    const rest = v > height ? ABOVE : BELOW;
    px[q] = px[q + 1] = px[q + 2] = g;
    px[q + 3] = Math.round(255 * a0 * (inside + (1 - inside) * rest));
  }
  c.putImageData(img, 0, 0);
}

/** Paint the slice at `height` onto `c` (the relief's size) from the
 *  relief's grey read back as heights, and the plan's flat floors in the
 *  slice drawn level where the terrain shows something else. Marks `keep`
 *  where the slice's lines go. */
function sliceRelief(c, r, data, rings, height, weight, keep) {
  const { w, h, grey, alpha } = r;
  const heights = r.height();
  const { x: x0, y: y1, res, z } = data;
  const lo = height - BAND, hi = height + BAND;
  // The flat floors in the slice, painted onto the relief's grid in the grey
  // of their height, the nearest to the slice last (on top).
  const flats = floorsOf(rings)
    .filter(f => f.ring.z[1] - f.ring.z[0] <= FLAT && f.ring.z[0] <= hi && f.ring.z[1] >= lo)
    .sort((m, n) => Math.abs((n.ring.z[0] + n.ring.z[1]) / 2 - height) - Math.abs((m.ring.z[0] + m.ring.z[1]) / 2 - height));
  if (flats.length) {
    c.setTransform(1 / res, 0, 0, -1 / res, -x0 / res, y1 / res);
    for (const f of flats) {
      const g = greyAt(z, (f.ring.z[0] + f.ring.z[1]) / 2);
      c.fillStyle = `rgb(${g}, ${g}, ${g})`;
      c.fill(ringsPath([f.ring, ...f.holes]), 'evenodd');
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
  }
  const img = c.getImageData(0, 0, w, h);
  const px = img.data;
  for (let p = 0, q = 0; p < grey.length; p++, q += 4) {
    const cover = px[q + 3] / 255;
    const a0 = alpha[p] / 255;
    const v = heights[p];
    const inside = a0 > 0 ? weight(v) : 0;
    if (inside > 0.5) keep[p] = 1;
    // Out of the slice: faint, and cut away over a flat floor in it.
    const rest = (v > height ? ABOVE : BELOW) * (1 - cover);
    const a = a0 * (inside + (1 - inside) * rest);
    if (cover > 0 && inside < 1) {
      // The flat floor shows where the terrain is out of the slice.
      const g = px[q] + (grey[p] - px[q]) * inside;
      px[q] = px[q + 1] = px[q + 2] = g;
      px[q + 3] = Math.round(255 * Math.min(1, a + cover * (1 - inside)));
    } else {
      px[q] = px[q + 1] = px[q + 2] = grey[p];
      px[q + 3] = Math.round(255 * a);
    }
  }
  c.putImageData(img, 0, 0);
}

// ── The clip ────────────────────────────────────────────────────────────

/** The plan's outside reaches into a gap between its floors no narrower
 *  than twice CLOSE (ft): a narrower one closes. */
const CLOSE = 3;
/** A gap with more than CUT ft2 of walkable floor farther than NARROW ft
 *  from the plan is floor the mode in play cuts away, and stays cut. */
const NARROW = 3;
const CUT = 20;

/** Each terrain's clips, by plan rings. */
const clips = new WeakMap();

/** The area of a plan (`rings`) that terrain `t` is kept to (map.js
 *  floorOf), as one path filled nonzero: the plan's outer rings, and where
 *  the map has heights, the gaps they close round. The navmesh stops short
 *  of what it runs round (a rock, a block, a pillar), and where the floor
 *  round it is several pieces rather than one with a hole, the outer rings
 *  alone cut it out of the map, with a white edge round its foot. A gap the
 *  plan's outside doesn't reach, but through one narrower than twice CLOSE,
 *  is the map's where its terrain is, unless it holds walkable floor away
 *  from the plan's edge. Its pixels on the terrain's grid, a pixel wider
 *  all round so they meet the rings without a crack, join the path as
 *  rectangles, which run the same way as the rings (counterclockwise with
 *  y up), so they fill together. */
export function clipOf(t, rings) {
  let byRings = clips.get(t);
  if (!byRings) clips.set(t, byRings = new WeakMap());
  let path = byRings.get(rings);
  if (path) return path;
  const outer = rings.filter(r => !r.hole && r.p.length >= 6);
  path = ringsPath(outer);
  const fill = gapsOf(t, outer);
  if (fill) {
    const { x: x0, y: y1, res, w, h } = t.data;
    // Runs along each row, a run that repeats in the rows under it one
    // rectangle.
    let open = new Map();
    const close = (run, j) => {
      const [i0, i1, j0] = run;
      path.rect(x0 + i0 * res, y1 - j * res, (i1 - i0) * res, (j - j0) * res);
    };
    for (let j = 0; j <= h; j++) {
      const next = new Map();
      if (j < h) {
        const row = j * w;
        for (let i = 0; i < w; i++) {
          if (!fill[row + i]) continue;
          let k = i;
          while (k < w && fill[row + k]) k++;
          const key = i * (w + 1) + k;
          const run = open.get(key);
          if (run) open.delete(key);
          next.set(key, run ?? [i, k, j]);
          i = k;
        }
      }
      for (const run of open.values()) close(run, j);
      open = next;
    }
  }
  byRings.set(rings, path);
  return path;
}

/** The gaps clipOf fills, on the terrain's grid (1 filled), or null for a
 *  terrain without heights, where nothing tells a rock from a floor the mode
 *  cuts away. */
function gapsOf(t, outer) {
  const layer = layerOf(t);
  if (!layer || !outer.length) return null;
  const { w, h, alpha } = reliefOf(t);
  const { x: x0, y: y1, res } = t.data;
  const n = w * h;
  // The plan's outer rings on the grid.
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.setTransform(1 / res, 0, 0, -1 / res, -x0 / res, y1 / res);
  c.fill(ringsPath(outer), 'nonzero');
  const px = c.getImageData(0, 0, w, h).data;
  const plan = new Uint8Array(n);
  for (let p = 0, q = 3; p < n; p++, q += 4) plan[p] = px[q] >= 128 ? 1 : 0;
  // The plan's outside: what the grid's edge reaches without coming within
  // CLOSE of the plan, and CLOSE round that.
  const r = Math.max(1, Math.round(CLOSE / res));
  const near = spread(plan, w, h, r);
  const queue = new Int32Array(n);
  const outside = new Uint8Array(n);
  let tail = 0;
  const visit = p => {
    if (!near[p] && !outside[p]) {
      outside[p] = 1;
      queue[tail++] = p;
    }
  };
  for (let i = 0; i < w; i++) { visit(i); visit((h - 1) * w + i); }
  for (let j = 0; j < h; j++) { visit(j * w); visit(j * w + w - 1); }
  for (let head = 0; head < tail; head++) {
    const p = queue[head], i = p % w;
    if (i > 0) visit(p - 1);
    if (i < w - 1) visit(p + 1);
    if (p >= w) visit(p - w);
    if (p < n - w) visit(p + w);
  }
  const reach = spread(outside, w, h, r);
  // The gaps: the terrain off the plan that its outside doesn't reach.
  const gap = new Uint8Array(n);
  for (let p = 0; p < n; p++) gap[p] = alpha[p] && !plan[p] && !reach[p] ? 1 : 0;
  // Each gap, kept unless it holds walkable floor away from the plan's edge.
  const away = spread(plan, w, h, Math.max(1, Math.round(NARROW / res)));
  const fill = new Uint8Array(n);
  const seen = new Uint8Array(n);
  for (let p0 = 0; p0 < n; p0++) {
    if (!gap[p0] || seen[p0]) continue;
    seen[p0] = 1;
    queue[0] = p0;
    let size = 1, floor = 0;
    const step = q => {
      if (gap[q] && !seen[q]) {
        seen[q] = 1;
        queue[size++] = q;
      }
    };
    for (let head = 0; head < size; head++) {
      const p = queue[head], i = p % w;
      if (layer.flags[p] & WALK && !away[p]) floor++;
      if (i > 0) step(p - 1);
      if (i < w - 1) step(p + 1);
      if (p >= w) step(p - w);
      if (p < n - w) step(p + w);
    }
    if (floor * res * res > CUT) continue;
    for (let k = 0; k < size; k++) fill[queue[k]] = 1;
  }
  return spread(fill, w, h, 1);
}

// ── Lines of fire ───────────────────────────────────────────────────────

/** Floors up to this far over a shooter's feet (ft) are under their line
 *  of fire: a step, a low ledge. */
const CLIMB = 4;
/** A shot flies this high over the shooter's floor (ft), where the heights'
 *  SOLID flag looks: from the waist to the eyes. A floor rising past EYE
 *  (ft over theirs) is a wall to them. */
const SHOT = [3, 6];
const EYE = 5;
/** A shooter's height within this of the floor under them (ft) is taken as
 *  standing on it. */
const STAND = 4;
/** A shot crosses a gap off the map (a pit, a drop between floors) up to
 *  this wide (ft). Wider, it is the map's edge, and the shot stops there. */
const GAP = 40;
/** A shooter beside a wall stands off the floor (the navmesh keeps clear
 *  of walls): what blocks the first CLEAR ft counts only once the line has
 *  been over open floor. */
const CLEAR = 3;
/** The floors' grid is at most this many cells. */
const CELLS = 1_500_000;

/** A plan's floors on a grid: each cell's lowest floor height (Infinity
 *  under none), from the rings' height ranges. */
function floorGrid(rings) {
  const floors = floorsOf(rings);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { ring } of floors) {
    for (let i = 0; i < ring.p.length; i += 2) {
      minX = Math.min(minX, ring.p[i]); maxX = Math.max(maxX, ring.p[i]);
      minY = Math.min(minY, ring.p[i + 1]); maxY = Math.max(maxY, ring.p[i + 1]);
    }
  }
  if (!floors.length) return null;
  const cell = Math.max(1, Math.sqrt(((maxX - minX) * (maxY - minY)) / CELLS));
  const cols = Math.ceil((maxX - minX) / cell) + 1, rows = Math.ceil((maxY - minY) / cell) + 1;
  const low = new Float32Array(cols * rows).fill(Infinity);
  for (const { ring, holes } of floors) {
    // Each row's crossings through the floor's rings, filled even-odd.
    const all = [ring, ...holes];
    let r0 = Infinity, r1 = -Infinity;
    for (let i = 1; i < ring.p.length; i += 2) {
      r0 = Math.min(r0, ring.p[i]);
      r1 = Math.max(r1, ring.p[i]);
    }
    const j0 = Math.max(0, Math.ceil((r0 - minY) / cell - 0.5)), j1 = Math.min(rows - 1, Math.floor((r1 - minY) / cell - 0.5));
    if (j1 < j0) continue;
    const xs = Array.from({ length: j1 - j0 + 1 }, () => []);
    for (const r of all) {
      const p = r.p;
      for (let i = 0, k = p.length - 2; i < p.length; k = i, i += 2) {
        const ax = p[k], ay = p[k + 1], bx = p[i], by = p[i + 1];
        if (ay === by) continue;
        const ja = Math.max(j0, Math.ceil((Math.min(ay, by) - minY) / cell - 0.5));
        const jb = Math.min(j1, Math.ceil((Math.max(ay, by) - minY) / cell - 0.5) - 1);
        for (let j = ja; j <= jb; j++) {
          const yc = minY + (j + 0.5) * cell;
          xs[j - j0].push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
        }
      }
    }
    const z0 = ring.z[0];
    xs.forEach((row, n) => {
      row.sort((m, o) => m - o);
      const base = (j0 + n) * cols;
      for (let i = 0; i + 1 < row.length; i += 2) {
        const c0 = Math.max(0, Math.ceil((row[i] - minX) / cell - 0.5)), c1 = Math.min(cols - 1, Math.floor((row[i + 1] - minX) / cell - 0.5));
        for (let q = c0; q <= c1; q++) if (z0 < low[base + q]) low[base + q] = z0;
      }
    });
  }
  return { minX, minY, cell, cols, rows, low };
}

/** Each plan's line of fire (lineOfFire), made on first use. */
const fire = new WeakMap();

/** Where a shot meets a wall on a plan, with its terrain (or null): reach(x,
 *  y, z, yaw, max) is how far (ft) a shooter standing at (x, y, z) can see
 *  along `yaw` before a wall, at most `max`.
 *
 *  With the map's heights a shot flies SHOT ft over the shooter's floor. A
 *  point blocks it where something solid stands at that height over a floor
 *  near the shooter's (a wall, a pillar, not low cover), where a solid's top
 *  rises into it, or where a floor rises past the shooter's eyes, unless the
 *  plan has floor under it at the shooter's level too (an overpass). Over a
 *  pit, a drop or the floor below, the line goes on.
 *
 *  Without heights a point blocks the line where no floor lies at or under
 *  the shooter's level and the terrain stands there (a wall, a pillar, a
 *  rock, the side of a floor above them). Without a terrain, any point with
 *  no floor under the shooter's level blocks it. */
export function lineOfFire(plan, t) {
  if (fire.has(plan)) return fire.get(plan);
  const grid = floorGrid(plan.rings);
  const layer = t ? layerOf(t) : null;
  const r = t && !layer ? reliefOf(t) : null;
  const lowAt = (x, y) => {
    const i = Math.floor((x - grid.minX) / grid.cell), j = Math.floor((y - grid.minY) / grid.cell);
    return i < 0 || j < 0 || i >= grid.cols || j >= grid.rows ? Infinity : grid.low[j * grid.cols + i];
  };
  const solid = (x, y) => {
    if (!r) return true;
    const p = pixelAt(t, x, y);
    return p >= 0 && r.alpha[p] > 127;
  };
  // With heights: whether (x, y) is on the map, and whether a shot over
  // floor `zf` stops there (on the map).
  const onMap = (x, y) => {
    const p = pixelAt(t, x, y);
    return p >= 0 && (layer.flags[p] & ON) !== 0;
  };
  const stops = (x, y, zf) => {
    const p = pixelAt(t, x, y);
    const f = layer.flags[p];
    const v = layer.height[p];
    if (f & WALK) {
      if (v > zf + EYE) return !(lowAt(x, y) <= zf + CLIMB);
      return (f & SOLID) !== 0 && Math.abs(v - zf) < SHOT[1] - SHOT[0];
    }
    return (f & SOLID) !== 0 && v > zf + SHOT[0];
  };
  const line = grid && {
    reach(x, y, z, yaw, max) {
      const dx = Math.cos(yaw), dy = Math.sin(yaw);
      let open = false;
      if (layer) {
        // The floor they stand on.
        const p = pixelAt(t, x, y);
        const zf = p >= 0 && layer.flags[p] & WALK && Math.abs(layer.height[p] - z) <= STAND ? layer.height[p] : z;
        const step = t.data.res / 2;
        for (let d = step; d <= max; d += step) {
          if (!onMap(x + dx * d, y + dy * d)) {
            // A gap the shot crosses, to the map on its far side, or the edge.
            let e = d + step;
            while (e <= d + GAP && !onMap(x + dx * e, y + dy * e)) e += step;
            if (e <= d + GAP) { d = e - step; open = true; continue; }
          } else if (!stops(x + dx * d, y + dy * d, zf)) {
            open = true;
            continue;
          }
          if (open || d > CLEAR) return d;
        }
        return max;
      }
      const step = grid.cell / 2;
      for (let d = step; d <= max; d += step) {
        const px = x + dx * d, py = y + dy * d;
        if (lowAt(px, py) <= z + CLIMB) { open = true; continue; }
        if (solid(px, py) && (open || d > CLEAR)) return d;
      }
      return max;
    },
  };
  fire.set(plan, line || null);
  return line || null;
}
