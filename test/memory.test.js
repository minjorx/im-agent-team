import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/core/store.js';
import { MemoryStore } from '../lib/core/memory.js';

test('memory records entries, deduplicates and renders a summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-'));
  const store = new JsonStore(dir);
  await store.load();
  const memory = new MemoryStore({ store, bindingId: 'a:oc' });
  memory.load();
  memory.add('decision', '项目代号 Apollo');
  memory.add('decision', '项目代号 Apollo');
  memory.add('question', '需要市场部提供 Q1 数据');
  assert.equal(memory.entries.length, 2);
  const summary = memory.summary();
  assert.match(summary, /项目代号 Apollo/);
  assert.match(summary, /Q1 数据/);
  memory.clear();
  assert.equal(memory.entries.length, 0);
  await rm(dir, { recursive: true, force: true });
});
