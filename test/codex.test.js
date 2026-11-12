'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { CodexReader, parseRateLimits, windowLabel } = require('../src/core/codex');

/** A tiny Codex home with the two databases Tokkie reads (same tables and columns as Codex 0.157+). */
function fakeCodex() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-codex-')), dir = path.join(home, '.codex');
  fs.mkdirSync(dir);
  const st = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  st.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, tokens_used INTEGER, model TEXT, cwd TEXT, updated_at_ms INTEGER)');
  const th = new DatabaseSync(path.join(dir, 'thread_history_1.sqlite'));
  th.exec('CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, first_user_item_id TEXT)');
  th.exec('CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, item_json TEXT)');
  return { home, st, th };
}

test('Codex turns become runs: tokens shared by run time at first sight, then the growth of the total per new turn', () => {
  const { home, st, th } = fakeCodex();
  const now = Date.now(), s = Math.floor(now / 1000);
  st.prepare('INSERT INTO threads VALUES (?,?,?,?,?)').run('T1', 30000, 'gpt-x', '/work/app', now - 1000);
  th.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?,?)').run('T1', 'a', 0, 'completed', s - 600, s - 500, 100000, 'u1');
  th.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?,?)').run('T1', 'b', 1, 'completed', s - 400, s - 200, 200000, 'u2');
  th.prepare('INSERT INTO thread_items VALUES (?,?,?,?)').run('T1', 'b', 'u2', JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: 'fix the login bug' }] }));
  const r = new CodexReader({ home, env: {}, now: () => now });
  assert.equal(r.available(), true);
  const first = r.poll();
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((x) => x.tokens), [10000, 20000]);              // 30k shared 1:2 by run time
  assert.ok(first.every((x) => x.provider === 'codex' && x.estimatedTokens));
  assert.equal(first[1].preview, 'fix the login bug'); assert.equal(first[1].cwd, '/work/app'); assert.equal(first[1].duration, 200);
  assert.equal(r.poll().length, 0, 'nothing twice');
  // a new turn: its tokens are what the thread's total grew by
  st.prepare('UPDATE threads SET tokens_used = 45000, updated_at_ms = ? WHERE id = ?').run(now, 'T1');
  th.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?,?)').run('T1', 'c', 2, 'completed', s - 100, s - 50, 50000, null);
  const next = r.poll();
  assert.equal(next.length, 1); assert.equal(next[0].tokens, 15000); assert.equal(next[0].estimatedTokens, false);
  // a turn still running makes Codex "active"
  th.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?,?)').run('T1', 'd', 3, 'inProgress', s - 5, null, null, null);
  st.prepare('UPDATE threads SET updated_at_ms = ? WHERE id = ?').run(now, 'T1');
  r.poll();
  assert.ok(r.active && r.active.sessionId === 'T1' && r.active.provider === 'codex');
});

test('no Codex installed: nothing, and no errors', () => {
  const r = new CodexReader({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-nocodex-')), env: {} });
  assert.equal(r.available(), false); assert.deepEqual(r.poll(), []);
});

test('Codex limits: windows are named by their length, shortest first; a plan may only have a weekly one', () => {
  assert.equal(windowLabel(300), '5-hour'); assert.equal(windowLabel(10080), 'Weekly'); assert.equal(windowLabel(1440), '1-day');
  const plus = parseRateLimits({ rateLimits: { planType: 'plus', primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1794908373 }, secondary: null, credits: { hasCredits: false, unlimited: false } } });
  assert.equal(plus.plan, 'plus'); assert.equal(plus.windows.length, 1); assert.equal(plus.windows[0].label, 'Weekly'); assert.equal(plus.windows[0].resetsAt, 1794908373000);
  const pro = parseRateLimits({ rateLimits: { primary: { usedPercent: 120, windowDurationMins: 10080 }, secondary: { usedPercent: 41, windowDurationMins: 300 } } });
  assert.deepEqual(pro.windows.map((w) => [w.label, w.pct]), [['5-hour', 41], ['Weekly', 100]]);
  assert.equal(parseRateLimits({}), null);
});

test('a Codex prompt with attachments shows what the person typed, not the file list', () => {
  const { requestOf } = require('../src/core/codex');
  assert.equal(requestOf('# Files mentioned by the user:\n\n## shark.png: /tmp/shark.png\n\n## My request:\nmake it fly'), 'make it fly');
  assert.equal(requestOf('plain prompt'), 'plain prompt');
});
