// The item icon atlas: weapon and equipment icons packed in
// one PNG (/api/icons/atlas.png) with an index (/api/icons). Pads look
// their item up by display name, then item name. Icons are drawn as a mask
// (DOM) or tinted sprites (canvas), so they take any token colour.
//
// Item classes select fixed HUD icon sizes. Power items render larger.

import { el } from './dom.js';

/** The loaded atlas: the index plus `image`, or null. */
let atlas = null;

/** Load and check the atlas. Resolves to it, or null when anything about
 *  it is off (wrong source or URL, too many icons, the image's size not
 *  the index's, a cell outside the image). The views then fall back to
 *  plain marks. */
export async function loadAtlas() {
  try {
    const response = await fetch('/api/icons');
    const index = await response.json();
    if (!response.ok || index.source !== 'game_hud_atlas' || index.atlas !== '/api/icons/atlas.png'
      || !Array.isArray(index.icons) || index.icons.length > 512 || !index.items) return null;
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = index.atlas;
    });
    if (image.naturalWidth !== index.width || image.naturalHeight !== index.height) return null;
    const bad = cell => ![cell.x, cell.y, cell.w, cell.h].every(Number.isInteger)
      || cell.x < 0 || cell.y < 0 || cell.w < 1 || cell.h < 1
      || cell.x + cell.w > index.width || cell.y + cell.h > index.height;
    if (index.icons.some(bad)) return null;
    atlas = { ...index, image };
    images.clear();
    return atlas;
  } catch {
    atlas = null;
    return null;
  }
}

/** The atlas cell of a pad's item: { index, cell: { x, y, w, h } }, or null. */
function itemCell(pad) {
  if (!atlas || !pad?.stock_spawner) return null;
  for (const name of [pad.stock_spawner.display_name, pad.stock_spawner.item_name]) {
    const index = name ? atlas.items[name] : undefined;
    if (Number.isInteger(index) && atlas.icons[index]) return { index, cell: atlas.icons[index] };
  }
  return null;
}

/** A pad's item icon as a <span> masked from the atlas, fitted inside
 *  w by h px and coloured by `currentColor`, or null without one. */
export function itemIcon(pad, w = 36, h = 22) {
  const match = itemCell(pad);
  if (!match) return null;
  const { cell } = match;
  const scale = Math.min(w / cell.w, h / cell.h);
  const image = `url("${atlas.atlas}")`;
  const size = `${atlas.width * scale}px ${atlas.height * scale}px`;
  const position = `${-cell.x * scale}px ${-cell.y * scale}px`;
  return el('span', {
    class: 'item-icon',
    'aria-hidden': 'true',
    style: {
      display: 'block',
      flex: 'none',
      width: `${cell.w * scale}px`,
      height: `${cell.h * scale}px`,
      background: 'currentColor',
      maskImage: image, webkitMaskImage: image,
      maskSize: size, webkitMaskSize: size,
      maskPosition: position, webkitMaskPosition: position,
      maskRepeat: 'no-repeat', webkitMaskRepeat: 'no-repeat',
    },
  });
}

/** Tinted icons `h` CSS px tall, as Films weaponIconImage: by cell, height,
 *  width cap, colour and pixel ratio. */
const images = new Map();

/** A pad's item icon `h` CSS px tall (narrower than `maxW` px: then
 *  shorter) in `color`, for drawImage: { canvas, w, h } in CSS px, or null
 *  without one. Cached, so a redraw at 4 Hz costs a lookup. */
export function itemImage(pad, h, color, maxW = Infinity, pixelRatio = window.devicePixelRatio || 1) {
  const match = itemCell(pad);
  if (!match) return null;
  const { cell, index } = match;
  const ratio = Math.max(1, Math.min(4, Math.round(pixelRatio * 1000) / 1000));
  const key = `${index}|${h}|${maxW}|${color}|${ratio}`;
  let v = images.get(key);
  if (!v) {
    const scale = Math.min(h / cell.h, maxW / cell.w);
    const w = cell.w * scale, hh = cell.h * scale;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * ratio));
    canvas.height = Math.max(1, Math.round(hh * ratio));
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(atlas.image, cell.x, cell.y, cell.w, cell.h, 0, 0, canvas.width, canvas.height);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, canvas.width, canvas.height);
    v = { canvas, w: canvas.width / ratio, h: canvas.height / ratio };
    if (images.size > 256) images.clear();
    images.set(key, v);
  }
  return v;
}

// ── Item classes (Films weaponIcons.ts) ─────────────────────────────────

/** Power weapons and power-ups by display name (Films POWER): drawn larger,
 *  ringed brighter. */
const POWER = new Set([
  'M41 Rocket Launcher', 'Fuel Rod SPNKr', 'S7 Sniper Rifle', 'Skewer', 'Energy Sword', 'Gravity Hammer',
  'Cindershot', 'Mutilator', 'Overshield', 'Active Camo',
]);
/** Power-ups: equipment that acts on pickup (Films POWER_UPS), by display
 *  name or the game's item name. */
const POWER_UPS = new Set(['Overshield', 'Active Camo', 'OverShield', 'ActiveCamo']);

const names = pad => [pad?.stock_spawner?.display_name, pad?.stock_spawner?.item_name].filter(Boolean);

/** The item's category for sizing its HUD icon. */
export function itemClass(pad) {
  const spawn = pad?.stock_spawner;
  if (!spawn || spawn.category === 'weapon') return 'weapon';
  const n = names(pad);
  if (n.some(s => POWER_UPS.has(s))) return 'powerUp';
  if (n.some(s => /grenade/i.test(s))) return 'grenade';
  return 'equipment';
}

/** Whether the pad holds a power weapon or a power-up. */
export const isPowerItem = pad => names(pad).some(s => POWER.has(s) || POWER_UPS.has(s));
