import { FeishuApi } from './api.js';
import { normalizeFeishuMessage } from './normalize.js';

const DEFAULT_LOGGER = {
  info: (...args) => console.log('[feishu-team]', ...args),
  warn: (...args) => console.warn('[feishu-team]', ...args),
  error: (...args) => console.error('[feishu-team]', ...args),
};

/**
 * One Feishu app = one bot. Inbound events arrive through the official
 * long-connection client; outbound calls go through the OpenAPI.
 */
export class FeishuChannel {
  constructor({ account, handlers = {}, logger = DEFAULT_LOGGER }) {
    this.account = account;
    this.handlers = handlers;
    this.logger = logger;
    this.api = new FeishuApi({ appId: account.appId, appSecret: account.appSecret, domain: account.domain, logger });
    this.self = undefined;
    this.ws = undefined;
    this.status = 'idle';
    this.chatNames = new Map();
    this.readyPromise = undefined;
  }

  async start() {
    this.status = 'connecting';
    this.self = await this.api.getBotInfo();
    const Lark = await import('@larksuiteoapi/node-sdk');
    const domain = /larksuite\.com/i.test(this.account.domain) ? Lark.Domain.Lark : Lark.Domain.Feishu;

    this.ws = new Lark.WSClient({
      appId: this.account.appId,
      appSecret: this.account.appSecret,
      domain,
      loggerLevel: Lark.LoggerLevel.info,
      autoReconnect: true,
      onReady: () => {
        this.status = 'ready';
        this.logger.info(`[${this.account.id}] long connection ready (${this.self?.name || 'bot'})`);
      },
      onError: (error) => {
        this.status = 'degraded';
        this.logger.error(`[${this.account.id}] long connection error`, error?.message || error);
      },
      onReconnecting: () => {
        this.status = 'reconnecting';
      },
      onReconnected: () => {
        this.status = 'ready';
      },
    });

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => {
        void this.onMessage(data);
        return undefined;
      },
      'im.chat.member.bot.added_v1': (data) => {
        void this.onBotAdded(data);
        return undefined;
      },
      'card.action.trigger': (data) => {
        void this.onCardAction(data);
        return undefined;
      },
    });

    this.readyPromise = this.ws.start({ eventDispatcher: dispatcher }).catch((error) => {
      this.status = 'failed';
      this.logger.error(`[${this.account.id}] failed to start`, error?.message || error);
    });
    return this;
  }

  async waitReady(timeoutMs = 15_000) {
    const grant = Promise.race([
      this.readyPromise,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    await grant;
    return this.status;
  }

  async chatName(chatId) {
    if (this.chatNames.has(chatId)) return this.chatNames.get(chatId);
    try {
      const info = await this.api.getChatInfo(chatId);
      const name = info.name || info.chat_name || undefined;
      this.chatNames.set(chatId, name);
      return name;
    } catch (error) {
      this.logger.warn(`[${this.account.id}] chat info failed`, error?.message || error);
      return undefined;
    }
  }

  async onMessage(data) {
    try {
      const chatId = data?.message?.chat_id;
      const chatName = chatId ? await this.chatName(chatId) : undefined;
      const message = normalizeFeishuMessage(data, {
        appId: this.account.appId,
        self: this.self,
        chatName,
      });
      if (!message.chatId) return;
      await this.handlers.onMessage?.(message);
    } catch (error) {
      this.logger.error(`[${this.account.id}] inbound failed`, error);
    }
  }

  async onBotAdded(data) {
    try {
      await this.handlers.onBotAdded?.({
        appId: this.account.appId,
        chatId: data?.chat_id,
        chatName: data?.name,
        operatorOpenId: data?.operator_id?.open_id,
      });
    } catch (error) {
      this.logger.error(`[${this.account.id}] bot-added failed`, error);
    }
  }

  async onCardAction(data) {
    try {
      await this.handlers.onCardAction?.(data);
    } catch (error) {
      this.logger.error(`[${this.account.id}] card action failed`, error);
    }
  }

  async send({ chatId, msgType, content, uuid, replyTo }) {
    if (replyTo) return this.api.replyMessage({ messageId: replyTo, msgType, content, uuid });
    return this.api.sendMessage({ chatId, msgType, content, uuid });
  }

  async stop() {
    this.status = 'stopped';
    try {
      this.ws?.close({});
    } catch (error) {
      this.logger.warn(`[${this.account.id}] close failed`, error?.message || error);
    }
  }
}
