import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { GrblController } from '../server/grbl.js';
import { GrblSimulator, SmoothieSimulator } from '../server/simulator.js';
import { TcpTransport, parseHost } from '../server/tcp.js';
import { splitProgram, buildResume, createState, step, segPower } from '../public/js/shared/gcode.js';
import { rasterGcode, powerMap } from '../public/js/shared/raster.js';
import { laserSMax, PROFILES } from '../public/js/shared/profiles.js';

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout');
}

async function smoothie(opts = {}) {
  const c = new GrblController();
  const sim = new SmoothieSimulator({ speedup: 40, ...opts });
  const logs = [];
  c.on('log', (e) => logs.push(e));
  c.attach(sim, 'sim', { profile: 'emblaser2' });
  await waitFor(() => c.ready && c.version !== 'Smoothieware' && c.seekRate);
  await c.nextStatus();
  return { c, sim, logs, close: () => c.detach('fin') };
}

test('Smoothieware : connexion, identification, origine travail', async () => {
  const { c, sim, close } = await smoothie();
  try {
    assert.equal(c.version, 'edge-copeau-sim');
    assert.equal(c.feedHold, false, 'sans grbl_mode : pas de « ! »');
    assert.equal(c.seekRate, 4000);
    assert.equal(c.modal.wcs, 'G54');
    await c.cmd('G10L20P0X-10Y-20Z0'); // position actuelle = X-10 Y-20
    await c.nextStatus();
    await c.nextStatus();
    near(c.status.wpos.X, -10);
    near(c.status.wco.X, 10, 0.001);
    near(c.status.wco.Y, 20, 0.001);
    assert.equal(c.snapshot().laser, true);
    assert.equal(c.snapshot().firmware, 'smoothie');
    assert.deepEqual(sim.ignored, []);
  } finally { close(); }
});

test('Smoothieware : ancien format de rapport', () => {
  const c = new GrblController();
  c.profile = PROFILES.emblaser2;
  c.onStatus('<Run,MPos:12.5000,3.0000,0.0000,WPos:2.5000,1.0000,0.0000>');
  assert.equal(c.status.state, 'Run');
  near(c.status.wpos.X, 2.5);
  near(c.status.wco.X, 10);
  near(c.status.wco.Y, 2);
});

test('Smoothieware : job complet, laser selon S, aucune ligne perdue', async () => {
  const { c, sim, close } = await smoothie();
  try {
    const prog = ['G21G90', 'G0X0Y0', ...Array.from({ length: 50 }, (_, i) => `G1X${i % 2 ? 20 : 0}Y${i * 0.4}F6000S0.4`), 'G0X0Y0'].join('\n');
    c.loadJob('laser.nc', prog);
    c.runJob(0);
    await waitFor(() => c.status.state === 'Run' && c.status.laserPower > 0);
    near(c.status.laserPower, 40, 0.5);
    await waitFor(() => c.job.state === 'done');
    near(c.status.wpos.X, 0);
    near(c.status.wpos.Y, 0);
    assert.deepEqual(sim.ignored, []);
    assert.equal(c.inflight.length, 0);
  } finally { close(); }
});

test('Smoothieware : jog relatif en G0, mode absolu et vitesse des rapides rétablis', async () => {
  const { c, sim, close } = await smoothie();
  try {
    await c.jogMove({ X: 5, Y: -2 }, { relative: true, feed: 1500 });
    await c.jogMove({ X: 5 }, { relative: true, feed: 1500 });
    await c.sync();
    near(c.status.wpos.X, 10);
    near(c.status.wpos.Y, -2);
    assert.equal(sim.st.abs, true, 'G90 rétabli après le jog');
    assert.equal(sim.seekRate, 4000, 'default_seek_rate rétabli');
    await c.jogMove({ X: 1, Y: 1 }, { feed: 1500 }); // absolu
    await c.sync();
    near(c.status.wpos.X, 1);
    near(c.status.wpos.Y, 1);
    assert.deepEqual(sim.ignored, []);
  } finally { close(); }
});

