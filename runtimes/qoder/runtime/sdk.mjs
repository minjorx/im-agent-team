import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, dirname, join } from 'node:path';
import {
  accessToken,
  qodercliAuth,
  query,
  shutdownDaemon,
  startDaemon,
} from '@qoder-ai/qoder-agent-sdk';

const WORKER_SUBPATH = join(
  'node_modules',
  '@qoder-ai',
  'qoder-agent-sdk',
  'dist',
  '_worker',
  'qoder-worker-runtime.obf.mjs',
);

const DAEMON_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
]);

let daemonInstance;
let daemonPromise;

function readWorkerInfo(file) {
  const infoFile = join(dirname(file), 'runtime-info.json');
  try {
    return JSON.parse(readFileSync(infoFile, 'utf8'));
  } catch {
    return undefined;
  }
}

function validateWorkerRuntime(file) {
  if (!file || !existsSync(file)) return undefined;
  const info = readWorkerInfo(file);
  const target = `${process.platform}-${process.arch}`;
  if (Array.isArray(info?.platforms) && !info.platforms.includes(target)) return undefined;
  return info || {};
}

function toDirectory(value) {
  if (!value) return undefined;
  try {
    return statSync(value).isFile() ? dirname(value) : value;
  } catch {
    return dirname(value);
  }
}

function candidatesFrom(root) {
  return [
    join(root, 'resources', 'app.asar.unpacked', WORKER_SUBPATH),
    join(root, 'app.asar.unpacked', WORKER_SUBPATH),
    join(root, WORKER_SUBPATH),
  ];
}

