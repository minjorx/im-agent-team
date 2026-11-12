#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

const root = dirname(import.meta.dirname);
const dist = join(root, 'dist');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

run(process.execPath, [join(root, 'scripts', 'build-dsh-package.mjs')]);
run(process.execPath, [join(root, 'runtimes', 'qoder', 'build.mjs')]);

const qoderManifest = JSON.parse(
  readFileSync(join(root, 'runtimes', 'qoder', '.qoder-plugin', 'plugin.json'), 'utf8'),
);
const qoderZipName = `im-agent-team-qoder-plugin-${qoderManifest.version}.zip`;
const qoderZip = join(root, 'runtimes', 'qoder', 'dist', qoderZipName);
const qoderZipOut = join(dist, qoderZipName);
copyFileSync(qoderZip, qoderZipOut);
const qoderHash = createHash('sha256').update(readFileSync(qoderZipOut)).digest('hex');
writeFileSync(`${qoderZipOut}.sha256`, `${qoderHash}  ${basename(qoderZipOut)}\n`, 'utf8');

for (const file of [
  join(dist, `im-agent-team-dsh-${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}.tgz`),
  qoderZipOut,
]) {
  console.log(`${basename(file)}  ${(statSync(file).size / 1024 / 1024).toFixed(2)} MiB`);
}
