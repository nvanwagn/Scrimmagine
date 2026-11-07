// Music and sound effects. Files live in sound-effects/ at the repo root and are
// served by the backend at /sound-effects/.
//
// Effects go through the Web Audio API so a quiet file can be boosted past 100%
// (HTMLAudio volume caps at 1). The looping menu music stays a plain <audio> element.

const BASE = '/sound-effects/';
// Per-effect gain on top of the SFX slider. button.mp3 is mastered ~2.3x quieter (RMS)
// than the others (peak 0.15), so 3x brings it level and still peaks at only ~0.45.
const EFFECT_GAIN = { button: 3.0, successful_play: 1, failed_play: 1, game_over: 1, win: 1 };
const SETTINGS_KEY = 'scrimmagine.audio';
const DEFAULTS = { sfx: 0.8, music: 0.45 };

// ---------- settings (per-browser convenience, so storage failures are fine) ----------

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const clamp = v => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
    return { sfx: clamp(saved.sfx) ?? DEFAULTS.sfx, music: clamp(saved.music) ?? DEFAULTS.music };
  } catch {
    return { ...DEFAULTS };
  }
}

const settings = loadSettings();

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

/** Current volumes, 0..1. */
export const getVolumes = () => ({ ...settings });

/** Set the sound-effects master volume (0..1). */
export function setSfxVolume(v) {
  settings.sfx = v;
  if (master) master.gain.value = v;
  saveSettings();
}

/** Set the menu music volume (0..1). */
export function setMusicVolume(v) {
  settings.music = v;
  music.volume = v;
  saveSettings();
}

// ---------- effects ----------

const AudioCtx = window.AudioContext || window.webkitAudioContext;
const ctx = AudioCtx ? new AudioCtx() : null;
const master = ctx ? ctx.createGain() : null;
if (master) {
  master.gain.value = settings.sfx;
  master.connect(ctx.destination);
}

// Decoded buffers, loaded once in the background; a failed load just means silence.
const buffers = {};
if (ctx) {
  for (const name of Object.keys(EFFECT_GAIN)) {
    fetch(`${BASE}${name}.mp3`)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
      .then(data => ctx.decodeAudioData(data))
      .then(buf => { buffers[name] = buf; })
      .catch(() => {});
  }
}

/** Play a one-shot effect. Overlapping plays are fine: each gets its own source node. */
export function playSfx(name) {
  if (!(name in EFFECT_GAIN)) return;
  // Lets tests (and anything else) observe which effect fired.
  document.dispatchEvent(new CustomEvent('scrimmagine:sfx', { detail: name }));
  if (!ctx || !buffers[name] || settings.sfx === 0) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  src.buffer = buffers[name];
  gain.gain.value = EFFECT_GAIN[name];
  src.connect(gain).connect(master);
  src.start();
}

// ---------- menu music ----------

const music = new Audio(`${BASE}main_menu.mp3`);
music.loop = true;
music.volume = settings.music;
music.preload = 'auto';

let wantMusic = false;
const tryPlay = audio => audio.play().catch(() => {});

/** Start (or resume) the looping menu music. */
export function startMusic() {
  wantMusic = true;
  if (music.paused) tryPlay(music);
}

/** Pause the menu music (it resumes where it left off). */
export function stopMusic() {
  wantMusic = false;
  music.pause();
}

// Browsers block audio until the first interaction: then start the music if it should be
// on, and wake the effects context.
const unlock = () => {
  if (wantMusic && music.paused) tryPlay(music);
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
};
for (const type of ['pointerdown', 'keydown', 'touchstart']) {
  document.addEventListener(type, unlock, { passive: true });
}
