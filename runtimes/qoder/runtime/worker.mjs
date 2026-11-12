import { buildPrompt } from './prompt.mjs';

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
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
    senderType: sender.sender_type || 'user',
    senderName: sender.sender_id?.open_id || '用户',
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
}) {
  const seen = new Set();

  return {
    async handleEvent(data) {
      const message = normalizeEvent(data, account.selfOpenId);
      if (!shouldHandle(message)) return { ignored: true, reason: 'not-mentioned-or-bot' };
      if (seen.has(message.messageId)) return { ignored: true, reason: 'duplicate' };
      seen.add(message.messageId);
      if (seen.size > 500) seen.delete(seen.values().next().value);

      const chat = (sessions.byChat[message.chatId] ||= { sessionId: undefined, history: [] });
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
          cwd: settings.cwd,
          sessionId: chat.sessionId,
          model: settings.model,
          permissionMode: settings.permissionMode,
          maxTurns: settings.maxTurns,
          timeoutMs: settings.timeoutMs,
        });
      } catch (error) {
        result = { text: '', error: true, errorMessage: error?.message || String(error) };
      }

      if (result.error || !result.text) {
        const text = `⚠️ Qoder 执行失败：${result.errorMessage || '没有返回内容'}`;
        await send({ chatId: message.chatId, text });
        logger.error?.('[connector] qoder failed', result.errorMessage);
        return { error: true, reply: text };
      }

      chat.sessionId = result.sessionId || chat.sessionId;
      chat.history = [...chat.history, { role: 'user', text: message.text }, { role: 'agent', text: result.text }].slice(-6);
      saveSessions(sessions);

      await send({ chatId: message.chatId, text: result.text });
      return { reply: result.text, sessionId: chat.sessionId };
    },
  };
}