test('Smoothieware : commandes de console sans « ok » ne décalent pas la file', async () => {
  const { c, sim, close } = await smoothie();
  try {
    await c.cmd('version');
    await c.cmd('$I');
    await c.cmd('$X'); // hors HALT : envoyé comme M999, qui répond toujours
    await c.cmd('$G');
    await c.sync();
    assert.equal(c.inflight.length, 0);
    await c.cmd('G0X3');
    await c.sync();
    near(c.status.wpos.X, 3);
    assert.deepEqual(sim.ignored, []);
  } finally { close(); }
});

test('Smoothieware : temps réel inconnu refusé (il corromprait la ligne suivante)', async () => {
  const { c, sim, close } = await smoothie();
  try {
    assert.throws(() => c.realtime('feedPlus10'), /Smoothieware/);
    assert.throws(() => c.realtime('jogCancel'), /Smoothieware/);
    assert.throws(() => c.realtime('hold'), /Smoothieware/);
    await c.cmd('G0X1');
    await c.sync();
    assert.deepEqual(sim.ignored, []);
  } finally { close(); }
});

test('Smoothieware : arrêter = HALT, M999, position et G90 conservés', async () => {
  const { c, sim, close } = await smoothie();
  try {
    const prog = ['G21G90', ...Array.from({ length: 60 }, (_, i) => `G1X${i % 2 ? 30 : 0}Y${i}F600S0.3`)].join('\n');
    c.loadJob('long.nc', prog);
    c.runJob(0);
    await waitFor(() => c.status.state === 'Run');
    await c.stopJob();
    await c.sync();
    assert.equal(c.job.state, 'stopped');
    assert.equal(c.status.state, 'Idle');
    assert.equal(sim.alarm, false);
    assert.equal(sim.st.abs, true);
    const at = { ...c.status.mpos };
    near(sim.mpos.X, at.X);
    await c.cmd('G0X0Y0');
    await c.sync();
    near(c.status.wpos.X, 0);
  } finally { close(); }
});

test('Smoothieware : erreur pendant un job = arrêt avec message de reprise', async () => {
  const { c, close } = await smoothie();
  try {
    c.loadJob('err.nc', 'G21G90\nG0X1\nG10L2P9X0\nG0X2\n'); // repère inexistant -> erreur
    c.runJob(0);
    await waitFor(() => c.job.state === 'stopped');
    assert.match(c.job.error, /Reprise/);
    await waitFor(() => c.status.state === 'Alarm');
    await c.cmd('$X');
    await waitFor(() => c.status.state === 'Idle');
  } finally { close(); }
});

test('Smoothieware sans feed hold : pause = plus aucune ligne envoyée, puis reprise', async () => {
  const { c, sim, close } = await smoothie();
  try {
    const prog = ['G21G90', ...Array.from({ length: 80 }, (_, i) => `G1X${i % 2 ? 10 : 0}Y${i * 0.2}F3000S0.2`)].join('\n');
    c.loadJob('pause.nc', prog);
    c.runJob(0);
    await waitFor(() => c.job.acked > 5);
    c.pauseJob();
    const sent = c.job.sent;
    await waitFor(() => c.status.state === 'Idle');
    assert.equal(c.job.sent, sent, 'plus rien n\'est envoyé');
    assert.equal(c.job.state, 'paused');
    await c.resumeJob();
    await waitFor(() => c.job.state === 'done', 20000);
    assert.deepEqual(sim.ignored, []);
  } finally { close(); }
});

test('Smoothieware en grbl_mode : pause immédiate (!) et reprise (~)', async () => {
  const { c, sim, close } = await smoothie({ grblMode: true });
  try {
    assert.equal(c.feedHold, true);
    const prog = ['G21G90', ...Array.from({ length: 40 }, (_, i) => `G1X${i % 2 ? 20 : 0}Y${i}F600S0.2`)].join('\n');
    c.loadJob('hold.nc', prog);
    c.runJob(0);
    await waitFor(() => c.status.state === 'Run');
    c.pauseJob();
    await waitFor(() => c.status.state === 'Hold');
    const p = { ...c.status.mpos };
    await c.nextStatus();
    await c.nextStatus();
    near(c.status.mpos.X, p.X, 0.001);
    await c.resumeJob();
    await waitFor(() => c.status.state === 'Run');
    await c.stopJob();
    assert.equal(c.job.state, 'stopped');
    await waitFor(() => c.status.state === 'Idle');
    assert.deepEqual(sim.ignored, []);
  } finally { close(); }
});

