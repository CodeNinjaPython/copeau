import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer, stopServer } from '../server/index.js';

test('le serveur Node accepte le chemin WebSocket partagÃ© avec la version Rust', async () => {
  const server = await startServer({ port: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  try {
    await once(socket, 'open');
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DÃ©lai WebSocket dÃ©passÃ©')), 5000);
      socket.on('message', (raw) => {
        const message = JSON.parse(raw);
        if (message.t === 'reply' && message.id === 1) {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    socket.send(JSON.stringify({ t: 'ports', id: 1 }));
    const message = await reply;
    assert.equal(message.ok, true);
    assert.equal(message.result[0].path, 'simulateur');
  } finally {
    socket.close();
    await stopServer();
  }
});

test('le programme chargÃ© est conservÃ© dans le dossier de donnÃ©es et la version est exposÃ©e', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'copeau-program-'));
  const server = await startServer({ port: 0, dataDir: dir });
  const base = `http://127.0.0.1:${server.address().port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`, { headers: { Origin: base } });
  try {
    await once(socket, 'open');
    const reply = new Promise((resolve) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw);
        if (message.t === 'reply' && message.id === 1) resolve(message);
      });
    });
    socket.send(JSON.stringify({ t: 'load', id: 1, name: 'garde.nc', text: 'G21\nG90' }));
    assert.equal((await reply).ok, true);
    const saved = JSON.parse(await readFile(path.join(dir, 'program.json'), 'utf8'));
    assert.deepEqual(saved, { name: 'garde.nc', text: 'G21\nG90' });
    const version = await (await fetch(`${base}/api/version`)).json();
    assert.match(version.version, /^\d+\.\d+\.\d+/);
  } finally {
    socket.close();
    await stopServer();
    await rm(dir, { recursive: true, force: true });
  }
});
