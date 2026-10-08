'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  finishBy: '18:30',
  bufferMin: 10,
  hotkey: 'CommandOrControl+Alt+Shift+L',
  clipboardWatch: false,
  launchAtLogin: false,
  alwaysOnTop: true,
  scale: 6,
  fallbackBudget5h: 0,       // tokens; 0 = unknown until the statusline reports a real %
  monsters: { active: '', saved: [], hideOwn: false },
  album: {},                 // species you've met: { 'blob:horns': seed, 'special:rainbow': seed, … }
  seed: null,                // first monster seed (derived from user on first run)
  window: { x: null, y: null, expanded: false, tab: 'usage', panelW: 336, panelH: 504 },
  calib: { five: {}, seven: {} },
  samples: [],               // persisted finished turns (survive log rotation)
  theme: 'auto',            // auto | light | dark
  notifyDone: true,
  alertBubble: true,         // pet reacts (hop + blinking !/?) when Claude finishes / may need you
  speechBubble: true,        // ...and also show the "Done — awaiting your response" speech bubble
  manualReadings: [],        // percentages you typed in from Claude's Usage page: [{id, t, pct}] — exact anchors + calibration points
  spendLimitUsd: 0,          // your plan's dollar limit (Enterprise / usage-based), typed once in Settings
  resetDay: 1,               // the day of the month that limit resets (UTC)
  spend: {},                 // exact Claude Code dollars from the bridge (ledger)
  layout: 'dock',            // dock | pills | pet
  dock: { usage: true, pace: true, status: true, tokens: true, context: true, cache: true, lastPrompt: true, agents: true },
  dockPlace: 'below',        // below | above the pet, or 'claude' = a bar above Claude Code's prompt (drawn by the bridge)
  pills: { usage: true, pace: false, status: false, tokens: true, context: false, cache: false, lastPrompt: false, agents: false },
  optimizerModel: 'haiku',   // haiku | sonnet | opus — what the prompt optimizer asks
  optimizerMode: 'clearer',  // clearer (adds what Claude would guess) | shorter (same meaning, fewest tokens)
  optimizeButton: true,      // ✨ Optimize on the Claude bar (rewrites what you typed, in place)
  personality: 'cheerful',   // cheerful | playful | sleepy | grumpy | shy
  evolution: { start: 0, archived: 0, stageSeen: 1, display: 0 },   // growth bookkeeping: when feeding began, tokens already pruned, last form celebrated, form shown (0 = newest)
  onboarded: false,
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Copy persisted values over defaults. Unknown keys are kept only where the default is an open-ended map ({}). */
function merge(base, extra) {
  if (!isObj(extra)) return base;
  for (const k of Object.keys(base)) {
    if (!(k in extra)) continue;
    const b = base[k], e = extra[k];
    if (isObj(b) && Object.keys(b).length === 0) { if (isObj(e)) base[k] = clone(e); }          // open map (calib, calib.five…)
    else if (isObj(b)) base[k] = merge(b, e);
    else if (Array.isArray(b)) { if (Array.isArray(e)) base[k] = e; }
    else if (b === null || e === null || typeof e === typeof b) base[k] = e;
  }
  return base;
}

class Settings {
  constructor(file) { this.file = file; this.data = clone(DEFAULTS); this.load(); this._t = null; }
  load() {
    try { merge(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run or corrupt: defaults */ }
    const d = this.data;
    d.samples = (Array.isArray(d.samples) ? d.samples : []).filter((x) => x && Number.isFinite(x.start) && Number.isFinite(x.duration) && Number.isFinite(x.chars));
    d.monsters = { active: String(d.monsters.active || ''), saved: (Array.isArray(d.monsters.saved) ? d.monsters.saved : []).map(String).slice(0, 12), hideOwn: !!d.monsters.hideOwn };
    for (const k of ['five', 'seven']) if (!isObj(d.calib[k]) || !(d.calib[k].k > 0)) d.calib[k] = {};
  }
  get(k) { return this.data[k]; }
  set(patch) { Object.assign(this.data, patch); this.saveSoon(); }
  saveSoon() { clearTimeout(this._t); this._t = setTimeout(() => this.save(), 400); }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('settings save failed', e.message); }
  }
}

module.exports = { Settings, DEFAULTS, merge };