function walkUp(start) {
  let dir = toDirectory(start);
  if (!dir || !isAbsolute(dir)) return undefined;
  for (let depth = 0; dir && depth < 8; depth += 1) {
    for (const candidate of candidatesFrom(dir)) {
      const info = validateWorkerRuntime(candidate);
      if (info) return { path: candidate, info };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function installRoots(env) {
  const roots = new Set();
  const add = (value) => {
    if (value) roots.add(value);
  };
  if (process.resourcesPath) add(dirname(process.resourcesPath));
  add(env.QODER_APP_ROOT);
  if (env.QODER_HOME) add(join(env.QODER_HOME, 'app'));
  add(join(homedir(), '.qoder', 'app'));

  if (process.platform === 'win32') {
    if (env.LOCALAPPDATA) add(join(env.LOCALAPPDATA, 'Programs', 'Qoder'));
    if (env.ProgramFiles) add(join(env.ProgramFiles, 'Qoder'));
    if (env['ProgramFiles(x86)']) add(join(env['ProgramFiles(x86)'], 'Qoder'));
  } else if (process.platform === 'darwin') {
    add('/Applications/Qoder.app/Contents');
    add(join(homedir(), 'Applications', 'Qoder.app', 'Contents'));
  } else {
    add('/opt/Qoder');
    add('/usr/lib/qoder');
    add('/usr/share/qoder');
    add(join(homedir(), '.local', 'share', 'Qoder'));
  }
  return [...roots];
}

function effectiveEnv(env) {
  return { ...process.env, ...env };
}

/**
 * Locate the worker runtime shipped with the installed Qoder app.
 * Returns undefined when no compatible runtime is found.
 */
export function resolveQoderWorkerRuntime({ env = process.env, roots = [] } = {}) {
  const merged = effectiveEnv(env);
  if (merged.QODER_WORKER_RUNTIME) {
    const info = validateWorkerRuntime(merged.QODER_WORKER_RUNTIME);
    if (!info) {
      throw new Error(
        `QODER_WORKER_RUNTIME 指向的 worker runtime 不存在或与当前平台不匹配：${merged.QODER_WORKER_RUNTIME}`,
      );
    }
    return { path: merged.QODER_WORKER_RUNTIME, info, source: 'env' };
  }

  for (const root of [...roots, ...installRoots(merged)]) {
    const found = walkUp(root);
    if (found) return { ...found, source: 'install' };
  }

  for (const start of [merged.QODER_NODE_RUNTIME, process.execPath]) {
    const found = walkUp(start);
    if (found) return { ...found, source: 'runtime-path' };
  }

  return undefined;
}

export function describeQoderRuntime(env = process.env) {
  const merged = effectiveEnv(env);
  if (merged.QODER_MOCK === '1') {
    return { mode: 'mock', available: true, auth: 'mock' };
  }
  try {
    const found = resolveQoderWorkerRuntime({ env: merged });
    if (!found) {
      return {
        mode: 'unavailable',
        available: false,
        error:
          '未找到 Qoder 安装目录里的 worker runtime。请确认 Qoder 安装完整；也可用 QODER_WORKER_RUNTIME 指定路径。',
      };
    }
    return {
      mode: 'sdk-worker',
      available: true,
      path: found.path,
      version: found.info?.version,
      target: found.info?.target,
      source: found.source,
      auth: merged.QODER_PERSONAL_ACCESS_TOKEN ? 'pat' : 'local',
      daemon: daemonInstance?.state,
    };
  } catch (error) {
    return { mode: 'unavailable', available: false, error: error?.message || String(error) };
  }
}

export function mapPermissionMode(value = 'plan') {
  if (value === 'plan') return { permissionMode: 'default', planMode: true };
  if (value === 'yolo' || value === 'bypassPermissions') {
    return { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true };
  }
  if (value === 'dontAsk') return { permissionMode: 'auto' };
  if (DAEMON_PERMISSION_MODES.has(value)) return { permissionMode: value };
  return { permissionMode: 'default' };
}

function resolveAuth(env) {
  if (env.QODER_PERSONAL_ACCESS_TOKEN) return accessToken(env.QODER_PERSONAL_ACCESS_TOKEN);
  return qodercliAuth();
}

function assistantText(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && block.text)
    .map((block) => block.text)
    .join('');
}

function friendlyError(message) {
  const text = String(message || '');
  if (/authentication required|not authenticated|login required|please log in/i.test(text)) {
    return `Qoder 未登录或登录已过期：请在 Qoder 客户端重新登录后重试。（${text}）`;
  }
  return text;
}

function resultError(result) {
  if (!result) return 'Qoder SDK 没有返回结果';
  const parts = [];
  if (result.error_message) parts.push(result.error_message);
  if (Array.isArray(result.errors)) parts.push(...result.errors);
  return friendlyError(
    parts.filter(Boolean).join('; ') ||
      (result.subtype === 'success' ? 'Qoder 没有返回内容' : result.subtype) ||
      'Qoder SDK 执行失败',
  );
}

function isStaleSessionError(message = '') {
  return /session.*(not found|does not exist|invalid|expired|unknown)|no conversation found|resume.*(failed|rejected)/i.test(
    message,
  );
}

export async function ensureQoderDaemon({ env = process.env } = {}) {
  const merged = effectiveEnv(env);
  if (daemonInstance && daemonInstance.state !== 'stopped' && daemonInstance.state !== 'failed') {
    return daemonInstance;
  }
  if (daemonPromise) return daemonPromise;

  const runtime = resolveQoderWorkerRuntime({ env: merged });
  if (!runtime) {
    throw new Error(
      '未找到 Qoder 安装目录里的 worker runtime。请确认 Qoder 安装完整；也可用 QODER_WORKER_RUNTIME 指定路径。',
    );
  }

  daemonPromise = startDaemon({
    auth: resolveAuth(merged),
    launchMode: 'worker',
    pathToQoderWorkerRuntime: runtime.path,
  })
    .then((daemon) => {
      daemonInstance = daemon;
      return daemon;
    })
    .finally(() => {
      daemonPromise = undefined;
    });
  return daemonPromise;
}

export async function listQoderSessions(cwd, { env = process.env } = {}) {
  const daemon = await ensureQoderDaemon({ env });
  return daemon.listSessions(cwd);
}

export async function getQoderModels({ env = process.env, ...params } = {}) {
  const daemon = await ensureQoderDaemon({ env });
  return daemon.getModels(params);
}

export async function getQoderUsage({ env = process.env } = {}) {
  const daemon = await ensureQoderDaemon({ env });
  return daemon.getUsageInfo();
}

async function runOnce({
  prompt,
  cwd = process.cwd(),
  sessionId,
  model,
  permissionMode = 'plan',
  maxTurns = 8,
  timeoutMs = 180_000,
  allowedTools,
  disallowedTools,
  canUseTool,
  onElicitation,
  onQuery,
  onQueryEnd,
  goal,
  clearGoal,
  env = process.env,
}) {
  const daemon = await ensureQoderDaemon({ env });
  const controller = new AbortController();
  let timer;
  let initSessionId;
  let result;
  let text = '';
  let q;

  try {
    q = query({
      prompt,
      options: {
        daemon,
        cwd,
        ...(model ? { model } : {}),
        maxTurns,
        ...mapPermissionMode(permissionMode),
        ...(sessionId ? { resume: sessionId } : {}),
        abortController: controller,
        ...(allowedTools?.length ? { allowedTools } : {}),
        ...(disallowedTools?.length ? { disallowedTools } : {}),
        ...(canUseTool ? { canUseTool } : {}),
        ...(onElicitation ? { onElicitation } : {}),
      },
    });

    if (onQuery) {
      try {
        await onQuery(q);
      } catch {
        // host callback failures must not break the query
      }
    }
    if (goal?.objective && typeof q.setGoal === 'function') {
      try {
        await q.setGoal({ objective: goal.objective, status: goal.status || 'active' });
      } catch {
        // goal is best-effort; older runtimes may not support it
      }
    }
    if (clearGoal && typeof q.clearGoal === 'function') {
      try {
        await q.clearGoal();
      } catch {
        // ignore
      }
    }

    const consume = (async () => {
      for await (const message of q) {
        if (message.type === 'system' && message.subtype === 'init') {
          initSessionId = message.session_id;
        }
        if (message.type === 'assistant') {
          const chunk = assistantText(message);
          if (chunk) text += `${text ? '\n' : ''}${chunk}`;
        }
        if (message.type === 'result') {
          result = message;
          break;
        }
      }
    })();
    consume.catch(() => {});

    await Promise.race([
      consume,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Qoder SDK 超时（${timeoutMs}ms）`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    return {
      text: '',
      sessionId: sessionId || initSessionId,
      error: true,
      errorMessage: friendlyError(error?.message || String(error)),
    };
  } finally {
    clearTimeout(timer);
    try {
      await q?.close();
    } catch {
      // ignore close errors
    }
    try {
      await onQueryEnd?.();
    } catch {
      // ignore host callback errors
    }
  }

  const finalText = result?.result || text;
  const failed = result ? result.is_error === true || result.subtype !== 'success' : !finalText;
  return {
    text: failed ? '' : finalText,
    sessionId: result?.session_id || initSessionId || sessionId,
    error: failed,
    errorMessage: failed ? resultError(result) : undefined,
    raw: result,
  };
}

export async function runQoderSdk(options = {}) {
  const env = effectiveEnv(options.env);
  if (env.QODER_MOCK === '1') {
    return {
      text: `[mock] ${String(options.prompt || '').slice(-160)}`,
      sessionId: options.sessionId || 'mock-session',
      error: false,
    };
  }

  const first = await runOnce({ ...options, env });
  if (/authentication required|not authenticated|login required|please log in/i.test(first.errorMessage || '')) {
    await shutdownQoderSdk();
  }
  if (
    first.error &&
    options.sessionId &&
    !options.retried &&
    isStaleSessionError(first.errorMessage)
  ) {
    return runOnce({ ...options, env, sessionId: undefined, retried: true });
  }
  return first;
}

export async function shutdownQoderSdk() {
  const daemon = daemonInstance;
  daemonInstance = undefined;
  daemonPromise = undefined;
  if (daemon) {
    try {
      await daemon.stop();
    } catch {
      // ignore
    }
    return;
  }
  try {
    await shutdownDaemon();
  } catch {
    // ignore
  }
  return undefined;
}
