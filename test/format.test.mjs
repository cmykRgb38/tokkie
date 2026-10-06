import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtRange, fmtDur, fmtTokens, parseTime } from '../src/renderer/util.js';

test('fmtRange never inverts units and always reads naturally', () => {
  assert.equal(fmtRange(20, 50), '20–50 sec');
  assert.equal(fmtRange(30, 240), '1–4 min');
  assert.equal(fmtRange(540, 1080), '9–18 min');
  assert.equal(fmtRange(240, 250), '~4 min');
  assert.equal(fmtRange(4000, 9000), '1.1–2.5 hr');
  assert.equal(fmtRange(10.2, 10.4), '~10 sec');
});
test('fmtDur / fmtTokens', () => {
  assert.equal(fmtDur(75), '1m 15s'); assert.equal(fmtDur(3700), '1h 02m'); assert.equal(fmtDur(7200), '2h'); assert.equal(fmtDur(0), '0s');
  assert.equal(fmtTokens(999), '999'); assert.equal(fmtTokens(1234), '1.2k'); assert.equal(fmtTokens(15600), '16k'); assert.equal(fmtTokens(1284300), '1.28M');
});
test('parseTime is forgiving but strict about nonsense', () => {
  for (const [i, o] of [['18:30', '18:30'], ['6:30pm', '18:30'], ['6.30 PM', '18:30'], ['1830', '18:30'], ['6pm', '18:00'], ['12am', '00:00'], ['12pm', '12:00'], ['9', '09:00'], ['07:05', '07:05']]) assert.equal(parseTime(i), o, i);
  for (const bad of ['', 'abc', '25:00', '13pm', '6:75', null]) assert.equal(parseTime(bad), null, String(bad));
});
