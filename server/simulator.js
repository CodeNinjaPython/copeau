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
  // laser : Grbl en mode laser ($32=1), sortie broche = laser (S 0 à 1000).
  constructor({ speedup = 1, laser = false } = {}) {
    super();
    this.speedup = speedup;
    this.settings = { ...DEFAULT_SETTINGS, ...(laser ? { 30: '1000', 32: '1' } : {}) };
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
    setTimeout(() => this.banner(alarmCode), 50);
  }

  banner(alarmCode) {
    if (alarmCode) this.send(`ALARM:${alarmCode}`);
    this.send('');
    this.send('Grbl 1.1h [\'$\' for help]');
    if (this.alarm) this.send('[MSG:\'$H\'|\'$X\' to unlock]');
  }

  // Ligne reçue telle que la carte la lit.
  normalize(raw) { return raw.replace(/\s+/g, '').toUpperCase(); }

  // ---- Interface "port série" ------------------------------------------

  write(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    for (const byte of buf) {
      if (this.realtime(byte)) continue;
      if (byte === 0x0a) {
        const line = this.normalize(this.lineBuf);
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
      if (this.needsIdle(line) && this.planner.length) break;
      if (this.planner.length >= PLANNER_SIZE) break;
      this.rx.shift();
      let r;
      try { r = this.execute(line); } catch { r = { err: 20 }; }
      if (r?.err) this.sendError(r.err);
      else if (r?.defer) this.waiting = true;
      else if (!r?.silent) this.send('ok');
    }
  }

  needsIdle(line) {
    return (line[0] === '$' && !line.startsWith('$J=')) || /G(10|92|28|30|0?4|38\.\d)(?!\d)/.test(line);
  }

  sendError(code) { this.send(`error:${code}`); }

  execute(line) {
    if (!line) return null;
    if (line[0] === '$') return this.dollar(line);
    // Comme Grbl (protocol.c) : tout G-code est refusé en alarme ET pendant un jog.
    if (this.alarm || this.machineState() === 'Jog') return { err: 9 };
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

// ---- Smoothieware (Emblaser 2) ------------------------------------------------
// Reproduit le comportement série de Smoothieware (branche edge), d'après son
// code source : bannière « Smoothie » + « ok » à l'ouverture de l'USB, rapport
// <Idle|MPos:…|WPos:…|F:…>, temps réel « ? » et Ctrl-X (HALT, levé par M999),
// « ! » / « ~ » seulement en grbl_mode, erreurs en texte, « !! » en HALT,
// commandes de console (fire, version, config-get…) et $I / $J sans « ok ».
// Tout autre octet temps réel est collé à la ligne suivante, qui est alors
// ignorée (« ok - ignored ») : this.ignored garde ces lignes pour les tests.
// Le laser tire sur les G1/G2/G3 selon S (0 à 1), jamais en G0.

const p4 = (p) => `${p.X.toFixed(4)},${p.Y.toFixed(4)},${p.Z.toFixed(4)}`;

export class SmoothieSimulator extends GrblSimulator {
  constructor({ speedup = 1, grblMode = false } = {}) {
    super({ speedup });
    this.grblMode = grblMode;
    this.alarm = false; // l'Emblaser fait son origine au démarrage
    this.st.feed = 4000; // default_feed_rate
    this.seekRate = 4000; // default_seek_rate
    this.laserScale = 1; // M221
    this.manualFire = 0; // fire <pct>
    this.ignored = [];
  }

  banner() {
    this.send('Smoothie');
    this.send('ok');
  }

  // La console garde les minuscules et les espaces (fire 1, $J X1 F100).
  normalize(raw) {
    const t = raw.trim();
    return /^[a-z$]/.test(t) ? t : t.replace(/\s+/g, '').toUpperCase();
  }

  realtime(b) {
    if (b === 0x3f) { this.sendStatus(); return true; }
    if (b === 0x18) { this.halt(); return true; }
    if (b === 0x19) return true; // ^Y : arrêt du jog continu
    if (this.grblMode && b === 0x21) { this.hold = true; return true; }
    if (this.grblMode && b === 0x7e) { this.hold = false; return true; }
    return false;
  }

  halt(message = true) {
    this.planner = [];
    this.rx = [];
    this.lineBuf = '';
    this.waiting = false;
    this.hold = false;
    this.planned = { ...this.mpos };
    this.syncWork();
    this.alarm = true;
    this.manualFire = 0;
    if (message) this.send(this.grblMode ? 'ALARM: Abort during cycle' : 'HALTED, M999 or $X to exit HALT state');
  }

  machineState() {
    if (this.alarm) return 'Alarm';
    if (this.planner.some((x) => x.homing)) return 'Home';
    if (this.hold) return 'Hold';
    if (this.planner.length) return 'Run';
    return 'Idle';
  }

  needsIdle(line) { return /^\$H/i.test(line); }

  rateOf(b) {
    if (b.homing || b.jog) return b.rate;
    return ((b.rapid ? b.seek ?? this.seekRate : b.rate) * this.ov.feed) / 100;
  }

  laserNow() {
    if (this.manualFire) return this.manualFire;
    const cur = this.planner[0];
    if (!cur || this.hold || cur.type !== 'move' || cur.rapid || !cur.power) return 0;
    return Math.min(100, cur.power * 100 * this.laserScale);
  }

  sendStatus() {
    const cur = this.planner[0];
    const moving = cur && !this.hold && cur.type === 'move';
    let s = `<${this.machineState()}|MPos:${p4(this.mpos)}|WPos:${p4(sub(this.mpos, this.wco()))}`;
    if (moving) {
      s += `|F:${this.rateOf(cur).toFixed(1)},${(cur.rapid ? cur.seek ?? this.seekRate : cur.rate).toFixed(1)},${this.ov.feed.toFixed(1)}`;
      s += `|L:${this.laserNow().toFixed(4)}|S:${this.st.speed.toFixed(4)}`;
    } else {
      s += `|F:${this.st.feed.toFixed(1)},${this.ov.feed.toFixed(1)}`;
    }
    this.send(s + '>');
  }

  sendError(code) {
    // Toute erreur G-code fait passer Smoothieware en HALT.
    this.send(`${this.grblMode ? 'error:' : 'Error: '}G-code invalide (${code})`);
    this.send('Entering Alarm/Halt state');
    this.halt(false);
  }

  execute(line) {
    if (!line) return null;
    if (/^[a-z]/.test(line)) return this.shell(line);
    if (line[0] === '$') return this.dollar(line);
    if (this.alarm) {
      if (/^M999(?!\d)/.test(line)) {
        this.alarm = false;
        this.send('WARNING: After HALT you should HOME as position is currently unknown');
        return null;
      }
      this.send(this.grblMode ? 'error:Alarm lock' : '!!');
      return { silent: true };
    }
    if (!'GMTSNXYZF'.includes(line[0])) {
      this.ignored.push(line);
      this.send('ok - ignored');
      return { silent: true };
    }
    return this.gcode(line);
  }

  shell(line) {
    const [cmd, ...args] = line.split(/\s+/);
    if (cmd === 'fire') {
      if (this.alarm) return { silent: true };
      if (args[0] === 'off' || args[0] === '0') {
        this.manualFire = 0;
        this.send('turning laser off and returning to auto mode');
      } else {
        this.manualFire = Math.max(0, Math.min(100, parseFloat(args[0]) || 0));
        this.send(`WARNING: Firing laser at ${this.manualFire.toFixed(2)}% power, entering manual mode use fire off to return to auto mode`);
      }
    } else if (cmd === 'version') {
      this.send('Build version: edge-copeau-sim, Build date: Jan  1 2026 00:00:00, MCU: LPC1769, System Clock: 120MHz');
    } else if (cmd === 'config-get') {
      const key = args[1];
      this.send(key === 'default_seek_rate' ? `sd: ${key} is set to 4000` : `sd: ${key} is not in config`);
    } else if (!cmd.startsWith('ok')) {
      this.send(`error:Unsupported command - ${cmd}`);
    }
    return { silent: true };
  }

  sendModal() {
    const s = this.st;
    this.send(`[GC:G${s.motion} G${s.wcs} G${s.plane} G${s.units} G${s.abs ? 90 : 91} G94 M0 M5 M9 T${s.tool} F${s.feed.toFixed(1)} S${s.speed.toFixed(4)}]`);
  }

  dollar(line) {
    const c = line[1]?.toUpperCase();
    if (c === 'G') { this.sendModal(); return null; }
    if (c === 'I') { this.sendModal(); return { silent: true }; }
    if (c === '#') return super.dollar('$#');
    if (c === 'X') {
      if (!this.alarm) return { silent: true }; // ne répond rien hors HALT
      this.alarm = false;
      this.send('[Caution: Unlocked]');
      return null;
    }
    if (c === 'H') { this.alarm = false; return super.dollar('$H'); }
    if (c === 'J') {
      // $J X10 [F600] [-R] : jog relatif, « ok » seulement avec -R.
      const parts = line.slice(2).trim().split(/\s+/);
      const to = { ...this.planned };
      let rate = 3000;
      for (const p of parts) {
        const a = p[0]?.toUpperCase();
        if (AXES.includes(a)) to[a] += parseFloat(p.slice(1));
        else if (a === 'F') rate = parseFloat(p.slice(1));
      }
      this.planner.push({ type: 'move', to, rate, jog: true });
      this.planned = to;
      this.syncWork();
      return parts.some((p) => /^-R$/i.test(p)) ? null : { silent: true };
    }
    this.send('error:Invalid statement');
    return { silent: true };
  }

  gcode(line) {
    const words = tokenize(line);
    const gs = words.filter((w) => w.letter === 'G').map((w) => Math.round(w.value * 10) / 10);
    const ms = words.filter((w) => w.letter === 'M').map((w) => Math.round(w.value));
    const val = (l) => words.find((w) => w.letter === l)?.value;
    if (ms.includes(115)) {
      this.send('FIRMWARE_NAME:Smoothieware, FIRMWARE_URL:http%3A//smoothieware.org, X-SOURCE_CODE_URL:https://github.com/Smoothieware/Smoothieware, ' +
        `FIRMWARE_VERSION:edge-copeau-sim, PROTOCOL_VERSION:1.0, X-FIRMWARE_BUILD_DATE:Jan  1 2026 00:00:00, X-SYSTEM_CLOCK:120MHz, X-AXES:5, X-GRBL_MODE:${this.grblMode ? 1 : 0}, X-ARCS:1, X-CNC:0, X-MSD:1`);
      return null;
    }
    if (ms.includes(220)) { if (val('S') !== undefined) this.ov.feed = Math.max(10, Math.min(200, val('S'))); return null; }
    if (ms.includes(221)) { if (val('S') !== undefined) this.laserScale = val('S') / 100; return null; }
    if (ms.includes(999)) return null;
    if (ms.includes(400)) {
      if (!this.planner.length) return null;
      this.planner.push({ type: 'dwell', remaining: 0, ok: true });
      return { defer: true };
    }
    if (gs.includes(4)) {
      // Hors grbl_mode, P est en millisecondes ; un G4 de 0 ms ne fait rien.
      const p = val('P') ?? 0;
      const sec = (this.grblMode ? p : Math.trunc(p) / 1000) + (val('S') ?? 0);
      if (sec <= 0) return null;
      this.planner.push({ type: 'dwell', remaining: sec, ok: true });
      return { defer: true };
    }
    // F sur un G0 règle la vitesse des rapides, pas l'avance.
    if (gs.includes(0) && val('F') !== undefined) {
      this.seekRate = val('F');
      line = line.replace(/F[-+]?(?:\d+\.?\d*|\.\d+)/, '');
    }
    const before = this.planner.length;
    const r = super.gcode(line);
    for (let i = before; i < this.planner.length; i++) {
      const b = this.planner[i];
      if (b.type === 'move' && !b.rapid) b.power = this.st.speed;
      if (b.type === 'move' && b.rapid) b.seek = this.seekRate; // vitesse figée à la planification
    }
    return r;
  }
}
