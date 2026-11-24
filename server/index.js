import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { marked } from 'marked';
import { SerialPort } from 'serialport';
import { GrblController } from './grbl.js';
import { GrblSimulator, SmoothieSimulator } from './simulator.js';
import { TcpTransport } from './tcp.js';
import { routines } from './probe.js';
import { PROFILES, profileOf, laserSMax } from '../public/js/shared/profiles.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8000);
// Par défaut seul cet ordinateur peut piloter la machine.
// HOST=0.0.0.0 pour y accéder depuis une tablette du réseau local.
const HOST = process.env.HOST || '127.0.0.1';
// Dossier de données résolu à chaque usage, pas au chargement du module :
// l'application de bureau importe ce fichier avant de fixer COPEAU_DATA_DIR.
// Figé trop tôt, il pointait dans app.asar (lecture seule) -> ENOTDIR.
const dataDir = () => path.resolve(process.env.COPEAU_DATA_DIR || path.join(root, 'data'));
const macrosFile = () => path.join(dataDir(), 'macros.json');
const configFile = () => path.join(dataDir(), 'config.json');
const programFile = () => path.join(dataDir(), 'program.json');
const SIMULATOR = 'simulateur';
const NETWORK = 'reseau';
const THREE_DIR = path.join(root, 'node_modules/three');

const app = express();
app.use(express.static(path.join(root, 'public')));
app.use('/vendor/three', express.static(THREE_DIR));

