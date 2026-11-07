// Scrimmagine front end: one page, three screens, shared game state.

import * as api from './api.js';
import { Field, buildPlan } from './field.js';
import { kitsFor, loadSprites, spritesNow, mix, textOn } from './sprites.js';

// ---------- constants ----------

const CALLS = ['run', 'short_pass', 'deep_pass', 'punt', 'field_goal'];
// kneel / spike only appear in the real coach's drive.
const CALL_LABEL = { run: 'RUN', short_pass: 'SHORT PASS', deep_pass: 'DEEP PASS', punt: 'PUNT', field_goal: 'FIELD GOAL', kneel: 'KNEEL', spike: 'SPIKE' };
const FG_MAX_DISTANCE = 70; // mirrors backend simulator.FG_MAX_DISTANCE: from here on, always a miss
const GOOD_OUTCOMES = new Set(['first_down', 'touchdown', 'fg_made']);
const FAIL_OUTCOMES = new Set(['turnover', 'turnover_on_downs', 'fg_missed']);
const GOOD = '#7dffa0', BAD = '#ff8f84';

// ---------- state ----------

const app = {
  scenarios: [],
  played: loadPlayed(),       // scenario id -> grade (this browser only)
  game: null,                 // the scenario being played
  busy: false,
};

const $ = id => document.getElementById(id);
const screens = { home: $('screen-home'), game: $('screen-game'), summary: $('screen-summary') };
const field = new Field($('field'));

// ---------- formatting ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = wp => `${Math.round(wp * 100)}%`;
// ASCII minus: Press Start 2P has no U+2212 glyph.
const pts = wpa => `${wpa >= 0 ? '+' : '-'}${Math.abs(wpa * 100).toFixed(1)}`;
const ordinal = n => ['', '1ST', '2ND', '3RD', '4TH'][n] || `${n}TH`;
const ordinalLower = n => ['', '1st', '2nd', '3rd', '4th'][n] || `${n}th`;

function quarterSeconds(s) {
  return s.quarter <= 4 ? Math.max(0, s.seconds_left_in_game - (4 - s.quarter) * 900) : s.seconds_left_in_game;
}
function clock(s) {
  const q = quarterSeconds(s);
  return `${Math.floor(q / 60)}:${String(q % 60).padStart(2, '0')}`;
}
const quarterLong = s => (s.quarter >= 5 ? 'OT' : `${ordinal(s.quarter)} QTR`);
const quarterShort = s => (s.quarter >= 5 ? 'OT' : `Q${s.quarter}`);
const isGoalToGo = s => s.yardline_100 <= s.distance;
const downText = s => `${ordinal(s.down)} & ${isGoalToGo(s) ? 'GOAL' : s.distance}`;
const downTextLower = s => `${ordinalLower(s.down)} & ${isGoalToGo(s) ? 'goal' : s.distance}`;

/** "NVY 38", "THE 50" from the offense's point of view. */
function spot(s) {
  if (s.yardline_100 === 50) return 'THE 50';
  return s.yardline_100 > 50 ? `${s.offense} ${100 - s.yardline_100}` : `${s.defense} ${s.yardline_100}`;
}

/** Legal calls: punt and field goal only on 4th down, or under 2:00 in the 2nd or 4th quarter. */
function legalCalls(s) {
  const late = (s.quarter === 2 || s.quarter === 4) && quarterSeconds(s) < 120;
  const kicks = s.down === 4 || late;
  return { run: true, short_pass: true, deep_pass: true, punt: kicks, field_goal: kicks };
}

/** "2025_12_PHI_DAL" is away_home in nflverse ids. */
function matchup(sc) {
  const parts = sc.game_id.split('_');
  const home = parts[3];
  const s = sc.start_state;
  return s.offense === home ? `${s.offense} v ${s.defense}` : `${s.offense} @ ${s.defense}`;
}

// ---------- persistence (per-viewer convenience only) ----------

function loadPlayed() {
  try { return JSON.parse(localStorage.getItem('scrimmagine.played') || '{}'); } catch { return {}; }
}
function savePlayed() {
  try { localStorage.setItem('scrimmagine.played', JSON.stringify(app.played)); } catch { /* storage unavailable */ }
}

// ---------- screens ----------

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  window.scrollTo(0, 0);
}

// ---------- home ----------

