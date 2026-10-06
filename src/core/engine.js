'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Store } = require('./store');
const { Tailer } = require('./tailer');
const { transcriptRoots, tokkieHome } = require('./paths');
const { readLimits, compute } = require('./limits');
const { predict, planVerdict, finishTimestamp, PREV_WINDOW_MS } = require('./predict');
const { estimateTokens } = require('./tokens');
const { readDesktopUsage, statMtime } = require('./desktopUsage');
const { buildMeters } = require('./meters');
const { tokensPer100, liveEstimate } = require('./calibrate');
const { evolutionFor } = require('./evolution');
const { headline } = require('./parser');

/**
 * Everything the UI needs, with no Electron dependency (so it is testable and reusable).
 * Emits 'change' (data changed), 'turn-end' ({duration, tokens}) for live-finished turns.
 */
class Engine extends EventEmitter {
  constructor({ settings, now = Date.now, roots, env = process.env, home = os.homedir(), desktopDirs } = {}) {
    super();
    this.desktopDirs = desktopDirs;      // where the Claude desktop app keeps its data (tests override this)
    this.settings = settings; this.now = now; this.env = env; this.home = home;
    this.store = new Store({ now });
    this.limitsFile = path.join(tokkieHome(env, home), 'rate_limits.json');
    this.limitsMtime = 0; this.limits = null;
    this.desktopMtime = -1; this.desktop = null; this.desktopK = {}; this.calibAt = 0; this.pending = [];   // pending = recent estimates, matched to the run they predicted
    this.loaded = false;
    this.tailer = new Tailer({ roots: roots || (() => transcriptRoots({ env, home })), onEvents: (evs) => this._onLive(evs), now });
    this.dirty = true;
  }

  async start() {
    for (const s of this.settings.get('samples') || []) this.store.addSample(s);
    this.store.onSample = null;
    // Feeding starts the first time Tokkie runs; older messages are never counted.
    const ev0 = this.settings.get('evolution');
    if (!ev0.start) this.settings.set({ evolution: { ...ev0, start: this.now() } });
    this.store.onPrune = (m) => {
      const ev = this.settings.get('evolution');
      if (m.ts >= ev.start) this.settings.set({ evolution: { ...ev, archived: ev.archived + m.input + m.output + m.cacheWrite } });
    };
    const evs = await this.tailer.initialScan();
    for (const e of evs) this.store.ingest(e);
    this.store.prune();
    this.loaded = true;
    this._readLimits();
    this._readDesktop();
    this._calibrate();                // the first scan has just finished: now the ledger can be compared with Claude's readings
    this._persistSamples();
    this.store.onSample = (s) => { this._attachEstimate(s); this._persistSamples(); this.emit('turn-end', { duration: s.duration, tokens: s.tokens }); };
    this.tailer.start();
    this.tick = setInterval(() => { this._readLimits(); this._readDesktop(); this.store.prune(); }, 2000);
    this.tick.unref?.();
    this.emit('change');
  }
  stop() { this.tailer.stop(); clearInterval(this.tick); this.settings.save(); }

  _onLive(evs) {
    for (const e of evs) this.store.ingest(e);
    this.emit('change');
  }

  /** Pair a finished run with the estimate that was made for it (same prompt length, estimated shortly before it started). */
  _attachEstimate(s) {
    const cand = this.pending.filter((p) => Math.abs(p.chars - s.chars) <= Math.max(6, s.chars * 0.06) && p.at <= s.start + 90e3 && s.start - p.at < 6 * 3600e3).sort((a, b) => b.at - a.at)[0];
    if (!cand) return;
    s.est = { dur: cand.dur, head: cand.head };
    this.pending = this.pending.filter((p) => p !== cand);
  }

  _persistSamples() { this.settings.set({ samples: this.store.samples.slice(-300) }); }

  _readLimits() {
    try {
      const st = fs.statSync(this.limitsFile);
      if (st.mtimeMs !== this.limitsMtime) { this.limitsMtime = st.mtimeMs; this.limits = readLimits(this.limitsFile); this.emit('change'); }
    } catch { if (this.limits) { this.limits = null; this.limitsMtime = 0; this.emit('change'); } }
  }

  _readDesktop() {
    const m = statMtime(this.desktopDirs);
    if (m === this.desktopMtime) return;
    this.desktopMtime = m; this.desktop = readDesktopUsage(this.desktopDirs); this._calibrate(); this.emit('change');
  }

  /** tokens-per-1% for each window, from Claude's own reading history vs what we saw in between (cheap; redone when the file changes). */
  _calibrate() {
    const d = this.desktop, now = this.now();
    this.desktopK = d && d.series ? { five: tokensPer100(d.series.five, this.store, now), seven: tokensPer100(d.series.seven, this.store, now), extra: tokensPer100(d.series.extra, this.store, now) } : {};
    this.calibAt = now;
  }

