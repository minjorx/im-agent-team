import { getQoderModels, getQoderUsage, listQoderSessions } from './sdk.mjs';

const HELP = [
  '可用命令：',
  '/mode [plan|default|acceptEdits|auto|bypass]  查看/切换权限模式',
  '/plan [on|off]  切换 Plan 模式',
  '/model [name]  查看/切换模型',
  '/stop  中断当前任务',
  '/sessions  查看最近 Qoder 会话',
  '/models  查看可用模型',
  '/usage  查看额度',
  '/goal [objective|clear]  设置/清除目标',
  '/status  查看当前会话状态',
  '/help  显示本帮助',
].join('\n');

const MODE_LABELS = {
  plan: 'plan（只规划，不执行工具）',
  default: 'default（工具执行需要审批）',
  acceptEdits: 'acceptEdits（自动接受文件编辑）',
  auto: 'auto（自动判定）',
  bypassPermissions: 'bypassPermissions（完全访问，跳过审批）',
};

function truncate(value, max = 80) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function parseCommand(text) {
  if (typeof text !== 'string' || !text.startsWith('/')) return undefined;
  const parts = text.slice(1).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return undefined;
  return { name: parts[0].toLowerCase(), args: parts.slice(1).join(' ').trim() };
}

export function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'plan' || mode === '计划') return 'plan';
  if (mode === 'default' || mode === '默认') return 'default';
  if (['acceptedits', 'accept-edits', 'accept_edits', '自动编辑'].includes(mode)) return 'acceptEdits';
  if (mode === 'auto' || mode === '自动') return 'auto';
  if (
    ['bypass', 'bypasspermissions', 'bypass_permissions', 'yolo', '完全访问'].includes(mode)
  ) {
    return 'bypassPermissions';
  }
  return undefined;
}

export function resolveChatRuntimeSettings({ chat, settings, now = Date.now() }) {
  const chatSettings = (chat.settings ||= {});
  let permissionMode = chatSettings.permissionMode || settings.permissionMode || 'plan';
  let expired = false;
  if (
    permissionMode === 'bypassPermissions' &&
    (!chatSettings.fullAccessUntil || chatSettings.fullAccessUntil <= now)
  ) {
    permissionMode = 'plan';
    chatSettings.permissionMode = 'plan';
    chatSettings.fullAccessUntil = 0;
    expired = true;
  }
  return {
    permissionMode,
    model: chatSettings.model || settings.model,
    cwd: chatSettings.cwd || settings.cwd,
    fullAccessUntil: chatSettings.fullAccessUntil || 0,
    expired,
    goal: chatSettings.goal,
    clearGoal: Boolean(chatSettings.clearGoal),
  };
}

function modeStatus({ chat, settings }) {
  const runtime = resolveChatRuntimeSettings({ chat, settings });
  const remaining = runtime.fullAccessUntil
    ? Math.max(0, Math.ceil((runtime.fullAccessUntil - Date.now()) / 60_000))
    : 0;
  return [
    `权限模式：${MODE_LABELS[runtime.permissionMode] || runtime.permissionMode}`,
    runtime.permissionMode === 'bypassPermissions'
      ? `完全访问剩余：${remaining} 分钟`
      : '完全访问：未开启',
    `模型：${runtime.model || 'auto'}`,
  ].join('\n');
}