test('Smoothieware : tir de repérage (fire) et refus de démarrer tant qu\'il est allumé', async () => {
  const { c, sim, close } = await smoothie();
  try {
    await c.laserPointer(true, { power: 1.5 });
    await c.sync();
    assert.equal(sim.manualFire, 1.5);
    c.loadJob('t.nc', 'G0X1\n');
    assert.throws(() => c.runJob(0), /repérage/);
    await c.laserPointer(false);
    await c.sync();
    assert.equal(sim.manualFire, 0);
    assert.equal(c.pointer, null);
  } finally { close(); }
});

test('Laser Grbl : la pause ne touche pas au laser, tir de repérage en M3 G1', async () => {
  const c = new GrblController();
  const sim = new GrblSimulator({ speedup: 40, laser: true });
  c.attach(sim, 'sim', { profile: 'laser-grbl' });
  try {
    await waitFor(() => c.ready);
    await c.cmd('$X');
    await waitFor(() => c.settings[32] === '1');
    await c.nextStatus();
    assert.equal(laserSMax(c.profile, c.settings), 1000);
    await c.laserPointer(true, { power: 1, sMax: 1000 });
    await c.sync();
    assert.equal(sim.st.spindle, 3);
    assert.equal(sim.st.speed, 10);
    assert.equal(sim.st.motion, 1, 'mode G1 : Grbl allume le laser à l\'arrêt');
    await c.laserPointer(false);
    await c.sync();
    assert.equal(sim.st.spindle, 5);
    assert.equal(sim.st.motion, 0);
    const prog = ['G21G90', 'M4S0', ...Array.from({ length: 30 }, (_, i) => `G1X${i % 2 ? 20 : 0}Y${i}F600S500`), 'M5', 'M30'].join('\n');
    c.loadJob('laser.nc', prog);
    c.runJob(0);
    await waitFor(() => c.status.state === 'Run');
    c.pauseJob({ stopSpindle: true });
    await waitFor(() => c.status.state === 'Hold' && c.status.subState === '0');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(c.spindleHeld, false, 'pas de « spindle stop » en mode laser');
    await c.resumeJob({ spinUp: 3 });
    assert.equal(c.job.state, 'running', 'pas d\'attente de broche');
    await waitFor(() => c.job.state === 'done', 30000);
  } finally { c.detach('fin'); }
});

test('Laser Grbl : $32=0 signalé', async () => {
  const c = new GrblController();
  const sim = new GrblSimulator({ speedup: 40 });
  const logs = [];
  c.on('log', (e) => logs.push(e));
  c.attach(sim, 'sim', { profile: 'laser-grbl' });
  try {
    await waitFor(() => logs.some((l) => /\$32=0/.test(l.text)));
  } finally { c.detach('fin'); }
});

test('reprise laser : pas de Z de sécurité ni d\'attente, laser rallumé sur place', () => {
  const lines = splitProgram('G21G90\nM4S0\nG0X10Y10\nG1X20S600F1500\nG1X30S300\nG0X0Y20\nG1X40S700\n');
  const g = buildResume(lines, 5, { laser: true, firmware: 'grbl', minSafeZ: 5 });
  assert.deepEqual(g.lines, ['G21', 'G90', 'G54', 'G17', 'G94', 'M5', 'G0X30Y10', 'M4S300', 'G1F1500']);
  const sLines = splitProgram('G21G90\nG0X10Y10F6000\nG1X20S0.6F1500\nG1X30S0.3\nG0X0Y20\n');
  const s = buildResume(sLines, 4, { laser: true, firmware: 'smoothie' });
  assert.deepEqual(s.lines, ['G21', 'G90', 'G54', 'G17', 'G94', 'G0X30Y10', 'G1F1500S0.3']);
  // Z réglé par le programme (mise au point) : rétabli ; sinon on n'y touche pas.
  const zLines = splitProgram('G21G90\nG0Z3.5\nG0X10Y10\nM4S0\nG1X20S500F1500\nG1X30\n');
  assert.ok(buildResume(zLines, 5, { laser: true }).lines.includes('G0Z3.5'));
});

