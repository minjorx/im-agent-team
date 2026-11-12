import { resolveStateDir } from './state-dir.js';

const DEFAULTS = {
  stateDir: resolveStateDir(),
  awareness: 'mentions',
  team: {
    mode: 'p2p',
    maxHop: 6,
    runDeadlineMs: 15 * 60 * 1000,
    maxOutboundPerRun: 20,
    handoffCooldownMs: 60 * 1000,
    pingPongWindow: 3,
  },
  outbound: {
    maxChars: 4000,
    chunkDelayMs: 400,
    retryAttempts: 3,
    retryBaseMs: 1000,
  },
};

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeRole(raw = {}) {
  return {
    name: String(raw.name || '机器人'),
    mission: String(raw.mission || ''),
    responsibilities: asArray(raw.responsibilities).map(String),
    inputs: asArray(raw.inputs).map(String),
    outputs: asArray(raw.outputs).map(String),
    handoffTo: asArray(raw.handoffTo).map(String),
    escalateTo: raw.escalateTo ? String(raw.escalateTo) : undefined,
    constraints: asArray(raw.constraints).map(String),
    behavior: asArray(raw.behavior).map(String),
    version: Number(raw.version || 1),
  };
}

function normalizePeer(raw = {}) {
  const name = String(raw.name || '').trim();
  return {
    name,
    openId: String(raw.openId || raw.open_id || '').trim(),
    unionId: raw.unionId || raw.union_id || undefined,
    role: raw.role ? normalizeRole(raw.role) : undefined,
  };
}

function normalizeAccount(raw, index) {
  const id = String(raw.id || `account-${index + 1}`);
  const role = normalizeRole(raw.role || { name: id });
  return {
    id,
    channel: String(raw.channel || 'feishu'),
    appId: raw.appId ? String(raw.appId) : '',
    appSecret: raw.appSecret ? String(raw.appSecret) : '',
    domain: raw.domain ? String(raw.domain) : 'https://open.feishu.cn',
    enabled: raw.enabled !== false,
    chatIds: asArray(raw.chatIds).map(String),
    chatName: raw.chatName ? String(raw.chatName) : undefined,
    awareness: raw.awareness === 'all' ? 'all' : 'mentions',
    workspace: raw.workspace ? String(raw.workspace) : undefined,
    provider: raw.provider ? String(raw.provider) : undefined,
    model: raw.model ? String(raw.model) : undefined,
    reasoningEffort: raw.reasoningEffort ? String(raw.reasoningEffort) : undefined,
    role,
    peers: asArray(raw.peers).map(normalizePeer).filter((peer) => peer.name),
    silence: raw.silence === true,
    echo: raw.echo === true,
    runtime: raw.runtime === 'subagent' ? 'subagent' : 'dsh-native',
  };
}

function pickNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeConfig(raw = {}) {
  const team = { ...DEFAULTS.team, ...(raw.team || {}) };
  const outbound = { ...DEFAULTS.outbound, ...(raw.outbound || {}) };
  const accounts = asArray(raw.accounts).map(normalizeAccount);

  const seen = new Set();
  for (const account of accounts) {
    if (seen.has(account.id)) throw new Error(`feishu-team: duplicate account id "${account.id}"`);
    seen.add(account.id);
    if (account.channel === 'feishu' && (!account.appId || !account.appSecret)) {
      throw new Error(`feishu-team: account "${account.id}" needs appId and appSecret`);
    }
  }

  return {
    accounts,
    stateDir: String(raw.stateDir || DEFAULTS.stateDir),
    team: {
      mode: team.mode === 'strict' ? 'strict' : 'p2p',
      maxHop: pickNumber(team.maxHop, DEFAULTS.team.maxHop, 1, 12),
      runDeadlineMs: pickNumber(team.runDeadlineMs, DEFAULTS.team.runDeadlineMs, 60_000, 2 * 60 * 60_000),
      maxOutboundPerRun: pickNumber(team.maxOutboundPerRun, DEFAULTS.team.maxOutboundPerRun, 1, 200),
      handoffCooldownMs: pickNumber(team.handoffCooldownMs, DEFAULTS.team.handoffCooldownMs, 0, 10 * 60_000),
      pingPongWindow: pickNumber(team.pingPongWindow, DEFAULTS.team.pingPongWindow, 2, 10),
      director: team.director ? String(team.director) : undefined,
    },
    outbound: {
      maxChars: pickNumber(outbound.maxChars, DEFAULTS.outbound.maxChars, 200, 100_000),
      chunkDelayMs: pickNumber(outbound.chunkDelayMs, DEFAULTS.outbound.chunkDelayMs, 0, 5000),
      retryAttempts: pickNumber(outbound.retryAttempts, DEFAULTS.outbound.retryAttempts, 0, 6),
      retryBaseMs: pickNumber(outbound.retryBaseMs, DEFAULTS.outbound.retryBaseMs, 100, 10_000),
    },
    debug: raw.debug === true,
    runtime: raw.runtime === 'subagent' ? 'subagent' : 'dsh-native',
    features: {
      prompts: raw.features?.prompts !== false,
      tools: raw.features?.tools !== false,
    },
  };
}

export { DEFAULTS, normalizeRole, normalizePeer };
