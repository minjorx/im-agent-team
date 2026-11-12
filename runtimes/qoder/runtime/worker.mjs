import { buildPrompt } from './prompt.mjs';
import { handleCommand, parseCommand, resolveChatRuntimeSettings } from './commands.mjs';

function flattenPost(content) {
  if (!content) return '';
  const root = content.zh_cn || content.en_us || content;
  const parts = [];
  if (root.title) parts.push(root.title);
  for (const paragraph of root.content || []) {
    for (const node of paragraph || []) {
      if (node.tag === 'text' && node.text) parts.push(node.text);
      if (node.tag === 'a' && node.text) parts.push(node.text);
      if (node.tag === 'at' && node.user_name) parts.push(`@${node.user_name}`);
    }
    parts.push('\n');
  }
  return parts.join('').trim();
}

export function normalizeEvent(data, selfOpenId) {
  const message = data?.message || {};
  const sender = data?.sender || {};
  const mentions = (message.mentions || []).map((mention) => ({
    key: mention.key,
    openId: mention.id?.open_id || mention.open_id || '',
    name: mention.name || '',
  }));
  let text = '';
  try {
    const content = JSON.parse(message.content || '{}');
    text = message.message_type === 'post' ? flattenPost(content) : content.text || '';
  } catch {
    text = message.content || '';
  }
  for (const mention of mentions) {
    if (mention.key) text = text.replaceAll(mention.key, '');
  }
  const mentionedMe =
    message.chat_type === 'p2p' ||
    mentions.some((mention) => mention.openId && mention.openId === selfOpenId);
  const senderOpenId = sender.sender_id?.open_id || sender.sender_id?.user_id || '';
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
    senderType: sender.sender_type || 'user',
    senderOpenId,
    senderName: sender.sender_name || senderOpenId || '用户',
    mentionedMe,
    text: text.trim(),
  };
}

export function shouldHandle(message) {
  if (!message?.text) return false;
  if (message.senderType === 'bot') return false;
  if (message.chatType === 'group' && !message.mentionedMe) return false;
  return true;
}

export function createWorker({
  account,
  settings = {},
  send,
  runQoder,
  sessions = { byChat: {} },
  saveSessions = () => {},
  memoryText = () => '',
  logger = console,
  broker,
}) {
  const seen = new Set();

  return {
    async handleEvent(data) {
      const message = normalizeEvent(data, account.selfOpenId);
      if (!shouldHandle(message)) return { ignored: true, reason: 'not-mentioned-or-bot' };
      if (seen.has(message.messageId)) return { ignored: true, reason: 'duplicate' };
      seen.add(message.messageId);
      if (seen.size > 500) seen.delete(seen.values().next().value);

      const chat = (sessions.byChat[message.chatId] ||= {
        sessionId: undefined,
        history: [],
        settings: {},
      });
      chat.settings ||= {};
      chat.history ||= [];
      const userId = message.senderOpenId || message.senderName;
      const sendText = (text) => send({ chatId: message.chatId, text });

      const command = parseCommand(message.text);
      if (command) {
        await handleCommand({
          chatId: message.chatId,
          userId,
          command,
          chat,
          settings,
          send: sendText,
          broker,
          save: () => saveSessions(sessions),
          accountId: account.appId,
        });
        return { handled: true, command: command.name };
      }

      if (broker?.handleText({ chatId: message.chatId, userId, text: message.text })) {
        return { handled: true, interaction: true };
      }

      const runtimeSettings = resolveChatRuntimeSettings({ chat, settings });
      if (runtimeSettings.expired) {
        saveSessions(sessions);
        await sendText('完全访问已过期，已自动回退到 plan 模式。');
      }

      const prompt = buildPrompt({
        role: account.role,
        peers: account.peers || [],
        history: chat.history,
        text: message.text,
        from: message.senderName,
        memory: memoryText(message.chatId),
      });

      let result;
      try {
        result = await runQoder({
          prompt,
          cwd: runtimeSettings.cwd,
          sessionId: chat.sessionId,
          model: runtimeSettings.model,
          permissionMode: runtimeSettings.permissionMode,
          maxTurns: settings.maxTurns,
          timeoutMs: settings.timeoutMs,
          allowedTools: settings.allowedTools,
          disallowedTools: settings.disallowedTools,
          canUseTool: broker?.canUseTool({ chatId: message.chatId, userId }),
          onElicitation: broker?.onElicitation({ chatId: message.chatId, userId }),
          onQuery: (q) => broker?.setActiveQuery(message.chatId, q),
          onQueryEnd: () => {
            broker?.clearActiveQuery(message.chatId);
            broker?.cancelPending?.(message.chatId, '任务已结束。');
          },
          goal: runtimeSettings.goal,
          clearGoal: runtimeSettings.clearGoal,
        });
      } catch (error) {
        result = { text: '', error: true, errorMessage: error?.message || String(error) };
      }

      if (runtimeSettings.clearGoal) {
        delete chat.settings.clearGoal;
        saveSessions(sessions);
      }

      if (result.error || !result.text) {
        const text = `⚠️ Qoder 执行失败：${result.errorMessage || '没有返回内容'}`;
        await send({ chatId: message.chatId, text });
        logger.error?.('[connector] qoder failed', result.errorMessage);
        return { error: true, reply: text };
      }

      chat.sessionId = result.sessionId || chat.sessionId;
      chat.history = [
        ...chat.history,
        { role: 'user', text: message.text },
        { role: 'agent', text: result.text },
      ].slice(-6);
      saveSessions(sessions);

      await send({ chatId: message.chatId, text: result.text });
      return { reply: result.text, sessionId: chat.sessionId };
    },
  };
}
