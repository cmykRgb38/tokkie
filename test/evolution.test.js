'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evolutionFor, THRESHOLDS } = require('../src/core/evolution');
const M = require('../src/core/monster');

test('forms unlock at the thresholds and never go backwards', () => {
  assert.equal(evolutionFor(0).stage, 1); assert.equal(evolutionFor(0).name, 'Hatchling');
  assert.equal(evolutionFor(THRESHOLDS[1] - 1).stage, 1); assert.equal(evolutionFor(THRESHOLDS[1]).stage, 2);
  assert.equal(evolutionFor(THRESHOLDS[2]).name, 'Champion'); assert.equal(evolutionFor(THRESHOLDS[3] + 1).name, 'Mega');
  let last = 0; for (let e = 0; e < 200e6; e += 250e3) { const s = evolutionFor(e).stage; assert.ok(s >= last); last = s; }
  assert.equal(evolutionFor(-5).stage, 1); assert.equal(evolutionFor(NaN).stage, 1);
});
test('chubbiness grows inside a form and progress points at the next form', () => {
  const lo = evolutionFor(THRESHOLDS[1] + 1), hi = evolutionFor(THRESHOLDS[2] - 1);
  assert.equal(lo.fat, 0); assert.equal(hi.fat, 2); assert.ok(hi.progress > 0.99 && hi.nextName === 'Champion');
  assert.equal(evolutionFor(100e6).nextName, null); assert.ok(evolutionFor(500e6).fat <= 2);
});

function connected(frame) {
  const cells = new Set(frame.cells.map((c) => M.key(c.x, c.y))); const [first] = cells; const seen = new Set([first]); const q = [first];
  while (q.length) { const k = q.pop(), x = k % 64, y = Math.floor(k / 64); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = M.key(x + dx, y + dy); if (cells.has(n) && !seen.has(n)) { seen.add(n); q.push(n); } } }
  return seen.size === cells.size;
}
test('every seed × stage × chub level draws a valid creature (in bounds, one piece, symmetric, grounded)', () => {
  const poses = [{}, { eye: 'angry', mouth: 'grit' }, { eye: 'wide', mouth: 'o', frame: 1 }, { eye: 'love', mouth: 'tongue', bob: 1 }];
  for (let i = 0; i < 400; i++) {
    const base = M.generate('evo-' + i);
    for (let stage = 1; stage <= 4; stage++) for (let fat = 0; fat <= 2; fat++) {
      const spec = M.evolveSpec(base, stage, fat);
      for (const pose of poses) {
        const f = M.compose(spec, pose);
        for (const c of [...f.cells, ...f.outline]) assert.ok(c.x >= 0 && c.x < M.W && c.y >= 0 && c.y < M.H, `${base.seed} s${stage} f${fat} oob ${c.x},${c.y}`);
        assert.ok(connected(f), `${base.seed} s${stage} f${fat} disconnected`);
      }
      const f = M.compose(spec, {}), ext = new Map();
      for (const c of f.cells) { const e = ext.get(c.y) || [99, -1]; ext.set(c.y, [Math.min(e[0], c.x), Math.max(e[1], c.x)]); }
      for (const [y, [lo, hi]] of ext) assert.equal(M.CX - lo, hi - M.CX, `${base.seed} s${stage} f${fat} row ${y} asymmetric`);
      assert.equal(Math.max(...f.cells.map((c) => c.y)), M.GROUND);
    }
  }
});
test('forms are visibly different and grow in size; the middle form is the original creature', () => {
  for (let i = 0; i < 50; i++) {
    const base = M.generate('size-' + i), area = (s) => M.compose(s, {}).cells.length;
    assert.equal(M.evolveSpec(base, 2, 0), base);
    assert.ok(area(M.evolveSpec(base, 1)) < area(base), 'hatchling is smaller');
    assert.ok(area(M.evolveSpec(base, 3)) > area(base), 'champion is bigger');
    assert.ok(area(M.evolveSpec(base, 4)) > area(M.evolveSpec(base, 3)), 'mega is biggest');
    assert.ok(area(M.evolveSpec(base, 2, 2)) > area(base), 'chubby is wider');
  }
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/core/engine');
const { Settings } = require('../src/core/settings');
const { parseLine } = require('../src/core/parser');
const { A } = require('./helpers');

test('the pet only eats tokens used after Tokkie started feeding, and keeps what it ate when old messages are forgotten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-evo-'));
  let now = Date.now();
  const settings = new Settings(path.join(dir, 's.json'));
  const eng = new Engine({ settings, env: { TOKKIE_HOME: path.join(dir, 'h') }, home: dir, now: () => now, roots: () => [] });
  eng.store.ingest(parseLine(A(now - 3600e3, 'before', { i: 0, o: 1000, cw: 0, cr: 0 })));      // used BEFORE the pet existed
  await eng.start();
  const start = settings.get('evolution').start; assert.ok(start >= now);
  assert.equal(eng.eaten(), 0, 'history is not food');
  now += 60e3; eng.store.ingest(parseLine(A(now, 'm1', { i: 10, o: 500, cw: 90, cr: 99999 })));    // cache reads are not food
  assert.equal(eng.eaten(), 600);
  eng.store.ingest(parseLine(A(now + 1, 'm1', { i: 10, o: 700, cw: 90, cr: 0 })));                   // streaming rewrite: counted once, latest wins
  assert.equal(eng.eaten(), 800);
  now += 9 * 86400e3; eng.store.prune();                                                             // message ages out of memory…
  assert.equal(eng.store.msgs.has('m1'), false); assert.equal(eng.eaten(), 800, '…but the pet remembers what it ate');
  assert.equal(JSON.parse(JSON.stringify(settings.get('evolution'))).archived, 800);
  const snap = eng.snapshot(now); assert.equal(snap.evolution.stage, 1); assert.equal(snap.evolution.name, 'Hatchling');
  eng.stop(); fs.rmSync(dir, { recursive: true });
});
