'use strict';
const fs = require('fs');
const fsp = fs.promises;
const { listTranscripts } = require('./paths');
const { parseLine } = require('./parser');

const LINE_HINT = /"type"\s*:\s*"(?:assistant|user)"/;
const CHUNK = 1024 * 1024;

/**
 * Incrementally follows every transcript file. Cheap by design: one stat() per file per poll,
 * reads only appended bytes, never re-parses old data, tolerates truncation/rotation and partial lines.
 */
class Tailer {
  /**
   * @param {object} o
   * @param {() => Array<{dir:string,source:string}>} o.roots
   * @param {(events:object[]) => void} o.onEvents
   * @param {number} [o.lookbackMs] files older than this are skipped on the initial scan
   */
  constructor({ roots, onEvents, lookbackMs = 8 * 86400e3, pollMs = 1500, discoverMs = 5000, now = Date.now }) {
    Object.assign(this, { roots, onEvents, lookbackMs, pollMs, discoverMs, now });
    this.files = new Map(); // path -> {offset, rest:Buffer, source}
    this.timer = null;
    this.lastDiscover = 0;
    this.busy = false;
    this.stopped = false;
  }

  _discover() {
    this.lastDiscover = this.now();
    const fresh = [];
    for (const { dir, source } of this.roots()) {
      for (const p of listTranscripts(dir)) if (!this.files.has(p)) fresh.push({ p, source });
    }
    return fresh;
  }

  async _read(p, state, fromStart) {
    let fh;
    const events = [];
    try {
      fh = await fsp.open(p, 'r');
      const st = await fh.stat(); const size = st.size;
      if (size < state.offset || (state.ino && st.ino && state.ino !== st.ino)) { state.offset = 0; state.rest = Buffer.alloc(0); } // truncated / replaced
      state.ino = st.ino;
      while (state.offset < size) {
        const len = Math.min(CHUNK, size - state.offset);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        let data = state.rest.length ? Buffer.concat([state.rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const cut = data.lastIndexOf(10);
        if (cut === -1) { state.rest = Buffer.from(data); continue; }
        state.rest = Buffer.from(data.subarray(cut + 1));
        for (const line of data.subarray(0, cut).toString('utf8').split('\n')) {
          if (!line || !LINE_HINT.test(line)) continue;
          const ev = parseLine(line);
          if (ev) { ev.source = state.source; events.push(ev); }
        }
      }
      return events;
    } catch { return events; /* keep what was parsed before the error; the offset already reflects it */ } finally { if (fh) await fh.close().catch(() => {}); }
  }

  /** Read every recent file once; events are returned time-sorted so sub-agent logs land after their parent prompt. */
  async initialScan() {
    const cutoff = this.now() - this.lookbackMs;
    const all = [];
    for (const { p, source } of this._discover()) {
      let st;
      try { st = await fsp.stat(p); } catch { continue; }
      const state = { offset: 0, rest: Buffer.alloc(0), source };
      this.files.set(p, state);
      if (st.mtimeMs < cutoff) { state.offset = st.size; continue; } // too old: follow from EOF only
      const evs = await this._read(p, state, true);
      for (const e of evs) all.push(e);
      await new Promise((r) => setImmediate(r)); // keep the UI responsive
    }
    all.sort((a, b) => a.ts - b.ts);
    return all;
  }

  async poll() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const out = [];
      if (this.now() - this.lastDiscover >= this.discoverMs) {
        for (const { p, source } of this._discover()) this.files.set(p, { offset: 0, rest: Buffer.alloc(0), source });
      }
      for (const [p, state] of this.files) {
        let st;
        try { st = await fsp.stat(p); } catch (e) { if (e.code === 'ENOENT') this.files.delete(p); continue; }
        if (state.ino && st.ino && state.ino !== st.ino) { state.offset = 0; state.rest = Buffer.alloc(0); }
        if (st.size === state.offset && !state.rest.length) continue;
        out.push(...(await this._read(p, state, false)));
      }
      if (out.length) { out.sort((a, b) => a.ts - b.ts); this.onEvents(out); }
    } finally { this.busy = false; }
  }

  start() {
    this.stopped = false;
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }
  stop() { this.stopped = true; clearInterval(this.timer); }
}

module.exports = { Tailer };
