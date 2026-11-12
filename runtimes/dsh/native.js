import { buildIdentityPrompt, buildMemoryPrompt, buildProtocolPrompt, buildRosterPrompt } from '../../lib/bridge-core/prompt.js';

const TOOL_PRESENT = (title) => (args) => ({
  card: 'generic',
  title,
  kind: 'other',
  rawInput: args,
});

function outputSchema(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, required };
}

/**
 * Runtime adapter for an in-process DSH agent.
 * One instance owns exactly one Agent / Session.
 */
export class DshRuntime {
  constructor({ ctx, controller, logger }) {
    this.ctx = ctx;
    this.controller = controller;
    this.logger = logger;
    this.handle = undefined;
    this.agent = undefined;
    this.attempts = new Map();
    this.sectionDisposers = [];
    this.status = 'idle';
    this.lastError = undefined;
    this.creating = undefined;
    this.events = [];
    this.pendingTurn = false;
    this.turnWaiters = [];
  }

  get binding() {
    return this.controller.binding;
  }

  get sessionId() {
    return this.binding.sessionId;
  }

  async ensure() {
    if (this.agent) return this.agent;
    if (this.creating) return this.creating;
    this.creating = this.createAgent().finally(() => {
      this.creating = undefined;
    });
    return this.creating;
  }

  anchorAgent() {
    return this.ctx.agents
      .roots()
      .find((candidate) => !/^(im-|probe-|anchor-)/.test(String(candidate.id)));
  }

  async createAgent(depth = 0) {
    const existing = this.ctx.agents.get(this.sessionId);
    if (existing) {
      this.agent = existing;
      this.status = 'ready';
      return existing;
    }

    const anchor = this.anchorAgent();
    const loop = this.ctx.get('agentLoop');
    const agentOptions =
      this.binding.provider && this.binding.model
        ? {
            provider: this.binding.provider,
            model: this.binding.model,
            ...(this.binding.reasoningEffort ? { reasoningEffort: this.binding.reasoningEffort } : {}),
          }
        : this.defaultModelOptions();
    this.effectiveModel = agentOptions;

    let lastResumeError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const options = {
          resumeSessionId: this.sessionId,
          ...(agentOptions ? { agentOptions } : {}),
          setup: this.setup,
        };
        const handle =
          anchor && typeof loop?.resume === 'function'
            ? await loop.resume(anchor.ctx, options)
            : await this.ctx.agents.resume(options);
        this.handle = handle;
        this.agent = handle.agent;
        this.status = 'ready';
        return this.agent;
      } catch (error) {
        lastResumeError = error;
        const message = error?.message || String(error);
        this.lastResumeError = message;
        const retryable = /already|open|write|lock|in use|busy/i.test(message);
        if (!retryable || attempt === 3) break;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    this.logger.warn(
      `[${this.binding.id}] resume failed, creating a new session`,
      lastResumeError?.message || lastResumeError,
    );

    try {
      const options = {
        sessionId: this.sessionId,
        ...(this.binding.workspace ? { meta: { cwd: this.binding.workspace } } : {}),
        ...(agentOptions ? { agentOptions } : {}),
        setup: this.setup,
      };
      const handle =
        anchor && typeof loop?.createAgent === 'function'
          ? await loop.createAgent(anchor.ctx, options)
          : await this.ctx.agents.create(options);
      this.handle = handle;
      this.agent = handle.agent;
      this.status = 'ready';
      return this.agent;
    } catch (error) {
      const message = error?.message || String(error);
      if (depth < 2 && /already exists/i.test(message)) {
        this.controller.rotateSessionId();
        return this.createAgent(depth + 1);
      }
      throw error;
    }
  }

  defaultModelOptions() {
    try {
      const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.();
      if (selection?.provider && selection?.model) {
        return {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        };
      }
    } catch (error) {
      this.logger.warn(`[${this.binding.id}] default model lookup failed`, error?.message || error);
    }
    return undefined;
  }

