'use strict';
/**
 * Turns every available source of "how much of my plan have I used" into one ordered list of meters.
 * Sources, best first per window: the Claude app's own readings (server truth, includes chat) vs Claude Code's status line
 * (server truth + live extrapolation), whichever is newer; then a manual token budget as a last resort.
 */
function buildMeters({ statusline, desktop, fallback, now, live }) {
  const out = [];
  const pick = (id, label, sl, dk) => {
    let best = null;
    const slTs = statusline && statusline.updatedAt;
    if (sl && !sl.expired && Number.isFinite(sl.pct)) best = { id, label, pct: sl.pct, approx: !!sl.approx, resetsAt: sl.resetsAt || null, readAt: slTs || now, source: 'claude-code' };
    if (dk && Number.isFinite(dk.pct) && (!best || dk.t > best.readAt)) {
      const est = live ? live(id, dk) : null;           // bridge the gap since Claude last saved a reading
      best = { id, label, pct: est ? est.pct : dk.pct, approx: !!est, baseline: est ? est.baseline : undefined, resetsAt: best ? best.resetsAt : null, readAt: dk.t, source: dk.manual ? 'manual' : 'claude-app', manual: !!dk.manual };
    }
    if (best) { best.pct = Math.max(0, Math.min(100, best.pct)); out.push(best); }
  };
  pick('five', '5-hour limit', statusline && statusline.five, desktop && desktop.five);
  if (desktop && desktop.extra && Number.isFinite(desktop.extra.pct)) {
    const est = live ? live('extra', desktop.extra) : null;
    out.push({ id: 'extra', label: 'Usage limit', pct: Math.max(0, Math.min(100, est ? est.pct : desktop.extra.pct)), approx: !!est, baseline: est ? est.baseline : undefined, resetsAt: null, readAt: desktop.extra.t, source: desktop.extra.manual ? 'manual' : 'claude-app' });
  }
  pick('seven', 'Weekly limit', statusline && statusline.seven, desktop && desktop.seven);
  if (!out.length && fallback) out.push({ id: 'budget', label: '5-hour budget', pct: Math.min(100, fallback.usedPct), approx: true, resetsAt: null, readAt: now, source: 'estimate' });
  return out;
}

module.exports = { buildMeters };
