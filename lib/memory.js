const KINDS = new Set(['note', 'fact', 'decision', 'question', 'task', 'result']);
const KIND_LABEL = {
  note: '笔记',
  fact: '事实',
  decision: '决策',
  question: '待确认',
  task: '任务',
  result: '结果',
};

/** Durable per-binding memory. The group chat is still the cross-machine truth;
 * this is the local working memory the model sees on every turn. */
export class MemoryStore {
  constructor({ store, bindingId, maxEntries = 80, maxChars = 3000 }) {
    this.store = store;
    this.bindingId = bindingId;
    this.maxEntries = maxEntries;
    this.maxChars = maxChars;
    this.entries = [];
    this.updatedAt = 0;
  }

  load() {
    const saved = this.store.binding(this.bindingId).memory;
    this.entries = Array.isArray(saved?.entries) ? saved.entries : [];
    this.updatedAt = Number(saved?.updatedAt || 0);
    return this;
  }

  add(kind, text, meta = {}) {
    const normalizedKind = KINDS.has(kind) ? kind : 'note';
    const normalizedText = String(text || '').trim();
    if (!normalizedText) return undefined;
    const duplicate = this.entries.find(
      (entry) => entry.kind === normalizedKind && entry.text === normalizedText,
    );
    if (duplicate) return duplicate;
    const entry = {
      kind: normalizedKind,
      text: normalizedText.slice(0, 1200),
      at: Date.now(),
      ...(meta.from ? { from: String(meta.from) } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    this.updatedAt = entry.at;
    this.persist();
    return entry;
  }

  list(kind) {
    return kind ? this.entries.filter((entry) => entry.kind === kind) : [...this.entries];
  }

  clear() {
    this.entries = [];
    this.updatedAt = Date.now();
    this.persist();
  }

  summary(maxChars = this.maxChars) {
    if (!this.entries.length) return '（暂无团队记忆；可以用 /remember <内容> 记录项目事实、决策或待确认项。）';
    const recent = [...this.entries].slice(-24);
    const order = ['decision', 'fact', 'question', 'task', 'result', 'note'];
    const sorted = recent.sort((a, b) => {
      const rank = order.indexOf(a.kind) - order.indexOf(b.kind);
      return rank !== 0 ? rank : b.at - a.at;
    });
    const lines = ['# 团队记忆（本群/本项目）'];
    let used = 0;
    for (const entry of sorted) {
      const line = `- [${KIND_LABEL[entry.kind] || entry.kind}] ${entry.text.replaceAll('\n', ' ')}`;
      if (used + line.length > maxChars) {
        lines.push('- …（更早的记忆已省略）');
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join('\n');
  }

  toJSON() {
    return { entries: this.entries, updatedAt: this.updatedAt };
  }

  persist() {
    this.store.patch(this.bindingId, { memory: this.toJSON() });
  }
}
