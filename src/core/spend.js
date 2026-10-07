'use strict';
/**
 * Exact dollars spent in Claude Code, from the Tokkie bridge (each session's running cost as /cost totals it).
 * Turned into a ledger of increments with timestamps, so "dollars spent since Claude's last reading" is exact.
 * A session first seen with cost already on it is a baseline (that money was spent before we were watching).
 */
const BUCKET_MS = 5 * 60e3;
const KEEP_MS = 45 * 86400e3;

class SpendLedger {
  constructor(settings, now = Date.now) {
    this.settings = settings; this.now = now;
    const s = settings.get('spend') || {};
    this.state = { since: s.since || 0, bridgeSince: s.bridgeSince || 0, last: { ...(s.last || {}) }, events: Array.isArray(s.events) ? s.events.filter((e) => Array.isArray(e) && e.length === 2 && Number.isFinite(e[0]) && Number.isFinite(e[1])) : [] };
    if (!this.state.since) { this.state.since = this.now(); this._save(); }
  }

  /** A session's running cost was observed: add what it grew by. */
  observe(key, usd, at) {
    if (!Number.isFinite(usd) || usd < 0 || !Number.isFinite(at)) return 0;
    if (!this.state.bridgeSince) this.state.bridgeSince = at;
    const prev = this.state.last[key];
    let delta = 0;
    if (prev === undefined) delta = 0;                 // first sight: a baseline, whatever it already cost
    else if (usd >= prev) delta = usd - prev;
    else delta = usd;                                  // the session restarted its count (e.g. /clear)
    this.state.last[key] = usd;
    if (delta > 0) this._add(at, delta);
    this._save();
    return delta;
  }

  _add(at, usd) {
    const b = Math.floor(at / BUCKET_MS) * BUCKET_MS;
    const ev = this.state.events;
    if (ev.length && ev[ev.length - 1][0] === b) ev[ev.length - 1][1] += usd;
    else { ev.push([b, usd]); ev.sort((x, y) => x[0] - y[0]); }
    const cut = this.now() - KEEP_MS;
    while (ev.length && ev[0][0] < cut) ev.shift();
  }

  /** Dollars observed after `t` (bucketed to 5 minutes, so a bucket that straddles t counts in full). */
  since(t) { let s = 0; for (const [b, usd] of this.state.events) if (b + BUCKET_MS > t) s += usd; return s; }
  /** Dollars observed in [a, b) (by 5-minute bucket). */
  between(a, b) { let s = 0; for (const [t, usd] of this.state.events) if (t >= a && t < b) s += usd; return s; }
  /** Whether the bridge has been reporting since before `t` (so dollars after t are complete). */
  covers(t) { return !!this.state.bridgeSince && this.state.bridgeSince <= t; }
  /** Claude Code session ids whose dollars the ledger already counts. */
  sessions() { return new Set(Object.keys(this.state.last).filter((k) => k.startsWith('code:')).map((k) => k.slice(5))); }
  _save() { clearTimeout(this._t); this._t = setTimeout(() => this.flush(), 300); this._t.unref?.(); }
  flush() { clearTimeout(this._t); this.settings.set({ spend: this.state }); }
}

module.exports = { SpendLedger, BUCKET_MS };