test('puissance des segments : M3/M4 pour Grbl, S seul pour Smoothieware', () => {
  const st = createState();
  for (const l of ['G1X1S500F100']) step(st, l);
  assert.equal(segPower(st, 'grbl'), 0, 'sans M3/M4 Grbl ne tire pas');
  assert.equal(segPower(st, 'smoothie'), 500);
  step(st, 'M4');
  assert.equal(segPower(st, 'grbl'), 500);
});

test('gravure d\'image : balayage aller-retour, puissance et marges', () => {
  const w = 4, h = 2;
  const gray = Uint8Array.from([0, 255, 255, 0, 255, 128, 255, 255]); // haut puis bas
  const r = rasterGcode({ gray, width: w, height: h }, { resolution: 2, powerMax: 100, powerMin: 0, overscan: 1, sMax: 1000 });
  const lines = r.text.trim().split('\n').filter((l) => !l.startsWith(';'));
  assert.equal(r.rows, 2);
  assert.equal(lines[0], 'G21G90');
  assert.equal(lines[1], 'M4S0');
  // Ligne du haut (y = 0.75), de gauche à droite : noir, blanc, noir.
  assert.deepEqual(lines.slice(2, 8), ['G0X-1Y0.75', 'G1X0S0F3000', 'G1X0.5S1000', 'G1X1.5S0', 'G1X2S1000', 'G1X3S0']);
  // Ligne du bas (y = 0.25), retour de droite à gauche : seul le gris.
  assert.deepEqual(lines.slice(8, 12), ['G0X2Y0.25', 'G1X1S0', 'G1X0.5S500', 'G1X-0.5S0']);
  assert.deepEqual(lines.slice(-2), ['M5S0', 'G0X0Y0']);
  assert.deepEqual(r.bounds, { minX: 0, minY: 0, maxX: 2, maxY: 1 });
});

