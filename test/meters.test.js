'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readDesktopUsage } = require('../src/core/desktopUsage');
const { buildMeters } = require('../src/core/meters');
const { Engine } = require('../src/core/engine');
const { Settings } = require('../src/core/settings');
const { A, U } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-m-'));
const writeHist = (dir, samples) => fs.writeFileSync(path.join(dir, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples }));
const NOW = Date.now();

test('reads the Claude app\'s own usage history: current org only, stale windows dropped', () => {
  const d = tmp();
  writeHist(d, [
    { t: NOW - 5 * 86400e3, org: 'A', u: { fh: 35, sd: 37 } },          // old reading from days ago
    { t: NOW - 3 * 3600e3, org: 'B', u: { fh: 99, sd: 99 } },          // someone else's org
    { t: NOW - 2 * 3600e3, org: 'A', u: { xu: 21.4 } },
    { t: NOW - 3600e3, org: 'A', u: { xu: 23 } },
    { t: NOW - 1800e3, org: 'A', u: {} },
  ]);
  const r = readDesktopUsage([d]);
  assert.equal(r.extra.pct, 23); assert.equal(r.five, null, 'a 5-day-old fh must not be shown as current'); assert.equal(r.seven, null);
});
test('handles missing / corrupt / empty files', () => {
  const d = tmp();
  assert.equal(readDesktopUsage([d]), null);
  fs.writeFileSync(path.join(d, 'plan-usage-history.json'), '{oops'); assert.equal(readDesktopUsage([d]), null);
  writeHist(d, []); assert.equal(readDesktopUsage([d]), null);
  writeHist(d, [{ t: 'x', u: {} }, null, { t: NOW, u: { fh: 'a' } }]); assert.equal(readDesktopUsage([d]), null);
});
test('meters: the newest source wins per window; chat-inclusive app reading beats an older status-line reading', () => {
  const sl = { updatedAt: NOW - 3600e3, five: { pct: 30, approx: true, resetsAt: NOW + 7200e3, expired: false }, seven: { pct: 40, expired: false } };
  const dk = { five: { pct: 44, t: NOW - 600e3 }, seven: null, extra: null };
  const m = buildMeters({ statusline: sl, desktop: dk, fallback: null, now: NOW });
  assert.deepEqual(m.map((x) => x.id), ['five', 'seven']);
  assert.equal(m[0].pct, 44); assert.equal(m[0].source, 'claude-app'); assert.equal(m[0].resetsAt, NOW + 7200e3, 'keeps reset time from the status line');
  assert.equal(m[1].pct, 40);
});
test('meters: the usage-bar-only account (xu) shows one meter; budget is only a last resort', () => {
  const m = buildMeters({ statusline: { connected: false }, desktop: { five: null, seven: null, extra: { pct: 23, t: NOW } }, fallback: { usedPct: 80 }, now: NOW });
  assert.equal(m.length, 1); assert.equal(m[0].id, 'extra'); assert.equal(m[0].pct, 23);
  assert.equal(buildMeters({ statusline: { connected: false }, desktop: null, fallback: { usedPct: 80 }, now: NOW })[0].id, 'budget');
  assert.deepEqual(buildMeters({ statusline: { connected: false }, desktop: null, fallback: null, now: NOW }), []);
  assert.equal(buildMeters({ statusline: {}, desktop: { extra: { pct: 140, t: NOW } }, now: NOW })[0].pct, 100, 'clamped');
});

