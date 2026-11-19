import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { Preview } from '../public/js/preview.js';
import { splitProgram, createState, step, arcPoints, analyze } from '../public/js/shared/gcode.js';

// Visualiseur minimal : mêmes segments que viewer.load(), sans affichage.
function fakeViewer(lines) {
  const pos = [], segLine = [], segRapid = [], segFeed = [];
  const st = createState();
  lines.forEach((line, i) => {
    step(st, line, (seg) => {
      const push = (a, b) => { pos.push(a.X, a.Y, a.Z, b.X, b.Y, b.Z); segLine.push(i); segRapid.push(seg.kind === 'rapid' ? 1 : 0); segFeed.push(seg.feed || 0); };
      if (seg.kind === 'arc') { let prev = seg.from; for (const p of arcPoints(seg, 0.5).pts) { push(prev, p); prev = p; } }
      else push(seg.from, seg.to);
    });
  });
  const arr = Float32Array.from(pos);
  return {
    path: {}, scene: new THREE.Scene(), grid: { visible: true },
    segLine: Uint32Array.from(segLine), segRapid: Uint8Array.from(segRapid), segFeed: Float32Array.from(segFeed),
    segment: (s) => arr.subarray(s * 6, s * 6 + 6),
    setGhost(p) { this.ghost = p; }, setPreviewSeg(k) { this.previewSeg = k; }, render() {},
  };
}

const depthAt = (stock, x, y) => {
  const i = Math.round((x - stock.x0) / stock.cell), j = Math.round((y - stock.y0) / stock.cell);
  return stock.h[j * stock.nx + i];
};
const near = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test('simulation : la démo creuse aux bonnes profondeurs', () => {
  const lines = splitProgram(fs.readFileSync(new URL('../public/demo/copeau-demo.nc', import.meta.url), 'utf8'));
  const v = fakeViewer(lines);
  const p = new Preview(v);
  p.open({ rapidRate: 3000, toolDia: 6 });

  near(p.total, analyze(lines, { rapidRate: 3000 }).seconds, 0.5);

  p.seek(p.total);
  const s = p.stock;
  near(depthAt(s, 40, 0), -3);      // contour extérieur, 2e passe
  near(depthAt(s, 40, 25), -2);     // centre de la poche
  near(depthAt(s, 40 + 13, 25), -2); // bord de la poche (r 12 + rayon outil)
  near(depthAt(s, 8, 8), -4);       // perçage
  near(depthAt(s, 15, 25), 0);      // matière intacte (hors poche et contour)
  assert.equal(v.previewSeg, v.segLine.length);
  near(v.ghost.Z, 10);

  // Retour en arrière : avant la poche, le centre n'est pas encore creusé.
  p.seek(p.total * 0.25);
  near(depthAt(s, 40, 25), 0);
  near(depthAt(s, 40, 0), -1.5, 0.05);
});