async function loadHome() {
  const list = $('scenario-list');
  list.innerHTML = '<p class="muted loading">Loading today\'s moments…</p>';
  try {
    app.scenarios = await api.getScenarios();
  } catch (err) {
    console.warn(err);
    list.innerHTML = `<div class="error-box error"><span>Couldn't load today's scenarios. Is the server running?</span>
      <button type="button" class="btn" id="btn-retry">RETRY</button></div>`;
    $('btn-retry').addEventListener('click', loadHome);
    return;
  }
  // Recolor every team's sprites up front so cards and the field render in team colors.
  await Promise.all(app.scenarios.flatMap(sc => {
    const k = kitsFor(sc.start_state.offense, sc.start_state.defense);
    return [loadSprites(k.off), loadSprites(k.def)];
  }));
  renderHome();
}

function renderHome() {
  const list = $('scenario-list');
  if (!app.scenarios.length) {
    list.innerHTML = '<p class="muted loading">No scenarios today. Run scripts.build_scenarios on the server.</p>';
    return;
  }
  const maxLev = Math.max(...app.scenarios.map(s => s.leverage_score), 1e-9);
  list.innerHTML = app.scenarios.map((sc, i) => {
    const s = sc.start_state;
    const k = kitsFor(s.offense, s.defense);
    const pips = Math.max(1, Math.ceil((sc.leverage_score / maxLev) * 5));
    const grade = app.played[sc.id];
    const badge = grade ? `<span class="badge played">PLAYED ${esc(grade)}</span>` : '<span class="badge new">NEW</span>';
    return `<button type="button" class="scenario-card" data-index="${i}" aria-label="Scenario ${i + 1}: ${esc(matchup(sc))}, ${esc(sc.title)}, ${quarterShort(s)} ${clock(s)}">
      <div class="card-top">
        <div class="matchup">
          <img src="${spritesNow(k.off).ready}" alt="">
          <span>${esc(matchup(sc))}</span>
          <img src="${spritesNow(k.def).ready}" alt="" style="transform:scaleX(-1)">
        </div>
        ${badge}
      </div>
      <div class="card-title">${esc(sc.title)}</div>
      <div class="card-sub">${quarterShort(s)} · ${clock(s)} · ball on ${esc(spot(s).replace('THE ', 'the '))}</div>
      <div class="leverage"><span class="lbl">LEVERAGE</span>${[1, 2, 3, 4, 5].map(n => `<span class="pip${n <= pips ? ' on' : ''}"></span>`).join('')}</div>
    </button>`;
  }).join('');
}

// ---------- gameplay ----------

async function startScenario(index) {
  const sc = app.scenarios[index];
  if (!sc) return;
  const s = sc.start_state;
  const kits = kitsFor(s.offense, s.defense);
  await Promise.all([loadSprites(kits.off), loadSprites(kits.def)]);
  app.game = {
    token: Symbol('game'),
    index, scenario: sc, kits,
    team: s.offense, opp: s.defense,
    state: s, wpNow: null, plays: [], phase: 'presnap', shown: -1,
  };
  app.busy = false;
  show('game');
  $('banner').hidden = true;
  $('call-error').hidden = true;
  setOnAir('ON AIR · SETTING THE SCENE', `<p class="intro">${esc(sc.intro)}</p>`);
  $('vs-coach').textContent = '±0.0';
  $('wp-delta').hidden = true;
  field.setup(s, kits, endZones());
  renderScorebug(s);
  renderCalls(s);
  renderWpBar($('wpbar'), null);

  // Pre-snap WP comes from a throwaway simulation (see api.winProbability).
  const token = app.game.token;
  api.winProbability(s).then(wp => {
    if (app.game?.token !== token || app.game.wpNow != null) return;
    app.game.wpNow = wp;
    if (app.game.phase === 'presnap' && !app.game.plays.length) renderWpBar($('wpbar'), wp);
  }).catch(err => console.warn('WP probe failed', err));
}

function endZones() {
  const g = app.game;
  return [
    { abbr: g.team, color: g.kits.off.ui },
    { abbr: g.opp, color: g.kits.def.ui },
  ];
}

function uiColor(abbr) {
  const g = app.game;
  return abbr === g.team ? g.kits.off.ui : g.kits.def.ui;
}

