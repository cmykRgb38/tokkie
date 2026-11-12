'use strict';
/**
 * Codex (OpenAI). Its desktop app keeps conversations in SQLite under ~/.codex (read here, read-only, with Node's
 * built-in sqlite), and exact plan limits come from Codex's own app-server (`account/rateLimits/read`), which signs in
 * with Codex's own login: Tokkie never reads `auth.json` or any token.
 *
 *  · runs:   thread_turns (start, end, duration, status) in thread_history_1.sqlite, and the thread's running token
 *            total (threads.tokens_used in state_5.sqlite). A new turn's tokens are the total's increase since we last
 *            looked; on the first look a thread's total is shared between its turns by how long each ran (an estimate).
 *  · limits: one long-lived `codex app-server` child speaking JSON-RPC, asked about once a minute.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const H = 3600e3;
const DONE = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'canceled', 'aborted']);

function codexHome(env = process.env, home = require('os').homedir()) { return env.CODEX_HOME || path.join(home, '.codex'); }

/** The native `codex` program: ChatGPT.app's bundled copy first (no Node needed), then the usual install places. */
function findCodexBin({ env = process.env, platform = process.platform, home = require('os').homedir() } = {}) {
  const c = [];
  if (env.TOKKIE_CODEX_BIN) c.push(env.TOKKIE_CODEX_BIN);
  if (platform === 'darwin') {
    c.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', path.join(home, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
      '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(home, '.local/bin/codex'));
  } else if (platform === 'win32') {
    const la = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), ap = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    c.push(path.join(la, 'Programs', 'ChatGPT', 'resources', 'codex-cli', 'bin', 'codex.exe'), path.join(la, 'Programs', 'codex', 'codex.exe'), path.join(ap, 'npm', 'codex.cmd'));
  } else c.push('/usr/local/bin/codex', '/usr/bin/codex', path.join(home, '.local/bin/codex'));
  return c.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/** Name a limit window by its length (Codex decides which windows a plan has: Plus may only have a weekly one). */
function windowLabel(mins) {
  if (!mins) return 'Limit';
  if (mins <= 330 && mins >= 270) return '5-hour';
  if (mins === 10080) return 'Weekly';
  if (mins % 1440 === 0) return `${mins / 1440}-day`;
  if (mins % 60 === 0) return `${mins / 60}-hour`;
  return `${mins}-min`;
}

/** Shape `account/rateLimits/read` into Tokkie's meters (percent used, when it resets). */
function parseRateLimits(result, now = Date.now()) {
  const rl = result && result.rateLimits;
  if (!rl) return null;
  const windows = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || !Number.isFinite(w.usedPercent)) continue;
    windows.push({ label: windowLabel(w.windowDurationMins), mins: w.windowDurationMins || null, pct: Math.max(0, Math.min(100, w.usedPercent)), resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null });
  }
  windows.sort((a, b) => (a.mins || 1e9) - (b.mins || 1e9));                  // shortest window first
  return { at: now, plan: rl.planType || null, windows, reached: rl.rateLimitReachedType || null,
    credits: rl.credits ? { has: !!rl.credits.hasCredits, unlimited: !!rl.credits.unlimited, balance: rl.credits.balance ?? null } : null };
}

/** What the person typed: with attachments, Codex puts a "# Files mentioned by the user:" list first and the words after "## My request:". */
function requestOf(text) {
  const i = text.indexOf('## My request:');
  return i >= 0 ? text.slice(i + '## My request:'.length).trim() : text;
}

class CodexReader {
  /** @param {{env?:object, home?:string, now?:()=>number, open?:(file:string)=>any}} o  open: a read-only DatabaseSync factory (tests inject one) */
  constructor({ env = process.env, home = require('os').homedir(), now = Date.now, open } = {}) {
    this.dir = codexHome(env, home); this.now = now;
    this.open = open || ((f) => { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(f, { readOnly: true }); });
    this.tokens = new Map();      // threadId -> tokens_used when we last looked
    this.seen = new Set();        // threadId:turnId already turned into a run
    this.active = null;           // a turn still running: { sessionId, start, provider }
    this.lastTurnEnd = 0; this.since = 0;
  }
  available() { return fs.existsSync(path.join(this.dir, 'state_5.sqlite')) && fs.existsSync(path.join(this.dir, 'thread_history_1.sqlite')); }

