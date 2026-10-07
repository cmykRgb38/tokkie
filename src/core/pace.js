'use strict';
/**
 * Pace: how fast you're using a limit compared with how fast its period is passing (after Token Weather's gauges).
 * pace = % used − % of the period elapsed. Above 0 you're using faster than time passes; we also project when
 * you'd hit 100% at the current rate, if that's before the reset.
 */
const H = 3600e3;
const SPAN = { five: 5 * H, seven: 7 * 24 * H };

/** Monthly period that resets at 00:00 UTC on `day` (Claude shows e.g. "Resets Sun, Nov 1, 8:00 AM GMT+8"). */
function monthlyPeriod(day, now) {
  const d = Math.max(1, Math.min(28, Math.round(day) || 1));
  const t = new Date(now);
  let end = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), d);
  if (end <= now) end = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, d);
  const e = new Date(end);
  const start = Date.UTC(e.getUTCFullYear(), e.getUTCMonth() - 1, d);
  return { start, end };
}

function periodOf(meter, resetDay, now) {
  if ((meter.id === 'five' || meter.id === 'seven') && meter.resetsAt) return { start: meter.resetsAt - SPAN[meter.id], end: meter.resetsAt };
  if (meter.id === 'extra' || meter.id === 'spend' || meter.id === 'budget') {
    if (meter.resetsAt && meter.id === 'spend') return { start: monthlyPeriod(resetDay, now).start, end: meter.resetsAt };
    return monthlyPeriod(resetDay, now);
  }
  return null;
}

function paceOf(meter, resetDay, now = Date.now()) {
  const p = periodOf(meter, resetDay, now);
  if (!p || !(p.end > p.start)) return null;
  const elapsed = Math.max(0, Math.min(100, ((now - p.start) / (p.end - p.start)) * 100));
  const used = Math.max(0, meter.pct);
  const pace = used - elapsed;
  const tone = used >= 90 || pace > 15 ? 'alert' : pace > 0 ? 'fast' : 'calm';
  let runOutAt = null;
  if (used > 0.5 && now > p.start && used < 100) {
    const hit = p.start + ((now - p.start) * 100) / used;     // at the average rate so far
    if (hit < p.end) runOutAt = hit;
  }
  return { elapsed, pace, tone, runOutAt, periodStart: p.start, periodEnd: p.end };
}

module.exports = { paceOf, monthlyPeriod };
