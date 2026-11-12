import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleCommand,
  normalizeMode,
  parseCommand,
  resolveChatRuntimeSettings,
} from '../runtime/commands.mjs';

function makeContext() {
  const messages = [];
  const records = [];
  let saves = 0;
  const chat = { sessionId: 's1', history: [], settings: {} };
  const settings = {
    permissionMode: 'plan',
    model: undefined,
    cwd: 'C:/work',
    fullAccessTtlMinutes: 1,
  };
  const broker = {
    requestFullAccess: async () => true,
    interrupt: async () => true,
    pendingCount: () => 0,
    record: (event) => records.push(event),
  };
  return {
    chat,
    settings,
    broker,
    messages,
    records,
    send: async (text) => messages.push(text),
    save: () => {
      saves += 1;
    },
    get saves() {
      return saves;
    },
  };
}

async function run(ctx, text) {
  const command = parseCommand(text);
  assert.ok(command, `not a command: ${text}`);
  return handleCommand({
    chatId: 'oc_test',
    userId: 'ou_user',
    command,
    chat: ctx.chat,
    settings: ctx.settings,
    send: ctx.send,
    broker: ctx.broker,
    save: ctx.save,
    accountId: 'app_test',
  });
}

test('parseCommand and normalizeMode', () => {
  assert.deepEqual(parseCommand('/mode bypass'), { name: 'mode', args: 'bypass' });
  assert.deepEqual(parseCommand('普通消息'), undefined);
  assert.equal(normalizeMode('完全访问'), 'bypassPermissions');
  assert.equal(normalizeMode('accept-edits'), 'acceptEdits');
  assert.equal(normalizeMode('unknown'), undefined);
});

test('/mode plan and /model update per-chat settings', async () => {
  const ctx = makeContext();
  await run(ctx, '/mode plan');
  assert.equal(ctx.chat.settings.permissionMode, 'plan');
  await run(ctx, '/model gpt-test');
  assert.equal(ctx.chat.settings.model, 'gpt-test');
  await run(ctx, '/model default');
  assert.equal(ctx.chat.settings.model, undefined);
  assert.ok(ctx.saves >= 3);
});

test('/mode bypass requires confirmation and sets a TTL', async () => {
  const ctx = makeContext();
  await run(ctx, '/mode bypass');
  assert.equal(ctx.chat.settings.permissionMode, 'bypassPermissions');
  assert.ok(ctx.chat.settings.fullAccessUntil > Date.now());
  assert.equal(ctx.records.at(-1).action, 'mode');
});

test('/plan off switches to default and clears full access', async () => {
  const ctx = makeContext();
  ctx.chat.settings.permissionMode = 'bypassPermissions';
  ctx.chat.settings.fullAccessUntil = Date.now() + 60_000;
  await run(ctx, '/plan off');
  assert.equal(ctx.chat.settings.permissionMode, 'default');
  assert.equal(ctx.chat.settings.fullAccessUntil, 0);
});

test('/goal set and clear', async () => {
  const ctx = makeContext();
  await run(ctx, '/goal 完成飞书联调');
  assert.equal(ctx.chat.settings.goal.objective, '完成飞书联调');
  await run(ctx, '/goal clear');
  assert.equal(ctx.chat.settings.goal, undefined);
  assert.equal(ctx.chat.settings.clearGoal, true);
});

test('/stop delegates to the broker', async () => {
  const ctx = makeContext();
  let interrupted = 0;
  ctx.broker.cancelChat = async () => {
    interrupted += 1;
    return true;
  };
  await run(ctx, '/stop');
  assert.equal(interrupted, 1);
  assert.match(ctx.messages.at(-1), /中断/);
});

test('expired full access falls back to plan', () => {
  const chat = {
    settings: {
      permissionMode: 'bypassPermissions',
      fullAccessUntil: Date.now() - 1000,
      model: 'm1',
    },
  };
  const runtime = resolveChatRuntimeSettings({
    chat,
    settings: { permissionMode: 'plan' },
    now: Date.now(),
  });
  assert.equal(runtime.permissionMode, 'plan');
  assert.equal(runtime.expired, true);
  assert.equal(chat.settings.permissionMode, 'plan');
});

test('unknown command returns help', async () => {
  const ctx = makeContext();
  await run(ctx, '/unknown');
  assert.match(ctx.messages.at(-1), /未知命令/);
});
