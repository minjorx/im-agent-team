import { cpSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the runtime state directory.
 *
 * v0.2 renamed the package to im-agent-team and moved state to
 * ~/.dsh/im-agent-team. The first new-code load copies the newest legacy
 * directory once; the legacy directory is kept as a backup.
 */
export function resolveStateDir() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const next = join(dshHome, 'im-agent-team');
  if (!existsSync(next)) {
    for (const legacyName of ['agent-team', 'dsh-feishu-team']) {
      const legacy = join(dshHome, legacyName);
      if (!existsSync(legacy)) continue;
      try {
        cpSync(legacy, next, { recursive: true });
      } catch {
        return legacy;
      }
      break;
    }
  }
  return next;
}
