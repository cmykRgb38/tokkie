'use strict';
/**
 * One-time migration from the app's former names ("Larrie", then "Munch") so existing installs keep their pet, learned history,
 * calibration and — importantly — the Claude Code status-line hook that was already connected.
 * Idempotent, best-effort, never throws.
 */
const fs = require('fs');
const path = require('path');
const { claudeConfigDirs } = require('./paths');

const OLD_NAMES = ['munch', 'larrie'];          // newest first
const NEW = 'tokkie';
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function migrate({ appData, userData, home, env = process.env, hookSource, skipUserData = false }) {
  const done = [];
  const attempt = (name, fn) => { try { if (fn()) done.push(name); } catch { /* best effort */ } };
  const newHome = env.TOKKIE_HOME || path.join(home, `.${NEW}`);

  attempt('userData', () => {
    if (skipUserData || !appData || !userData) return false;
    const to = path.join(userData, 'settings.json');
    if (fs.existsSync(to)) return false;
    for (const old of OLD_NAMES) {
      const from = path.join(appData, cap(old), 'settings.json');
      if (fs.existsSync(from)) { fs.mkdirSync(userData, { recursive: true }); fs.copyFileSync(from, to); return true; }
    }
    return false;
  });

  attempt('home', () => {
    if (fs.existsSync(newHome)) return false;
    for (const old of OLD_NAMES) {
      const oldHome = path.join(home, `.${old}`);
      if (fs.existsSync(oldHome)) { fs.renameSync(oldHome, newHome); return true; }
    }
    return false;
  });

  attempt('statusline', () => {
    let changed = false;
    for (const dir of claudeConfigDirs(env, home)) {
      const file = path.join(dir, 'settings.json');
      if (!fs.existsSync(file)) continue;
      const real = fs.realpathSync(file);
      const s = JSON.parse(fs.readFileSync(real, 'utf8'));
      const cmd = s && s.statusLine && s.statusLine.command;
      if (typeof cmd !== 'string') continue;
      const old = OLD_NAMES.find((o) => cmd.includes(`${o}-statusline`));
      if (!old) continue;
      s.statusLine.command = cmd.split(`.${old}`).join(`.${NEW}`).split(`${old}-statusline`).join(`${NEW}-statusline`);
      fs.writeFileSync(real, JSON.stringify(s, null, 2) + '\n'); changed = true;
      for (const o of OLD_NAMES) {
        const oldBak = `${real}.${o}-backup`;
        if (fs.existsSync(oldBak) && !fs.existsSync(`${real}.${NEW}-backup`)) fs.renameSync(oldBak, `${real}.${NEW}-backup`);
      }
    }
    // put the current hook script where the rewritten command expects it, and drop stale copies
    if (changed && hookSource) { fs.mkdirSync(newHome, { recursive: true }); fs.copyFileSync(hookSource, path.join(newHome, `${NEW}-statusline-hook.js`)); }
    for (const o of OLD_NAMES) { try { fs.rmSync(path.join(newHome, `${o}-statusline-hook.js`), { force: true }); } catch { /* ignore */ } }
    return changed;
  });
  return done;
}

module.exports = { migrate };
