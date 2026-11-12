import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker, normalizeEvent, shouldHandle } from '../../lib/runtimes/qoder/worker.mjs';
import { parseQoderOutput, runQoderCli } from '../../lib/runtimes/qoder/cli.mjs';

const selfOpenId = 'ou_self';

function event({ text = '@_user_1 你好', messageId = 'om_1', senderType = 'user' } = {}) {
  return {
    sender: { sender_type: senderType, sender_id: { open_id: 'ou_user' } },
    message: {
      message_id: messageId,
      chat_id: 'oc_test',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      mentions: [{ key: '@_user_1', id: { open_id: selfOpenId }, name: 'Qoder' }],
    },
  };
}

test('normalizeEvent strips the bot mention and detects mentionedMe', () => {
  const message = normalizeEvent(event(), selfOpenId);
  assert.equal(message.chatId, 'oc_test');
  assert.equal(message.mentionedMe, true);
  assert.equal(message.text, '你好');
  assert.equal(shouldHandle(message), true);
});

test('bot messages and unmentioned group messages are ignored', () => {
  assert.equal(shouldHandle(normalizeEvent(event({ senderType: 'bot' }), selfOpenId)), false);
  const unmentioned = normalizeEvent(event({ text: '普通消息' }), selfOpenId);
  unmentioned.mentionedMe = false;
  assert.equal(shouldHandle(unmentioned), false);
});

test('parseQoderOutput reads result and session id', () => {
  const parsed = parseQoderOutput('{"type":"result","result":"OK","session_id":"s-1"}');
  assert.equal(parsed.text, 'OK');
  assert.equal(parsed.sessionId, 's-1');
  assert.equal(parsed.error, false);
});

test('worker calls Qoder, sends the reply and persists the session', async () => {
  const sent = [];
  const sessions = { byChat: {} };
  const prompts = [];
  const worker = createWorker({
    account: {
      appId: 'cli_test',
      selfOpenId,
      role: { name: '调研员', mission: '核验数据' },
      peers: [{ name: '总调度' }],
    },
    settings: { cwd: 'C:/work', permissionMode: 'plan', maxTurns: 2 },
    sessions,
    saveSessions: () => {},
    send: async (payload) => sent.push(payload),
    runQoder: async (args) => {
      prompts.push(args.prompt);
      return { text: '收到，我先核对数据。', sessionId: 's-1' };
    },
  });

  const result = await worker.handleEvent(event());
  assert.equal(result.reply, '收到，我先核对数据。');
  assert.equal(sent[0].chatId, 'oc_test');
  assert.match(prompts[0], /调研员/);
  assert.match(prompts[0], /团队/);
  assert.match(prompts[0], /你好/);
  assert.equal(sessions.byChat.oc_test.sessionId, 's-1');
  assert.equal(sessions.byChat.oc_test.history.length, 2);
});

test('duplicate message ids are processed once', async () => {
  let calls = 0;
  const worker = createWorker({
    account: { appId: 'cli_test', selfOpenId, role: { name: '调研员' }, peers: [] },
    settings: {},
    sessions: { byChat: {} },
    saveSessions: () => {},
    send: async () => {},
    runQoder: async () => {
      calls += 1;
      return { text: 'ok' };
    },
  });
  await worker.handleEvent(event({ messageId: 'om_same' }));
  const second = await worker.handleEvent(event({ messageId: 'om_same' }));
  assert.equal(second.ignored, true);
  assert.equal(calls, 1);
});

test('QODER_MOCK short-circuits the CLI', async () => {
  process.env.QODER_MOCK = '1';
  const result = await runQoderCli({ prompt: '只回复 OK', cwd: process.cwd() });
  assert.match(result.text, /\[mock\]/);
  assert.equal(result.sessionId, 'mock-session');
  delete process.env.QODER_MOCK;
});