function renderScorebug(s, opts = {}) {
  const g = app.game;
  const scoreOf = abbr => (s.offense === abbr ? s.offense_score : s.defense_score);
  const tosOf = abbr => (s.offense === abbr ? s.offense_timeouts : s.defense_timeouts);
  const team = abbr => {
    const bg = uiColor(abbr);
    const used = mix(bg, '#000000', 0.45);
    const tos = [0, 1, 2].map(i => `<span style="background:${i < tosOf(abbr) ? '#fff' : used}"></span>`).join('');
    const poss = opts.showPossession && s.offense === abbr && abbr !== g.team ? `<span class="poss" title="${abbr} ball"></span>` : '';
    return `<div class="sb-team" style="background:${bg};color:${textOn(bg)}"><span>${esc(abbr)}</span><span class="pts">${scoreOf(abbr)}</span><span class="timeouts" aria-label="${tosOf(abbr)} timeouts">${tos}</span>${poss}</div>`;
  };
  const downCls = opts.downBad ? ' bad' : '';
  const downLabel = opts.downLabel || downText(s);
  const spotLabel = (s.offense !== g.team ? `${s.offense} BALL ON ` : 'BALL ON ') + spot(s);
  $('scorebug').innerHTML = `
    <button type="button" class="sb-menu" id="btn-menu" aria-label="Back to menu">
      <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true" style="shape-rendering:crispEdges"><path d="M0 1h16M0 7h16M0 13h16" stroke="#f3ead3" stroke-width="2"></path></svg><span class="txt">MENU</span>
    </button>
    ${team(g.team)}${team(g.opp)}
    <div class="sb-clock"><span class="q"><span class="long">${quarterLong(s)}</span><span class="short">${quarterShort(s)}</span></span><span class="t">${clock(s)}</span></div>
    <div class="sb-down${downCls}">${esc(downLabel)}</div>
    <div class="sb-spot">${esc(spotLabel)}</div>
    <div class="sb-right">${esc(opts.right || `SCENARIO ${g.index + 1} / ${app.scenarios.length}`)}</div>`;
  const db = $('downbar');
  db.className = `downbar${downCls}`;
  db.innerHTML = `<span>${esc(downLabel)}</span><span>${esc(spotLabel)}</span>`;
  $('btn-menu').addEventListener('click', goHome);
}

/** WP bar. With `after`, draws before → after like the result mockups. */
function renderWpBar(bar, before, after = null, withLabels = true) {
  const g = app.game;
  const off = g.kits.off.ui, def = g.kits.def.ui;
  if (before == null) {
    bar.innerHTML = `<div class="seg" style="width:50%;background:${off};opacity:.35"></div><div class="seg" style="flex:1;background:${def};opacity:.35"></div>
      <span class="lbl l">${esc(g.team)} …</span>`;
    return;
  }
  let segs;
  if (after == null) {
    segs = `<div class="seg" style="width:${before * 100}%;background:${off}"></div><div class="seg" style="flex:1;background:${def}"></div>`;
  } else if (after >= before) {
    segs = `<div class="seg" style="width:${before * 100}%;background:${off}"></div>
      <div class="seg" style="width:${(after - before) * 100}%;background:${mix(off, '#ffffff', 0.45)}"></div>
      <div class="seg" style="flex:1;background:${def}"></div>`;
  } else {
    segs = `<div class="seg" style="width:${after * 100}%;background:${off}"></div>
      <div class="seg" style="width:${(before - after) * 100}%;background:repeating-linear-gradient(45deg, ${def} 0 4px, ${off} 4px 8px)"></div>
      <div class="seg" style="flex:1;background:${def}"></div>`;
  }
  const now = after ?? before;
  const labels = withLabels ? `<span class="lbl l">${esc(g.team)} ${pct(now)}</span><span class="lbl r">${pct(1 - now)}</span>` : '';
  bar.innerHTML = segs + labels;
}

function callHint(call, s) {
  const legal = legalCalls(s)[call];
  if (!legal) return '4th down only';
  const need = isGoalToGo(s) ? 'Goal to go.' : `Need ${s.distance}.`;
  switch (call) {
    case 'run': return s.distance <= 3 ? `${need} Pound it.` : `${need} Hand it off.`;
    case 'short_pass': return 'Quick game to the sticks';
    case 'deep_pass': return 'Shot play downfield';
    case 'punt': return 'Flip the field, trust the D';
    case 'field_goal': {
      const diff = s.offense_score - s.defense_score;
      const yds = s.yardline_100 + 17;
      if (yds >= FG_MAX_DISTANCE) return `${yds} yds · out of range`;
      const effect = diff + 3 === 0 ? ' · ties it' : diff < 0 && diff + 3 > 0 ? ' · takes the lead' : '';
      return `${yds} yds${effect}`;
    }
    default: return '';
  }
}

/** The left box: kicker line plus the intro or the booth lines. */
function setOnAir(kicker, bodyHtml) {
  $('onair-kicker').innerHTML = `<span class="dot"></span>${esc(kicker)}`;
  $('onair-body').innerHTML = bodyHtml;
}

