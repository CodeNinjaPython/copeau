import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createState, step, arcPoints } from './shared/gcode.js';

const COLORS = {
  feed: new THREE.Color(0x5aa9ff),
  rapid: new THREE.Color(0x4a515e),
  feedDone: new THREE.Color(0xf08a24),
  rapidDone: new THREE.Color(0x6b4a2a),
};

export class Viewer {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0d10);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(150, -200, 180);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.render());

    this.grid = new THREE.Group();
    this.scene.add(this.grid);
    this.setGrid(200);

    const axis = (to, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), to]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
    };
    this.scene.add(axis(new THREE.Vector3(25, 0, 0), 0xff6b6b));
    this.scene.add(axis(new THREE.Vector3(0, 25, 0), 0x4ade80));
    this.scene.add(axis(new THREE.Vector3(0, 0, 25), 0x60a5fa));

    // Outil : cône dont la pointe est à l'origine de l'objet.
    const cone = new THREE.ConeGeometry(3, 14, 24);
    cone.rotateX(-Math.PI / 2);
    cone.translate(0, 0, 7);
    this.tool = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: 0xf5c84b, transparent: true, opacity: 0.85 }));
    this.scene.add(this.tool);

    this.marker = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.marker.visible = false;
    this.scene.add(this.marker);

    // Cible du "cliquer pour déplacer" : anneau + croix posés sur le plateau.
    this.target = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 3, 32), new THREE.MeshBasicMaterial({ color: 0x3ecf8e, side: THREE.DoubleSide }));
    const cross = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-5, 0, 0), new THREE.Vector3(5, 0, 0), new THREE.Vector3(0, -5, 0), new THREE.Vector3(0, 5, 0),
      ]),
      new THREE.LineBasicMaterial({ color: 0x3ecf8e }),
    );
    this.target.add(ring, cross);
    this.target.visible = false;
    this.scene.add(this.target);

    this.path = null;
    this.segLine = null;
    this.segRapid = null;
    this.lineEnd = [];
    this.done = 0;
    this.onClick = null;
    this.onHover = null;

    // Plateau et zone de travail (repère travail), dessinés sous le parcours.
    this.shapes = new THREE.Group();
    this.scene.add(this.shapes);
    this.shapesBox = null;

    this.raycaster = new THREE.Raycaster();
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      this.pick(e);
    });
    let hoverQueued = false;
    el.addEventListener('pointermove', (e) => {
      if (!this.onHover || hoverQueued) return;
      hoverQueued = true;
      requestAnimationFrame(() => {
        hoverQueued = false;
        const p = this.planePoint(e);
        if (p && this.onHover) this.onHover(p);
      });
    });

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
  }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.renderer.render(this.scene, this.camera);
    });
  }

  setGrid(size) {
    this.grid.clear();
    const s = Math.max(50, Math.ceil(size / 10) * 10);
    const minor = new THREE.GridHelper(s * 2, (s * 2) / 10, 0x1f242c, 0x1f242c);
    const major = new THREE.GridHelper(s * 2, (s * 2) / 50, 0x2c333d, 0x2c333d);
    for (const g of [minor, major]) { g.rotateX(Math.PI / 2); this.grid.add(g); }
    major.position.z = 0.01;
  }

  // La grille couvre le programme, le plateau et la zone.
  fitGrid() {
    let ext = 0;
    for (const b of [this.box, this.shapesBox]) {
      if (b) ext = Math.max(ext, Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.y), Math.abs(b.max.y));
    }
    if (ext) this.setGrid(ext + 20);
  }

  load(lines) {
    if (this.path) {
      this.scene.remove(this.path);
      this.path.geometry.dispose();
    }
    const pos = [];
    const segLine = [];
    const segRapid = [];
    this.lineEnd = new Array(lines.length);
    const st = createState();
    lines.forEach((line, i) => {
      step(st, line, (seg) => {
        const push = (a, b) => {
          pos.push(a.X, a.Y, a.Z, b.X, b.Y, b.Z);
          segLine.push(i);
          segRapid.push(seg.kind === 'rapid' ? 1 : 0);
        };
        if (seg.kind === 'arc') {
          let prev = seg.from;
          for (const p of arcPoints(seg, 0.5).pts) { push(prev, p); prev = p; }
        } else {
          push(seg.from, seg.to);
        }
      });
      this.lineEnd[i] = { ...st.pos };
    });

    this.segLine = Uint32Array.from(segLine);
    this.segRapid = Uint8Array.from(segRapid);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    this.path = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.scene.add(this.path);
    this.done = -1;
    this.paint(0, this.segLine.length);
    this.done = 0;

    geom.computeBoundingBox();
    this.box = geom.boundingBox.isEmpty() ? null : geom.boundingBox.clone();
    this.fitGrid();
    this.view('iso');
  }

  // Colore les segments [from, to) selon la ligne courante.
  paint(from, to) {
    const col = this.path.geometry.attributes.color;
    for (let s = from; s < to; s++) {
      const done = this.segLine[s] < this.done;
      const c = this.segRapid[s] ? (done ? COLORS.rapidDone : COLORS.rapid) : (done ? COLORS.feedDone : COLORS.feed);
      col.setXYZ(s * 2, c.r, c.g, c.b);
      col.setXYZ(s * 2 + 1, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  // Les lignes d'index < doneLines sont exécutées.
  setProgress(doneLines) {
    if (!this.path || doneLines === this.done) return;
    const lo = Math.min(doneLines, this.done), hi = Math.max(doneLines, this.done);
    this.done = doneLines;
    const first = lowerBound(this.segLine, lo);
    const last = lowerBound(this.segLine, hi);
    this.paint(first, last);
    this.render();
  }

  setTool(p) {
    this.tool.position.set(p.X, p.Y, p.Z);
    this.render();
  }

  // Marque le point de reprise (fin de la ligne précédente).
  setMarker(lineIndex) {
    const p = lineIndex > 0 ? this.lineEnd[lineIndex - 1] : null;
    this.marker.visible = !!p;
    if (p) this.marker.position.set(p.X, p.Y, p.Z);
    this.render();
  }

  castFrom(e) {
    const r = this.el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return r;
  }

  planePoint(e) {
    this.castFrom(e);
    const p = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    return p ? { X: p.x, Y: p.y } : null;
  }

  // Renvoie la ligne du parcours sous le clic (ou null) et le point du plateau Z0.
  pick(e) {
    if (!this.onClick) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.raycaster.params.Line.threshold = dist / 300;
    const r = this.castFrom(e);
    const hit = this.path ? this.raycaster.intersectObject(this.path)[0] : null;
    const p = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    this.onClick({
      line: hit ? this.segLine[Math.floor(hit.index / 2)] : null,
      point: p ? { X: p.x, Y: p.y } : null,
      screen: { x: e.clientX - r.left, y: e.clientY - r.top },
    });
  }

  // shapes : { table, zone, preview }, chacun { kind: 'rect', a, b } ou
  // { kind: 'circle', c, r } en repère travail, ou null.
  setShapes({ table, zone, preview }) {
    for (const o of this.shapes.children) o.traverse((m) => { m.geometry?.dispose(); m.material?.dispose(); });
    this.shapes.clear();
    const box = new THREE.Box3();
    const add = (shape, { line, fill, fillOpacity, z, dashed }) => {
      const pts = outline(shape);
      if (pts.length < 3) return;
      const v = pts.map((p) => new THREE.Vector3(p.X, p.Y, z));
      if (!dashed) for (const p of v) box.expandByPoint(p);
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color: line, dashSize: 3, gapSize: 2 })
        : new THREE.LineBasicMaterial({ color: line });
      const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(v), mat);
      if (dashed) loop.computeLineDistances();
      this.shapes.add(loop);
      if (fill !== undefined) {
        const geom = new THREE.ShapeGeometry(new THREE.Shape(pts.map((p) => new THREE.Vector2(p.X, p.Y))));
        const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: fill, transparent: true, opacity: fillOpacity, side: THREE.DoubleSide, depthWrite: false }));
        mesh.position.z = z - 0.01;
        this.shapes.add(mesh);
      }
    };
    if (table) add(table, { line: 0x6b7280, fill: 0x2a2f38, fillOpacity: 0.35, z: -0.05 });
    if (zone) add(zone, { line: 0xf5c84b, fill: 0xf5c84b, fillOpacity: 0.07, z: 0.02 });
    if (preview) add(preview, { line: 0x3ecf8e, z: 0.04, dashed: true });
    const changed = (this.shapesBox ? JSON.stringify(this.shapesBox) : '') !== (box.isEmpty() ? '' : JSON.stringify(box));
    this.shapesBox = box.isEmpty() ? null : box;
    if (changed) this.fitGrid();
    this.render();
  }

  setTarget(p) {
    this.target.visible = !!p;
    if (p) {
      this.target.position.set(p.X, p.Y, 0.05);
      this.target.scale.setScalar(this.tool.scale.x);
    }
    this.render();
  }

  view(name) {
    let box = this.box ? this.box.clone() : null;
    if (this.shapesBox) box = box ? box.union(this.shapesBox) : this.shapesBox.clone();
    if (!box) box = new THREE.Box3(new THREE.Vector3(-50, -50, -10), new THREE.Vector3(50, 50, 10));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z * 2, 20);
    const d = (span / 2 / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.35;
    this.tool.scale.setScalar(Math.min(1.5, Math.max(0.25, span / 150)));
    const dir = {
      iso: new THREE.Vector3(0.6, -0.9, 0.8),
      top: new THREE.Vector3(0, -0.0001, 1),
      front: new THREE.Vector3(0, -1, 0.0001),
      fit: this.camera.position.clone().sub(this.controls.target),
    }[name] || new THREE.Vector3(0.6, -0.9, 0.8);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(dir.normalize().multiplyScalar(d));
    this.camera.far = d * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
  }
}

// Contour d'une forme en points (repère travail).
export function outline(shape, segments = 64) {
  if (!shape) return [];
  if (shape.kind === 'rect') {
    const { a, b } = shape;
    if (!a || !b) return [];
    return [{ X: a.X, Y: a.Y }, { X: b.X, Y: a.Y }, { X: b.X, Y: b.Y }, { X: a.X, Y: b.Y }];
  }
  if (shape.kind === 'circle' && shape.c && shape.r > 0) {
    return Array.from({ length: segments }, (_, i) => {
      const t = (i / segments) * Math.PI * 2;
      return { X: shape.c.X + shape.r * Math.cos(t), Y: shape.c.Y + shape.r * Math.sin(t) };
    });
  }
  return [];
}

function lowerBound(arr, value) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}
