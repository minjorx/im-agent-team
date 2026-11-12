import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/store.js';
import { MockChannel } from '../lib/channel/mock.js';
import { TeamController } from '../lib/team.js';
import { DEFAULTS } from '../lib/config.js';

const silent = { info() {}, warn() {}, error() {} };

function fakeRuntime() {
  return {
    status: 'ready',
    submitted: [],
    async ensure() {},
    async whenIdle() {},
    refreshPrompt() {},
    async cancel() {},
    async dispose() {},
    async submit(text) {
      this.submitted.push(text);
    },
  };
}

async function makeController(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-team-'));
  const store = new JsonStore(dir);
  await store.load();
  const account = {
    id: 'director',
    appId: 'cli_director',
    channel: 'mock',
    chatIds: ['oc_test'],
    chatName: '测试群',
    awareness: 'mentions',
    role: { name: '总调度', mission: '拆任务与交付', handoffTo: ['分析师'], version: 1 },
    peers: [{ name: '分析师', openId: 'ou_analyst_here', role: { name: '分析师', mission: '做分析' } }],
    ...overrides,
  };
  const channel = new MockChannel({ account, logger: silent });
  const runtime = fakeRuntime();
  const controller = new TeamController({
    account,
    channel,
    runtime,
    store,
    team: { ...DEFAULTS.team },
    outbound: { ...DEFAULTS.outbound, chunkDelayMs: 0 },
    logger: silent,
    chatId: 'oc_test',
    chatName: '测试群',
  });
  controller.runtime = runtime;
  await controller.start();
  return { controller, channel, runtime, store, dir };
}

test('inbound user message becomes an agent prompt', async () => {
  const { controller, runtime, dir } = await makeController();
  await controller.handleInbound({
    messageId: 'om_1',
    chatId: 'oc_test',
    sender: { type: 'user', openId: 'ou_user', name: '张三' },
    mentionedMe: true,
    mentionedAll: false,
    text: '@总调度 做个简报',
    mentions: [],
    messageType: 'text',
  });
  assert.equal(runtime.submitted.length, 1);
  assert.match(runtime.submitted[0], /做个简报/);
  await rm(dir, { recursive: true, force: true });
});

test('handoff renders a real post mention and suppresses final text', async () => {
  const { controller, channel, dir } = await makeController();
  const receipt = await controller.handoff({ to: '分析师', goal: '分析数据', deliverable: '结论' });
  assert.equal(receipt.ok, true);
  const last = channel.outbox.at(-1);
  assert.equal(last.msgType, 'post');
  const content = JSON.parse(last.content);
  assert.equal(content.zh_cn.content[0][0].tag, 'at');
  assert.equal(content.zh_cn.content[0][0].user_id, 'ou_analyst_here');
  controller.onAgentText({ text: '已交接', turn: 1 });
  assert.equal(channel.outbox.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('commands answer without invoking the agent', async () => {
  const { controller, channel, runtime, dir } = await makeController();
  await controller.handleInbound({
    messageId: 'om_2',
    chatId: 'oc_test',
    sender: { type: 'user', openId: 'ou_user' },
    mentionedMe: true,
    text: '/whoami',
    mentions: [],
    messageType: 'text',
  });
  assert.equal(runtime.submitted.length, 0);
  const last = channel.outbox.at(-1);
  assert.match(JSON.parse(last.content).text, /总调度/);
  await rm(dir, { recursive: true, force: true });
});

test('role command persists and broadcasts', async () => {
  const { controller, channel, dir } = await makeController();
  await controller.handleInbound({
    messageId: 'om_3',
    chatId: 'oc_test',
    sender: { type: 'user', openId: 'ou_user' },
    mentionedMe: true,
    text: '/role 负责最终交付与质量把关',
    mentions: [],
    messageType: 'text',
  });
  assert.match(controller.roleCard.mission, /质量把关/);
  assert.ok(channel.outbox.some((item) => item.msgType === 'post' && item.content.includes('rolecard')));
  await rm(dir, { recursive: true, force: true });
});

test('duplicate message ids are processed once', async () => {
  const { controller, runtime, dir } = await makeController();
  const message = {
    messageId: 'om_dup',
    chatId: 'oc_test',
    sender: { type: 'user', openId: 'ou_user' },
    mentionedMe: true,
    text: '你好',
    mentions: [],
    messageType: 'text',
  };
  await controller.handleInbound(message);
  await controller.handleInbound(message);
  assert.equal(runtime.submitted.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('p2p message invites the sender into the configured group', async () => {
  const { controller, channel, dir } = await makeController();
  await controller.handleInbound({
    messageId: 'om_p2p',
    chatId: 'oc_p2p',
    chatType: 'p2p',
    sender: { type: 'user', openId: 'ou_user', name: '张三' },
    mentionedMe: false,
    text: 'hi',
    mentions: [],
    messageType: 'text',
  });
  const last = channel.outbox.at(-1);
  assert.match(JSON.parse(last.content).text, /已把你加入群/);
  await rm(dir, { recursive: true, force: true });
});

test('a result receipt does not append a triggering footer', async () => {
  const { controller, dir } = await makeController();
  controller.currentTrace = 'T-1';
  controller.currentHop = 1;
  controller.currentKind = 'result';
  const text = '@分析师 收到，结论已转述';
  assert.equal(controller.decorateOutgoing(text), text);
  await rm(dir, { recursive: true, force: true });
});
