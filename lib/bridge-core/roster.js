function keyOf(peer) {
  return (peer.unionId || peer.name || peer.openId || '').toLowerCase();
}

export class Roster {
  constructor(self = {}, peers = []) {
    this.self = {
      appId: self.appId || '',
      name: self.name || '机器人',
      openId: self.openId || '',
      unionId: self.unionId,
      tenantKey: self.tenantKey,
    };
    this.peers = new Map();
    for (const peer of peers) this.upsert(peer, 'manual');
    this.normalize();
    this.version = 1;
  }

  /** Collapse duplicate display names, preferring entries that carry a role. */
  normalize() {
    const byName = new Map();
    for (const peer of this.peers.values()) {
      const existing = byName.get(peer.name);
      if (!existing || (!existing.role && peer.role)) byName.set(peer.name, peer);
    }
    if (byName.size !== this.peers.size) {
      this.peers = new Map([...byName.values()].map((peer) => [peer.key, peer]));
      this.version += 1;
    }
    return this;
  }

  upsert(peer, source = 'mention') {
    const name = String(peer?.name || '').trim();
    const openId = String(peer?.openId || '').trim();
    if (!name && !openId) return undefined;
    let key = keyOf(peer);
    if (!this.peers.has(key) && name) {
      const named = [...this.peers.values()].find((item) => item.name === name);
      if (named) key = named.key;
    }
    if (!this.peers.has(key) && openId) {
      const identified = [...this.peers.values()].find((item) => item.openId === openId);
      if (identified) key = identified.key;
    }
    const previous = this.peers.get(key);
    const next = {
      key,
      name: name || previous?.name || openId,
      openId: openId || previous?.openId || '',
      unionId: peer?.unionId || previous?.unionId,
      role: peer?.role || previous?.role,
      lastSeenAt: Date.now(),
      source: previous?.source === 'manual' ? 'manual' : source,
    };
    this.peers.set(key, next);
    this.version += 1;
    return next;
  }

  /** Learn peers from a Feishu mentions[] array; ids are scoped to this app. */
  learnFromMentions(mentions) {
    let learned = 0;
    for (const mention of mentions || []) {
      if (!mention?.openId) continue;
      if (mention.openId === this.self.openId) continue;
      if (this.self.unionId && mention.unionId === this.self.unionId) continue;
      this.upsert(
        {
          name: mention.name,
          openId: mention.openId,
          unionId: mention.unionId,
        },
        'mention',
      );
      learned += 1;
    }
    return learned;
  }

  remove(key) {
    return this.peers.delete(String(key || '').toLowerCase());
  }

  find(nameOrKey) {
    const needle = String(nameOrKey || '').trim().toLowerCase();
    if (!needle) return undefined;
    const direct = this.peers.get(needle);
    if (direct) return direct;
    for (const peer of this.peers.values()) {
      if (peer.name.toLowerCase() === needle) return peer;
      if (peer.openId === nameOrKey) return peer;
    }
    return undefined;
  }

  list() {
    return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  toJSON() {
    return {
      self: this.self,
      peers: this.list(),
      version: this.version,
    };
  }
}

export function describePeer(peer) {
  if (!peer) return '';
  const role = peer.role?.mission ? `：${peer.role.mission}` : '';
  return `${peer.name}${role}`;
}
