import { fmt, splitProgram, tokenize } from './shared/gcode.js';

export const MAX_RASTER_PIXELS = 250_000;

export function sealLaserProgram(lines) {
  const program = [...lines];
  if (!program.length || !isM5(program[0])) program.unshift('M5');
  if (!isM5(program.at(-1))) program.push('M5');
  return program;
}

export function validateLaserProgram(lines, settings = {}) {
  const errors = [];
  if (Number(settings[13]) !== 0) errors.push('Le contrôleur doit rapporter les positions en millimètres ($13=0).');
  if (Number(settings[32]) !== 1) errors.push('Le mode laser Grbl doit être activé ($32=1).');

  const maxSetting = Number(settings[30]);
  if (!Number.isFinite(maxSetting) || maxSetting <= 0) {
    errors.push('Le réglage $30 est inconnu : connectez la machine et relisez ses réglages.');
  }

  let hasDynamicPower = false;
  let maxPower = 0;
  let spindle = 5;
  for (const line of lines) {
    const words = tokenize(line);
    if (words.some(({ letter, value }) => letter === 'G' && [10, 28, 30, 53, 92].includes(Math.round(value)))) {
      errors.push('G10, G28, G30, G53 et G92 modifient ou contournent le repère visualisé et sont refusés en mode laser.');
    }
    const hasRapid = words.some(({ letter, value }) => letter === 'G' && value === 0);
    const hasM5 = words.some(({ letter, value }) => letter === 'M' && value === 5);
    if (hasRapid && spindle !== 5 && !hasM5) errors.push('Un déplacement rapide G0 est précédé d’une commande M4 : coupez le laser avant ce déplacement.');
    if (hasRapid && words.some(({ letter, value }) => letter === 'M' && value === 4)) {
      errors.push('M4 et G0 ne doivent pas apparaître sur la même ligne.');
    }
    for (const { letter, value } of words) {
      if (letter === 'M' && value === 3) errors.push('M3 est refusé en mode laser : réexportez avec la puissance dynamique M4.');
      if (letter === 'M' && value === 4) hasDynamicPower = true;
      if (letter === 'M' && (value === 4 || value === 5)) spindle = value;
      if (letter === 'Z') errors.push('Les déplacements Z sont refusés en mode laser.');
      if (letter === 'M' && value === 6) errors.push('Les changements d’outil M6 ne sont pas pris en charge en mode laser.');
      if (letter === 'S') maxPower = Math.max(maxPower, value);
    }
  }
  if (!hasDynamicPower) errors.push('Le programme ne contient pas M4 : puissance dynamique laser requise.');
  if (maxPower <= 0) errors.push('Le programme ne définit aucune puissance laser S positive.');
  if (Number.isFinite(maxSetting) && maxSetting > 0 && maxPower > maxSetting) {
    errors.push(`La puissance S${fmt(maxPower)} dépasse le maximum $30=${fmt(maxSetting)}.`);
  }
  return [...new Set(errors)];
}

function checkRasterInput(pixels, pixelWidth, pixelHeight, widthMm, overscanPercent) {
  if (!pixels || pixelWidth < 1 || pixelHeight < 1 || pixels.length !== pixelWidth * pixelHeight * 4) {
    throw new Error('Image raster invalide.');
  }
  if (pixelWidth * pixelHeight > MAX_RASTER_PIXELS) {
    throw new Error(`Image trop détaillée (maximum ${MAX_RASTER_PIXELS.toLocaleString('fr-FR')} pixels). Réduisez la résolution.`);
  }
  if (![widthMm, overscanPercent].every(Number.isFinite) || widthMm <= 0 || overscanPercent < 0 || overscanPercent > 20) {
    throw new Error('La largeur doit être positive et la marge comprise entre 0 et 20 %.');
  }
}

function pixelRgb(pixels, index) {
  const i = index * 4;
  const alpha = pixels[i + 3] / 255;
  return [0, 1, 2].map((c) => pixels[i + c] * alpha + 255 * (1 - alpha));
}

