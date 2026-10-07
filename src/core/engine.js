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
const { SpendLedger } = require('./spend');
const { BridgeReader } = require('./bridge');
const { paceOf } = require('./pace');

/**
 * Everything the UI needs, with no Electron dependency (so it is testable and reusable).
 * Emits 'change' (data changed), 'turn-end' ({duration, tokens}) for live-finished turns.
 */
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

class Engine extends EventEmitter {
  constructor({ settings, now = Date.now, roots, env = process.env, home = os.homedir(), desktopDirs } = {}) {
    super();
    this.desktopDirs = desktopDirs;      // where the Claude desktop app keeps its data (tests override this)
    this.settings = settings; this.now = now; this.env = env; this.home = home;
    this.store = new Store({ now });
    this.limitsFile = path.join(tokkieHome(env, home), 'rate_limits.json');
    this.bridge = new BridgeReader(path.join(tokkieHome(env, home), 'bridge'));
    this.ledger = new SpendLedger(settings, now);
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
    this._readBridge();
    this._readDesktop();
    this._calibrate();                // the first scan has just finished: now the ledger can be compared with Claude's readings
    this._persistSamples();
    this.store.onSample = (s) => { this._attachEstimate(s); this._persistSamples(); this.emit('turn-end', { duration: s.duration, tokens: s.tokens }); };
    this.tailer.start();
    this.tick = setInterval(() => { this._readLimits(); this._readBridge(); this._readDesktop(); this.store.prune(); }, 2000);
    this.tick.unref?.();
    this.emit('change');
  }
  stop() { this.tailer.stop(); clearInterval(this.tick); this.ledger.flush(); this.settings.save(); }

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

  /** What the bridge reported from inside Claude Code: exact running cost per session (→ the spend ledger), context, agents. */
  _readBridge() {
    const changed = this.bridge.poll(this.now());
    for (const r of changed) if (r.costUsd != null) this.ledger.observe('code:' + r.sessionId, r.costUsd, r.updatedAt);
    if (changed.length) { this._snapKey = null; this.emit('change'); }
  }

  /**
   * Live % for a meter, starting from Claude's last reading. With a dollar limit set and the bridge running since that
   * reading, Claude Code's part is exact dollars; everything else (Cowork, Chat, Code without the bridge) is estimated from tokens.
   */
  _live(id, reading, now) {
    const limit = this.settings.get('spendLimitUsd') || 0;
    // No calibration from Claude's readings yet (new install, few readings): with a $ limit, learn tokens→% from
    // the bridge's exact dollars instead — your own cost per token × your limit.
    const k = this.desktopK[id] || (id === 'extra' && limit > 0 ? this._dollarK(limit, now) : null);
    if (id === 'extra' && limit > 0 && reading && this.ledger.covers(reading.t)) {
      const usd = this.ledger.since(reading.t + 1);
      const rest = k ? (this.store.sumSince(reading.t + 1, now, this.ledger.sessions()).weighted / k) * 100 : 0;
      const added = (usd / limit) * 100 + rest;
      return { pct: Math.min(100, reading.pct + added), baseline: reading.pct, added, mode: 'dollars', exactUsd: usd };
    }
    return liveEstimate(reading, k, this.store, now);
  }

  /**
   * Weighted tokens per 100% of a dollar limit, from the bridge: exact session costs vs the tokens those
   * sessions used. Cached for a minute. null until there's at least ~$0.50 of matched spend.
   */
  _dollarK(limit, now = this.now()) {
    if (this._dk && now - this._dk.at < 60e3) return this._dk.perUsd ? limit * this._dk.perUsd : null;
    const costs = new Map();
    for (const [key, usd] of Object.entries(this.ledger.state.last)) if (key.startsWith('code:') && usd > 0) costs.set(key.slice(5), usd);
    const tok = new Map();
    if (costs.size) for (const m of this.store.msgs.values()) if (costs.has(m.sessionId)) tok.set(m.sessionId, (tok.get(m.sessionId) || 0) + m.input + m.output + m.cacheWrite + m.cacheRead * 0.1);
    let usd = 0, w = 0;
    for (const [sid, c] of costs) { const t = tok.get(sid) || 0; if (t > 0 && c > 0.02) { usd += c; w += t; } }
    const perUsd = usd >= 0.5 && w > 0 ? w / usd : null;          // weighted tokens per dollar
    this._dk = { at: now, perUsd };
    return perUsd ? limit * perUsd : null;
  }

