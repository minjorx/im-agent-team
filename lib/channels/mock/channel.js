const DEFAULT_LOGGER = {
  info: (...args) => console.log('[feishu-team]', ...args),
  warn: (...args) => console.warn('[feishu-team]', ...args),
  error: (...args) => console.error('[feishu-team]', ...args),
};

/** In-memory channel used by unit tests and the debug tool. */
export class MockChannel {
  constructor({ account, handlers = {}, logger = DEFAULT_LOGGER } = {}) {
    this.account = account;
    this.handlers = handlers;
    this.logger = logger;
    this.status = 'ready';
    this.self = { openId: `ou_self_${account.id}`, name: account.role?.name || account.id, appId: account.appId || `cli_${account.id}` };
    this.outbox = [];
    this.sentAt = [];
  }

  async start() {
    this.status = 'ready';
    return this;
  }

  async send(payload) {
    this.outbox.push({ ...payload, at: Date.now() });
    this.sentAt.push(Date.now());
    return { message_id: `om_mock_${this.outbox.length}` };
  }

  async reply(payload) {
    return this.send({ ...payload, replyTo: payload.replyTo });
  }

  async stop() {
    this.status = 'stopped';
  }

  /** Simulate an inbound event through the same handler contract as Feishu. */
  async inject(message) {
    await this.handlers.onMessage?.(message);
  }

  last(count = 5) {
    return this.outbox.slice(-count);
  }
}
