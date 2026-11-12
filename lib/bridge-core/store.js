import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Tiny atomic JSON store. The bridge treats this as a rebuildable cache:
 * the group chat is the source of truth across machines.
 */
export class JsonStore {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'state.json');
    this.state = { version: 1, bindings: {} };
    this.saveTimer = undefined;
    this.saving = Promise.resolve();
  }

  async load() {
    try {
      const text = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        this.state = { version: 1, bindings: {}, ...parsed };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return this.state;
  }

  binding(key) {
    this.state.bindings[key] ||= {};
    return this.state.bindings[key];
  }

  patch(key, patch) {
    const current = this.binding(key);
    Object.assign(current, patch);
    this.scheduleSave();
    return current;
  }

  scheduleSave(delay = 200) {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, delay);
    this.saveTimer.unref?.();
  }

  async save() {
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      await rename(tmp, this.file);
    }).catch(() => {});
    return this.saving;
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.save();
  }
}
