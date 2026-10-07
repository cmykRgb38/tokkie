'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/core/engine');
const { Settings } = require('../src/core/settings');
const { A, U, TR } = require('./helpers');

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-eng-'));
  const proj = path.join(dir, 'projects', 'p'); fs.mkdirSync(proj, { recursive: true });
  const env = { TOKKIE_HOME: path.join(dir, 'lh') };
  const settings = new Settings(path.join(dir, 'settings.json'));
  const eng = new Engine({ settings, env, home: dir, roots: () => [{ dir: path.join(dir, 'projects'), source: 'code' }] });
  return { dir, proj, env, settings, eng };
}
const T = () => Date.now() - 30e3;

test('end-to-end: logs → snapshot → live turn → sample → estimate', async () => {
  const { dir, proj, eng, settings } = rig();
  const t0 = T();
  fs.writeFileSync(path.join(proj, 's.jsonl'), [U(t0, 'build me a thing'), A(t0 + 1000, 'a', { o: 200 })].join('\n') + '\n');
  await eng.start();
  let snap = eng.snapshot();
  assert.equal(snap.loaded, true); assert.ok(snap.active, 'turn should be running'); assert.ok(snap.tokens.today > 0);
  const ended = new Promise((r) => eng.once('turn-end', r));
  fs.appendFileSync(path.join(proj, 's.jsonl'), A(t0 + 20000, 'b', { o: 300, stop: 'end_turn' }) + '\n');
  await eng.tailer.poll();
  const e = await ended;
  assert.equal(e.duration, 20);
  snap = eng.snapshot(); assert.equal(snap.active, null); assert.equal(snap.samples, 1);
  const est = eng.estimate('please refactor the whole module and add tests');
  assert.ok(est.promptTokens > 5); assert.ok(est.duration.p50 > 0); assert.ok(['go', 'tight', 'stop', 'over'].includes(est.plan.verdict));
  assert.equal(settings.get('samples').length, 1, 'samples persisted');
  eng.stop(); fs.rmSync(dir, { recursive: true });
});

test('plan limits file is picked up and calibrates live extrapolation', async () => {
  const { dir, proj, env, eng } = rig();
  const t0 = T();
  fs.writeFileSync(path.join(proj, 's.jsonl'), A(t0, 'a', { i: 0, o: 100000, cw: 0, cr: 0, stop: 'end_turn' }) + '\n');
  fs.mkdirSync(env.TOKKIE_HOME, { recursive: true });
  const resets = Math.floor((Date.now() + 3 * 3600e3) / 1000);
  fs.writeFileSync(path.join(env.TOKKIE_HOME, 'rate_limits.json'), JSON.stringify({ updated_at: Math.floor(Date.now() / 1000), five_hour: { used_percentage: 10, resets_at: resets } }));
  await eng.start();
  const s = eng.snapshot();
  assert.equal(s.limits.connected, true); assert.ok(Math.abs(s.limits.five.pct - 10) < 1);
  assert.ok(eng.settings.get('calib').five.k > 0, 'calibration persisted');
  assert.ok(eng.estimate('hello').share, 'share of limit available once calibrated');
  eng.stop(); fs.rmSync(dir, { recursive: true });
});

test('works with zero data: day-one experience', async () => {
  const { dir, eng } = rig();
  await eng.start();
  const s = eng.snapshot(); assert.equal(s.active, null); assert.equal(s.limits.connected, false); assert.equal(s.tokens.today, 0);
  const e = eng.estimate(''); assert.equal(e.confidence, 'low'); assert.equal(e.share, null);
  eng.stop(); fs.rmSync(dir, { recursive: true });
});

test('dollar mode: with a spend limit and the bridge running since the reading, Claude Code dollars are exact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-eng-'));
  const proj = path.join(dir, 'projects', 'p'); fs.mkdirSync(proj, { recursive: true });
  const app = path.join(dir, 'app'); fs.mkdirSync(app);
  const env = { TOKKIE_HOME: path.join(dir, 'lh') };
  const settings = new Settings(path.join(dir, 'settings.json'));
  settings.set({ spendLimitUsd: 200 });
  const now = Date.now(), t0 = now - 40 * 60e3;
  // the bridge saw session c at $10 before Claude's reading, then $25 after it
  const bdir = path.join(env.TOKKIE_HOME, 'bridge'); fs.mkdirSync(bdir, { recursive: true });
  const write = (usd, at) => { const f = path.join(bdir, 'c.json'); fs.writeFileSync(f, JSON.stringify({ sessionId: 'c', updatedAt: at, costUsd: usd, turns: [{ at, usd: 1.5 }], context: { tokens: 120000, window: 200000, percent: 60 } })); fs.utimesSync(f, new Date(at), new Date(at)); };
  write(10, t0);
  fs.writeFileSync(path.join(app, 'plan-usage-history.json'), JSON.stringify({ samples: [{ t: t0 + 60e3, org: 'o', u: { xu: 40 } }] }));
  // Code session c's tokens must not be counted twice (they are in the dollars)
  fs.writeFileSync(path.join(proj, 'c.jsonl'), A(t0 + 5 * 60e3, 'x', { s: 'c', i: 0, o: 900000, cw: 0, cr: 0, stop: 'end_turn' }) + '\n');
  const eng = new Engine({ settings, env, home: dir, desktopDirs: [app], roots: () => [{ dir: path.join(dir, 'projects'), source: 'code' }] });
  await eng.start();
  write(25, now - 60e3); eng._readBridge();
  const s = eng.snapshot();
  const m = s.meters.find((x) => x.id === 'extra');
  assert.equal(m.mode, 'dollars');
  assert.ok(Math.abs(m.pct - (40 + (15 / 200) * 100)) < 0.01, `pct ${m.pct}`);
  assert.ok(Math.abs(m.usd - 95) < 0.1, `usd ${m.usd}`); assert.equal(m.limitUsd, 200);
  assert.ok(m.pace && Number.isFinite(m.pace.pace));
  assert.equal(s.context.tokens, 120000); assert.equal(s.lastPrompt.usd, 1.5);
  eng.stop(); fs.rmSync(dir, { recursive: true });
});
