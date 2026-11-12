#!/usr/bin/env node
/**
 * Configure one bot's role in the local Feishu team config.
 *
 * Usage:
 *   dsh-feishu-team-role --id assistant --name 调研员 \
 *     --mission "搜集并核验公开数据" \
 *     --responsibilities "按维度收集;标注来源;交给撰稿人" \
 *     --handoff-to 撰稿人 --constraints "不编造;不写文件" \
 *     --behavior "先评估任务合理性;缺材料要提出"
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
function has(name) {
  return args.includes(`--${name}`);
}
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
function listArg(name) {
  const value = arg(name);
  if (!value) return undefined;
  return value
    .split(/[;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const configFile = join(dshHome, 'dsh-feishu-team', 'config.json');
if (!existsSync(configFile)) {
  console.error(`config not found: ${configFile}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configFile, 'utf8'));
const accounts = Array.isArray(config.accounts) ? config.accounts : [];
const id = arg('id');
const appId = arg('app-id');
const account = accounts.find((item) => (id && item.id === id) || (appId && item.appId === appId));

if (!account) {
  console.error(`account not found. known ids: ${accounts.map((item) => item.id).join(', ') || '(none)'}`);
  process.exit(1);
}

if (has('show') || args.length === 0) {
  console.log(JSON.stringify({ id: account.id, appId: account.appId, role: account.role }, null, 2));
  process.exit(0);
}

const role = { ...(account.role || {}), version: Number(account.role?.version || 1) + 1 };
if (arg('name')) role.name = arg('name');
if (arg('mission')) role.mission = arg('mission');
for (const [field, key] of [
  ['responsibilities', 'responsibilities'],
  ['inputs', 'inputs'],
  ['outputs', 'outputs'],
  ['handoff-to', 'handoffTo'],
  ['constraints', 'constraints'],
  ['behavior', 'behavior'],
]) {
  const values = listArg(field);
  if (values) role[key] = values;
}
if (arg('escalate-to')) role.escalateTo = arg('escalate-to');

account.role = role;
writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');

console.log(JSON.stringify({ updated: account.id, role }, null, 2));
console.log('已写入配置。重载插件后生效（禁用/启用 bundle，或重启 dsh）。');
