import { EventEmitter } from 'node:events';
import { splitProgram, buildResume } from '../public/js/shared/gcode.js';
import { errorText, alarmText } from './codes.js';

// Grbl a un tampon de réception de 128 octets. On garde un octet de marge.
const RX_BUFFER = 127;
const POLL_MS = 200;

// Commandes temps réel. Les octets >= 0x80 doivent partir en Buffer brut,
// sinon l'encodage UTF-8 les transforme en deux octets.
export const REALTIME = {
  status: 0x3f, hold: 0x21, start: 0x7e, reset: 0x18, jogCancel: 0x85,
  feed100: 0x90, feedPlus10: 0x91, feedMinus10: 0x92, feedPlus1: 0x93, feedMinus1: 0x94,
  rapid100: 0x95, rapid50: 0x96, rapid25: 0x97,
  spindle100: 0x99, spindlePlus10: 0x9a, spindleMinus10: 0x9b, spindlePlus1: 0x9c, spindleMinus1: 0x9d,
  spindleStop: 0x9e, flood: 0xa0, mist: 0xa1,
};

const TOOL_CHANGE_RE = /M0*6(?!\d)/;

export class GrblError extends Error {
  constructor(code, line) {
    super(`error:${code} ${errorText(code)} (${line})`);
    this.code = code;
  }
}

const xyz = (s) => {
  const [X, Y, Z] = s.split(',').map(Number);
  return { X, Y, Z };
};

export class GrblController extends EventEmitter {
  constructor() {
    super();
    this.transport = null;
    this.portName = null;
    this.job = null;
    this.reset();
  }

  reset() {
    this.ready = false;
    this.version = null;
    this.queue = [];
    this.inflight = [];
    this.inflightBytes = 0;
    this.rxText = '';
    this.status = {
      state: 'Déconnecté', subState: null,
      mpos: { X: 0, Y: 0, Z: 0 }, wpos: { X: 0, Y: 0, Z: 0 }, wco: { X: 0, Y: 0, Z: 0 },
      feed: 0, speed: 0, ov: { feed: 100, rapid: 100, spindle: 100 }, pins: '', buffer: null,
    };
    this.modal = { wcs: 'G54', units: 'G21', distance: 'G90', spindle: 'M5', coolant: 'M9', tool: 0, feed: 0, speed: 0 };
    this.settings = {};
    this.offsets = {};
    this.lastProbe = null;
    this.statusWaiters = [];
    this.spindleHeld = false; // broche coupée par Copeau pendant une pause
    this.restoreOnUnlock = null; // modes à rétablir quand l'alarme est levée
  }

  get connected() { return !!this.transport; }

  attach(transport, portName) {
    this.reset();
    this.transport = transport;
    this.portName = portName;
    this.status.state = 'Connexion';
    transport.on('data', (d) => this.onData(d));
    transport.on('close', () => this.detach('Port fermé'));
    transport.on('error', (e) => this.log('err', `Port : ${e.message}`));
    // Sans bannière (carte qui ne redémarre pas à l'ouverture), on force un reset.
    this.bannerTimer = setTimeout(() => { if (!this.ready) this.realtime('reset'); }, 2500);
    this.silenceTimer = setTimeout(() => {
      if (!this.ready) this.log('err', 'La carte ne répond pas : vérifiez le port et la vitesse (115200 pour Grbl, parfois 250000).');
    }, 6000);
    this.pollTimer = setInterval(() => { if (this.ready) this.writeRaw(Buffer.from([REALTIME.status])); }, POLL_MS);
    this.emitState();
  }

  detach(reason) {
    if (!this.transport) return;
    clearTimeout(this.bannerTimer);
    clearTimeout(this.silenceTimer);
    clearInterval(this.pollTimer);
    const t = this.transport;
    this.transport = null;
    this.failPending(new Error(reason || 'Déconnecté'));
    if (this.job && ['running', 'paused', 'spinup', 'toolchange', 'finishing'].includes(this.job.state)) {
      this.job.state = 'stopped';
      this.job.error = reason || 'Déconnecté';
    }
    this.reset();
    try { t.close?.(); } catch {}
    this.log('info', reason || 'Déconnecté');
    this.emitJob();
    this.emitState();
  }

