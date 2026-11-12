#!/usr/bin/env node
/**
 * Official Feishu one-click app onboarding (OAuth 2.0 Device Authorization Grant).
 *
 * Usage:
 *   dsh-feishu-team-onboard --name "DSH Assistant" --id assistant
 *
 * Writes the QR image and the creation result under $DSH_HOME/dsh-feishu-team,
 * stores credentials there, creates a test group with the scanning user, and
 * appends the new account to config.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const name = arg('name', 'DSH Assistant');
const id = arg('id', 'assistant');
const createGroup = args.includes('--no-group') ? false : true;
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const stateDir = join(dshHome, 'dsh-feishu-team');
const appsFile = join(stateDir, 'feishu-apps.json');
const configFile = join(stateDir, 'config.json');
const qrFile = join(stateDir, 'onboard-qr.png');
mkdirSync(stateDir, { recursive: true });

const lark = await import('@larksuiteoapi/node-sdk');

function saveApp(app) {
  let data = { apps: [] };
  if (existsSync(appsFile)) {
    try {
      data = JSON.parse(readFileSync(appsFile, 'utf8'));
      if (!Array.isArray(data.apps)) data.apps = [];
    } catch {
      data = { apps: [] };
    }
  }
  data.apps = data.apps.filter((item) => item.id !== app.id && item.appId !== app.appId);
  data.apps.push(app);
  writeFileSync(appsFile, JSON.stringify(data, null, 2), 'utf8');
}

function appendAccount(account) {
  let config = { accounts: [] };
  if (existsSync(configFile)) {
    try {
      config = JSON.parse(readFileSync(configFile, 'utf8'));
      if (!Array.isArray(config.accounts)) config.accounts = [];
    } catch {
      config = { accounts: [] };
    }
  }
  config.accounts = config.accounts.filter((item) => item.id !== account.id && item.appId !== account.appId);
  config.accounts.push(account);
  writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
}

async function tenantToken(appId, appSecret) {
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await response.json();
  if (data.code !== 0) throw new Error(`tenant token failed: ${data.code} ${data.msg}`);
  return data.tenant_access_token;
}

(async () => {
  try {
    const result = await lark.registerApp({
      createOnly: true,
      appPreset: {
        name,
        desc: 'DeepSeek Harness 多机器人协作适配层：扫码创建的飞书机器人。',
      },
      addons: {
        scopes: {
          tenant: [
            'im:message:send_as_bot',
            'im:message.p2p_msg:readonly',
            'im:message.group_at_msg:readonly',
            'im:message.group_at_msg.include_bot:readonly',
            'application:bot.basic_info:read',
            'im:chat:readonly',
            'im:chat',
            'im:chat.members:write_only',
          ],
        },
        events: {
          items: {
            tenant: ['im.message.receive_v1', 'im.chat.member.bot.added_v1', 'im.chat.member.bot.deleted_v1'],
          },
        },
        callbacks: { items: ['card.action.trigger'] },
      },
      async onQRCodeReady(info) {
        console.log('QR_URL=' + info.url);
        console.log('QR_EXPIRE=' + info.expireIn);
        await QRCode.toFile(qrFile, info.url, { width: 520, margin: 2 });
        console.log('QR_FILE=' + qrFile);
      },
      onStatusChange(info) {
        console.log('STATUS=' + info.status + (info.interval ? ` interval=${info.interval}` : ''));
      },
    });

    console.log('APP_ID=' + result.client_id);
    const userOpenId = result.user_info?.open_id;
    if (userOpenId) console.log('USER_OPEN_ID=' + userOpenId);

    saveApp({ id, name, appId: result.client_id, appSecret: result.client_secret });

    let chatId;
    if (createGroup && userOpenId) {
      try {
        const token = await tenantToken(result.client_id, result.client_secret);
        const response = await fetch('https://open.feishu.cn/open-apis/im/v1/chats?user_id_type=open_id', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            name: `${name} 测试群`,
            description: 'DSH 扫码接入测试群',
            chat_type: 'private',
            chat_mode: 'group',
            user_id_list: [userOpenId],
          }),
        });
        const data = await response.json();
        if (data.code === 0) {
          chatId = data.data.chat_id;
          console.log('CHAT_ID=' + chatId);
          console.log('CHAT_NAME=' + data.data.name);
        } else {
          console.log('CHAT_ERROR=' + data.code + ' ' + data.msg);
        }
      } catch (error) {
        console.log('CHAT_ERROR=' + (error?.message || error));
      }
    }

    if (chatId) {
      appendAccount({
        id,
        channel: 'feishu',
        appId: result.client_id,
        chatIds: [chatId],
        chatName: `${name} 测试群`,
        awareness: 'mentions',
        echo: false,
        runtime: 'subagent',
        role: {
          name,
          mission: '由扫码接入的新机器人，等待用户在群里分配角色',
        },
      });
      console.log('CONFIG_APPENDED=' + configFile);
    }

    writeFileSync(
      join(stateDir, 'onboard-result.json'),
      JSON.stringify({ id, name, appId: result.client_id, chatId, userOpenId, at: new Date().toISOString() }, null, 2),
      'utf8',
    );
    console.log('ONBOARD_DONE');
  } catch (error) {
    console.log('ONBOARD_ERROR=' + (error?.code || '') + ' ' + (error?.description || error?.message || error));
    process.exitCode = 1;
  }
})();
