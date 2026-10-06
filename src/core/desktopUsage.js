'use strict';
/**
 * Reads the usage readings the Claude desktop app already saves for its own Settings → Usage screen
 * (<app data>/plan-usage-history.json). These are server-reported percentages, so — unlike transcripts — they include
 * regular Chat, other devices and everything else that counts against the plan.
 *
 * Keys (from the app): fh = 5-hour window, sd = 7-day window, xu = extra usage. Samples arrive every ~15 min while the app runs.
 */
const fs = require('fs');
const path = require('path');
const { desktopAppDirs } = require('./paths');

const FILE = 'plan-usage-history.json';
const FRESH_WINDOW_MS = 12 * 3600e3;   // a window counts as "current" if its latest value is within 12 h of the newest sample

function readDesktopUsage(dirs = desktopAppDirs()) {
  let best = null;
  for (const dir of dirs) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')); } catch { continue; }
    const samples = Array.isArray(j && j.samples) ? j.samples.filter((s) => s && Number.isFinite(s.t) && s.u && typeof s.u === 'object') : [];
    if (!samples.length) continue;
    const newest = samples.reduce((a, b) => (b.t > a.t ? b : a));
    const mine = samples.filter((s) => s.org === newest.org);        // the account the app is currently using
    const latest = (key) => {
      let found = null;
      for (const s of mine) if (Number.isFinite(s.u[key]) && (!found || s.t > found.t)) found = { pct: s.u[key], t: s.t };
      return found && newest.t - found.t <= FRESH_WINDOW_MS ? found : null;
    };
    const seriesOf = (key) => mine.filter((s) => Number.isFinite(s.u[key])).map((s) => ({ t: s.t, pct: s.u[key] })).sort((a, b) => a.t - b.t);
    const res = { t: newest.t, five: latest('fh'), seven: latest('sd'), extra: latest('xu'), series: { five: seriesOf('fh'), seven: seriesOf('sd'), extra: seriesOf('xu') } };
    if ((res.five || res.seven || res.extra) && (!best || res.t > best.t)) best = res;
  }
  return best;
}

function statMtime(dirs = desktopAppDirs()) {
  let m = 0;
  for (const dir of dirs) { try { m = Math.max(m, fs.statSync(path.join(dir, FILE)).mtimeMs); } catch { /* none */ } }
  return m;
}

module.exports = { readDesktopUsage, statMtime, FILE };
