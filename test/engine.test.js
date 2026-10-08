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
  eng.runLog.save(eng.store.samples);
  assert.equal(eng.runLog.load().length, 1, 'runs persisted to runs.json');
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

test('fit check: says when a prompt will not fit in what is left of a limit', async () => {
  const { dir, eng, settings } = rig();
  settings.set({ calib: { five: { k: 1_000_000 }, seven: {} } });            // 1M weighted tokens = 100% of the 5-hour window
  const meters = [{ id: 'five', label: '5-hour limit', pct: 95 }];
  assert.equal(eng._fit({ p50: 80_000, p75: 120_000 }, meters).status, 'no');      // needs 8–12%, 5% left
  assert.equal(eng._fit({ p50: 30_000, p75: 60_000 }, meters).status, 'risky');    // 3–6%
  assert.equal(eng._fit({ p50: 10_000, p75: 20_000 }, meters).status, 'ok');
  assert.equal(eng._fit({ p50: 1, p75: 1 }, [{ id: 'five', label: '5-hour limit', pct: 100 }]).status, 'no');   // used up
  const d = eng._fit({ p50: 80_000, p75: 120_000 }, [{ id: 'five', label: 'x', pct: 95, limitUsd: 200 }]);
  assert.ok(Math.abs(d.usd.left - 10) < 1e-9 && Math.abs(d.usd.p50 - 16) < 1e-9);
  assert.equal(eng._fit({ p50: 1, p75: 1 }, [{ id: 'seven', label: 'w', pct: 50 }]), null);       // can't convert → no claim
  fs.rmSync(dir, { recursive: true });
});

test('new install with a $ limit: the bridge’s exact dollars calibrate the live estimate (no stale reading shown as current)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-eng-'));
  const proj = path.join(dir, 'projects', 'p'); fs.mkdirSync(proj, { recursive: true });
  const app = path.join(dir, 'app'); fs.mkdirSync(app);
  const env = { TOKKIE_HOME: path.join(dir, 'lh') };
  const settings = new Settings(path.join(dir, 'settings.json'));
  settings.set({ spendLimitUsd: 600 });
  const now = Date.now(), old = now - 30 * 3600e3;
  // one old Claude reading (23%), no history to calibrate from
  fs.writeFileSync(path.join(app, 'plan-usage-history.json'), JSON.stringify({ samples: [{ t: old, org: 'o', u: { xu: 23 } }] }));
  // since then: a Claude Code session with 1M weighted tokens that the bridge says cost $66 (= 11% of $600)
  fs.writeFileSync(path.join(proj, 's.jsonl'), A(now - 3 * 3600e3, 'x', { s: 'S', i: 0, o: 1_000_000, cw: 0, cr: 0, stop: 'end_turn' }) + '\n');
  const bdir = path.join(env.TOKKIE_HOME, 'bridge'); fs.mkdirSync(bdir, { recursive: true });
  const write = (usd, at) => { const f = path.join(bdir, 'S.json'); fs.writeFileSync(f, JSON.stringify({ sessionId: 'S', updatedAt: at, costUsd: usd, turns: [] })); fs.utimesSync(f, new Date(at), new Date(at)); };
  write(0.0, now - 3 * 3600e3);
  const eng = new Engine({ settings, env, home: dir, desktopDirs: [app], roots: () => [{ dir: path.join(dir, 'projects'), source: 'code' }] });
  await eng.start();
  write(66, now - 60e3); eng._readBridge(); eng._dk = null; eng._snapKey = null;
  const m = eng.snapshot().meters.find((x) => x.id === 'extra');
  assert.equal(m.approx, true);
  assert.ok(Math.abs(m.pct - 34) < 0.6, `pct ${m.pct}`);           // 23% + $66/$600
  eng.stop(); fs.rmSync(dir, { recursive: true });
});

test('full prompt text is read on demand, in chunks, and long prompts are trimmed for display but not for copying', async () => {
  const { dir, proj, eng } = rig();
  const t0 = T(), long = 'Once upon a time. '.repeat(10_000);          // ~180k characters, a "storybook" prompt
  const filler = Array.from({ length: 3000 }, (_, i) => A(t0 - 1e6 + i, 'f' + i, { stop: 'end_turn' })).join('\n');   // ~1.5 MB before it
  fs.writeFileSync(path.join(proj, 's.jsonl'), [filler, U(t0, long), A(t0 + 4000, 'a', { stop: 'end_turn' })].join('\n') + '\n');
  await eng.start();
  const run = eng.recentRuns(1)[0];
  assert.ok(run.hasText && run.preview.startsWith('Once upon a time.'));
  const t = await eng.promptText(run.sessionId, run.uuid);
  assert.equal(t.total, long.trim().length);
  assert.equal(t.text.length, 60_000);
  assert.equal(t.full, long.trim());
  assert.equal(await eng.promptText(run.sessionId, 'not-a-real-id'), null);
  eng.stop(); fs.rmSync(dir, { recursive: true });
});

