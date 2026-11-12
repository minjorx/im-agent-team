import { extractMessageText, parseFooter, stripOwnMention } from '../../bridge-core/protocol.js';

export function normalizeMentions(rawMentions) {
  return (rawMentions || []).map((mention) => ({
    key: mention.key,
    openId: mention.id?.open_id || mention.id?.openId || '',
    unionId: mention.id?.union_id || mention.id?.unionId || undefined,
    name: mention.name || '',
    type: mention.mentioned_type === 'bot' ? 'bot' : 'user',
  }));
}

export function normalizeFeishuMessage(event, { appId, self, chatName } = {}) {
  const message = event?.message || {};
  const sender = event?.sender || {};
  const mentions = normalizeMentions(message.mentions);
  let text = extractMessageText(message) || '';

  for (const mention of mentions) {
    if (!mention.key) continue;
    text = text.split(mention.key).join(`@${mention.name || ''}`);
  }
  text = text.replaceAll('@_all', '@所有人').trim();

  const selfMentioned = mentions.some((mention) => {
    if (self?.openId && mention.openId === self.openId) return true;
    if (self?.unionId && mention.unionId === self.unionId) return true;
    return false;
  });
  const mentionedAll = /@_all/.test(message.content || '') || /@所有人/.test(text);
  const parsed = parseFooter(text);
  const senderType = sender.sender_type === 'bot' || sender.sender_type === 'app' ? 'bot' : 'user';

  return {
    platform: 'feishu',
    appId,
    eventId: event?.event_id || event?.header?.event_id,
    messageId: message.message_id || '',
    chatId: message.chat_id || '',
    chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
    chatName,
    threadId: message.thread_id,
    messageType: message.message_type || 'text',
    sender: {
      type: senderType,
      openId: sender.sender_id?.open_id || '',
      unionId: sender.sender_id?.union_id || undefined,
      name: sender.sender_id?.name || undefined,
    },
    text: parsed.clean,
    rawText: text,
    mentions,
    mentionedMe: selfMentioned,
    mentionedAll,
    envelope: parsed.envelope,
    createTime: Number(message.create_time || Date.now()),
  };
}

export function buildSyntheticMessage({
  appId,
  chatId = 'oc_debug',
  text,
  senderName = '调试用户',
  senderOpenId = 'ou_debug_user',
  senderType = 'user',
  self,
  mentionedMe = true,
  mentions,
}) {
  const allMentions = mentions || (mentionedMe ? [{ key: '@_user_1', openId: self?.openId || 'ou_self', name: self?.name || '机器人', type: 'bot' }] : []);
  const parsed = parseFooter(text);
  return {
    platform: 'feishu',
    appId,
    eventId: `evt_${Date.now()}`,
    messageId: `om_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    chatId,
    chatType: 'group',
    chatName: '调试群',
    messageType: 'text',
    sender: { type: senderType, openId: senderOpenId, name: senderName },
    text: stripOwnMention(parsed.clean, self),
    rawText: text,
    mentions: allMentions,
    mentionedMe,
    mentionedAll: false,
    envelope: parsed.envelope,
    createTime: Date.now(),
  };
}
