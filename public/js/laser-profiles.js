import { fmt } from './shared/gcode.js';

export const LAYER_COLORS = [
  { id: '00', color: '#000000', label: 'Noir' },
  { id: '01', color: '#0000ff', label: 'Bleu' },
  { id: '02', color: '#ff0000', label: 'Rouge' },
  { id: '03', color: '#00e000', label: 'Vert' },
  { id: '04', color: '#d0d000', label: 'Jaune' },
  { id: '05', color: '#ff8000', label: 'Orange' },
  { id: '06', color: '#00e0e0', label: 'Cyan' },
  { id: '07', color: '#ff00ff', label: 'Magenta' },
];

export const DEFAULT_MACHINES = [
  { id: 'emblaser-2', name: 'Emblaser 2', bedWidth: 500, bedHeight: 300, sMax: 1000 },
  { id: 'grbl-generic', name: 'Graveuse GRBL générique', bedWidth: 400, bedHeight: 400, sMax: 1000 },
];

export function defaultLayers() {
  return LAYER_COLORS.map(({ id, color }) => ({
    id, color, enabled: id === '00', feed: 1000, power: 200, passes: 1,
  }));
}

const finiteIn = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const cleanName = (name) => String(name ?? '').trim().slice(0, 60);

export function sanitizeMachine(machine) {
  const result = {
    id: String(machine?.id || '').trim(),
    name: cleanName(machine?.name),
    bedWidth: Number(machine?.bedWidth),
    bedHeight: Number(machine?.bedHeight),
    sMax: Number(machine?.sMax),
  };
  if (!result.id || !result.name) throw new Error('Le profil machine doit avoir un nom.');
  if (!finiteIn(result.bedWidth, 10, 3000) || !finiteIn(result.bedHeight, 10, 3000)) {
    throw new Error('Les dimensions du plateau doivent être comprises entre 10 et 3000 mm.');
  }
  if (!finiteIn(result.sMax, 1, 100000)) throw new Error('La puissance S max du profil doit être positive.');
  return result;
}

export function sanitizeLayers(layers) {
  return LAYER_COLORS.map(({ id, color }, index) => {
    const layer = layers?.find?.((item) => item?.id === id) || layers?.[index] || {};
    const result = {
      id,
      color,
      enabled: Boolean(layer.enabled),
      feed: Number(layer.feed),
      power: Number(layer.power),
      passes: Number(layer.passes),
    };
    if (!finiteIn(result.feed, 1, 30000) || !finiteIn(result.power, 1, 100000)
      || !Number.isInteger(result.passes) || !finiteIn(result.passes, 1, 10)) {
      throw new Error(`Calque ${id} : avance de 1 à 30000 mm/min, puissance positive et 1 à 10 passes.`);
    }
    return result;
  });
}

export function sanitizePreset(preset) {
  const result = {
    name: cleanName(preset?.name),
    resolution: Number(preset?.resolution),
    feed: Number(preset?.feed),
    power: Number(preset?.power),
    overscan: Number(preset?.overscan),
    invert: Boolean(preset?.invert),
    useLayers: Boolean(preset?.useLayers),
    layers: sanitizeLayers(preset?.layers),
  };
  if (!result.name) throw new Error('Le préréglage doit avoir un nom.');
  if (!finiteIn(result.resolution, 1, 20) || !finiteIn(result.feed, 1, 30000)
    || !finiteIn(result.power, 1, 100000) || !finiteIn(result.overscan, 0, 20)) {
    throw new Error('Préréglage invalide : vérifiez résolution, avance, puissance et marge.');
  }
  return result;
}

export function powerLimitErrors({ power, useLayers, layers }, machine) {
  const limit = machine.sMax;
  const errors = [];
  if (useLayers) {
    for (const layer of layers.filter((item) => item.enabled)) {
      if (layer.power > limit) errors.push(`Calque ${layer.id} : S${fmt(layer.power)} dépasse S max ${fmt(limit)} du profil ${machine.name}.`);
    }
    if (!layers.some((item) => item.enabled)) errors.push('Activez au moins un calque.');
  } else if (power > limit) {
    errors.push(`La puissance S${fmt(power)} dépasse S max ${fmt(limit)} du profil ${machine.name}.`);
  }
  return errors;
}

export function bedLimitError({ widthMm, heightMm, overscanMm = 0 }, machine) {
  const travel = widthMm + 2 * overscanMm;
  if (travel > machine.bedWidth || heightMm > machine.bedHeight) {
    return `La gravure (${fmt(travel)} × ${fmt(heightMm)} mm, marge comprise) dépasse le plateau ${machine.name} (${fmt(machine.bedWidth)} × ${fmt(machine.bedHeight)} mm).`;
  }
  return null;
}
