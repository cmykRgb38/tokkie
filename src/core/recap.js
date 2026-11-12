'use strict';
/**
 * The weekly recap: one week (Monday to Sunday, your local time) of runs with Claude and Codex, compared with the week
 * before. Only counts and times: no prompts, no folder names, so the card is safe to copy and share.
 */
const { byDay, currentStreak, dayKey } = require('./achievements');

/** Monday 00:00 (local) of the week `offset` weeks before the one holding `now`. */
function weekStart(now, offset = 0) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7 * offset);
  return d.getTime();
}
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d.getTime(); };

function totals(runs) {
  const t = { runs: runs.length, tokens: 0, seconds: 0, claude: 0, codex: 0, claudeTokens: 0, codexTokens: 0 };
  for (const s of runs) {
    const tok = s.headline || 0;
    t.tokens += tok; t.seconds += s.duration || 0;
    if ((s.provider || 'claude') === 'codex') { t.codex++; t.codexTokens += tok; } else { t.claude++; t.claudeTokens += tok; }
  }
  return t;
}

/** Percent change, or null when there's nothing to compare with. */
const change = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);

/**
 * @param {object} o
 * @param {Array} o.samples   every remembered run
 * @param {number} o.now
 * @param {number} [o.offset] 0 = this week, 1 = last week…
 * @param {(from:number,to:number)=>number|null} [o.usd] exact Claude Code dollars in a time range, when known
 * @param {Object} [o.earned] badges kept {id: at}
 */
function recap({ samples = [], now = Date.now(), offset = 0, usd = null, earned = {}, names = {} }) {
  const from = weekStart(now, offset), to = addDays(from, 7), pfrom = addDays(from, -7);
  const all = samples.filter((s) => Number.isFinite(s.start)).sort((a, b) => a.start - b.start);
  const runs = all.filter((s) => s.start >= from && s.start < to);
  const prevRuns = all.filter((s) => s.start >= pfrom && s.start < from);
  const t = totals(runs), p = totals(prevRuns);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const a = addDays(from, i), b = addDays(from, i + 1), r = runs.filter((s) => s.start >= a && s.start < b);
    days.push({ day: a, runs: r.length, tokens: r.reduce((n, s) => n + (s.headline || 0), 0), future: a > now });
  }
  const busiest = days.reduce((m, d) => (d.tokens > (m ? m.tokens : 0) ? d : m), null);
  const longest = runs.reduce((m, s) => ((s.duration || 0) > (m ? m.duration : 0) ? s : m), null);
  const hours = new Array(24).fill(0); for (const s of runs) hours[new Date(s.start).getHours()]++;
  const peak = t.runs ? hours.indexOf(Math.max(...hours)) : null;
  const end = Math.min(now, to - 1);
  const dollars = usd ? usd(from, to) : null;
  const badges = Object.entries(earned || {}).filter(([, at]) => at >= from && at < to).sort((a, b) => a[1] - b[1]).map(([id]) => ({ id, name: names[id] || id }));
  return {
    from, to, offset, done: now >= to, now,
    ...t,
    activeDays: days.filter((d) => d.runs).length,
    days, busiest: busiest && busiest.tokens ? { day: busiest.day, runs: busiest.runs, tokens: busiest.tokens } : null,
    longest: longest && longest.duration ? { duration: longest.duration, provider: longest.provider || 'claude', start: longest.start } : null,
    peakHour: peak,
    streak: currentStreak(byDay(all.filter((s) => s.start < to)), end),
    usd: Number.isFinite(dollars) && dollars > 0 ? dollars : null,
    prev: { runs: p.runs, tokens: p.tokens, seconds: p.seconds },
    vs: { runs: change(t.runs, p.runs), tokens: change(t.tokens, p.tokens), seconds: change(t.seconds, p.seconds) },
    badges,
    hasEarlier: all.length > 0 && all[0].start < from,
  };
}

module.exports = { recap, weekStart, dayKey };