test('estimate is paired with the run it predicted, and the run log reports both', async () => {
  const dir = tmp(); const proj = path.join(dir, 'projects', 'p'); fs.mkdirSync(proj, { recursive: true });
  const settings = new Settings(path.join(dir, 's.json'));
  const eng = new Engine({ settings, env: { TOKKIE_HOME: path.join(dir, 'h') }, home: dir, roots: () => [{ dir: path.join(dir, 'projects'), source: 'code' }] });
  fs.writeFileSync(path.join(proj, 's.jsonl'), '');       // the session file exists before Tokkie starts watching
  await eng.start();
  const prompt = 'Refactor the billing module and add tests for every endpoint please';
  const est = eng.estimate(prompt);
  const t0 = Date.now();
  fs.appendFileSync(path.join(proj, 's.jsonl'), [U(t0 + 500, prompt), A(t0 + 4000, 'a', { o: 400 }), A(t0 + 9000, 'b', { o: 600, stop: 'end_turn' })].join('\n') + '\n');
  const done = new Promise((r) => eng.once('turn-end', r));
  await eng.tailer.poll(); await done;
  const run = eng.recentRuns(1)[0];
  assert.equal(run.chars, prompt.length); assert.ok(run.est, 'estimate attached');
  assert.equal(run.est.dur.p50, est.duration.p50); assert.ok(run.headline > 0);
  assert.equal(settings.get('samples').at(-1).est.dur.p50, est.duration.p50, 'persisted with the run');
  // a run nobody estimated has no est
  fs.appendFileSync(path.join(proj, 's.jsonl'), [U(t0 + 20000, 'something totally different and much longer than before, never estimated'), A(t0 + 26000, 'c', { o: 10, stop: 'end_turn' })].join('\n') + '\n');
  const done2 = new Promise((r) => eng.once('turn-end', r)); await eng.tailer.poll(); await done2;
  assert.equal(eng.recentRuns(1)[0].est, null);
  eng.stop(); fs.rmSync(dir, { recursive: true });
});

const { tokensPer100, liveEstimate } = require('../src/core/calibrate');
const { Store } = require('../src/core/store');
const { parseLine } = require('../src/core/parser');

function ledger(entries) { // [{t, tokens}] → Store with output-token messages
  const s = new Store({ now: () => NOW });
  entries.forEach((e, i) => s.ingest(parseLine(A(e.t, 'c' + i, { i: 0, o: e.tokens, cw: 0, cr: 0 }))));
  return s;
}
test('calibration: tokens-per-1% comes from Claude\'s consecutive readings, ignores resets and idle gaps', () => {
  const H = 3600e3, t0 = NOW - 6 * H;
  const store = ledger([{ t: t0 + 0.5 * H, tokens: 1000 }, { t: t0 + 1.5 * H, tokens: 2000 }, { t: t0 + 3.5 * H, tokens: 99999 }]);
  const series = [{ t: t0, pct: 10 }, { t: t0 + H, pct: 11 }, { t: t0 + 2 * H, pct: 13 }, { t: t0 + 3 * H, pct: 2 } /* reset */, { t: t0 + 20 * H, pct: 50 } /* huge gap */];
  const k = tokensPer100(series, store, NOW);
  assert.ok(Math.abs(k - 100000) < 1, `k=${k}`);                                   // (1000+2000 tokens) / (1%+2%) = 1000 per 1%
  assert.equal(tokensPer100([{ t: t0, pct: 10 }], store, NOW), null, 'one reading is not enough');
  assert.equal(tokensPer100([{ t: t0, pct: 10 }, { t: t0 + H, pct: 10.1 }], store, NOW), null, 'tiny change is noise');
});
test('live estimate adds what was used since the reading, capped at 100', () => {
  const store = ledger([{ t: NOW - 1000, tokens: 5000 }, { t: NOW - 9 * 3600e3, tokens: 777777 }]);
  const est = liveEstimate({ pct: 20, t: NOW - 3600e3 }, 100000, store, NOW);          // 5000 tokens at 1000/1% → +5%
  assert.ok(Math.abs(est.pct - 25) < 1e-6 && est.baseline === 20 && Math.abs(est.added - 5) < 1e-6);
  assert.equal(liveEstimate({ pct: 99, t: NOW - 3600e3 }, 1000, store, NOW).pct, 100);
  assert.equal(liveEstimate({ pct: 20, t: NOW }, null, store, NOW), null);
});
test('end to end: a stale Claude reading is bridged into a live, labelled estimate', async () => {
  const dir = tmp(); const app = path.join(dir, 'ClaudeApp'); fs.mkdirSync(app); const proj = path.join(dir, 'projects', 'p'); fs.mkdirSync(proj, { recursive: true });
  const H = 3600e3, t0 = NOW - 6 * H;
  writeHist(app, [{ t: t0, org: 'A', u: { xu: 10 } }, { t: t0 + H, org: 'A', u: { xu: 12 } }, { t: t0 + 2 * H, org: 'A', u: { xu: 14 } }]);   // last reading 4 h ago
  const mk = (t, id, o) => A(t, id, { i: 0, o, cw: 0, cr: 0 });
  fs.writeFileSync(path.join(proj, 's.jsonl'), [mk(t0 + 0.5 * H, 'a', 20000), mk(t0 + 1.5 * H, 'b', 20000), mk(NOW - 3 * H, 'c', 20000), mk(NOW - 2 * H, 'd', 20000)].join('\n') + '\n');
  const settings = new Settings(path.join(dir, 's.json'));
  const eng = new Engine({ settings, env: { TOKKIE_HOME: path.join(dir, 'h') }, home: dir, desktopDirs: [app], roots: () => [{ dir: path.join(dir, 'projects'), source: 'code' }] });
  await eng.start();
  const m = eng.snapshot().meters.find((x) => x.id === 'extra');
  assert.ok(m, 'extra meter present');
  assert.equal(m.approx, true); assert.equal(m.baseline, 14);
  assert.ok(Math.abs(m.pct - 18) < 0.05, `expected ~18% (14 + 2×20000 tokens at 10000/1%), got ${m.pct}`);   // 20000 tokens ≙ 2% each
  eng.stop(); fs.rmSync(dir, { recursive: true });
});

