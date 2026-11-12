import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

test('DSH plugin registers the self-service onboarding tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-'));
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ accounts: [] }), 'utf8');
  const previous = process.env.IM_AGENT_TEAM_CONFIG;
  process.env.IM_AGENT_TEAM_CONFIG = configFile;

  try {
    const tools = [];
    const effects = [];
    const ctx = {
      effect(fn) {
        const dispose = fn();
        effects.push(dispose);
        return dispose;
      },
      tools: {
        register(tool) {
          tools.push(tool);
          return () => {};
        },
      },
      get() {
        return undefined;
      },
      agents: { roots: () => [] },
      systemPrompt: {},
      subagents: undefined,
    };

    apply(ctx, { stateDir: join(dir, 'state') });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const onboard = tools.find((tool) => tool.name === 'feishu_team_onboard');
    assert.ok(onboard, 'feishu_team_onboard should be registered');
    const list = await onboard.execute({ action: 'list' });
    assert.deepEqual(list.data.accounts, []);
    const status = await onboard.execute({ action: 'status' });
    assert.equal(status.ok, true);

    for (const dispose of effects) {
      try {
        await dispose?.();
      } catch {
        // ignore
      }
    }
  } finally {
    if (previous === undefined) delete process.env.IM_AGENT_TEAM_CONFIG;
    else process.env.IM_AGENT_TEAM_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
