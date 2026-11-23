// Gravure d'une image par balayage ligne à ligne (comme le mode « ligne à
// ligne » de LaserGRBL). Fonctionne dans le navigateur et sous Node (tests).
//
// L'image arrive déjà rééchantillonnée : un pixel = un pas de gravure
// (1 / resolution mm), ligne 0 en haut. gray : luminance 0 (noir) à 255
// (blanc), un octet par pixel.

import { fmt } from './gcode.js';

export const RASTER_DEFAULTS = {
  mode: 'gray', // gray : niveaux de gris · threshold : noir et blanc · dither : tramage
  threshold: 128,
  invert: false,
  resolution: 10, // lignes par mm
  speed: 3000, // mm/min pendant la gravure
  powerMin: 0, // % pour le gris le plus clair gravé
  powerMax: 50, // % pour le noir
  overscan: 2, // mm de marge pour accélérer avant la ligne
  origin: 'bottom-left', // bottom-left : X0 Y0 = coin bas gauche · center : centre de l'image
  firmware: 'grbl',
  sMax: 1000,
};

// Puissance (0 à 1) de chaque pixel, selon le mode.
export function powerMap(gray, width, height, o) {
  const n = width * height;
  const dark = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = gray[i] / 255;
    dark[i] = o.invert ? g : 1 - g;
  }
  const out = new Float32Array(n);
  const lo = Math.max(0, Math.min(100, o.powerMin)) / 100;
  const hi = Math.max(0, Math.min(100, o.powerMax)) / 100;
  if (o.mode === 'threshold') {
    const t = 1 - o.threshold / 255;
    for (let i = 0; i < n; i++) out[i] = dark[i] > t ? hi : 0;
  } else if (o.mode === 'dither') {
    // Floyd–Steinberg : l'erreur de chaque pixel se reporte sur ses voisins.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const v = dark[i];
        const on = v >= 0.5 ? 1 : 0;
        out[i] = on ? hi : 0;
        const e = v - on;
        if (x + 1 < width) dark[i + 1] += (e * 7) / 16;
        if (y + 1 < height) {
          if (x > 0) dark[i + width - 1] += (e * 3) / 16;
          dark[i + width] += (e * 5) / 16;
          if (x + 1 < width) dark[i + width + 1] += e / 16;
        }
      }
    }
  } else {
    // Niveaux de gris, arrondis au % pour limiter la taille du fichier.
    for (let i = 0; i < n; i++) {
      const d = Math.max(0, Math.min(1, dark[i]));
      out[i] = d < 0.005 ? 0 : Math.round((lo + d * (hi - lo)) * 100) / 100;
    }
  }
  return out;
}

// Programme G-code. Renvoie { text, lines, bounds, rows } (bounds en mm,
// repère travail, sans la marge d'accélération).
export function rasterGcode({ gray, width, height }, options = {}) {
  const o = { ...RASTER_DEFAULTS, ...options };
  if (!(width > 0 && height > 0) || gray.length < width * height) throw new Error('Image vide');
  const pix = 1 / o.resolution;
  const wMm = width * pix, hMm = height * pix;
  const x0 = o.origin === 'center' ? -wMm / 2 : 0;
  const y0 = o.origin === 'center' ? -hMm / 2 : 0;
  const power = powerMap(gray, width, height, o);
  const smoothie = o.firmware === 'smoothie';
  // S entier pour Grbl ($30 = 1000), au millième si l'échelle est petite (S 0-1).
  const sOf = (p) => (o.sMax >= 100 ? String(Math.round(p * o.sMax)) : fmt(p * o.sMax));
  const X = (v) => fmt(x0 + v);
  const over = Math.max(0, o.overscan);

  const modeLabel = { gray: 'niveaux de gris', threshold: 'noir et blanc', dither: 'tramage' }[o.mode] || o.mode;
  const out = [
    `; Copeau : gravure d'image ${fmt(wMm)} x ${fmt(hMm)} mm, ${fmt(o.resolution)} lignes/mm, ${modeLabel}`,
    `; Puissance ${fmt(o.powerMin)} à ${fmt(o.powerMax)} %, vitesse ${fmt(o.speed)} mm/min`,
    'G21G90',
  ];
  // Grbl : M4 = puissance dynamique, le laser s'éteint quand la tête ralentit
  // ou s'arrête. Smoothieware : la puissance suit déjà la vitesse, et le
  // laser ne tire que sur les G1 avec un S non nul.
  if (!smoothie) out.push('M4S0');
  let rows = 0;
  let forward = true;
  // F est modal : donné une seule fois. Jamais sur un G0 : sous Smoothieware
  // il changerait la vitesse de tous les G0 suivants, après la gravure aussi.
  let feedSet = false;
  const feed = () => (feedSet ? '' : ((feedSet = true), `F${fmt(o.speed)}`));
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (let r = 0; r < height; r++) {
    const row = power.subarray(r * width, (r + 1) * width);
    let first = -1, last = -1;
    for (let c = 0; c < width; c++) if (row[c] > 0) { if (first < 0) first = c; last = c; }
    if (first < 0) continue; // ligne blanche : rien à graver
    const y = y0 + (height - 1 - r + 0.5) * pix;
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minX = Math.min(minX, x0 + first * pix); maxX = Math.max(maxX, x0 + (last + 1) * pix);
    // Suites de pixels de même puissance, dans le sens de balayage.
    const runs = [];
    if (forward) {
      for (let c = first; c <= last; c++) {
        if (runs.length && runs[runs.length - 1].p === row[c]) runs[runs.length - 1].to = (c + 1) * pix;
        else runs.push({ p: row[c], to: (c + 1) * pix });
      }
    } else {
      for (let c = last; c >= first; c--) {
        if (runs.length && runs[runs.length - 1].p === row[c]) runs[runs.length - 1].to = c * pix;
        else runs.push({ p: row[c], to: c * pix });
      }
    }
    const start = forward ? first * pix : (last + 1) * pix;
    const dir = forward ? 1 : -1;
    out.push(`G0X${X(start - dir * over)}Y${fmt(y)}`);
    if (over > 0) out.push(`G1X${X(start)}S0${feed()}`);
    for (const run of runs) out.push(`G1X${X(run.to)}S${sOf(run.p)}${feed()}`);
    if (over > 0) out.push(`G1X${X(runs[runs.length - 1].to + dir * over)}S0`);
    rows++;
    forward = !forward;
  }
  if (!smoothie) out.push('M5S0');
  out.push('G0X0Y0');
  return {
    text: out.join('\n') + '\n',
    lines: out.length,
    rows,
    bounds: rows ? { minX, minY: minY - pix / 2, maxX, maxY: maxY + pix / 2 } : null,
    size: { width: wMm, height: hMm },
  };
}
