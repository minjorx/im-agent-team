import { createHash, randomBytes } from 'node:crypto';
import { Dedup } from './dedup.js';
import { HandoffGuard } from './guard.js';
import { Roster } from './roster.js';
import {
  buildFooter,
  parseFooter,
  renderMentionPost,
  renderPost,
  renderResultBody,
  renderTaskBody,
  splitText,
  stripOwnMention,
} from './protocol.js';
import { buildInboundPrompt } from './prompt.js';
import { buildSyntheticMessage } from './feishu/normalize.js';

const LOG_PREFIX = '[feishu-team]';

function traceId() {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `T-${day}-${randomBytes(3).toString('hex')}`;
}

function sessionIdFor(appId, chatId) {
  const digest = createHash('sha1').update(`${appId}:${chatId}`).digest('hex').slice(0, 20);
  return `im-${digest}`;
}

/** Feishu uuid fields are capped at 50 chars. */
function shortUuid(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 32);
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

export class TeamController {
  constructor({ account, channel, runtime, store, team, outbound, logger, chatId, chatType = 'group', chatName, features }) {
    this.account = account;
    this.channel = channel;
    this.runtime = runtime;
    this.store = store;
    this.team = team;
    this.outbound = outbound;
    this.features = features || { prompts: true, tools: true };
    this.logger = logger;
    this.chatId = chatId;
    this.chatType = chatType;
    this.chatName = chatName;
    this.bindingId = `${account.appId || account.id}:${chatId}`;
    this.dedup = new Dedup();
    this.guard = new HandoffGuard(team);
    this.roster = new Roster(
      {
        appId: account.appId,
        name: account.role.name,
        openId: channel.self?.openId,
        unionId: channel.self?.unionId,
      },
      account.peers,
    );
    this.roleCard = account.role;
    this.suppressNextOutput = false;
    this.outboundCount = 0;
    this.sent = [];
    this.ambient = [];
    this.currentTrace = undefined;
    this.currentHop = 0;
    this.currentKind = undefined;
    this.currentUpstream = undefined;
    this.status = 'idle';
    this.startedAt = Date.now();
    this.lastInboundAt = 0;
    this.lastInbound = undefined;
    this.lastSendError = undefined;
    this.lastOutboundAt = 0;
    this.handoffs = [];
    this.sessionId = sessionIdFor(account.appId || account.id, chatId);
  }

  get binding() {
    return {
      id: this.bindingId,
      appId: this.account.appId,
      chatId: this.chatId,
      chatType: this.chatType,
      chatName: this.chatName,
      self: this.roster.self,
      role: this.roleCard,
      sessionId: this.sessionId,
      workspace: this.account.workspace,
      provider: this.account.provider,
      model: this.account.model,
      reasoningEffort: this.account.reasoningEffort,
      features: this.features,
    };
  }

  async start({ channelStarted = false } = {}) {
    if (!channelStarted) await this.channel.start();
    this.roster.self = {
      ...this.roster.self,
      name: this.channel.self?.name || this.account.role.name,
      openId: this.channel.self?.openId || '',
      unionId: this.channel.self?.unionId,
    };
    const saved = this.store.binding(this.bindingId);
    if (saved.sessionId) this.sessionId = saved.sessionId;
    if (saved.role) this.roleCard = { ...this.roleCard, ...saved.role };
    for (const peer of saved.peers || []) this.roster.upsert(peer, 'manual');
    this.roster.normalize();
    this.persist();
    try {
      await this.runtime.ensure();
      this.status = 'ready';
    } catch (error) {
      this.status = 'degraded';
      this.logger.error(`${LOG_PREFIX} [${this.bindingId}] agent creation failed`, error?.message || error);
    }
    this.logger.info(`${LOG_PREFIX} [${this.bindingId}] ready as ${this.roleCard.name} (${this.chatId})`);
    return this;
  }

  persist() {
    this.store.patch(this.bindingId, {
      sessionId: this.sessionId,
      role: safeJson(this.roleCard),
      peers: safeJson(this.roster.list()),
      updatedAt: Date.now(),
    });
  }

  rotateSessionId() {
    this.sessionId = `${sessionIdFor(this.account.appId || this.account.id, this.chatId)}-${randomBytes(2).toString('hex')}`;
    this.persist();
    return this.sessionId;
  }

  allowsChat(chatId) {
    if (!this.account.chatIds?.length) return true;
    return this.account.chatIds.includes(chatId);
  }

