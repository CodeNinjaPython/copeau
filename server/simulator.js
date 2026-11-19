import { EventEmitter } from 'node:events';
import { tokenize, createState, step, arcPoints, fmt } from '../public/js/shared/gcode.js';

// Simulateur Grbl 1.1 : se branche à la place d'un port série. Fraise Ø6 montée.
// Volume machine négatif (origine machine en haut à droite au fond, comme Grbl
// après une prise d'origine). Une pièce virtuelle permet de tester le palpage :
// un bloc avec un trou débouchant au milieu.
const STOCK = { min: { X: -220, Y: -200, Z: -80 }, max: { X: -120, Y: -100, Z: -50 } };
const HOLE = { X: -170, Y: -150, r: 12.5 };
const PLANNER_SIZE = 15;
const TICK_MS = 20;

const DEFAULT_SETTINGS = {
  0: '10', 1: '25', 2: '0', 3: '0', 4: '0', 5: '0', 6: '0', 10: '1', 11: '0.010', 12: '0.002',
  13: '0', 20: '0', 21: '0', 22: '1', 23: '0', 24: '25.000', 25: '500.000', 26: '250', 27: '1.000',
  30: '24000', 31: '0', 32: '0', 100: '800.000', 101: '800.000', 102: '800.000',
  110: '3000.000', 111: '3000.000', 112: '1000.000', 120: '200.000', 121: '200.000', 122: '100.000',
  130: '300.000', 131: '300.000', 132: '80.000',
};

const AXES = ['X', 'Y', 'Z'];
const add = (a, b) => ({ X: a.X + b.X, Y: a.Y + b.Y, Z: a.Z + b.Z });
const sub = (a, b) => ({ X: a.X - b.X, Y: a.Y - b.Y, Z: a.Z - b.Z });
const dist = (a, b) => Math.hypot(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
const lerp = (a, b, t) => ({ X: a.X + (b.X - a.X) * t, Y: a.Y + (b.Y - a.Y) * t, Z: a.Z + (b.Z - a.Z) * t });
const p3 = (p) => `${p.X.toFixed(3)},${p.Y.toFixed(3)},${p.Z.toFixed(3)}`;
const zero = () => ({ X: 0, Y: 0, Z: 0 });

// L'outil simulé est une fraise droite de rayon TOOL_R : on teste le
// centre de l'outil contre la pièce dilatée de son rayon en X/Y.
const TOOL_R = 3;
function solid(p) {
  const inBox = ['X', 'Y'].every((a) => p[a] >= STOCK.min[a] - TOOL_R && p[a] <= STOCK.max[a] + TOOL_R) &&
    p.Z >= STOCK.min.Z && p.Z <= STOCK.max.Z;
  return inBox && Math.hypot(p.X - HOLE.X, p.Y - HOLE.Y) > HOLE.r - TOOL_R;
}

// Premier point de contact sur le segment, ou null.
function findContact(from, to) {
  const d = dist(from, to);
  const n = Math.max(1, Math.ceil(d / 0.05));
  let prev = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (solid(lerp(from, to, t))) {
      let lo = prev, hi = t;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        if (solid(lerp(from, to, mid))) hi = mid; else lo = mid;
      }
      return lerp(from, to, lo);
    }
    prev = t;
  }
  return null;
}

export class GrblSimulator extends EventEmitter {
  constructor({ speedup = 1 } = {}) {
    super();
    this.speedup = speedup;
    this.settings = { ...DEFAULT_SETTINGS };
    this.wcs = { 54: zero(), 55: zero(), 56: zero(), 57: zero(), 58: zero(), 59: zero() };
    this.g92 = zero();
    this.mpos = zero();
    this.ov = { feed: 100, rapid: 100, spindle: 100 };
    this.out = [];
    this.alarm = true;
    this.powerOn();
    this.timer = setInterval(() => this.tick(TICK_MS / 1000), TICK_MS);
  }

  powerOn(alarmCode) {
    this.st = createState();
    this.planner = [];
    this.rx = [];
    this.lineBuf = '';
    this.hold = false;
    this.spindleStopOvr = false;
    this.waiting = false;
    this.planned = { ...this.mpos };
    this.syncWork();
    setTimeout(() => {
      if (alarmCode) this.send(`ALARM:${alarmCode}`);
      this.send('');
      this.send('Grbl 1.1h [\'$\' for help]');
      if (this.alarm) this.send('[MSG:\'$H\'|\'$X\' to unlock]');
    }, 50);
  }

  // ---- Interface "port série" ------------------------------------------