  failPending(err) {
    for (const item of [...this.inflight, ...this.queue]) item.reject?.(err);
    this.queue = [];
    this.inflight = [];
    this.inflightBytes = 0;
  }

  log(dir, text) { this.emit('log', { dir, text, at: Date.now() }); }

  writeRaw(data) {
    if (!this.transport) return;
    this.transport.write(data);
  }

  realtime(name) {
    const byte = REALTIME[name];
    if (byte === undefined) throw new Error(`Commande temps réel inconnue : ${name}`);
    if (!this.transport) return;
    this.writeRaw(Buffer.from([byte]));
    if (name === 'reset') {
      // Grbl vide son tampon de réception : toutes les lignes en vol sont perdues.
      this.ready = false;
      this.failPending(new Error('Reset'));
      if (this.job && ['running', 'paused', 'spinup', 'toolchange', 'finishing', 'stopping'].includes(this.job.state)) {
        this.job.state = 'stopped';
        this.emitJob();
      }
    }
  }

  // ---- Réception -------------------------------------------------------

  onData(chunk) {
    this.rxText += chunk.toString('latin1');
    let i;
    while ((i = this.rxText.indexOf('\n')) >= 0) {
      const line = this.rxText.slice(0, i).replace(/\r$/, '').trim();
      this.rxText = this.rxText.slice(i + 1);
      if (line) this.handleLine(line);
    }
  }

  handleLine(line) {
    if (line[0] === '<') return this.onStatus(line);
    if (line === 'ok') return this.ack(null);
    let m;
    if ((m = line.match(/^error:(\d+)/))) return this.ack(Number(m[1]));
    this.log('rx', line);
    if ((m = line.match(/^ALARM:(\d+)/))) {
      const code = Number(m[1]);
      this.log('err', `Alarme ${code} : ${alarmText(code)}`);
      this.status.state = 'Alarm';
      if (this.job && ['running', 'paused', 'spinup', 'toolchange', 'finishing'].includes(this.job.state)) {
        this.job.state = 'stopped';
        this.job.error = `Alarme ${code} : ${alarmText(code)}`;
        this.emitJob();
      }
      this.emit('alarm', code);
      return this.emitState();
    }
    if ((m = line.match(/^(Grbl|GrblHAL)\s+(\S+)/i))) return this.onBanner(line, m[2]);
    if ((m = line.match(/^\[GC:(.*)\]$/))) return this.onModal(m[1]);
    if ((m = line.match(/^\[PRB:([^:]+):(\d)\]$/))) {
      this.lastProbe = { ...xyz(m[1]), ok: m[2] === '1' };
      return;
    }
    if ((m = line.match(/^\[(G5[4-9]|G28|G30|G92|TLO):(.*)\]$/))) {
      this.offsets[m[1]] = m[1] === 'TLO' ? Number(m[2]) : xyz(m[2]);
      return this.emitState();
    }
    if ((m = line.match(/^\$(\d+)=(.*)$/))) {
      this.settings[m[1]] = m[2].trim();
      // Copeau travaille en mm : des rapports en pouces fausseraient tout.
      if (m[1] === '13' && m[2].trim() === '1') {
        this.log('err', 'La carte rapporte les positions en pouces ($13=1) : Copeau attend des mm. Envoyez $13=0.');
      }
      this.emitSettings();
    }
  }

  onBanner(line, version) {
    clearTimeout(this.bannerTimer);
    clearTimeout(this.silenceTimer);
    this.failPending(new Error('Reset'));
    this.ready = true;
    this.version = version;
    this.log('info', `Connecté : ${line}`);
    this.settings = {};
    for (const q of ['$$', '$G', '$#']) this.cmd(q).catch(() => {});
    this.emitState();
  }

  onModal(text) {
    for (const w of text.split(' ')) {
      if (/^G5[4-9]$/.test(w)) this.modal.wcs = w;
      else if (w === 'G20' || w === 'G21') this.modal.units = w;
      else if (w === 'G90' || w === 'G91') this.modal.distance = w;
      else if (/^M[345]$/.test(w)) this.modal.spindle = w;
      else if (/^M[789]$/.test(w)) this.modal.coolant = w;
      else if (w[0] === 'T') this.modal.tool = Number(w.slice(1));
      else if (w[0] === 'F') this.modal.feed = Number(w.slice(1));
      else if (w[0] === 'S') this.modal.speed = Number(w.slice(1));
    }
    this.emitState();
  }

