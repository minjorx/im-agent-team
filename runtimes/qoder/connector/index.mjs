import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { createInteractionBroker } from './interactions.mjs';
import { createWorker } from '../runtime/worker.mjs';
import { describeQoderRuntime, runQoderSdk, shutdownQoderSdk } from '../runtime/sdk.mjs';

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const stateDir = join(dshHome, 'im-agent-team');
const configFile = join(stateDir, 'config.json');
const appsFile = join(stateDir, 'feishu-apps.json');
const bindingsFile = join(stateDir, 'state.json');
const sessionsFile = join(stateDir, 'qoder-sessions.json');

const runtime = {
  running: false,
  startedAt: 0,
  clients: [],
  accounts: [],
  sessions: { version: 1, byAccount: {} },
  lastError: undefined,
  lastMessageAt: 0,
  runtimeInfo: undefined,
  brokers: [],
};

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function loadConfig() {
  return readJson(configFile, {});
}

function loadApps() {
  return readJson(appsFile, { apps: [] }).apps || [];
}

function saveSessions() {
  writeJson(sessionsFile, runtime.sessions);
}

function accountSettings() {
  const config = loadConfig();
  const qoder = config.qoderConnector || {};
  const envAccounts = process.env.QODER_CONNECTOR_ACCOUNT
    ? process.env.QODER_CONNECTOR_ACCOUNT.split(',').map((item) => item.trim()).filter(Boolean)
    : undefined;
  return {
    accountIds: envAccounts || qoder.accountIds,
    cwd: process.env.QODER_CONNECTOR_CWD || qoder.cwd || process.cwd(),
    model: qoder.model,
    permissionMode: process.env.QODER_CONNECTOR_PERMISSION || qoder.permissionMode || 'plan',
    maxTurns: Number(qoder.maxTurns || 8),
    timeoutMs: Number(qoder.timeoutMs || 180_000),
    allowedTools: qoder.allowedTools,
    disallowedTools: qoder.disallowedTools,
  };
}

function feishuAccounts(settings) {
  const config = loadConfig();
  const apps = loadApps();
  const accounts = (config.accounts || [])
    .filter((account) => account.channel === 'feishu' && account.enabled !== false)
    .filter((account) => !settings.accountIds?.length || settings.accountIds.includes(account.id));
  return accounts.map((account) => {
    const app = apps.find((item) => item.appId === account.appId || item.id === account.id);
    return { ...account, appSecret: app?.appSecret };
  });
}

const tokenCache = new Map();

async function tenantToken(account) {
  const cached = tokenCache.get(account.appId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: account.appId, app_secret: account.appSecret }),
  });
  const data = await response.json();
  if (data.code !== 0) throw new Error(`tenant token failed: ${data.code} ${data.msg}`);
  tokenCache.set(account.appId, { token: data.tenant_access_token, expiresAt: Date.now() + (data.expire || 3600) * 1000 });
  return data.tenant_access_token;
}

async function botInfo(account) {
  const token = await tenantToken(account);
  const response = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (data.code !== 0) throw new Error(`bot info failed: ${data.code} ${data.msg}`);
  return data.bot;
}

async function sendText(account, chatId, text) {
  const token = await tenantToken(account);
  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
  });
  const data = await response.json();
  if (data.code !== 0) throw new Error(`send failed: ${data.code} ${data.msg}`);
  return data.data;
}

async function sendCard(account, chatId, card) {
  const token = await tenantToken(account);
  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  });
  const data = await response.json();
  if (data.code !== 0) throw new Error(`send card failed: ${data.code} ${data.msg}`);
  return data.data;
}

function handleCardAction(account, broker, data) {
  let value =
    data?.action?.value ||
    data?.action?.option?.value ||
    data?.action?.option ||
    {};
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }
  const chatId =
    data?.context?.open_chat_id ||
    data?.open_chat_id ||
    data?.chat_id ||
    data?.context?.chat_id;
  const userId =
    data?.operator?.open_id ||
    data?.operator?.user_id ||
    data?.user_id ||
    data?.operator?.union_id;
  if (!chatId || !value?.id) {
    console.error(`[connector:${account.id}] card action missing chat/value`, data);
    return { toast: { type: 'error', content: '无法识别操作' } };
  }
  try {
    const result = broker.handleCardAction({ chatId, userId, value });
    return { toast: { type: result.ok ? 'success' : 'error', content: result.toast || '已处理' } };
  } catch (error) {
    console.error(`[connector:${account.id}] card action failed`, error?.message || error);
    return { toast: { type: 'error', content: '处理失败' } };
  }
}