  _persistSamples() { this.settings.set({ samples: this.store.samples.slice(-300) }); }

  _readLimits() {
    try {
      const st = fs.statSync(this.limitsFile);
      if (st.mtimeMs !== this.limitsMtime) { this.limitsMtime = st.mtimeMs; this.limits = readLimits(this.limitsFile); this.emit('change'); }
    } catch { if (this.limits) { this.limits = null; this.limitsMtime = 0; this.emit('change'); } }
  }

  /** Claude's saved readings plus the ones you typed in, merged per window (newest wins; both feed the calibration). */
  _mergedDesktop() {
    const base = this.desktop ? { ...this.desktop, series: { ...(this.desktop.series || {}) } } : { t: 0, five: null, seven: null, extra: null, series: {} };
    for (const r of this.settings.get('manualReadings') || []) {
      if (!['five', 'seven', 'extra'].includes(r.id) || !Number.isFinite(r.t) || !Number.isFinite(r.pct)) continue;
      base.series[r.id] = [...(base.series[r.id] || []), { t: r.t, pct: r.pct }].sort((a, b) => a.t - b.t);
      if (!base[r.id] || r.t > base[r.id].t) base[r.id] = { pct: r.pct, t: r.t, manual: true };
      base.t = Math.max(base.t || 0, r.t);
    }
    return base;
  }

  /** Record "Claude's Usage page says X% right now" for the given meter. Returns false if the input is not sensible. */
  setManualReading(id, pct, now = this.now()) {
    if (!['five', 'seven', 'extra'].includes(id) || !Number.isFinite(pct) || pct < 0 || pct > 100) return false;
    const list = [...(this.settings.get('manualReadings') || []), { id, t: now, pct }].slice(-60);
    this.settings.set({ manualReadings: list });
    this._snapKey = null;                   // drop the cached snapshot so the new anchor shows immediately
    this._calibrate(); this.emit('change');
    return true;
  }

  _readDesktop() {
    const m = statMtime(this.desktopDirs);
    if (m === this.desktopMtime) return;
    this.desktopMtime = m; this.desktop = readDesktopUsage(this.desktopDirs); this._calibrate(); this.emit('change');
  }