/** The call grid stays in place for the whole drive: 5 calls plus the real-coach tile. */
function renderCalls(s) {
  const legal = legalCalls(s);
  const all = CALLS.every(c => legal[c]);
  const why = s.down === 4 ? '4TH DOWN' : all ? 'UNDER 2:00' : `${ordinal(s.down)} DOWN`;
  const rest = all ? ' · EVERY CALL IS LIVE' : ' · KICKS ON 4TH';
  const chip = $('down-chip');
  chip.className = all ? 'chip' : 'chip quiet';
  chip.innerHTML = `${why}<span class="long">${rest}</span>`;
  $('calls-title').textContent = 'MAKE THE CALL';
  const grid = $('calls');
  grid.className = 'calls';
  grid.innerHTML = CALLS.map((c, i) => `
    <button type="button" class="call" data-call="${c}" ${legal[c] ? '' : 'disabled'}>
      <span class="name"><span class="key">${i + 1}</span><span>${CALL_LABEL[c]}</span></span>
      <span class="hint">${esc(callHint(c, s))}</span>
    </button>`).join('') + coachTile();
}

/** The real coach's drive, scored by the same WP model as the player. */
const coachPlays = () => app.game.scenario.real_drive_plays || [];

/** Coach's WPA after their first n plays (their whole drive once n reaches its length). */
function coachWpaThrough(n) {
  const real = coachPlays();
  if (!real.length || n >= real.length) return app.game.scenario.real_drive_wpa;
  return real.slice(0, n).reduce((sum, p) => sum + p.wpa, 0);
}

/** nflverse text without the leading clock and formation tags: "(1:35) (Shotgun) ..." */
const cleanDesc = d => String(d || '').replace(/^(\s*\([^)]*\)\s*)+/, '');

const callLabel = c => CALL_LABEL[c] || String(c).toUpperCase();

/** Teaser before the first snap; after your play n, what the coach called on their play n. */
function coachTile() {
  const g = app.game;
  const n = g.plays.length;
  if (!n) return '<div class="coach-tease"><b>REAL COACH?</b>Revealed after you snap it.</div>';
  const real = coachPlays();
  const cp = real[n - 1];
  if (!real.length) {
    // scenarios.json built before real_drive_plays existed: only the first call is known.
    return `<div class="coach-tile" title="${esc(g.scenario.real_play_desc)}"><b>REAL COACH'S FIRST CALL</b>
      <span class="cc-call">${callLabel(g.scenario.real_call)}</span></div>`;
  }
  if (!cp) {
    return `<div class="coach-tile"><b>REAL COACH · PLAY ${n}</b><span class="cc-call">DRIVE OVER</span>
      <span class="cc-desc">Their drive ended after ${real.length} play${real.length === 1 ? '' : 's'}.</span></div>`;
  }
  return `<div class="coach-tile" title="${esc(cp.description)}">
    <b>COACH PLAY ${n} · ${esc(downText(cp.state))}</b>
    <span class="cc-call">${callLabel(cp.call)} <span style="color:${cp.wpa >= 0 ? GOOD : BAD}">${pts(cp.wpa)}</span></span>
    <span class="cc-desc">${esc(cleanDesc(cp.description))}</span>
  </div>`;
}

/** Same grid slots once the drive ends: summary, try again, the verdict and the coach tile. */
function renderOverGrid(sim) {
  const chip = $('down-chip');
  chip.className = FAIL_OUTCOMES.has(sim.result.outcome) ? 'chip bad' : 'chip';
  chip.textContent = driveEndLabel(sim);
  $('calls-title').textContent = 'DRIVE OVER';
  const grid = $('calls');
  grid.className = 'calls over';
  grid.innerHTML = `
    <button type="button" class="call primary span2" id="btn-see-summary">
      <span class="name"><span>SEE SUMMARY ▶</span></span><span class="hint">Your grade vs the real coach</span>
    </button>
    <button type="button" class="call" id="btn-try-again">
      <span class="name"><span>TRY AGAIN</span></span><span class="hint">Replay this moment</span>
    </button>
    <div class="over-msg span2">${esc(overMessage(sim))}</div>
    ${coachTile()}`;
  $('btn-see-summary').addEventListener('click', showSummary);
  $('btn-try-again').addEventListener('click', () => startScenario(app.game.index));
  $('btn-see-summary').focus({ preventScroll: true });
}

function setCallsBusy(busy) {
  document.querySelectorAll('#calls button[data-call]').forEach(b => {
    if (busy) { b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true; b.classList.add('busy'); }
    else { b.disabled = b.dataset.wasDisabled === '1'; b.classList.remove('busy'); }
  });
}