export async function handleCommand({
  chatId,
  userId,
  command,
  chat,
  settings,
  send,
  broker,
  save,
  accountId,
}) {
  const chatSettings = (chat.settings ||= {});
  const record = (action, detail) =>
    broker?.record?.({ chatId, userId, kind: 'command', action, detail });

  switch (command.name) {
    case 'help':
      await send(HELP);
      return true;

    case 'mode': {
      if (!command.args) {
        await send(modeStatus({ chat, settings }));
        return true;
      }
      const mode = normalizeMode(command.args);
      if (!mode) {
        await send('可选模式：plan / default / acceptEdits / auto / bypass');
        return true;
      }
      if (mode === 'bypassPermissions') {
        const ttlMinutes = Number(settings.fullAccessTtlMinutes || 30);
        const ok = await (broker?.requestFullAccess?.({ chatId, userId, ttlMinutes }) ?? false);
        if (!ok) {
          await send('未开启完全访问。');
          return true;
        }
        chatSettings.permissionMode = 'bypassPermissions';
        chatSettings.fullAccessUntil = Date.now() + ttlMinutes * 60_000;
        save();
        record('mode', `bypassPermissions ${ttlMinutes}m`);
        await send(`已开启完全访问，${ttlMinutes} 分钟后自动回退到 plan。`);
        return true;
      }
      chatSettings.permissionMode = mode;
      chatSettings.fullAccessUntil = 0;
      save();
      record('mode', mode);
      await send(`权限模式已切换为 ${mode}。`);
      return true;
    }

    case 'plan': {
      const value = command.args.toLowerCase();
      if (value === 'off') {
        chatSettings.permissionMode = 'default';
        chatSettings.fullAccessUntil = 0;
        save();
        record('plan', 'off');
        await send('已退出 Plan 模式（default）。');
      } else {
        chatSettings.permissionMode = 'plan';
        chatSettings.fullAccessUntil = 0;
        save();
        record('plan', 'on');
        await send('已进入 Plan 模式：只规划，不执行工具。');
      }
      return true;
    }

    case 'model': {
      if (!command.args) {
        const runtime = resolveChatRuntimeSettings({ chat, settings });
        await send(`当前模型：${runtime.model || 'auto'}`);
        return true;
      }
      if (/^(default|reset|auto)$/i.test(command.args)) {
        delete chatSettings.model;
        save();
        record('model', 'default');
        await send('模型已恢复为默认。');
        return true;
      }
      chatSettings.model = command.args;
      save();
      record('model', command.args);
      await send(`模型已切换为 ${command.args}（下一条消息生效）。`);
      return true;
    }

    case 'stop': {
      const ok = await (broker?.cancelChat?.(chatId) ?? false);
      record('stop', ok ? 'interrupted' : 'idle');
      await send(ok ? '已请求中断当前任务。' : '当前没有执行中的任务。');
      return true;
    }

    case 'sessions': {
      const runtime = resolveChatRuntimeSettings({ chat, settings });
      try {
        const sessions = await listQoderSessions(runtime.cwd);
        const rows = [...sessions]
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
          .slice(0, 10)
          .map(
            (session) =>
              `- ${truncate(session.title || session.localSessionId, 60)} · ${session.state} · ${session.updatedAt} · ${session.localSessionId}`,
          );
        await send(rows.length ? `最近 Qoder 会话：\n${rows.join('\n')}` : '没有找到 Qoder 会话。');
      } catch (error) {
        await send(`查询会话失败：${error?.message || error}`);
      }
      return true;
    }

    case 'models': {
      try {
        let models = await getQoderModels();
        if (!models.length) models = await getQoderModels({ fetchStrategy: 'live' });
        const rows = models
          .slice(0, 20)
          .map((model) => `- ${model.displayName || model.value}${model.isDefault ? '（默认）' : ''}`);
        await send(rows.length ? `可用模型：\n${rows.join('\n')}` : '没有可用模型。');
      } catch (error) {
        await send(`查询模型失败：${error?.message || error}`);
      }
      return true;
    }

    case 'usage': {
      try {
        const usage = await getQoderUsage();
        if (!usage) {
          await send('暂无额度信息。');
          return true;
        }
        const lines = [];
        if (usage.userQuota) {
          lines.push(
            `用户额度：${usage.userQuota.used ?? '-'} / ${usage.userQuota.total ?? '-'} ${usage.userQuota.unit || ''}`.trim(),
          );
        }
        if (typeof usage.totalUsagePercentage === 'number') {
          lines.push(`已用比例：${usage.totalUsagePercentage}%`);
        }
        if (usage.session?.credits !== undefined) {
          lines.push(`本会话 credits：${usage.session.credits}`);
        }
        await send(lines.length ? lines.join('\n') : JSON.stringify(usage).slice(0, 800));
      } catch (error) {
        await send(`查询额度失败：${error?.message || error}`);
      }
      return true;
    }

    case 'goal': {
      if (!command.args) {
        await send(chatSettings.goal ? `当前目标：${chatSettings.goal.objective}` : '当前没有设置目标。');
        return true;
      }
      if (command.args.toLowerCase() === 'clear') {
        delete chatSettings.goal;
        chatSettings.clearGoal = true;
        save();
        record('goal', 'clear');
        await send('已清除目标。');
        return true;
      }
      chatSettings.goal = { objective: command.args, status: 'active' };
      delete chatSettings.clearGoal;
      save();
      record('goal', command.args);
      await send(`目标已设置：${command.args}\n将在下一条任务中生效。`);
      return true;
    }

    case 'status': {
      const runtime = resolveChatRuntimeSettings({ chat, settings });
      const lines = [
        modeStatus({ chat, settings }),
        `cwd：${runtime.cwd || process.cwd()}`,
        `会话：${chat.sessionId || '新会话'}`,
        `待处理交互：${broker?.pendingCount?.() ?? 0}`,
        `目标：${chatSettings.goal?.objective || '未设置'}`,
      ];
      await send(lines.join('\n'));
      return true;
    }

    default:
      await send(`未知命令：/${command.name}\n\n${HELP}`);
      return true;
  }
}
