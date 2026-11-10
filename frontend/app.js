// Scrimmagine front end: one page, three screens, shared game state.

import * as api from './api.js';
import { Field, buildPlan } from './field.js';
import { kitsFor, loadSprites, spritesNow, mix, textOn } from './sprites.js';
import { getVolumes, playSfx, setMusicVolume, setSfxVolume, startMusic, stopMusic } from './sound.js';

// ---------- constants ----------

const CALLS = ['run', 'short_pass', 'deep_pass', 'punt', 'field_goal'];
// kneel / spike only appear in the real coach's drive.
const CALL_LABEL = { run: 'RUN', short_pass: 'SHORT PASS', deep_pass: 'DEEP PASS', punt: 'PUNT', field_goal: 'FIELD GOAL', kneel: 'KNEEL', spike: 'SPIKE' };
const FG_MAX_DISTANCE = 70; // mirrors backend simulator.FG_MAX_DISTANCE: from here on, always a miss
const GOOD_OUTCOMES = new Set(['first_down', 'touchdown', 'fg_made']);
const FAIL_OUTCOMES = new Set(['turnover', 'turnover_on_downs', 'fg_missed']);
const SUCCESS_SOUND_OUTCOMES = new Set(['first_down', 'touchdown', 'fg_made']);
const GOOD = '#7dffa0', BAD = '#ff8f84', MEH = '#ffcf3a';
const DAILY_KEY = 'scrimmagine.daily';   // today's attempts at the daily 6 (localStorage)

// Grade = 60% decisions + 40% result. A decision is judged before the snap, on the odds: how
// close the call's expected win probability was to the best legal call's. The result is your
// actual WPA on the drive. Comparing with the real coach is shown, but doesn't set the grade.
const DECISION_WEIGHT = 0.6;
const REGRET_SCALE = 0.05;     // a call 5+ WP points (expected) below the best one earns no decision credit
const RESULT_SCALE = 0.20;     // drive WPA of +20 points = full result credit, -20 = none
const BEST_CALL_SLACK = 0.002; // within 0.2 points of the best call counts as the best call

// ---------- state ----------

const app = {
  scenarios: [],
  daily: loadDaily(),         // today's progress: {day, runs: {scenario id: {calls, done, scores}}}
  game: null,                 // the scenario being played
  busy: false,
  endless: { streak: 0, rounds: [], best: 0, newBest: false, next: null },
};

const $ = id => document.getElementById(id);
const screens = { home: $('screen-home'), game: $('screen-game'), summary: $('screen-summary'), final: $('screen-final'), endless: $('screen-endless') };
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

// The daily game: one attempt per scenario. Every call is saved the moment it's made, so leaving
// mid-drive resumes where you were and a finished drive can't be replayed. Outcomes are
// predetermined on the server, so the same calls always give the same plays, for everyone.

/** Today's date in US Eastern time (YYYY-MM-DD): the daily 6 change at midnight ET, like the server. */
function easternDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Today's saved progress, or a fresh start if the saved progress is from an earlier day. */
function loadDaily() {
  try {
    const saved = JSON.parse(localStorage.getItem(DAILY_KEY) || 'null');
    if (saved && saved.day === easternDay() && saved.runs) return saved;
  } catch { /* unreadable: start fresh */ }
  return { day: easternDay(), runs: {} };
}
function saveDaily() {
  try { localStorage.setItem(DAILY_KEY, JSON.stringify(app.daily)); } catch { /* storage unavailable */ }
}

/** The saved attempt at one of today's scenarios (created empty on first use). */
function runFor(id) {
  if (!app.daily.runs[id]) app.daily.runs[id] = { calls: [], done: false };
  return app.daily.runs[id];
}

/** The next of today's 6 you haven't finished, after index `from` (wrapping); null when all are done. */
function nextUnplayed(from = -1) {
  const n = app.scenarios.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (!app.daily.runs[app.scenarios[i].id]?.done) return i;
  }
  return null;
}

// ---------- screens ----------

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  window.scrollTo(0, 0);
  // The menu music plays only on the menu.
  if (name === 'home') startMusic(); else stopMusic();
}

// ---------- home ----------

