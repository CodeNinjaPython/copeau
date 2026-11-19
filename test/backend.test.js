import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrblController } from '../server/grbl.js';
import { GrblSimulator } from '../server/simulator.js';
import { probeZ, probeCorner, probeCenter } from '../server/probe.js';
import { splitProgram, buildResume, analyze, arcPoints } from '../public/js/shared/gcode.js';

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

async function setup() {
  const c = new GrblController();
  const sim = new GrblSimulator({ speedup: 40 });
  c.attach(sim, 'sim');
  await new Promise((r) => { const t = setInterval(() => { if (c.ready) { clearInterval(t); r(); } }, 10); });
  await c.cmd('$X');
  await c.nextStatus();
  return { c, close: () => c.detach('fin') };
}

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout');
}

test('gcode : arcs et analyse', () => {
  const lines = splitProgram('G21 G90 (commentaire)\nG0 X0 Y0\nG1 Z-1 F100 ; plongée\nG2 X10 Y0 I5 J0\n%');
  assert.deepEqual(lines, ['G21G90', 'G0X0Y0', 'G1Z-1F100', 'G2X10Y0I5J0']);
  const a = analyze(lines);
  near(a.max.X, 10);
  near(a.min.Z, -1);
  const { pts, length } = arcPoints({ from: { X: 0, Y: 0, Z: 0 }, to: { X: 10, Y: 0, Z: 0 }, center: { X: 5, Y: 0 }, cw: true, plane: 17 });
  near(length, Math.PI * 5);
  assert.ok(pts.every((p) => p.Y >= -1e-9), 'G2 de gauche à droite passe par le haut');
});

test('reprise : préambule cohérent', () => {
  const lines = splitProgram('G21G90G55\nM3S12000\nG0Z5\nG0X10Y10\nG1Z-2F300\nG1X20F800\nG1Y20\n');
  const r = buildResume(lines, 6);
  assert.deepEqual(r.lines, ['G21', 'G90', 'G55', 'G17', 'G94', 'G0Z5', 'M3S12000', 'G4P3', 'G0X20Y10', 'G1Z-2F300', 'G1F800']);
});

test('job complet sur simulateur', async () => {
  const { c, close } = await setup();
  try {
    const prog = ['G21G90', 'G10L20P1X0Y0Z0', 'G0Z2', ...Array.from({ length: 60 }, (_, i) => `G1X${i % 2 ? 5 : 0}Y${i * 0.5}F6000`), 'G0Z5', 'M30'].join('\n');
    c.loadJob('test.nc', prog);
    c.runJob(0);
    await waitFor(() => c.job.state === 'done');
    near(c.status.wpos.Z, 5, 0.01);
    near(c.status.wpos.Y, 29.5, 0.01);
  } finally { close(); }
});

test('changement d\'outil met le job en attente', async () => {
  const { c, close } = await setup();
  try {
    c.loadJob('outil.nc', 'G21G90\nG0Z1\nT2M6\nG0Z3\n');
    c.runJob(0);
    await waitFor(() => c.job.state === 'toolchange');
    assert.equal(c.job.tool, '2');
    c.continueAfterToolChange();
    await waitFor(() => c.job.state === 'done');
  } finally { close(); }
});

test('erreur Grbl met le job en pause', async () => {
  const { c, close } = await setup();
  try {
    c.loadJob('err.nc', 'G21\nG1X5\nG0X1\n'); // G1 sans F -> error:22
    c.runJob(0);
    await waitFor(() => c.job.state === 'paused');
    assert.match(c.job.error, /error:22/);
  } finally { close(); }
});

test('palpage Z, coin et centre', async () => {
  const { c, close } = await setup();
  try {
    await c.cmd('G90G53G0X-140Y-130Z-40');
    await c.sync();
    await probeZ(c, { plate: 0 });
    await c.nextStatus();
    near(c.status.wco.Z, -50);

    await c.cmd('G90G53G0X-210Y-190Z-40');
    await c.sync();
    const r = await probeCorner(c, { corner: 'FL', toolDia: 6 });
    near(r.edgeX, -220);
    near(r.edgeY, -200);
    near(r.top, -50);
    await c.nextStatus();
    near(c.status.wco.X, -220);

    await c.cmd('G90G53G0X-165Y-147Z-60');
    await c.sync();
    const h = await probeCenter(c, { toolDia: 6 });
    near(h.center.X, -170);
    near(h.center.Y, -150);
    near(h.diameterX, 25, 0.05);
  } finally { close(); }
});

test('palpage sans contact : erreur et alarme', async () => {
  const { c, close } = await setup();
  try {
    await c.cmd('G90G53G0X-10Y-10Z-5');
    await c.sync();
    await assert.rejects(probeZ(c, { travel: 10 }), /Pas de contact/);
    await c.nextStatus();
    assert.equal(c.status.state, 'Alarm');
  } finally { close(); }
});