async function makeCall(call) {
  const g = app.game;
  if (!g || app.busy || g.phase === 'over' || !legalCalls(g.state)[call]) return;
  app.busy = true;
  setCallsBusy(true);
  $('call-error').hidden = true;
  const before = g.state;
  const token = g.token;

  let sim;
  try {
    sim = await api.simulate(before, call);
  } catch (err) {
    console.warn(err);
    if (app.game?.token !== token) return;
    $('call-error').textContent = "Couldn't reach the field. Check the server and try that call again.";
    $('call-error').hidden = false;
    app.busy = false;
    setCallsBusy(false);
    return;
  }
  if (app.game?.token !== token) return;

  const i = g.plays.length;
  g.plays.push({ before, call, sim, booth: null });
  requestBooth(i);

  if (i > 0) field.setup(before, g.kits, endZones());
  $('banner').hidden = true;
  // Hold the booth lines until the animation lands so they can't spoil the result.
  setOnAir('THE BOOTH', '<p class="pending">Booth is on the mic</p>');
  g.phase = 'animating';
  const plan = buildPlan(field, before, sim);
  await field.play(plan);
  if (app.game?.token !== token) return;

  field.setMarks(aftermathMarks(before, sim, plan));
  g.state = sim.new_state;
  g.wpNow = sim.wp_after;
  g.phase = sim.drive_over ? 'over' : 'presnap';
  if (sim.drive_over) recordGrade();
  showResult(i);
  app.busy = false;
}

/** Field marks left behind after the whistle (lines, trail, yardage chip). */
function aftermathMarks(before, sim, plan) {
  const r = sim.result;
  const los = 100 - before.yardline_100;
  const marks = { trail: field.trailFor(plan) };
  const ns = sim.new_state;
  if (!sim.drive_over) {
    const newLos = 100 - ns.yardline_100;
    Object.assign(marks, { oldLos: los, los: newLos, ltg: newLos + ns.distance });
  } else {
    Object.assign(marks, { los, ltg: los + before.distance });
  }
  const scrimmage = ['run', 'short_pass', 'deep_pass'].includes(r.call);
  const incomplete = /incomplete/i.test(r.description);
  const takeaway = /Intercepted|Fumble/i.test(r.description);
  if (r.outcome === 'turnover_on_downs') {
    const end = los + r.yards;
    marks.shortfall = [end, los + before.distance];
    const short = before.distance - r.yards;
    marks.gain = { x: end, y: plan.end?.y ?? 0.5, color: BAD, text: `${yardsText(r.yards)} · ${short} SHORT` };
  } else if (scrimmage && !incomplete && !takeaway) {
    marks.gain = { x: Math.min(los + r.yards, 100), y: plan.end?.y ?? 0.5, color: r.yards > 0 ? GOOD : BAD, text: yardsText(r.yards) };
  } else if (r.call === 'punt') {
    marks.gain = { x: los + r.yards, y: 0.5, color: '#f3ead3', text: `NET ${r.yards}` };
  }
  return marks;
}

function yardsText(y) {
  if (y === 0) return 'NO GAIN';
  const n = Math.abs(y);
  return `${y > 0 ? '+' : '-'}${n} YD${n === 1 ? '' : 'S'}`;
}

function bannerFor(sim) {
  const r = sim.result, d = r.description;
  switch (r.outcome) {
    case 'first_down': return ['FIRST DOWN!', 'good'];
    case 'touchdown': return ['TOUCHDOWN!', 'good'];
    case 'fg_made': return ["IT'S GOOD!", 'good'];
    case 'fg_missed': return ['NO GOOD!', 'fail'];
    case 'punt': return ['PUNT AWAY', 'good'];
    case 'turnover_on_downs': return ['TURNOVER ON DOWNS', 'fail'];
    case 'turnover':
      if (/SAFETY/.test(d)) return ['SAFETY!', 'fail'];
      if (/Returned for a touchdown/i.test(d)) return [/Intercepted/i.test(d) ? 'PICK SIX!' : 'SCOOP AND SCORE!', 'fail'];
      if (/Intercepted/i.test(d)) return ['INTERCEPTED!', 'fail'];
      if (/Fumble/i.test(d)) return ['FUMBLE!', 'fail'];
      return ['TURNOVER!', 'fail'];
    default:
      if (/^Sacked/i.test(d)) return ['SACKED!', 'fail'];
      if (/incomplete/i.test(d)) return ['INCOMPLETE', 'fail'];
      if (r.yards > 0) return [`GAIN OF ${r.yards}`, 'good'];
      if (r.yards === 0) return ['NO GAIN', 'fail'];
      return [`LOSS OF ${-r.yards}`, 'fail'];
  }
}

