import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuOnboardManager } from '../lib/channels/feishu/onboard.js';

test('DSH onboarding returns a QR link and persists a DSH account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-onboard-'));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const manager = createFeishuOnboardManager({
    stateDir: dir,
    logger: { error() {} },
    accountDefaults: { runtime: 'dsh-native', fullAccess: true, awareness: 'mentions' },
    registerApp: async ({ onQRCodeReady }) => {
      onQRCodeReady({ url: 'https://example.com/qr', expireIn: 300 });
      await gate;
      return {
        client_id: 'cli_dsh',
        client_secret: 'sec_dsh',
        user_info: { open_id: 'ou_dsh' },
      };
    },
    createGroup: async ({ name }) => ({ chatId: 'oc_dsh', name: `${name} 测试群` }),
  });

  const state = await manager.start({ name: 'DSH Assistant', id: 'assistant' });
  assert.equal(state.status, 'waiting');
  assert.equal(state.url, 'https://example.com/qr');

  release();
  const done = await manager.whenDone();
  assert.equal(done.status, 'done');
  assert.equal(done.appId, 'cli_dsh');
  assert.equal(done.chatId, 'oc_dsh');

  const apps = JSON.parse(readFileSync(join(dir, 'feishu-apps.json'), 'utf8'));
  assert.equal(apps.apps[0].appId, 'cli_dsh');
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(config.accounts[0].id, 'assistant');
  assert.equal(config.accounts[0].runtime, 'dsh-native');
  assert.equal(config.accounts[0].fullAccess, true);
  assert.deepEqual(config.accounts[0].chatIds, ['oc_dsh']);
  rmSync(dir, { recursive: true, force: true });
});

test('DSH onboarding reports errors and can retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-onboard-err-'));
  let attempts = 0;
  const manager = createFeishuOnboardManager({
    stateDir: dir,
    logger: { error() {} },
    registerApp: async () => {
      attempts += 1;
      throw new Error('scan failed');
    },
    createGroup: async () => ({ chatId: 'oc_dsh' }),
  });

  const first = await manager.start({ name: 'DSH Assistant', id: 'assistant' });
  assert.equal(first.status, 'error');
  assert.match(first.error, /scan failed/);
  await manager.whenDone();
  manager.reset();
  const second = await manager.start({ name: 'DSH Assistant', id: 'assistant' });
  assert.equal(attempts, 2);
  assert.equal(second.status, 'error');
  rmSync(dir, { recursive: true, force: true });
});

test('DSH onboarding short-circuits an existing account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-onboard-existing-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ accounts: [{ id: 'assistant', appId: 'cli_existing', chatIds: ['oc_x'] }] }),
  );
  let called = false;
  const manager = createFeishuOnboardManager({
    stateDir: dir,
    logger: { error() {} },
    registerApp: async () => {
      called = true;
    },
    createGroup: async () => ({}),
  });

  const state = await manager.start({ id: 'assistant' });
  assert.equal(state.status, 'done');
  assert.equal(state.existing, true);
  assert.equal(called, false);
  rmSync(dir, { recursive: true, force: true });
});
