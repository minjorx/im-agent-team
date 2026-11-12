import { createHash } from 'node:crypto';

function hash(text) {
  return createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12);
}

/**
 * Multi-layer loop protection for bot-to-bot handoffs.
 * All state is per binding (per bot per chat).
 */
export class HandoffGuard {
  constructor({ maxHop = 6, runDeadlineMs = 15 * 60_000, cooldownMs = 60_000, pingPongWindow = 3 } = {}) {
    this.maxHop = maxHop;
    this.runDeadlineMs = runDeadlineMs;
    this.cooldownMs = cooldownMs;
    this.pingPongWindow = pingPongWindow;
    this.runs = new Map();
  }

  run(trace) {
    let run = this.runs.get(trace);
    if (!run) {
      const now = Date.now();
      run = { trace, createdAt: now, deadlineAt: now + this.runDeadlineMs, outbound: 0, pairs: new Map(), recent: [] };
      this.runs.set(trace, run);
    }
    return run;
  }

  check({ trace, hop = 0, kind = 'task', from, to, text }) {
    if (!trace) return { ok: true };
    const run = this.run(trace);
    if (Date.now() > run.deadlineAt) return { ok: false, reason: 'run_expired' };
    if (hop > this.maxHop) return { ok: false, reason: 'hop_exceeded' };
    if (run.outbound >= 20) return { ok: false, reason: 'outbound_budget' };

    const pairKey = `${from}->${to}`;
    const last = run.pairs.get(pairKey) || 0;
    if (kind !== 'review' && this.cooldownMs > 0 && Date.now() - last < this.cooldownMs) {
      return { ok: false, reason: 'cooldown', retryAfterMs: this.cooldownMs - (Date.now() - last) };
    }

    const digest = `${pairKey}:${hash(text)}`;
    const recent = run.recent;
    const same = recent.filter((entry) => entry.digest === digest).length;
    if (same >= this.pingPongWindow - 1) return { ok: false, reason: 'ping_pong' };

    return { ok: true, run };
  }

  record({ trace, from, to, text, kind = 'task' }) {
    if (!trace) return;
    const run = this.run(trace);
    run.outbound += 1;
    if (kind !== 'ack') run.pairs.set(`${from}->${to}`, Date.now());
    run.recent.push({ digest: `${from}->${to}:${hash(text)}`, at: Date.now() });
    if (run.recent.length > 20) run.recent.shift();
  }

  attachToRun(trace, { deadlineAt } = {}) {
    if (!trace) return;
    const run = this.run(trace);
    if (deadlineAt) run.deadlineAt = Math.min(run.deadlineAt, deadlineAt);
    return run;
  }

  reset(trace) {
    this.runs.delete(trace);
  }

  sweep(now = Date.now()) {
    for (const [trace, run] of this.runs) {
      if (now - run.deadlineAt > 60 * 60_000) this.runs.delete(trace);
    }
  }

  snapshot() {
    return [...this.runs.values()].map((run) => ({
      trace: run.trace,
      outbound: run.outbound,
      deadlineAt: run.deadlineAt,
      ageMs: Date.now() - run.createdAt,
    }));
  }
}
