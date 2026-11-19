import { EventEmitter } from 'node:events';
import { splitProgram, buildResume, fmt } from '../public/js/shared/gcode.js';
import { profileOf, DEFAULT_PROFILE } from '../public/js/shared/profiles.js';
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

// Smoothieware (Emblaser 2) : seules ces commandes temps réel existent. Tout
// autre octet serait collé au début de la ligne suivante et la fausserait.
// « ! » et « ~ » n'existent que si la carte a enable_feed_hold (par défaut
// en grbl_mode).
const SMOOTHIE_REALTIME = new Set(['status', 'reset']);
const SMOOTHIE_HOLD = new Set(['hold', 'start']);
// Erreurs de la console Smoothieware, sans rapport avec une ligne G-code.
const SMOOTHIE_SHELL_ERRORS = /^error:\s*(Unsupported command - |bad axis|illegal option|no delta jog|axis out of range|unknown option|Not enough memory)/i;
// Vitesse des G0 quand le fichier config n'a pas de default_seek_rate.
const SMOOTHIE_DEFAULT_SEEK = 100;

// Messages d'arrêt de Smoothieware, traduits.
const SMOOTHIE_ALARMS = [
  [/^ALARM:\s*Abort during cycle/i, 'arrêt pendant un mouvement (Ctrl-X)'],
  [/^HALTED/i, 'machine arrêtée (HALT)'],
  [/Entering Alarm\/Halt state/i, 'erreur dans une ligne, la carte s\'est arrêtée (HALT)'],
  [/^ok Emergency Stop/i, 'arrêt d\'urgence demandé (M112)'],
  [/^ALARM:\s*(.*)$/i, null],
];

export class GrblError extends Error {
  constructor(code, line) {
    super(typeof code === 'number'
      ? `error:${code} ${errorText(code)} (${line})`
      : `Erreur de la carte : ${code} (${line})`);
    this.code = code;
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
    this.profile = profileOf(DEFAULT_PROFILE);
    this.reset();
  }