// Manuel d'utilisation : docs/MANUEL.md rendu en HTML, lisible hors ligne.
// Les ancres suivent la convention GitHub pour que le sommaire marche partout.
const slug = (t) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
marked.use({
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
  },
});
app.get('/api/version', async (req, res) => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  res.json({ name: pkg.name, version: pkg.version });
});
app.get('/manuel', async (req, res) => {
  const md = await fs.readFile(path.join(root, 'docs/MANUEL.md'), 'utf8');
  res.type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Manuel Copeau</title>
<link rel="stylesheet" href="/css/manuel.css"></head><body>
<nav class="top"><a href="/">← Retour à Copeau</a><a href="/?tour=0">Lancer la démo guidée</a></nav>
<main>${marked.parse(md)}</main></body></html>`);
});
app.use('/vendor/three/examples/jsm', (req, res, next) => {
  const addonsDir = process.env.COPEAU_THREE_ADDONS_DIR || path.join(THREE_DIR, 'examples/jsm');
  express.static(addonsDir)(req, res, next);
});
const server = http.createServer(app);

// Le canal WebSocket pilote la machine : on refuse les pages d'autres sites.
// Un navigateur envoie toujours l'en-tête Origin ; il doit correspondre à
// l'adresse de Copeau. L'hôte doit être localhost ou une adresse IP : un nom
// de domaine signalerait une attaque par « DNS rebinding ».
function allowedClient(req) {
  const host = req.headers.host || '';
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const ipLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
  // Noms .local (mDNS du réseau local, ex. mon-mac.local) : pas de rebinding possible.
  if (hostname !== 'localhost' && !hostname.endsWith('.local') && !ipLiteral) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // outil local sans navigateur (tests, scripts)
  try { return new URL(origin).host === host; } catch { return false; }
}
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024 * 1024,
  verifyClient: ({ req }) => allowedClient(req),
});

const grbl = new GrblController();
const logHistory = [];

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(text);
}

grbl.on('state', (s) => broadcast({ t: 'state', s }));
grbl.on('job', (j) => broadcast({ t: 'job', j }));
grbl.on('job-loaded', (j) => broadcast({ t: 'job-text', name: j.name, text: j.text }));
grbl.on('settings', (s) => broadcast({ t: 'settings', s }));
grbl.on('log', (entry) => {
  logHistory.push(entry);
  if (logHistory.length > 500) logHistory.shift();
  broadcast({ t: 'log', entry });
});

// ---- Macros --------------------------------------------------------------

const DEFAULT_MACROS = [
  { id: 'park', name: 'Garer (Z haut, X0 Y0)', gcode: 'G90 G53 G0 Z-2\nG90 G0 X0 Y0' },
  { id: 'spindle-warmup', name: 'Chauffe broche 2 min', gcode: 'M3 S8000\nG4 P60\nM3 S16000\nG4 P60\nM5' },
];

async function loadMacros() {
  try { return JSON.parse(await fs.readFile(macrosFile(), 'utf8')); }
  catch { return DEFAULT_MACROS; }
}
async function saveMacros(list) {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(macrosFile(), JSON.stringify(list, null, 2));
}

// ---- Configuration partagée (plateau, zone de travail) ----------------------

let config = {};
async function loadConfig() {
  try { config = JSON.parse(await fs.readFile(configFile(), 'utf8')); } catch { config = {}; }
}
// zones : plateau et zone de travail. machine : { profile, host, sMax }.
const CONFIG_KEYS = ['zones', 'machine'];

async function setConfig(key, value) {
  if (!CONFIG_KEYS.includes(key)) throw new Error(`Clé de configuration inconnue : ${key}`);
  config = { ...config, [key]: value };
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(configFile(), JSON.stringify(config, null, 2));
  broadcast({ t: 'config', config });
}

// ---- Connexion -----------------------------------------------------------

async function listPorts() {
  const ports = await SerialPort.list().catch(() => []);
  return [
    { path: SIMULATOR, label: 'Simulateur (sans machine)' },
    { path: NETWORK, label: 'Réseau (Wi-Fi / Ethernet)…' },
    ...ports
      .filter((p) => !/Bluetooth|debug-console/i.test(p.path))
      .map((p) => ({ path: p.path, label: [p.path, p.manufacturer].filter(Boolean).join(' · ') })),
  ];
}

// Le simulateur parle le dialecte du profil choisi (Grbl ou Smoothieware).
function openTransport(portPath, baudRate, { profile, host } = {}) {
  if (portPath === SIMULATOR) {
    const p = profileOf(profile);
    return Promise.resolve(p.firmware === 'smoothie' ? new SmoothieSimulator() : new GrblSimulator({ laser: p.laser }));
  }
  if (portPath === NETWORK) return TcpTransport.open(host);
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });
    port.open((err) => (err ? reject(err) : resolve(port)));
  });
}

// ---- Messages clients ------------------------------------------------------

const AXIS_INDEX = { X: 0, Y: 1, Z: 2 };

let pathRun = null;

// Pendant un usinage (ou sa pause), une ligne envoyée passerait avant la suite
// du programme et s'insérerait au milieu. Seules les lectures sont permises.
// Au changement d'outil, la machine est à l'arrêt : tout est permis.
const READ_ONLY = /^\$(G|#|I|\$)$/;
function guardJobLines(lines) {
  const busy = ['running', 'paused', 'spinup', 'finishing', 'stopping'].includes(grbl.job?.state);
  if (busy && lines.some((l) => !READ_ONLY.test(l.toUpperCase()))) {
    throw new Error('Usinage en cours : commande refusée. Utilisez Pause, Arrêter ou les corrections en direct.');
  }
}

// ---- Laser : tir de repérage ---------------------------------------------------
// Éteint tout seul au bout de POINTER_MAX_MS, ou si l'écran qui l'a allumé se
// déconnecte.

const POINTER_MAX_MS = 60000;
let pointerTimer = null;
let pointerOwner = null;

function machineConfig() {
  return { profile: 'cnc', host: '', sMax: null, ...(config.machine || {}) };
}
const currentSMax = () => machineConfig().sMax > 0 ? machineConfig().sMax : laserSMax(grbl.profile, grbl.settings);

async function pointerOff(reason) {
  clearTimeout(pointerTimer);
  pointerTimer = null;
  pointerOwner = null;
  if (!grbl.pointer) return;
  // Une carte qui ne répond plus ne doit pas bloquer la déconnexion.
  const timeout = new Promise((resolve) => setTimeout(resolve, 1500));
  await Promise.race([grbl.laserPointer(false).catch((e) => grbl.log('err', e.message)), timeout]);
  if (reason) grbl.log('info', reason);
}

// Smoothieware : corrections par G-code. M220 = avance, M221 = puissance laser.
// Elles passent devant les lignes du programme et s'appliquent aussitôt.
const SMOOTHIE_OVERRIDES = {
  feed100: ['M220', 'feed', () => 100], feedPlus10: ['M220', 'feed', (v) => v + 10], feedMinus10: ['M220', 'feed', (v) => v - 10],
  feedPlus1: ['M220', 'feed', (v) => v + 1], feedMinus1: ['M220', 'feed', (v) => v - 1],
  spindle100: ['M221', 'spindle', () => 100], spindlePlus10: ['M221', 'spindle', (v) => v + 10], spindleMinus10: ['M221', 'spindle', (v) => v - 10],
  spindlePlus1: ['M221', 'spindle', (v) => v + 1], spindleMinus1: ['M221', 'spindle', (v) => v - 1],
};

const handlers = {
  async ports() { return listPorts(); },
  async profiles() { return Object.values(PROFILES); },

  async connect({ port, baud = 115200, profile, host }) {
    if (grbl.connected) grbl.detach('Changement de port');
    const machine = { ...machineConfig(), ...(profile ? { profile: profileOf(profile).id } : {}), ...(port === NETWORK ? { host: String(host || '') } : {}) };
    const transport = await openTransport(port, Number(baud), machine);
    grbl.attach(transport, port === NETWORK ? `${port}:${machine.host}` : port, { profile: machine.profile });
    if (JSON.stringify(machine) !== JSON.stringify(machineConfig())) await setConfig('machine', machine).catch(() => {});
  },

  async disconnect() { await pointerOff(); grbl.detach('Déconnecté par l\'utilisateur'); },

  async laserPointer({ on, power }, ws) {
    if (!on) return pointerOff();
    await grbl.laserPointer(true, { power: Number(power), sMax: currentSMax() });
    clearTimeout(pointerTimer);
    pointerOwner = ws;
    pointerTimer = setTimeout(() => pointerOff(`Tir de repérage éteint automatiquement après ${POINTER_MAX_MS / 1000} s`), POINTER_MAX_MS);
  },

  async cmd({ line }) {
    const lines = String(line).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    guardJobLines(lines);
    for (const l of lines) grbl.cmd(l).catch(() => {}); // l'erreur est déjà journalisée
  },

  async realtime({ name }) {
    const ov = grbl.isSmoothie && SMOOTHIE_OVERRIDES[name];
    if (ov) {
      const [code, key, next] = ov;
      if (!grbl.ready) throw new Error('Machine non prête');
      const cur = key === 'feed' ? grbl.status.ov?.feed ?? 100 : grbl.status.ov?.spindle ?? 100;
      const pct = Math.max(10, Math.min(200, Math.round(next(cur))));
      grbl.status.ov = { ...grbl.status.ov, [key]: pct };
      await grbl.cmd(`${code}S${pct}`, 'override');
      grbl.emitState();
      return;
    }
    grbl.realtime(name);
  },

  async jog({ axes, feed }) {
    const moves = Object.fromEntries(Object.entries(axes)
      .filter(([a, v]) => a in AXIS_INDEX && Math.abs(Number(v)) >= 0.001));
    if (!Object.keys(moves).length) return;
    await grbl.jogMove(moves, { relative: true, feed: Number(feed) || 1000 });
  },

  // Amène la tête en X/Y (repère travail), après une éventuelle montée en Z.
  // Tout passe en jog : interruptible par Échap / le bouton stop.
  // Retour au zéro établi : montée au Z de survol si besoin, X0 Y0, puis
  // descente lente jusqu'à Z0. Tout en jog : Échap annule toute la séquence.
  // Ramène un seul axe à 0 (repère travail), en jog. En descente, Z va lentement.
  async axisToZero({ axis, feed, plungeFeed }) {
    if (!['X', 'Y', 'Z'].includes(axis)) throw new Error('Axe invalide');
    let f = Number(feed) || 1000;
    if (axis === 'Z' && grbl.status.wpos.Z > 0) f = Math.min(f, Number(plungeFeed) || 300);
    grbl.log('info', `Retour de ${axis} à l'origine`);
    await grbl.jogMove({ [axis]: 0 }, { feed: f });
  },

  async gotoOrigin({ liftZ, feed, plungeFeed }) {
    const f = Number(feed) || 1000;
    const pf = Math.min(f, Number(plungeFeed) || 300);
    const lift = Number(liftZ);
    if (liftZ !== null && liftZ !== undefined && Number.isFinite(lift) && grbl.status.wpos.Z < lift) {
      await grbl.jogMove({ Z: lift }, { feed: f });
    }
    grbl.log('info', 'Retour à l\'origine X0 Y0 Z0');
    await grbl.jogMove({ X: 0, Y: 0 }, { feed: f });
    await grbl.jogMove({ Z: 0 }, { feed: pf });
  },

  async jogTo({ X, Y, liftZ, feed }) {
    const f = Number(feed) || 1000;
    if (![X, Y].every(Number.isFinite)) throw new Error('Cible invalide');
    if (liftZ !== null && liftZ !== undefined && grbl.status.wpos.Z < Number(liftZ)) {
      await grbl.jogMove({ Z: Number(liftZ) }, { feed: f });
    }
    grbl.log('info', `Déplacement vers X${X} Y${Y}`);
    await grbl.jogMove({ X, Y }, { feed: f });
  },

  // Parcourt une suite de points (repère travail) en jog, par exemple le contour
  // de la zone de travail. Les points partent un par un : un arrêt (Échap)
  // n'a ainsi au plus qu'une ligne en route à annuler.
  // pointer : % du tir de repérage gardé allumé pendant le parcours (cadre
  // d'un job laser). Seul Smoothieware le garde en G0 ; Grbl l'éteint en jog.
  async jogPath({ points, liftZ, feed, pointer }) {
    if (pathRun) throw new Error('Un parcours est déjà en cours');
    if (!Array.isArray(points) || points.length < 2 || points.length > 400) throw new Error('Parcours invalide');
    if (!points.every((p) => Number.isFinite(p.X) && Number.isFinite(p.Y))) throw new Error('Parcours invalide');
    const f = Number(feed) || 1000;
    const withPointer = Number(pointer) > 0 && grbl.isSmoothie && !grbl.pointer;
    if (withPointer) await grbl.laserPointer(true, { power: Number(pointer), sMax: currentSMax() });
    const run = (pathRun = { abort: false });
    try {
      if (liftZ !== null && liftZ !== undefined && grbl.status.wpos.Z < Number(liftZ)) {
        await grbl.jogMove({ Z: Number(liftZ) }, { feed: f });
      }
      grbl.log('info', `Parcours du contour (${points.length} points)`);
      for (const p of points) {
        if (run.abort) break;
        await grbl.jogMove({ X: p.X, Y: p.Y }, { feed: f });
      }
      // Le pointeur reste allumé jusqu'à la fin réelle du mouvement.
      if (withPointer && !run.abort) await grbl.cmd(grbl.syncLine, 'sync');
    } finally {
      pathRun = null;
      if (withPointer) await grbl.laserPointer(false).catch(() => {});
    }
    if (run.abort) await grbl.jogStop();
  },

  // Annulation du jog. Comme le recommande la doc Grbl, un G4P0 suit
  // l'annulation : son « ok » arrive une fois l'arrêt terminé, la position
  // lue ensuite est donc la position finale.
  // gentle (relâchement d'un jog maintenu) : avec Smoothieware, qui ne sait
  // pas annuler un mouvement en douceur, on finit le pas en cours.
  async jogStop({ gentle = false } = {}) {
    if (pathRun) pathRun.abort = true;
    await grbl.jogStop({ gentle: !!gentle });
  },

  async getConfig() { return config; },
  async setConfig({ key, value }) { await setConfig(key, value); },

  async load({ name, text }) {
    const program = { name: String(name || 'programme.nc'), text: String(text) };
    grbl.loadJob(program.name, program.text);
    try {
      await fs.mkdir(dataDir(), { recursive: true });
      await fs.writeFile(programFile(), JSON.stringify(program));
    } catch (e) { grbl.log('err', `Programme non conservé pour le prochain démarrage : ${e.message}`); }
  },
  async run({ from = 0, toolChange = true, spinUp = 3, safeZ = 5 }) {
    grbl.runJob(Number(from), { toolChange, spinUpSeconds: Number(spinUp), minSafeZ: Number(safeZ) });
  },
  async pause({ stopSpindle = false }) { grbl.pauseJob({ stopSpindle: !!stopSpindle }); },
  async resume({ spinUp = 3 }) {
    const s = Math.max(0, Math.min(30, Number(spinUp) || 0));
    grbl.resumeJob({ spinUp: s }).catch((e) => grbl.log('err', e.message));
  },
  async spindleStop() { await grbl.stopSpindleInPause(); },
  async stop() { await grbl.stopJob(); },
  async toolDone() { grbl.continueAfterToolChange(); },

  async probe({ kind, params = {} }) {
    const fn = routines[kind];
    if (!fn) throw new Error(`Palpage inconnu : ${kind}`);
    const res = await fn(grbl, params);
    grbl.log('info', res.message);
    return res;
  },

  async macros() { return loadMacros(); },
  async saveMacros({ list }) {
    if (!Array.isArray(list)) throw new Error('Liste de macros invalide');
    await saveMacros(list);
    broadcast({ t: 'macros', list });
  },
  async runMacro({ id }) {
    const m = (await loadMacros()).find((x) => x.id === id);
    if (!m) throw new Error('Macro introuvable');
    const lines = m.gcode.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    guardJobLines(lines);
    grbl.log('info', `Macro : ${m.name}`);
    for (const l of lines) grbl.cmd(l, 'macro').catch(() => {});
  },
};