  setup = (agentCtx, agent) => {
    try {
      const anchor = this.ctx.agents
        .roots()
        .find((candidate) => !/^(im-|probe-|anchor-)/.test(String(candidate.id)));
      if (anchor) this.ctx.get('agentPresets')?.composeFrom(agentCtx, anchor.ctx);
    } catch (error) {
      this.logger.warn(`[${this.binding.id}] composition inheritance failed`, error?.message || error);
    }
    try {
      // Bot agents get only their scoped team tools. The registry's restriction
      // filter names global tools, so deny the host toolset explicitly.
      agentCtx.tools.restrict({
        deny: [
          'create_goal',
          'edit',
          'exit_plan_mode',
          'feishu_team_debug',
          'get_goal',
          'glob',
          'grep',
          'interrupt_agent',
          'job_kill',
          'job_list',
          'job_output',
          'list_agents',
          'pwsh',
          'read',
          'read_image',
          'send_message',
          'skill',
          'subagent',
          'subagent_fork',
          'todo_write',
          'update_goal',
          'web_fetch',
          'web_search',
          'workflow',
          'working_directory',
          'write',
        ],
      });
    } catch (error) {
      this.logger.warn(`[${this.binding.id}] tool restriction failed`, error?.message || error);
    }
    this.installPrompt(agentCtx);
    this.installTools(agentCtx);
    agentCtx.on('agent/assistant-stream', (payload) => this.onFrame(payload));
    agentCtx.on('agent/status', (payload) => {
      this.status = payload?.status || this.status;
      this.pushEvent({ type: 'agent/status', status: this.status });
      if (this.status === 'idle' && this.pendingTurn) {
        this.pendingTurn = false;
        this.flushTurnWaiters();
      }
    });
    agentCtx.on('agent/error', (payload) => {
      const message = payload?.error?.message || payload?.error || 'unknown agent error';
      this.lastError = String(message);
      this.pushEvent({ type: 'agent/error', message: this.lastError });
      this.logger.error(`[${this.binding.id}] agent error`, this.lastError);
      void this.controller.safeNotice(`⚠️ Agent 出错：${this.lastError}`);
    });
    agentCtx.on('agent/request-error', (payload, next) => {
      this.pushEvent({
        type: 'agent/request-error',
        failure: payload?.failure,
        provider: payload?.provider,
      });
      return next();
    });
    agentCtx.on('session/event', (_session, event) => {
      if (!event?.type) return;
      if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'assistant/message' || event.type === 'request/header') {
        this.pushEvent({
          type: event.type,
          data:
            event.type === 'turn/end'
              ? event.data?.reason
              : event.type === 'assistant/message'
                ? { blocks: event.data?.message?.content?.length }
                : event.type === 'request/header'
                  ? { config: event.data?.header?.config, reason: event.data?.reason }
                  : undefined,
        });
      }
    });
    this.logger.info(`[${this.binding.id}] agent setup for ${agent.id}`);
  };

  installPrompt(agentCtx) {
    if (this.binding.features?.prompts === false) return;
    this.sectionDisposers = [];
    const register = (name, order, text) => {
      try {
        const dispose = agentCtx.systemPrompt.section({ name, order, text });
        if (typeof dispose === 'function') this.sectionDisposers.push(dispose);
      } catch (error) {
        this.logger.warn(`[${this.binding.id}] prompt section ${name} failed`, error?.message || error);
      }
    };
    register('feishu-team/identity', 900, buildIdentityPrompt({ role: this.binding.role, binding: this.binding }));
    register('feishu-team/roster', 901, buildRosterPrompt({ role: this.binding.role, roster: this.controller.roster }));
    register('feishu-team/protocol', 902, buildProtocolPrompt({ team: this.controller.team, binding: this.binding }));
    register('feishu-team/memory', 903, () => buildMemoryPrompt(this.controller.memory.summary()));
  }

  refreshPrompt() {
    for (const dispose of this.sectionDisposers.splice(0)) {
      try {
        dispose();
      } catch {
        // scope may already be disposed
      }
    }
    if (this.agent?.ctx) this.installPrompt(this.agent.ctx);
  }

  installTools(agentCtx) {
    if (this.binding.features?.tools === false) return;
    const handoff = {
      name: 'team_handoff',
      description:
        'Hand a task to another bot in this Feishu group. Use this instead of writing @name by hand. ' +
        'The tool sends a real rich-text mention so the other bot receives an event, and returns a receipt.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          to: { type: 'string', description: 'Target bot name from team_roster.' },
          goal: { type: 'string', description: 'What the target should do.' },
          input: { type: 'string', description: 'Known inputs or a short context digest.' },
          deliverable: { type: 'string', description: 'Expected output.' },
          constraints: { type: 'string', description: 'Rules, deadline, or forbidden actions.' },
          kind: { type: 'string', enum: ['task', 'review', 'escalate'], description: 'Handoff kind.' },
        },
        required: ['to', 'goal'],
      },
      output: {
        schema: outputSchema(
          {
            ok: { type: 'boolean' },
            to: { type: 'string' },
            messageId: { type: 'string' },
            trace: { type: 'string' },
            hop: { type: 'integer' },
            error: { type: 'string' },
          },
          ['ok'],
        ),
        render: (_args, value) => [
          {
            type: 'text',
            text: value.ok
              ? `Handed off to ${value.to || 'peer'} (trace ${value.trace}, hop ${value.hop}).`
              : `Handoff failed: ${value.error || 'unknown'}`,
          },
        ],
      },
      presentCall: TOOL_PRESENT('Hand off task'),
      async execute(args) {
        return this.handoffFromAgent(args);
      },
    };

    const roster = {
      name: 'team_roster',
      description: 'List the bots currently known in this Feishu group, with their roles.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: outputSchema(
          {
            self: { type: 'string' },
            peers: { type: 'array', items: { type: 'string' } },
          },
          ['self', 'peers'],
        ),
        render: (_args, value) => [{ type: 'text', text: `self: ${value.self}\npeers: ${(value.peers || []).join(', ')}` }],
      },
      presentCall: TOOL_PRESENT('Team roster'),
      async execute() {
        return this.rosterValue();
      },
    };

    for (const tool of [handoff, roster]) {
      try {
        agentCtx.tools.register(tool);
      } catch (error) {
        this.logger.error(`[${this.binding.id}] tool ${tool.name} failed`, error?.message || error);
      }
    }
  }

  async handoffFromAgent(args) {
    return this.controller.handoff({
      to: args.to,
      goal: args.goal,
      input: args.input,
      deliverable: args.deliverable,
      constraints: args.constraints,
      kind: args.kind || 'task',
    });
  }

  rosterValue() {
    const roster = this.controller.roster;
    return {
      self: `${roster.self.name} (${this.binding.role.name})`,
      peers: roster.list().map((peer) => `${peer.name}${peer.role?.mission ? `: ${peer.role.mission}` : ''}`),
    };
  }

  onFrame(payload) {
    const frame = payload?.frame;
    if (!frame) return;
    if (frame.type === 'start') {
      this.attempts.set(frame.attemptId, { text: '', turn: frame.turn });
      return;
    }
    if (frame.type === 'chunk') {
      const attempt = this.attempts.get(frame.attemptId);
      if (!attempt) return;
      const chunk = frame.chunk;
      if (chunk?.type === 'text-delta') attempt.text += chunk.text;
      return;
    }
    if (frame.type === 'end') {
      const attempt = this.attempts.get(frame.attemptId);
      this.attempts.delete(frame.attemptId);
      if (!attempt) return;
      if (frame.outcome?.kind === 'committed' && attempt.text.trim()) {
        this.controller.onAgentText({ text: attempt.text.trim(), turn: attempt.turn });
      }
    }
  }

  async submit(text) {
    const agent = await this.ensure();
    this.lastError = undefined;
    this.pendingTurn = true;
    try {
      if (typeof agent.followup !== 'function') {
        throw new Error(`agent.followup is ${typeof agent.followup}; keys=${Object.keys(agent).join(',')}`);
      }
      await agent.followup({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      });
    } catch (error) {
      this.pendingTurn = false;
      this.flushTurnWaiters();
      this.lastError = error?.stack || String(error);
      this.logger.error(`[${this.binding.id}] followup failed`, this.lastError);
      throw error;
    }
  }

  async waitForTurn(timeoutMs = 120_000) {
    if (!this.pendingTurn) return;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.turnWaiters = this.turnWaiters.filter((waiter) => waiter !== finish);
        resolve();
      }, timeoutMs);
      this.turnWaiters.push(finish);
    });
  }

  flushTurnWaiters() {
    for (const finish of this.turnWaiters.splice(0)) finish();
  }

  info() {
    return {
      status: this.status,
      agentKeys: this.agent ? Object.keys(this.agent) : [],
      handleKeys: this.handle ? Object.keys(this.handle) : [],
      followup: typeof this.agent?.followup,
      cancel: typeof this.agent?.cancel,
      whenIdle: typeof this.agent?.whenIdle,
      attempts: this.attempts.size,
      lastError: this.lastError,
      lastResumeError: this.lastResumeError,
      effectiveModel: this.effectiveModel,
      events: this.events.slice(-20),
    };
  }

  pushEvent(event) {
    this.events.push({ ...event, at: Date.now() });
    if (this.events.length > 50) this.events.shift();
  }

  async whenIdle() {
    const agent = await this.ensure();
    await agent.whenIdle();
  }

  async cancel() {
    try {
      await this.agent?.cancel({ kind: 'user' });
    } catch (error) {
      this.logger.warn(`[${this.binding.id}] cancel failed`, error?.message || error);
    }
  }

  async dispose() {
    for (const dispose of this.sectionDisposers.splice(0)) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
    try {
      await this.handle?.dispose();
    } catch (error) {
      this.logger.warn(`[${this.binding.id}] dispose failed`, error?.message || error);
    }
    this.handle = undefined;
    this.agent = undefined;
  }
}
