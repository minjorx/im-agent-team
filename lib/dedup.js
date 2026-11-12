/** Small TTL + capacity LRU used for inbound message idempotency. */
export class Dedup {
  constructor({ ttlMs = 24 * 60 * 60_000, capacity = 5000 } = {}) {
    this.ttlMs = ttlMs;
    this.capacity = capacity;
    this.map = new Map();
  }

  seen(key, now = Date.now()) {
    if (!key) return false;
    const at = this.map.get(key);
    if (at && now - at < this.ttlMs) return true;
    this.map.delete(key);
    this.map.set(key, now);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return false;
  }

  delete(key) {
    this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }
}
