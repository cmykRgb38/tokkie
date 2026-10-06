'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store, H } = require('../src/core/store');
const { parseLine } = require('../src/core/parser');
const { A, U, TR } = require('./helpers');
const T0 = Date.parse('2026-10-06T10:00:00Z');
const feed = (s, lines) => lines.forEach((l) => s.ingest(parseLine(l)));

test('streaming duplicates of one message count once, keeping the largest', () => {
  const s = new Store({ now: () => T0 + 1000 });
  feed(s, [A(T0, 'm1', { o: 10 }), A(T0 + 100, 'm1', { o: 400 }), A(T0 + 200, 'm1', { o: 400 })]);
  assert.equal(s.msgs.size, 1);
  assert.equal(s.sumSince(0).output, 400);
});
test('replaying the same lines is idempotent', () => {
  const s = new Store({ now: () => T0 + 5000 });
  const lines = [U(T0, 'go'), A(T0 + 1000, 'a', { stop: 'tool_use' }), TR(T0 + 2000), A(T0 + 9000, 'b', { stop: 'end_turn' })];
  feed(s, lines); feed(s, lines);
  assert.equal(s.msgs.size, 2); assert.equal(s.samples.length, 1);
});
test('a turn produces a duration + token sample', () => {
  const s = new Store({ now: () => T0 + 60e3 });
  feed(s, [U(T0, 'x'.repeat(300)), A(T0 + 5000, 'a', { o: 50 }), TR(T0 + 6000), A(T0 + 30000, 'b', { o: 70, stop: 'end_turn' })]);
  assert.equal(s.samples.length, 1);
  const t = s.samples[0];
  assert.equal(t.duration, 30); assert.equal(t.chars, 300); assert.equal(t.output, 120); assert.ok(t.tokens > 0);
  assert.equal(s.activeTurn(T0 + 31000), null);
});
test('active turn is tracked, then stale ones are ignored', () => {
  const now = T0 + 20e3; const s = new Store({ now: () => now });
  feed(s, [U(T0, 'hi'), A(T0 + 3000, 'a', { stop: 'tool_use' })]);
  const a = s.activeTurn(now);
  assert.ok(a); assert.equal(a.elapsed, 20e3);
  assert.equal(s.activeTurn(T0 + 40 * 60e3), null); // abandoned
});
test('interrupted / superseded turns do not become samples', () => {
  const s = new Store({ now: () => T0 + 1e6 });
  feed(s, [U(T0, 'first'), A(T0 + 1000, 'a'), U(T0 + 2000, '[Request interrupted by user]'), U(T0 + 50000, 'second'), A(T0 + 60000, 'b', { stop: 'end_turn' })]);
  assert.equal(s.samples.length, 1); assert.equal(s.samples[0].duration, 10);
});
test('implausible durations are rejected (<2.5s, >4h)', () => {
  const s = new Store({ now: () => T0 + 10 * H });
  feed(s, [U(T0, 'a'), A(T0 + 1000, 'a1', { stop: 'end_turn' }), U(T0 + 5000, 'b'), A(T0 + 5000 + 5 * H, 'b1', { stop: 'end_turn' })]);
  assert.equal(s.samples.length, 0);
});
test('sub-agent tokens fold into the parent turn', () => {
  const s = new Store({ now: () => T0 + 60e3 });
  feed(s, [U(T0, 'go'), A(T0 + 2000, 'sub', { side: true, o: 1000, cr: 0, cw: 0, i: 0 }), A(T0 + 9000, 'end', { o: 10, cr: 0, cw: 0, i: 0, stop: 'end_turn' })]);
  assert.equal(s.samples[0].output, 1010);
});
test('5-hour block anchors to the first message after a gap', () => {
  const now = T0 + 2 * H; const s = new Store({ now: () => now });
  feed(s, [A(T0 - 6 * H, 'old'), A(T0 + 20 * 60e3, 'new1'), A(T0 + H, 'new2')]);
  const b = s.currentBlock(now);
  assert.equal(b.start, T0); assert.equal(b.end, T0 + 5 * H);
  assert.equal(s.currentBlock(T0 + 6 * H), null);
});
test('sums and sparkline', () => {
  const now = T0 + 10 * 60e3; const s = new Store({ now: () => now });
  feed(s, [A(T0 + 60e3, 'a', { i: 1, o: 10, cw: 100, cr: 1000 }), A(T0 + 9 * 60e3, 'b', { i: 1, o: 20, cw: 0, cr: 0 })]);
  const r = s.sumSince(T0); assert.equal(r.headline, 132); assert.equal(r.weighted, 232);
  const sp = s.sparkline(10, now); assert.equal(sp.length, 10); assert.equal(sp.reduce((a, b) => a + b, 0), 132);
});

test('aggregate() agrees with the individual range queries', () => {
  const now = T0 + 6 * H; const s = new Store({ now: () => now });
  const lines = []; for (let i = 0; i < 300; i++) lines.push(A(T0 + i * 60e3 * 1.1, 'm' + i, { i: 1, o: 10 + i, cw: 5, cr: 100 }));
  feed(s, lines);
  const g = s.aggregate(now), d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  assert.equal(g.last5h.headline, s.sumSince(now - 5 * H, now).headline);
  assert.equal(g.week.weighted, s.sumSince(now - 7 * 24 * H, now).weighted);
  assert.equal(g.today.headline, s.sumSince(d0.getTime(), now).headline);
  assert.deepEqual(g.spark, s.sparkline(60, now));
  assert.ok(Math.abs(g.burn - s.burnRate(20, now)) < 1e-9);
});
test('snapshot of 150k messages stays cheap', () => {
  const now = T0 + 12 * H; const s = new Store({ now: () => now });
  for (let i = 0; i < 150000; i++) s.msgs.set('m' + i, { ts: now - Math.random() * 7 * 24 * H, input: 1, output: 50, cacheWrite: 10, cacheRead: 500, sessionId: 's' });
  // A regression guard, not a benchmark: best of 5 so a busy CI machine can't fail it, and a limit ~10x the typical time.
  let best = Infinity;
  for (let i = 0; i < 5; i++) { const t = process.hrtime.bigint(); s.aggregate(now); best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6); }
  assert.ok(best < 400, `aggregate took ${best.toFixed(0)}ms at best`);
});
