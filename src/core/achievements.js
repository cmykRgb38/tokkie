'use strict';
/**
 * Badges: little milestones from how you use your AIs. Worked out from the runs Tokkie remembers (90 days), the pet's
 * growth and your collection; once earned a badge is kept for good (with the moment it was earned), even after the
 * runs that earned it are forgotten. Nothing here reads what you wrote: only times, sizes, folders and counts.
 */
const DAY = 86400e3;

const dayKey = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const nextDay = (k) => { const d = new Date(k); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d.getTime(); };
const endOf = (s) => s.start + (s.duration || 0) * 1000;

/** Per local day: runs, tokens, providers, folders, and when each count/threshold was first crossed. */
function byDay(samples) {
  const days = new Map();
  for (const s of samples) {
    const k = dayKey(s.start);
    let d = days.get(k);
    if (!d) { d = { day: k, runs: 0, tokens: 0, providers: new Map(), folders: new Map(), at50: 0, atM: 0, at5f: 0 }; days.set(k, d); }
    d.runs++; d.tokens += s.headline || 0;
    const end = endOf(s);
    if (d.runs === 50) d.at50 = end;
    if (!d.atM && d.tokens >= 1e6) d.atM = end;
    const p = s.provider || 'claude'; if (!d.providers.has(p)) d.providers.set(p, end);
    if (s.cwd && !d.folders.has(s.cwd)) { d.folders.set(s.cwd, end); if (d.folders.size === 5) d.at5f = end; }
  }
  return [...days.values()].sort((a, b) => a.day - b.day);
}

/** Longest run of consecutive days with at least one run, the best one ever, and when each length was first reached. */
function streaks(days) {
  let cur = 0, best = 0, prev = null; const reached = {};
  for (const d of days) {
    cur = prev != null && nextDay(prev) === d.day ? cur + 1 : 1;
    prev = d.day;
    if (cur > best) best = cur;
    if (!reached[cur]) reached[cur] = d.day + DAY - 1;     // reached by the end of that day at the latest
  }
  return { best, reached, last: prev, cur };
}

/** The streak still going at `now` (today, or yesterday if you haven't started today yet). */
function currentStreak(days, now) {
  const set = new Set(days.map((d) => d.day));
  let k = dayKey(now); if (!set.has(k)) { const y = new Date(k); y.setDate(y.getDate() - 1); k = y.getTime(); }
  let n = 0;
  while (set.has(k)) { n++; const y = new Date(k); y.setDate(y.getDate() - 1); k = dayKey(y.getTime()); }
  return n;
}

const firstRun = (samples, f) => { for (const s of samples) if (f(s)) return endOf(s); return 0; };
const hourOf = (t) => new Date(t).getHours();

/**
 * Every badge: id, name, a one-word icon for the UI, how to earn it, and check(ctx) → {at} when earned (at = when) or
 * {progress:[have, goal]} when not yet. ctx = {samples, days, streak, stage, album, flags, now}.
 */
