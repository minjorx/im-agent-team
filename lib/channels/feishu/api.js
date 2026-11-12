export class FeishuApiError extends Error {
  constructor(message, { code, status, logId, payload } = {}) {
    super(message);
    this.name = 'FeishuApiError';
    this.code = code;
    this.status = status;
    this.logId = logId;
    this.payload = payload;
  }
}

const TOKEN_PATHS = new Set(['/open-apis/auth/v3/tenant_access_token/internal']);

export class FeishuApi {
  constructor({ appId, appSecret, domain = 'https://open.feishu.cn', logger = console } = {}) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = String(domain || 'https://open.feishu.cn').replace(/\/+$/, '');
    this.logger = logger;
    this.token = undefined;
    this.tokenExpiresAt = 0;
    this.tokenPromise = undefined;
  }

  async tenantToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      const response = await fetch(`${this.domain}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
        throw new FeishuApiError(`tenant token failed: ${payload.msg || response.statusText}`, {
          code: payload.code,
          status: response.status,
          payload,
        });
      }
      this.token = payload.tenant_access_token;
      this.tokenExpiresAt = Date.now() + Math.max(60, Number(payload.expire || 7200) - 120) * 1000;
      return this.token;
    })().finally(() => {
      this.tokenPromise = undefined;
    });
    return this.tokenPromise;
  }

  async request(path, { method = 'GET', query, body, retry = true } = {}) {
    const token = await this.tenantToken();
    const url = new URL(`${this.domain}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    const logId = response.headers.get('x-tt-logid') || undefined;
    if (response.ok && (payload.code === 0 || payload.code === undefined)) return payload;

    const tokenInvalid = payload.code === 99991663 || payload.code === 99991661 || response.status === 401;
    if (tokenInvalid && retry) {
      this.token = undefined;
      this.tokenExpiresAt = 0;
      return this.request(path, { method, query, body, retry: false });
    }
    throw new FeishuApiError(payload.msg || `feishu api ${response.status}`, {
      code: payload.code,
      status: response.status,
      logId,
      payload,
    });
  }

  async getBotInfo() {
    const payload = await this.request('/open-apis/bot/v3/info');
    return {
      openId: payload.bot?.open_id || payload.data?.bot?.open_id || '',
      unionId: payload.bot?.union_id || payload.data?.bot?.union_id || undefined,
      name: payload.bot?.app_name || payload.data?.bot?.app_name || '',
      avatarUrl: payload.bot?.avatar_url || payload.data?.bot?.avatar_url || '',
      activateStatus: payload.bot?.activate_status,
    };
  }

  async sendMessage({ chatId, msgType, content, uuid, receiveIdType = 'chat_id' }) {
    const payload = await this.request('/open-apis/im/v1/messages', {
      method: 'POST',
      query: { receive_id_type: receiveIdType },
      body: {
        receive_id: chatId,
        msg_type: msgType,
        content,
        ...(uuid ? { uuid } : {}),
      },
    });
    return payload.data || {};
  }

  async replyMessage({ messageId, msgType, content, uuid, replyInThread = false }) {
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      body: {
        msg_type: msgType,
        content,
        ...(uuid ? { uuid } : {}),
        ...(replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    return payload.data || {};
  }

  async getChatInfo(chatId) {
    const payload = await this.request(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`);
    return payload.data || {};
  }

  async addChatMembers({ chatId, memberIds, memberIdType = 'open_id' }) {
    const payload = await this.request(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`, {
      method: 'POST',
      query: { member_id_type: memberIdType },
      body: { id_list: memberIds },
    });
    return payload.data || {};
  }
}