  write(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    for (const byte of buf) {
      if (this.realtime(byte)) continue;
      if (byte === 0x0a) {
        const line = this.lineBuf.replace(/\s+/g, '').toUpperCase();
        this.lineBuf = '';
        this.rx.push(line);
      } else if (byte !== 0x0d) {
        this.lineBuf += String.fromCharCode(byte);
      }
    }
    this.processRx();
    return true;
  }

  close() {
    clearInterval(this.timer);
    setImmediate(() => this.emit('close'));
  }

  send(line) {
    this.out.push(line + '\r\n');
    if (this.out.length === 1) {
      setImmediate(() => {
        const text = this.out.join('');
        this.out = [];
        this.emit('data', Buffer.from(text, 'latin1'));
      });
    }
  }

  // ---- Temps réel --------------------------------------------------------

  realtime(b) {
    const clamp = (v) => Math.max(10, Math.min(200, v));
    switch (b) {
      case 0x3f: this.sendStatus(); return true;
      case 0x21:
        if (this.planner.some((x) => x.jog)) this.cancelJog();
        else if (this.planner.length) this.hold = true;
        return true;
      case 0x7e: this.hold = false; this.spindleStopOvr = false; return true; // Grbl rallume la broche à la reprise
      case 0x9e: if (this.hold) this.spindleStopOvr = !this.spindleStopOvr; return true;
      case 0x18: this.softReset(); return true;
      case 0x85: this.cancelJog(); return true;
      case 0x90: this.ov.feed = 100; return true;
      case 0x91: this.ov.feed = clamp(this.ov.feed + 10); return true;
      case 0x92: this.ov.feed = clamp(this.ov.feed - 10); return true;
      case 0x93: this.ov.feed = clamp(this.ov.feed + 1); return true;
      case 0x94: this.ov.feed = clamp(this.ov.feed - 1); return true;
      case 0x95: this.ov.rapid = 100; return true;
      case 0x96: this.ov.rapid = 50; return true;
      case 0x97: this.ov.rapid = 25; return true;
      case 0x99: this.ov.spindle = 100; return true;
      case 0x9a: this.ov.spindle = clamp(this.ov.spindle + 10); return true;
      case 0x9b: this.ov.spindle = clamp(this.ov.spindle - 10); return true;
      case 0x9c: this.ov.spindle = clamp(this.ov.spindle + 1); return true;
      case 0x9d: this.ov.spindle = clamp(this.ov.spindle - 1); return true;
      default: return b >= 0x80; // autres octets étendus ignorés
    }
  }

  cancelJog() {
    if (!this.planner.some((x) => x.jog)) return;
    this.planner = this.planner.filter((x) => !x.jog);
    this.planned = { ...this.mpos };
    this.syncWork();
  }

  softReset() {
    const moving = this.planner.length > 0 && !this.hold;
    if (moving) this.alarm = true;
    this.powerOn(moving ? 3 : undefined);
  }

  machineState() {
    if (this.alarm) return 'Alarm';
    if (this.hold) return 'Hold:0';
    if (this.planner.some((x) => x.homing)) return 'Home';
    if (this.planner.some((x) => x.jog)) return 'Jog';
    if (this.planner.length) return 'Run';
    return 'Idle';
  }

  wco() { return add(this.wcs[this.st.wcs], this.g92); }

  // Recalcule la position programme à partir de la position planifiée machine.
  syncWork() { this.st.pos = sub(this.planned, this.wco()); }

  sendStatus() {
    const cur = this.planner[0];
    const moving = cur && !this.hold && (cur.type === 'move' || cur.type === 'probe');
    const feed = moving ? Math.round(this.rateOf(cur)) : 0;
    const spindleOn = (this.st.spindle === 3 || this.st.spindle === 4) && !this.spindleStopOvr;
    const speed = spindleOn ? Math.round((this.st.speed * this.ov.spindle) / 100) : 0;
    const rxBytes = this.rx.reduce((n, l) => n + l.length + 1, 0);
    this.send(`<${this.machineState()}|MPos:${p3(this.mpos)}|Bf:${PLANNER_SIZE - this.planner.length},${128 - rxBytes}` +
      `|FS:${feed},${speed}|WCO:${p3(this.wco())}|Ov:${this.ov.feed},${this.ov.rapid},${this.ov.spindle}>`);
  }

  // ---- Réception des lignes ----------------------------------------------

  processRx() {
    while (this.rx.length && !this.waiting) {
      const line = this.rx[0];
      const needsIdle = (line[0] === '$' && !line.startsWith('$J=')) || /G(10|92|28|30|0?4|38\.\d)(?!\d)/.test(line);
      if (needsIdle && this.planner.length) break;
      if (this.planner.length >= PLANNER_SIZE) break;
      this.rx.shift();
      let r;
      try { r = this.execute(line); } catch (e) { r = { err: 20 }; }
      if (r?.err) this.send(`error:${r.err}`);
      else if (r?.defer) this.waiting = true;
      else this.send('ok');
    }
  }

