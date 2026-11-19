// The map floor's colour: the HUD's deep blue by default, or a base colour
// the operator picks (a preset or any colour), from which the floor's dark
// to light ramp is built. The pick lives in the page address
// (?floorcolor=blue, or ?floorcolor=2f7fc1 for any other colour), so a
// browser source given the same address shows the same floor.
//
// A pick sets state.floorColor ('#rrggbb', or null for the default) so the
// views repaint.

import { state, set } from './state.js';

/** The default first (no colour of its own: the HUD tokens), then the
 *  presets, mid-tone base colours a ramp reads well from. */
export const FLOOR_COLORS = [
  { key: 'default', name: 'Default', hex: null },
  { key: 'blue', name: 'Blue', hex: '#2f7fc1' },
  { key: 'slate', name: 'Slate', hex: '#5a6f8c' },
  { key: 'teal', name: 'Teal', hex: '#1f8a8c' },
  { key: 'green', name: 'Green', hex: '#3f8c4f' },
  { key: 'sand', name: 'Sand', hex: '#a58a5c' },
  { key: 'violet', name: 'Violet', hex: '#7559b5' },
  { key: 'graphite', name: 'Graphite', hex: '#6b7078' },
];

const keyOf = name => String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');

/** A preset by key, or null. */
export const floorPreset = key => FLOOR_COLORS.find(c => c.key === keyOf(key)) ?? null;

/** '#rrggbb' from 'rrggbb' or '#rrggbb' (six hex digits, any case), or null. */
const hexOf = value => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  return m ? `#${m[1].toLowerCase()}` : null;
};

/** A preset key, a custom colour or nothing, as '#rrggbb' or null (the
 *  default). Undefined when it is none of those. */
function parse(value) {
  if (value === null || value === undefined || value === '') return null;
  const preset = floorPreset(value);
  if (preset) return preset.hex;
  return hexOf(value) ?? undefined;
}

/** The floor's base colour, '#rrggbb', or null for the default look. */
export const floorColorHex = () => state.floorColor;

/** The preset with this colour, or null for a custom one. */
export const floorPresetOf = hex => FLOOR_COLORS.find(c => c.hex === (hex ?? null)) ?? null;

/** Apply the address's pick, before the views mount. */
export function initFloorColor() {
  const hex = parse(new URLSearchParams(location.search).get('floorcolor'));
  set({ floorColor: hex ?? null });
}

let urlTimer = 0;
/** Keep the pick in the address. A colour dragged in the picker changes
 *  many times a second, so the address is written once it settles. */
function writeUrl(hex) {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const url = new URL(location.href);
    const preset = floorPresetOf(hex);
    if (hex === null) url.searchParams.delete('floorcolor');
    else url.searchParams.set('floorcolor', preset ? preset.key : hex.slice(1));
    history.replaceState(null, '', url);
  }, 200);
}

/** Give the floor a colour: a preset key, '#rrggbb' or 'rrggbb', or null
 *  for the default. Anything else is ignored. */
export function setFloorColor(value) {
  const hex = parse(value);
  if (hex === undefined) return;
  writeUrl(hex);
  set({ floorColor: hex });
}
