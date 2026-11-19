// The map's look: Halo Infinite's tactical map and HUD, sampled from the
// game (the TACMAP's navy, its dot grid and corner brackets, terrain lit
// teal with cyan contour edges, the HUD's light blue highlight, tracked
// capitals). The operator's chrome around the map keeps films-ui's look,
// but everything drawn on the map, and the map's own frame, use this. The
// colours are tokens.css's --hud-* (the canvas reads them once).

import { token } from './dom.js';

let palette = null;
/** The HUD's colours, from tokens.css. */
export const hud = () => palette ??= {
  bg: token('--hud-bg'),
  edge: token('--hud-edge'),
  floorLow: token('--hud-floor-low'),
  floorHigh: token('--hud-floor-high'),
  floorAway: token('--hud-floor-away'),
  floorPeak: token('--hud-floor-peak'),
  floorContour: token('--hud-floor-contour'),
  floorRim: token('--hud-floor-rim'),
  accent: token('--hud-accent'),
  plate: token('--hud-plate'),
  text: token('--hud-text'),
  muted: token('--hud-muted'),
  ink: token('--hud-ink'),
  shadow: token('--hud-shadow'),
};

/** The HUD's typeface (film-assets fonts/): squared, tracked capitals close
 *  to the game's, falling back to the system's while it loads. */
export const HUD_FAMILY = '"Saira Semi Condensed", system-ui, sans-serif';
export const hudFont = (weight, px) => `${weight} ${px}px ${HUD_FAMILY}`;

/** Resolves once the canvas can draw with the HUD's typeface, or it failed. */
export const hudFontReady = () =>
  Promise.all([500, 600, 700].map(w => document.fonts?.load(hudFont(w, 12)))).catch(() => null);

/** Corner brackets round a box, the TACMAP's frame and selection: four L
 *  shaped corners `len` long. */
export function brackets(ctx, x, y, w, h, len, color, width) {
  const l = Math.min(len, w / 2, h / 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'square';
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x + w, y + h, -1, -1], [x, y + h, 1, -1]]) {
    ctx.moveTo(cx, cy + dy * l);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * l, cy);
  }
  ctx.stroke();
  ctx.lineCap = 'butt';
}
