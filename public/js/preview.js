import * as THREE from 'three';

// Simulation d'usinage dans le navigateur : un outil fantôme suit le parcours à
// la vitesse programmée et creuse une carte de hauteur (fraise droite).
// Rien n'est envoyé à la machine.

const MAX_CELLS = 360; // résolution max de la matière par côté

// Matière : bloc dont le dessus est à Z0 (repère travail), représenté par une
// grille de hauteurs. Chaque passage d'outil abaisse les cellules sous la fraise.
class Stock {
  constructor(bounds, toolR, bottom) {
    const margin = toolR + 4;
    this.x0 = bounds.minX - margin;
    this.y0 = bounds.minY - margin;
    const w = bounds.maxX - bounds.minX + 2 * margin;
    const h = bounds.maxY - bounds.minY + 2 * margin;
    this.cell = Math.max(w / MAX_CELLS, h / MAX_CELLS, 0.2);
    this.nx = Math.ceil(w / this.cell) + 1;
    this.ny = Math.ceil(h / this.cell) + 1;
    this.top = 0;
    this.bottom = bottom;
    this.r = toolR;
    this.h = new Float32Array(this.nx * this.ny).fill(this.top);
    this.dirty = true;

    const pos = new Float32Array(this.nx * this.ny * 3);
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const k = (j * this.nx + i) * 3;
        pos[k] = this.x0 + i * this.cell;
        pos[k + 1] = this.y0 + j * this.cell;
        pos[k + 2] = this.top;
      }
    }
    const index = [];
    for (let j = 0; j < this.ny - 1; j++) {
      for (let i = 0; i < this.nx - 1; i++) {
        const a = j * this.nx + i, b = a + 1, c = a + this.nx, d = c + 1;
        index.push(a, b, d, a, d, c);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setIndex(index);
    this.mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
      color: 0xc9a173, roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }));

    // Flancs et fond du bloc, pour lire l'épaisseur.
    const depth = this.top - bottom;
    const box = new THREE.BoxGeometry((this.nx - 1) * this.cell, (this.ny - 1) * this.cell, depth);
    this.block = new THREE.Mesh(box, new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.95, transparent: true, opacity: 0.35, depthWrite: false }));
    this.block.position.set(this.x0 + ((this.nx - 1) * this.cell) / 2, this.y0 + ((this.ny - 1) * this.cell) / 2, this.top - depth / 2 - 0.01);
    this.group = new THREE.Group();
    this.group.add(this.mesh, this.block);
    this.update();
  }

  reset() {
    this.h.fill(this.top);
    this.dirty = true;
  }

  stampDisk(x, y, z) {
    if (z >= this.top) return;
    z = Math.max(z, this.bottom);
    const c = this.cell, r = this.r;
    const i0 = Math.max(0, Math.floor((x - r - this.x0) / c)), i1 = Math.min(this.nx - 1, Math.ceil((x + r - this.x0) / c));
    const j0 = Math.max(0, Math.floor((y - r - this.y0) / c)), j1 = Math.min(this.ny - 1, Math.ceil((y + r - this.y0) / c));
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const dy = this.y0 + j * c - y;
      for (let i = i0; i <= i1; i++) {
        const dx = this.x0 + i * c - x;
        if (dx * dx + dy * dy > r2) continue;
        const k = j * this.nx + i;
        if (this.h[k] > z) { this.h[k] = z; this.dirty = true; }
      }
    }
  }

  // Balaye la fraise de a vers b (seulement sous le dessus de la pièce).
  stampSegment(ax, ay, az, bx, by, bz) {
    if (az >= this.top && bz >= this.top) return;
    const d = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(d / (this.cell * 0.5)));
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      this.stampDisk(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
    }
  }

  update() {
    if (!this.dirty) return;
    this.dirty = false;
    const pos = this.mesh.geometry.attributes.position;
    for (let k = 0; k < this.h.length; k++) pos.array[k * 3 + 2] = this.h[k];
    pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }

  dispose() {
    this.group.traverse((m) => { m.geometry?.dispose(); m.material?.dispose(); });
  }
}

export class Preview {
  constructor(viewer, { onFrame } = {}) {
    this.viewer = viewer;
    this.onFrame = onFrame;
    this.active = false;
    this.playing = false;
    this.speed = 5;
    this.t = 0;
    this.cum = null;
    this.stock = null;
    this.showStock = true;
    this.toolDia = 6;
    this.stamped = 0;
    this.lastFrame = 0;
    this.loop = this.loop.bind(this);
  }