  get isSmoothie() { return this.profile.firmware === 'smoothie'; }
  // Pause immédiate possible (« ! ») ?
  get canHold() { return !this.isSmoothie || this.feedHold; }
  // Ligne qui ne reçoit son « ok » qu'une fois tous les mouvements terminés.
  // Smoothieware ignore un G4 de 0 ms (P en ms hors grbl_mode) : M400 attend.
  get syncLine() { return this.isSmoothie ? 'M400' : 'G4P0.01'; }

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
    this.rxSeen = false; // au moins une ligne reçue de la carte
    this.feedHold = false; // Smoothieware : « ! » / « ~ » acceptés
    this.grblMode = null; // Smoothieware : grbl_mode de la carte (M115)
    this.seekRate = null; // Smoothieware : default_seek_rate (vitesse des G0)
    this.skipOk = 0; // « ok » de bannière à ignorer
    this.expectHalt = false; // arrêt Ctrl-X voulu par Copeau
    this.motionSource = null; // origine du dernier mouvement envoyé (jog, job…)
    this.pointer = null; // tir de repérage laser en cours : { power }
    this.laserWarned = false;
    // Rapports d'état reçus depuis le dernier jog acquitté (voir jogSettled).
    this.statusSinceJog = Infinity;
  }

  get connected() { return !!this.transport; }

  // profile : identifiant de profil (cnc, laser-grbl, emblaser2…).
  attach(transport, portName, { profile } = {}) {
    this.reset();
    this.profile = profileOf(profile);
    this.transport = transport;
    this.portName = portName;
    this.status.state = 'Connexion';
    transport.on('data', (d) => this.onData(d));
    transport.on('close', () => this.detach('Port fermé'));
    transport.on('error', (e) => this.log('err', `Port : ${e.message}`));
    if (this.isSmoothie) {
      // Smoothieware n'envoie « Smoothie » qu'à l'ouverture de l'USB, et ne
      // redémarre pas : sans bannière (Wi-Fi, port déjà ouvert), on continue.
      this.bannerTimer = setTimeout(() => { if (!this.ready) this.onSmoothieReady(null); }, 700);
    } else {
      // Sans bannière (carte qui ne redémarre pas à l'ouverture), on force un reset.
      this.bannerTimer = setTimeout(() => { if (!this.ready) this.realtime('reset'); }, 2500);
    }
    this.silenceTimer = setTimeout(() => {
      if (this.isSmoothie && !this.rxSeen) {
        this.log('err', 'La carte ne répond pas : vérifiez le port (USB) ou l\'adresse réseau, et que LightBurn ou LaserGRBL sont fermés.');
      } else if (!this.isSmoothie && !this.ready) {
        this.log('err', 'La carte ne répond pas : vérifiez le port et la vitesse (115200 pour Grbl, parfois 250000). Une Emblaser 2 se choisit avec le profil « Emblaser 2 ».');
      }
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

  supportsRealtime(name) {
    if (!(name in REALTIME)) return false;
    if (!this.isSmoothie) return true;
    return SMOOTHIE_REALTIME.has(name) || (SMOOTHIE_HOLD.has(name) && this.feedHold);
  }

  realtime(name) {
    const byte = REALTIME[name];
    if (byte === undefined) throw new Error(`Commande temps réel inconnue : ${name}`);
    if (!this.supportsRealtime(name)) throw new Error(`Commande « ${name} » indisponible avec Smoothieware`);
    if (!this.transport) return;
    this.writeRaw(Buffer.from([byte]));
    if (name === 'reset') {
      // La carte vide son tampon de réception : toutes les lignes en vol sont perdues.
      // Grbl redémarre (nouvelle bannière) ; Smoothieware passe en HALT et
      // reste connecté.
      this.pointer = null; // le reset (Grbl) ou le HALT (Smoothieware) éteint le laser
      if (this.isSmoothie) {
        this.expectHalt = true;
        // Un jog interrompu a pu laisser G91 actif et la vitesse des G0 changée :
        // rétablis au déverrouillage.
        if (this.motionSource === 'jog') this.restoreOnUnlock = this.afterHaltLines();
      } else {
        this.ready = false;
      }
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
    this.rxSeen = true;
    // Invite « > » d'une console réseau (telnet) : on l'ignore.
    line = line.replace(/^(?:>\s*)+/, '');
    if (!line) return;
    if (line[0] === '<') return this.onStatus(line);
    if (this.isSmoothie && this.smoothieLine(line)) return;
    if (line === 'ok') return this.ack(null);
    let m;
    if ((m = line.match(/^error:(\d+)/))) return this.ack(Number(m[1]));
    this.log('rx', line);
    if ((m = line.match(/^ALARM:(\d+)/))) {
      const code = Number(m[1]);
      return this.onAlarm(`Alarme ${code} : ${alarmText(code)}`, code);
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
      // Sans mode laser, Grbl garde le laser allumé pendant les G0 et les arrêts.
      if (m[1] === '32' && this.profile.laser && m[2].trim() !== '1' && !this.laserWarned) {
        this.laserWarned = true;
        this.log('err', 'Mode laser désactivé ($32=0) : le laser resterait allumé pendant les déplacements rapides et les pauses. Envoyez $32=1 avant de graver.');
      }
      this.emitSettings();
    }
  }

  // Alarme : le job s'arrête, la machine attend $H ou un déverrouillage.
  onAlarm(text, code = null) {
    if (this.expectHalt) {
      this.expectHalt = false;
      this.log('info', `Carte arrêtée : ${text}`);
    } else {
      this.log('err', text);
    }
    this.status.state = 'Alarm';
    this.pointer = null;
    if (this.job && ['running', 'paused', 'spinup', 'toolchange', 'finishing'].includes(this.job.state)) {
      this.job.state = 'stopped';
      // Une erreur de ligne précède souvent l'alarme : on garde les deux.
      this.job.error = this.job.error ? `${this.job.error} · ${text}` : text;
      this.emitJob();
    }
    this.emit('alarm', code);
    this.emitState();
  }

  // Réponses propres à Smoothieware. Renvoie true si la ligne est traitée.
  smoothieLine(line) {
    let m;
    if (line === 'Smoothie') {
      // Bannière de l'USB, toujours suivie d'un « ok » qui ne répond à rien.
      this.skipOk = 1;
      this.log('rx', line);
      if (!this.ready) this.onSmoothieReady(line);
      return true;
    }
    if (/^ok\b/.test(line)) {
      if (this.skipOk) { this.skipOk--; return true; }
      // « ok - ignored », « ok C: X:… » (M114) : réponse à la ligne envoyée.
      if (line !== 'ok') this.log('rx', line);
      if (/^ok Emergency Stop/i.test(line)) this.onAlarm('Alarme : arrêt d\'urgence demandé (M112)');
      this.ack(null);
      return true;
    }
    this.skipOk = 0;
    // Machine en HALT : la ligne est refusée.
    if (line === '!!') {
      this.status.state = 'Alarm';
      this.ack('machine arrêtée (HALT), déverrouillez avant d\'envoyer des commandes');
      return true;
    }
    // Erreurs propres à la console (commande inconnue, $J mal formé) : la
    // commande partie sans être comptée n'attend pas de réponse.
    if (SMOOTHIE_SHELL_ERRORS.test(line)) {
      this.log('err', `Carte : ${line}`);
      return true;
    }
    if ((m = line.match(/^error:\s*(.*)$/i))) {
      this.ack(m[1] || 'inconnue');
      return true;
    }
    for (const [re, label] of SMOOTHIE_ALARMS) {
      if ((m = line.match(re))) {
        this.log('rx', line);
        this.onAlarm(`Alarme : ${label || m[1]}`);
        return true;
      }
    }
    if ((m = line.match(/^FIRMWARE_NAME:/))) {
      this.log('rx', line);
      const field = (k) => line.match(new RegExp(`${k}:([^,]*)`))?.[1]?.trim();
      this.version = field('FIRMWARE_VERSION') || this.version;
      this.grblMode = field('X-GRBL_MODE') === '1';
      // enable_feed_hold vaut par défaut grbl_mode.
      this.feedHold = this.grblMode;
      this.log('info', this.feedHold
        ? 'Smoothieware en grbl_mode : pause immédiate disponible (!/~).'
        : 'Smoothieware sans grbl_mode : la pause attend la fin des mouvements déjà envoyés.');
      this.emitState();
      return true;
    }
    if ((m = line.match(/default_seek_rate is set to\s*([\d.]+)/))) {
      this.seekRate = Number(m[1]) || null;
      return true;
    }
    if (/default_seek_rate is not in config/.test(line)) {
      this.seekRate = SMOOTHIE_DEFAULT_SEEK;
      return true;
    }
    return false;
  }

  // Smoothieware prêt (avec ou sans bannière) : identification et lectures.
  onSmoothieReady(banner) {
    clearTimeout(this.bannerTimer);
    this.ready = true;
    this.version = 'Smoothieware';
    this.log('info', `Connecté : Smoothieware${banner ? '' : ' (sans bannière)'}`);
    for (const q of ['M115', '$G', '$#']) this.cmd(q, 'query').catch(() => {});
    // Vitesse des G0 : les jogs la changent, Copeau la rétablit ensuite.
    this.cmd('config-get sd default_seek_rate', 'query').catch(() => {});
    this.emitState();
  }

  onBanner(line, version) {
    this.pointer = null;
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
    let body = line.replace(/^</, '').replace(/>$/, '');
    // Ancien format (Grbl 0.9, vieux Smoothieware) : <Idle,MPos:…,WPos:…>
    if (!body.includes('|')) body = body.replace(/,(?=[A-Za-z]+:)/g, '|');
    const parts = body.split('|');
    let [state, sub] = parts[0].split(':');
    const s = this.status;
    // Smoothieware n'a pas d'état Jog : un mouvement manuel s'affiche Run.
    if (this.isSmoothie && state === 'Run' && this.motionSource === 'jog' && !this.jobBusy()) state = 'Jog';
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
    if (this.isSmoothie) s.laserPower = 0;
    for (const f of parts.slice(1)) {
      const [k, v = ''] = f.split(':');
      if (k === 'MPos') mpos = xyz(v);
      else if (k === 'WPos') wpos = xyz(v);
      else if (k === 'WCO') s.wco = xyz(v);
      else if (this.isSmoothie && k === 'F') {
        // En mouvement : vitesse réelle, demandée, correction %. À l'arrêt :
        // vitesse demandée, correction %.
        const nums = v.split(',').map(Number);
        s.feed = state === 'Idle' ? 0 : nums[0] || 0;
        if (nums.length >= 2) s.ov = { ...s.ov, feed: Math.round(nums[nums.length - 1]) };
      }
      else if (this.isSmoothie && k === 'L') s.laserPower = Number(v) || 0; // % de la puissance max
      else if (this.isSmoothie && k === 'S') s.speed = Number(v) || 0;
      else if (k === 'FS' || k === 'F') { const [f1, s1] = v.split(','); s.feed = Number(f1); s.speed = Number(s1 ?? 0); }
      else if (k === 'Ov') { const [a, b, c] = v.split(',').map(Number); s.ov = { feed: a, rapid: b, spindle: c }; }
      else if (k === 'Pn') s.pins = v;
      else if (k === 'Bf') { const [blocks, bytes] = v.split(',').map(Number); s.buffer = { blocks, bytes }; }
    }
    const sub3 = (a, b) => ({ X: a.X - b.X, Y: a.Y - b.Y, Z: a.Z - b.Z });
    const add3 = (a, b) => ({ X: a.X + b.X, Y: a.Y + b.Y, Z: a.Z + b.Z });
    // Les deux positions (Smoothieware) donnent directement l'origine travail.
    // Chaque position est arrondie à 4 décimales : on ignore les écarts
    // d'arrondi pour que l'origine ne « tremble » pas pendant un mouvement.
    if (mpos && wpos) {
      s.mpos = mpos;
      s.wpos = wpos;
      const w = sub3(mpos, wpos);
      if (['X', 'Y', 'Z'].some((a) => Math.abs(w[a] - (s.wco?.[a] ?? Infinity)) > 0.002)) {
        s.wco = { X: Math.round(w.X * 1000) / 1000, Y: Math.round(w.Y * 1000) / 1000, Z: Math.round(w.Z * 1000) / 1000 };
      }
    }
    else if (mpos) { s.mpos = mpos; s.wpos = sub3(mpos, s.wco); }
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
    if (this.statusSinceJog < 10) this.statusSinceJog++;
    const waiters = this.statusWaiters;
    this.statusWaiters = [];
    for (const w of waiters) w(s);
    this.emitState();
    // Des lignes attendaient la fin d'un jog (voir pump).
    if (this.queue.length || this.job?.state === 'running') this.pump();
  }

  // Grbl refuse tout G-code pendant un jog (error:9, « G-code bloqué pendant
  // une alarme ou un jog »), même juste après le dernier « ok » du jog : la
  // tête bouge encore. Le jog est fini quand la carte ne dit plus Jog sur deux
  // rapports demandés après son acquittement. Smoothieware n'a pas ce verrou.
  jogSettled() {
    if (this.isSmoothie) return true;
    if (this.status.state === 'Jog') return false;
    if (this.inflight.some((i) => i.source === 'jog')) return false;
    return this.statusSinceJog >= 2;
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
    line = String(line).trim();
    if (this.isSmoothie) {
      // $X ne répond rien si la carte n'est pas en HALT : M999 répond toujours.
      if (/^\$X$/i.test(line)) line = 'M999';
      // Commandes de la console Smoothieware (minuscules : version, fire…),
      // $I et $J sans -R : aucun « ok » en retour. Comptées dans la file,
      // elles décaleraient tous les acquittements suivants.
      if (/^[a-z]/.test(line) || /^\$(I|S)/i.test(line) || (/^\$J/i.test(line) && !/\s-R\b/i.test(line))) {
        if (!this.transport) return Promise.reject(new Error('Non connecté'));
        this.writeRaw(line + '\n');
        if (!['query', 'sync'].includes(source)) this.log('tx', line);
        return Promise.resolve();
      }
    }
    return new Promise((resolve, reject) => {
      if (!this.transport) return reject(new Error('Non connecté'));
      this.queue.push({ line, resolve, reject, source });
      this.pump();
    });
  }

  // G90/G91 et G20/G21 envoyés : Grbl les rapporte avec $G, mais les jogs
  // Smoothieware en ont besoin tout de suite pour les rétablir.
  trackModal(line) {
    const up = line.toUpperCase();
    const d = up.match(/G9([01])(?!\d)(?![\d.]*\.)/g);
    if (d) this.modal.distance = d[d.length - 1];
    const u = up.match(/G2([01])(?!\d)/g);
    if (u) this.modal.units = u[u.length - 1];
  }

  jobBusy() {
    return ['running', 'paused', 'spinup', 'finishing', 'stopping', 'toolchange'].includes(this.job?.state);
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
    await this.cmd(this.syncLine, 'sync');
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
      // $J= et commandes $ passent ; le G-code (programme, console, macros,
      // palpage) attend que le jog soit vraiment terminé.
      if (item.line[0] !== '$' && !this.jogSettled()) break;
      const len = Buffer.byteLength(item.line) + 1;
      if (this.inflight.length && this.inflightBytes + len > RX_BUFFER) break;
      if (fromJob) this.jobTake(item);
      else this.queue.shift();
      this.inflight.push({ ...item, len });
      this.inflightBytes += len;
      if (!['sync', 'query', 'override', 'jogmode'].includes(item.source)) this.motionSource = item.source;
      if (!['jog', 'jogmode'].includes(item.source)) this.trackModal(item.line);
      this.writeRaw(item.line + '\n');
      if (['user', 'macro', 'probe'].includes(item.source)) this.log('tx', item.line);
    }
  }

  ack(code) {
    const item = this.inflight.shift();
    if (!item) return;
    this.inflightBytes -= item.len;
    if (item.source === 'jog') this.statusSinceJog = 0;
    if (code !== null) {
      const err = new GrblError(code, item.line);
      if (item.source !== 'sync' && item.source !== 'query') this.log('err', err.message);
      if (item.jobIndex !== undefined && this.job?.state === 'running') {
        this.job.error = `Ligne ${item.jobIndex + 1} : ${err.message}`;
        if (this.isSmoothie) {
          // Smoothieware s'arrête (HALT) et vide sa file : impossible de
          // continuer tel quel, il faudra reprendre à une ligne.
          this.job.state = 'stopped';
          this.job.resumeFrom = item.jobIndex;
          this.job.error += ' · Déverrouillez puis utilisez l\'onglet Reprise.';
        } else if (code === 9) {
          // Ligne refusée parce que la carte était en alarme ou en jog : elle
          // n'a pas été exécutée (souvent le M3 qui relance la broche). Une
          // simple reprise la sauterait et continuerait broche arrêtée : on
          // arrête et on propose de reprendre à cette ligne (broche relancée).
          const msg = `${this.job.error} · Ligne non exécutée : reprenez à la ligne ${item.jobIndex + 1} (onglet Reprise), la broche sera relancée.`;
          this.job.resumeFrom = item.jobIndex;
          this.stopJob().finally(() => { this.job.error = msg; this.emitJob(); });
          this.job.error = msg;
        } else {
          this.job.state = 'paused';
          this.realtime('hold');
        }
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
    if (this.pointer) throw new Error('Éteignez d\'abord le tir de repérage');
    from = Math.max(0, Math.min(Math.floor(from), j.lines.length - 1));
    j.resumeFrom = null;
    j.prelude = from > 0 ? buildResume(j.lines, from, { ...opts, laser: this.profile.laser, firmware: this.profile.firmware }).lines : [];
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
      this.cmd(this.syncLine, 'sync').then(() => {
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
    if (this.status.state === 'Alarm') throw new Error('Machine en alarme : déverrouillez ou faites l\'origine avant de continuer');
    if (!this.jogSettled()) this.log('info', 'Fin du déplacement en cours, puis reprise du programme');
    j.next++;
    j.acked = Math.max(j.acked, j.next);
    j.state = 'running';
    this.emitJob();
    this.pump();
  }

  pauseJob({ stopSpindle = false } = {}) {
    if (this.job?.state !== 'running') return;
    this.job.state = 'paused';
    if (this.canHold) {
      this.realtime('hold');
    } else {
      this.log('info', 'Pause : Copeau n\'envoie plus de lignes, la carte finit les mouvements déjà reçus puis s\'arrête (pause immédiate : enable_feed_hold dans la configuration Smoothieware).');
    }
    this.emitJob();
    // Laser : Grbl éteint le laser pendant une pause en mode laser
    // (DISABLE_LASER_DURING_HOLD). Un « spindle stop » le rallumerait.
    if (stopSpindle && !this.profile.laser) this.stopSpindleInPause().catch((e) => this.log('err', e.message));
  }

  // Coupe la broche pendant une pause. Grbl n'accepte « spindle stop » (0x9E)
  // qu'une fois le mouvement complètement arrêté (Hold:0) : on attend cet état.
  async stopSpindleInPause() {
    if (this.profile.laser) throw new Error('Laser : la carte éteint le laser pendant la pause');
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
    if (this.canHold) this.realtime('start');
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
    if (this.isSmoothie) {
      await this.haltMotion();
      j.state = 'stopped';
      this.log('info', 'Job arrêté');
      this.emitJob();
      return;
    }
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

  // Smoothieware : arrête tout mouvement et vide la file de la carte.
  // Avec la pause (feed hold), on ralentit d'abord ; sinon l'arrêt est
  // immédiat (Ctrl-X). La carte recale sa position sur les moteurs, puis M999
  // lève le HALT. Le laser s'éteint au HALT.
  async haltMotion() {
    if (this.canHold && ['Run', 'Jog', 'Hold'].includes(this.status.state)) {
      this.realtime('hold');
      const deadline = Date.now() + 4000;
      let prev = null;
      while (Date.now() < deadline) {
        const s = await this.nextStatus().catch(() => this.status);
        const here = `${s.mpos.X},${s.mpos.Y},${s.mpos.Z}`;
        if (s.state === 'Idle' || (s.state === 'Hold' && here === prev)) break;
        prev = here;
      }
    } else if (['Run', 'Jog'].includes(this.status.state)) {
      this.log('info', 'Arrêt immédiat (Smoothieware). Si la tête a pu sauter des pas, refaites l\'origine.');
    }
    this.realtime('reset');
    this.restoreOnUnlock = null; // rétablis juste après, ici
    // La carte vide son tampon à la prise en compte du Ctrl-X : un M999
    // envoyé trop tôt serait effacé avec lui.
    await delay(300);
    await this.cmd('M999', 'sync').catch(() => {});
    for (const l of this.afterHaltLines()) await this.cmd(l, 'sync').catch(() => {});
  }

  // Comme Grbl après un reset : déplacements absolus en mm, et vitesse des G0
  // d'origine (un jog interrompu a pu la laisser à la vitesse jog).
  afterHaltLines() {
    this.modal.distance = 'G90';
    this.modal.units = 'G21';
    return ['G90', 'G21', ...(this.seekRate ? [`G0F${fmt(this.seekRate)}`] : [])];
  }

  // Déplacement manuel, laser éteint. axes : { X: 10 } en mm, repère travail.
  // Grbl : $J= (annulable). Smoothieware : G0 (le laser ne tire jamais en G0),
  // avec le mode relatif rétabli juste après.
  jogMove(axes, { relative = false, feed = 1000 } = {}) {
    const words = Object.entries(axes)
      .filter(([a, v]) => ['X', 'Y', 'Z'].includes(a) && Number.isFinite(Number(v)))
      .map(([a, v]) => `${a}${Number(v).toFixed(3)}`).join('');
    if (!words) return Promise.resolve();
    const f = Math.max(1, Math.round(Number(feed) || 1000));
    if (!this.isSmoothie) return this.cmd(`$J=G${relative ? 91 : 90}G21${words}F${f}`, 'jog');
    // Une commande par ligne : un seul « ok » chacune, quel que soit ok_per_line.
    const { distance, units } = this.modal;
    const dist = relative ? 'G91' : 'G90';
    if (units !== 'G21') this.cmd('G21', 'jog').catch(() => {});
    this.cmd(dist, 'jog').catch(() => {});
    // F d'un G0 change la vitesse de tous les G0 suivants : seulement si on
    // connaît celle de la carte pour la rétablir.
    const move = this.cmd(`G0${words}${this.seekRate ? `F${f}` : ''}`, 'jog');
    // Lignes de rétablissement : jamais retirées par une annulation de jog.
    if (distance !== dist) this.cmd(distance, 'jogmode').catch(() => {});
    if (units !== 'G21') this.cmd(units, 'jogmode').catch(() => {});
    if (this.seekRate) this.cmd(`G0F${fmt(this.seekRate)}`, 'jogmode').catch(() => {});
    return move;
  }

  // Arrêt des déplacements manuels. gentle : finir le pas en cours (Smoothieware).
  async jogStop({ gentle = false } = {}) {
    if (!this.ready) return;
    this.dropQueued('jog');
    if (!this.isSmoothie) {
      this.realtime('jogCancel');
      await this.cmd('G4P0', 'sync').catch(() => {});
      return;
    }
    const moving = ['Run', 'Jog'].includes(this.status.state) && this.motionSource === 'jog' && !this.jobBusy();
    if (moving && !gentle) await this.haltMotion();
    else await this.cmd(this.syncLine, 'sync').catch(() => {});
  }

  // Tir de repérage : le laser s'allume à faible puissance, tête immobile,
  // pour voir où il tombe. power en % de la puissance max.
  async laserPointer(on, { power = 1, sMax = 1000 } = {}) {
    if (!this.profile.laser) throw new Error('Profil laser non choisi');
    if (!this.ready) throw new Error('Machine non prête');
    if (!on) {
      if (this.isSmoothie) await this.cmd('fire off');
      else { await this.cmd('M5'); await this.cmd('G0'); }
      this.pointer = null;
      this.log('info', 'Tir de repérage éteint');
      this.emitState();
      return;
    }
    if (this.jobBusy()) throw new Error('Usinage en cours');
    if (this.status.state !== 'Idle') throw new Error(`La machine doit être Prête (état : ${this.status.state})`);
    const pct = Math.max(0.1, Math.min(100, Number(power) || 1));
    if (this.isSmoothie) {
      // Mode manuel du module laser : reste allumé, même pendant un G0.
      await this.cmd(`fire ${fmt(pct)}`);
    } else {
      // Grbl en mode laser n'allume M3 à l'arrêt qu'en mode G1.
      await this.cmd('G1F1000');
      await this.cmd(`M3S${fmt((pct / 100) * sMax)}`);
    }
    this.pointer = { power: pct, since: Date.now() };
    this.log('info', `Tir de repérage à ${fmt(pct)} %`);
    this.emitState();
  }

  // ---- Diffusion -------------------------------------------------------

  snapshot() {
    return {
      connected: this.connected, port: this.portName, ready: this.ready, version: this.version,
      status: this.status, modal: this.modal, offsets: this.offsets,
      queue: this.queue.length, inflight: this.inflight.length, spindleHeld: this.spindleHeld,
      profile: this.profile.id, firmware: this.profile.firmware, laser: !!this.profile.laser,
      canHold: this.canHold, grblMode: this.grblMode, pointer: this.pointer,
    };
  }

  jobSnapshot() {
    const j = this.job;
    if (!j) return null;
    return {
      name: j.name, total: j.lines.length, acked: j.acked, sent: j.next, startIndex: j.startIndex,
      state: j.state, error: j.error, tool: j.tool, startedAt: j.startedAt, finishedAt: j.finishedAt,
      spinUpUntil: j.spinUpUntil ?? null, spindleHeld: this.spindleHeld, resumeFrom: j.resumeFrom ?? null,
    };
  }

  emitState() { this.emit('state', this.snapshot()); }
  emitJob() { this.emit('job', this.jobSnapshot()); }
  emitSettings() {
    clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(() => this.emit('settings', this.settings), 100);
  }
}
