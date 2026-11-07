// Music and sound effects. Files live in sound-effects/ at the repo root and are
// served by the backend at /sound-effects/.

const BASE = '/sound-effects/';
const EFFECTS = ['button', 'first_down', 'failed_play', 'game_over', 'win'];
const MUSIC_VOLUME = 0.45;
const SFX_VOLUME = 0.8;

const music = new Audio(`${BASE}main_menu.mp3`);
music.loop = true;
music.volume = MUSIC_VOLUME;
music.preload = 'auto';

const effects = Object.fromEntries(EFFECTS.map(name => {
  const a = new Audio(`${BASE}${name}.mp3`);
  a.preload = 'auto';
  return [name, a];
}));

let wantMusic = false;

// Audio failures (missing file, autoplay blocked) must never break the game, so they're ignored.
const tryPlay = audio => audio.play().catch(() => {});

/** Play a one-shot effect. Overlapping plays are fine: each one uses its own copy. */
export function playSfx(name) {
  const base = effects[name];
  if (!base) return;
  const shot = base.cloneNode();
  shot.volume = SFX_VOLUME;
  tryPlay(shot);
}

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

// Browsers block audio until the first interaction; start the menu music then if it should be on.
const unlock = () => { if (wantMusic && music.paused) tryPlay(music); };
for (const type of ['pointerdown', 'keydown', 'touchstart']) {
  document.addEventListener(type, unlock, { passive: true });
}