  async handleInbound(message) {
    if (!message?.messageId || !message.chatId) return;
    if (message.chatType === 'p2p') {
      await this.handleDirectMessage(message);
      return;
    }
    if (!this.allowsChat(message.chatId)) {
      this.logger.warn(`${LOG_PREFIX} [${this.bindingId}] ignoring chat ${message.chatId}`);
      return;
    }
    if (this.dedup.seen(message.messageId)) return;
    this.lastInboundAt = Date.now();
    this.lastInbound = {
      messageId: message.messageId,
      text: message.text,
      mentionedMe: message.mentionedMe,
      mentionedAll: message.mentionedAll,
      sender: message.sender,
      mentions: message.mentions,
    };
    const learned = this.roster.learnFromMentions(message.mentions);
    if (learned) this.persist();

    if (message.sender.type === 'bot') {
      const upstream = /上游：(.+)/.exec(message.text || '')?.[1]?.trim();
      if (message.sender.openId && message.sender.openId !== this.roster.self.openId) {
        this.roster.upsert(
          {
            name: upstream || message.sender.name || `bot-${String(message.sender.openId).slice(-6)}`,
            openId: message.sender.openId,
            unionId: message.sender.unionId,
          },
          'mention',
        );
        this.persist();
      }
      await this.handlePeerMessage(message);
      return;
    }

    this.currentTrace = undefined;
    this.currentHop = 0;
    this.currentKind = undefined;
    this.currentUpstream = undefined;
    if (message.mentionedAll && !message.mentionedMe) return;
    if (!message.mentionedMe) {
      if (this.account.awareness === 'all') this.pushAmbient(message);
      return;
    }

    const text = stripOwnMention(message.text, this.roster.self).trim();
    if (!text) return;
    if (text.startsWith('/')) {
      await this.handleCommand(text, message);
      return;
    }
    await this.submit(buildInboundPrompt(message, { selfName: this.roster.self.name }));
  }

  async handleDirectMessage(message) {
    if (message.sender.type !== 'user' || !message.sender.openId) return;
    try {
      await this.channel.api?.addChatMembers?.({
        chatId: this.chatId,
        memberIds: [message.sender.openId],
      });
      await this.channel.send({
        chatId: message.chatId,
        msgType: 'text',
        content: JSON.stringify({
          text: `✅ 已把你加入群「${this.chatName || this.chatId}」。请在群里 @ 机器人开始协作。`,
        }),
        uuid: shortUuid(`${this.bindingId}:p2p:${message.messageId}`),
      });
      this.logger.info(`${LOG_PREFIX} [${this.bindingId}] invited ${message.sender.openId} to ${this.chatId}`);
    } catch (error) {
      this.logger.warn(`${LOG_PREFIX} [${this.bindingId}] p2p invite failed`, error?.message || error);
      await this.channel.send({
        chatId: message.chatId,
        msgType: 'text',
        content: JSON.stringify({ text: `加入群失败：${error?.message || error}` }),
        uuid: shortUuid(`${this.bindingId}:p2p-fail:${message.messageId}`),
      }).catch(() => {});
    }
  }

  async handlePeerMessage(message) {
    const envelope = message.envelope;
    if (!envelope) {
      if (this.account.awareness === 'all') this.pushAmbient(message);
      return;
    }
    if (envelope.kind === 'ack') return;
    if (envelope.kind === 'rolecard') {
      this.applyRoleCard(message);
      return;
    }
    if (envelope.kind === 'task' || envelope.kind === 'review' || envelope.kind === 'result' || envelope.kind === 'escalate') {
      this.guard.attachToRun(envelope.trace);
      this.currentTrace = envelope.trace;
      this.currentHop = envelope.hop || 0;
      this.currentKind = envelope.kind;
      this.currentUpstream = /上游：(.+)/.exec(message.text || '')?.[1]?.trim() || this.currentUpstream;
      await this.submit(buildInboundPrompt(message, { selfName: this.roster.self.name }));
    }
  }

  applyRoleCard(message) {
    const name = message.sender.name || message.sender.openId;
    const missionMatch = /使命：(.+)/.exec(message.text);
    const peer = this.roster.find(name);
    if (peer) {
      peer.role = { ...(peer.role || {}), mission: missionMatch?.[1]?.trim() || peer.role?.mission };
      this.persist();
    }
    this.logger.info(`${LOG_PREFIX} [${this.bindingId}] role card from ${name}`);
  }

