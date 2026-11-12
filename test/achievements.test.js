'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, BADGES } = require('../src/core/achievements');
const { recap, weekStart } = require('../src/core/recap');

// local-time helpers: Wednesday 12 Nov 2025 is a Wednesday
const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const run = (start, o = {}) => ({ start, duration: 60, headline: 10_000, chars: 100, provider: 'claude', cwd: '/p/a', sessionId: 's', ...o });
const got = (r, id) => r.list.find((b) => b.id === id).at;

test('every badge has a name, icon and how-to', () => {
  assert.ok(BADGES.length >= 15);
  for (const b of BADGES) assert.ok(b.id && b.name && b.icon && b.how && typeof b.check === 'function', b.id);
  assert.equal(new Set(BADGES.map((b) => b.id)).size, BADGES.length, 'ids are unique');
});

test('nothing earned with no runs; progress is shown instead', () => {
  const r = evaluate({ samples: [], now: at(2025, 11, 12) });
  assert.equal(r.newly.length, 0);
  assert.deepEqual(r.list.find((b) => b.id === 'first').progress, [0, 1]);
  assert.deepEqual(r.list.find((b) => b.id === 'busy').progress, [0, 50]);
});

test('first run, night owl, early bird, marathon earn at the moment it happened', () => {
  const s = [run(at(2025, 11, 10, 2, 30)), run(at(2025, 11, 10, 6, 15)), run(at(2025, 11, 10, 14), { duration: 31 * 60 })];
  const r = evaluate({ samples: s, now: at(2025, 11, 12) });
  assert.equal(got(r, 'first'), at(2025, 11, 10, 2, 30) + 60e3);
  assert.equal(got(r, 'owl'), at(2025, 11, 10, 2, 30) + 60e3);
  assert.equal(got(r, 'bird'), at(2025, 11, 10, 6, 15) + 60e3);
  assert.equal(got(r, 'marathon'), at(2025, 11, 10, 14) + 31 * 60e3);
  assert.equal(got(r, 'ultra'), 0);
  assert.deepEqual(r.list.find((b) => b.id === 'ultra').progress, [31, 120], 'longest so far, in minutes');
});

test('streaks: consecutive days, across a month end, best kept', () => {
  const s = [at(2025, 10, 30), at(2025, 10, 31), at(2025, 11, 1), at(2025, 11, 3)].map((t) => run(t));
  const r = evaluate({ samples: s, now: at(2025, 11, 3, 18) });
  assert.ok(got(r, 'streak3') > 0, '30 Oct → 1 Nov is 3 in a row');
  assert.equal(got(r, 'streak7'), 0);
  assert.equal(r.bestStreak, 3);
  assert.equal(r.streak, 1, 'the streak going now started today');
  assert.deepEqual(r.list.find((b) => b.id === 'streak7').progress, [1, 7]);
});

test('a streak still counts in the morning before today’s first run', () => {
  const s = [at(2025, 11, 10), at(2025, 11, 11)].map((t) => run(t));
  assert.equal(evaluate({ samples: s, now: at(2025, 11, 12, 8) }).streak, 2);
  assert.equal(evaluate({ samples: s, now: at(2025, 11, 13, 8) }).streak, 0);
});

test('busy bee, millionaire, folder hopper, two brains: per local day', () => {
  const day = at(2025, 11, 11, 9);
  const s = [];
  for (let i = 0; i < 50; i++) s.push(run(day + i * 60e3, { headline: 25_000, cwd: `/p/${i % 5}` }));
  s.push(run(day + 3600e3, { provider: 'codex' }));
  const r = evaluate({ samples: s, now: at(2025, 11, 12) });
  assert.equal(got(r, 'busy'), day + 49 * 60e3 + 60e3, 'the 50th run');
  assert.equal(got(r, 'million'), day + 39 * 60e3 + 60e3, '40 × 25k = 1M');
  assert.equal(got(r, 'hopper'), day + 4 * 60e3 + 60e3, 'fifth folder');
  assert.equal(got(r, 'both'), day + 3600e3 + 60e3, 'when Codex joined Claude that day');
  // 49 runs today: progress, not earned
  const r2 = evaluate({ samples: s.slice(0, 49).map((x) => ({ ...x, start: x.start + 86400e3 })), now: at(2025, 11, 12, 18) });
  assert.equal(got(r2, 'busy'), 0);
  assert.deepEqual(r2.list.find((b) => b.id === 'busy').progress, [49, 50]);
});

