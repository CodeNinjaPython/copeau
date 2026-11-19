// Interpréteur G-code partagé entre le serveur (reprise de job) et le navigateur
// (visualiseur, estimation de durée). Les positions sont toujours en mm,
// dans le repère de travail du programme.

const INCH = 25.4;

// Retire commentaires et espaces, met en majuscules. Renvoie '' si rien à envoyer.
export function clean(raw) {
  let s = raw.replace(/\(.*?\)/g, '');
  const semi = s.indexOf(';');
  if (semi >= 0) s = s.slice(0, semi);
  s = s.replace(/\s+/g, '').toUpperCase();
  return s === '%' ? '' : s;
}

// Découpe un fichier en lignes envoyables. L'index dans ce tableau est la
// référence commune serveur / navigateur pour la progression.
export function splitProgram(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const c = clean(raw);
    if (c) out.push(c);
  }
  return out;
}

export function tokenize(line) {
  const words = [];
  const re = /([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))/g;
  let m;
  while ((m = re.exec(line))) words.push({ letter: m[1], value: parseFloat(m[2]) });
  return words;
}

export function createState() {
  return {
    motion: 0,
    units: 21,
    abs: true,
    plane: 17,
    wcs: 54,
    feedMode: 94,
    feed: 0,
    spindle: 5,
    speed: 0,
    mist: false,
    flood: false,
    tool: 0,
    pos: { X: 0, Y: 0, Z: 0 },
  };
}

const PLANES = {
  17: { a: 'X', b: 'Y', c: 'Z', i: 'I', j: 'J' },
  18: { a: 'Z', b: 'X', c: 'Y', i: 'K', j: 'I' },
  19: { a: 'Y', b: 'Z', c: 'X', i: 'J', j: 'K' },
};

// Exécute une ligne nettoyée sur l'état. emit(seg) est appelé pour chaque
// mouvement : { kind: 'rapid'|'feed'|'arc', from, to, feed, center?, cw?, plane? }
export function step(state, line, emit) {
  if (!line || line[0] === '$') return null;
  const words = tokenize(line);
  const p = {};
  let motionWord = false;
  let nonModalAxes = false; // G10/G28/G30/G92 : les axes ne sont pas une cible
  let g53 = false;
  let toolChange = false;

  for (const { letter, value } of words) {
    if (letter === 'G') {
      const v = Math.round(value * 10) / 10;
      if (v === 0 || v === 1 || v === 2 || v === 3) { state.motion = v; motionWord = true; }
      else if (v >= 38.2 && v <= 38.5) { state.motion = v; motionWord = true; }
      else if (v === 80) state.motion = 80;
      else if (v === 90) state.abs = true;
      else if (v === 91) state.abs = false;
      else if (v === 20 || v === 21) state.units = v;
      else if (v === 17 || v === 18 || v === 19) state.plane = v;
      else if (v >= 54 && v <= 59) state.wcs = v;
      else if (v === 93 || v === 94) state.feedMode = v;
      else if (v === 53) g53 = true;
      else if (v === 10 || v === 28 || v === 30 || v === 92 || v === 4) nonModalAxes = true;
    } else if (letter === 'M') {
      const v = Math.round(value);
      if (v === 3 || v === 4 || v === 5) state.spindle = v;
      else if (v === 7) state.mist = true;
      else if (v === 8) state.flood = true;
      else if (v === 9) { state.mist = false; state.flood = false; }
      else if (v === 6) toolChange = true;
    } else if (letter === 'F') {
      state.feed = state.units === 20 ? value * INCH : value;
    } else if (letter === 'S') {
      state.speed = value;
    } else if (letter === 'T') {
      state.tool = value;
    } else {
      p[letter] = value;
    }
  }

  const k = state.units === 20 ? INCH : 1;
  const hasAxis = 'X' in p || 'Y' in p || 'Z' in p;
  if (!hasAxis || nonModalAxes || state.motion === 80) return { toolChange };

  const from = { ...state.pos };
  const to = { ...state.pos };
  for (const a of ['X', 'Y', 'Z']) {
    if (a in p) to[a] = state.abs || g53 ? p[a] * k : from[a] + p[a] * k;
  }

  // Un G53 est en coordonnées machine : on ne connaît pas l'offset ici,
  // on ne trace rien et on garde la position du programme.
  if (g53) return { toolChange };

  const m = state.motion;
  if (m === 0 || m === 1) {
    emit && emit({ kind: m === 0 ? 'rapid' : 'feed', from, to, feed: state.feed });
  } else if (m === 2 || m === 3) {
    const pl = PLANES[state.plane];
    let ci, cj;
    if ('R' in p) {
      let r = p.R * k;
      const x = to[pl.a] - from[pl.a];
      const y = to[pl.b] - from[pl.b];
      const d = Math.hypot(x, y);
      let h = d > 0 ? -Math.sqrt(Math.max(0, 4 * r * r - d * d)) / d : 0;
      if (m === 3) h = -h;
      if (r < 0) h = -h;
      ci = 0.5 * (x - y * h);
      cj = 0.5 * (y + x * h);
    } else {
      ci = (p[pl.i] ?? 0) * k;
      cj = (p[pl.j] ?? 0) * k;
    }
    const center = { [pl.a]: from[pl.a] + ci, [pl.b]: from[pl.b] + cj };
    emit && emit({ kind: 'arc', from, to, feed: state.feed, center, cw: m === 2, plane: state.plane });
  }
  // G38.x : le point final réel dépend du contact, on suppose la cible.
  state.pos = to;
  return { toolChange };
}

