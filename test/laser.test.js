import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, step } from '../public/js/shared/gcode.js';
import {
  createLayeredRasterProgram, createRasterProgram, normalizeLaserText, validateLaserProgram,
} from '../public/js/laser.js';
import {
  DEFAULT_MACHINES, bedLimitError, defaultLayers, powerLimitErrors, sanitizePreset,
} from '../public/js/laser-profiles.js';

const settings = { 13: '0', 30: '1000', 32: '1' };

test('raster conversion maps dark pixels to power and keeps the laser off around rapids', () => {
  const result = createRasterProgram({
    pixels: Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255]),
    pixelWidth: 2,
    pixelHeight: 1,
    widthMm: 2,
    feed: 100,
    maxPower: 1000,
  });
  const lines = result.text.split('\n');
  assert.equal(lines[0], 'M5');
  assert.equal(lines.at(-1), 'M5');
  assert.ok(lines.includes('G0X0Y0.5'));
  assert.ok(lines.includes('G1X1S1000'));
  assert.ok(lines.includes('G1X2S0'));
  assert.deepEqual(validateLaserProgram(lines, settings), []);
});

test('raster conversion can engrave light pixels when inverted', () => {
  const result = createRasterProgram({
    pixels: Uint8ClampedArray.from([255, 255, 255, 255]),
    pixelWidth: 1,
    pixelHeight: 1,
    widthMm: 1,
    feed: 100,
    maxPower: 500,
    invert: true,
  });
  assert.ok(result.text.includes('G1X1S500'));
});

test('raster overscan adds laser-off acceleration distance on both scan directions', () => {
  const result = createRasterProgram({
    pixels: Uint8ClampedArray.from([
      0, 0, 0, 255,
      0, 0, 0, 255,
    ]),
    pixelWidth: 1, pixelHeight: 2, widthMm: 2, feed: 600, maxPower: 1000, overscanPercent: 5,
  });
  const lines = result.text.split('\n');
  assert.equal(result.overscanMm, 0.5);
  assert.ok(lines.includes('G0X-0.5Y3'));
  assert.ok(lines.includes('G0X2.5Y1'));
  assert.equal(lines.filter((line) => line === 'G1X0S0').length, 1);
  assert.equal(lines.filter((line) => line === 'G1X2S0').length, 1);
  assert.equal(lines.filter((line) => line === 'G1X2.5S0').length, 1);
  assert.equal(lines.filter((line) => line === 'G1X-0.5S0').length, 1);
});

test('laser G-code normalization adds M5 before rapid moves and at the end', () => {
  const lines = normalizeLaserText('M4S400\nG1X10\nG0X0\nG1X5\nM30');
  assert.equal(lines[0], 'M5');
  assert.equal(lines[3], 'M5');
  assert.equal(lines[5], 'M4');
  assert.equal(lines[7], 'M5');
  assert.equal(lines[8], 'M30');
  assert.equal(lines.at(-1), 'M5');
  assert.deepEqual(validateLaserProgram(lines, settings), []);
  assert.deepEqual(normalizeLaserText(lines.join('\n')), lines);
});

test('raster pixels cover their full width in both scan directions', () => {
  const result = createRasterProgram({
    pixels: Uint8ClampedArray.from([
      0, 0, 0, 255, 255, 255, 255, 255,
      0, 0, 0, 255, 255, 255, 255, 255,
    ]),
    pixelWidth: 2, pixelHeight: 2, widthMm: 2, feed: 100, maxPower: 1000,
  });
  const state = createState();
  const segments = [];
  for (const line of result.text.split('\n')) step(state, line, (segment) => {
    if (segment.power) segments.push([segment.from.X, segment.to.X]);
  });
  assert.deepEqual(segments, [[0, 1], [1, 0]]);
});

test('laser preflight rejects constant power, Z motion, unsafe rapids, and excess power', () => {
  const lines = ['M5', 'M3S1200', 'G1Z1S1200', 'G0X2'];
  const errors = validateLaserProgram(lines, settings).join(' ');
  assert.match(errors, /M3/);
  assert.match(errors, /Z/);
  assert.match(errors, /M4/);
  assert.match(errors, /\$30/);
});

