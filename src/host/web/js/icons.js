// Lucide icons as their SVG node arrays, rendered like Films' ui/icons.ts:
// 24px viewBox, no fill, stroke currentColor, stroke-width 2, round caps
// and joins, aria-hidden. One icon per meaning, the same ones Films uses.
// Icon data: Lucide v1.8.0 (https://lucide.dev), ISC licence.

const NS = 'http://www.w3.org/2000/svg';

/** Lucide's own names. */
const NODES = {
  braces: [["path", {d: "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"}], ["path", {d: "M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"}]],
  cast: [["path", {d: "M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"}], ["path", {d: "M2 12a9 9 0 0 1 8 8"}], ["path", {d: "M2 16a5 5 0 0 1 4 4"}], ["line", {"x1": "2", "x2": "2.01", "y1": "20", "y2": "20"}]],
  check: [["path", {d: "M20 6 9 17l-5-5"}]],
  "chevron-down": [["path", {d: "m6 9 6 6 6-6"}]],
  "circle-alert": [["circle", {cx: "12", cy: "12", r: "10"}], ["line", {"x1": "12", "x2": "12", "y1": "8", "y2": "12"}], ["line", {"x1": "12", "x2": "12.01", "y1": "16", "y2": "16"}]],
  clock: [["circle", {cx: "12", cy: "12", r: "10"}], ["path", {d: "M12 6v6l4 2"}]],
  compass: [["circle", {cx: "12", cy: "12", r: "10"}], ["path", {d: "m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"}]],
  copy: [["rect", {width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2"}], ["path", {d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]],
  crosshair: [["circle", {cx: "12", cy: "12", r: "10"}], ["line", {"x1": "22", "x2": "18", "y1": "12", "y2": "12"}], ["line", {"x1": "6", "x2": "2", "y1": "12", "y2": "12"}], ["line", {"x1": "12", "x2": "12", "y1": "6", "y2": "2"}], ["line", {"x1": "12", "x2": "12", "y1": "22", "y2": "18"}]],
  eye: [["path", {d: "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"}], ["circle", {cx: "12", cy: "12", r: "3"}]],
  flag: [["path", {d: "M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"}]],
  focus: [["circle", {cx: "12", cy: "12", r: "3"}], ["path", {d: "M3 7V5a2 2 0 0 1 2-2h2"}], ["path", {d: "M17 3h2a2 2 0 0 1 2 2v2"}], ["path", {d: "M21 17v2a2 2 0 0 1-2 2h-2"}], ["path", {d: "M7 21H5a2 2 0 0 1-2-2v-2"}]],
  funnel: [["path", {d: "M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"}]],
  hand: [["path", {d: "M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"}], ["path", {d: "M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"}], ["path", {d: "M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"}], ["path", {d: "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"}]],
  heart: [["path", {d: "M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"}]],
  "image-down": [["path", {d: "M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21"}], ["path", {d: "m14 19 3 3v-5.5"}], ["path", {d: "m17 22 3-3"}], ["circle", {cx: "9", cy: "9", r: "2"}]],
  info: [["circle", {cx: "12", cy: "12", r: "10"}], ["path", {d: "M12 16v-4"}], ["path", {d: "M12 8h.01"}]],
  "layers-2": [["path", {d: "M13 13.74a2 2 0 0 1-2 0L2.5 8.87a1 1 0 0 1 0-1.74L11 2.26a2 2 0 0 1 2 0l8.5 4.87a1 1 0 0 1 0 1.74z"}], ["path", {d: "m20 14.285 1.5.845a1 1 0 0 1 0 1.74L13 21.74a2 2 0 0 1-2 0l-8.5-4.87a1 1 0 0 1 0-1.74l1.5-.845"}]],
  layers: [["path", {d: "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"}], ["path", {d: "M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"}], ["path", {d: "M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"}]],
  link: [["path", {d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"}], ["path", {d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"}]],
  map: [["path", {d: "M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"}], ["path", {d: "M15 5.764v15"}], ["path", {d: "M9 3.236v15"}]],
  maximize: [["path", {d: "M8 3H5a2 2 0 0 0-2 2v3"}], ["path", {d: "M21 8V5a2 2 0 0 0-2-2h-3"}], ["path", {d: "M3 16v3a2 2 0 0 0 2 2h3"}], ["path", {d: "M16 21h3a2 2 0 0 0 2-2v-3"}]],
  "mouse-pointer-click": [["path", {d: "M14 4.1 12 6"}], ["path", {d: "m5.1 8-2.9-.8"}], ["path", {d: "m6 12-1.9 2"}], ["path", {d: "M7.2 2.2 8 5.1"}], ["path", {d: "M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"}]],
  package: [["path", {d: "M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"}], ["path", {d: "M12 22V12"}], ["polyline", {points: "3.29 7 12 12 20.71 7"}], ["path", {d: "m7.5 4.27 9 5.15"}]],
  "panels-top-left": [["rect", {width: "18", height: "18", x: "3", y: "3", rx: "2"}], ["path", {d: "M3 9h18"}], ["path", {d: "M9 21V9"}]],
  palette: [["path", {d: "M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"}], ["circle", {cx: "13.5", cy: "6.5", r: ".5", fill: "currentColor"}], ["circle", {cx: "17.5", cy: "10.5", r: ".5", fill: "currentColor"}], ["circle", {cx: "6.5", cy: "12.5", r: ".5", fill: "currentColor"}], ["circle", {cx: "8.5", cy: "7.5", r: ".5", fill: "currentColor"}]],
  pause: [["rect", {x: "14", y: "3", width: "5", height: "18", rx: "1"}], ["rect", {x: "5", y: "3", width: "5", height: "18", rx: "1"}]],
  play: [["path", {d: "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"}]],
  "radio-tower": [["path", {d: "M4.9 16.1C1 12.2 1 5.8 4.9 1.9"}], ["path", {d: "M7.8 4.7a6.14 6.14 0 0 0-.8 7.5"}], ["circle", {cx: "12", cy: "9", r: "2"}], ["path", {d: "M16.2 4.8c2 2 2.26 5.11.8 7.47"}], ["path", {d: "M19.1 1.9a9.96 9.96 0 0 1 0 14.1"}], ["path", {d: "M9.5 18h5"}], ["path", {d: "m8 22 4-11 4 11"}]],
  radio: [["path", {d: "M16.247 7.761a6 6 0 0 1 0 8.478"}], ["path", {d: "M19.075 4.933a10 10 0 0 1 0 14.134"}], ["path", {d: "M4.925 19.067a10 10 0 0 1 0-14.134"}], ["path", {d: "M7.753 16.239a6 6 0 0 1 0-8.478"}], ["circle", {cx: "12", cy: "12", r: "2"}]],
  "refresh-cw": [["path", {d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"}], ["path", {d: "M21 3v5h-5"}], ["path", {d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"}], ["path", {d: "M8 16H3v5"}]],
  scan: [["path", {d: "M3 7V5a2 2 0 0 1 2-2h2"}], ["path", {d: "M17 3h2a2 2 0 0 1 2 2v2"}], ["path", {d: "M21 17v2a2 2 0 0 1-2 2h-2"}], ["path", {d: "M7 21H5a2 2 0 0 1-2-2v-2"}]],
  search: [["path", {d: "m21 21-4.34-4.34"}], ["circle", {cx: "11", cy: "11", r: "8"}]],
  shapes: [["path", {d: "M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"}], ["rect", {x: "3", y: "14", width: "7", height: "7", rx: "1"}], ["circle", {cx: "17.5", cy: "17.5", r: "3.5"}]],
  shield: [["path", {d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}]],
  "skip-forward": [["path", {d: "M21 4v16"}], ["path", {d: "M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"}]],
  skull: [["path", {d: "m12.5 17-.5-1-.5 1h1z"}], ["path", {d: "M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z"}], ["circle", {cx: "15", cy: "12", r: "1"}], ["circle", {cx: "9", cy: "12", r: "1"}]],
  timer: [["line", {"x1": "10", "x2": "14", "y1": "2", "y2": "2"}], ["line", {"x1": "12", "x2": "15", "y1": "14", "y2": "11"}], ["circle", {cx: "12", cy: "14", r: "8"}]],
  "triangle-alert": [["path", {d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"}], ["path", {d: "M12 9v4"}], ["path", {d: "M12 17h.01"}]],
  users: [["path", {d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}], ["path", {d: "M16 3.128a4 4 0 0 1 0 7.744"}], ["path", {d: "M22 21v-2a4 4 0 0 0-3-3.87"}], ["circle", {cx: "9", cy: "7", r: "4"}]],
  video: [["path", {d: "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"}], ["rect", {x: "2", y: "6", width: "14", height: "12", rx: "2"}]],
  waypoints: [["path", {d: "m10.586 5.414-5.172 5.172"}], ["path", {d: "m18.586 13.414-5.172 5.172"}], ["path", {d: "M6 12h12"}], ["circle", {cx: "12", cy: "20", r: "2"}], ["circle", {cx: "12", cy: "4", r: "2"}], ["circle", {cx: "20", cy: "12", r: "2"}], ["circle", {cx: "4", cy: "12", r: "2"}]],
  "navigation-2": [["polygon", {points: "12 2 19 21 12 17 5 21 12 2"}]],
  "wifi-off": [["path", {d: "M12 20h.01"}], ["path", {d: "M8.5 16.429a5 5 0 0 1 7 0"}], ["path", {d: "M5 12.859a10 10 0 0 1 5.17-2.69"}], ["path", {d: "M19 12.859a10 10 0 0 0-2.007-1.523"}], ["path", {d: "M2 8.82a15 15 0 0 1 4.177-2.643"}], ["path", {d: "M22 8.82a15 15 0 0 0-11.288-3.764"}], ["path", {d: "m2 2 20 20"}]],
  x: [["path", {d: "M18 6 6 18"}], ["path", {d: "m6 6 12 12"}]],
  "zoom-in": [["circle", {cx: "11", cy: "11", r: "8"}], ["line", {"x1": "21", "x2": "16.65", "y1": "21", "y2": "16.65"}], ["line", {"x1": "11", "x2": "11", "y1": "8", "y2": "14"}], ["line", {"x1": "8", "x2": "14", "y1": "11", "y2": "11"}]],
  "zoom-out": [["circle", {cx: "11", cy: "11", r: "8"}], ["line", {"x1": "21", "x2": "16.65", "y1": "21", "y2": "16.65"}], ["line", {"x1": "8", "x2": "14", "y1": "11", "y2": "11"}]],
};

/** Films' names for the same meanings (ui/icons.ts), so a view can say
 *  icon('players') or icon('caret') and match the Films client. */
const ALIASES = {
  players: 'users',
  geometry: 'layers',
  paths: 'waypoints',
  objectives: 'flag',
  vitals: 'heart',
  caret: 'chevron-down',
  alert: 'triangle-alert',
  error: 'circle-alert',
  filter: 'funnel',
  zoomIn: 'zoom-in',
  zoomOut: 'zoom-out',
  sync: 'refresh-cw',
  fit: 'maximize',
  zoom: 'crosshair',
  follow: 'eye',
  live: 'radio',
  brand: 'radio-tower',
  broadcast: 'cast',
  operator: 'panels-top-left',
  elevation: 'layers-2',
  timers: 'timer',
  selection: 'mouse-pointer-click',
  raw: 'braces',
  devices: 'shapes',
  carried: 'hand',
  image: 'image-down',
  next: 'skip-forward',
  orientation: 'compass',
  offline: 'wifi-off',
  colors: 'palette',
  markers: 'navigation-2',
  observe: 'video',
  data: 'scan',
};

/** A Lucide icon as an SVG element, `size` px square (Films ICON sizes: xs 11,
 *  sm 12, md 14, lg 16, xl 24). Unknown names throw, so a typo shows at once. */
export function icon(name, size = 14) {
  const node = NODES[name] ?? NODES[ALIASES[name]];
  if (!node) throw new Error(`Unknown icon: ${name}`);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  svg.dataset.icon = name;
  for (const [tag, attrs] of node) {
    const child = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
    svg.appendChild(child);
  }
  return svg;
}