function appendRasterRows(lines, {
  pixelWidth, pixelHeight, widthMm, feed, overscanPercent, powerAt, skipEmptyRows = false,
}) {
  const mmPerPixel = widthMm / pixelWidth;
  const heightMm = pixelHeight * mmPerPixel;
  const overscanMm = feed / 60 * overscanPercent / 100;
  const xAt = (boundary) => fmt(boundary * mmPerPixel);
  const yAt = (row) => fmt(heightMm - (row + 0.5) * mmPerPixel);
  lines.push(`G1F${fmt(feed)}`);
  let scanned = 0;
  for (let row = 0; row < pixelHeight; row++) {
    if (skipEmptyRows) {
      let empty = true;
      for (let x = 0; x < pixelWidth && empty; x++) empty = powerAt(x, row) === 0;
      if (empty) continue;
    }
    const reverse = scanned % 2 === 1;
    scanned++;
    const scanStart = reverse ? widthMm : 0;
    const overscanDirection = reverse ? -1 : 1;
    lines.push(
      'M5',
      `G0X${fmt(scanStart - overscanDirection * overscanMm)}Y${yAt(row)}`,
      'M4S0',
    );
    if (overscanMm > 0) lines.push(`G1X${fmt(scanStart)}S0`);
    let cursor = 0;
    while (cursor < pixelWidth) {
      const x = reverse ? pixelWidth - 1 - cursor : cursor;
      const power = powerAt(x, row);
      let end = cursor + 1;
      while (end < pixelWidth) {
        const nextX = reverse ? pixelWidth - 1 - end : end;
        if (powerAt(nextX, row) !== power) break;
        end++;
      }
      const endX = reverse ? pixelWidth - end : end;
      lines.push(`G1X${xAt(endX)}S${power}`);
      cursor = end;
    }
    if (overscanMm > 0) {
      const scanEnd = reverse ? 0 : widthMm;
      lines.push(`G1X${fmt(scanEnd + overscanDirection * overscanMm)}S0`);
    }
    lines.push('M5');
  }
  return { heightMm, overscanMm, rows: scanned };
}

export function createRasterProgram({
  pixels, pixelWidth, pixelHeight, widthMm, feed, maxPower, invert = false, overscanPercent = 0,
}) {
  checkRasterInput(pixels, pixelWidth, pixelHeight, widthMm, overscanPercent);
  if (![feed, maxPower].every(Number.isFinite) || feed <= 0 || maxPower <= 0) {
    throw new Error('La largeur, l’avance et la puissance doivent être positives ; la marge doit être comprise entre 0 et 20 %.');
  }
  const lines = ['M5', 'G21', 'G90', 'G17', 'G94'];
  const powerAt = (x, y) => {
    const [r, g, b] = pixelRgb(pixels, y * pixelWidth + x);
    const darkness = (255 - (0.2126 * r + 0.7152 * g + 0.0722 * b)) / 255;
    const level = Math.round((invert ? 1 - darkness : darkness) * 15);
    return Math.round((level / 15) * maxPower);
  };
  const { heightMm, overscanMm } = appendRasterRows(lines, {
    pixelWidth, pixelHeight, widthMm, feed, overscanPercent, powerAt,
  });
  return { text: lines.join('\n'), widthMm, heightMm, pixelWidth, pixelHeight, overscanMm };
}

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

export function createLayeredRasterProgram({
  pixels, pixelWidth, pixelHeight, widthMm, layers, overscanPercent = 0,
}) {
  checkRasterInput(pixels, pixelWidth, pixelHeight, widthMm, overscanPercent);
  const palette = [[255, 255, 255], ...layers.map((layer) => hexRgb(layer.color))];
  const owner = new Int8Array(pixelWidth * pixelHeight);
  for (let index = 0; index < owner.length; index++) {
    const rgb = pixelRgb(pixels, index);
    let best = 0;
    let bestDistance = Infinity;
    palette.forEach((color, paletteIndex) => {
      const distance = (rgb[0] - color[0]) ** 2 + (rgb[1] - color[1]) ** 2 + (rgb[2] - color[2]) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = paletteIndex; }
    });
    owner[index] = best - 1;
  }

  const lines = ['M5', 'G21', 'G90', 'G17', 'G94'];
  const used = [];
  let heightMm = pixelHeight * widthMm / pixelWidth;
  let overscanMm = 0;
  layers.forEach((layer, layerIndex) => {
    if (!layer.enabled) return;
    if (!(layer.feed > 0) || !(layer.power > 0) || !Number.isInteger(layer.passes) || layer.passes < 1) {
      throw new Error(`Calque ${layer.id} : avance, puissance et nombre de passes invalides.`);
    }
    const powerAt = (x, y) => (owner[y * pixelWidth + x] === layerIndex ? layer.power : 0);
    for (let pass = 1; pass <= layer.passes; pass++) {
      const mark = lines.length;
      const result = appendRasterRows(lines, {
        pixelWidth, pixelHeight, widthMm, feed: layer.feed, overscanPercent, powerAt, skipEmptyRows: true,
      });
      heightMm = result.heightMm;
      overscanMm = Math.max(overscanMm, result.overscanMm);
      if (!result.rows) {
        lines.splice(mark);
        break;
      }
      if (pass === 1) used.push(layer.id);
    }
  });
  if (!used.length) throw new Error('Aucun pixel de l’image ne correspond à un calque activé.');
  return { text: lines.join('\n'), widthMm, heightMm, pixelWidth, pixelHeight, overscanMm, layers: used };
}