  /**
   * New finished turns since the last call, as run samples (same shape as Claude's), plus whether one is running.
   * @param {number} lookbackMs  on the first call, how far back to turn turns into runs
   */
  poll(lookbackMs = 8 * 86400e3) {
    if (!this.available()) return [];
    const now = this.now(), first = !this.since;
    let st, th;
    try { st = this.open(path.join(this.dir, 'state_5.sqlite')); th = this.open(path.join(this.dir, 'thread_history_1.sqlite')); } catch { try { st && st.close(); } catch { /* */ } return []; }
    const out = [];
    try {
      const from = first ? now - lookbackMs : this.since - 5 * 60e3;
      const threads = st.prepare('SELECT id, tokens_used, model, cwd, updated_at_ms FROM threads WHERE updated_at_ms >= ? ORDER BY updated_at_ms').all(from);
      const turnsQ = th.prepare('SELECT turn_id, status, started_at, completed_at, duration_ms, first_user_item_id FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal');
      const textQ = th.prepare('SELECT item_json FROM thread_items WHERE thread_id = ? AND item_id = ?');
      let active = null;
      for (const t of threads) {
        const turns = turnsQ.all(t.id);
        const done = turns.filter((u) => DONE.has(u.status) && u.started_at);
        const running = turns.find((u) => !DONE.has(u.status) && u.started_at && now - u.started_at * 1000 < 6 * H);
        if (running) active = { sessionId: t.id, start: running.started_at * 1000, provider: 'codex' };
        const fresh = done.filter((u) => !this.seen.has(`${t.id}:${u.turn_id}`));
        const prev = this.tokens.get(t.id);
        // tokens for the fresh turns: the total's growth since we last looked, or (first sight) the whole total shared by run time
        const pool = prev == null ? (t.tokens_used || 0) : Math.max(0, (t.tokens_used || 0) - prev);
        const share = prev == null ? done : fresh;
        const totalMs = share.reduce((a, u) => a + Math.max(1, u.duration_ms || 0), 0) || 1;
        this.tokens.set(t.id, t.tokens_used || 0);
        for (const u of fresh) {
          this.seen.add(`${t.id}:${u.turn_id}`);
          const start = u.started_at * 1000, dur = (u.duration_ms || Math.max(0, (u.completed_at - u.started_at) * 1000)) / 1000;
          const end = u.completed_at ? u.completed_at * 1000 : start + dur * 1000;
          if (end > this.lastTurnEnd) this.lastTurnEnd = end;
          if (end < now - lookbackMs) continue;
          const tk = Math.round(pool * Math.max(1, u.duration_ms || 0) / totalMs);
          let text = '';
          try { const r = u.first_user_item_id && textQ.get(t.id, u.first_user_item_id); const j = r && JSON.parse(r.item_json); text = j && Array.isArray(j.content) ? j.content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n') : ''; } catch { /* no prompt text */ }
          text = requestOf(text);
          out.push({ sessionId: t.id, provider: 'codex', source: 'codex', start, duration: dur, chars: text.length, hint: 1, prev: 0,
            tokens: tk, headline: tk, output: 0, estimatedTokens: prev == null, model: t.model || '', failed: u.status !== 'completed',
            preview: text.replace(/\s+/g, ' ').trim().slice(0, 140), find: (text.split('\n').find((l) => l.trim()) || '').trim().slice(0, 60), cwd: t.cwd || '', file: '', uuid: '' });
        }
      }
      this.active = active;
    } catch { /* a schema we don't know (Codex updated): keep what we have */ } finally { try { st.close(); } catch { /* */ } try { th.close(); } catch { /* */ } }
    this.since = now;
    return out.sort((a, b) => a.start - b.start);
  }
}

/** Exact Codex limits from Codex's own app-server (it uses its own login). One child process, asked once a minute. */
class CodexLimits {
  constructor({ bin, everyMs = 60e3, now = Date.now, onChange = () => {} } = {}) {
    Object.assign(this, { bin, everyMs, now, onChange });
    this.latest = null; this.error = null; this.child = null; this.buf = ''; this.nextId = 1; this.pending = new Map(); this.timer = null; this.ready = null; this.failures = 0;
  }
  start() { if (!this.bin || this.timer) return; this.refresh(); this.timer = setInterval(() => this.refresh(), this.everyMs); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); this.timer = null; this._kill(); }
  _kill() { if (this.child) { try { this.child.kill(); } catch { /* */ } } this.child = null; this.ready = null; for (const [, p] of this.pending) p.reject(new Error('stopped')); this.pending.clear(); }
  _spawn() {
    const env = { ...process.env, PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter) };
    const child = spawn(this.bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env, windowsHide: true });
    this.child = child; this.buf = '';
    child.stdout.on('data', (d) => {
      this.buf += d; let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        const p = m && m.id != null && this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message || 'error')); else p.resolve(m.result); }
      }
    });
    child.on('exit', () => { if (this.child === child) this._kill(); });
    child.on('error', () => { if (this.child === child) this._kill(); });
    this.ready = this._call('initialize', { clientInfo: { name: 'tokkie', title: 'Tokkie', version: '1' }, capabilities: null }).then(() => this._send({ method: 'initialized' }));
    return this.ready;
  }
  _send(o) { if (this.child) this.child.stdin.write(JSON.stringify(o) + '\n'); }
  _call(method, params, ms = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, ms);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this._send({ id, method, params });
    });
  }
  async refresh() {
    try {
      if (!this.child) await this._spawn(); else await this.ready;
      const r = await this._call('account/rateLimits/read', { excludeResetCreditDetails: true });
      const parsed = parseRateLimits(r, this.now());
      if (parsed) { this.latest = parsed; this.error = null; this.failures = 0; this.onChange(parsed); }
    } catch (e) {
      this.error = e.message; this.failures++; this._kill();
      if (this.failures >= 5) { clearInterval(this.timer); this.timer = setInterval(() => this.refresh(), 10 * this.everyMs); this.timer.unref?.(); }   // back off when Codex isn't signed in / broken
    }
  }
}

module.exports = { CodexReader, CodexLimits, codexHome, findCodexBin, parseRateLimits, windowLabel, requestOf };