test('laser preflight requires millimeter status and rejects unvisualized coordinate moves', () => {
  const program = ['G21', 'G90', 'M4S100', 'G1X1', 'M5'];
  assert.match(validateLaserProgram(program, { ...settings, 13: '1' }).join(' '), /\$13=0/);
  for (const command of ['G28', 'G30', 'G53G0X1', 'G10L2P1X0Y0', 'G92X0Y0']) {
    const errors = validateLaserProgram(['M4S100', 'G1X1', command, 'M5'], settings).join(' ');
    assert.match(errors, /G10, G28, G30, G53 et G92/);
  }
  assert.deepEqual(validateLaserProgram(['G21', 'G90', 'G54', 'M4S100', 'G1X1', 'M5'], settings), []);
});

test('G-code preview carries dynamic laser power only for M4 moves', () => {
  const state = createState();
  const segments = [];
  step(state, 'M4S350');
  step(state, 'G1X2F100', (segment) => segments.push(segment));
  step(state, 'M3S500');
  step(state, 'G1X4', (segment) => segments.push(segment));
  assert.equal(segments[0].power, 350);
  assert.equal(segments[1].power, 0);
});

test('color layers engrave only matching pixels with their own feed, power, and passes', () => {
  const layers = defaultLayers().map((layer) => {
    if (layer.id === '00') return { ...layer, enabled: true, feed: 600, power: 300, passes: 1 };
    if (layer.id === '02') return { ...layer, enabled: true, feed: 1200, power: 800, passes: 2 };
    return { ...layer, enabled: false };
  });
  const result = createLayeredRasterProgram({
    pixels: Uint8ClampedArray.from([
      0, 0, 0, 255, 250, 10, 10, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 0, 0, 250, 255, 255, 255, 255, 255,
    ]),
    pixelWidth: 3, pixelHeight: 2, widthMm: 3, layers,
  });
  const lines = result.text.split('\n');
  assert.deepEqual(result.layers, ['00', '02']);
  assert.ok(lines.includes('G1F600'));
  assert.equal(lines.filter((line) => line === 'G1F1200').length, 2);
  assert.ok(lines.includes('G1X1S300'));
  assert.equal(lines.filter((line) => line === 'G1X2S800').length, 2);
  assert.ok(!lines.some((line) => /Y0\.5$/.test(line)), 'blue layer row is disabled and skipped');
  assert.deepEqual(validateLaserProgram(lines, settings), []);
  assert.throws(() => createLayeredRasterProgram({
    pixels: Uint8ClampedArray.from([0, 0, 250, 255]), pixelWidth: 1, pixelHeight: 1, widthMm: 1, layers,
  }), /Aucun pixel/);
});

test('machine profiles cap power and bed size, and presets reject invalid values', () => {
  const emblaser = DEFAULT_MACHINES.find((machine) => machine.id === 'emblaser-2');
  const layers = defaultLayers();
  assert.match(powerLimitErrors({ power: 1200, useLayers: false, layers }, emblaser).join(' '), /S1200/);
  layers[1] = { ...layers[1], enabled: true, power: 1500 };
  assert.match(powerLimitErrors({ power: 100, useLayers: true, layers }, emblaser).join(' '), /Calque 01/);
  assert.equal(bedLimitError({ widthMm: 490, heightMm: 300, overscanMm: 5 }, emblaser), null);
  assert.match(bedLimitError({ widthMm: 495, heightMm: 100, overscanMm: 5 }, emblaser), /dépasse le plateau/);
  const preset = { name: 'Contreplaqué', resolution: 5, feed: 2000, power: 400, overscan: 5, layers };
  assert.equal(sanitizePreset(preset).layers.length, 8);
  assert.throws(() => sanitizePreset({ ...preset, overscan: 25 }), /Préréglage invalide/);
  assert.throws(() => sanitizePreset({ ...preset, name: ' ' }), /nom/);
});
