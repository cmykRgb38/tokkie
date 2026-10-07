'use strict';
/**
 * Plan-limit tracking. The only trustworthy source of "% of your plan used" is Claude Code's statusline
 * payload (rate_limits.five_hour / seven_day). A tiny hook script writes that to ~/.tokkie/rate_limits.json.
 * Between readings we extrapolate live from local token counts, calibrated against the last reading.
 */
const fs = require('fs');
const path = require('path');

function readLimits(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

/**
 * @param {object} win       {used_percentage, resets_at(sec)} from the statusline
 * @param {number} spanMs    window length
 * @param {Store} store
 * @param {{k?:number}} calib persisted calibration (weighted tokens per 100%)
 */
function windowStatus(win, spanMs, store, calib, readingTs, now = Date.now()) {
  if (!win || !Number.isFinite(win.used_percentage) || !Number.isFinite(win.resets_at) || !Number.isFinite(readingTs)) return null;
  const resetsAt = win.resets_at * 1000;
  const start = resetsAt - spanMs;
  const reportedPct = Math.max(0, win.used_percentage);

  if (now >= resetsAt) {
    // Reading is for a window that has since reset. We know nothing except "it reset".
    return { pct: null, stale: true, resetsAt, reported: reportedPct, approx: true, expired: true };
  }
  const wNow = store.sumSince(start, now).weighted;
  const wAtReading = store.sumSince(start, readingTs).weighted;
  let k = calib && calib.k;
  if (reportedPct >= 3 && wAtReading > 0) k = wAtReading / (reportedPct / 100); // fresh calibration beats stored
  let pct = reportedPct;
  let approx = false;
  if (k && wNow > wAtReading) { pct = reportedPct + ((wNow - wAtReading) / k) * 100; approx = true; }
  pct = Math.min(100, pct);
  return { pct, reported: reportedPct, resetsAt, k: k || null, approx, stale: now - readingTs > 30 * 60e3, expired: false };
}

function compute(limits, store, calib, now = Date.now()) {
  if (!limits) return { connected: false };
  const tsOf = (w) => { const t = w && Number.isFinite(w.updated_at) ? w.updated_at : limits.updated_at; return Number.isFinite(t) ? t * 1000 : NaN; };
  const five = windowStatus(limits.five_hour, 5 * 3600e3, store, calib && calib.five, tsOf(limits.five_hour), now);
  const seven = windowStatus(limits.seven_day, 7 * 86400e3, store, calib && calib.seven, tsOf(limits.seven_day), now);
  const spend = windowStatus(limits.spend_limit, 30 * 86400e3, store, calib && calib.spend, tsOf(limits.spend_limit), now);
  return { connected: !!(five || seven || spend), updatedAt: Math.max(five ? tsOf(limits.five_hour) : 0, seven ? tsOf(limits.seven_day) : 0, spend ? tsOf(limits.spend_limit) : 0), five, seven, spend };
}

module.exports = { readLimits, compute, windowStatus };
