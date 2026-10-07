'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { optimize, parseReply, sweep } = require('../src/core/optimizer');

test('parses the reply even with a code fence or stray text', () => {
  const r = parseReply('Sure!\n```json\n{"optimized":"Fix the login bug in auth.ts","changes":["Named the file"],"questions":["none"]}\n```');
  assert.equal(r.optimized, 'Fix the login bug in auth.ts'); assert.deepEqual(r.changes, ['Named the file']); assert.deepEqual(r.questions, []);
  assert.equal(parseReply('no json here'), null); assert.equal(parseReply('{"optimized":""}'), null);
});

test('round trip through the request/response files, cleaned up afterwards', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-opt-'));
  // a stand-in for the bridge: claim, then answer
  const fake = setInterval(() => {
    let names = []; try { names = fs.readdirSync(path.join(home, 'requests')); } catch { return; }
    for (const n of names) {
      const req = JSON.parse(fs.readFileSync(path.join(home, 'requests', n), 'utf8'));
      fs.writeFileSync(path.join(home, 'claims', n), 'me');
      fs.writeFileSync(path.join(home, 'responses', n), JSON.stringify({ text: JSON.stringify({ optimized: req.prompt.toUpperCase(), changes: ['Louder'] }), model: req.model }));
    }
  }, 50);
  const r = await optimize(home, 'make it better', 'sonnet');
  clearInterval(fake);
  assert.equal(r.ok, true); assert.equal(r.optimized, 'MAKE IT BETTER'); assert.equal(r.model, 'sonnet');
  for (const d of ['requests', 'claims', 'responses']) assert.deepEqual(fs.readdirSync(path.join(home, d)), []);
  sweep(home);
});

test('says so plainly when no Claude Code session picks it up', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-opt-'));
  const r = await optimize(home, 'hello', 'haiku', { claimMs: 300 });
  assert.equal(r.ok, false); assert.match(r.error, /Claude Code/);
  assert.deepEqual(fs.readdirSync(path.join(home, 'requests')), []);
});
