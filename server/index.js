import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { marked } from 'marked';
import { SerialPort } from 'serialport';
import { GrblController } from './grbl.js';
import { GrblSimulator } from './simulator.js';
import { routines } from './probe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8000);
// Par défaut seul cet ordinateur peut piloter la machine.
// HOST=0.0.0.0 pour y accéder depuis une tablette du réseau local.
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.COPEAU_DATA_DIR || path.join(root, 'data'));
const MACROS_FILE = path.join(DATA_DIR, 'macros.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SIMULATOR = 'simulateur';
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
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024 });

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
  try { return JSON.parse(await fs.readFile(MACROS_FILE, 'utf8')); }
  catch { return DEFAULT_MACROS; }
}
async function saveMacros(list) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(MACROS_FILE, JSON.stringify(list, null, 2));
}

// ---- Configuration partagée (plateau, zone de travail) ----------------------

let config = {};
try { config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')); } catch {}
const CONFIG_KEYS = ['zones'];

async function setConfig(key, value) {
  if (!CONFIG_KEYS.includes(key)) throw new Error(`Clé de configuration inconnue : ${key}`);
  config = { ...config, [key]: value };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  broadcast({ t: 'config', config });
}

// ---- Connexion -----------------------------------------------------------

async function listPorts() {
  const ports = await SerialPort.list().catch(() => []);
  return [
    { path: SIMULATOR, label: 'Simulateur Grbl (sans machine)' },
    ...ports
      .filter((p) => !/Bluetooth|debug-console/i.test(p.path))
      .map((p) => ({ path: p.path, label: [p.path, p.manufacturer].filter(Boolean).join(' · ') })),
  ];
}

function openTransport(portPath, baudRate) {
  if (portPath === SIMULATOR) return Promise.resolve(new GrblSimulator());
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });
    port.open((err) => (err ? reject(err) : resolve(port)));
  });
}

// ---- Messages clients ------------------------------------------------------

const jogDistance = 1000; // jog continu : coupé par jogCancel au relâchement
const AXIS_INDEX = { X: 0, Y: 1, Z: 2 };

// Distance d'un jog continu. Avec les limites logicielles ($20=1), Grbl refuse
// tout jog dont la cible sort du volume (error:15) : on vise alors juste avant
// la limite. Volume machine Grbl standard : de -$13x à 0 après prise d'origine.
function continuousDistance(axis, dir) {
  if (grbl.settings[20] !== '1') return dir * jogDistance;
  const travel = Number(grbl.settings[130 + AXIS_INDEX[axis]]);
  const pos = grbl.status.mpos[axis];
  if (!travel) return dir * jogDistance;
  const margin = 0.5;
  const d = dir > 0 ? 0 - margin - pos : -travel + margin - pos;
  return Math.sign(d) === dir ? d : 0;
}

let pathRun = null;

const handlers = {
  async ports() { return listPorts(); },

  async connect({ port, baud = 115200 }) {
    if (grbl.connected) grbl.detach('Changement de port');
    const transport = await openTransport(port, Number(baud));
    grbl.attach(transport, port);
  },

  async disconnect() { grbl.detach('Déconnecté par l\'utilisateur'); },

  async cmd({ line }) {
    for (const l of String(line).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      grbl.cmd(l).catch(() => {}); // l'erreur est déjà journalisée
    }
  },

  async realtime({ name }) { grbl.realtime(name); },

  async jog({ axes, feed, continuous }, ws) {
    const parts = Object.entries(axes)
      .filter(([a, v]) => a in AXIS_INDEX && Number(v))
      .map(([a, v]) => [a, continuous ? continuousDistance(a, Math.sign(v)) : Number(v)])
      .filter(([, d]) => Math.abs(d) >= 0.001)
      .map(([a, d]) => `${a}${d.toFixed(3)}`);
    if (!parts.length) {
      if (continuous) throw new Error('Limite logicielle atteinte dans cette direction');
      return;
    }
    if (continuous) ws.jogging = true;
    await grbl.cmd(`$J=G91G21${parts.join('')}F${Number(feed) || 1000}`, 'jog');
  },

  // Amène la tête en X/Y (repère travail), après une éventuelle montée en Z.
  // Tout passe en jog : interruptible par Échap / le bouton stop.
  async jogTo({ X, Y, liftZ, feed }) {
    const f = Number(feed) || 1000;
    if (![X, Y].every(Number.isFinite)) throw new Error('Cible invalide');
    if (liftZ !== null && liftZ !== undefined && grbl.status.wpos.Z < Number(liftZ)) {
      await grbl.cmd(`$J=G90G21Z${Number(liftZ).toFixed(3)}F${f}`, 'jog');
    }
    grbl.log('info', `Déplacement vers X${X} Y${Y}`);
    await grbl.cmd(`$J=G90G21X${X.toFixed(3)}Y${Y.toFixed(3)}F${f}`, 'jog');
  },

  // Parcourt une suite de points (repère travail) en jog, par exemple le contour
  // de la zone de travail. Les points partent un par un : un arrêt (Échap)
  // n'a ainsi au plus qu'une ligne en route à annuler.
  async jogPath({ points, liftZ, feed }) {
    if (pathRun) throw new Error('Un parcours est déjà en cours');
    if (!Array.isArray(points) || points.length < 2 || points.length > 400) throw new Error('Parcours invalide');
    if (!points.every((p) => Number.isFinite(p.X) && Number.isFinite(p.Y))) throw new Error('Parcours invalide');
    const f = Number(feed) || 1000;
    const run = (pathRun = { abort: false });
    try {
      if (liftZ !== null && liftZ !== undefined && grbl.status.wpos.Z < Number(liftZ)) {
        await grbl.cmd(`$J=G90G21Z${Number(liftZ).toFixed(3)}F${f}`, 'jog');
      }
      grbl.log('info', `Parcours du contour (${points.length} points)`);
      for (const p of points) {
        if (run.abort) break;
        await grbl.cmd(`$J=G90G21X${p.X.toFixed(3)}Y${p.Y.toFixed(3)}F${f}`, 'jog');
      }
    } finally {
      pathRun = null;
    }
    if (run.abort) grbl.realtime('jogCancel');
  },

  async jogStop(_, ws) {
    ws.jogging = false;
    if (pathRun) pathRun.abort = true;
    grbl.realtime('jogCancel');
  },

  async getConfig() { return config; },
  async setConfig({ key, value }) { await setConfig(key, value); },

  async load({ name, text }) { grbl.loadJob(String(name || 'programme.nc'), String(text)); },
  async run({ from = 0, toolChange = true, spinUp = 3 }) {
    grbl.runJob(Number(from), { toolChange, spinUpSeconds: Number(spinUp) });
  },
  async pause() { grbl.pauseJob(); },
  async resume() { grbl.resumeJob(); },
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
    grbl.log('info', `Macro : ${m.name}`);
    for (const l of m.gcode.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      grbl.cmd(l, 'macro').catch(() => {});
    }
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

  // Sécurité : un écran qui disparaît pendant un jog continu l'arrête.
  ws.on('close', () => { if (ws.jogging) grbl.realtime('jogCancel'); });
});

export function startServer({ port = PORT, host = HOST, threeAddonsDir } = {}) {
  if (threeAddonsDir) process.env.COPEAU_THREE_ADDONS_DIR = threeAddonsDir;
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