  // Durée cumulée de chaque segment (s), d'après les avances programmées.
  build(rapidRate) {
    const v = this.viewer;
    const n = v.segLine.length;
    this.cum = new Float64Array(n);
    let t = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = 0;
    for (let s = 0; s < n; s++) {
      const [ax, ay, az, bx, by, bz] = v.segment(s);
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      const rate = v.segRapid[s] ? rapidRate : v.segFeed[s] || rapidRate;
      t += (len / rate) * 60;
      this.cum[s] = t;
      if (az < 0 || bz < 0) {
        minX = Math.min(minX, ax, bx); maxX = Math.max(maxX, ax, bx);
        minY = Math.min(minY, ay, by); maxY = Math.max(maxY, ay, by);
        minZ = Math.min(minZ, az, bz);
      }
    }
    this.total = t;
    this.cutBounds = Number.isFinite(minX) ? { minX, minY, maxX, maxY, minZ } : null;
  }

  open({ rapidRate = 3000, toolDia = 6 } = {}) {
    const v = this.viewer;
    if (!v.path || !v.segLine.length) throw new Error('Chargez d\'abord un programme');
    this.toolDia = toolDia;
    this.build(rapidRate);
    this.active = true;
    v.grid.visible = false; // la grille transparaîtrait sur le dessus de la matière
    this.rebuildStock();
    this.seek(0);
  }

  rebuildStock() {
    const v = this.viewer;
    if (this.stock) { v.scene.remove(this.stock.group); this.stock.dispose(); this.stock = null; }
    if (!this.cutBounds) return;
    const b = this.cutBounds;
    this.stock = new Stock(b, Math.max(0.1, this.toolDia / 2), b.minZ - 2);
    this.stock.group.visible = this.showStock;
    v.scene.add(this.stock.group);
    this.stamped = 0;
    this.lastT = 0;
  }

  close() {
    this.pause();
    this.active = false;
    const v = this.viewer;
    if (this.stock) { v.scene.remove(this.stock.group); this.stock.dispose(); this.stock = null; }
    v.grid.visible = true;
    v.setGhost(null);
    v.setPreviewSeg(null);
  }

  setToolDia(d) {
    if (!(d > 0) || d === this.toolDia) return;
    this.toolDia = d;
    if (!this.active) return;
    this.rebuildStock();
    this.seek(this.t);
  }

  setShowStock(on) {
    this.showStock = on;
    if (this.stock) this.stock.group.visible = on;
    this.viewer.render();
  }

  play() {
    if (!this.active) return;
    if (this.t >= this.total) this.seek(0);
    this.playing = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.loop);
    this.onFrame?.(this.state());
  }

  pause() {
    this.playing = false;
    this.onFrame?.(this.state());
  }

  loop(now) {
    if (!this.playing) return;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.seek(this.t + dt * this.speed);
    if (this.t >= this.total) { this.playing = false; this.onFrame?.(this.state()); return; }
    requestAnimationFrame(this.loop);
  }

  // Place la simulation au temps t (secondes de programme).
  seek(t) {
    const v = this.viewer;
    this.t = Math.max(0, Math.min(this.total, t));
    const n = this.cum.length;
    // Premier segment qui se termine après t.
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cum[mid] <= this.t) lo = mid + 1; else hi = mid; }
    const k = Math.min(lo, n - 1);
    const start = k > 0 ? this.cum[k - 1] : 0;
    const dur = this.cum[k] - start;
    const frac = lo >= n ? 1 : dur > 0 ? (this.t - start) / dur : 1;
    const [ax, ay, az, bx, by, bz] = v.segment(k);
    const p = { X: ax + (bx - ax) * frac, Y: ay + (by - ay) * frac, Z: az + (bz - az) * frac };

    if (this.stock) {
      // Retour en arrière : on repart d'un bloc neuf.
      if (k < this.stamped || this.t < (this.lastT ?? 0)) { this.stock.reset(); this.stamped = 0; }
      for (; this.stamped < k; this.stamped++) this.stock.stampSegment(...v.segment(this.stamped));
      this.stock.stampSegment(ax, ay, az, p.X, p.Y, p.Z);
      this.stock.update();
    }
    this.k = k;
    this.lastT = this.t;
    v.setPreviewSeg(lo >= n ? n : k);
    v.setGhost(p);
    this.onFrame?.(this.state());
  }

  seekFraction(f) { this.seek(f * this.total); }

  state() {
    const v = this.viewer;
    return {
      active: this.active, playing: this.playing, t: this.t, total: this.total || 0,
      line: this.active && v.segLine.length ? v.segLine[this.k ?? 0] : 0,
    };
  }
}