  /** tokens-per-1% for each window, from Claude's own reading history vs what we saw in between (cheap; redone when the file changes). */
  _calibrate() {
    const d = this._mergedDesktop(), now = this.now();
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
  recentRuns(n = 8, turns = []) {
    // A run's exact cost: the bridge's per-prompt cost from the same session, recorded as that run finished.
    const usdFor = (s) => { const end = s.start + s.duration * 1000; const t = turns.find((x) => x.sessionId === s.sessionId && Math.abs(x.at - end) < 30e3); return t ? t.usd : null; };
    return this.store.samples.slice(-n).reverse().map((s) => ({ start: s.start, chars: s.chars, duration: s.duration, headline: s.headline || 0, tokens: s.tokens, est: s.est || null, usd: usdFor(s),
      sessionId: s.sessionId, preview: s.preview || '', find: s.find || '', cwd: s.cwd || '', source: s.source || '', uuid: s.uuid || '', hasText: !!(s.file && s.uuid) }));
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
    const live = (id, reading) => this._live(id, reading, now);
    const meters = buildMeters({ statusline: lim, desktop: this._mergedDesktop(), fallback, now, live });
    const limitUsd = this.settings.get('spendLimitUsd') || 0, resetDay = this.settings.get('resetDay') || 1;
    for (const m of meters) {
      if (m.id === 'five' && !m.resetsAt && t.block) m.resetsAt = t.block.end;      // our own guess at the 5-hour window
      if ((m.id === 'extra' || m.id === 'spend') && limitUsd > 0) { m.limitUsd = limitUsd; m.usd = (m.pct / 100) * limitUsd; }
      m.pace = paceOf(m, resetDay, now);
    }
    const br = this.bridge.latest();
    const fresh = br && now - br.updatedAt < 15 * 60e3 ? br : null;
    const cache = this.store.cacheView(now);
    const ctx = fresh && Number.isFinite(fresh.context.tokens) && (!cache || fresh.sessionId === cache.sessionId)
      ? { tokens: fresh.context.tokens, window: fresh.context.window || null, percent: Number.isFinite(fresh.context.percent) ? fresh.context.percent : null, exact: true }
      : cache ? { tokens: cache.ctxTokens, window: null, percent: null, exact: false } : null;
    const recent = this.store.samples.slice(-20).map((x) => x.tokens).filter((x) => x > 0).sort((a, b) => a - b);
    const typical = recent.length >= 3 ? { p50: recent[Math.floor(recent.length / 2)], p75: recent[Math.floor(recent.length * 0.75)] } : null;
    const nextFit = typical ? this._fit(typical, meters, now) : null;
    const turns = this.bridge.allTurns();
    const lastPrompt = turns.length ? turns[turns.length - 1] : null;
    const eta = active ? predict(this.store.samples, '', active.chars, { prev: active.prev || 0, hint: active.hint }).duration : null;
    return {
      now, loaded: this.loaded, eta,
      active, activeCount: this.store.activeCount(now), lastTurnEnd: this.store.lastTurnEnd, lastTurn: { end: this.store.recent.end, dur: this.store.recent.dur }, lastEvent: this.store.lastEvent,
      tokens: { today: t.today.headline, last5h: t.last5h.headline, week: t.week.headline, burn: t.burn, weightedLast5h: t.last5h.weighted },
      spark: t.spark,
      limits: lim, fallback, block: t.block,
      meters, desktopSeen: !!this.desktop, manualCount: (this.settings.get('manualReadings') || []).length, evolution: evolutionFor(this.eaten()),
      nextFit, cache, context: ctx, agents: fresh ? fresh.agentsRunning : 0, lastPrompt,
      bridge: { seen: !!br, live: !!fresh, since: this.ledger.state.bridgeSince || 0, todayUsd: this.ledger.since(startOfDay(now)) },
      runs: this.recentRuns(8, turns), k5: (this.settings.get('calib').five || {}).k || null,
      samples: this.store.samples.length,
      files: this.tailer.files.size,
    };
  }

  /**
   * Will a prompt of this size fit in what's left? Checked against every limit we can convert tokens into %
   * (5-hour, weekly, usage/spend), and the tightest one wins. need = predicted tokens ÷ tokens-per-100%.
   */
  _fit(tokens, meters, now) {
    let worst = null;
    for (const m of meters || []) {
      if (!Number.isFinite(m.pct) || m.id === 'budget') continue;
      const lim = this.settings.get('spendLimitUsd') || 0;
      const k = m.id === 'five' ? ((this.settings.get('calib').five || {}).k || this.desktopK.five) : this.desktopK[m.id] || (m.id === 'extra' && lim > 0 ? this._dollarK(lim, now) : null);
      const left = Math.max(0, 100 - m.pct);
      if (!k && left > 0) continue;
      const need = k ? { p50: (tokens.p50 / k) * 100, p75: (tokens.p75 / k) * 100 } : { p50: 0, p75: 0 };
      const status = left <= 0.05 || need.p50 >= left ? 'no' : need.p75 >= left ? 'risky' : 'ok';
      const f = { id: m.id, label: m.label, left, need, status, usd: m.limitUsd ? { left: (left / 100) * m.limitUsd, p50: (need.p50 / 100) * m.limitUsd, p75: (need.p75 / 100) * m.limitUsd } : null };
      if (!worst || f.left - f.need.p75 < worst.left - worst.need.p75) worst = f;
    }
    return worst;
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

  /**
   * The full text of a past prompt, read on demand from the conversation log it came from (Tokkie keeps only a
   * preview). Only files Tokkie itself is reading are opened, and only the line with that prompt's id is returned.
   */
  promptText(sessionId, uuid) {
    const s = this.store.samples.find((x) => x.sessionId === sessionId && x.uuid === uuid && x.file);
    if (!s || !this.tailer.files.has(s.file)) return null;
    try {
      const data = fs.readFileSync(s.file, 'utf8');
      const i = data.indexOf(`"uuid":"${uuid}"`);
      if (i < 0) return null;
      const a = data.lastIndexOf('\n', i) + 1, b = data.indexOf('\n', i);
      const d = JSON.parse(data.slice(a, b < 0 ? undefined : b));
      const { textOf } = require('./parser');
      return textOf(d.message && d.message.content).trim().slice(0, 100_000);
    } catch { return null; }
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
    const fit = this._fit(pred.tokens, this.snapshot(now).meters, now);
    return { chars, promptTokens: estimateTokens(text), duration: pred.duration, tokens: pred.tokens, headline: pred.headline, share, fit, confidence: pred.confidence, n: pred.n, method: pred.method, plan, finishBy, now };
  }
}

module.exports = { Engine };
