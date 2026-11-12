#!/usr/bin/env node
/**
 * Minimal zero-dependency MCP server for the im-agent-team Qoder plugin.
 *
 * It is the control plane the @feishu agent talks to:
 *   - feishu_status: read local im-agent-team config/state and onboarding progress
 *   - feishu_onboard: start/report the official QR onboarding flow
 *   - feishu_connect: start the connector, auto-starting onboarding when needed
 *   - feishu_send: send a text message through the configured Feishu bot
 *   - feishu_disconnect: stop the connector
 *
 * The Feishu WebSocket connector runs in-process via connector/index.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { createOnboardManager } from '../connector/onboard.mjs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const stateDir = join(dshHome, 'im-agent-team');
const configFile = join(stateDir, 'config.json');
const appsFile = join(stateDir, 'feishu-apps.json');
const stateFile = join(stateDir, 'state.json');
const onboard = createOnboardManager({ stateDir, logger: console });

const TOOLS = [
  {
    name: 'feishu_status',
    description: '查看本机 im-agent-team 的飞书机器人配置、扫码接入进度、绑定群和连接器状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'feishu_onboard',
    description: '首次创建/绑定飞书机器人：启动官方扫码授权并返回授权链接；再次调用查询进度。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '机器人显示名，默认 Qoder Agent' },
        id: { type: 'string', description: '本地账号 id，默认 qoder' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'feishu_connect',
    description: '连接当前 Qoder 到飞书机器人；未配置时自动启动扫码 onboarding。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '机器人显示名，默认 Qoder Agent' },
        id: { type: 'string', description: '本地账号 id，默认 qoder' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'feishu_send',
    description: '通过已配置的飞书机器人发送一条文本消息。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发送的文本' },
        chatId: { type: 'string', description: '目标群/会话 id；默认使用配置里的第一个群' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'feishu_disconnect',
    description: '说明如何断开/停止飞书连接器。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function loadConfig() {
  return readJson(configFile);
}

function loadState() {
  return readJson(stateFile);
}

function apps() {
  return readJson(appsFile)?.apps || [];
}

function accountSummary() {
  const config = loadConfig();
  const accounts = config?.accounts || [];
  if (!accounts.length) return undefined;
  return accounts.map((account) => {
    const app = apps().find((item) => item.appId === account.appId || item.id === account.id);
    return {
      id: account.id,
      name: account.role?.name || account.id,
      appId: account.appId || app?.appId,
      chats: account.chatIds || [],
      runtime: account.runtime || 'dsh-native',
    };
  });
}

function statusText() {
  return statusTextAsync();
}

async function statusTextAsync() {
  const accounts = accountSummary();
  const state = loadState();
  const bindings = Object.keys(state?.bindings || {}).length;
  const lines = [];
  if (!accounts) {
    lines.push(
      '🔴 尚未配置飞书机器人。',
      `配置目录：${stateDir}`,
      '',
      '下一步：调用 feishu_connect（或 feishu_onboard）启动官方扫码；把返回的授权链接交给用户打开。',
    );
  } else {
    lines.push(
      `🟡 已配置 ${accounts.length} 个飞书机器人。`,
      ...accounts.map((account) => `- ${account.name} (${account.id}) · ${account.appId} · 群：${account.chats.join(', ') || '未绑定'}`),
      `本地状态 binding 数：${bindings}`,
    );
  }

  const onboardState = onboard.status();
  if (onboardState.status !== 'idle') {
    lines.push('', `扫码接入：${onboardState.status}${onboardState.id ? ` (${onboardState.id})` : ''}`);
    if (onboardState.url) lines.push(`授权链接：${onboardState.url}`);
    if (onboardState.expireIn) lines.push(`有效期：约 ${onboardState.expireIn} 秒`);
    if (onboardState.error) lines.push(`错误：${onboardState.error}`);
  }
  try {
    const { getStatus } = await connector();
    const status = getStatus();
    lines.push(
      '',
      `连接器：${status.running ? '🟢 running' : '⚪ stopped'}`,
      ...status.accounts.map((account) => `- ${account.name} (${account.id}) · ${account.appId}`),
      `Qoder 运行时：${status.runtime?.mode || 'unknown'}${status.runtime?.available === false ? '（不可用）' : ''}`,
      ...(status.runtime?.version
        ? [`- worker ${status.runtime.version}${status.runtime.target ? ` · ${status.runtime.target}` : ''}`]
        : []),
      ...(status.runtime?.available === false && status.runtime?.error
        ? [`运行时错误：${status.runtime.error}`]
        : []),
      ...(status.pendingInteractions ? [`待处理交互：${status.pendingInteractions}`] : []),
    );
    if (status.lastError) lines.push(`最近错误：${status.lastError}`);
  } catch (error) {
    lines.push('', `连接器：不可用（${error?.message || error}）`);
  }
  return lines.join('\n');
}

async function tenantToken(app) {
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret }),
  });
  const data = await response.json();
  if (data.code !== 0) throw new Error(`tenant token failed: ${data.code} ${data.msg}`);
  return data.tenant_access_token;
}

async function sendText({ text, chatId }) {
  const accounts = accountSummary();
  if (!accounts?.length) throw new Error('尚未配置飞书机器人，请先运行 im-agent-team-onboard。');
  const account = accounts.find((item) => item.chats.includes(chatId)) || accounts[0];
  const target = chatId || account.chats[0];
  if (!target) throw new Error('配置里没有 chatId，无法发送。');
  const app = apps().find((item) => item.appId === account.appId || item.id === account.id);
  if (!app?.appSecret) throw new Error(`找不到 ${account.id} 的 App Secret。`);
  const token = await tenantToken(app);
  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ receive_id: target, msg_type: 'text', content: JSON.stringify({ text }) }),
  });
  const data = await response.json();
  if (data.code !== 0) throw new Error(`send failed: ${data.code} ${data.msg}`);
  return `已发送到 ${target}（message_id: ${data.data?.message_id || 'unknown'}）`;
}

let connectorModule;
async function connector() {
  connectorModule ||= await import('../connector/index.mjs');
  return connectorModule;
}

async function connectText({ name = 'Qoder Agent', id = 'qoder' } = {}) {
  const config = loadConfig();
  const target = (config?.accounts || []).find((account) => account.id === id);
  if (target) {
    try {
      const { startConnector } = await connector();
      const status = await startConnector({ accountIds: [id] });
      return [
        `🟢 已启动飞书连接器：${id}`,
        ...status.accounts.map((account) => `- ${account.name} (${account.id}) · ${account.appId}`),
        '',
        '现在到飞书群里 @ 这个机器人即可。回复会由 Qoder 生成并回到飞书。',
      ].join('\n');
    } catch (error) {
      return `🔴 启动连接器失败：${error?.message || error}`;
    }
  }

  const state = await onboard.start({ name, id });
  if (state.status === 'done') {
    try {
      const { startConnector } = await connector();
      const status = await startConnector({ accountIds: [id] });
      return [
        `🟢 已创建并启动飞书连接器：${id}`,
        ...status.accounts.map((account) => `- ${account.name} (${account.id}) · ${account.appId}`),
        '',
        '现在到飞书群里 @ 这个机器人即可。',
      ].join('\n');
    } catch (error) {
      return `🟢 机器人已创建，但连接器启动失败：${error?.message || error}\n请再次调用 feishu_connect。`;
    }
  }
  if (state.status === 'waiting') {
    return [
      `🟡 正在为 ${id} 创建飞书机器人。请打开下面的链接完成扫码授权：`,
      state.url,
      '',
      '扫码完成后告诉我，或再次调用 feishu_status；确认后我会启动连接器。',
      '不需要在对话里粘贴 App Secret。',
    ].join('\n');
  }
  return formatOnboardState(state);
}

function formatOnboardState(state) {
  if (!state) return '🔴 无法读取扫码接入状态。';
  switch (state.status) {
    case 'waiting':
      return [
        `🟡 请打开下面的链接完成飞书扫码授权（${state.id}）：`,
        state.url,
        '',
        `有效期约 ${state.expireIn || '未知'} 秒。扫码完成后告诉我，或再次调用 feishu_status。`,
        '不需要在对话里粘贴 App Secret。',
      ].join('\n');
    case 'done':
      if (state.existing) {
        return `🟢 已存在账号 ${state.id || ''} (${state.appId || ''})。现在调用 feishu_connect 启动连接器。`;
      }
      return [
        `🟢 已创建飞书机器人：${state.id} · ${state.appId}`,
        state.chatId
          ? `测试群：${state.chatName || ''} (${state.chatId})`
          : '未创建测试群；把机器人拉进群后 @ 它即可。',
        '现在调用 feishu_connect 启动连接器。',
      ].join('\n');
    case 'error':
      return `🔴 扫码接入失败：${state.error}\n可再次调用 feishu_onboard 或 feishu_connect 重试。`;
    case 'saving':
      return '🟡 已扫码，正在保存凭据并创建测试群，请稍后再次调用 feishu_status。';
    default:
      return `🟡 扫码接入状态：${state.status}，请稍后再次调用 feishu_status。`;
  }
}

async function onboardText({ name = 'Qoder Agent', id = 'qoder' } = {}) {
  const state = await onboard.start({ name, id });
  return formatOnboardState(state);
}

async function callTool(name, args) {
  switch (name) {
    case 'feishu_status':
      return await statusText();
    case 'feishu_onboard':
      return await onboardText(args);
    case 'feishu_connect':
      return await connectText(args);
    case 'feishu_send':
      return sendText(args);
    case 'feishu_disconnect': {
      try {
        const { stopConnector } = await connector();
        const status = await stopConnector();
        return `连接器已停止（running=${status.running}）。配置未删除。`;
      } catch (error) {
        return `停止连接器失败：${error?.message || error}`;
      }
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (method === undefined) return;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'im-agent-team', version: packageJson.version },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    try {
      const text = await callTool(params?.name, params?.arguments || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `错误：${error?.message || error}` }], isError: true },
      });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});

console.error('[im-agent-team] MCP server ready');