  /** Current plan-limit view incl. live extrapolation; persists calibration so it survives restarts. */
  limitsView(now = this.now()) {
    const calib = this.settings.get('calib');
    const v = compute(this.limits, this.store, calib, now);
    let changed = false;
    for (const [k, w] of [['five', v.five], ['seven', v.seven]]) {
      if (w && w.k && Math.abs((calib[k].k || 0) - w.k) > w.k * 0.02) { calib[k] = { k: w.k }; changed = true; }
    }
    if (changed) this.settings.set({ calib });
    return v;
  }

  /** Lifetime tokens the pet has eaten = banked (already pruned) + everything still in memory since feeding began. */
  eaten() {
    if (process.env.TOKKIE_EVO_EATEN) return Number(process.env.TOKKIE_EVO_EATEN) || 0;     // QA override
    const { start, archived } = this.settings.get('evolution');
    let sum = archived || 0;
    for (const m of this.store.msgs.values()) if (m.ts >= start) sum += m.input + m.output + m.cacheWrite;
    return sum;
  }

  /** Newest finished runs with their actual cost, and how the estimate (if one was made) held up. */
  recentRuns(n = 8) {
    return this.store.samples.slice(-n).reverse().map((s) => ({ start: s.start, chars: s.chars, duration: s.duration, headline: s.headline || 0, tokens: s.tokens, est: s.est || null }));
  }

  snapshot(now = this.now()) {
    const key = `${this.store.version}:${Math.floor(now / 1000)}:${this.limitsMtime}:${this.loaded}`;
    if (this._snapKey === key) return this._snap;
    const snap = this._snapshot(now);
    this._snapKey = key; this._snap = snap;
    return snap;
  }

  _snapshot(now) {
    const t = this.store.aggregate(now);
    const lim = this.limitsView(now);
    const budget = this.settings.get('fallbackBudget5h') || 0;
    const fallback = !lim.connected && budget > 0 ? { budget, usedPct: Math.min(100, (t.last5h.weighted / budget) * 100) } : null;
    const active = this.store.activeTurn(now);
    if (now - this.calibAt > 600e3) this._calibrate();
    const live = (id, reading) => liveEstimate(reading, this.desktopK[id], this.store, now);
    const meters = buildMeters({ statusline: lim, desktop: this.desktop, fallback, now, live });
    const eta = active ? predict(this.store.samples, '', active.chars, { prev: active.prev || 0, hint: active.hint }).duration : null;
    return {
      now, loaded: this.loaded, eta,
      active, activeCount: this.store.activeCount(now), lastTurnEnd: this.store.lastTurnEnd, lastTurn: { end: this.store.recent.end, dur: this.store.recent.dur }, lastEvent: this.store.lastEvent,
      tokens: { today: t.today.headline, last5h: t.last5h.headline, week: t.week.headline, burn: t.burn, weightedLast5h: t.last5h.weighted },
      spark: t.spark,
      limits: lim, fallback, block: t.block,
      meters, desktopSeen: !!this.desktop, evolution: evolutionFor(this.eaten()),
      runs: this.recentRuns(8), k5: (this.settings.get('calib').five || {}).k || null,
      samples: this.store.samples.length,
      files: this.tailer.files.size,
    };
  }

  _remember(chars, pred, now) {
    if (chars < 20) return;
    const band = (b) => ({ p25: b.p25, p50: b.p50, p75: b.p75, p90: b.p90 });
    const entry = { at: now, chars, dur: band(pred.duration), head: band(pred.headline) };
    // The textbox re-estimates while you type: keep one evolving entry per prompt instead of a pile.
    const i = this.pending.findIndex((p) => now - p.at < 120e3 && Math.abs(p.chars - chars) < Math.max(60, chars * 0.5));
    if (i >= 0) this.pending[i] = entry; else this.pending.push(entry);
    this.pending = this.pending.filter((p) => now - p.at < 6 * 3600e3).slice(-6);
  }

  /** The planner: tokens, duration range, share of the limit, and the go/no-go verdict. */
  estimate(text, now = this.now()) {
    text = String(text || '');
    const chars = text.length;
    const r = this.store.recent;
    const pred = predict(this.store.samples, text, chars, { prev: now - r.end < PREV_WINDOW_MS ? r.dur : 0 });
    const finishBy = finishTimestamp(this.settings.get('finishBy'), now);
    const plan = planVerdict(pred, now, finishBy, this.settings.get('bufferMin'));
    this._remember(chars, pred, now);
    const k = (this.settings.get('calib').five || {}).k;
    const share = k ? { lo: (pred.tokens.p25 / k) * 100, mid: (pred.tokens.p50 / k) * 100, hi: (pred.tokens.p75 / k) * 100 } : null;
    return { chars, promptTokens: estimateTokens(text), duration: pred.duration, tokens: pred.tokens, headline: pred.headline, share, confidence: pred.confidence, n: pred.n, method: pred.method, plan, finishBy, now };
  }
}

module.exports = { Engine };
