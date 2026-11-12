import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFooter, flattenPost, parseFooter, renderMentionPost, splitText, stripOwnMention } from '../lib/bridge-core/protocol.js';
import { Roster } from '../lib/bridge-core/roster.js';
import { HandoffGuard } from '../lib/bridge-core/guard.js';
import { Dedup } from '../lib/bridge-core/dedup.js';
import { normalizeConfig } from '../lib/bridge-core/config.js';
import { normalizeFeishuMessage } from '../lib/channels/feishu/normalize.js';
import { DEFAULT_BEHAVIOR, buildIdentityPrompt } from '../lib/bridge-core/prompt.js';

test('footer round-trips and strips from text', () => {
  const footer = buildFooter({ trace: 'T-1', hop: 2, kind: 'task', taskId: 'T-1-2' });
  const parsed = parseFooter(`hello\n—\n${footer}`);
  assert.equal(parsed.clean, 'hello');
  assert.deepEqual(parsed.envelope, { trace: 'T-1', hop: 2, kind: 'task', taskId: 'T-1-2', deadline: undefined });
});

test('post mention renders as a real at segment', () => {
  const content = renderMentionPost({ openId: 'ou_b', name: '分析师', text: ' 请分析' });
  const parsed = JSON.parse(content);
  const row = parsed.zh_cn.content[0];
  assert.deepEqual(row[0], { tag: 'at', user_id: 'ou_b', user_name: '分析师' });
  assert.equal(row[1].tag, 'text');
});

test('flattenPost reads text and at elements', () => {
  const content = JSON.stringify({
    zh_cn: {
      title: '标题',
      content: [[
        { tag: 'at', user_id: 'ou_b', user_name: '分析师' },
        { tag: 'text', text: ' 请看' },
      ]],
    },
  });
  assert.equal(flattenPost(content), '标题\n@分析师 请看');
});

test('flattenPost accepts locale-less received post content', () => {
  const content = JSON.stringify({
    title: '',
    content: [[
      { tag: 'at', user_id: 'ou_b', user_name: 'Researcher' },
      { tag: 'text', text: ' /whoami' },
    ]],
  });
  assert.equal(flattenPost(content), '@Researcher /whoami');
});

test('splitText preserves short text and chunks long text', () => {
  assert.deepEqual(splitText('hi', 10), ['hi']);
  const chunks = splitText('a'.repeat(25), 10);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].startsWith('(1/3)'));
});

test('stripOwnMention only removes the bot prefix', () => {
  assert.equal(stripOwnMention('@总调度 你好', { name: '总调度' }), '你好');
  assert.equal(stripOwnMention('你好 @总调度', { name: '总调度' }), '你好 @总调度');
});

test('roster learns app-scoped peer ids and finds by name', () => {
  const roster = new Roster({ name: '总调度', openId: 'ou_self' });
  roster.learnFromMentions([
    { name: '总调度', openId: 'ou_self' },
    { name: '分析师', openId: 'ou_b_in_this_app' },
    { name: '撰稿人', openId: 'ou_c_in_this_app' },
  ]);
  assert.equal(roster.list().length, 2);
  assert.equal(roster.find('分析师').openId, 'ou_b_in_this_app');
  assert.equal(roster.find('不存在'), undefined);
});

test('roster merges same-name peers instead of duplicating', () => {
  const roster = new Roster({ name: '总调度', openId: 'ou_self' });
  roster.upsert({ name: '总调度', openId: 'ou_config' }, 'manual');
  roster.upsert({ name: '总调度', openId: 'ou_sender' }, 'mention');
  assert.equal(roster.list().length, 1);
  assert.equal(roster.find('总调度').openId, 'ou_sender');
});

test('guard blocks hop overflow, cooldown and ping-pong', () => {
  const guard = new HandoffGuard({ maxHop: 2, cooldownMs: 0, pingPongWindow: 2 });
  assert.equal(guard.check({ trace: 'T', hop: 3, from: 'A', to: 'B', text: 'x' }).ok, false);
  assert.equal(guard.check({ trace: 'T', hop: 1, from: 'A', to: 'B', text: 'x' }).ok, true);
  guard.record({ trace: 'T', from: 'A', to: 'B', text: 'x' });
  const second = guard.check({ trace: 'T', hop: 1, from: 'A', to: 'B', text: 'x' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'ping_pong');
});

test('guard enforces cooldown for ordinary handoffs', () => {
  const guard = new HandoffGuard({ maxHop: 6, cooldownMs: 60_000, pingPongWindow: 5 });
  guard.record({ trace: 'T2', from: 'A', to: 'B', text: 'one' });
  const result = guard.check({ trace: 'T2', hop: 1, from: 'A', to: 'B', text: 'two' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cooldown');
});

test('dedup is idempotent by message id', () => {
  const dedup = new Dedup({ ttlMs: 10_000, capacity: 2 });
  assert.equal(dedup.seen('m1'), false);
  assert.equal(dedup.seen('m1'), true);
  assert.equal(dedup.seen('m2'), false);
  assert.equal(dedup.seen('m3'), false);
  assert.equal(dedup.size, 2);
});

test('config normalizes defaults and rejects duplicate accounts', () => {
  const config = normalizeConfig({ accounts: [{ id: 'a', channel: 'mock', role: { name: 'A' } }] });
  assert.equal(config.accounts.length, 1);
  assert.equal(config.team.maxHop, 6);
  assert.equal(config.accounts[0].awareness, 'mentions');
  assert.throws(() => normalizeConfig({ accounts: [{ id: 'a', channel: 'mock' }, { id: 'a', channel: 'mock' }] }));
});

test('feishu text event normalizes mentions and self detection', () => {
  const message = normalizeFeishuMessage(
    {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 你好' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_self' }, name: '总调度', mentioned_type: 'bot' }],
      },
    },
    { appId: 'cli_a', self: { openId: 'ou_self', name: '总调度' } },
  );
  assert.equal(message.text, '@总调度 你好');
  assert.equal(message.mentionedMe, true);
  assert.equal(message.sender.type, 'user');
});

test('feishu post event flattens rich text', () => {
  const post = {
    zh_cn: {
      title: '',
      content: [[{ tag: 'at', user_id: 'ou_self', user_name: '总调度' }, { tag: 'text', text: ' 收到' }]],
    },
  };
  const message = normalizeFeishuMessage(
    {
      sender: { sender_type: 'bot', sender_id: { open_id: 'ou_peer' } },
      message: {
        message_id: 'om_2',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'post',
        content: JSON.stringify(post),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_self' }, name: '总调度', mentioned_type: 'bot' }],
      },
    },
    { appId: 'cli_a', self: { openId: 'ou_self', name: '总调度' } },
  );
  assert.equal(message.mentionedMe, true);
  assert.match(message.rawText, /收到/);
});

test('identity prompt carries the working-style constraints', () => {
  const text = buildIdentityPrompt({
    role: { name: '调研员', mission: '核验数据' },
    binding: { chatType: 'group' },
  });
  assert.match(text, /工作方式/);
  assert.match(text, /先评估任务/);
  assert.ok(DEFAULT_BEHAVIOR.length >= 4);
});