  execute(line) {
    if (!line) return null;
    if (line[0] === '$') return this.dollar(line);
    if (this.alarm) return { err: 9 };
    return this.gcode(line);
  }

  dollar(line) {
    if (line === '$$') {
      for (const [k, v] of Object.entries(this.settings)) this.send(`$${k}=${v}`);
      return null;
    }
    if (line === '$G') {
      const s = this.st;
      this.send(`[GC:G${s.motion} G${s.wcs} G${s.plane} G${s.units} G${s.abs ? 90 : 91} G${s.feedMode} M${s.spindle} ` +
        `M${s.flood ? 8 : s.mist ? 7 : 9} T${s.tool} F${fmt(s.feed)} S${fmt(s.speed)}]`);
      return null;
    }
    if (line === '$#') {
      for (const n of [54, 55, 56, 57, 58, 59]) this.send(`[G${n}:${p3(this.wcs[n])}]`);
      this.send('[G28:0.000,0.000,0.000]');
      this.send('[G30:0.000,0.000,0.000]');
      this.send(`[G92:${p3(this.g92)}]`);
      this.send('[TLO:0.000]');
      this.send('[PRB:0.000,0.000,0.000:0]');
      return null;
    }
    if (line === '$I') { this.send('[VER:1.1h.20190825:Copeau-sim]'); this.send('[OPT:V,15,128]'); return null; }
    if (line === '$X') {
      if (this.alarm) { this.alarm = false; this.send('[MSG:Caution: Unlocked]'); }
      return null;
    }
    if (line === '$H') {
      this.alarm = false;
      const top = { ...this.mpos, Z: 0 };
      this.planner.push({ type: 'move', to: top, rate: 1500, homing: true });
      this.planner.push({ type: 'move', to: zero(), rate: 1500, homing: true });
      this.planner.push({ type: 'move', to: { X: -1, Y: -1, Z: -1 }, rate: 500, homing: true, ok: true });
      this.planned = { X: -1, Y: -1, Z: -1 };
      this.syncWork();
      return { defer: true };
    }
    if (line === '$C' || line === '$N' || line === '$SLP') return null;
    if (line.startsWith('$J=')) return this.jog(line.slice(3));
    const m = line.match(/^\$(\d+)=([-\d.]+)$/);
    if (m) { this.settings[m[1]] = m[2]; return null; }
    return { err: 3 };
  }

  jog(body) {
    if (this.alarm) return { err: 9 };
    const st = this.machineState();
    if (st !== 'Idle' && st !== 'Jog') return { err: 8 };
    const words = tokenize(body);
    const g = words.filter((w) => w.letter === 'G').map((w) => w.value);
    const f = words.find((w) => w.letter === 'F');
    if (!f) return { err: 22 };
    const k = g.includes(20) ? 25.4 : 1;
    const rel = g.includes(91);
    const machine = g.includes(53);
    const to = { ...this.planned };
    for (const w of words) {
      if (!AXES.includes(w.letter)) continue;
      const v = w.value * k;
      to[w.letter] = machine ? v : rel ? to[w.letter] + v : v + this.wco()[w.letter];
    }
    this.planner.push({ type: 'move', to, rate: f.value * k, jog: true });
    this.planned = to;
    this.syncWork();
    return null;
  }