  onStatus(line) {
    const parts = line.slice(1, -1).split('|');
    const [state, sub] = parts[0].split(':');
    const s = this.status;
    // Alarme levée ($X ou prise d'origine) : rétablir les modes qu'une routine
    // interrompue avait changés (ex. G91 d'un palpage raté).
    if (s.state === 'Alarm' && state === 'Idle' && this.restoreOnUnlock) {
      const lines = this.restoreOnUnlock;
      this.restoreOnUnlock = null;
      for (const l of lines) this.cmd(l, 'probe').catch(() => {});
      this.cmd('$G', 'sync').catch(() => {});
      this.log('info', `Modes rétablis après l'alarme : ${lines.join(' ')}`);
    }
    s.state = state;
    s.subState = sub ?? null;
    let mpos = null, wpos = null;
    s.pins = '';
    for (const f of parts.slice(1)) {
      const [k, v] = f.split(':');
      if (k === 'MPos') mpos = xyz(v);
      else if (k === 'WPos') wpos = xyz(v);
      else if (k === 'WCO') s.wco = xyz(v);
      else if (k === 'FS' || k === 'F') { const [f1, s1] = v.split(','); s.feed = Number(f1); s.speed = Number(s1 ?? 0); }
      else if (k === 'Ov') { const [a, b, c] = v.split(',').map(Number); s.ov = { feed: a, rapid: b, spindle: c }; }
      else if (k === 'Pn') s.pins = v;
      else if (k === 'Bf') { const [blocks, bytes] = v.split(',').map(Number); s.buffer = { blocks, bytes }; }
    }
    const sub3 = (a, b) => ({ X: a.X - b.X, Y: a.Y - b.Y, Z: a.Z - b.Z });
    const add3 = (a, b) => ({ X: a.X + b.X, Y: a.Y + b.Y, Z: a.Z + b.Z });
    if (mpos) { s.mpos = mpos; s.wpos = sub3(mpos, s.wco); }
    else if (wpos) { s.wpos = wpos; s.mpos = add3(wpos, s.wco); }
    // Reprise faite ailleurs (bouton de la machine, autre logiciel) : Grbl a
    // déjà rallumé la broche.
    if (this.spindleHeld && state !== 'Hold') this.spindleHeld = false;

    if (this.job?.state === 'finishing' && state === 'Idle' && !this.inflight.length) {
      this.job.state = 'done';
      this.job.finishedAt = Date.now();
      this.log('info', `Job terminé : ${this.job.name}`);
      this.emitJob();
    }
    const waiters = this.statusWaiters;
    this.statusWaiters = [];
    for (const w of waiters) w(s);
    this.emitState();
  }

