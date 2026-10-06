'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store, H } = require('../src/core/store');
const { parseLine } = require('../src/core/parser');
const { compute } = require('../src/core/limits');
const { A } = require('./helpers');

const NOW = Date.parse('2026-10-06T12:00:00Z');
const mkStore = () => new Store({ now: () => NOW });
const lim = (pct, resetsInMs, updatedAgoMs = 0) => ({ updated_at: (NOW - updatedAgoMs) / 1000, five_hour: { used_percentage: pct, resets_at: (NOW + resetsInMs) / 1000 } });

test('extrapolates live from tokens used since the last statusline reading', () => {
  const s = mkStore(); const feed = (l) => s.ingest(parseLine(l));
  // 10% reading with 100k weighted tokens in the window => implied limit 1M
  feed(A(NOW - 2 * H, 'a', { i: 0, o: 100000, cw: 0, cr: 0 }));
  const reading = NOW - 30 * 60e3;
  const l = lim(10, 3 * H, 30 * 60e3);
  // after the reading: another 50k tokens
  feed(A(NOW - 10 * 60e3, 'b', { i: 0, o: 50000, cw: 0, cr: 0 }));
  const r = compute(l, s, {}, NOW);
  assert.equal(r.connected, true);
  assert.ok(Math.abs(r.five.pct - 15) < 0.5, String(r.five.pct)); // 10% + 50k/1M
  assert.equal(r.five.approx, true);
});
test('never exceeds 100 and does not go backwards', () => {
  const s = mkStore(); s.ingest(parseLine(A(NOW - 60e3, 'a', { i: 0, o: 5e6, cw: 0, cr: 0 })));
  assert.equal(compute(lim(99, H, 5 * H), s, { five: { k: 1000 } }, NOW).five.pct, 100);
});
test('an expired window reports expired instead of a wrong %', () => {
  const r = compute(lim(80, -60e3), mkStore(), {}, NOW);
  assert.equal(r.five.expired, true); assert.equal(r.five.pct, null);
});
test('no data / bad data is harmless', () => {
  assert.equal(compute(null, mkStore(), {}, NOW).connected, false);
  assert.equal(compute({ five_hour: { used_percentage: 'x' } }, mkStore(), {}, NOW).connected, false);
});