test('history groups every remembered run by day, newest first, and survives a restart via runs.json', async () => {
  const { dir, proj, eng, settings } = rig();
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const t1 = today.getTime() - 2 * 86400e3, t2 = Math.min(Date.now() - 60e3, today.getTime());
  fs.writeFileSync(path.join(proj, 's.jsonl'), [U(t1, 'old prompt'), A(t1 + 6000, 'a', { o: 500, stop: 'end_turn' }), U(t2, 'new prompt'), A(t2 + 8000, 'b', { o: 700, stop: 'end_turn' })].join('\n') + '\n');
  await eng.start();
  const h = eng.history();
  assert.equal(h.days.length, 2);
  assert.ok(h.days[0].day > h.days[1].day);
  assert.equal(h.days[0].runs[0].preview, 'new prompt'); assert.equal(h.days[1].runs[0].preview, 'old prompt');
  assert.ok(h.days[0].tokens > 0 && h.days[0].seconds === 8);
  eng.stop();
  // a fresh engine (the logs are gone) still has the runs
  fs.rmSync(path.join(proj, 's.jsonl'));
  const eng2 = new Engine({ settings, env: { TOKKIE_HOME: path.join(dir, 'lh') }, home: dir, roots: () => [{ dir: path.join(dir, 'projects'), source: 'code' }] });
  await eng2.start();
  assert.equal(eng2.history().days.length, 2);
  eng2.stop(); fs.rmSync(dir, { recursive: true });
});

test('whole-run cost: estimates $ from your own past runs, only once there are 3 with a known cost', async () => {
  const { dir, eng } = rig();
  await eng.start();
  assert.equal(eng.estimate('fix the bug').cost, null);
  const now = Date.now();
  for (let i = 0; i < 4; i++) eng.store.samples.push({ start: now - (i + 1) * 3600e3, chars: 200, duration: 300, headline: 50_000, tokens: 50_000, usd: 3 });
  const e = eng.estimate('fix the bug');
  assert.ok(e.cost && e.cost.n === 4);
  assert.ok(Math.abs(e.cost.p25 - e.tokens.p25 * 0.00006) < 1e-9 && e.cost.p75 >= e.cost.p25);
  eng.stop(); fs.rmSync(dir, { recursive: true });
});

test('chat-aware: a big chat costs more per prompt, and a cold cache adds a full rewrite of it', async () => {
  const { dir, eng } = rig();
  await eng.start();
  const now = Date.now();
  for (let i = 0; i < 20; i++) eng.store.samples.push({ start: now - (i + 1) * 3600e3, chars: 200, duration: 120, headline: 20_000, tokens: 40_000, steps: 8, usd: 1, cold: false });
  eng.store.cacheBySession.set('s1', { at: now - 60e3, ttl: '5m', ctx: 600_000 });
  const warm = eng.estimate('fix the bug', now);
  assert.equal(warm.chat.cold, false); assert.equal(warm.chat.ctx, 600_000);
  assert.ok(warm.chat.rereads.p50 > 1e6, 'every step re-reads the 600k chat');
  assert.ok(warm.chat.here.p50 > 5 * warm.chat.fresh.p50 && warm.chat.cost.p50 > warm.chat.newCost.p50);
  const cold = eng.estimate('fix the bug', now + 10 * 60e3);
  assert.equal(cold.chat.cold, true);
  assert.ok(cold.chat.freshHere.p50 - warm.chat.freshHere.p50 > 590_000, 'the expired cache re-writes the whole chat');
  assert.ok(eng.snapshot(now).nextRun && eng.snapshot(now).nextRun.ctx === 600_000);
  eng.stop(); fs.rmSync(dir, { recursive: true });
});

test('runs record the chat size at Enter, whether its cache was cold, and the steps taken', () => {
  const { Store } = require('../src/core/store');
  const st = new Store();
  const t = Date.now() - 600e3, u = (id, ts, o) => ({ kind: 'usage', ts, sessionId: 's', id, model: 'm', input: 5, output: 50, cacheWrite: o.cw || 0, cacheRead: o.cr || 0, ending: !!o.end });
  st.ingest(u('a', t, { cr: 300_000, end: true }));
  st.ingest({ kind: 'prompt', ts: t + 30e3, sessionId: 's', chars: 40 });
  st.ingest(u('b', t + 40e3, { cr: 300_000 })); st.ingest(u('c', t + 50e3, { cr: 300_000, end: true }));
  const s = st.samples[st.samples.length - 1];
  assert.equal(s.steps, 2); assert.equal(s.cold, false); assert.ok(s.ctx0 >= 300_000); assert.equal(s.cacheRead, 600_000);
});