  nextStatus(timeout = 2000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Pas de rapport d\'état')), timeout);
      this.statusWaiters.push((s) => { clearTimeout(t); resolve(s); });
    });
  }

  // ---- Envoi -----------------------------------------------------------

  // Envoie une ligne via la file. La promesse se résout au "ok" de Grbl.
  cmd(line, source = 'user') {
    return new Promise((resolve, reject) => {
      if (!this.transport) return reject(new Error('Non connecté'));
      this.queue.push({ line: line.trim(), resolve, reject, source });
      this.pump();
    });
  }

  // Retire de la file les lignes pas encore envoyées d'une source (ex. jogs
  // en attente au moment d'une annulation), pour qu'elles ne partent pas après.
  dropQueued(source) {
    const kept = [];
    for (const item of this.queue) {
      if (item.source === source) item.reject?.(new Error('Annulé'));
      else kept.push(item);
    }
    this.queue = kept;
  }

  // Attend que tous les mouvements planifiés soient exécutés.
  async sync() {
    await this.cmd('G4P0.01', 'sync');
    return this.nextStatus();
  }

  pump() {
    if (!this.transport || !this.ready) return;
    for (;;) {
      let item = this.queue[0];
      let fromJob = false;
      if (!item) {
        item = this.jobPeek();
        fromJob = true;
      }
      if (!item) break;
      const len = Buffer.byteLength(item.line) + 1;
      if (this.inflight.length && this.inflightBytes + len > RX_BUFFER) break;
      if (fromJob) this.jobTake(item);
      else this.queue.shift();
      this.inflight.push({ ...item, len });
      this.inflightBytes += len;
      this.writeRaw(item.line + '\n');
      if (['user', 'macro', 'probe'].includes(item.source)) this.log('tx', item.line);
    }
  }

  ack(code) {
    const item = this.inflight.shift();
    if (!item) return;
    this.inflightBytes -= item.len;
    if (code !== null) {
      const err = new GrblError(code, item.line);
      if (item.source !== 'sync') this.log('err', err.message);
      if (item.jobIndex !== undefined && this.job?.state === 'running') {
        this.job.state = 'paused';
        this.job.error = `Ligne ${item.jobIndex + 1} : ${err.message}`;
        this.realtime('hold');
        this.emitJob();
      }
      item.reject?.(err);
    } else {
      item.resolve?.();
    }
    if (item.jobIndex !== undefined && this.job) {
      this.job.acked = Math.max(this.job.acked, item.jobIndex + 1);
      this.jobProgress();
    }
    this.pump();
  }

  // ---- Jobs ------------------------------------------------------------

  loadJob(name, text) {
    if (this.job && ['running', 'paused', 'spinup', 'toolchange', 'finishing', 'stopping'].includes(this.job.state)) {
      throw new Error('Un job est en cours');
    }
    this.job = {
      name, text, lines: splitProgram(text), next: 0, acked: 0, startIndex: 0,
      prelude: [], state: 'loaded', error: null, startedAt: null, finishedAt: null, tool: null,
    };
    this.emit('job-loaded', this.job);
    this.emitJob();
  }

  runJob(from = 0, opts = {}) {
    const j = this.job;
    if (!j) throw new Error('Aucun job chargé');
    if (!this.ready) throw new Error('Machine non prête');
    if (['running', 'paused', 'spinup', 'toolchange', 'finishing', 'stopping'].includes(j.state)) throw new Error('Job déjà en cours');
    if (this.status.state !== 'Idle') throw new Error(`La machine doit être Idle (état : ${this.status.state})`);
    from = Math.max(0, Math.min(Math.floor(from), j.lines.length - 1));
    j.prelude = from > 0 ? buildResume(j.lines, from, opts).lines : [];
    if (from > 0) this.log('info', `Reprise à la ligne ${from + 1} : ${j.prelude.join(' | ')}`);
    j.next = from;
    j.acked = from;
    j.startIndex = from;
    j.state = 'running';
    j.error = null;
    j.toolChange = opts.toolChange !== false;
    j.startedAt = Date.now();
    j.finishedAt = null;
    this.emitJob();
    this.pump();
  }

  jobPeek() {
    const j = this.job;
    if (!j || j.state !== 'running') return null;
    if (j.prelude.length) return { line: j.prelude[0], source: 'job', prelude: true };
    if (j.next >= j.lines.length) return null;
    const line = j.lines[j.next];
    if (j.toolChange && TOOL_CHANGE_RE.test(line)) {
      if (j.waitingTool) return null;
      j.waitingTool = true;
      const tool = line.match(/T(\d+)/)?.[1] ?? this.modal.tool;
      // On attend que tout soit usiné avant de demander le changement.
      this.cmd('G4P0.01', 'sync').then(() => {
        if (j.state !== 'running') return;
        j.state = 'toolchange';
        j.tool = tool;
        this.log('info', `Changement d'outil demandé : T${tool}`);
        this.emitJob();
      }).catch(() => {}).finally(() => { j.waitingTool = false; });
      return null;
    }
    return { line, source: 'job', jobIndex: j.next };
  }

  jobTake(item) {
    if (item.prelude) this.job.prelude.shift();
    else this.job.next++;
  }

  jobProgress() {
    const j = this.job;
    if (j.state === 'running' && j.acked >= j.lines.length && !j.prelude.length) {
      j.state = 'finishing';
    }
    const now = Date.now();
    if (!this.lastJobEmit || now - this.lastJobEmit > 150 || j.state !== 'running') {
      this.lastJobEmit = now;
      this.emitJob();
    }
  }

  // Après un changement d'outil : on saute la ligne M6 et on continue.
  continueAfterToolChange() {
    const j = this.job;
    if (j?.state !== 'toolchange') throw new Error('Pas de changement d\'outil en attente');
    j.next++;
    j.acked = Math.max(j.acked, j.next);
    j.state = 'running';
    this.emitJob();
    this.pump();
  }

  pauseJob({ stopSpindle = false } = {}) {
    if (this.job?.state !== 'running') return;
    this.job.state = 'paused';
    this.realtime('hold');
    this.emitJob();
    if (stopSpindle) this.stopSpindleInPause().catch((e) => this.log('err', e.message));
  }

  // Coupe la broche pendant une pause. Grbl n'accepte « spindle stop » (0x9E)
  // qu'une fois le mouvement complètement arrêté (Hold:0) : on attend cet état.
  async stopSpindleInPause() {
    if (this.spindleHeld) return;
    const deadline = Date.now() + 8000;
    let s = this.status;
    while (!(s.state === 'Hold' && s.subState === '0')) {
      if (Date.now() > deadline || !['Hold', 'Run'].includes(s.state)) {
        throw new Error('Broche non coupée : la machine doit être en pause complète');
      }
      s = await this.nextStatus();
    }
    this.realtime('spindleStop');
    this.spindleHeld = true;
    this.log('info', 'Broche coupée pendant la pause');
    this.emitState();
    this.emitJob();
  }

  // Reprise après une pause (ou un M0). Si la broche a été coupée : rallumage,
  // attente de la montée en vitesse, puis seulement reprise du mouvement.
  async resumeJob({ spinUp = 3 } = {}) {
    const j = this.job;
    // Pause du programme (M0) ou porte de sécurité : Grbl attend un « ~ ».
    const programPause = j?.state === 'running' && ['Hold', 'Door'].includes(this.status.state);
    if (j?.state !== 'paused' && !programPause) return;
    if (this.spindleHeld) {
      j.state = 'spinup';
      j.spinUpUntil = Date.now() + spinUp * 1000;
      this.realtime('spindleStop'); // second appui : Grbl rallume la broche
      this.spindleHeld = false;
      this.log('info', `Broche rallumée, reprise dans ${spinUp} s`);
      this.emitState();
      this.emitJob();
      await new Promise((r) => setTimeout(r, spinUp * 1000));
      if (j.state !== 'spinup') return; // arrêté pendant l'attente
    }
    j.state = 'running';
    j.error = null;
    j.spinUpUntil = null;
    this.realtime('start');
    this.emitJob();
    this.pump();
  }

  // Arrêt propre : maintien d'avance, attente de l'arrêt complet, puis reset.
  // Un reset pendant un mouvement ferait perdre la position (alarme 3).
  async stopJob() {
    const j = this.job;
    if (!j || !['running', 'paused', 'spinup', 'toolchange', 'finishing'].includes(j.state)) return;
    j.state = 'stopping';
    this.emitJob();
    this.realtime('hold');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const s = await this.nextStatus().catch(() => this.status);
      if (s.state === 'Idle' || (s.state === 'Hold' && s.subState === '0')) break;
    }
    this.realtime('reset');
    j.state = 'stopped';
    this.log('info', 'Job arrêté');
    this.emitJob();
  }

  // ---- Diffusion -------------------------------------------------------

  snapshot() {
    return {
      connected: this.connected, port: this.portName, ready: this.ready, version: this.version,
      status: this.status, modal: this.modal, offsets: this.offsets,
      queue: this.queue.length, inflight: this.inflight.length, spindleHeld: this.spindleHeld,
    };
  }

  jobSnapshot() {
    const j = this.job;
    if (!j) return null;
    return {
      name: j.name, total: j.lines.length, acked: j.acked, sent: j.next, startIndex: j.startIndex,
      state: j.state, error: j.error, tool: j.tool, startedAt: j.startedAt, finishedAt: j.finishedAt,
      spinUpUntil: j.spinUpUntil ?? null, spindleHeld: this.spindleHeld,
    };
  }

  emitState() { this.emit('state', this.snapshot()); }
  emitJob() { this.emit('job', this.jobSnapshot()); }
  emitSettings() {
    clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(() => this.emit('settings', this.settings), 100);
  }
}
