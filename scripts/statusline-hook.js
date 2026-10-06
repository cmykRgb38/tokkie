#!/usr/bin/env node
// tokkie-statusline-hook — receives Claude Code's statusline JSON on stdin and records the plan-limit
// readings for the Tokkie desktop pet. Chains to your previous status line, so nothing is lost.
// Must be fast, dependency-free and must never throw: a broken status line is a bad experience.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const home = process.env.TOKKIE_HOME || path.join(os.homedir(), '.tokkie');

function run(raw) {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { /* not JSON: still chain */ }
  const rl = input.rate_limits;
  let line = '';
  if (rl && typeof rl === 'object') {
    const f = rl.five_hour, w = rl.seven_day;
    const parts = [];
    if (f && Number.isFinite(f.used_percentage)) parts.push(`5h ${Math.round(f.used_percentage)}%`);
    if (w && Number.isFinite(w.used_percentage)) parts.push(`7d ${Math.round(w.used_percentage)}%`);
    line = parts.join(' · ');                                    // computed first: a failed write must not blank the status line
    try {
      fs.mkdirSync(home, { recursive: true });
      const file = path.join(home, 'rate_limits.json');
      let cur = {};
      try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object') cur = j; } catch { /* new or unreadable file */ }
      const nowSec = Math.floor(Date.now() / 1000);
      const next = { ...cur, updated_at: nowSec };
      for (const k of ['five_hour', 'seven_day']) {
        const x = rl[k];
        if (x && Number.isFinite(x.used_percentage) && Number.isFinite(x.resets_at)) next[k] = { used_percentage: x.used_percentage, resets_at: x.resets_at, updated_at: nowSec };   // each window keeps its own timestamp
      }
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;     // unique: several Claude sessions run this hook at once
      fs.writeFileSync(tmp, JSON.stringify(next));
      try { fs.renameSync(tmp, file); } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
    } catch { /* ignore */ }
  }
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(path.join(home, 'statusline.json'), 'utf8')).previous; } catch { /* none */ }
  if (prev && prev.command) {
    const r = spawnSync(prev.command, { input: raw, shell: true, encoding: 'utf8', timeout: 4000 });
    if (r.stdout) { process.stdout.write(r.stdout); return; }
  }
  process.stdout.write(line);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => { try { run(buf); } catch { /* never fail */ } });
process.stdin.on('error', () => {});
setTimeout(() => process.exit(0), 6000).unref();