function memoryTextFor(account, chatId) {
  const state = readJson(bindingsFile, {});
  const binding = state.bindings?.[`${account.appId}:${chatId}`];
  const entries = binding?.memory?.entries || [];
  if (!entries.length) return '';
  return entries
    .slice(-12)
    .map((entry) => `- [${entry.kind}] ${String(entry.text).replaceAll('\n', ' ').slice(0, 300)}`)
    .join('\n');
}

function accountSessions(account) {
  runtime.sessions.byAccount ||= {};
  const byChat = (runtime.sessions.byAccount[account.appId] ||= {});
  return { byChat };
}

export async function startConnector(overrides = {}) {
  if (runtime.running) return getStatus();
  const settings = { ...accountSettings(), ...overrides };
  const accounts = feishuAccounts(settings);
  if (!accounts.length) {
    throw new Error('没有可用的飞书账号。请先运行 im-agent-team-onboard 创建机器人，或在 config.json 设置 qoderConnector.accountIds。');
  }

  runtime.runtimeInfo = describeQoderRuntime();
  if (!runtime.runtimeInfo.available) {
    throw new Error(runtime.runtimeInfo.error || 'Qoder worker runtime 不可用。');
  }

  runtime.sessions = readJson(sessionsFile, { version: 1, byAccount: {} });
  runtime.clients = [];
  runtime.accounts = [];
  runtime.brokers = [];
  runtime.lastError = undefined;
  runtime.running = true;
  runtime.startedAt = Date.now();

  for (const account of accounts) {
    if (!account.appSecret) {
      runtime.lastError = `${account.id} 缺少 App Secret`;
      continue;
    }
    const info = await botInfo(account);
    const selfOpenId = info.open_id;
    const sessions = accountSessions(account);
    const broker = createInteractionBroker({
      accountId: account.id,
      stateDir,
      sendText: (chatId, text) => sendText(account, chatId, text),
      sendCard: (chatId, card) => sendCard(account, chatId, card),
      logger: console,
      timeoutMs: Number(settings.timeoutMs || 180_000),
    });
    runtime.brokers.push(broker);
    const worker = createWorker({
      account: { ...account, selfOpenId },
      settings,
      sessions,
      saveSessions,
      memoryText: (chatId) => memoryTextFor(account, chatId),
      runQoder: runQoderSdk,
      send: ({ chatId, text }) => sendText(account, chatId, text),
      logger: console,
      broker,
    });

    const client = new Lark.WSClient({
      appId: account.appId,
      appSecret: account.appSecret,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.info,
      autoReconnect: true,
      onError: (error) => {
        runtime.lastError = error?.message || String(error);
        console.error(`[connector:${account.id}] ws error`, error?.message || error);
      },
    });
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => {
        runtime.lastMessageAt = Date.now();
        void worker.handleEvent(data).catch((error) => {
          runtime.lastError = error?.message || String(error);
          console.error(`[connector:${account.id}] handle failed`, error?.message || error);
        });
        return undefined;
      },
      'card.action.trigger': (data) => handleCardAction(account, broker, data),
      'card.action.trigger_v1': (data) => handleCardAction(account, broker, data),
    });
    await client.start({ eventDispatcher: dispatcher });
    runtime.clients.push({ id: account.id, client });
    runtime.accounts.push({ id: account.id, name: account.role?.name || account.id, appId: account.appId, selfOpenId });
    console.log(`[connector:${account.id}] ready as ${info.name || account.id}`);
  }

  return getStatus();
}

export async function stopConnector() {
  for (const { client } of runtime.clients) {
    try {
      await client.close({});
    } catch {
      // ignore
    }
  }
  runtime.clients = [];
  runtime.accounts = [];
  runtime.running = false;
  for (const broker of runtime.brokers) {
    try {
      broker.cancelAll();
    } catch {
      // ignore
    }
  }
  runtime.brokers = [];
  try {
    await shutdownQoderSdk();
  } catch {
    // daemon may already be stopped
  }
  return getStatus();
}

export function getStatus() {
  return {
    running: runtime.running,
    startedAt: runtime.startedAt,
    accounts: runtime.accounts,
    lastError: runtime.lastError,
    lastMessageAt: runtime.lastMessageAt,
    runtime: runtime.runtimeInfo || describeQoderRuntime(),
    pendingInteractions: runtime.brokers.reduce(
      (total, broker) => total + (broker.pendingCount?.() || 0),
      0,
    ),
    configured: feishuAccounts(accountSettings()).map((account) => ({
      id: account.id,
      name: account.role?.name || account.id,
      appId: account.appId,
      hasSecret: Boolean(account.appSecret),
    })),
  };
}
