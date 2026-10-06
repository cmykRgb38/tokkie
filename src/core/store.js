'use strict';
const { weighted, headline } = require('./parser');

const H = 3600e3, DAY = 24 * H;
const MAX_TURN_MS = 4 * H, MIN_TURN_MS = 2500, STALE_TURN_MS = 15 * 60e3;
const KEEP_MS = 8 * DAY;

/**
 * In-memory ledger fed by parsed events. Idempotent: replaying the same log lines never double counts
 * (assistant messages are upserted by message id; Claude Code rewrites a message as it streams).
 */
class Store {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.msgs = new Map();        // id -> {ts, input, output, cacheWrite, cacheRead, sessionId}
    this.sessions = new Map();    // sessionId -> open turn {start, chars, lastTs, tokens}
    this.samples = [];            // finished turns {start, chars, duration(s), tokens, output}
    this.sampleKeys = new Set();
    this.lastEvent = 0;
    this.version = 0;
    this.lastTurnEnd = 0;
    this.lastDur = new Map();     // sessionId -> seconds of its most recent finished turn
    this.recent = { dur: 0, end: 0 }; // most recent finished turn anywhere
    this.onPrune = null;          // called with each message about to be forgotten (the engine banks its tokens for the pet)
    this.onSample = null;         // called with each newly finished turn (live only; engine sets it after the initial replay)
  }

  addSample(s) {
    const key = `${s.sessionId}:${s.start}`;
    if (this.sampleKeys.has(key)) return false;
    this.sampleKeys.add(key);
    this.samples.push(s);
    this.samples.sort((a, b) => a.start - b.start);
    if (this.samples.length > 500) { const x = this.samples.shift(); this.sampleKeys.delete(`${x.sessionId}:${x.start}`); }
    return true;
  }

  /** Feed one parsed event. */
  ingest(ev) {
    if (!ev) return;
    this.version++;
    if (ev.ts > this.lastEvent) this.lastEvent = ev.ts;
    const turn = this.sessions.get(ev.sessionId);

    if (ev.kind === 'prompt') {
      this.sessions.set(ev.sessionId, { start: ev.ts, chars: ev.chars, hint: ev.hint || 1, lastTs: ev.ts, tokens: 0, output: 0, prev: this.lastDur.get(ev.sessionId) || 0 });
    } else if (ev.kind === 'interrupt') {
      this.sessions.delete(ev.sessionId);
    } else if (ev.kind === 'usage') {
      const prev = this.msgs.get(ev.id);
      // Streaming rewrites: keep whichever copy has seen more output.
      if (!prev || ev.output >= prev.output) {
        this.msgs.set(ev.id, { ts: ev.ts, input: ev.input, output: ev.output, cacheWrite: ev.cacheWrite, cacheRead: ev.cacheRead, sessionId: ev.sessionId });
      }
      if (turn && ev.ts >= turn.start) {
        turn.lastTs = Math.max(turn.lastTs, ev.ts);
        turn.msgs = turn.msgs || new Map();
        const old = turn.msgs.get(ev.id);
        if (!old || ev.output >= old.out) turn.msgs.set(ev.id, { w: weighted(ev), out: ev.output, h: headline(ev) });
        if (ev.ending) this._finish(ev.sessionId, turn, ev.ts);
      }
    }
  }

  _finish(sessionId, turn, endTs) {
    this.sessions.delete(sessionId);
    const ms = endTs - turn.start;
    this.lastTurnEnd = endTs;
    if (ms < MIN_TURN_MS || ms > MAX_TURN_MS) return;
    let tokens = 0, output = 0, head = 0;
    for (const m of (turn.msgs || new Map()).values()) { tokens += m.w; output += m.out; head += m.h; }
    this.lastDur.set(sessionId, ms / 1000);
    if (endTs >= this.recent.end) this.recent = { dur: ms / 1000, end: endTs };
    const sample = { sessionId, start: turn.start, chars: turn.chars, hint: turn.hint, prev: turn.prev, duration: ms / 1000, tokens, headline: head, output };
    if (this.addSample(sample) && this.onSample) this.onSample(sample);
  }

  prune() {
    const cut = this.now() - KEEP_MS;
    for (const [id, m] of this.msgs) if (m.ts < cut) { if (this.onPrune) this.onPrune(m); this.msgs.delete(id); }
    for (const [sid, t] of this.sessions) if (this.now() - Math.max(t.lastTs, t.start) > 6 * H) this.sessions.delete(sid);
    for (const sid of this.lastDur.keys()) if (!this.sessions.has(sid) && this.lastDur.size > 200) this.lastDur.delete(sid);
  }

  /** Sum usage since a timestamp. */
  sumSince(since, until = Infinity) {
    const r = { headline: 0, weighted: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 };
    for (const m of this.msgs.values()) {
      if (m.ts < since || m.ts > until) continue;
      r.input += m.input; r.output += m.output; r.cacheWrite += m.cacheWrite; r.cacheRead += m.cacheRead; r.messages++;
    }
    r.headline = r.input + r.output + r.cacheWrite;
    r.weighted = r.input + r.output + r.cacheWrite + r.cacheRead * 0.1;
    return r;
  }

  /**
   * Local approximation of the 5-hour window when the real reset time is unknown:
   * a block starts at the hour of the first message after the previous block ended.
   */
  currentBlock(now = this.now()) {
    if (this._tsVersion !== this.version) { this._ts = [...this.msgs.values()].map((m) => m.ts).sort((a, b) => a - b); this._tsVersion = this.version; }
    const ts = this._ts.filter((t) => t <= now);
    let start = null;
    for (const t of ts) {
      if (start === null || t >= start + 5 * H) start = Math.floor(t / H) * H;
    }
    if (start === null || now >= start + 5 * H) return null;
    return { start, end: start + 5 * H };
  }

  /** 60 one-minute buckets of headline tokens ending now (for the live sparkline). */
  sparkline(minutes = 60, now = this.now()) {
    const b = new Array(minutes).fill(0);
    const start = now - minutes * 60e3;
    for (const m of this.msgs.values()) {
      if (m.ts < start || m.ts > now) continue;
      b[Math.min(minutes - 1, Math.floor((m.ts - start) / 60e3))] += m.input + m.output + m.cacheWrite;
    }
    return b;
  }

  /** Weighted tokens per minute over the last `minutes`. */
  burnRate(minutes = 20, now = this.now()) {
    const r = this.sumSince(now - minutes * 60e3, now);
    return r.weighted / minutes;
  }

  /** The turn currently running anywhere (most recent), or null. Stale turns are ignored. */
  activeTurn(now = this.now()) {
    let best = null;
    for (const [sessionId, t] of this.sessions) {
      const last = Math.max(t.lastTs, t.start);
      if (now - last > STALE_TURN_MS) continue;
      if (!best || t.start > best.start) best = { sessionId, start: t.start, chars: t.chars, hint: t.hint, prev: t.prev, lastTs: last, elapsed: now - t.start };
    }
    return best;
  }

  activeCount(now = this.now()) {
    let n = 0;
    for (const t of this.sessions.values()) if (now - Math.max(t.lastTs, t.start) <= STALE_TURN_MS) n++;
    return n;
  }

  /** Everything the UI needs from the ledger in ONE pass (a heavy user has 100k+ messages; this runs every second). */
  aggregate(now = this.now(), sparkMinutes = 60, burnMinutes = 20) {
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    const today = d0.getTime(), t5 = now - 5 * H, wk = now - 7 * DAY, burnFrom = now - burnMinutes * 60e3, spFrom = now - sparkMinutes * 60e3;
    const mk = () => ({ headline: 0, weighted: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 });
    const out = { today: mk(), last5h: mk(), week: mk() }, spark = new Array(sparkMinutes).fill(0);
    let burn = 0;
    const add = (r, m) => { r.input += m.input; r.output += m.output; r.cacheWrite += m.cacheWrite; r.cacheRead += m.cacheRead; r.messages++; };
    for (const m of this.msgs.values()) {
      if (m.ts > now || m.ts < wk) continue;
      add(out.week, m);
      if (m.ts >= t5) add(out.last5h, m);
      if (m.ts >= today) add(out.today, m);
      const head = m.input + m.output + m.cacheWrite;
      if (m.ts >= burnFrom) burn += head + m.cacheRead * 0.1;
      if (m.ts >= spFrom) spark[Math.min(sparkMinutes - 1, Math.floor((m.ts - spFrom) / 60e3))] += head;
    }
    for (const r of Object.values(out)) { r.headline = r.input + r.output + r.cacheWrite; r.weighted = r.headline + r.cacheRead * 0.1; }
    return { ...out, burn: burn / burnMinutes, spark, block: this.currentBlock(now) };
  }

  snapshotTotals(now = this.now()) {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    return {
      today: this.sumSince(d.getTime(), now),
      last5h: this.sumSince(now - 5 * H, now),
      week: this.sumSince(now - 7 * DAY, now),
      block: this.currentBlock(now),
    };
  }
}

module.exports = { Store, H, DAY };
