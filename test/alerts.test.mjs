import test from 'node:test';
import assert from 'node:assert/strict';
import { alertState, acknowledge } from '../src/renderer/alerts.js';

const NOW = 1_000_000_000_000;
const done = (end, dur = 90) => ({ active: null, lastTurnEnd: end, lastTurn: { end, dur }, now: NOW });

test('a finished run alerts until acknowledged, then stays quiet', () => {
  const S = done(NOW - 30_000), acked = { doneEnd: NOW - 3600e3, ask: null };
  assert.deepEqual(alertState(S, acked), { kind: 'done', since: NOW - 30_000 });
  const a2 = acknowledge(S, acked);
  assert.equal(alertState(S, a2), null);
  assert.equal(alertState(done(NOW - 5_000), a2).kind, 'done', 'the NEXT finished run alerts again');
});
test('quick replies and ancient finishes do not nag; nothing alerts when disabled', () => {
  const acked = { doneEnd: 0, ask: null };
  assert.equal(alertState(done(NOW - 5000, 6), acked), null, 'a 6-second run is not worth an alert');
  assert.equal(alertState(done(NOW - 3 * 3600e3), acked), null, 'older than 2h');
  assert.equal(alertState(done(NOW - 5000), acked, false), null);
  assert.equal(alertState({ active: null, lastTurnEnd: NOW - 5000, lastTurn: { end: NOW - 9999, dur: 99 }, now: NOW }, acked), null, 'the last RECORDED run must be the one that just ended');
});
test('a quiet running task may be waiting on you; dismissing it holds until new activity', () => {
  const run = (lastTs) => ({ active: { lastTs, start: lastTs - 100_000 }, lastTurnEnd: 0, now: NOW });
  assert.equal(alertState(run(NOW - 20_000), { doneEnd: 0, ask: null }), null, 'recent activity: fine');
  const quiet = run(NOW - 90_000);
  assert.equal(alertState(quiet, { doneEnd: 0, ask: null }).kind, 'ask');
  const seen = acknowledge(quiet, { doneEnd: 0, ask: null });
  assert.equal(alertState(quiet, seen), null, 'dismissed');
  assert.equal(alertState(run(NOW - 80_000), seen).kind, 'ask', 'new activity then quiet again → asks again');
});
