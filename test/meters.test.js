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
