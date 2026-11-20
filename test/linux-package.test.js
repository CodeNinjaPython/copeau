import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const resources = process.env.COPEAU_PACKAGED_RESOURCES;

test('paquet Linux : ressources, port série, simulateur et données', {
  skip: !resources,
  timeout: 30000,
}, async () => {
  const resourceDir = path.resolve(resources);
  const appDir = path.join(resourceDir, 'app.asar');
  const require = createRequire(import.meta.url);
  const { SerialPort } = require(path.join(appDir, 'node_modules/serialport'));
  const WebSocket = require(path.join(appDir, 'node_modules/ws'));
  const { startServer, stopServer } = await import(pathToFileURL(path.join(appDir, 'server/index.js')).href);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'copeau-packaged-'));
  let started = false;
  let ws;

  try {
    assert.equal(existsSync(path.join(appDir, 'data')), false);
    assert.ok(Array.isArray(await SerialPort.list()));
    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      threeAddonsDir: path.join(resourceDir, 'three-addons'),
    });
    started = true;
    const url = `http://127.0.0.1:${server.address().port}`;

    for (const [resource, expected] of [
      ['/', /Copeau/],
      ['/manuel', /Manuel Copeau/],
      ['/vendor/three/build/three.module.js', /three/i],
      ['/vendor/three/examples/jsm/controls/OrbitControls.js', /OrbitControls/],
    ]) {
      const response = await fetch(`${url}${resource}`, { signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200, resource);
      assert.match(await response.text(), expected, resource);
    }

    ws = new WebSocket(url.replace('http:', 'ws:'));
    await once(ws, 'open');
    let id = 0;
    const request = (type, payload = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => {
        ws.off('message', onMessage);
        reject(new Error(`Délai dépassé pour ${type}`));
      }, 5000);
      const onMessage = (raw) => {
        const reply = JSON.parse(raw.toString());
        if (reply.t !== 'reply' || reply.id !== requestId) return;
        clearTimeout(timeout);
        ws.off('message', onMessage);
        if (reply.ok) resolve(reply.result);
        else reject(new Error(reply.error));
      };
      ws.on('message', onMessage);
      ws.send(JSON.stringify({ t: type, id: requestId, ...payload }), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        ws.off('message', onMessage);
        reject(error);
      });
    });

    const ports = await request('ports');
    assert.ok(ports.some((port) => port.path === 'simulateur'));
    await request('connect', { port: 'simulateur' });
    const macros = [{ id: 'test', name: 'Essai', gcode: 'G0 X0' }];
    await request('saveMacros', { list: macros });
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'macros.json'), 'utf8')), macros);
  } finally {
    ws?.terminate();
    if (started) await stopServer();
    await rm(dataDir, { recursive: true, force: true });
  }
});