test('gravure d\'image : Smoothieware en S 0-1 sans M3/M4, tramage tout ou rien', () => {
  const w = 8, h = 8;
  const gray = new Uint8Array(w * h).fill(160);
  const r = rasterGcode({ gray, width: w, height: h }, { firmware: 'smoothie', sMax: 1, mode: 'dither', powerMax: 60, overscan: 0 });
  assert.ok(!/M[345]/.test(r.text));
  const s = [...r.text.matchAll(/S([\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(s.every((v) => v === 0 || v === 0.6), 'tramage : 0 ou la puissance max');
  const on = powerMap(gray, w, h, { mode: 'dither', powerMax: 100, invert: false }).filter((p) => p > 0).length;
  near(on / (w * h), 1 - 160 / 255, 0.1);
  const t = powerMap(Uint8Array.from([100, 200]), 2, 1, { mode: 'threshold', threshold: 128, powerMax: 40 });
  assert.deepEqual([...t].map((v) => Math.round(v * 100)), [40, 0]);
});

test('réseau : adresse et port', () => {
  assert.deepEqual(parseHost('192.168.1.50'), { host: '192.168.1.50', port: 23 });
  assert.deepEqual(parseHost('emblaser.local:8080'), { host: 'emblaser.local', port: 8080 });
  assert.deepEqual(parseHost('telnet://10.0.0.2:23/'), { host: '10.0.0.2', port: 23 });
  assert.throws(() => parseHost(''), /manquante/);
});

test('réseau : connexion TCP à une console Smoothieware (telnet)', async () => {
  const server = net.createServer((sock) => {
    const sim = new SmoothieSimulator({ speedup: 40 });
    sock.write(Buffer.from([0xff, 0xfb, 0x01, 0xff, 0xfd, 0x03])); // négociation telnet
    sim.on('data', (d) => sock.write(d));
    sock.on('data', (d) => sim.write(d));
    sock.on('close', () => sim.close());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const c = new GrblController();
  try {
    const t = await TcpTransport.open(`127.0.0.1:${server.address().port}`);
    c.attach(t, 'reseau', { profile: 'emblaser2' });
    await waitFor(() => c.ready && c.seekRate);
    await c.cmd('G0X2');
    await c.sync();
    near(c.status.wpos.X, 2);
  } finally {
    c.detach('fin');
    server.close();
  }
});

test('Smoothieware : erreur de la console sans effet sur la file', async () => {
  const { c, sim, close } = await smoothie();
  try {
    await c.cmd('foo'); // commande inconnue : « error:Unsupported command - foo »
    const move = c.cmd('G0X4');
    await c.sync();
    await move; // ne doit pas être rejetée à la place de « foo »
    near(c.status.wpos.X, 4);
    assert.equal(c.inflight.length, 0);
    assert.deepEqual(sim.ignored, []);
  } finally { close(); }
});

test('Smoothieware : jog arrêté net, vitesse des G0 et G90 rétablis', async () => {
  const { c, sim, close } = await smoothie();
  try {
    c.jogMove({ X: 80 }, { relative: true, feed: 300 }).catch(() => {});
    await waitFor(() => c.status.state === 'Jog');
    near(c.status.feed, 300, 1); // vitesse jog, pas celle des rapides
    await c.jogStop();
    await c.sync();
    assert.equal(c.status.state, 'Idle');
    assert.equal(sim.seekRate, 4000);
    assert.equal(sim.st.abs, true);
    assert.ok(c.status.wpos.X < 79, 'arrêt avant la fin du jog');
  } finally { close(); }
});

test('Smoothieware : un jog absolu laisse le mode G91 choisi par l\'utilisateur', async () => {
  const { c, sim, close } = await smoothie();
  try {
    await c.cmd('G91');
    await c.jogMove({ X: 2, Y: 3 }, { feed: 2000 });
    await c.sync();
    near(c.status.wpos.X, 2);
    assert.equal(sim.st.abs, false, 'G91 rétabli');
    await c.cmd('G90');
    await c.jogMove({ X: 1 }, { relative: true, feed: 2000 });
    await c.sync();
    near(c.status.wpos.X, 3);
    assert.equal(sim.st.abs, true);
  } finally { close(); }
});

test('Laser Grbl : un reset éteint le tir de repérage', async () => {
  const c = new GrblController();
  const sim = new GrblSimulator({ speedup: 40, laser: true });
  c.attach(sim, 'sim', { profile: 'laser-grbl' });
  try {
    await waitFor(() => c.ready);
    await c.cmd('$X');
    await c.nextStatus();
    await c.laserPointer(true, { power: 1, sMax: 1000 });
    assert.ok(c.pointer);
    c.realtime('reset');
    assert.equal(c.pointer, null);
    await waitFor(() => c.ready);
    assert.equal(c.snapshot().pointer, null);
  } finally { c.detach('fin'); }
});

test('réseau : négociation telnet coupée entre deux paquets', () => {
  const t = new TcpTransport({ on() {} });
  const a = t.stripTelnet(Buffer.from([0x6f, 0x6b, 0xff]));
  const b = t.stripTelnet(Buffer.from([0xfb, 0x01, 0x0a, 0xff, 0xfa, 0x18, 0x00]));
  const c = t.stripTelnet(Buffer.from([0xff, 0xf0, 0x6f, 0x6b, 0xff, 0xff]));
  assert.equal(Buffer.concat([a, b, c]).toString('latin1'), 'ok\nok\xff');
});

test('gravure d\'image : S au millième quand S max est petit', () => {
  const gray = Uint8Array.from([0, 128, 255, 255]);
  const r = rasterGcode({ gray, width: 4, height: 1 }, { sMax: 1, powerMax: 100, overscan: 0 });
  assert.match(r.text, /S0\.5\b/);
});
