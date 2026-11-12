import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractionBroker, parseQuestionAnswers } from '../connector/interactions.mjs';

function makeBroker({ timeoutMs = 500 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'im-agent-team-ix-'));
  const sent = [];
  const cards = [];
  const broker = createInteractionBroker({
    accountId: 'app_test',
    stateDir: dir,
    sendText: async (chatId, text) => sent.push({ chatId, text }),
    sendCard: async (chatId, card) => cards.push({ chatId, card }),
    timeoutMs,
    logger: { error() {} },
  });
  return {
    broker,
    sent,
    cards,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const question = {
  question: '选 A 还是 B？',
  header: '选择',
  options: [
    { label: 'A', description: '选择 A' },
    { label: 'B', description: '选择 B' },
  ],
  multiSelect: false,
};

test('AskUserQuestion is answered through canUseTool.updatedInput.answers', async () => {
  const { broker, cleanup, dir } = makeBroker();
  const canUseTool = broker.canUseTool({ chatId: 'oc_1', userId: 'ou_user' });
  const pending = canUseTool(
    'AskUserQuestion',
    { questions: [question] },
    { toolUseID: 'tool_1', details: { questions: [question] } },
  );

  assert.equal(broker.handleText({ chatId: 'oc_1', userId: 'ou_user', text: '2' }), true);
  const result = await pending;
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(result.updatedInput.answers, { '选 A 还是 B？': 'B' });

  const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(audit.at(-1)).action, 'answer');
  cleanup();
});

test('approval text maps to allow once, allow session and deny', async () => {
  const { broker, cleanup } = makeBroker();
  const canUseTool = broker.canUseTool({ chatId: 'oc_2', userId: 'ou_user' });

  const once = canUseTool('Bash', { command: 'pwd' }, { toolUseID: 't1', title: 'Bash' });
  broker.handleText({ chatId: 'oc_2', userId: 'ou_user', text: '1' });
  assert.equal((await once).permissionScope, 'once');

  const session = canUseTool('Edit', { path: 'a.txt' }, { toolUseID: 't2', title: 'Edit' });
  broker.handleText({ chatId: 'oc_2', userId: 'ou_user', text: '2' });
  assert.equal((await session).permissionScope, 'session');

  const denied = canUseTool('Write', { path: 'b.txt' }, { toolUseID: 't3', title: 'Write' });
  broker.handleText({ chatId: 'oc_2', userId: 'ou_user', text: '3' });
  assert.equal((await denied).behavior, 'deny');
  cleanup();
});

test('only the requester can resolve an interaction', async () => {
  const { broker, cleanup } = makeBroker();
  const canUseTool = broker.canUseTool({ chatId: 'oc_3', userId: 'ou_owner' });
  const pending = canUseTool('Bash', { command: 'pwd' }, { toolUseID: 't1', title: 'Bash' });

  assert.equal(broker.handleText({ chatId: 'oc_3', userId: 'ou_other', text: '1' }), true);
  broker.handleText({ chatId: 'oc_3', userId: 'ou_owner', text: '3' });
  assert.equal((await pending).behavior, 'deny');
  cleanup();
});

test('approval times out as deny', async () => {
  const { broker, cleanup } = makeBroker({ timeoutMs: 30 });
  const canUseTool = broker.canUseTool({ chatId: 'oc_4', userId: 'ou_user' });
  const pending = canUseTool('Bash', { command: 'pwd' }, { toolUseID: 't1', title: 'Bash' });
  const result = await pending;
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /超时/);
  cleanup();
});

test('question card buttons resolve the pending question', async () => {
  const { broker, cards, cleanup } = makeBroker();
  const canUseTool = broker.canUseTool({ chatId: 'oc_5', userId: 'ou_user' });
  const pending = canUseTool(
    'AskUserQuestion',
    { questions: [question] },
    { toolUseID: 't1', details: { questions: [question] } },
  );

  const card = cards.at(-1).card;
  const button = card.elements
    .flatMap((element) => element.actions || [])
    .find((item) => item.value?.kind === 'question');
  assert.ok(button);
  const result = broker.handleCardAction({
    chatId: 'oc_5',
    userId: 'ou_user',
    value: button.value,
  });
  assert.equal(result.ok, true);
  assert.deepEqual((await pending).updatedInput.answers, { '选 A 还是 B？': 'A' });
  cleanup();
});

test('full access requires confirmation', async () => {
  const { broker, cleanup } = makeBroker();
  const pending = broker.requestFullAccess({ chatId: 'oc_6', userId: 'ou_user', ttlMinutes: 1 });
  broker.handleText({ chatId: 'oc_6', userId: 'ou_user', text: '1' });
  assert.equal(await pending, true);
  cleanup();
});

test('parseQuestionAnswers handles multi-question replies', () => {
  const questions = [
    { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'Q2', options: [{ label: 'C' }, { label: 'D' }] },
  ];
  assert.deepEqual(parseQuestionAnswers(questions, '1=B; 2=C'), { Q1: 'B', Q2: 'C' });
  assert.deepEqual(parseQuestionAnswers(questions, 'B\nC'), { Q1: 'B', Q2: 'C' });
});
