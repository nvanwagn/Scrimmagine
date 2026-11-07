// Team-colored sprites.
//
// The navy sprite set is a clean two-tone template: jersey (#243c96 + shade #162464)
// and trim = helmet, pants, number (#f0be28 + shade #b48214). We swap those four palette
// entries on a canvas to dress every player in real team colors. If the canvas path
// fails for any reason, we fall back to the stock colorway from teamColors.js.

import { teamColors } from './teamColors.js';

export const POSES = ['ready', 'stance', 'run', 'throw', 'celebrate'];
const TEMPLATE = 'navy';
const SLOTS = {
  '36,60,150': 'jersey', '22,36,100': 'jerseyShade',
  '240,190,40': 'trim', '180,130,20': 'trimShade',
};
const AWAY_WHITE = '#f0f0e8';
const AWAY_WHITE_SHADE = '#bebeb6';
const SAME_COLOR_DISTANCE = 140; // below this, the defense switches to away whites

// ---------- color helpers ----------

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

export function rgbToHex(rgb) {
  return '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/** Linear mix of two hex colors, t = 0 gives a, t = 1 gives b. */
export function mix(a, b, t) {
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex(x.map((v, i) => v + (y[i] - v) * t));
}

/** Relative luminance (0 = black, 1 = white). */
export function luminance(hex) {
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = hexToRgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Perceptual-ish RGB distance ("redmean"). */
export function colorDistance(a, b) {
  const x = hexToRgb(a), y = hexToRgb(b);
  const rm = (x[0] + y[0]) / 2;
  const [dr, dg, db] = [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/** Dark text on light backgrounds, cream text on dark ones. */
export function textOn(bg) {
  return luminance(bg) > 0.4 ? '#0e1220' : '#f3ead3';
}

/** Near-black kit colors vanish into the sprite outline, so lift them a little. */
function readable(hex) {
  return luminance(hex) < 0.02 ? mix(hex, '#8a8a99', 0.3) : hex;
}

function shade(hex) {
  return mix(hex, '#000000', 0.32);
}

// ---------- kits ----------

function homeKit(abbr, c) {
  const jersey = readable(c.primary), trim = readable(c.secondary);
  return { abbr, ui: c.primary, jersey, jerseyShade: shade(jersey), trim, trimShade: shade(trim), colorway: c.colorway };
}

function awayKit(abbr, c, uiClashWith) {
  const trim = readable(c.primary);
  // The score bug can't show two identical blocks either: use the secondary if it reads.
  const ui = colorDistance(c.secondary, uiClashWith) > SAME_COLOR_DISTANCE && luminance(c.secondary) > 0.02
    ? c.secondary : '#5d6582';
  return { abbr, ui, jersey: AWAY_WHITE, jerseyShade: AWAY_WHITE_SHADE, trim, trimShade: shade(trim), colorway: c.colorway };
}

/** Kits for both sides. If the jerseys would look alike, the defense wears away whites. */
export function kitsFor(offense, defense) {
  const o = teamColors(offense), d = teamColors(defense);
  const off = homeKit(offense, o);
  const clash = colorDistance(o.primary, d.primary) < SAME_COLOR_DISTANCE;
  const def = clash ? awayKit(defense, d, o.primary) : homeKit(defense, d);
  return { off, def };
}

// ---------- sprite sets ----------

const cache = new Map();      // kit key -> Promise<{pose: url}>
const resolved = new Map();   // kit key -> {pose: url}
let templatePromise = null;

const kitKey = kit => [kit.jersey, kit.jerseyShade, kit.trim, kit.trimShade].join('|');

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

function loadTemplate() {
  if (!templatePromise) {
    templatePromise = Promise.all(POSES.map(p => loadImage(`/sprites/${TEMPLATE}_${p}.png`)))
      .then(imgs => Object.fromEntries(POSES.map((p, i) => [p, imgs[i]])));
  }
  return templatePromise;
}

function recolor(img, kit) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  const swap = Object.fromEntries(Object.entries(SLOTS).map(([k, slot]) => [k, hexToRgb(kit[slot])]));
  for (let i = 0; i < px.length; i += 4) {
    if (!px[i + 3]) continue;
    const to = swap[`${px[i]},${px[i + 1]},${px[i + 2]}`];
    if (to) { px[i] = to[0]; px[i + 1] = to[1]; px[i + 2] = to[2]; }
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL('image/png');
}

function stockSet(kit) {
  return Object.fromEntries(POSES.map(p => [p, `/sprites/${kit.colorway}_${p}.png`]));
}

/** Resolve a {pose: url} map for a kit (recolored, or stock colorway on failure). */
export function loadSprites(kit) {
  const key = kitKey(kit);
  if (!cache.has(key)) {
    const p = loadTemplate()
      .then(tpl => Object.fromEntries(POSES.map(pose => [pose, recolor(tpl[pose], kit)])))
      .catch(() => stockSet(kit))
      .then(set => { resolved.set(key, set); return set; });
    cache.set(key, p);
  }
  return cache.get(key);
}

/** Synchronous lookup: the recolored set if ready, else the stock colorway. */
export function spritesNow(kit) {
  return resolved.get(kitKey(kit)) || stockSet(kit);
}