export function isLaserImage(file) {
  return file.type.startsWith('image/') || /\.(svg|png|jpe?g|webp|bmp)$/i.test(file.name);
}

export async function rasterizeImage(file, {
  widthMm, pixelsPerMm, feed, maxPower, invert = false, overscanPercent = 0, layers = null,
}) {
  const isSvg = /\.svg$/i.test(file.name) || file.type === 'image/svg+xml';
  const source = isSvg ? await loadSvgImage(file) : await createImageBitmap(file);
  const bitmap = source.image || source;
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('Dimensions d’image introuvables.');
    const pixelWidth = Math.max(1, Math.round(widthMm * pixelsPerMm));
    const pixelHeight = Math.max(1, Math.round(pixelWidth * bitmap.height / bitmap.width));
    if (pixelWidth * pixelHeight > MAX_RASTER_PIXELS) {
      throw new Error(`Résolution trop élevée (${pixelWidth} × ${pixelHeight}). Réduisez la largeur ou la résolution.`);
    }
    const canvas = document.createElement('canvas');
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Impossible de préparer l’image sur ce navigateur.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, pixelWidth, pixelHeight);
    context.drawImage(bitmap, 0, 0, pixelWidth, pixelHeight);
    const pixels = context.getImageData(0, 0, pixelWidth, pixelHeight).data;
    if (layers) return createLayeredRasterProgram({ pixels, pixelWidth, pixelHeight, widthMm, layers, overscanPercent });
    return createRasterProgram({
      pixels, pixelWidth, pixelHeight, widthMm, feed, maxPower, invert, overscanPercent,
    });
  } finally {
    source.close?.();
  }
}

function isM5(line) {
  const words = tokenize(line);
  return words.some(({ letter, value }) => letter === 'M' && value === 5)
    && !words.some(({ letter, value }) => letter === 'M' && (value === 3 || value === 4));
}

async function sanitizeSvg(file) {
  const documentXml = new DOMParser().parseFromString(await file.text(), 'image/svg+xml');
  if (documentXml.querySelector('parsererror') || documentXml.documentElement.localName !== 'svg') {
    throw new Error('Fichier SVG invalide.');
  }
  for (const element of [...documentXml.getElementsByTagName('*')]) {
    if (['script', 'foreignobject', 'iframe', 'object', 'embed'].includes(element.localName.toLowerCase())) {
      throw new Error('Le SVG contient un élément actif non pris en charge.');
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on')) throw new Error('Le SVG contient un gestionnaire actif non pris en charge.');
      if ((name === 'href' || name.endsWith(':href')) && value && !value.startsWith('#')) {
        throw new Error('Les images liées de l’extérieur ne sont pas prises en charge dans les SVG.');
      }
      if (/url\(\s*(['"]?)(?!#)/i.test(value)) throw new Error('Le SVG contient une ressource externe non prise en charge.');
    }
    if (element.localName.toLowerCase() === 'style'
      && /@import|url\(\s*(['"]?)(?!#)/i.test(element.textContent)) {
      throw new Error('Les styles SVG avec ressources externes ne sont pas pris en charge.');
    }
  }
  return new Blob([new XMLSerializer().serializeToString(documentXml.documentElement)], { type: 'image/svg+xml' });
}

async function loadSvgImage(file) {
  const url = URL.createObjectURL(await sanitizeSvg(file));
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return { image, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw new Error(`Impossible de lire le SVG : ${error.message}`);
  }
}

export function normalizeLaserText(text) {
  const output = [];
  let spindle = 5;
  for (const line of splitProgram(text)) {
    const words = tokenize(line);
    const rapid = words.some(({ letter, value }) => letter === 'G' && value === 0);
    const stopsSpindle = words.some(({ letter, value }) => letter === 'M' && value === 5);
    const endsProgram = words.some(({ letter, value }) => letter === 'M' && (value === 2 || value === 30));
    const restore = rapid && spindle === 4 && !stopsSpindle && !endsProgram;
    if ((rapid && spindle !== 5 && !stopsSpindle)
      || (endsProgram && !stopsSpindle && !isM5(output.at(-1) || ''))) output.push('M5');
    output.push(line);
    for (const { letter, value } of words) {
      if (letter === 'M' && (value === 4 || value === 5)) spindle = value;
    }
    if (restore) output.push('M4');
    else if (endsProgram) spindle = 5;
  }
  return sealLaserProgram(output);
}
