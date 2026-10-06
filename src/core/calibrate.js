'use strict';
/**
 * Claude's saved usage readings are sparse (a few per day) but Tokkie sees every token as it happens. Comparing consecutive
 * readings with the tokens used between them gives "tokens per 1%", which lets us turn the last reading into a live estimate:
 *
 *     live % = last reading % + tokens used since that reading / (tokens per 1%)
 *
 * Validated on real data: a 5-hour-old reading of 21.4% was extrapolated to 35.7% when Claude's own page said 35%.
 */
const MAX_GAP_MS = 8 * 3600e3;       // pairs further apart than this include too much unseen usage (e.g. Chat) to be trusted
const RECENT_MS = 7 * 86400e3;       // the in-memory ledger only covers about a week

/** @returns {number|null} weighted tokens per 100% */
function tokensPer100(series, store, now = Date.now()) {
  let dw = 0, dp = 0, pairs = 0;
  const recent = (series || []).filter((s) => now - s.t <= RECENT_MS);
  for (let i = 1; i < recent.length && pairs < 40; i++) {
    const a = recent[i - 1], b = recent[i], p = b.pct - a.pct;
    if (p < 0.5 || b.t - a.t > MAX_GAP_MS) continue;               // resets (pct drops) and idle pairs carry no information
    const w = store.sumSince(a.t, b.t).weighted;
    if (w <= 0) continue;
    dw += w; dp += p; pairs++;
  }
  return dp >= 2 && dw > 0 ? (dw / dp) * 100 : null;
}

/** Live estimate from a reading {pct,t}; returns null when we can't calibrate. */
function liveEstimate(reading, k, store, now = Date.now()) {
  if (!reading || !k) return null;
  const used = store.sumSince(reading.t + 1, now).weighted;
  return { pct: Math.min(100, reading.pct + (used / k) * 100), baseline: reading.pct, added: (used / k) * 100 };
}

module.exports = { tokensPer100, liveEstimate };