function showResult(i) {
  const g = app.game;
  const { sim } = g.plays[i];
  const r = sim.result;
  g.shown = i;

  // Banner over the field.
  const [title, kind] = bannerFor(sim);
  const banner = $('banner');
  banner.className = `banner${kind === 'fail' ? ' fail' : ''}`;
  banner.innerHTML = `<div class="title">${esc(title)}</div><div class="desc">${esc(r.description)}</div>`;
  banner.hidden = false;
  $('announce').textContent = `${title} ${r.description} Win probability ${pct(sim.wp_before)} to ${pct(sim.wp_after)}.`;

  // Score bug shows the new state.
  const over = sim.drive_over;
  renderScorebug(sim.new_state, {
    showPossession: true,
    downLabel: over ? driveEndLabel(sim) : undefined,
    downBad: over && FAIL_OUTCOMES.has(r.outcome),
    right: `PLAY ${i + 1} OF DRIVE`,
  });

  // Win probability lives in the same box as the booth.
  const delta = $('wp-delta');
  delta.hidden = false;
  delta.innerHTML = `<span class="from">${pct(sim.wp_before)}</span><span class="arrow">▶</span><span class="to">${pct(sim.wp_after)}</span>` +
    `<span class="wpa-chip" style="background:${sim.wpa >= 0 ? GOOD : BAD}">WPA ${pts(sim.wpa)}</span>`;
  renderWpBar($('wpbar'), sim.wp_before, sim.wp_after);
  // Same number of plays on both sides; once your drive is over, their whole drive.
  const coachSoFar = over ? g.scenario.real_drive_wpa : coachWpaThrough(i + 1);
  $('vs-coach').textContent = pts(yourWpa() - coachSoFar);

  renderBooth(i);
  if (over) renderOverGrid(sim);
  else renderCalls(sim.new_state);
}

function driveEndLabel(sim) {
  const r = sim.result;
  if (r.outcome === 'gain' || r.outcome === 'first_down') return 'END OF HALF';
  return bannerFor(sim)[0].replace(/!$/, '');
}

function renderBooth(i) {
  const g = app.game;
  if (!g || g.shown !== i) return;
  const b = g.plays[i].booth;
  let body;
  if (!b) body = '<p class="pending">Booth is on the mic</p>';
  else if (b.error) body = '<p class="pending done">Booth feed dropped. Play on.</p>';
  else {
    body = `<div class="booth-line"><span class="who">PBP</span><p>"${esc(b.line_1)}"</p></div>
      <div class="booth-line color"><span class="who">COLOR</span><p>"${esc(b.line_2)}"</p></div>`;
  }
  setOnAir('THE BOOTH', body);
}

/** Commentary runs alongside the animation and never blocks the next call. */
function requestBooth(i) {
  const g = app.game;
  const token = g.token;
  const p = g.plays[i];
  api.commentary(p.before, p.sim)
    .then(c => { p.booth = c; })
    .catch(err => { console.warn('Commentary failed', err); p.booth = { error: true }; })
    .finally(() => { if (app.game?.token === token) renderBooth(i); });
}

function yourWpa() {
  return app.game.plays.reduce((sum, p) => sum + p.sim.wpa, 0);
}

function overMessage(sim) {
  const r = sim.result;
  if (r.outcome === 'touchdown') return 'Six on the board, and the extra point is assumed good.';
  if (r.outcome === 'fg_made') return 'Three points banked.';
  if (r.outcome === 'punt') return 'The defense takes it from here.';
  if (FAIL_OUTCOMES.has(r.outcome)) return "It didn't pay off, but the grade rewards the decision, not just the result.";
  return 'The clock ran out on the half.';
}

// ---------- summary ----------

function gradeFor(diffPoints) {
  if (diffPoints >= 10) return 'A';
  if (diffPoints >= 3) return 'B';
  if (diffPoints >= -3) return 'C';
  if (diffPoints >= -10) return 'D';
  return 'F';
}

function recordGrade() {
  const g = app.game;
  const diff = (yourWpa() - g.scenario.real_drive_wpa) * 100;
  app.played[g.scenario.id] = gradeFor(diff);
  savePlayed();
}

function resultShort(p) {
  const r = p.sim.result, d = r.description;
  switch (r.outcome) {
    case 'first_down': return `${yardsText(r.yards).toLowerCase()}, first down`;
    case 'touchdown': return 'Touchdown';
    case 'fg_made': return 'Field goal good';
    case 'fg_missed': return 'Field goal missed';
    case 'punt': return `Punt, net ${r.yards}`;
    case 'turnover_on_downs': return `${yardsText(r.yards).toLowerCase()}, turnover on downs`;
    case 'turnover': return bannerFor(p.sim)[0].replace(/!$/, '').toLowerCase().replace(/^./, c => c.toUpperCase());
    default:
      if (/^Sacked/i.test(d)) return `Sacked, ${yardsText(r.yards).toLowerCase()}`;
      if (/incomplete/i.test(d)) return 'Incomplete';
      return yardsText(r.yards).toLowerCase();
  }
}

