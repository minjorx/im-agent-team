import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonStore } from './lib/bridge-core/store.js';
import { MockChannel } from './lib/channels/mock/channel.js';
import { TeamController } from './lib/bridge-core/team.js';
import { FeishuChannel } from './lib/channels/feishu/channel.js';
import { DshRuntime } from './runtimes/dsh/native.js';
import { SubagentRuntime } from './runtimes/dsh/subagent.js';
import { normalizeConfig } from './lib/bridge-core/config.js';
import { resolveStateDir } from './lib/bridge-core/state-dir.js';
import { buildSyntheticMessage } from './lib/channels/feishu/normalize.js';

const LOG_PREFIX = '[im-agent-team]';
const STATE_DIR = resolveStateDir();

function makeLogger() {
  return {
    info: (...args) => console.log(LOG_PREFIX, ...args),
    warn: (...args) => console.warn(LOG_PREFIX, ...args),
    error: (...args) => console.error(LOG_PREFIX, ...args),
  };
}

function installFetchProbe() {
  const previous = globalThis.__dshFeishuFetchProbe;
  if (previous) {
    try {
      globalThis.fetch = previous.original;
    } catch {
      // ignore
    }
    delete globalThis.__dshFeishuFetchProbe;
  }
  const log = [];
  const original = globalThis.fetch;
  globalThis.__dshFeishuFetchProbe = { log, original, version: 3 };
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url || input || '');
    if (!/api\.deepseek\.com|anthropic\.com/.test(url)) return original(input, init);
    const started = Date.now();
    try {
      const response = await original(input, init);
      log.push({
        url,
        status: response.status,
        contentType: response.headers.get('content-type'),
        requestId: response.headers.get('x-request-id') || response.headers.get('x-tt-logid'),
        ms: Date.now() - started,
        at: Date.now(),
      });
      if (log.length > 50) log.shift();
      return response;
      if (response.ok && response.body) {
        try {
          const body = response.body;
          if (!body.__dshProbed) {
            body.__dshProbed = true;
            let chunks = 0;
            const originalGetReader = body.getReader.bind(body);
            body.getReader = (...args) => {
              const reader = originalGetReader(...args);
              const originalRead = reader.read.bind(reader);
              reader.read = async () => {
                try {
                  const result = await originalRead();
                  if (!result.done && chunks < 4) {
                    chunks += 1;
                    const preview = new TextDecoder().decode(result.value).slice(0, 700);
                    log.push({ url, chunk: preview, at: Date.now() });
                    if (log.length > 50) log.shift();
                  }
                  return result;
                } catch (error) {
                  log.push({ url, streamError: error?.message || String(error), at: Date.now() });
                  if (log.length > 50) log.shift();
                  throw error;
                }
              };
              return reader;
            };
          }
        } catch (error) {
          log.push({ url, probeError: error?.message || String(error), at: Date.now() });
        }
      }
      if (!response.ok) {
        const body = await response.clone().text().catch(() => '');
        log.push({ url, status: response.status, body: body.slice(0, 800), at: Date.now() });
      }
      if (log.length > 50) log.shift();
      return response;
    } catch (error) {
      log.push({
        url,
        error: error?.message || String(error),
        cause: error?.cause ? String(error.cause).slice(0, 500) : undefined,
        ms: Date.now() - started,
        at: Date.now(),
      });
      if (log.length > 50) log.shift();
      throw error;
    }
  };
  return globalThis.__dshFeishuFetchProbe;
}

function installFetchProbeV4() {
  const stale = globalThis.__dshFeishuFetchProbe;
  if (stale?.original) {
    try {
      globalThis.fetch = stale.original;
    } catch {
      // ignore
    }
  }
  const log = [];
  const original = globalThis.fetch;
  globalThis.__dshFeishuFetchProbe = { log, original, version: 4 };
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url || input || '');
    if (!/api\.deepseek\.com|anthropic\.com/.test(url)) return original(input, init);
    const started = Date.now();
    try {
      const response = await original(input, init);
      log.push({
        url,
        status: response.status,
        contentType: response.headers.get('content-type'),
        ms: Date.now() - started,
        at: Date.now(),
      });
      if (log.length > 80) log.shift();
      if (response.ok && response.body) {
        try {
          const [clientBody, logBody] = response.body.tee();
          void (async () => {
            const reader = logBody.getReader();
            let count = 0;
            try {
              while (count < 6) {
                const { done, value } = await reader.read();
                if (done) break;
                count += 1;
                log.push({ url, chunk: new TextDecoder().decode(value).slice(0, 700), at: Date.now() });
                if (log.length > 80) log.shift();
              }
            } catch (error) {
              log.push({ url, streamError: error?.message || String(error), at: Date.now() });
            }
            await reader.cancel().catch(() => {});
          })();
          const headers = new Headers(response.headers);
          headers.delete('content-encoding');
          headers.delete('content-length');
          return new Response(clientBody, { status: response.status, statusText: response.statusText, headers });
        } catch (error) {
          log.push({ url, probeError: error?.message || String(error), at: Date.now() });
        }
      }
      return response;
    } catch (error) {
      log.push({
        url,
        error: error?.message || String(error),
        cause: error?.cause ? String(error.cause).slice(0, 500) : undefined,
        ms: Date.now() - started,
        at: Date.now(),
      });
      if (log.length > 80) log.shift();
      throw error;
    }
  };
  return globalThis.__dshFeishuFetchProbe;
}

