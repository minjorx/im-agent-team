#!/usr/bin/env node
import { startConnector, getStatus, stopConnector } from '../connector/index.mjs';

const args = process.argv.slice(2);
function arg(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const accountId = arg('account');
try {
  const status = await startConnector(accountId ? { accountIds: [accountId] } : {});
  console.log(JSON.stringify(status, null, 2));
  console.log('Connector running. Press Ctrl+C to stop.');
  const keepAlive = setInterval(() => {}, 60_000);
  const shutdown = async () => {
    clearInterval(keepAlive);
    await stopConnector();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error('Failed to start connector:', error?.message || error);
  process.exit(1);
}
