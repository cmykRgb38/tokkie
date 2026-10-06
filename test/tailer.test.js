'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tailer } = require('../src/core/tailer');
const { Store } = require('../src/core/store');
const { findProjectDirs, transcriptRoots } = require('../src/core/paths');
const { A, U } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-'));
const T0 = Date.now() - 60e3;

test('initial scan + live append + partial line + truncation', async () => {
  const dir = tmp(); const proj = path.join(dir, 'projects', 'p1'); fs.mkdirSync(proj, { recursive: true });
  const f = path.join(proj, 's1.jsonl');
  fs.writeFileSync(f, [U(T0, 'hello'), A(T0 + 1000, 'a1', { o: 10 })].join('\n') + '\n');
  const store = new Store();
  const t = new Tailer({ roots: () => [{ dir: path.join(dir, 'projects'), source: 'code' }], onEvents: (evs) => evs.forEach((e) => store.ingest(e)), discoverMs: 0 });
  (await t.initialScan()).forEach((e) => store.ingest(e));
  assert.equal(store.msgs.size, 1);

  const line = A(T0 + 5000, 'a2', { o: 77, stop: 'end_turn' });
  fs.appendFileSync(f, line.slice(0, 40));            // half a line — must not be parsed or lost
  await t.poll(); assert.equal(store.msgs.size, 1);
  fs.appendFileSync(f, line.slice(40) + '\n');
  await t.poll(); assert.equal(store.msgs.size, 2);
  assert.equal(store.samples.length, 1);

  fs.appendFileSync(path.join(proj, 'new.jsonl'), A(T0 + 6000, 'a3', { s: 's2' }) + '\n'); // new file discovered
  await t.poll(); assert.equal(store.msgs.size, 3);

  fs.writeFileSync(f, A(T0 + 9000, 'a9', { o: 5 }) + '\n'); // truncated + rewritten
  await t.poll(); assert.equal(store.msgs.has('a9'), true);
  fs.rmSync(dir, { recursive: true });
});

test('multibyte characters split across read chunks survive', async () => {
  const dir = tmp(); const proj = path.join(dir, 'projects', 'p'); fs.mkdirSync(proj, { recursive: true });
  const f = path.join(proj, 's.jsonl');
  fs.writeFileSync(f, U(T0, '你好'.repeat(50)) + '\n');
  const store = new Store();
  const t = new Tailer({ roots: () => [{ dir: path.join(dir, 'projects'), source: 'code' }], onEvents: () => {} });
  const evs = await t.initialScan(); evs.forEach((e) => store.ingest(e));
  assert.equal(evs[0].chars, 100);
  fs.rmSync(dir, { recursive: true });
});

test('old files are followed from EOF, not replayed', async () => {
  const dir = tmp(); const proj = path.join(dir, 'projects', 'p'); fs.mkdirSync(proj, { recursive: true });
  const f = path.join(proj, 'old.jsonl'); fs.writeFileSync(f, A(T0, 'x') + '\n');
  const old = new Date(Date.now() - 20 * 86400e3); fs.utimesSync(f, old, old);
  const seen = [];
  const t = new Tailer({ roots: () => [{ dir: path.join(dir, 'projects'), source: 'code' }], onEvents: (e) => seen.push(...e) });
  assert.equal((await t.initialScan()).length, 0);
  fs.appendFileSync(f, A(T0 + 1, 'y') + '\n'); await t.poll(); assert.equal(seen.length, 1);
  fs.rmSync(dir, { recursive: true });
});

test('Cowork discovery finds .claude/projects and skips audit logs & heavy dirs', () => {
  const dir = tmp();
  const proj = path.join(dir, 'Claude', 'local-agent-mode-sessions', 'org', 'acct', 'sess', '.claude', 'projects', 'x');
  fs.mkdirSync(proj, { recursive: true }); fs.writeFileSync(path.join(proj, 'a.jsonl'), '');
  fs.mkdirSync(path.join(dir, 'Claude', 'local-agent-mode-sessions', 'org', 'acct', 'sess', 'outputs', '.claude', 'projects'), { recursive: true });
  const found = findProjectDirs(path.join(dir, 'Claude', 'local-agent-mode-sessions'));
  assert.equal(found.length, 1); assert.ok(found[0].endsWith(path.join('.claude', 'projects')));
  const roots = transcriptRoots({ env: { HOME: dir }, home: dir, platform: 'linux' });
  assert.ok(Array.isArray(roots));
  fs.rmSync(dir, { recursive: true });
});
