// Top-down field: yard lines, formations and the ~1.2s play animation.
//
// World coordinates: x = yards from the offense's own goal line (0) toward the
// opponent's goal line (100); end zones run -10..0 and 100..110. y = fraction of
// the field height (0 = top sideline). The offense always attacks to the right.

import { spritesNow } from './sprites.js';

const PHONE_MAX = 760;          // matches the CSS breakpoint
const PHONE_PX_PER_YARD = 19.5; // Mobile.html: 20 yards across 390px
const MAX_VISIBLE_YARDS = 50;   // Gameplay.html: 50 yards across 1280px
const PLAY_MS = 1200;

// Formations copied from the mockups, in mockup pixels (left/top of each sprite).
const FORMATIONS = {
  desktop: {
    ppy: 25.6, h: 464, los: 640, w: 40, sh: 48, ball: [16, 12], ballAt: [626, 230],
    off: [['ol', 'stance', 592, [120, 164, 208, 252, 296, 340]], ['qb', 'ready', 528, [208]],
      ['rb', 'ready', 466, [226]], ['wr1', 'ready', 598, [36]], ['wr2', 'ready', 598, [400]],
      ['slot', 'ready', 560, [70]]],
    def: [['dl', 'stance', 650, [142, 186, 230, 274]], ['lb', 'ready', 736, [120, 208, 300]],
      ['cb', 'ready', 664, [36, 400]], ['s', 'ready', 880, [150, 280]]],
  },
  phone: {
    ppy: 19.5, h: 252, los: 194, w: 30, sh: 36, ball: [12, 9], ballAt: [188, 122],
    off: [['ol', 'stance', 164, [35, 71, 107, 143, 179]], ['qb', 'ready', 126, [107]],
      ['rb', 'ready', 88, [122]], ['wr1', 'ready', 166, [2]], ['wr2', 'ready', 166, [213]],
      ['slot', 'ready', 126, [196, 18]]],
    def: [['dl', 'stance', 202, [53, 89, 125, 161]], ['lb', 'ready', 258, [40, 107, 174]],
      ['cb', 'ready', 206, [2, 213]], ['s', 'ready', 336, [70, 150]]],
  },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

export class Field {
  /** @param {HTMLElement} viewport the .field element */
  constructor(viewport) {
    this.vp = viewport;
    this.world = el('div', 'world');
    this.staticLayer = el('div', 'f-static');
    this.markLayer = el('div', 'f-marks');
    this.actorLayer = el('div', 'f-actors');
    this.tagLayer = el('div', 'f-tags');   // name tags draw above every player
    this.world.append(this.staticLayer, this.markLayer, this.actorLayer, this.tagLayer);
    this.vp.prepend(this.world);
    this.actors = [];
    this.ball = null;
    this.camX = 50;
    this.marks = {};
    this.kits = null;
    this.endZones = ['', ''];
    this.measure();
    let lastW = 0, lastH = 0;
    new ResizeObserver(() => {
      if (this.vp.clientWidth === lastW && this.vp.clientHeight === lastH) return;
      lastW = this.vp.clientWidth; lastH = this.vp.clientHeight;
      this.relayout();
    }).observe(this.vp);
  }

  // ---------- geometry ----------

  measure() {
    this.W = this.vp.clientWidth || 1280;
    this.H = this.vp.clientHeight || 464;
    this.phone = this.W < PHONE_MAX;
    this.visible = clamp(this.W / PHONE_PX_PER_YARD, 20, MAX_VISIBLE_YARDS);
    this.ppy = this.W / this.visible;
    this.spec = this.phone ? FORMATIONS.phone : FORMATIONS.desktop;
  }

  px(x) { return (x + 10) * this.ppy; }

  clampCam(x) { return clamp(x, -10 + this.visible / 2, 110 - this.visible / 2); }

  /** Camera target that keeps both the snap spot and the end spot in view when possible. */
  follow(los, endX) {
    const cam = this.clampCam(los);
    const margin = this.visible / 2 - (this.phone ? 3 : 5);
    if (Math.abs(endX - cam) <= margin) return cam;
    return this.clampCam(endX - Math.sign(endX - cam) * margin);
  }

  // ---------- static field ----------

  drawStatic() {
    const p = x => this.px(x).toFixed(1);
    const lw = this.phone ? 3 : 4, tw = this.phone ? 2 : 3;
    const numSize = this.phone ? 16 : 26;
    const parts = [];
    this.world.style.width = `${120 * this.ppy}px`;

    // End zones, tinted with each team's color.
    const [left, right] = this.endZones;
    for (const [x0, z] of [[-10, left], [100, right]]) {
      if (!z) continue;
      parts.push(`<div class="endzone" style="left:${p(x0)}px;width:${(10 * this.ppy).toFixed(1)}px;background:${z.color}">` +
        `<span style="font-size:${numSize}px;transform:rotate(${x0 < 0 ? -90 : 90}deg)">${z.abbr}</span></div>`);
    }
    // Shaded 5-yard bands every 20 yards (as in the mockup).
    for (let x = 0; x < 100; x += 20) {
      parts.push(`<div class="band" style="left:${p(x)}px;width:${(5 * this.ppy).toFixed(1)}px"></div>`);
    }
    // Yard ticks: sidelines and hashes.
    for (let x = 1; x < 100; x++) {
      if (x % 5 === 0) continue;
      const l = (this.px(x) - tw / 2).toFixed(1);
      parts.push(`<div class="tick edge" style="left:${l}px;top:6px;width:${tw}px"></div>`,
        `<div class="tick hash" style="left:${l}px;top:34.5%;width:${tw}px"></div>`,
        `<div class="tick hash" style="left:${l}px;top:63.4%;width:${tw}px"></div>`,
        `<div class="tick edge" style="left:${l}px;bottom:6px;width:${tw}px"></div>`);
    }
    // 5-yard lines, goal lines included.
    for (let x = 0; x <= 100; x += 5) {
      parts.push(`<div class="yardline" style="left:${(this.px(x) - lw / 2).toFixed(1)}px;width:${lw}px"></div>`);
    }
    // Yard numbers.
    for (let x = 10; x <= 90; x += 10) {
      const n = x <= 50 ? x : 100 - x;
      const l = (this.px(x) - 40).toFixed(1);
      parts.push(`<div class="yardnum" style="left:${l}px;top:${this.phone ? '10.3%' : '13.8%'};font-size:${numSize}px">${n}</div>`);
      if (!this.phone) {
        parts.push(`<div class="yardnum flip" style="left:${l}px;top:79.7%;font-size:${numSize}px">${n}</div>`);
      }
    }
    // Goal post at the back of the opponent's end zone (and our own).
    for (const x of [-10, 110]) {
      parts.push(`<div class="goalpost" style="left:${(this.px(x) - (x < 0 ? 0 : 6)).toFixed(1)}px"></div>`);
    }
    this.staticLayer.innerHTML = parts.join('');
  }

  // ---------- marks (lines of scrimmage, chips, trail) ----------

  setMarks(marks) {
    this.marks = marks;
    this.drawMarks();
  }

  drawMarks() {
    const m = this.marks, parts = [];
    const lw = this.phone ? 3 : 4;
    const line = (x, color, extra = '') =>
      parts.push(`<div class="mline" style="left:${(this.px(x) - lw / 2).toFixed(1)}px;width:${lw}px;background:${color};${extra}"></div>`);
    if (m.shortfall) {
      const [a, b] = m.shortfall;
      parts.push(`<div class="shortfall" style="left:${this.px(a).toFixed(1)}px;width:${Math.max(4, (b - a) * this.ppy).toFixed(1)}px"></div>`);
    }
    if (m.oldLos != null) line(m.oldLos, 'rgba(74,163,255,0.45)');
    if (m.los != null) line(m.los, '#4aa3ff');
    if (m.ltg != null && m.ltg <= 100) line(m.ltg, '#ffcf3a');
    if (m.chip && !this.phone && m.los != null && m.ltg != null) {
      const mid = this.px((m.los + Math.min(m.ltg, 100)) / 2);
      parts.push(`<div class="ltg-chip" style="left:${mid.toFixed(1)}px">${m.chip}</div>`);
    }
    if (m.trail) {
      const n = m.trail.length;
      m.trail.forEach((pt, i) => {
        const s = this.phone ? 4 : 6;
        const left = this.px(pt.x) - s / 2, top = pt.y * this.H - pt.h - s / 2;
        parts.push(`<div class="trail" style="left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;width:${s}px;height:${s}px;opacity:${(0.4 + 0.5 * i / Math.max(1, n - 1)).toFixed(2)}"></div>`);
      });
    }
    if (m.gain) {
      // Keep the chip inside the camera view (it sits to the right of the ball).
      const viewRight = this.px(this.camX) + this.W / 2;
      const left = Math.min(this.px(m.gain.x) + (this.phone ? 12 : 20), viewRight - (this.phone ? 120 : 190));
      const top = clamp(m.gain.y * this.H - (this.phone ? 52 : 70), 6, this.H - 40);
      parts.push(`<div class="gain-chip" style="left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;color:${m.gain.color}">${m.gain.text}</div>`);
    }
    this.markLayer.innerHTML = parts.join('');
  }

  // ---------- actors ----------

  /**
   * Lay out both teams in the mockup formation at the line of scrimmage.
   * `names` = {qb, rb, wr1} name tags for offensive players (any may be missing).
   */
  setup(state, kits, endZones, names = {}) {
    this.kits = kits;
    this.endZones = endZones;
    this.measure();
    this.drawStatic();
    const los = 100 - state.yardline_100;
    const f = this.spec;
    const toX = left => los + (left + f.w / 2 - f.los) / f.ppy;
    const toY = top => (top + f.sh / 2) / f.h;
    this.actorLayer.innerHTML = '';
    this.tagLayer.innerHTML = '';
    this.tagLayer.classList.remove('no-names');
    this.actors = [];
    for (const side of ['off', 'def']) {
      for (const [role, pose, left, tops] of f[side]) {
        for (const top of tops) {
          const a = { side, role, pose, x: toX(left), y: toY(top), el: el('div', 'actor'), img: el('img') };
          a.img.alt = '';
          a.img.draggable = false;
          if (side === 'def') a.img.className = 'mirror';
          a.el.append(a.img);
          // One tag per named role (the formation has a single qb, rb and wr1).
          if (side === 'off' && names[role]) {
            a.tag = el('span', 'name-tag');
            a.tag.textContent = names[role];
            this.tagLayer.append(a.tag);
          }
          this.actorLayer.append(a.el);
          this.actors.push(a);
        }
      }
    }
    const [bx, by] = f.ballAt;
    this.ball = { x: los + (bx + f.ball[0] / 2 - f.los) / f.ppy, y: (by + f.ball[1] / 2) / f.h, h: 0, el: el('img', 'ball') };
    this.ball.el.src = '/sprites/ball.png';
    this.ball.el.alt = '';
    this.actorLayer.append(this.ball.el);
    this.camX = this.clampCam(los);
    this.setMarks({
      los, ltg: los + state.distance,
      chip: `${state.down}&amp;${state.yardline_100 <= state.distance ? 'G' : state.distance}`,
    });
    this.render();
  }

  relayout() {
    const wasPhone = this.phone;
    this.measure();
    this.drawStatic();
    this.drawMarks();
    if (wasPhone !== this.phone) this.camX = this.clampCam(this.camX);
    this.render();
  }

  one(role) { return this.actors.find(a => a.role === role); }
  all(role) { return this.actors.filter(a => a.role === role); }

  render() {
    const sprites = { off: spritesNow(this.kits.off), def: spritesNow(this.kits.def) };
    const w = this.phone ? 30 : 40, h = this.phone ? 36 : 48;
    for (const a of this.actors) {
      const src = sprites[a.side][a.pose];
      if (a.src !== src) { a.img.src = src; a.src = src; }
      const s = a.el.style;
      s.width = `${w}px`; s.height = `${h}px`;
      s.transform = `translate(${(this.px(a.x) - w / 2).toFixed(1)}px, ${(a.y * this.H - h / 2).toFixed(1)}px)`;
      s.zIndex = String(10 + Math.round(a.y * 100));
      if (a.tag) {
        // Just under the sprite, right-aligned to it so it trails back toward the
        // offense's own end zone instead of running into the line of scrimmage.
        a.tag.style.transform = `translate(${(this.px(a.x) + w / 2).toFixed(1)}px, ${(a.y * this.H + h / 2 + 1).toFixed(1)}px) translateX(-100%)`;
      }
    }
    if (this.ball) {
      const [bw, bh] = this.phone ? [12, 9] : [16, 12];
      const b = this.ball, s = b.el.style;
      const scale = 1 + b.h / 160;
      s.width = `${bw}px`; s.height = `${bh}px`;
      s.transform = `translate(${(this.px(b.x) - bw / 2).toFixed(1)}px, ${(b.y * this.H - bh / 2 - b.h).toFixed(1)}px) scale(${scale.toFixed(2)})`;
    }
    this.world.style.transform = `translateX(${(this.W / 2 - this.px(this.camX)).toFixed(1)}px)`;
  }

  // ---------- animation ----------

  /** Run a plan built by buildPlan(); resolves when the play is over. */
  play(plan) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const list of [plan.moves, plan.poses, plan.ball]) list.sort((a, b) => a.t0 - b.t0);
    // Kicks reuse the QB and RB as holder / kicker / punter, so their name tags would lie.
    this.tagLayer.classList.toggle('no-names', Boolean(plan.hideNames));
    return new Promise(resolve => {
      let start = null;
      const frame = now => {
        if (start === null) start = now;
        const t = reduce ? plan.T : Math.min(plan.T, now - start);
        this.applyPlan(plan, t);
        this.render();
        if (t < plan.T) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  applyPlan(plan, t) {
    for (const m of plan.moves) {
      if (t < m.t0) break;
      if (!m.from) m.from = { x: m.a.x, y: m.a.y };
      const k = m.t1 > m.t0 ? ease(clamp((t - m.t0) / (m.t1 - m.t0), 0, 1)) : 1;
      m.a.x = lerp(m.from.x, m.x, k);
      m.a.y = lerp(m.from.y, m.y, k);
    }
    for (const p of plan.poses) {
      if (t < p.t0) break;
      p.a.pose = p.pose;
    }
    const b = this.ball;
    for (const seg of plan.ball) {
      if (t < seg.t0) break;
      if (seg.attach) {
        const a = seg.attach;
        if (t >= seg.t0 && !plan.ball.some(s => s.t0 > seg.t0 && t >= s.t0)) {
          b.x = a.x + (a.side === 'off' ? 0.35 : -0.35) * (25.6 / this.ppy);
          b.y = a.y + 0.02;
          b.h = 2;
        }
        continue;
      }
      if (!seg.from) seg.from = { x: b.x, y: b.y };
      const k = clamp((t - seg.t0) / (seg.t1 - seg.t0), 0, 1);
      b.x = lerp(seg.from.x, seg.to.x, k);
      b.y = lerp(seg.from.y, seg.to.y, k);
      b.h = 4 * seg.peak * k * (1 - k);
    }
    if (plan.cam) {
      const c = plan.cam;
      if (t >= c.t0) {
        if (c.from == null) c.from = this.camX;
        this.camX = lerp(c.from, c.to, ease(clamp((t - c.t0) / (c.t1 - c.t0), 0, 1)));
      }
    }
  }

  /** Points along a plan's main ball flight, for the dotted trail left on the field. */
  trailFor(plan) {
    const seg = plan.trailSeg;
    if (!seg || !seg.from) return null;
    const pts = [];
    for (let i = 0; i < 12; i++) {
      const k = i / 11;
      pts.push({ x: lerp(seg.from.x, seg.to.x, k), y: lerp(seg.from.y, seg.to.y, k), h: 4 * seg.peak * k * (1 - k) });
    }
    return pts;
  }
}

// ---------- play plans ----------

/**
 * Turn a SimulateResponse into an animation plan:
 * moves (actor -> spot over [t0, t1]), pose swaps, ball segments and a camera pan.
 */
export function buildPlan(f, before, sim) {
  const r = sim.result;
  const desc = r.description || '';
  const los = 100 - before.yardline_100;
  const T = PLAY_MS;
  const plan = { T, moves: [], poses: [], ball: [], cam: null, trailSeg: null, end: null };
  const mv = (a, x, y, t0, t1) => a && plan.moves.push({ a, x, y: clamp(y, 0.06, 0.94), t0, t1 });
  const pose = (a, p, t0) => a && plan.poses.push({ a, pose: p, t0 });
  const arc = (to, t0, t1, peak, main = false) => {
    const seg = { to, t0, t1, peak };
    plan.ball.push(seg);
    if (main) plan.trailSeg = seg;
    return seg;
  };
  const attach = (a, t0) => a && plan.ball.push({ attach: a, t0 });

  const qb = f.one('qb'), rb = f.one('rb'), wr1 = f.one('wr1'), wr2 = f.one('wr2');
  const slot = f.all('slot')[f.all('slot').length - 1] || wr1;
  const ols = f.all('ol'), dls = f.all('dl');
  const back7 = [...f.all('lb'), ...f.all('cb'), ...f.all('s')];
  const scale = f.phone ? 0.75 : 1; // arc heights are in px

  // Everybody fires off the ball.
  ols.forEach(a => mv(a, a.x + 0.6, a.y, 100, 500));
  dls.forEach(a => mv(a, a.x - 0.3, a.y, 100, 500));

  const converge = (x, y, except = [], t1 = 1050, pull = 0.8) => {
    const near = back7.filter(a => !except.includes(a))
      .sort((a, b) => Math.hypot(a.x - x, (a.y - y) * 50) - Math.hypot(b.x - x, (b.y - y) * 50));
    near.forEach((a, i) => {
      pose(a, 'run', 150);
      const k = i < 2 ? 0.92 : pull - i * 0.06;
      mv(a, lerp(a.x, x + 0.8, k), lerp(a.y, y, k), 200, t1);
    });
    return near;
  };
  const release = (players, t0 = 120) => players.forEach(a => {
    if (!a) return;
    pose(a, 'run', t0);
    mv(a, a.x + 4, a.y, t0, 950);
  });
  const celebrate = (players, t0 = 1100) => players.forEach(a => pose(a, 'celebrate', t0));
  const snapTo = (a, t1 = 150) => { arc({ x: a.x, y: a.y }, 0, t1, 6 * scale); attach(a, t1); };

  // ----- punt -----
  if (r.call === 'punt' || r.call === 'field_goal') plan.hideNames = true;

  if (r.call === 'punt') {
    const punter = rb, land = los + r.yards, returner = f.all('s')[0];
    mv(punter, punter.x - 2, 0.5, 0, 150);
    snapTo(punter, 200);
    pose(punter, 'throw', 220);
    arc({ x: land, y: 0.5 }, 260, 1050, 110 * scale, true);
    [wr1, wr2].forEach((a, i) => { pose(a, 'run', 150); mv(a, land - 4, i ? 0.62 : 0.38, 150, 1100); });
    pose(returner, 'ready', 200);
    mv(returner, land + 0.5, 0.5, 200, 1000);
    attach(returner, 1060);
    plan.cam = { to: f.follow(los, land), t0: 300, t1: 1100 };
    plan.end = { x: land, y: 0.5 };
    return plan;
  }

  // ----- field goal -----
  if (r.call === 'field_goal') {
    const made = r.outcome === 'fg_made';
    mv(qb, los - 7, 0.5, 0, 120);
    pose(qb, 'stance', 0);
    mv(rb, los - 9.5, 0.45, 0, 120);
    snapTo(qb, 260);
    pose(rb, 'run', 260);
    mv(rb, los - 7.6, 0.48, 260, 420);
    pose(rb, 'throw', 420);
    const toY = made ? 0.5 : (Math.random() < 0.5 ? 0.33 : 0.67);
    arc({ x: 109.5, y: toY }, 430, 1100, 90 * scale, true);
    celebrate(made ? [rb, qb] : dls.slice(1, 3), 1120);
    plan.cam = { to: f.follow(los, 105), t0: 450, t1: 1100 };
    plan.end = { x: 109.5, y: toY };
    return plan;
  }

  // ----- scrimmage plays -----
  const isSack = /^Sacked/i.test(desc);
  const isInc = /incomplete/i.test(desc);
  const isInt = /Intercepted/i.test(desc);
  const isFumble = /Fumble/i.test(desc);
  const returnTd = /Returned for a touchdown/i.test(desc);
  const deep = r.call === 'deep_pass';
  const passing = r.call !== 'run';

  let endX = los + r.yards;
  if (r.outcome === 'touchdown') endX = 102.5;
  if (/SAFETY/.test(desc)) endX = Math.min(endX, -1.5);

  let carrier;
  let endY = 0.5;

  snapTo(qb, 130);

  if (passing && !isSack) {
    // Dropback, receivers release, throw.
    const receiver = deep ? wr1 : slot;
    release([wr1, wr2, slot, rb].filter(a => a !== receiver));
    mv(qb, qb.x - 2, qb.y, 130, 400);
    pose(qb, 'throw', 400);
    pose(receiver, 'run', 100);
    if (isInc || isInt) {
      const target = los + (deep ? 20 : 7);
      endY = lerp(receiver.y, 0.5, 0.3);
      mv(receiver, target, endY, 100, 850);
      if (isInt) {
        const picker = converge(target, endY, [], 850)[0];
        mv(picker, target + 0.6, endY - 0.04, 200, 850);
        arc({ x: target + 0.4, y: endY - 0.03 }, 450, 850, (deep ? 70 : 30) * scale, true);
        attach(picker, 850);
        const runBack = returnTd ? -3 : target - 6;
        mv(picker, runBack, 0.5, 860, 1180);
        celebrate([picker], 1150);
        plan.cam = { to: f.follow(los, runBack), t0: 400, t1: 1180 };
        plan.end = { x: runBack, y: 0.5 };
        return plan;
      }
      converge(target, endY, [], 850);
      arc({ x: target + 1.5, y: endY - 0.06 }, 450, 850, (deep ? 70 : 30) * scale, true);
      arc({ x: target + 3, y: endY - 0.03 }, 850, 1000, 5 * scale);
      plan.cam = { to: f.follow(los, target), t0: 400, t1: 1000 };
      plan.end = { x: target, y: endY };
      return plan;
    }
    // Completion: ball meets the receiver at the end spot.
    endY = lerp(receiver.y, 0.5, 0.35);
    mv(receiver, endX, endY, 100, 850);
    arc({ x: endX, y: endY }, 450, 850, (deep ? 70 : 30) * scale, true);
    attach(receiver, 850);
    carrier = receiver;
  } else if (isSack) {
    release([wr1, wr2, slot]);
    mv(qb, qb.x - 2, qb.y, 130, 400);
    mv(qb, Math.min(endX, qb.x - 2), qb.y, 400, 900);
    endY = qb.y;
    dls.slice(1, 3).forEach((a, i) => { pose(a, 'run', 120); mv(a, Math.min(endX, qb.x - 2) + 0.9, qb.y + (i ? 0.05 : -0.05), 150, 900); });
    carrier = qb;
  } else {
    // Handoff and run to the spot.
    release([wr1, wr2, slot]);
    pose(qb, 'run', 220);
    mv(qb, qb.x - 1, qb.y + 0.05, 200, 600);
    pose(rb, 'run', 150);
    mv(rb, los - 0.6, 0.5, 150, 380);
    attach(rb, 300);
    endY = 0.5 + (Math.random() - 0.5) * 0.3;
    mv(rb, endX, endY, 380, 1050);
    carrier = rb;
  }

  const tacklers = converge(endX, endY, [], 1050);
  plan.cam = { to: f.follow(los, endX), t0: 250, t1: 1100 };
  plan.end = { x: endX, y: endY };

  if (isFumble) {
    const recoverer = tacklers[0];
    arc({ x: endX + 0.6, y: endY + 0.05 }, 1000, 1100, 10 * scale);
    attach(recoverer, 1100);
    if (returnTd) {
      mv(recoverer, -3, 0.5, 1100, 1200);
      plan.cam = { to: f.follow(los, -3), t0: 250, t1: 1200 };
    }
    celebrate([recoverer], 1150);
    return plan;
  }
  if (r.outcome === 'touchdown') celebrate([carrier, wr2], 1100);
  if (r.outcome === 'turnover' || r.outcome === 'turnover_on_downs') celebrate(tacklers.slice(0, 2), 1120);
  if (isSack && r.outcome !== 'turnover') celebrate(dls.slice(1, 2), 1120);
  return plan;
}
