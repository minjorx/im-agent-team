import test from 'node:test';
import assert from 'node:assert/strict';
import { DshRuntime } from '../runtimes/dsh/native.js';

const silent = { info() {}, warn() {}, error() {} };

test('native full access registers Feishu question and approval answerers', async () => {
  const handlers = new Map();
  const presetCalls = [];
  const policyCalls = [];
  const questions = [];
  const ctx = {
    get(name) {
      if (name === 'permissionPresets') {
        return {
          catalog: () => ({ options: [{ value: 'auto' }, { value: 'full' }] }),
          resolve: (name) => ({ sandbox: name === 'full' ? 'danger-full-access' : 'workspace-write', approval: 'ask' }),
          set: (session, name) => presetCalls.push({ session, name }),
        };
      }
      if (name === 'approval') {
        return { setPolicy: (agent, policy) => policyCalls.push({ agent, policy }) };
      }
      return undefined;
    },
  };
  const controller = {
    binding: { id: 'cli_x:oc_x', fullAccess: true },
    async askUserQuestions(request) {
      questions.push(request);
      return { answers: [{ id: 'q1', selected: ['A'] }] };
    },
  };
  const runtime = new DshRuntime({ ctx, controller, logger: silent });
  const agent = { id: 'agent-1', session: { id: 'agent-1' } };
  const agentCtx = {
    on(name, handler) {
      handlers.set(name, handler);
      return () => {};
    },
  };

  runtime.installInteractions(agentCtx, agent);
  assert.ok(handlers.has('user-questions/request'));
  assert.ok(handlers.has('approval/request'));
  assert.deepEqual(presetCalls, [{ session: agent.session, name: 'full' }]);
  assert.deepEqual(policyCalls, [{ agent, policy: 'ask' }]);

  const answer = await handlers.get('user-questions/request')(
    { questions: [{ id: 'q1', question: '选哪个', options: [{ label: 'A' }] }], agent },
    async () => ({ answers: [] }),
  );
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['A'] }] });
  assert.equal(questions.length, 1);

  assert.equal(await handlers.get('approval/request')({ agent, toolName: 'pwsh' }, async () => 'unavailable'), 'allowed-once');
});