wss.on('connection', (ws) => {
  const send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  send({ t: 'state', s: grbl.snapshot() });
  send({ t: 'settings', s: grbl.settings });
  send({ t: 'logs', list: logHistory });
  send({ t: 'config', config });
  if (grbl.job) send({ t: 'job-text', name: grbl.job.name, text: grbl.job.text });
  send({ t: 'job', j: grbl.jobSnapshot() });

  ws.on('close', () => {
    if (pointerOwner === ws) pointerOff('Tir de repérage éteint : écran déconnecté');
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const fn = handlers[msg.t];
    if (!fn) return send({ t: 'reply', id: msg.id, ok: false, error: `Message inconnu : ${msg.t}` });
    try {
      const result = await fn(msg, ws);
      send({ t: 'reply', id: msg.id, ok: true, result });
    } catch (e) {
      send({ t: 'reply', id: msg.id, ok: false, error: e.message });
    }
  });
});

export async function startServer({ port = PORT, host = HOST, threeAddonsDir, dataDir: dir } = {}) {
  if (threeAddonsDir) process.env.COPEAU_THREE_ADDONS_DIR = threeAddonsDir;
  if (dir) process.env.COPEAU_DATA_DIR = dir;
  await loadConfig();
  // Le programme chargé avant la fermeture reste chargé, jamais relancé.
  try {
    const saved = JSON.parse(await fs.readFile(programFile(), 'utf8'));
    if (typeof saved.name === 'string' && typeof saved.text === 'string') grbl.loadJob(saved.name, saved.text);
  } catch { /* aucun programme enregistré */ }
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const where = host === '0.0.0.0' ? `http://<ip-de-cet-ordinateur>:${actualPort}` : `http://localhost:${actualPort}`;
      console.log(`Copeau prêt : ${where}`);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function stopServer() {
  await pointerOff();
  if (grbl.connected) grbl.detach('Application fermée');
  for (const ws of wss.clients) ws.terminate();
  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startServer();
}
