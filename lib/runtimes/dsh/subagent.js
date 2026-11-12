import { randomBytes } from 'node:crypto';
import { DEFAULT_BEHAVIOR } from '../../bridge-core/prompt.js';

/**
 * Fallback runtime: one child Agent per inbound message, driven through the
 * subagent service. It trades long-lived session continuity for a working
 * model call on hosts where programmatic root agents cannot stream.
 */
export class SubagentRuntime {
  constructor({ ctx, controller, logger }) {
    this.ctx = ctx;
    this.controller = controller;
    this.logger = logger;
    this.status = 'idle';
    this.anchor = undefined;
    this.anchorHandle = undefined;
    this.history = [];
    this.pending = undefined;
    this.submits = 0;
    this.lastError = undefined;
  }

  get binding() {
    return this.controller.binding;
  }

  async ensureAnchor() {
    if (this.anchor) return this.anchor;
    const existing = this.ctx.agents
      .roots()
      .find((agent) => !/^(im-|probe-|anchor-|feishu-)/.test(String(agent.id)));
    if (existing) {
      this.anchor = existing;
      return existing;
    }
    const handle = await this.ctx.agents.create({
      sessionId: `feishu-anchor-${randomBytes(4).toString('hex')}`,
      setup: () => {},
    });
    this.anchorHandle = handle;
    this.anchor = handle.agent;
    return this.anchor;
  }

  buildPrompt(text) {
    const role = this.binding.role;
    const peers = this.controller.roster.list();
    const behavior = role.behavior?.length ? role.behavior : DEFAULT_BEHAVIOR;
    const lines = [
      `你是飞书群里的机器人「${role.name}」。`,
      `使命：${role.mission || '未设置'}`,
      '只输出要发到群里的内容；不要调用工具，不要解释你的思考过程。',
      '如果需要其他机器人接手，用 @对方名字 的形式写在回复里。',
      '',
      '工作方式（硬性要求，不是建议）：',
      ...behavior.map((item) => `- ${item}`),
      '',
      '团队：',
      ...(peers.length ? peers.map((peer) => `- ${peer.name}${peer.role?.mission ? `：${peer.role.mission}` : ''}`) : ['- （暂无）']),
      '',
      this.controller.memory.summary(),
    ];
    if (this.history.length) {
      lines.push('', '最近对话：');
      for (const entry of this.history.slice(-6)) lines.push(`${entry.role === 'user' ? '对方' : '你'}：${entry.text.slice(0, 400)}`);
    }
    if (this.controller.currentTrace) {
      if (this.controller.currentKind === 'result') {
        lines.push(
          '',
          `这是一条来自上游的结果回执（trace ${this.controller.currentTrace}）。`,
          '不要再 @上游，也不要再发起新的协作；如果需要告知用户，直接输出即可。',
        );
      } else {
        const upstream = this.controller.currentUpstream || '上游';
        lines.push(
          '',
          `这是一条协作任务（trace ${this.controller.currentTrace}，hop ${this.controller.currentHop}）。`,
          `完成后必须用 @${upstream} 把结果回复给上游，不要直接回复用户。`,
        );
      }
    }
    lines.push('', '当前消息：', text);
    return lines.join('\n');
  }

  async submit(text) {
    this.status = 'running';
    this.submits += 1;
    this.lastError = undefined;
    this.pending = (async () => {
      const parent = await this.ensureAnchor();
      const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.();
      const childId = `feishu-${Date.now()}-${randomBytes(3).toString('hex')}`;
      const abort = new AbortController();
      let output = '';
      try {
        const activation = await this.ctx.subagents.startActivation({
          provider: 'spawn',
          label: this.binding.role.name,
          childId,
          request: {
            parent,
            cwd: process.cwd(),
            prompt: [{ type: 'text', text: this.buildPrompt(text) }],
            ...(selection?.provider && selection?.model ? { agentOptions: selection } : {}),
          },
          signal: abort.signal,
          delivery: 'caller',
        });
        const result = await Promise.race([
          activation.result,
          new Promise((resolve) => setTimeout(() => resolve({ stopReason: 'timeout', output: [] }), 120_000)),
        ]);
        output = (result.output || [])
          .filter((block) => block?.type === 'text' && block.text)
          .map((block) => block.text)
          .join('\n')
          .trim();
        this.history.push({ role: 'user', text }, { role: 'assistant', text: output });
        if (this.history.length > 12) this.history.splice(0, this.history.length - 12);
        if (output) this.controller.onAgentText({ text: output, turn: 0 });
        if (result.stopReason !== 'completed' && !output) {
          this.logger.warn(`[${this.binding.id}] subagent stop: ${result.stopReason}`);
        }
      } catch (error) {
        this.lastError = error?.message || String(error);
        this.logger.error(`[${this.binding.id}] subagent runtime failed`, this.lastError);
        await this.controller.safeNotice(`⚠️ 子 Agent 处理失败：${this.lastError}`);
      } finally {
        this.status = 'idle';
      }
      return output;
    })();
    return this.pending;
  }

  async ensure() {
    await this.ensureAnchor();
    this.status = 'ready';
  }

  async waitForTurn() {
    await this.pending;
  }

  async whenIdle() {
    await this.pending;
  }

  async cancel() {
    // Each activation owns its own abort; a future version should retain it.
  }

  async dispose() {
    try {
      await this.anchorHandle?.dispose();
    } catch {
      // ignore
    }
  }

  refreshPrompt() {}

  info() {
    return {
      status: this.status,
      runtime: 'subagent',
      anchor: this.anchor?.id,
      history: this.history.length,
      submits: this.submits,
      lastError: this.lastError,
    };
  }
}
