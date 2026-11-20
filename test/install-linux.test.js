import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install-linux.sh', import.meta.url));
const skipOnNonLinux = process.platform !== 'linux';

test('installateur Linux : refuse les arguments invalides', { skip: skipOnNonLinux }, () => {
  const missing = spawnSync('/bin/sh', [installer], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Utilisation/);

  const wrongFormat = spawnSync('/bin/sh', [installer, 'Copeau.AppImage'], { encoding: 'utf8' });
  assert.equal(wrongFormat.status, 2);
  assert.match(wrongFormat.stderr, /paquet \.deb/);

  const absent = spawnSync('/bin/sh', [installer, 'absent.deb'], { encoding: 'utf8' });
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /introuvable/);
});

test('installateur Linux : utilise apt avec un chemin absolu, avec ou sans sudo', { skip: skipOnNonLinux }, (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'copeau-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const command = (name, body) => writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  command('apt-get', 'printf "<%s>\\n" "$@"');
  command('sudo', 'printf "sudo\\n"\nexec "$@"');
  const packageName = 'Copeau essai.deb';
  writeFileSync(path.join(dir, packageName), '');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

  command('id', 'printf "1000\\n"');
  const user = spawnSync('/bin/sh', [installer, packageName], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(user.status, 0, user.stderr);
  assert.equal(user.stdout, `sudo\n<install>\n<-->\n<${path.join(dir, packageName)}>\n`);

  command('id', 'printf "0\\n"');
  const root = spawnSync('/bin/sh', [installer, packageName], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(root.status, 0, root.stderr);
  assert.equal(root.stdout, `<install>\n<-->\n<${path.join(dir, packageName)}>\n`);
});