const BADGES = [
  { id: 'first', name: 'First run', icon: '🐣', how: 'Finish a run with Claude or Codex while Tokkie is watching.', check: (c) => (c.samples.length ? { at: endOf(c.samples[0]) } : { progress: [0, 1] }) },
  { id: 'streak3', name: 'On a roll', icon: '🔥', how: 'Use Claude or Codex 3 days in a row.', check: (c) => streakCheck(c, 3) },
  { id: 'streak7', name: 'Full week', icon: '📅', how: 'Use Claude or Codex 7 days in a row.', check: (c) => streakCheck(c, 7) },
  { id: 'streak30', name: 'Habit', icon: '🗓️', how: 'Use Claude or Codex 30 days in a row.', check: (c) => streakCheck(c, 30) },
  { id: 'marathon', name: 'Marathon', icon: '🏃', how: 'One run that works for 30 minutes or more.', check: (c) => longRun(c, 30 * 60) },
  { id: 'ultra', name: 'Ultramarathon', icon: '🏔️', how: 'One run that works for 2 hours or more.', check: (c) => longRun(c, 2 * 3600) },
  { id: 'owl', name: 'Night owl', icon: '🦉', how: 'Start a run between midnight and 4 am.', check: (c) => at(firstRun(c.samples, (s) => hourOf(s.start) < 4)) },
  { id: 'bird', name: 'Early bird', icon: '🐦', how: 'Start a run between 5 and 7 am.', check: (c) => at(firstRun(c.samples, (s) => { const h = hourOf(s.start); return h >= 5 && h < 7; })) },
  { id: 'weekend', name: 'Weekend warrior', icon: '🏖️', how: 'Run something on a Saturday and on the Sunday after it.', check: (c) => at(weekend(c.days)) },
  { id: 'busy', name: 'Busy bee', icon: '🐝', how: '50 runs in one day.', check: (c) => dayBest(c, (d) => d.at50, (d) => d.runs, 50) },
  { id: 'million', name: 'Millionaire', icon: '💎', how: 'A million tokens in one day.', check: (c) => dayBest(c, (d) => d.atM, (d) => d.tokens, 1e6) },
  { id: 'hopper', name: 'Folder hopper', icon: '📂', how: 'Work in 5 different project folders in one day.', check: (c) => dayBest(c, (d) => d.at5f, (d) => d.folders.size, 5) },
  { id: 'both', name: 'Two brains', icon: '🧠', how: 'Use Claude and Codex on the same day.', check: (c) => at(Math.min(...c.days.filter((d) => d.providers.size > 1).map((d) => Math.max(...d.providers.values())), Infinity)) },
  { id: 'juggler', name: 'Juggler', icon: '🤹', how: 'Have 3 runs going at once.', check: (c) => flag(c, 'juggler') },
  { id: 'closecall', name: 'Close call', icon: '😅', how: 'Use 95% or more of a limit and make it to the reset without running out.', check: (c) => flag(c, 'closecall') },
  { id: 'junior', name: 'Growing up', icon: '🌱', how: 'Your pet reaches its Junior form.', check: (c) => form(c, 2) },
  { id: 'champion', name: 'Champion', icon: '🏆', how: 'Your pet reaches its Champion form.', check: (c) => form(c, 3) },
  { id: 'mega', name: 'Mega', icon: '👑', how: 'Your pet reaches its Mega form.', check: (c) => form(c, 4) },
  { id: 'collector', name: 'Collector', icon: '📚', how: 'Discover 10 species in the album.', check: (c) => { const n = Object.keys(c.album).length; return n >= 10 ? { at: c.now } : { progress: [n, 10] }; } },
  { id: 'secret', name: 'Secret finder', icon: '✨', how: 'Find one of the secret pets.', check: (c) => (Object.keys(c.album).some((k) => k.startsWith('special:')) ? { at: c.now } : { progress: [0, 1] }) },
];

function at(t) { return Number.isFinite(t) && t > 0 ? { at: t } : { progress: [0, 1] }; }
function streakCheck(c, n) { return c.streak.reached[n] ? { at: c.streak.reached[n] } : { progress: [Math.min(n - 1, c.streakNow), n] }; }
function longRun(c, secs) {
  const t = firstRun(c.samples, (s) => s.duration >= secs);
  if (t) return { at: t };
  const best = c.samples.reduce((m, s) => Math.max(m, s.duration || 0), 0);
  return { progress: [Math.floor(best / 60), Math.round(secs / 60)], unit: 'min' };
}
function dayBest(c, when, size, goal) {
  const d = c.days.find((x) => when(x));
  if (d) return { at: when(d) };
  const today = c.days.find((x) => x.day === dayKey(c.now));
  return { progress: [today ? Math.min(goal - 1, size(today)) : 0, goal], today: true };
}
function flag(c, id, goal = 1) { return c.flags[id] ? { at: c.flags[id] } : { progress: [0, goal] }; }
function form(c, n) { return c.stage >= n ? { at: c.now } : { progress: [c.stage, n] }; }

function weekend(days) {
  const set = new Set(days.map((d) => d.day));
  for (const d of days) if (new Date(d.day).getDay() === 6 && set.has(nextDay(d.day))) return nextDay(d.day) + DAY - 1;
  return 0;
}

/**
 * Evaluate every badge. `earned` is what was already kept ({id: at}); it never shrinks.
 * @returns {{list: Array, newly: string[], earned: Object}}
 */
function evaluate({ samples = [], stage = 1, album = {}, flags = {}, earned = {}, now = Date.now() }) {
  const runs = samples.filter((s) => Number.isFinite(s.start)).sort((a, b) => a.start - b.start);
  const days = byDay(runs);
  const ctx = { samples: runs, days, streak: streaks(days), streakNow: currentStreak(days, now), stage, album: album || {}, flags: flags || {}, now };
  const out = { ...earned }, newly = [];
  const list = BADGES.map((b) => {
    let r; try { r = b.check(ctx); } catch { r = { progress: [0, 1] }; }
    if (!out[b.id] && r.at) { out[b.id] = Math.min(r.at, now); newly.push(b.id); }
    const got = out[b.id] || 0;
    return { id: b.id, name: b.name, icon: b.icon, how: b.how, at: got, progress: got ? null : r.progress || null, unit: r.unit || null, today: !!r.today };
  });
  return { list, newly, earned: out, streak: ctx.streakNow, bestStreak: ctx.streak.best };
}

module.exports = { BADGES, evaluate, byDay, streaks, currentStreak, dayKey };