  pushAmbient(message) {
    this.ambient.push({
      from: message.sender.name || message.sender.openId,
      text: message.text.slice(0, 500),
      at: Date.now(),
    });
    if (this.ambient.length > 20) this.ambient.shift();
  }

  async submit(text, { replyTo } = {}) {
    this.suppressNextOutput = false;
    if (this.account.echo) {
      await new Promise((resolve) => setTimeout(resolve, 300 + Math.floor(Math.random() * 900)));
      await this.sendText(`🤖 ${this.roleCard.name} 已收到（echo 模式）：${String(text).slice(0, 180)}`);
      return;
    }
    try {
      await this.runtime.submit(text);
      this.lastRequester = replyTo;
    } catch (error) {
      this.logger.error(`${LOG_PREFIX} [${this.bindingId}] submit failed`, error?.message || error);
      await this.sendText(`⚠️ 处理失败：${error?.message || error}`, { replyTo });
    }
  }

  onAgentText({ text, turn }) {
    if (this.suppressNextOutput) {
      this.suppressNextOutput = false;
      this.logger.info(`${LOG_PREFIX} [${this.bindingId}] suppressed final text after handoff (turn ${turn})`);
      return;
    }
    if (!text) return;
    void this.sendText(text);
  }

  decorateOutgoing(text) {
    if (!text) return text;
    if (parseFooter(text).envelope) return text;
    const mentionedPeer = this.roster.list().some((peer) => text.includes(`@${peer.name}`));
    if (!mentionedPeer) return text;
    // A result回执 must not start another round-trip: send it without a
    // triggering footer so the receiving bot ignores it as ambient.
    if (this.currentKind === 'result') return text;
    if (this.currentHop >= this.team.maxHop) return text;
    const trace = this.currentTrace || traceId();
    const hop = (this.currentHop || 0) + 1;
    const kind = this.currentTrace ? 'result' : 'task';
    const upstream = kind === 'task' && !/上游：/.test(text) ? `\n上游：${this.roleCard.name}` : '';
    return `${text}${upstream}\n—\n${buildFooter({ trace, hop, kind })}`;
  }