async function loadHome() {
  const list = $('scenario-list');
  list.innerHTML = '<p class="muted loading">Loading today\'s moments…</p>';
  try {
    app.scenarios = await api.getScenarios();
    app.day = easternDay();
    if (app.daily.day !== app.day) {   // a new day: yesterday's attempts don't carry over
      app.daily = { day: app.day, runs: {} };
      saveDaily();
    }
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

/** Menu button to today's results: how many of the 6 are done; usable once one is. */
function renderResultsButton() {
  const done = app.scenarios.filter(sc => app.daily.runs[sc.id]?.done).length;
  $('btn-results').disabled = done === 0;
  $('results-progress').textContent = app.scenarios.length ? `${done}/${app.scenarios.length} PLAYED` : '';
}

function renderHome() {
  renderEndlessButton();
  renderResultsButton();
  const list = $('scenario-list');
  if (!app.scenarios.length) {
    list.innerHTML = '<p class="muted loading">No scenarios today. Check that the server has its data.</p>';
    return;
  }
  const maxLev = Math.max(...app.scenarios.map(s => s.leverage_score), 1e-9);
  list.innerHTML = app.scenarios.map((sc, i) => {
    const s = sc.start_state;
    const k = kitsFor(s.offense, s.defense);
    const pips = Math.max(1, Math.ceil((sc.leverage_score / maxLev) * 5));
    const run = app.daily.runs[sc.id];
    const badge = run?.done
      ? `<span class="badge played">${esc(run.grade)} · ${Math.round(run.total)}</span>`
      : run?.calls.length ? '<span class="badge new">RESUME</span>' : '<span class="badge new">NEW</span>';
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

/** Score bug corner text: which set this drive belongs to. */
function modeLabel(g) {
  if (g.mode === 'endless') return `ENDLESS · STREAK ${app.endless.streak}`;
  return `SCENARIO ${g.index + 1} / ${app.scenarios.length}`;
}

/**
 * Open one of today's 6 by its position in the list: a fresh start, a resume where you left
 * off, or (once finished) your locked-in result. There are no retries.
 */
async function startScenario(index) {
  const sc = app.scenarios[index];
  if (!sc) return;
  const run = runFor(sc.id);
  if (!run.calls.length) return startGame(sc, { mode: 'daily', index });
  try {
    await restoreGame(sc, index, run);
  } catch (err) {
    console.warn('Restore failed', err);
    goHome();
    $('home-error').textContent = "Couldn't load your drive. Is the server running?";
    $('home-error').hidden = false;
  }
}

/** Set up a game for a scenario without showing it yet. mode is 'daily' or 'endless'. */
async function newGame(sc, mode, index) {
  const s = sc.start_state;
  const kits = kitsFor(s.offense, s.defense);
  await Promise.all([loadSprites(kits.off), loadSprites(kits.def)]);
  app.game = {
    token: Symbol('game'),
    mode, index, scenario: sc, kits,
    team: s.offense, opp: s.defense,
    state: s, wpNow: null, plays: [], phase: 'presnap', shown: -1,
  };
  app.busy = false;
  return app.game;
}

/** Show the field at the game's current state, ready for the next call. */
function enterField(g, kicker, bodyHtml) {
  show('game');
  $('banner').hidden = true;
  $('call-error').hidden = true;
  setOnAir(kicker, bodyHtml);
  $('vs-coach').textContent = g.plays.length ? pts(yourWpa() - coachWpaThrough(g.plays.length)) : '±0.0';
  $('wp-delta').hidden = true;
  field.setup(g.state, g.kits, endZones(), nameTags());
  renderScorebug(g.state);
  renderCalls(g.state);
  renderWpBar($('wpbar'), g.wpNow);
  loadOdds(g.state);   // also brings the pre-snap win probability on the first snap
}

/** Start a drive from the top. */
async function startGame(sc, { mode, index = null }) {
  const g = await newGame(sc, mode, index);
  enterField(g, 'ON AIR · SETTING THE SCENE', `<p class="intro">${esc(sc.intro)}</p>`);
}

/**
 * Rebuild a daily drive from its saved calls. Outcomes are predetermined, so replaying the same
 * calls gives the same plays. Then pick up at the next snap, or show the summary if it's over.
 */
async function restoreGame(sc, index, run) {
  const g = await newGame(sc, 'daily', index);
  const token = g.token;
  for (const saved of run.calls) {
    const sim = await api.simulate(g.state, saved.call, sc.id);
    if (app.game?.token !== token) return;
    g.plays.push({ before: g.state, call: saved.call, sim, booth: null, decision: saved.decision });
    g.state = sim.new_state;
    g.wpNow = sim.wp_after;
    if (sim.drive_over) break;
  }
  if (g.plays[g.plays.length - 1].sim.drive_over) {
    g.phase = 'over';
    if (!run.done) recordGrade();
    showSummary({ review: run.done });
    return;
  }
  const n = g.plays.length;
  enterField(g, `RESUMING · PLAY ${n + 1}`,
    `<p class="intro">Picking up where you left off. Your first ${n === 1 ? 'call is' : `${n} calls are`} locked in.</p>`);
}

/**
 * Fetch every call's odds for the state about to be snapped. The promise never rejects (null on
 * failure: the calls still work, that play just isn't scored as a decision). When the odds land,
 * the call buttons are redrawn with them.
 */
function loadOdds(s) {
  const g = app.game, token = g.token;
  const entry = { state: s, data: null };
  entry.promise = api.callOdds(s)
    .catch(err => { console.warn('Odds failed', err); return null; })
    .then(data => {
      entry.data = data;
      if (app.game?.token !== token || g.odds !== entry || g.phase !== 'presnap' || app.busy) return data;
      if (data && !g.plays.length) {
        g.wpNow = data.wp_before;
        renderWpBar($('wpbar'), data.wp_before);
      }
      renderCalls(s);
      return data;
    });
  g.odds = entry;
}

/** The odds for this state, if they have arrived. */
function oddsFor(s) {
  const o = app.game?.odds;
  return o && o.state === s ? o.data : null;
}

const pctText = v => `${Math.round(v * 100)}%`;

/** One line of odds for a call button: the chance that matters for it, plus turnover risk. */
function oddsLine(call, s) {
  const o = oddsFor(s)?.calls.find(c => c.call === call);
  if (!o) return 'ODDS …';
  if (call === 'punt') return `NET ~${Math.round(o.avg_yards)} YDS`;
  if (call === 'field_goal') return `MAKE ${pctText(o.success_chance)}`;
  const main = isGoalToGo(s) ? `TD ${pctText(o.touchdown_chance)}` : `1ST DOWN ${pctText(o.success_chance)}`;
  return o.turnover_chance >= 0.02 ? `${main} · TO ${pctText(o.turnover_chance)}` : main;
}

/** Hover text: the full odds and how many real plays they come from. */
function oddsTitle(call, s) {
  const o = oddsFor(s)?.calls.find(c => c.call === call);
  if (!o) return '';
  const parts = o.success_chance == null ? [] : [`${call === 'field_goal' ? 'make' : 'first down or TD'} ${pctText(o.success_chance)}`];
  parts.push(`TD ${pctText(o.touchdown_chance)}`, `turnover ${pctText(o.turnover_chance)}`, `avg ${o.avg_yards} yds`);
  return `From ${o.plays_considered} real plays like this one: ${parts.join(', ')}.`;
}

/** How good a call was before the snap: its expected WP against the best legal call's. */
function decisionFor(odds, s, call) {
  if (!odds) return null;
  const legal = legalCalls(s);
  const options = odds.calls.filter(c => legal[c.call]);
  const mine = options.find(c => c.call === call);
  if (!mine) return null;
  const best = options.reduce((a, b) => (b.expected_wp > a.expected_wp ? b : a));
  const regret = Math.max(0, best.expected_wp - mine.expected_wp);
  const isBest = regret <= BEST_CALL_SLACK;
  return {
    best: isBest ? call : best.call, isBest, regret,
    score: Math.max(0, 1 - regret / REGRET_SCALE), expectedWpa: mine.expected_wpa,
  };
}

/** Chip text and color for a decision: 'BEST CALL', or how much expected WP it gave up. */
function decisionChip(d) {
  if (!d) return null;
  if (d.isBest) return { text: 'BEST CALL', color: GOOD };
  return { text: `${pts(-d.regret)} vs ${CALL_LABEL[d.best]}`, color: d.regret >= REGRET_SCALE ? BAD : MEH };
}

/** nflverse "D.Prescott" -> "D PRESCOTT" ("A.St. Brown" -> "A ST BROWN"). */
const tagName = name => (name ? String(name).replace(/\./g, ' ').replace(/\s+/g, ' ').trim().toUpperCase() : null);

/** Name tags: QB, RB, top target on the outside WR (deep passes), second target in the slot (short passes). */
function nameTags() {
  const p = app.game.scenario.offense_players || {};
  return { qb: tagName(p.qb), rb: tagName(p.rb), wr1: tagName(p.wr), slot: tagName(p.wr2) };
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
    <div class="sb-right">${esc(opts.right || modeLabel(g))}</div>`;
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
    <button type="button" class="call" data-call="${c}" ${legal[c] ? '' : 'disabled'} title="${esc(oddsTitle(c, s))}">
      <span class="name"><span class="key">${i + 1}</span><span>${CALL_LABEL[c]}</span></span>
      <span class="hint">${esc(callHint(c, s))}</span>
      ${legal[c] ? `<span class="odds">${esc(oddsLine(c, s))}</span>` : ''}
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

/** Same grid slots once the drive ends: summary, menu, the verdict and the coach tile. */
function renderOverGrid(sim) {
  if (app.game.mode === 'endless') return renderEndlessOverGrid(sim);
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
    <button type="button" class="call" id="btn-over-menu">
      <span class="name"><span>MENU</span></span><span class="hint">Result locked in</span>
    </button>
    <div class="over-msg span2">${esc(overMessage(sim))}</div>
    ${coachTile()}`;
  $('btn-see-summary').addEventListener('click', showSummary);
  $('btn-over-menu').addEventListener('click', goHome);
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
  const odds = g.odds?.state === before ? await g.odds.promise : null;
  if (app.game?.token !== token) return;
  const decision = decisionFor(odds, before, call);

  let sim;
  try {
    sim = await api.simulate(before, call, g.mode === 'daily' ? g.scenario.id : null);
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

  if (g.mode === 'daily') {   // locked in before the result is even shown
    runFor(g.scenario.id).calls.push({ call, decision });
    saveDaily();
  }
  const i = g.plays.length;
  g.plays.push({ before, call, sim, booth: null, decision });
  requestBooth(i);

  if (i > 0) field.setup(before, g.kits, endZones(), nameTags());
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
  if (!sim.drive_over) loadOdds(sim.new_state);
  if (sim.drive_over) {
    if (g.mode === 'endless') recordEndlessRound(sim);
    else recordGrade();
  }
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
  if (SUCCESS_SOUND_OUTCOMES.has(r.outcome)) playSfx('successful_play');
  else if (kind === 'fail') playSfx('failed_play');

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
  const chip = decisionChip(g.plays[i].decision);
  delta.hidden = false;
  delta.innerHTML = `<span class="from">${pct(sim.wp_before)}</span><span class="arrow">▶</span><span class="to">${pct(sim.wp_after)}</span>` +
    `<span class="wpa-chip" style="background:${sim.wpa >= 0 ? GOOD : BAD}">WPA ${pts(sim.wpa)}</span>` +
    (chip ? `<span class="wpa-chip decision-chip" style="background:${chip.color}" title="Judged on the odds before the snap">${esc(chip.text)}</span>` : '');
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
  api.commentary(p.before, p.sim, g.scenario.offense_players || null)
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

const LOCKED_WIN_WP = 0.995;   // displays as 100%
const ONE_SCORE = 8;           // a touchdown plus a two-point conversion
const LAST_MINUTE = 60;        // too little time for two scores (TD, onside kick, TD)

/**
 * Is the win guaranteed once the drive is over? The WP model tops out around 98-99% even
 * for unlosable spots, so this reads the scoreboard: ahead at 0:00, or ahead by more than
 * one score with a minute or less left.
 */
function winLocked(finalState, team, finalWp) {
  const lead = finalState.offense === team
    ? finalState.offense_score - finalState.defense_score
    : finalState.defense_score - finalState.offense_score;
  const secs = finalState.seconds_left_in_game;
  return finalWp >= LOCKED_WIN_WP || (lead > 0 && secs === 0) || (lead > ONE_SCORE && secs <= LAST_MINUTE);
}

/** Letter grade from the 0-100 total. */
function gradeFor(total) {
  if (total >= 85) return 'A';
  if (total >= 70) return 'B';
  if (total >= 55) return 'C';
  if (total >= 40) return 'D';
  return 'F';
}

/** 0-100: average credit for each judged call (100 = the best call by the odds every time). */
function decisionScore(plays) {
  const judged = plays.filter(p => p.decision);
  if (!judged.length) return null;
  return (100 * judged.reduce((sum, p) => sum + p.decision.score, 0)) / judged.length;
}

/** 0-100 from your drive's actual WPA: 50 for no change, 100 at +20 points, 0 at -20. A locked-up win is 100. */
function resultScore(you, locked) {
  if (locked) return 100;
  return Math.min(100, Math.max(0, 50 + (50 * you) / RESULT_SCALE));
}

/** Everything the summary and the final screen need about the finished drive. */
function driveResult() {
  const g = app.game;
  const you = yourWpa(), coach = g.scenario.real_drive_wpa;
  const diff = (you - coach) * 100;
  const last = g.plays[g.plays.length - 1].sim;
  const locked = winLocked(last.new_state, g.team, last.wp_after);
  const decision = decisionScore(g.plays);
  const result = resultScore(you, locked);
  // No odds at all (server trouble): grade on the result alone rather than not at all.
  const total = decision == null ? result : DECISION_WEIGHT * decision + (1 - DECISION_WEIGHT) * result;
  return { you, coach, diff, finalWp: last.wp_after, locked, decision, result, total, grade: gradeFor(total) };
}

function recordGrade() {
  const { grade, total, you, coach, decision, result } = driveResult();
  Object.assign(runFor(app.game.scenario.id), { done: true, grade, total, you, coach, decision, result });
  saveDaily();
}

/** Today's finished attempt at a scenario ({grade, total, you, coach, ...}), or null. */
function playedEntry(id) {
  const run = app.daily.runs[id];
  return run?.done ? run : null;
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

/** The drive's summary. review = reopening a finished daily scenario from the menu. */
function showSummary({ review = false } = {}) {
  const g = app.game;
  const sc = g.scenario;
  const plays = g.plays;
  const last = plays[plays.length - 1].sim;
  const fin = last.new_state;
  const { you, coach, diff, locked, grade, decision, result, total } = driveResult();
  const next = nextUnplayed(g.index);
  const scoreOf = abbr => (fin.offense === abbr ? fin.offense_score : fin.defense_score);
  const teamBg = g.kits.off.ui, oppBg = g.kits.def.ui;

  const versus = Math.abs(diff) < 0.05
    ? 'Dead even with the real coach.'
    : diff > 0
      ? `You beat the real coach by ${diff.toFixed(1)} points of win probability.`
      : `The real coach beat you by ${(-diff).toFixed(1)} points of win probability.`;
  const judged = plays.filter(p => p.decision);
  const bestCount = judged.filter(p => p.decision.isBest).length;
  const decisionText = decision == null
    ? 'Decisions: not scored (no odds).'
    : `Decisions ${Math.round(decision)}/100: best call on ${bestCount} of ${judged.length} snap${judged.length === 1 ? '' : 's'}.`;
  const gradeLine = `Score ${Math.round(total)}/100. ${decisionText} Result ${Math.round(result)}/100${locked ? ': win locked up' : ''}.`;

  const good = grade === 'A' || grade === 'B';
  const turfKit = grade === 'C' ? g.kits.off : good ? g.kits.off : g.kits.def;
  const turfPose = grade === 'C' ? 'ready' : 'celebrate';
  const turfImg = spritesNow(turfKit)[turfPose];
  const turfAlt = good ? `${g.team} players celebrating` : grade === 'C' ? `${g.team} players` : `${g.opp} players celebrating`;
  const mirror = !good && grade !== 'C' ? ' style="transform:scaleX(-1)"' : '';

  const meter = v => Math.min(100, Math.abs(v * 100) * 2);
  const youText = `${plays.length} call${plays.length === 1 ? '' : 's'}, ended in ${resultShort(plays[plays.length - 1]).toLowerCase()}. WP ${pct(plays[0].sim.wp_before)} → ${pct(last.wp_after)}.`;

  const real = coachPlays();
  const sitText = s => `${downTextLower(s)} · ${spot(s).replace('THE ', 'the ')}`;

  // Your drive, play by play (the real coach's drive has its own table below).
  const rows = plays.map((p, i) => {
    const sit = sitText(p.before);
    return `<tr>
      <td class="n">${i + 1}</td>
      <td class="sit">${esc(sit)}</td>
      <td class="callc">${CALL_LABEL[p.call]}<span class="sit-phone">${esc(sit)}</span></td>
      <td class="res">${esc(resultShort(p))}</td>
      <td class="wpa" style="color:${p.sim.wpa >= 0 ? GOOD : BAD}">${pts(p.sim.wpa)}</td>
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
          <span class="grade-line">${esc(gradeLine)}</span>
          <span class="grade-how">60% decisions (judged on the odds before each snap) + 40% result. ${esc(versus)}</span>
          <div class="grade-turf">
            <img src="${turfImg}" alt=""${mirror}>
            <img class="big" src="${turfImg}" alt="${esc(turfAlt)}"${mirror}>
            <img src="${turfImg}" alt=""${mirror}>
          </div>
        </div>
        <div class="sum-actions">
          <button type="button" class="btn btn-primary btn-big" id="btn-next"><span>${next == null ? 'FINAL RESULTS' : 'NEXT SCENARIO'}</span><span aria-hidden="true">▶</span></button>
          <button type="button" class="btn" id="btn-sum-menu">MENU</button>
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
            <thead><tr><th class="n">#</th><th class="sit">SITUATION</th><th>YOUR CALL</th><th>RESULT</th><th style="text-align:right">WPA</th></tr></thead>
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
  $('btn-next').addEventListener('click', () => (next == null ? showFinal() : startScenario(next)));
  $('btn-sum-menu').addEventListener('click', goHome);
  show('summary');
  if (review) { /* reopened from the menu: no fanfare */ }
  else if (grade === 'A' || grade === 'B') playSfx('win');
  else if (grade === 'D' || grade === 'F') playSfx('game_over');
  $('btn-next').focus({ preventScroll: true });
}

// ---------- final screen (after the last scenario) ----------

const GRADE_POINTS = { A: 4, B: 3, C: 2, D: 1, F: 0 };

// Share card, like Krillion's: puzzle number, daily score, one emoji per scenario (best to worst).
const GRADE_EMOJI = { A: '🏆', B: '🔥', C: '🏈', D: '🟨', F: '🟥' };
const UNPLAYED_EMOJI = '⬛';
const FIRST_DAY = '2026-11-10';   // Scrimmagine #1 (US Eastern date)

/** Puzzle number for an Eastern date: #1 on FIRST_DAY, +1 every day. */
function dayNumber(day) {
  return Math.round((Date.parse(day) - Date.parse(FIRST_DAY)) / 86400000) + 1;
}

/** One emoji per scenario in today's order. */
function emojiRow(results) {
  return results.map(x => (x.r ? GRADE_EMOJI[x.r.grade] : UNPLAYED_EMOJI)).join('');
}

/** The text that SHARE RESULTS copies. */
function shareText(results, dailyScore) {
  return `Scrimmagine #${dayNumber(app.day || easternDay())} 🏈\n${dailyScore}/${results.length * 100}\n\n${emojiRow(results)}`;
}

/** Copy to the clipboard (with a fallback for browsers that block it); true if it worked. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* not supported */ }
    area.remove();
    return ok;
  }
}

function averageGrade(grades) {
  const avg = grades.reduce((sum, gr) => sum + GRADE_POINTS[gr], 0) / grades.length;
  const letter = avg >= 3.5 ? 'A' : avg >= 2.5 ? 'B' : avg >= 1.5 ? 'C' : avg >= 0.5 ? 'D' : 'F';
  return { letter, avg };
}

/** Today's set wrapped up: average grade and net win-probability change across the scenarios. */
function showFinal() {
  if (app.game) app.game.token = Symbol('finished');
  app.game = null;
  const results = app.scenarios.map((sc, i) => ({ sc, i, r: playedEntry(sc.id) }));
  const played = results.filter(x => x.r);
  const withWp = played.filter(x => x.r.you != null);
  const net = withWp.reduce((sum, x) => sum + x.r.you, 0);
  const netVsCoach = withWp.reduce((sum, x) => sum + (x.r.you - x.r.coach), 0);
  const { letter, avg } = played.length ? averageGrade(played.map(x => x.r.grade)) : { letter: '-', avg: 0 };
  const dailyScore = Math.round(played.reduce((sum, x) => sum + (x.r.total ?? 0), 0));
  const next = nextUnplayed();
  const good = letter === 'A' || letter === 'B';
  const colorways = ['crimson', 'navy', 'forest', 'midnight'];
  const turf = colorways.map((c, i) => `<img${i === 1 || i === 2 ? ' class="big"' : ''} src="/sprites/${c}_${good ? 'celebrate' : 'ready'}.png" alt="">`).join('');
  const color = v => (v >= 0 ? GOOD : BAD);

  const rows = results.map(({ sc, i, r }) => `<tr>
      <td class="n">${i + 1}</td>
      <td class="callc">${esc(matchup(sc))}<span class="sit-phone">${esc(sc.title)}</span></td>
      <td class="sit">${esc(sc.title)}</td>
      <td class="wpa">${r ? `${esc(r.grade)} · ${Math.round(r.total ?? 0)}` : '<span class="muted">—</span>'}</td>
      <td class="wpa" style="color:${r?.you != null ? color(r.you) : 'inherit'}">${r?.you != null ? pts(r.you) : '<span class="muted">—</span>'}</td>
      <td class="wpa" style="color:${r?.you != null ? color(r.you - r.coach) : 'inherit'}">${r?.you != null ? pts(r.you - r.coach) : '<span class="muted">—</span>'}</td>
    </tr>`).join('');

  const playedNote = played.length === results.length
    ? `All ${results.length} of today's scenarios.`
    : `${played.length} of ${results.length} scenarios played. Unplayed ones don't count.`;

  $('final-body').innerHTML = `
    <div class="sum-head">
      <div class="sum-title">
        <span class="crumbs">SCRIMMAGINE #${dayNumber(app.day || easternDay())} · TODAY'S ${results.length} TURNING POINTS</span>
        <h1 id="final-title" style="text-shadow:4px 4px 0 #c8352a">${next == null ? 'FINAL RESULTS' : "TODAY'S RESULTS"}</h1>
      </div>
    </div>
    <div class="sum-body">
      <div class="sum-left">
        <div class="panel grade-card">
          <span class="lbl">AVERAGE GRADE</span>
          <span class="grade">${letter}</span>
          <span class="grade-line">${played.length ? `Score ${dailyScore} / ${results.length * 100} · ${avg.toFixed(1)} / 4.0 · ${esc(playedNote)}` : 'No scenarios played yet.'}</span>
          <span class="share-row" aria-label="Your results by scenario">${emojiRow(results)}</span>
          <span class="share-legend">🏆 A · 🔥 B · 🏈 C · 🟨 D · 🟥 F · ⬛ not played</span>
          <span class="grade-how">One attempt per scenario. A new set unlocks at midnight ET.</span>
          <div class="grade-turf">${turf}</div>
        </div>
        <div class="sum-actions">
          ${next == null ? '' : `<button type="button" class="btn btn-primary btn-big" id="btn-final-next"><span>KEEP PLAYING</span><span aria-hidden="true">▶</span></button>`}
          <button type="button" class="btn${next == null ? ' btn-primary btn-big' : ''}" id="btn-share">SHARE RESULTS</button>
          <button type="button" class="btn" id="btn-final-menu">MENU</button>
          <p class="share-status" id="share-status" role="status" aria-live="polite"></p>
        </div>
      </div>
      <div class="sum-right">
        <div class="vs">
          <div class="panel vs-card">
            <div class="vs-top"><span class="who">NET WP CHANGE</span><span class="num" style="color:${color(net)}">${pts(net)}</span></div>
            <span class="txt">Your win-probability change, added up across ${withWp.length} scenario${withWp.length === 1 ? '' : 's'}.</span>
          </div>
          <div class="panel vs-card coach">
            <div class="vs-top"><span class="who">NET vs REAL COACHES</span><span class="num" style="color:${color(netVsCoach)}">${pts(netVsCoach)}</span></div>
            <span class="txt">${netVsCoach >= 0 ? 'Ahead of' : 'Behind'} the real coaches overall, in points of win probability.</span>
          </div>
        </div>
        <div class="panel log">
          <h2>SCENARIO BY SCENARIO</h2>
          <table>
            <thead><tr><th class="n">#</th><th>MATCHUP</th><th class="sit">SITUATION</th><th style="text-align:right">GRADE · SCORE</th><th style="text-align:right">YOUR WPA</th><th style="text-align:right">vs COACH</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
  if (next != null) $('btn-final-next').addEventListener('click', () => startScenario(next));
  $('btn-final-menu').addEventListener('click', goHome);
  $('btn-share').addEventListener('click', async () => {
    const text = shareText(results, dailyScore);
    const ok = await copyText(text);
    $('share-status').textContent = ok ? 'Copied! Paste it anywhere.' : text;   // shown to copy by hand
  });
  show('final');
  $(next == null ? 'btn-share' : 'btn-final-next').focus({ preventScroll: true });
}

function goHome() {
  if (app.game) app.game.token = Symbol('abandoned');
  app.game = null;
  app.busy = false;
  show('home');
  // Past midnight ET since the set loaded (tab left open): fetch the new day's 6.
  if (app.day && app.day !== easternDay()) loadHome();
  else renderHome();
}

// ---------- endless mode ----------
// Random one-possession drives where you're tied or trailing. A touchdown, or a field goal
// that ties it or takes the lead, loads the next random game; anything else ends the run.
// The score is how many rounds you survive in a row.

const BEST_KEY = 'scrimmagine.endlessBest';

function loadBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}
function saveBest(n) {
  try { localStorage.setItem(BEST_KEY, String(n)); } catch { /* storage unavailable */ }
}

/** Fetch a round; never rejects, so a prefetch nobody awaits can't raise an unhandled error. */
// Promise.resolve().then(...) also turns a synchronous throw (e.g. a stale cached api.js
// without endlessNext) into {error}, instead of a rejection that leaves "LOADING…" forever.
const fetchEndlessRound = () => Promise.resolve()
  .then(() => api.endlessNext())
  .then(sc => ({ sc }), error => ({ error }));

async function startEndless() {
  app.endless = { streak: 0, rounds: [], best: loadBest(), newBest: false, next: null };
  const btn = $('btn-endless');
  btn.disabled = true;
  btn.querySelector('.label').textContent = 'LOADING…';
  $('home-error').hidden = true;
  let ok = false;
  try {
    ok = await nextEndlessRound();
  } finally {
    btn.disabled = false;   // whatever happens, the button never stays on LOADING…
    renderEndlessButton();
  }
  if (!ok) {
    show('home');   // errors are shown on the menu (also when starting from the results screen)
    $('home-error').textContent = "Couldn't load an endless game. Is the server running?";
    $('home-error').hidden = false;
  }
}

/** Load the next round (prefetched if ready) and start it; prefetch the one after. */
async function nextEndlessRound() {
  const e = app.endless;
  const pending = e.next || fetchEndlessRound();
  e.next = null;
  const { sc, error } = await pending;
  if (error) {
    console.warn('Endless round failed to load', error);
    return false;
  }
  e.next = fetchEndlessRound();
  try {
    await startGame(sc, { mode: 'endless' });
  } catch (err) {
    console.warn('Endless round failed to start', err);
    return false;
  }
  return true;
}

/** Your lead once the drive is over (negative if you're still behind). */
function leadAfter(sim) {
  const s = sim.new_state, team = app.game.team;
  return s.offense === team ? s.offense_score - s.defense_score : s.defense_score - s.offense_score;
}

/** How an endless round was survived ('TOUCHDOWN', 'FG TIES IT', 'FG GO-AHEAD'), or null if it wasn't. */
function endlessWin(sim) {
  const outcome = sim.result.outcome;
  if (outcome === 'touchdown') return 'TOUCHDOWN';
  if (outcome !== 'fg_made') return null;
  const lead = leadAfter(sim);
  return lead === 0 ? 'FG TIES IT' : lead > 0 ? 'FG GO-AHEAD' : null;
}

/** Called when an endless drive ends: a touchdown, or a field goal that ties it or takes the
 * lead, extends the streak; anything else ends the run. */
function recordEndlessRound(sim) {
  const e = app.endless;
  const how = endlessWin(sim);
  const won = how !== null;
  e.rounds.push({ scenario: app.game.scenario, won, label: how || driveEndLabel(sim) });
  if (!won) return;
  e.streak += 1;
  if (e.streak > e.best) {
    e.best = e.streak;
    e.newBest = true;
    saveBest(e.best);   // saved right away, so leaving mid-run keeps it
  }
}

function renderEndlessOverGrid(sim) {
  const e = app.endless;
  const how = endlessWin(sim);
  const won = how !== null;
  const chip = $('down-chip');
  chip.className = won ? 'chip' : 'chip bad';
  chip.textContent = `STREAK ${e.streak}`;
  $('calls-title').textContent = won ? 'ROUND WON' : 'RUN OVER';
  const why = driveEndLabel(sim).toLowerCase();
  const grid = $('calls');
  grid.className = 'calls over';
  grid.innerHTML = won
    ? `<button type="button" class="call primary span2" id="btn-endless-go">
         <span class="name"><span>NEXT GAME ▶</span></span><span class="hint">Streak: ${e.streak}. Keep it going.</span>
       </button>
       <button type="button" class="call" id="btn-endless-menu">
         <span class="name"><span>MENU</span></span><span class="hint">Your best is saved</span>
       </button>
       <div class="over-msg span2">${how === 'TOUCHDOWN' ? 'Touchdown!' : how === 'FG TIES IT' ? 'Field goal ties it!' : 'Field goal takes the lead!'} That's ${e.streak} in a row.</div>
       ${coachTile()}`
    : `<button type="button" class="call primary span2" id="btn-endless-go">
         <span class="name"><span>SEE RESULTS ▶</span></span><span class="hint">Final streak: ${e.streak}</span>
       </button>
       <button type="button" class="call" id="btn-endless-menu">
         <span class="name"><span>MENU</span></span><span class="hint">Back to the menu</span>
       </button>
       <div class="over-msg span2">${sim.result.outcome === 'fg_made' ? 'Three points, but still behind' : `No score (${esc(why)})`}. The run ends at ${e.streak}.</div>
       ${coachTile()}`;
  $('btn-endless-go').addEventListener('click', won ? onEndlessNext : showEndlessResults);
  $('btn-endless-menu').addEventListener('click', goHome);
  $('btn-endless-go').focus({ preventScroll: true });
}

async function onEndlessNext() {
  const btn = $('btn-endless-go');
  btn.disabled = true;
  $('call-error').hidden = true;
  if (!(await nextEndlessRound())) {
    btn.disabled = false;
    $('call-error').textContent = "Couldn't load the next game. Try again.";
    $('call-error').hidden = false;
  }
}

function showEndlessResults() {
  const e = app.endless;
  if (app.game) app.game.token = Symbol('finished');
  app.game = null;
  e.next = null;   // a fresh run fetches its own first round
  const rows = e.rounds.map((r, i) => `<tr>
      <td class="n">${i + 1}</td>
      <td class="callc">${esc(matchup(r.scenario))}<span class="sit-phone">${esc(r.scenario.title)}</span></td>
      <td class="sit">${esc(r.scenario.title)}</td>
      <td class="wpa" style="color:${r.won ? GOOD : BAD}">${esc(r.label)}</td>
    </tr>`).join('');
  const line = e.newBest ? 'New best streak!' : `Best streak: ${e.best}`;
  const pose = e.streak > 0 ? 'celebrate' : 'ready';
  const turf = ['crimson', 'navy', 'forest', 'midnight']
    .map((c, i) => `<img${i === 1 || i === 2 ? ' class="big"' : ''} src="/sprites/${c}_${pose}.png" alt="">`).join('');
  $('endless-body').innerHTML = `
    <div class="sum-head">
      <div class="sum-title">
        <span class="crumbs">ENDLESS MODE</span>
        <h1 id="endless-title" style="text-shadow:4px 4px 0 #c8352a">RUN OVER</h1>
      </div>
    </div>
    <div class="sum-body">
      <div class="sum-left">
        <div class="panel grade-card">
          <span class="lbl">FINAL STREAK</span>
          <span class="grade">${e.streak}</span>
          <span class="grade-line">${e.streak === 1 ? '1 game won in a row.' : `${e.streak} games won in a row.`} ${esc(line)}</span>
          <div class="grade-turf">${turf}</div>
        </div>
        <div class="sum-actions">
          <button type="button" class="btn btn-primary btn-big" id="btn-endless-again"><span>PLAY AGAIN</span><span aria-hidden="true">▶</span></button>
          <button type="button" class="btn" id="btn-endless-home">MENU</button>
        </div>
      </div>
      <div class="sum-right">
        <div class="panel log">
          <h2>GAME BY GAME</h2>
          <table>
            <thead><tr><th class="n">#</th><th>MATCHUP</th><th class="sit">SITUATION</th><th style="text-align:right">RESULT</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
  $('btn-endless-again').addEventListener('click', e => { e.currentTarget.disabled = true; startEndless(); });
  $('btn-endless-home').addEventListener('click', goHome);
  show('endless');
  playSfx(e.newBest ? 'win' : 'game_over');
  $('btn-endless-again').focus({ preventScroll: true });
}

function renderEndlessButton() {
  const best = loadBest();
  $('btn-endless').querySelector('.label').textContent = 'ENDLESS';
  $('endless-best').textContent = best ? `BEST ${best}` : '';
}

// ---------- events ----------

$('btn-endless').addEventListener('click', startEndless);
$('btn-results').addEventListener('click', showFinal);

$('scenario-list').addEventListener('click', e => {
  const card = e.target.closest('.scenario-card');
  if (card) startScenario(Number(card.dataset.index));
});
$('btn-play-all').addEventListener('click', () => {
  if (!app.scenarios.length) return;
  const i = nextUnplayed();
  if (i == null) showFinal(); else startScenario(i);
});
$('btn-random').addEventListener('click', () => {
  const open = app.scenarios.map((sc, i) => i).filter(i => !app.daily.runs[app.scenarios[i].id]?.done);
  if (!app.scenarios.length) return;
  if (!open.length) showFinal(); else startScenario(open[Math.floor(Math.random() * open.length)]);
});
$('calls').addEventListener('click', e => {
  const b = e.target.closest('button[data-call]');
  if (b && !b.disabled) makeCall(b.dataset.call);
});
// Every button press clicks (capture phase, so it fires even when the handler re-renders).
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b && !b.disabled) playSfx('button');
}, true);
document.addEventListener('keydown', e => {
  if (screens.game.hidden || e.altKey || e.ctrlKey || e.metaKey) return;
  const n = Number(e.key);
  if (!(n >= 1 && n <= 5)) return;
  // Number keys press the call button itself, so they behave (and sound) like a click.
  const b = document.querySelector(`#calls button[data-call="${CALLS[n - 1]}"]`);
  if (b && !b.disabled) b.click();
});

// ---------- settings (volume sliders) ----------

function wireSlider(inputId, outputId, get, set, onChange) {
  const input = $(inputId), out = $(outputId);
  const sync = () => { out.value = `${input.value}%`; };
  input.value = Math.round(get() * 100);
  sync();
  input.addEventListener('input', () => { set(input.value / 100); sync(); });
  if (onChange) input.addEventListener('change', onChange);
}

wireSlider('vol-sfx', 'vol-sfx-out', () => getVolumes().sfx, setSfxVolume, () => playSfx('button')); // preview
wireSlider('vol-music', 'vol-music-out', () => getVolumes().music, setMusicVolume);
$('btn-settings').addEventListener('click', () => $('settings').showModal());

renderEndlessButton();
show('home'); // also starts the menu music (or arms it for the first click if autoplay is blocked)
loadHome();