test('weekend warrior needs a Saturday and the Sunday after it', () => {
  assert.equal(got(evaluate({ samples: [run(at(2025, 11, 8)), run(at(2025, 11, 9))], now: at(2025, 11, 12) }), 'weekend') > 0, true);
  assert.equal(got(evaluate({ samples: [run(at(2025, 11, 2)), run(at(2025, 11, 8))], now: at(2025, 11, 12) }), 'weekend'), 0, 'Sunday then Saturday is not one weekend');
});

test('flags, pet forms and the album', () => {
  const now = at(2025, 11, 12);
  const r = evaluate({ samples: [], stage: 3, album: { 'blob:horns': 'x', 'special:rainbow': 'y' }, flags: { juggler: now - 5 }, now });
  assert.equal(got(r, 'juggler'), now - 5);
  assert.ok(got(r, 'junior') && got(r, 'champion'));
  assert.equal(got(r, 'mega'), 0);
  assert.ok(got(r, 'secret'));
  assert.deepEqual(r.list.find((b) => b.id === 'collector').progress, [2, 10]);
});

test('earned badges are kept even when the runs are forgotten, and only new ones are "newly"', () => {
  const now = at(2025, 11, 12);
  const first = evaluate({ samples: [run(at(2025, 11, 10, 2))], now });
  assert.ok(first.newly.includes('owl'));
  const later = evaluate({ samples: [], earned: first.earned, now: now + 100 * 86400e3 });
  assert.equal(got(later, 'owl'), first.earned.owl);
  assert.equal(later.newly.length, 0);
});

test('weekStart is local Monday 00:00', () => {
  const w = new Date(weekStart(at(2025, 11, 12, 15)));
  assert.equal(w.getDay(), 1); assert.equal(w.getDate(), 10); assert.equal(w.getHours(), 0);
  assert.equal(new Date(weekStart(at(2025, 11, 16, 23))).getDate(), 10, 'Sunday belongs to the week that started Monday');
  assert.equal(new Date(weekStart(at(2025, 11, 12), 1)).getDate(), 3);
});

test('recap: totals, days, busiest, longest, providers, comparison', () => {
  const now = at(2025, 11, 16, 20);   // Sunday evening
  const s = [
    run(at(2025, 11, 4), { headline: 50_000, duration: 100 }),                      // week before
    run(at(2025, 11, 10, 9), { headline: 10_000, duration: 60 }),
    run(at(2025, 11, 12, 15), { headline: 300_000, duration: 1200, provider: 'codex' }),
    run(at(2025, 11, 12, 15, 30), { headline: 20_000, duration: 30 }),
  ];
  const r = recap({ samples: s, now, earned: { owl: at(2025, 11, 12), first: at(2025, 10, 1) }, names: { owl: '🦉 Night owl' }, usd: () => 4.5 });
  assert.equal(r.runs, 3); assert.equal(r.tokens, 330_000); assert.equal(r.seconds, 1290);
  assert.equal(r.claude, 2); assert.equal(r.codex, 1);
  assert.equal(r.days.length, 7); assert.equal(r.days[2].runs, 2);
  assert.equal(new Date(r.busiest.day).getDate(), 12);
  assert.equal(r.longest.provider, 'codex'); assert.equal(r.longest.duration, 1200);
  assert.equal(r.peakHour, 15);
  assert.equal(r.prev.runs, 1); assert.equal(r.vs.runs, 200);
  assert.deepEqual(r.badges, [{ id: 'owl', name: '🦉 Night owl' }], 'only badges earned that week');
  assert.equal(r.usd, 4.5); assert.equal(r.hasEarlier, true);
  const last = recap({ samples: s, now, offset: 1 });
  assert.equal(last.runs, 1); assert.equal(last.vs.runs, null, 'nothing to compare with');
});

test('recap of an empty week is calm, with future days marked', () => {
  const r = recap({ samples: [], now: at(2025, 11, 12) });
  assert.equal(r.runs, 0); assert.equal(r.busiest, null); assert.equal(r.longest, null); assert.equal(r.peakHour, null);
  assert.equal(r.days.filter((d) => d.future).length, 4, 'Thursday to Sunday have not happened yet');
});

test('the recap has no prompts or folders in it (safe to share)', () => {
  const r = recap({ samples: [run(at(2025, 11, 12), { preview: 'SECRET prompt', cwd: '/Users/x/secret-project' })], now: at(2025, 11, 13) });
  const txt = JSON.stringify(r);
  assert.ok(!txt.includes('SECRET') && !txt.includes('secret-project'));
});
