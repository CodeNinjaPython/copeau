import { fmt } from '../public/js/shared/gcode.js';

// Routines de palpage. Toutes les coordonnées de contact viennent de [PRB:...]
// (repère machine). Les origines sont écrites avec G10 L2 dans le repère actif,
// ce qui évite l'erreur due au dépassement après déclenchement de la sonde.

const num = (v, def) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? def : Number(v));

function wcsP(c) {
  return Number(c.modal.wcs.slice(1)) - 53; // G54 -> P1
}

async function probeOnce(c, axis, dir, travel, feed) {
  c.lastProbe = null;
  await c.cmd(`G91G38.2${axis}${fmt(dir * travel)}F${fmt(feed)}`, 'probe');
  const p = c.lastProbe;
  if (!p || !p.ok || c.status.state === 'Alarm') {
    throw new Error(`Pas de contact sur ${axis}${dir > 0 ? '+' : '-'} dans ${travel} mm`);
  }
  return p;
}

// Palpage rapide puis lent, renvoie le point de contact précis.
async function probeAxis(c, axis, dir, travel, o) {
  await probeOnce(c, axis, dir, travel, o.fastFeed);
  await c.cmd(`G91G0${axis}${fmt(-dir * o.backoff)}`, 'probe');
  const p = await probeOnce(c, axis, dir, o.backoff + 1, o.slowFeed);
  await c.cmd(`G91G0${axis}${fmt(-dir * o.backoff)}`, 'probe');
  return p;
}

function options(params) {
  return {
    fastFeed: num(params.fastFeed, 150),
    slowFeed: num(params.slowFeed, 30),
    backoff: num(params.backoff, 2),
    travel: num(params.travel, 25),
    retract: num(params.retract, 5),
    plate: num(params.plate, 0),
    toolDia: num(params.toolDia, 6),
    wall: num(params.wall, 0),
    inset: num(params.inset, 10),
    depth: num(params.depth, 3),
  };
}

async function guard(c, fn) {
  if (!c.ready) throw new Error('Machine non connectée');
  if (c.status.state !== 'Idle') throw new Error(`La machine doit être Idle (état : ${c.status.state})`);
  if (c.job && ['running', 'paused', 'spinup', 'finishing'].includes(c.job.state)) throw new Error('Un job est en cours');
  // Modes à jour avant de commencer : le repère actif (G54…) décide où G10 écrit.
  await c.cmd('$G', 'probe');
  const restore = [c.modal.units, c.modal.distance];
  try {
    return await fn();
  } finally {
    if (c.ready && c.status.state === 'Alarm') {
      // Palpage raté : Grbl garde G91/G21 jusqu'au déverrouillage, on les
      // rétablira à ce moment-là (sinon un G0 X10 deviendrait relatif).
      c.restoreOnUnlock = restore;
    } else if (c.ready) {
      for (const l of restore) await c.cmd(l, 'probe').catch(() => {});
      await c.cmd('$G', 'probe').catch(() => {});
    }
  }
}

// Origine Z sur le dessus de la pièce, avec ou sans cale de palpage.
export function probeZ(c, params) {
  const o = options(params);
  return guard(c, async () => {
    await c.cmd('G21', 'probe');
    const p = await probeAxis(c, 'Z', -1, o.travel, o);
    const zOffset = p.Z - o.plate;
    await c.cmd(`G10L2P${wcsP(c)}Z${fmt(zOffset)}`, 'probe');
    await c.cmd(`G91G0Z${fmt(o.retract)}`, 'probe');
    return { message: `Z0 fixé (contact machine Z ${fmt(p.Z)}, cale ${o.plate} mm)`, Z: p.Z };
  });
}

// Origine XYZ sur un coin de la pièce. corner : FL, FR, BL, BR (avant/arrière, gauche/droite).
// L'outil doit être au-dessus de la pièce, à environ `inset` mm de chaque bord.
export function probeCorner(c, params) {
  const o = options(params);
  const corner = String(params.corner || 'FL').toUpperCase();
  const dx = corner.includes('L') ? 1 : -1; // sens de palpage en X
  const dy = corner.includes('F') ? 1 : -1;
  const r = o.toolDia / 2;
  return guard(c, async () => {
    await c.cmd('G21', 'probe');
    const start = { ...(await c.sync()).mpos };

    const pz = await probeAxis(c, 'Z', -1, o.travel, o);
    const top = pz.Z - o.plate; // dessus de la pièce, repère machine
    const safe = pz.Z + o.retract;
    const low = top - o.depth;
    const out = o.inset + r + 5;

    await c.cmd(`G90G53G0Z${fmt(safe)}`, 'probe');
    await c.cmd(`G90G53G0X${fmt(start.X - dx * out)}Y${fmt(start.Y)}`, 'probe');
    await c.cmd(`G90G53G0Z${fmt(low)}`, 'probe');
    const px = await probeAxis(c, 'X', dx, out + 5, o);
    const edgeX = px.X + dx * (r + o.wall);

    await c.cmd(`G90G53G0Z${fmt(safe)}`, 'probe');
    await c.cmd(`G90G53G0X${fmt(start.X)}Y${fmt(start.Y - dy * out)}`, 'probe');
    await c.cmd(`G90G53G0Z${fmt(low)}`, 'probe');
    const py = await probeAxis(c, 'Y', dy, out + 5, o);
    const edgeY = py.Y + dy * (r + o.wall);

    await c.cmd(`G90G53G0Z${fmt(safe)}`, 'probe');
    await c.cmd(`G10L2P${wcsP(c)}X${fmt(edgeX)}Y${fmt(edgeY)}Z${fmt(top)}`, 'probe');
    await c.cmd('G90G0X0Y0', 'probe');
    return { message: `Origine posée sur le coin ${corner}`, edgeX, edgeY, top };
  });
}

// Centre d'un alésage : l'outil doit être dans le trou, sous le bord.
export function probeCenter(c, params) {
  const o = options(params);
  const maxR = num(params.maxRadius, 30);
  const r = o.toolDia / 2;
  return guard(c, async () => {
    await c.cmd('G21', 'probe');
    const start = { ...(await c.sync()).mpos };
    const center = { ...start };
    const measure = async (axis) => {
      const a = await probeAxis(c, axis, 1, maxR, o);
      await c.cmd(`G90G53G0${axis}${fmt(center[axis])}`, 'probe');
      const b = await probeAxis(c, axis, -1, maxR, o);
      center[axis] = (a[axis] + b[axis]) / 2;
      await c.cmd(`G90G53G0${axis}${fmt(center[axis])}`, 'probe');
      return a[axis] - b[axis] + 2 * r;
    };
    await measure('X');
    const dy = await measure('Y');
    // Second passage en X maintenant que Y est centré : mesure du vrai diamètre.
    const dx = await measure('X');
    await c.cmd(`G10L2P${wcsP(c)}X${fmt(center.X)}Y${fmt(center.Y)}`, 'probe');
    return {
      message: `Centre trouvé, Ø X ${fmt(dx)} mm / Ø Y ${fmt(dy)} mm`,
      center, diameterX: dx, diameterY: dy,
    };
  });
}

export const routines = { z: probeZ, corner: probeCorner, center: probeCenter };
