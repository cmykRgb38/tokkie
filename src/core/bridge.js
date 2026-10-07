'use strict';
/** Reads what the Tokkie bridge mod writes from inside Claude Code: ~/.tokkie/bridge/<session>.json */
const fs = require('fs');
const path = require('path');

const STALE_MS = 14 * 86400e3;

class BridgeReader {
  constructor(dir) { this.dir = dir; this.mtimes = new Map(); this.sessions = new Map(); }

  /** Returns the sessions whose file changed since the last poll. */
  poll(now = Date.now()) {
    const changed = [];
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')); } catch { return changed; }
    for (const n of names) {
      const f = path.join(this.dir, n);
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (now - st.mtimeMs > STALE_MS) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } continue; }
      if (this.mtimes.get(f) === st.mtimeMs) continue;
      this.mtimes.set(f, st.mtimeMs);
      let rec; try { rec = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      if (!rec || typeof rec.sessionId !== 'string') continue;
      const clean = {
        sessionId: rec.sessionId, updatedAt: Number(rec.updatedAt) || st.mtimeMs, reason: rec.reason,
        costUsd: Number.isFinite(rec.costUsd) ? rec.costUsd : null,
        turns: Array.isArray(rec.turns) ? rec.turns.filter((t) => t && Number.isFinite(t.at) && Number.isFinite(t.usd) && t.usd > 0) : [],   // a $0 turn is a failed request, not a prompt
        context: rec.context && typeof rec.context === 'object' ? rec.context : {},
        agentsRunning: Number(rec.agentsRunning) || 0,
        rateLimits: Array.isArray(rec.rateLimits) ? rec.rateLimits : [],
      };
      this.sessions.set(clean.sessionId, clean);
      changed.push(clean);
    }
    return changed;
  }

  /** The most recently active session the bridge reported. */
  latest() { let best = null; for (const s of this.sessions.values()) if (!best || s.updatedAt > best.updatedAt) best = s; return best; }
  /** All prompt costs across sessions, newest last. */
  allTurns() { const all = []; for (const s of this.sessions.values()) for (const t of s.turns) all.push({ ...t, sessionId: s.sessionId }); return all.sort((a, b) => a.at - b.at); }
}

module.exports = { BridgeReader };