function showSummary() {
  const g = app.game;
  const sc = g.scenario;
  const plays = g.plays;
  const last = plays[plays.length - 1].sim;
  const fin = last.new_state;
  const you = yourWpa(), coach = sc.real_drive_wpa;
  const diff = (you - coach) * 100;
  const grade = gradeFor(diff);
  const scoreOf = abbr => (fin.offense === abbr ? fin.offense_score : fin.defense_score);
  const teamBg = g.kits.off.ui, oppBg = g.kits.def.ui;

  const gradeLine = Math.abs(diff) < 0.05
    ? 'Dead even with the real coach.'
    : diff > 0
      ? `You beat the real coach by ${diff.toFixed(1)} points of win probability.`
      : `The real coach beat you by ${(-diff).toFixed(1)} points of win probability.`;

  const good = grade === 'A' || grade === 'B';
  const turfKit = grade === 'C' ? g.kits.off : good ? g.kits.off : g.kits.def;
  const turfPose = grade === 'C' ? 'ready' : 'celebrate';
  const turfImg = spritesNow(turfKit)[turfPose];
  const turfAlt = good ? `${g.team} players celebrating` : grade === 'C' ? `${g.team} players` : `${g.opp} players celebrating`;
  const mirror = !good && grade !== 'C' ? ' style="transform:scaleX(-1)"' : '';

  // Best / worst calls.
  let best = -1, worst = -1;
  if (plays.length > 1) {
    plays.forEach((p, i) => {
      if (best < 0 || p.sim.wpa > plays[best].sim.wpa) best = i;
      if (worst < 0 || p.sim.wpa < plays[worst].sim.wpa) worst = i;
    });
    if (plays[best].sim.wpa === plays[worst].sim.wpa) best = worst = -1;
  } else if (plays.length === 1) {
    if (plays[0].sim.wpa >= 0) best = 0; else worst = 0;
  }

  const meter = v => Math.min(100, Math.abs(v * 100) * 2);
  const youText = `${plays.length} call${plays.length === 1 ? '' : 's'}, ended in ${resultShort(plays[plays.length - 1]).toLowerCase()}. WP ${pct(plays[0].sim.wp_before)} → ${pct(last.wp_after)}.`;

  const real = coachPlays();
  const sitText = s => `${downTextLower(s)} · ${spot(s).replace('THE ', 'the ')}`;
  const coachCell = cp => (cp
    ? `${callLabel(cp.call)} <span style="color:${cp.wpa >= 0 ? GOOD : BAD}">${pts(cp.wpa)}</span>`
    : '<span class="muted">—</span>');

  // Your drive, with what the coach called on the same play number.
  const rows = plays.map((p, i) => {
    const sit = sitText(p.before);
    const tag = i === best ? `<span class="tagchip" style="background:${GOOD}">BEST CALL</span>`
      : i === worst ? `<span class="tagchip" style="background:${BAD}">WORST CALL</span>` : '';
    return `<tr>
      <td class="n">${i + 1}</td>
      <td class="sit">${esc(sit)}</td>
      <td class="callc">${CALL_LABEL[p.call]}<span class="sit-phone">${esc(sit)}</span><span class="sit-phone">Coach: ${coachCell(real[i])}</span></td>
      <td class="res">${esc(resultShort(p))}</td>
      <td class="wpa" style="color:${p.sim.wpa >= 0 ? GOOD : BAD}">${pts(p.sim.wpa)}</td>
      <td class="coachc">${coachCell(real[i])}</td>
      <td class="tag">${tag}</td>
    </tr>`;
  }).join('');

  // The real drive, every snap, scored by the same model.
  const realRows = real.map((cp, i) => `<tr>
      <td class="n">${i + 1}</td>
      <td class="sit">${esc(sitText(cp.state))}</td>
      <td class="callc">${callLabel(cp.call)}<span class="sit-phone">${esc(sitText(cp.state))}</span></td>
      <td class="res">${esc(cleanDesc(cp.description))}</td>
      <td class="wpa" style="color:${cp.wpa >= 0 ? GOOD : BAD}">${pts(cp.wpa)}</td>
    </tr>`).join('');
  const coachText = real.length
    ? `${real.length} call${real.length === 1 ? '' : 's'}, ended: ${cleanDesc(real[real.length - 1].description)} WP ${pct(real[0].wp_before)} → ${pct(real[real.length - 1].wp_after)}.`
    : sc.real_play_desc;

  $('summary-body').innerHTML = `
    <div class="sum-head">
      <div class="sum-title">
        <span class="crumbs">SCENARIO ${g.index + 1} / ${app.scenarios.length} · ${esc(matchup(sc))} · ${esc(sc.title)}</span>
        <h1 id="summary-title" style="text-shadow:4px 4px 0 ${teamBg}">DRIVE OVER: ${esc(driveEndLabel(last))}${/!$/.test(driveEndLabel(last)) ? '' : '!'}</h1>
      </div>
      <div class="sum-score">
        <span style="background:${teamBg};color:${textOn(teamBg)}">${esc(g.team)} ${scoreOf(g.team)}</span>
        <span style="background:${oppBg};color:${textOn(oppBg)}">${esc(g.opp)} ${scoreOf(g.opp)}</span>
        <span style="background:#1a2035;color:#ffcf3a">${quarterShort(fin)} ${clock(fin)}</span>
      </div>
    </div>
    <div class="sum-body">
      <div class="sum-left">
        <div class="panel grade-card">
          <span class="lbl">YOUR GRADE</span>
          <span class="grade">${grade}</span>
          <span class="grade-line">${gradeLine}</span>
          <div class="grade-turf">
            <img src="${turfImg}" alt=""${mirror}>
            <img class="big" src="${turfImg}" alt="${esc(turfAlt)}"${mirror}>
            <img src="${turfImg}" alt=""${mirror}>
          </div>
        </div>
        <div class="sum-actions">
          <button type="button" class="btn btn-primary btn-big" id="btn-next"><span>NEXT SCENARIO</span><span aria-hidden="true">▶</span></button>
          <div class="two-col">
            <button type="button" class="btn" id="btn-replay">REPLAY</button>
            <button type="button" class="btn" id="btn-sum-menu">MENU</button>
          </div>
        </div>
      </div>
      <div class="sum-right">
        <div class="vs">
          <div class="panel vs-card">
            <div class="vs-top"><span class="who">YOU · ${plays.length} CALL${plays.length === 1 ? '' : 'S'}</span><span class="num" style="color:${you >= 0 ? GOOD : BAD}">${pts(you)}</span></div>
            <div class="meter"><div style="width:${meter(you)}%;background:${you >= 0 ? GOOD : BAD}"></div></div>
            <span class="txt">${esc(youText)}</span>
          </div>
          <div class="panel vs-card coach">
            <div class="vs-top"><span class="who">REAL COACH · ${real.length ? `${real.length} CALL${real.length === 1 ? '' : 'S'}` : callLabel(sc.real_call)}</span><span class="num" style="color:${coach >= 0 ? GOOD : BAD}">${pts(coach)}</span></div>
            <div class="meter"><div style="width:${meter(coach)}%;background:${coach >= 0 ? GOOD : BAD}"></div></div>
            <span class="txt">${esc(coachText)}</span>
          </div>
        </div>
        <div class="panel log">
          <h2>PLAY BY PLAY</h2>
          <table>
            <thead><tr><th class="n">#</th><th class="sit">SITUATION</th><th>YOUR CALL</th><th>RESULT</th><th style="text-align:right">WPA</th><th>COACH ON PLAY #</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${real.length ? `<div class="panel log coach-log">
          <h2>THE REAL DRIVE</h2>
          <table>
            <thead><tr><th class="n">#</th><th class="sit">SITUATION</th><th>COACH CALL</th><th>WHAT HAPPENED</th><th style="text-align:right">WPA</th></tr></thead>
            <tbody>${realRows}</tbody>
          </table>
        </div>` : ''}
      </div>
    </div>`;
  $('btn-next').addEventListener('click', () => startScenario((g.index + 1) % app.scenarios.length));
  $('btn-replay').addEventListener('click', () => startScenario(g.index));
  $('btn-sum-menu').addEventListener('click', goHome);
  show('summary');
  $('btn-next').focus({ preventScroll: true });
}

function goHome() {
  if (app.game) app.game.token = Symbol('abandoned');
  app.game = null;
  app.busy = false;
  renderHome();
  show('home');
}

// ---------- events ----------

$('scenario-list').addEventListener('click', e => {
  const card = e.target.closest('.scenario-card');
  if (card) startScenario(Number(card.dataset.index));
});
$('btn-play-all').addEventListener('click', () => app.scenarios.length && startScenario(0));
$('btn-random').addEventListener('click', () => app.scenarios.length && startScenario(Math.floor(Math.random() * app.scenarios.length)));
$('calls').addEventListener('click', e => {
  const b = e.target.closest('button[data-call]');
  if (b && !b.disabled) makeCall(b.dataset.call);
});
document.addEventListener('keydown', e => {
  if (screens.game.hidden || e.altKey || e.ctrlKey || e.metaKey) return;
  const n = Number(e.key);
  if (n >= 1 && n <= 5) makeCall(CALLS[n - 1]);
});

loadHome();