// Discrétise un arc en points (inclut le point final, pas le départ).
export function arcPoints(seg, maxLen = 0.5) {
  const pl = PLANES[seg.plane];
  const { from, to, center } = seg;
  const a0 = Math.atan2(from[pl.b] - center[pl.b], from[pl.a] - center[pl.a]);
  const a1 = Math.atan2(to[pl.b] - center[pl.b], to[pl.a] - center[pl.a]);
  const r = Math.hypot(from[pl.a] - center[pl.a], from[pl.b] - center[pl.b]);
  let sweep = a1 - a0;
  if (seg.cw) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; }
  else if (sweep <= 1e-9) sweep += 2 * Math.PI;
  const n = Math.max(1, Math.ceil((Math.abs(sweep) * r) / maxLen));
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ang = a0 + sweep * t;
    pts.push({
      [pl.a]: center[pl.a] + r * Math.cos(ang),
      [pl.b]: center[pl.b] + r * Math.sin(ang),
      [pl.c]: from[pl.c] + (to[pl.c] - from[pl.c]) * t,
    });
  }
  pts[pts.length - 1] = { ...to };
  return { pts, length: Math.hypot(Math.abs(sweep) * r, to[pl.c] - from[pl.c]) };
}

export function segLength(seg) {
  if (seg.kind === 'arc') return arcPoints(seg, 5).length;
  return Math.hypot(seg.to.X - seg.from.X, seg.to.Y - seg.from.Y, seg.to.Z - seg.from.Z);
}

export const fmt = (n) => (Math.round(n * 1000) / 1000).toString();

// Préambule pour reprendre un programme à la ligne `from` (index dans splitProgram).
// Restaure les modes, démarre la broche, remonte en sécurité, se place au-dessus
// du point de reprise puis plonge en vitesse d'avance.
export function buildResume(lines, from, { spinUpSeconds = 3, plungeFeed = 300 } = {}) {
  const st = createState();
  let maxZ = -Infinity;
  for (let i = 0; i < from && i < lines.length; i++) {
    step(st, lines[i], (seg) => { maxZ = Math.max(maxZ, seg.from.Z, seg.to.Z); });
  }
  const safeZ = Number.isFinite(maxZ) ? Math.max(maxZ, st.pos.Z) : Math.max(5, st.pos.Z);
  const out = ['G21', 'G90', `G${st.wcs}`, `G${st.plane}`, `G${st.feedMode}`];
  out.push(`G0Z${fmt(safeZ)}`);
  if (st.spindle === 3 || st.spindle === 4) {
    out.push(`M${st.spindle}S${fmt(st.speed)}`);
    if (spinUpSeconds > 0) out.push(`G4P${spinUpSeconds}`);
  }
  if (st.mist) out.push('M7');
  if (st.flood) out.push('M8');
  out.push(`G0X${fmt(st.pos.X)}Y${fmt(st.pos.Y)}`);
  const feed = st.feed > 0 ? st.feed : plungeFeed;
  out.push(`G1Z${fmt(st.pos.Z)}F${fmt(Math.min(feed, plungeFeed))}`);
  out.push(st.motion === 0 || st.motion === 1 ? `G${st.motion}F${fmt(feed)}` : `F${fmt(feed)}`);
  if (st.units === 20) out.push('G20');
  if (!st.abs) out.push('G91');
  return { lines: out, state: st, safeZ };
}

// Analyse complète pour l'affichage : bornes, durée estimée, outils.
export function analyze(lines, { rapidRate = 3000 } = {}) {
  const st = createState();
  const min = { X: Infinity, Y: Infinity, Z: Infinity };
  const max = { X: -Infinity, Y: -Infinity, Z: -Infinity };
  let seconds = 0;
  const tools = new Set();
  let toolChanges = 0;
  for (const line of lines) {
    const r = step(st, line, (seg) => {
      for (const a of ['X', 'Y', 'Z']) {
        min[a] = Math.min(min[a], seg.to[a]);
        max[a] = Math.max(max[a], seg.to[a]);
      }
      const len = segLength(seg);
      const rate = seg.kind === 'rapid' ? rapidRate : seg.feed || rapidRate;
      seconds += (len / rate) * 60;
    });
    if (st.tool) tools.add(st.tool);
    if (r && r.toolChange) toolChanges++;
    const dwell = /G0*4(?!\d)/.test(line) && line.match(/P([\d.]+)/);
    if (dwell) seconds += parseFloat(dwell[1]);
  }
  return { min, max, seconds, tools: [...tools], toolChanges, lines: lines.length };
}
