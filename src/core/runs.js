'use strict';
/**
 * Run history on disk (runs.json next to settings.json): every finished prompt for the last 90 days, so the History
 * tab can go back further than the logs Tokkie scans at start-up. Kept apart from settings so that file stays small.
 */
const fs = require('fs');
const path = require('path');

const KEEP_MS = 90 * 86400e3;
const MAX_RUNS = 5000;

class RunLog {
  constructor(file, now = Date.now) { this.file = file; this.now = now; this._t = null; }

  load() {
    try { const v = JSON.parse(fs.readFileSync(this.file, 'utf8')); return Array.isArray(v) ? v.filter(ok) : []; } catch { return []; }
  }

  /** The runs worth keeping: recent enough, newest MAX_RUNS. */
  trim(runs) { const cut = this.now() - KEEP_MS; return runs.filter((r) => r.start >= cut).slice(-MAX_RUNS); }

  saveSoon(runs) { clearTimeout(this._t); this._t = setTimeout(() => this.save(runs), 1500); this._t.unref?.(); }
  save(runs) {
    clearTimeout(this._t);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.trim(runs)));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('run history save failed', e.message); }
  }
}

const ok = (x) => x && Number.isFinite(x.start) && Number.isFinite(x.duration) && Number.isFinite(x.chars);

module.exports = { RunLog, KEEP_MS };
