import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_SCOPES = [
  'im:message:send_as_bot',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:message.group_at_msg.include_bot:readonly',
  'application:bot.basic_info:read',
  'im:chat:readonly',
  'im:chat',
  'im:chat.members:write_only',
];

const DEFAULT_EVENTS = [
  'im.message.receive_v1',
  'im.chat.member.bot.added_v1',
  'im.chat.member.bot.deleted_v1',
];

const DEFAULT_CALLBACKS = ['card.action.trigger'];

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

async function tenantToken(appId, appSecret) {
  const response = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
  );
  const data = await response.json();
  if (data.code !== 0) throw new Error(`tenant token failed: ${data.code} ${data.msg}`);
  return data.tenant_access_token;
}

async function defaultCreateGroup({ appId, appSecret, name, userOpenId }) {
  const token = await tenantToken(appId, appSecret);
  const response = await fetch(
    'https://open.feishu.cn/open-apis/im/v1/chats?user_id_type=open_id',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        name: `${name} 测试群`,
        description: 'im-agent-team 扫码接入测试群',
        chat_type: 'private',
        chat_mode: 'group',
        user_id_list: [userOpenId],
      }),
    },
  );
  const data = await response.json();
  if (data.code !== 0) throw new Error(`create group failed: ${data.code} ${data.msg}`);
  return { chatId: data.data.chat_id, name: data.data.name };
}

async function defaultRegisterApp(options) {
  const lark = await import('@larksuiteoapi/node-sdk');
  return lark.registerApp(options);
}

/**
 * Official Feishu app onboarding shared by the DSH runtime and CLI.
 * The manager returns as soon as the QR URL is ready and keeps the device
 * authorization flow running in the background.
 */
export function createFeishuOnboardManager({
  stateDir,
  logger = console,
  registerApp,
  createGroup,
  accountDefaults = {},
  qrWaitMs = 15_000,
  now = () => Date.now(),
}) {
  const appsFile = join(stateDir, 'feishu-apps.json');
  const configFile = join(stateDir, 'config.json');
  const resultFile = join(stateDir, 'onboard-result.json');

  let state = { status: 'idle' };
  let task;

  function snapshot() {
    return { ...state };
  }

  function existingAccount(id) {
    const config = readJson(configFile, {});
    return (config.accounts || []).find((account) => account.id === id);
  }

  function saveApp(app) {
    const data = readJson(appsFile, { apps: [] });
    if (!Array.isArray(data.apps)) data.apps = [];
    data.apps = data.apps.filter(
      (item) => item.id !== app.id && item.appId !== app.appId,
    );
    data.apps.push(app);
    writeJson(appsFile, data);
  }

  function appendAccount(account) {
    const config = readJson(configFile, { accounts: [] });
    if (!Array.isArray(config.accounts)) config.accounts = [];
    config.accounts = config.accounts.filter(
      (item) => item.id !== account.id && item.appId !== account.appId,
    );
    config.accounts.push(account);
    writeJson(configFile, config);
  }

  async function start({ name = 'DSH Assistant', id = 'assistant' } = {}) {
    if (['starting', 'waiting', 'saving'].includes(state.status)) return snapshot();

    const account = existingAccount(id);
    if (account) {
      state = {
        status: 'done',
        existing: true,
        id: account.id,
        appId: account.appId,
        chatId: account.chatIds?.[0],
        account: {
          id: account.id,
          appId: account.appId,
          chatIds: account.chatIds || [],
        },
      };
      return snapshot();
    }

    state = { status: 'starting', name, id, startedAt: now() };

    let resolveQr;
    const qrReady = new Promise((resolve) => {
      resolveQr = resolve;
    });

    const register = registerApp || defaultRegisterApp;
    const create = createGroup || defaultCreateGroup;

    task = (async () => {
      try {
        const result = await register({
          createOnly: true,
          appPreset: {
            name,
            desc: 'im-agent-team 多机器人协作：扫码创建的飞书机器人。',
          },
          addons: {
            scopes: { tenant: DEFAULT_SCOPES },
            events: { items: { tenant: DEFAULT_EVENTS } },
            callbacks: { items: DEFAULT_CALLBACKS },
          },
          onQRCodeReady(info) {
            state = {
              ...state,
              status: 'waiting',
              url: info?.url,
              expireIn: info?.expireIn,
              qrReadyAt: now(),
            };
            resolveQr(snapshot());
          },
          onStatusChange(info) {
            state = {
              ...state,
              lastStatus: info?.status,
              ...(info?.interval ? { interval: info.interval } : {}),
            };
          },
        });

        state = { status: 'saving', name, id, appId: result.client_id };
        saveApp({
          id,
          name,
          appId: result.client_id,
          appSecret: result.client_secret,
        });

        const userOpenId = result.user_info?.open_id;
        let chatId;
        let chatName;
        if (create && userOpenId) {
          try {
            const group = await create({
              appId: result.client_id,
              appSecret: result.client_secret,
              name,
              userOpenId,
            });
            chatId = group?.chatId;
            chatName = group?.name;
          } catch (error) {
            logger.error?.('[onboard] create group failed', error?.message || error);
          }
        }

        const accountEntry = {
          ...accountDefaults,
          id,
          channel: 'feishu',
          appId: result.client_id,
          chatIds: chatId ? [chatId] : [],
          ...(chatName ? { chatName } : {}),
          role: {
            name,
            mission: '由扫码接入的飞书机器人，等待在群里分配角色',
          },
        };
        appendAccount(accountEntry);
        writeJson(resultFile, {
          id,
          name,
          appId: result.client_id,
          chatId,
          userOpenId,
          at: new Date().toISOString(),
        });

        state = {
          status: 'done',
          name,
          id,
          appId: result.client_id,
          userOpenId,
          chatId,
          chatName,
          account: {
            id,
            appId: result.client_id,
            chatIds: accountEntry.chatIds,
          },
        };
        return snapshot();
      } catch (error) {
        state = {
          ...state,
          status: 'error',
          error: error?.description || error?.message || String(error),
        };
        logger.error?.('[onboard] failed', state.error);
        resolveQr(snapshot());
        return snapshot();
      }
    })();

    let qrTimer;
    await Promise.race([
      qrReady,
      new Promise((resolve) => {
        qrTimer = setTimeout(resolve, qrWaitMs);
      }),
    ]);
    clearTimeout(qrTimer);
    return snapshot();
  }

  function status() {
    return snapshot();
  }

  function whenDone() {
    return task;
  }

  function reset() {
    if (state.status === 'error') state = { status: 'idle' };
  }

  return { start, status, whenDone, reset };
}