test('pause : broche coupée puis rallumée avant la reprise', async () => {
  const { c, close } = await setup();
  try {
    const prog = ['G21G90', 'M3S12000', 'G0Z1', ...Array.from({ length: 30 }, (_, i) => `G1X${i % 2 ? 20 : 0}Y${i}F300`), 'M5', 'M30'].join('\n');
    c.loadJob('broche.nc', prog);
    c.runJob(0);
    await waitFor(() => c.status.state === 'Run' && c.status.speed > 0);
    c.pauseJob({ stopSpindle: true });
    await waitFor(() => c.spindleHeld);
    await c.nextStatus();
    assert.equal(c.status.speed, 0, 'broche arrêtée pendant la pause');
    const resumed = c.resumeJob({ spinUp: 0.3 });
    assert.equal(c.job.state, 'spinup');
    await c.nextStatus();
    assert.equal(c.status.state, 'Hold', 'le mouvement attend la montée en vitesse');
    assert.ok(c.status.speed > 0, 'broche rallumée avant de bouger');
    await resumed;
    assert.equal(c.job.state, 'running');
    await waitFor(() => c.job.state === 'done', 30000);
  } finally { close(); }
});

test('palpage raté : G90 rétabli après déverrouillage', async () => {
  const { c, close } = await setup();
  try {
    await c.cmd('G90G53G0X-10Y-10Z-5');
    await c.sync();
    await assert.rejects(probeZ(c, { travel: 5 }), /Pas de contact/);
    await c.cmd('$X');
    await waitFor(() => c.status.state === 'Idle');
    await c.sync();
    await c.cmd('$G');
    assert.equal(c.modal.distance, 'G90', 'un G0 X10 ne doit pas devenir relatif');
  } finally { close(); }
});

test('reprise : hauteur de sécurité minimale avec dégagements G53', () => {
  const lines = splitProgram('G21G90\nG53G0Z0\nG0X10Y10\nG1Z-2F300\nG1X50F800\nG53G0Z0\nG0X10Y30\nG1Z-2F300\n');
  const r = buildResume(lines, 7, { minSafeZ: 5 });
  assert.equal(r.safeZ, 5);
  assert.equal(r.lines.find((l) => l.startsWith('G0Z')), 'G0Z5');
});

test('changement d\'outil : jog puis « Continuer » tout de suite, la broche repart', async () => {
  const { c, close } = await setup();
  try {
    const sim = c.transport;
    c.loadJob('outil.nc', 'G21G90\nM3S12000\nG0Z5\nM5\nT2M6\nM3S18000\nG0X10\nG1Z-1F300\nG1X20\n');
    c.runJob(0);
    await waitFor(() => c.job.state === 'toolchange');
    c.jogMove({ Z: 20 }, { relative: true, feed: 1000 }); // l'utilisateur remonte Z…
    await new Promise((r) => setTimeout(r, 30));
    c.continueAfterToolChange(); // … et clique « Continuer » pendant le jog
    await waitFor(() => ['done', 'paused', 'stopped'].includes(c.job.state));
    assert.equal(c.job.state, 'done', c.job.error);
    assert.equal(sim.st.spindle, 3, 'broche relancée');
    assert.equal(sim.st.speed, 18000);
    near(c.status.wpos.X, 20);
  } finally { close(); }
});

test('ligne refusée en alarme ou en jog (error:9) : arrêt et reprise proposée à cette ligne', async () => {
  const { c, close } = await setup();
  try {
    c.loadJob('err9.nc', ['G21G90', 'G0Z5', ...Array.from({ length: 40 }, (_, i) => `G1X${i % 2 ? 10 : 0}Y${i}F3000`)].join('\n'));
    c.runJob(0);
    await waitFor(() => c.job.acked > 3);
    const refused = c.inflight.find((i) => i.jobIndex !== undefined).jobIndex;
    c.handleLine('error:9'); // la carte refuse la plus ancienne ligne en vol
    await waitFor(() => c.job.state === 'stopped');
    assert.match(c.job.error, /error:9/);
    assert.match(c.job.error, /reprenez à la ligne/);
    assert.equal(c.job.resumeFrom, refused);
    assert.equal(c.jobSnapshot().resumeFrom, c.job.resumeFrom);
  } finally { close(); }
});

test('G-code envoyé pendant un jog : il attend la fin au lieu d\'être refusé', async () => {
  const { c, close } = await setup();
  try {
    const errors = [];
    c.on('log', (e) => { if (e.dir === 'err') errors.push(e.text); });
    c.jogMove({ X: 30 }, { relative: true, feed: 3000 });
    await c.cmd('G0Y5'); // console pendant le jog
    await c.sync();
    near(c.status.wpos.X, 30);
    near(c.status.wpos.Y, 5);
    c.jogMove({ X: 60 }, { relative: true, feed: 100 });
    await waitFor(() => c.status.state === 'Jog');
    await c.jogStop();
    const s = await c.nextStatus();
    assert.equal(s.state, 'Idle', 'jogStop rend la main une fois l\'arrêt fini');
    assert.deepEqual(errors, []);
  } finally { close(); }
});