  gcode(line) {
    const words = tokenize(line);
    if (!words.length) return { err: 1 };
    const gs = words.filter((w) => w.letter === 'G').map((w) => Math.round(w.value * 10) / 10);
    const ms = words.filter((w) => w.letter === 'M').map((w) => Math.round(w.value));
    const val = (l) => words.find((w) => w.letter === l)?.value;
    const axes = {};
    for (const w of words) if (AXES.includes(w.letter)) axes[w.letter] = w.value;
    const units = gs.includes(20) ? 20 : gs.includes(21) ? 21 : this.st.units;
    const k = units === 20 ? 25.4 : 1;

    if (gs.includes(10)) {
      const L = val('L'), P = Math.round(val('P') ?? 0);
      const n = P === 0 ? this.st.wcs : 53 + P;
      if (!this.wcs[n]) return { err: 29 };
      for (const a of Object.keys(axes)) {
        if (L === 2) this.wcs[n][a] = axes[a] * k;
        else if (L === 20) this.wcs[n][a] = this.mpos[a] - this.g92[a] - axes[a] * k;
        else return { err: 20 };
      }
      this.syncWork();
      return null;
    }
    if (gs.includes(92)) {
      for (const a of Object.keys(axes)) this.g92[a] = this.mpos[a] - this.wcs[this.st.wcs][a] - axes[a] * k;
      this.syncWork();
      return null;
    }
    if (gs.includes(4)) {
      const p = val('P');
      if (p === undefined) return { err: 28 };
      this.planner.push({ type: 'dwell', remaining: p, ok: true });
      return { defer: true };
    }
    if (gs.includes(53)) {
      const to = { ...this.planned };
      for (const a of Object.keys(axes)) to[a] = axes[a] * k;
      const rapid = !gs.includes(1);
      if (gs.includes(0) || gs.includes(1)) this.st.motion = gs.includes(1) ? 1 : 0;
      if (!rapid && !this.st.feed && val('F') === undefined) return { err: 22 };
      if (val('F') !== undefined) this.st.feed = val('F') * k;
      this.planner.push({ type: 'move', to, rate: this.st.feed, rapid });
      this.planned = to;
      this.syncWork();
      return null;
    }

    const probe = gs.find((g) => g >= 38.2 && g <= 38.5);
    const before = { ...this.st.pos };
    const segs = [];
    step(this.st, line, (s) => segs.push(s));
    if (this.st.feed <= 0 && (probe || segs.some((s) => s.kind !== 'rapid'))) return { err: 22 };

    if (probe) {
      const to = add(this.st.pos, this.wco());
      this.st.pos = before;
      this.planner.push({ type: 'probe', to, rate: this.st.feed, mode: probe, ok: true });
      return { defer: true };
    }
    for (const s of segs) {
      const wco = this.wco();
      if (s.kind === 'arc') {
        for (const p of arcPoints(s, 1).pts) this.planner.push({ type: 'move', to: add(p, wco), rate: s.feed });
      } else {
        this.planner.push({ type: 'move', to: add(s.to, wco), rate: s.feed, rapid: s.kind === 'rapid' });
      }
    }
    this.planned = add(this.st.pos, this.wco());
    if (ms.includes(0) || ms.includes(1)) this.planner.push({ type: 'pause' });
    if (ms.includes(2) || ms.includes(30)) {
      this.st.spindle = 5; this.st.mist = false; this.st.flood = false;
      this.st.abs = true; this.st.wcs = 54; this.st.plane = 17; this.st.motion = 1;
      this.g92 = zero();
      this.syncWork();
    }
    return null;
  }

  // ---- Exécution -------------------------------------------------------

  rateOf(b) {
    if (b.homing || b.jog) return b.rate;
    if (b.rapid) return (Number(this.settings[110]) * this.ov.rapid) / 100;
    return (b.rate * this.ov.feed) / 100;
  }

  tick(dt) {
    let budget = dt * this.speedup;
    while (budget > 0 && this.planner.length && !this.hold && !this.alarm) {
      const b = this.planner[0];
      if (b.type === 'dwell') {
        b.remaining -= budget;
        if (b.remaining > 0) budget = 0;
        else { budget = -b.remaining; this.finish(b); }
        continue;
      }
      if (b.type === 'pause') { this.hold = true; this.finish(b); break; }
      if (b.type === 'probe' && !b.started) {
        b.started = true;
        if (solid(this.mpos)) { this.failProbe(b, 4); break; }
        const hit = findContact(this.mpos, b.to);
        if (hit) { b.to = hit; b.hit = true; }
      }
      const speed = this.rateOf(b) / 60; // mm/s
      const d = dist(this.mpos, b.to);
      if (speed <= 0) break;
      if (speed * budget >= d) {
        this.mpos = { ...b.to };
        budget -= d / speed;
        this.finish(b);
      } else {
        this.mpos = lerp(this.mpos, b.to, (speed * budget) / d);
        budget = 0;
      }
    }
    this.processRx();
  }

  finish(b) {
    this.planner.shift();
    if (b.type === 'probe') {
      const fails = !b.hit && (b.mode === 38.2 || b.mode === 38.4);
      this.planned = { ...this.mpos };
      this.syncWork();
      if (fails) return this.failProbe(b, 5);
      this.send(`[PRB:${p3(this.mpos)}:${b.hit ? 1 : 0}]`);
    }
    if (b.ok) { this.send('ok'); this.waiting = false; }
  }

  failProbe(b, code) {
    if (this.planner[0] === b) this.planner.shift();
    this.alarm = true;
    this.planner = [];
    this.planned = { ...this.mpos };
    this.syncWork();
    this.send(`ALARM:${code}`);
    this.send(`[PRB:${p3(this.mpos)}:0]`);
    this.send('ok');
    this.waiting = false;
  }
}
