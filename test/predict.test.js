'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { predict, planVerdict, finishTimestamp } = require('../src/core/predict');
const { estimateTokens, complexityHint } = require('../src/core/tokens');

const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ chars: 50 + i * 40, duration: f(50 + i * 40, i), tokens: 20000 + i * 500, start: i }));

test('bands are ordered and positive; day-one priors are used with no history', () => {
  const p = predict([], 'fix the login bug');
  assert.equal(p.confidence, 'low'); assert.equal(p.method, 'prior');
  assert.ok(0 < p.duration.p25 && p.duration.p25 < p.duration.p50 && p.duration.p50 < p.duration.p75 && p.duration.p75 < p.duration.p90);
});
test('regression learns that longer prompts take longer', () => {
  const s = mk(60, (c, i) => 20 * Math.pow(c, 0.5) * (1 + ((i * 7) % 5) / 40));
  const short = predict(s, '', 100).duration.p50, long = predict(s, '', 2000).duration.p50;
  assert.equal(predict(s, '', 100).method, 'regression'); assert.equal(predict(s, '', 100).confidence, 'high');
  assert.ok(long > short * 1.5, `${short} -> ${long}`);
});
test('history pulls the estimate toward the user\'s real durations', () => {
  const fast = predict(mk(40, () => 20), '', 300).duration.p50, slow = predict(mk(40, () => 600), '', 300).duration.p50;
  assert.ok(fast < 60 && slow > 300, `${fast} ${slow}`);
});
test('a single odd sample cannot dominate (shrinkage)', () => {
  const p = predict([{ chars: 100, duration: 5000, tokens: 1e6, start: 1 }], '', 100);
  assert.ok(p.duration.p50 < 1500);
});
test('verdict: go / tight / stop / over', () => {
  const pred = { duration: { p25: 300, p50: 600, p75: 900, p90: 1200 } };
  const finish = Date.parse('2026-10-06T18:30:00');
  const at = (hh, mm) => Date.parse(`2026-10-06T${hh}:${mm}:00`);
  assert.equal(planVerdict(pred, at('16', '00'), finish).verdict, 'go');
  assert.equal(planVerdict(pred, at('18', '05'), finish).verdict, 'tight');
  assert.equal(planVerdict(pred, at('18', '17'), finish).verdict, 'stop');
  assert.equal(planVerdict(pred, at('18', '25'), finish).verdict, 'over');
  const v = planVerdict(pred, at('16', '00'), finish, 10);
  assert.equal(v.sendBy, finish - 10 * 60e3 - 1200e3);
});
test('finishTimestamp parses HH:MM and tolerates junk', () => {
  const d = new Date(finishTimestamp('18:30', Date.parse('2026-10-06T08:00:00')));
  assert.equal(d.getHours(), 18); assert.equal(d.getMinutes(), 30);
  assert.equal(new Date(finishTimestamp('garbage')).getHours(), 18);
});
test('token estimator is sane on prose, code, CJK, empty', () => {
  assert.equal(estimateTokens(''), 0);
  const prose = 'The quick brown fox jumps over the lazy dog and keeps running through the forest.';
  const n = estimateTokens(prose); assert.ok(n >= 14 && n <= 24, String(n));
  const code = 'function add(a, b) { return a + b; }\nconsole.log(add(1, 2));';
  const c = estimateTokens(code); assert.ok(c >= 18 && c <= 40, String(c));
  assert.ok(estimateTokens('你好，世界！今天天气很好') >= 10);
  assert.ok(estimateTokens('x'.repeat(40000)) > 5000);
});
test('complexity hint reacts to wording within bounds', () => {
  assert.ok(complexityHint('rename this variable, quick typo fix') < 1);
  assert.ok(complexityHint('build a comprehensive end-to-end app from scratch and test everything\n1. a\n2. b\n3. c') > 1.5);
  assert.ok(complexityHint('build '.repeat(100)) <= 3);
});

test('learns that wording and the previous run both matter (3-feature model)', () => {
  // synthetic user: duration ≈ 30 · hint^1.2 · (prev+5)^0.4 — the model should recover direction, not exact values
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const samples = Array.from({ length: 120 }, (_, i) => {
    const hint = 0.6 + rnd() * 2, prev = rnd() < 0.7 ? 20 + rnd() * 600 : 0, chars = 40 + rnd() * 1500;
    return { chars, hint, prev, duration: 30 * Math.pow(hint, 1.2) * Math.pow((prev || 35) + 5, 0.4) * (0.8 + rnd() * 0.4), tokens: 20000 * hint, start: i };
  });
  const lightText = 'quick typo fix', heavyText = 'build a comprehensive end-to-end system from scratch and test everything';
  const light = predict(samples, lightText, 200, { prev: 30 }).duration.p50, heavy = predict(samples, heavyText, 200, { prev: 30 }).duration.p50;
  assert.ok(heavy > light * 1.5, `${light} vs ${heavy}`);
  const afterShort = predict(samples, 'x'.repeat(200), 200, { prev: 15 }).duration.p50, afterLong = predict(samples, 'x'.repeat(200), 200, { prev: 900 }).duration.p50;
  assert.ok(afterLong > afterShort * 1.3, `${afterShort} vs ${afterLong}`);
});
test('stays finite and positive on degenerate data (identical samples, zeros)', () => {
  const same = Array.from({ length: 30 }, (_, i) => ({ chars: 100, hint: 1, prev: 0, duration: 60, tokens: 5000, start: i }));
  const p = predict(same, 'x', 100, { prev: 0 });
  for (const v of Object.values(p.duration)) assert.ok(Number.isFinite(v) && v > 0);
  assert.ok(p.duration.p50 > 30 && p.duration.p50 < 120);
});
