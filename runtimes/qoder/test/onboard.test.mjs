import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOnboardManager } from '../connector/onboard.mjs';

test('onboarding returns a QR link and persists app/account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-agent-team-onboard-'));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const manager = createOnboardManager({
    stateDir: dir,
    logger: { error() {} },
    registerApp: async ({ onQRCodeReady }) => {
      onQRCodeReady({ url: 'https://example.com/qr', expireIn: 300 });
      await gate;
      return {
        client_id: 'cli_x',
        client_secret: 'sec_x',
        user_info: { open_id: 'ou_x' },
      };
    },
    createGroup: async ({ name }) => ({ chatId: 'oc_x', name: `${name} 测试群` }),
  });

  const state = await manager.start({ name: 'Qoder Agent', id: 'qoder' });
  assert.equal(state.status, 'waiting');
  assert.equal(state.url, 'https://example.com/qr');

  release();
  const done = await manager.whenDone();
  assert.equal(done.status, 'done');
  assert.equal(done.appId, 'cli_x');
  assert.equal(done.chatId, 'oc_x');

  const apps = JSON.parse(readFileSync(join(dir, 'feishu-apps.json'), 'utf8'));
  assert.equal(apps.apps[0].appId, 'cli_x');
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(config.accounts[0].id, 'qoder');
  assert.deepEqual(config.accounts[0].chatIds, ['oc_x']);
  rmSync(dir, { recursive: true, force: true });
});

test('onboarding reports errors and can retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-agent-team-onboard-err-'));
  let attempts = 0;
  const manager = createOnboardManager({
    stateDir: dir,
    logger: { error() {} },
    registerApp: async () => {
      attempts += 1;
      throw new Error('scan failed');
    },
    createGroup: async () => ({ chatId: 'oc_x' }),
  });

  const first = await manager.start({ name: 'Qoder Agent', id: 'qoder' });
  assert.equal(first.status, 'error');
  assert.match(first.error, /scan failed/);
  await manager.whenDone();
  manager.reset();
  const second = await manager.start({ name: 'Qoder Agent', id: 'qoder' });
  assert.equal(attempts, 2);
  assert.equal(second.status, 'error');
  rmSync(dir, { recursive: true, force: true });
});

test('existing account short-circuits onboarding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-agent-team-onboard-existing-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ accounts: [{ id: 'qoder', appId: 'cli_existing', chatIds: ['oc_x'] }] }),
  );
  let called = false;
  const manager = createOnboardManager({
    stateDir: dir,
    logger: { error() {} },
    registerApp: async () => {
      called = true;
    },
    createGroup: async () => ({}),
  });

  const state = await manager.start({ id: 'qoder' });
  assert.equal(state.status, 'done');
  assert.equal(state.existing, true);
  assert.equal(called, false);
  rmSync(dir, { recursive: true, force: true });
});
