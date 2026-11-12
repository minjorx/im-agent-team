#!/usr/bin/env node
/**
 * Build a self-contained Qoder plugin ZIP.
 *
 * pnpm's node_modules uses absolute symlinks, which do not survive being copied
 * into the plugin cache or a ZIP, so production dependencies are reinstalled
 * with npm into the staging directory.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = import.meta.dirname;
const manifest = JSON.parse(readFileSync(join(root, '.qoder-plugin/plugin.json'), 'utf8'));
const version = manifest.version || '0.1.0';
const dist = join(root, 'dist');
const stage = join(dist, 'qoder-plugin');
const zip = join(dist, `im-agent-team-qoder-plugin-${version}.zip`);

rmSync(stage, { recursive: true, force: true });
rmSync(zip, { force: true });
mkdirSync(stage, { recursive: true });

const entries = [
  '.qoder-plugin',
  'agents',
  'commands',
  'skills',
  'bin',
  'connector',
  'runtime',
  'package.json',
  '.mcp.json',
  'README.md',
];

for (const entry of entries) {
  const source = join(root, entry);
  if (!existsSync(source)) {
    throw new Error(`missing required plugin entry: ${entry}`);
  }
  cpSync(source, join(stage, entry), { recursive: true });
}

const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
  'install',
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
], {
  cwd: stage,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  // The bundled plugin must not download a qodercli binary; it uses the
  // worker runtime shipped with the installed Qoder app.
  env: { ...process.env, QODER_SKIP_DOWNLOAD: '1' },
});

if (npm.error) throw npm.error;
if (npm.status !== 0) throw new Error(`npm install failed with exit code ${npm.status}`);

// The published plugin is self-contained: dependencies live in node_modules,
// so the manifest no longer declares runtime dependencies.
const stagedPkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
delete stagedPkg.dependencies;
writeFileSync(join(stage, 'package.json'), JSON.stringify(stagedPkg, null, 2), 'utf8');
rmSync(join(stage, 'package-lock.json'), { force: true });

if (process.platform === 'win32') {
  const tarExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const result = spawnSync(tarExe, ['-a', '-cf', zip, '-C', stage, '.'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`zip failed with exit code ${result.status}`);
} else {
  const result = spawnSync('zip', ['-qr', zip, '.'], { cwd: stage, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`zip failed with exit code ${result.status}`);
}

const size = statSync(zip).size;
console.log(`built ${zip}`);
console.log(`size ${(size / 1024 / 1024).toFixed(2)} MiB`);
console.log('upload this ZIP in Qoder: Extensions → Plugins → Add Plugins → Upload Plugin');