function loadConfig(raw = {}) {
  let merged = raw || {};
  const inline = process.env.IM_AGENT_TEAM_CONFIG_JSON || process.env.FEISHU_TEAM_CONFIG_JSON;
  const file =
    process.env.IM_AGENT_TEAM_CONFIG ||
    process.env.AGENT_TEAM_CONFIG ||
    process.env.FEISHU_TEAM_CONFIG ||
    join(STATE_DIR, 'config.json');
  try {
    if (inline) merged = { ...merged, ...JSON.parse(inline) };
    else if (existsSync(file)) merged = { ...merged, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    console.error(LOG_PREFIX, 'failed to load external config', error?.message || error);
  }

  // Merge credentials from the local app store, keyed by account id or appId.
  try {
    const appsFile = join(STATE_DIR, 'feishu-apps.json');
    if (existsSync(appsFile)) {
      const apps = JSON.parse(readFileSync(appsFile, 'utf8')).apps || [];
      for (const account of merged.accounts || []) {
        if (account.appSecret) continue;
        const app = apps.find((item) => item.id === account.id || (account.appId && item.appId === account.appId));
        if (app) {
          account.appId ||= app.appId;
          account.appSecret = app.appSecret;
        }
      }
    }
  } catch (error) {
    console.error(LOG_PREFIX, 'failed to merge app credentials', error?.message || error);
  }
  return merged;
}

export const name = 'im-agent-team';
export const inject = ['agents', 'tools', 'systemPrompt', 'subagents'];

export function apply(ctx, rawConfig) {
  const staleProbe = globalThis.__dshFeishuFetchProbe;
  if (staleProbe?.original) {
    try {
      globalThis.fetch = staleProbe.original;
    } catch {
      // ignore
    }
    delete globalThis.__dshFeishuFetchProbe;
  }
  const logger = makeLogger();
  const config = normalizeConfig(loadConfig(rawConfig));
  const fetchProbe = config.debug ? installFetchProbeV4() : { log: [] };
  const store = new JsonStore(config.stateDir);
  const controllers = [];
  let stopping = false;

  const debugTool = {
    name: 'feishu_team_debug',
    description:
      'Inspect and exercise the Feishu team bridge: list bindings, simulate an inbound group message, or read recent outbox. ' +
      'Use action=simulate to test the full inbound → agent → outbound path without a real Feishu message.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'state', 'simulate', 'send', 'probe', 'fetchlog', 'handoff', 'anchor'],
          description: 'list: bindings; state: one binding snapshot; simulate: inject a message; send: send text directly; probe: bare agent model test.',
        },
        accountId: { type: 'string', description: 'Account id; defaults to the first binding.' },
        text: { type: 'string', description: 'Message text for simulate/send.' },
        senderName: { type: 'string', description: 'Simulated sender name.' },
        senderOpenId: { type: 'string', description: 'Simulated sender open_id.' },
        withSetup: { type: 'boolean', description: 'For probe: install this binding prompt/tools before the test turn.' },
        maxTokens: { type: 'number', description: 'For probe: override maxTokens.' },
        model: { type: 'string', description: 'For probe: override model id.' },
        provider: { type: 'string', description: 'For probe: override provider id.' },
        reasoningEffort: { type: 'string', description: 'For probe: override reasoning effort, or "off".' },
        preset: { type: 'string', description: 'For probe: agent preset id.' },
        parent: { type: 'boolean', description: 'For probe: create as a child of the calling agent.' },
        inherit: { type: 'boolean', description: 'For probe: compose from the calling agent composition.' },
        mountPreset: { type: 'string', description: 'For probe: mount this agent preset into the new agent scope.' },
        subagentMeta: { type: 'boolean', description: 'For probe: stamp subagent session metadata.' },
        to: { type: 'string', description: 'For handoff: target bot name.' },
        goal: { type: 'string', description: 'For handoff: task goal.' },
        deliverable: { type: 'string', description: 'For handoff: expected deliverable.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          data: { type: 'object' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.data ?? value, null, 2).slice(0, 8000) }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'Feishu team debug', kind: 'other', rawInput: args }),
    async execute(args) {
      const result = await runDebugAction(args);
      return JSON.parse(JSON.stringify(result));
    },
  };

  async function runDebugAction(args) {
    const action = args?.action || 'list';
    const controller = args?.accountId
      ? controllers.find((item) => item.account.id === args.accountId)
      : controllers[0];
    if (!controller) return { ok: false, data: { error: 'no bindings configured' } };

    if (action === 'list') {
      return { ok: true, data: { bindings: controllers.map((item) => item.snapshot()) } };
    }
    if (action === 'state') {
      return { ok: true, data: controller.snapshot() };
    }
    if (action === 'fetchlog') {
      return { ok: true, data: { log: fetchProbe.log } };
    }
    if (action === 'anchor') {
      const subagents = ctx.get('subagents');
      const parent = ctx.agents.roots().find((agent) => !/^(im-|probe-|anchor-)/.test(String(agent.id)));
      if (!subagents || !parent) {
        return { ok: false, data: { error: 'subagents service or anchor parent unavailable', rootIds: ctx.agents.roots().map((agent) => agent.id) } };
      }
      const childId = `anchor-${Date.now()}`;
      const controllerAbort = new AbortController();
      const events = [];
      let text = '';
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: 'feishu-bot-anchor',
        childId,
        request: {
          parent,
          cwd: process.cwd(),
          prompt: [{ type: 'text', text: '请只回复 OK。' }],
          agentOptions: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
        },
        signal: controllerAbort.signal,
        delivery: 'caller',
      });
      let child = ctx.agents.get(childId);
      for (let i = 0; i < 30 && !child; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        child = ctx.agents.get(childId);
      }
      if (child?.ctx?.on) {
        child.ctx.on('agent/assistant-stream', (payload) => {
          const frame = payload?.frame;
          if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta') text += frame.chunk.text;
        });
        child.ctx.on('agent/error', (payload) => {
          events.push({ type: 'error', message: payload?.error?.message || String(payload?.error) });
        });
      }
      const result = await Promise.race([
        activation.result,
        new Promise((resolve) => setTimeout(() => resolve({ stopReason: 'timeout' }), 60_000)),
      ]);
      return {
        ok: true,
        data: {
          parent: parent.id,
          childId,
          messageId: activation.messageId,
          result,
          text,
          events,
          childLive: Boolean(ctx.agents.get(childId)),
        },
      };
    }
    if (action === 'handoff') {
      const receipt = await controller.handoff({
        to: String(args.to || ''),
        goal: String(args.goal || '测试交接'),
        deliverable: args.deliverable ? String(args.deliverable) : undefined,
        kind: 'task',
      });
      return { ok: true, data: receipt };
    }
    if (action === 'send') {
      await controller.sendText(String(args.text || 'ping'));
      return { ok: true, data: { sent: controller.sent?.slice(-5) || [] } };
    }
    if (action === 'probe') {
      const id = `probe-${Date.now()}`;
      const base = ctx.get('agentDefaultModel')?.currentSelection?.() || {};
      const selection = { ...base };
      if (args.provider) selection.provider = String(args.provider);
      if (args.model) selection.model = String(args.model);
      if (args.maxTokens) selection.maxTokens = Number(args.maxTokens);
      if (args.reasoningEffort === 'off') delete selection.reasoningEffort;
      else if (args.reasoningEffort) selection.reasoningEffort = String(args.reasoningEffort);
      const caller = args.parent || args.inherit || args.subagentMeta ? ctx.agents.currentInitiator() : undefined;
      const events = [];
      let text = '';
      const meta = args.subagentMeta
        ? {
            cwd: process.cwd(),
            ...(caller ? { parentSession: caller.id } : {}),
            isSeeded: false,
            origin: 'subagent',
            delegationDepth: 1,
            agentPreset: 'cordis',
          }
        : undefined;
      const handle = await ctx.agents.create({
        sessionId: id,
        ...(selection ? { agentOptions: selection } : {}),
        ...(meta ? { meta } : args.preset ? { meta: { agentPreset: String(args.preset) } } : {}),
        ...(args.parent && caller ? { parentAgent: caller } : {}),
        setup: async (agentCtx) => {
          try {
            agentCtx.tools.restrict({
              deny: [
                'create_worktree',
                'feishu_team_debug',
                'load_workspace_dependencies',
                'terminal_close',
                'terminal_list',
                'terminal_open',
                'terminal_read',
                'terminal_send',
                'terminal_signal',
                'working_directory',
              ],
            });
          } catch (error) {
            events.push({ type: 'restrict-error', message: error?.message || String(error) });
          }
          const presets = ctx.get('agentPresets');
          if (args.mountPreset) await presets?.mount(agentCtx, String(args.mountPreset));
          else if (args.inherit && caller) presets?.composeFrom(agentCtx, caller.ctx);
          if (args.withSetup) {
            controller.runtime.installPrompt(agentCtx);
            controller.runtime.installTools(agentCtx);
          }
        },
      });
      handle.agent.ctx.on('agent/assistant-stream', (payload) => {
        const frame = payload?.frame;
        if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta') text += frame.chunk.text;
      });
      handle.agent.ctx.on('agent/request-error', (payload, next) => {
        events.push({ type: 'request-error', failure: payload?.failure });
        return next();
      });
      handle.agent.ctx.on('agent/error', (payload) => {
        events.push({ type: 'error', message: payload?.error?.message || String(payload?.error) });
      });
      await handle.agent.followup({
        content: [{ type: 'text', text: String(args.text || '只回复 OK。') }],
        source: { kind: 'user' },
      });
      await Promise.race([
        handle.agent.whenIdle(),
        new Promise((resolve) => setTimeout(resolve, 60_000)),
      ]);
      await handle.dispose().catch(() => {});
      return { ok: true, data: { selection, text, events, sessionId: id } };
    }
    if (action === 'simulate') {
      const text = String(args.text || '/whoami');
      const message = buildSyntheticMessage({
        appId: controller.account.appId,
        chatId: controller.chatId,
        text,
        senderName: args.senderName || '调试用户',
        senderOpenId: args.senderOpenId || 'ou_debug_user',
        self: controller.roster.self,
      });
      await controller.handleInbound(message);
      await Promise.race([
        controller.runtime.waitForTurn?.(120_000) ?? controller.runtime.whenIdle(),
        new Promise((resolve) => setTimeout(resolve, 120_000)),
      ]);
      return {
        ok: true,
        data: {
          ok: true,
          outbox: (controller.sent || []).slice(-8),
          state: controller.snapshot(),
        },
      };
    }
    return { ok: false, data: { error: `unknown action ${action}` } };
  }

  ctx.effect(() => ctx.tools.register(debugTool), 'im-agent-team.debugTool()');

  ctx.effect(() => {
    let disposed = false;
    const startPromise = (async () => {
      await store.load();
      if (disposed) return;
      for (const account of config.accounts) {
        if (!account.enabled) continue;
        const handlers = {};
        const channel =
          account.channel === 'mock'
            ? new MockChannel({ account, handlers, logger })
            : new FeishuChannel({ account, handlers, logger });
        await channel.start();
        if (account.channel === 'feishu') await channel.waitReady?.();

        const byChat = new Map();
        const ensureController = async (chatId, chatName) => {
          const key = `${account.id}:${chatId}`;
          let controller = byChat.get(key);
          if (controller) return controller;
          const scopedAccount =
            chatId && !account.chatIds.includes(chatId)
              ? { ...account, chatIds: [...account.chatIds, chatId] }
              : account;
          controller = new TeamController({
            account: scopedAccount,
            channel,
            store,
            team: config.team,
            outbound: config.outbound,
            logger,
            chatId,
            chatName: chatName || account.chatName,
            features: config.features,
          });
          const runtime =
            account.runtime === 'subagent' || config.runtime === 'subagent'
              ? new SubagentRuntime({ ctx, controller, logger })
              : new DshRuntime({ ctx, controller, logger });
          controller.runtime = runtime;
          byChat.set(key, controller);
          controllers.push(controller);
          await controller.start({ channelStarted: true });
          return controller;
        };

        const initialChats = account.chatIds.length ? account.chatIds : ['oc_debug'];
        for (const chatId of initialChats) await ensureController(chatId, account.chatName);
        const fallback = byChat.values().next().value;

        handlers.onMessage = async (message) => {
          if (message.chatType === 'p2p') {
            await fallback?.handleInbound(message);
            return;
          }
          let controller = byChat.get(`${account.id}:${message.chatId}`);
          if (!controller) controller = await ensureController(message.chatId, message.chatName);
          await controller.handleInbound(message);
        };
        handlers.onBotAdded = async (event) => {
          if (!event?.chatId) return;
          logger.info(`${LOG_PREFIX} [${account.id}] added to ${event.chatId} (${event.chatName || ''})`);
          await ensureController(event.chatId, event.chatName);
        };
      }
      logger.info(`${LOG_PREFIX} started with ${controllers.length} binding(s)`);
    })().catch((error) => {
      logger.error(`${LOG_PREFIX} startup failed`, error);
    });

    return () => {
      disposed = true;
      stopping = true;
      return Promise.allSettled(controllers.map((controller) => controller.stop())).then(() => store.flush());
    };
  }, 'im-agent-team.start()');

  return {
    controllers,
    get config() {
      return config;
    },
    get stopping() {
      return stopping;
    },
  };
}
