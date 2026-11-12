#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

const root = dirname(import.meta.dirname);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const dist = join(root, 'dist');
const build = join(dist, '.dsh-build');
const stage = join(build, 'package');
const tgz = join(dist, `im-agent-team-dsh-${version}.tgz`);

rmSync(build, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
mkdirSync(stage, { recursive: true });

const entries = [
  'index.js',
  'cordis.patch.yml',
  'lib',
  'runtimes/dsh',
  'bin',
  'locale',
  'icon.svg',
  'README.md',
  'LICENSE',
  'package.json',
];

for (const entry of entries) {
  const source = join(root, entry);
  if (!existsSync(source)) throw new Error(`missing required package entry: ${entry}`);
  cpSync(source, join(stage, entry), { recursive: true });
}

const npm = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  {
    cwd: stage,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, QODER_SKIP_DOWNLOAD: '1' },
  },
);
if (npm.error) throw npm.error;
if (npm.status !== 0) throw new Error(`npm install failed with exit code ${npm.status}`);

rmSync(join(stage, 'package-lock.json'), { force: true });

// The published package is self-contained: dependencies are vendored under
// node_modules, so the DSH plugin manager does not need to resolve them.
const stagedPkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
delete stagedPkg.dependencies;
delete stagedPkg.bundledDependencies;
writeFileSync(join(stage, 'package.json'), JSON.stringify(stagedPkg, null, 2), 'utf8');

rmSync(tgz, { force: true });
const tarExe =
  process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
const tar = spawnSync(tarExe, ['-czf', tgz, '-C', build, 'package'], {
  cwd: root,
  stdio: 'inherit',
});
if (tar.error) throw tar.error;
if (tar.status !== 0) throw new Error(`tar failed with exit code ${tar.status}`);

const hash = createHash('sha256').update(readFileSync(tgz)).digest('hex');
writeFileSync(`${tgz}.sha256`, `${hash}  ${basename(tgz)}\n`, 'utf8');
const size = statSync(tgz).size;

rmSync(build, { recursive: true, force: true });

console.log(`built ${tgz}`);
console.log(`size ${(size / 1024 / 1024).toFixed(2)} MiB`);
console.log(`sha256 ${hash}`);
