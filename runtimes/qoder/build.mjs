#!/usr/bin/env node
/**
 * Build a self-contained Qoder plugin ZIP.
 *
 * The plugin source imports its Qoder runtime from ../runtime, so the staged
 * package simply keeps connector/ and runtime/ as siblings. node_modules is
 * copied so the plugin works without running pnpm on the user's machine.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
  'node_modules',
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

const result = spawnSync('tar', ['-a', '-cf', zip, '-C', stage, '.'], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`zip failed with exit code ${result.status}`);

const size = statSync(zip).size;
console.log(`built ${zip}`);
console.log(`size ${(size / 1024 / 1024).toFixed(2)} MiB`);
console.log('upload this ZIP in Qoder: Extensions → Plugins → Add Plugins → Upload Plugin');