test('typing in the percentage Claude shows re-anchors the meter and keeps improving the calibration', async () => {
  const dir = tmp(); const app = path.join(dir, 'ClaudeApp'); fs.mkdirSync(app); const proj = path.join(dir, 'projects', 'p'); fs.mkdirSync(proj, { recursive: true });
  const H = 3600e3, now0 = Date.now();
  writeHist(app, [{ t: now0 - 9 * H, org: 'A', u: { xu: 10 } }, { t: now0 - 8 * H, org: 'A', u: { xu: 12 } }]);            // old, stale readings
  const mk = (t, id, o) => A(t, id, { i: 0, o, cw: 0, cr: 0 });
  fs.writeFileSync(path.join(proj, 's.jsonl'), [mk(now0 - 8.5 * H, 'a', 20000), mk(now0 - 2 * H, 'b', 40000)].join('\n') + '\n');
  const settings = new Settings(path.join(dir, 's.json'));
  const eng = new Engine({ settings, env: { TOKKIE_HOME: path.join(dir, 'h') }, home: dir, desktopDirs: [app], roots: () => [{ dir: path.join(dir, 'projects'), source: 'code' }] });
  await eng.start();
  const before = eng.snapshot().meters.find((x) => x.id === 'extra');
  assert.ok(before.pct > 12, 'bridged from the stale reading');
  assert.equal(eng.setManualReading('extra', 40), true);
  const after = eng.snapshot().meters.find((x) => x.id === 'extra');
  assert.ok(Math.abs(after.pct - 40) < 0.6, `anchored to what you typed, got ${after.pct}`);
  assert.equal(after.source, 'manual'); assert.equal(settings.get('manualReadings').length, 1, 'persisted');
  for (const bad of [-1, 101, NaN, Infinity, 'x']) assert.equal(eng.setManualReading('extra', bad), false, String(bad));
  assert.equal(eng.setManualReading('nope', 5), false);
  assert.equal(settings.get('manualReadings').length, 1, 'bad input is never stored');
  // the typed reading also teaches the calibration: usage since then moves the number in the right proportion
  eng.store.ingest(parseLine(mk(Date.now() + 1000, 'zz', 20000)));
  const later = eng.snapshot(Date.now() + 2000).meters.find((x) => x.id === 'extra');
  assert.ok(later.pct > after.pct, 'more usage → higher estimate');
  eng.stop(); fs.rmSync(dir, { recursive: true });
});