  async sendText(text, { replyTo } = {}) {
    const decorated = this.decorateOutgoing(text);
    const chunks = splitText(decorated, this.outbound.maxChars);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const payload = this.renderOutbound(chunk);
      let sent = false;
      try {
        await this.channel.send({
          chatId: this.chatId,
          msgType: payload.msgType,
          content: payload.content,
          uuid: shortUuid(`${this.bindingId}:${Date.now()}:${i}`),
          replyTo,
        });
        sent = true;
        this.lastSendError = undefined;
      } catch (error) {
        this.lastSendError = error?.message || String(error);
        this.logger.error(`${LOG_PREFIX} [${this.bindingId}] send failed`, this.lastSendError);
        if (replyTo) {
          try {
            await this.channel.send({
              chatId: this.chatId,
              msgType: payload.msgType,
              content: payload.content,
              uuid: shortUuid(`${this.bindingId}:${Date.now()}:${i}:fallback`),
            });
            sent = true;
            this.lastSendError = undefined;
          } catch (fallbackError) {
            this.lastSendError = fallbackError?.message || String(fallbackError);
          }
        }
      }
      if (!sent) {
        if (i === 0) await this.safeNotice(`⚠️ 发送失败：${this.lastSendError}`);
        return;
      }
      this.outboundCount += 1;
      this.lastOutboundAt = Date.now();
      this.sent.push({ text: chunk, at: Date.now() });
      if (this.sent.length > 100) this.sent.shift();
      if (i + 1 < chunks.length && this.outbound.chunkDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.outbound.chunkDelayMs));
      }
    }
  }

  async safeNotice(text) {
    try {
      await this.channel.send({
        chatId: this.chatId,
        msgType: 'text',
        content: JSON.stringify({ text }),
        uuid: shortUuid(`${this.bindingId}:notice:${Date.now()}`),
      });
    } catch {
      // ignore
    }
  }

  renderOutbound(text) {
    const mentions = [];
    let cursor = 0;
    const peers = this.roster.list().sort((a, b) => b.name.length - a.name.length);
    const pattern = peers.length
      ? new RegExp(`@(${peers.map((peer) => escapeRegExp(peer.name)).join('|')})`, 'g')
      : undefined;
    if (pattern) {
      for (const match of text.matchAll(pattern)) {
        mentions.push({ peer: peers.find((peer) => peer.name === match[1]), index: match.index, token: match[0] });
      }
    }
    if (!mentions.length) return { msgType: 'text', content: JSON.stringify({ text }) };

    const segments = [];
    for (const mention of mentions) {
      if (mention.index > cursor) segments.push({ type: 'text', text: text.slice(cursor, mention.index) });
      if (mention.peer?.openId) {
        segments.push({ type: 'at', openId: mention.peer.openId, name: mention.peer.name });
      } else {
        segments.push({ type: 'text', text: mention.token });
      }
      cursor = mention.index + mention.token.length;
    }
    if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });
    return { msgType: 'post', content: renderPost({ segments }) };
  }

  async handoff({ to, goal, input, deliverable, constraints, kind = 'task' }) {
    const peer = this.roster.find(to);
    if (!peer) {
      return { ok: false, error: `unknown_peer: ${to}` };
    }
    if (!peer.openId) {
      return { ok: false, error: `peer_has_no_open_id: ${peer.name}` };
    }
    const trace = this.currentTrace || traceId();
    const hop = (this.currentHop || 0) + 1;
    const taskId = `${trace}-${hop}`;
    const footer = buildFooter({ trace, hop, kind, taskId });
    const body = renderTaskBody({
      toName: peer.name,
      taskId,
      step: hop,
      goal,
      input,
      deliverable,
      constraints,
      upstream: this.roleCard.name,
      footer,
    });

    const verdict = this.guard.check({ trace, hop, kind, from: this.roleCard.name, to: peer.name, text: body });
    if (!verdict.ok) {
      return { ok: false, error: verdict.reason, trace, hop };
    }

    try {
      const sent = await this.channel.send({
        chatId: this.chatId,
        msgType: 'post',
        content: renderMentionPost({ openId: peer.openId, name: peer.name, text: `\n${body}` }),
        uuid: shortUuid(`${trace}:${taskId}:${hop}`),
      });
      this.guard.record({ trace, from: this.roleCard.name, to: peer.name, text: body, kind });
      this.suppressNextOutput = true;
      this.handoffs.push({ trace, taskId, to: peer.name, hop, at: Date.now(), messageId: sent?.message_id });
      if (this.handoffs.length > 50) this.handoffs.shift();
      this.outboundCount += 1;
      this.lastOutboundAt = Date.now();
      this.logger.info(`${LOG_PREFIX} [${this.bindingId}] handoff -> ${peer.name} (${trace}/${hop})`);
      return { ok: true, to: peer.name, messageId: sent?.message_id, trace, hop };
    } catch (error) {
      this.logger.error(`${LOG_PREFIX} [${this.bindingId}] handoff failed`, error?.message || error);
      return { ok: false, error: error?.message || String(error), trace, hop };
    }
  }

  async handleCommand(text, message) {
    const [rawCommand, ...rest] = text.trim().split(/\s+/);
    const command = rawCommand.toLowerCase();
    const argument = rest.join(' ').trim();
    switch (command) {
      case '/help':
        return this.sendText(HELP_TEXT, {});
      case '/whoami':
        return this.sendText(
          `我是「${this.roleCard.name}」\n使命：${this.roleCard.mission || '未设置'}\napp: ${this.account.appId || this.account.id}\nchat: ${this.chatId}\nsession: ${this.sessionId}`,
          {},
        );
      case '/team':
      case '/roster':
        return this.sendText(this.rosterText(), {});
      case '/status':
        return this.sendText(this.statusText(), {});
      case '/role': {
        if (!argument) return this.sendText('用法：/role <你的职责描述>', {});
        this.roleCard = { ...this.roleCard, mission: argument, version: (this.roleCard.version || 1) + 1 };
        this.persist();
        this.runtime.refreshPrompt();
        await this.broadcastRoleCard();
        return this.sendText(`✅ 角色已更新为「${this.roleCard.name}」v${this.roleCard.version}\n使命：${argument}`, {});
      }
      case '/stop':
        await this.runtime.cancel();
        return this.sendText('⏹ 已请求停止当前任务。', {});
      case '/sync':
        return this.sendText(this.rosterText(), {});
      case '/new': {
        await this.runtime.dispose();
        this.sessionId = `${sessionIdFor(this.account.appId || this.account.id, this.chatId)}-${randomBytes(2).toString('hex')}`;
        this.persist();
        await this.runtime.ensure();
        return this.sendText(`🆕 新会话已创建：${this.sessionId}`, {});
      }
      default:
        return this.sendText(`未知命令 ${rawCommand}，发送 /help 查看可用命令。`, {});
    }
  }

  rosterText() {
    const lines = [`👥 团队名册（${this.chatName || this.chatId}）`, `- ${this.roleCard.name}（我）：${this.roleCard.mission || '未设置使命'}`];
    for (const peer of this.roster.list()) {
      lines.push(`- ${peer.name}：${peer.role?.mission || '未设置使命'}`);
    }
    if (this.roster.list().length === 0) {
      lines.push('（还没有其他机器人；在群里 @ 所有机器人发一条初始化消息即可）');
    }
    return lines.join('\n');
  }

  statusText() {
    return [
      `📡 状态：${this.channel.status} / agent ${this.runtime.status}`,
      `🤖 角色：${this.roleCard.name}`,
      `🧵 会话：${this.sessionId}`,
      `📥 最近入站：${this.lastInboundAt ? new Date(this.lastInboundAt).toLocaleTimeString() : '无'}`,
      `📤 最近出站：${this.lastOutboundAt ? new Date(this.lastOutboundAt).toLocaleTimeString() : '无'}`,
      `🔁 出站计数：${this.outboundCount}`,
      `🧑‍🤝‍🧑 名册：${this.roster.list().map((peer) => peer.name).join('、') || '空'}`,
    ].join('\n');
  }

  async broadcastRoleCard() {
    const peers = this.roster.list().filter((peer) => peer.openId);
    if (!peers.length) return;
    const body = [
      `【角色卡】${this.roleCard.name} v${this.roleCard.version}`,
      `使命：${this.roleCard.mission || '未设置'}`,
      '—',
      buildFooter({ trace: `ROLE-${this.roleCard.name}-${this.roleCard.version}`, hop: 0, kind: 'rolecard' }),
    ].join('\n');
    const segments = [];
    for (const peer of peers) {
      segments.push({ type: 'at', openId: peer.openId, name: peer.name }, { type: 'text', text: ' ' });
    }
    segments.push({ type: 'text', text: `\n${body}` });
    try {
      await this.channel.send({
        chatId: this.chatId,
        msgType: 'post',
        content: renderPost({ segments }),
        uuid: shortUuid(`rolecard:${this.bindingId}:${this.roleCard.version}`),
      });
    } catch (error) {
      this.logger.warn(`${LOG_PREFIX} [${this.bindingId}] role card broadcast failed`, error?.message || error);
    }
  }

  async stop() {
    this.status = 'stopped';
    await this.runtime.dispose();
    await this.channel.stop();
    await this.store.flush();
  }

  snapshot() {
    return {
      bindingId: this.bindingId,
      appId: this.account.appId,
      chatId: this.chatId,
      chatName: this.chatName,
      role: this.roleCard.name,
      mission: this.roleCard.mission,
      channelStatus: this.channel.status,
      runtimeStatus: this.runtime.status,
      runtimeInfo: this.runtime.info?.(),
      sessionId: this.sessionId,
      peers: this.roster.list().map((peer) => ({ name: peer.name, openId: peer.openId, mission: peer.role?.mission })),
      outboundCount: this.outboundCount,
      lastInboundAt: this.lastInboundAt,
      lastInbound: this.lastInbound,
      lastSendError: this.lastSendError,
      lastOutboundAt: this.lastOutboundAt,
      handoffs: this.handoffs.slice(-5),
      guard: this.guard.snapshot(),
    };
  }

  simulate({ text, senderName, senderOpenId, senderType = 'user', mentionedMe = true }) {
    const message = buildSyntheticMessage({
      appId: this.account.appId,
      chatId: this.chatId,
      text,
      senderName,
      senderOpenId,
      senderType,
      self: this.roster.self,
      mentionedMe,
    });
    return this.handleInbound(message);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HELP_TEXT = [
  '🤖 飞书团队机器人命令',
  '/whoami  我是谁、当前会话',
  '/team    查看团队名册与角色',
  '/role <职责描述>  更新我的使命',
  '/status  连接、会话与出站状态',
  '/stop    停止当前任务',
  '/new     开一个新会话',
  '/sync    重新同步名册',
  '/help    本帮助',
].join('\n');

export { traceId, sessionIdFor };
