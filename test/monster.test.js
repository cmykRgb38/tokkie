'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/monster');

function connected(frame) {
  const cells = new Set(frame.cells.map((c) => M.key(c.x, c.y)));
  const [first] = cells; const seen = new Set([first]); const q = [first];
  while (q.length) {
    const k = q.pop(); const x = k % 64, y = Math.floor(k / 64);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nk = M.key(x + dx, y + dy); if (cells.has(nk) && !seen.has(nk)) { seen.add(nk); q.push(nk); } }
  }
  return seen.size === cells.size;
}

test('same seed → identical monster; different seed → different', () => {
  assert.deepEqual(M.generate('abc'), M.generate('abc'));
  assert.notDeepEqual(M.generate('abc').palette, M.generate('abd').palette);
});
test('3000 seeds × every pose: in-bounds, single connected piece, left/right symmetric silhouette', () => {
  const poses = [{}, { eye: 'angry', mouth: 'grit' }, { eye: 'bored', mouth: 'flat', look: { x: -1, y: 0 } }, { eye: 'wide', mouth: 'o' }, { eye: 'love', mouth: 'tongue' }, { eye: 'wink', mouth: 'tongue', frame: 1 }, { frame: 1 }, { bob: 1 }, { bob: -1 }, { eye: 'closed', mouth: 'open' }, { mouth: 'chew', look: { x: 1, y: 1 } }, { mouth: 'sad', look: { x: -1, y: -1 } }, { mouth: 'o', eye: 'happy', frame: 1 }];
  for (let i = 0; i < 3000; i++) {
    const spec = M.generate('seed-' + i);
    for (const pose of poses) {
      const f = M.compose(spec, pose);
      for (const c of [...f.cells, ...f.outline]) assert.ok(c.x >= 0 && c.x < M.W && c.y >= 0 && c.y < M.H, `${spec.seed} oob ${c.x},${c.y}`);
      assert.ok(connected(f), `${spec.seed} ${JSON.stringify(pose)} disconnected`);
      assert.ok(f.cells.length > 35, 'too small');
    }
    // the *silhouette without eyes/mouth/highlights* is mirrored: check rows' extents of the body are symmetric
    const f = M.compose(spec, {});
    const ext = new Map();
    for (const c of f.cells) { const e = ext.get(c.y) || [99, -1]; ext.set(c.y, [Math.min(e[0], c.x), Math.max(e[1], c.x)]); }
    for (const [y, [lo, hi]] of ext) assert.equal(M.CX - lo, hi - M.CX, `${spec.seed} row ${y} asymmetric`);
  }
});
test('no overlap bugs: bottom of legs always on the ground row', () => {
  for (let i = 0; i < 500; i++) { const f = M.compose(M.generate('g' + i), {}); assert.equal(Math.max(...f.cells.map((c) => c.y)), M.GROUND); }
});
test('variety: 1000 seeds give ≥ 990 distinct looks', () => {
  const sigs = new Set();
  for (let i = 0; i < 1000; i++) { const s = M.generate('v' + i); sigs.add(JSON.stringify(M.compose(s, {}).cells) + s.palette.body); }
  assert.ok(sigs.size >= 990, String(sigs.size));
});
test('names are pronounceable-length and traits exist', () => {
  for (let i = 0; i < 200; i++) { const s = M.generate('n' + i); assert.match(s.name, /^[A-Z][a-z]{4,9}$/); assert.ok(s.traits.length >= 2); }
});

test('every eye style tracks the cursor: looking left vs right changes the picture', () => {
  const seen = new Set();
  for (let i = 0; i < 400 && seen.size < 6; i++) {
    const spec = M.generate('track-' + i);
    if (seen.has(spec.eyes)) continue;
    const left = JSON.stringify(M.compose(spec, { look: { x: -1, y: 0 } }).cells), right = JSON.stringify(M.compose(spec, { look: { x: 1, y: 0 } }).cells);
    assert.notEqual(left, right, `${spec.eyes} eyes ignore the cursor`);
    seen.add(spec.eyes);
  }
  assert.equal(seen.size, 6, 'covered all six eye styles');
});
test('expressions actually change the face (angry, bored, wide, love, closed all differ from neutral)', () => {
  for (let i = 0; i < 60; i++) {
    const spec = M.generate('emo-' + i), base = JSON.stringify(M.compose(spec, {}).cells);
    for (const eye of ['angry', 'bored', 'wide', 'love', 'closed']) assert.notEqual(JSON.stringify(M.compose(spec, { eye }).cells), base, `${spec.eyes}/${eye}`);
  }
});

test('pets made before 1.0.19 keep their names; new pets draw from a much bigger name pool', () => {
  const M = require('../src/core/monster');
  assert.equal(M.generate('you:chuabh').name, 'Chimble');                         // a real user's pet: unchanged
  const legacy = new Set(), fresh = new Set();
  for (let i = 0; i < 20000; i++) { legacy.add(M.generate('you:u' + i).name); fresh.add(M.generate(`you:u:${i.toString(16)}`).name); }
  assert.ok(legacy.size <= 391);
  assert.ok(fresh.size > 2000, String(fresh.size));
  // same username on two machines → different pets once each install has its own id
  const a = M.generate('you:admin:1a2b3c4d5e6f'), b = M.generate('you:admin:9f8e7d6c5b4a');
  assert.notDeepEqual([a.name, a.palette.body, a.shape, a.top, a.eyes], [b.name, b.palette.body, b.shape, b.top, b.eyes]);
});

test('secret codes unlock special pets (codes are stored only as hashes), and special pets draw cleanly at every stage', () => {
  const M = require('../src/core/monster'), S = require('../src/core/secrets');
  assert.equal(S.redeem(' Rain Bow '), 'rainbow'); assert.equal(S.redeem('gold'), 'golden'); assert.equal(S.redeem('nope'), null);
  assert.ok(!require('fs').readFileSync(require.resolve('../src/core/secrets'), 'utf8').includes("'unicorn'".replace('unicorn', 'uni' + 'corn') + ': '));
  for (const k of M.SPECIAL_KINDS) {
    const s = M.generate(`sp:${k}:x1`);
    assert.equal(s.special, k); assert.equal(M.speciesOf(s), `special:${k}`);
    for (const st of [1, 2, 3, 4]) { const f = M.compose(M.evolveSpec(s, st, st === 4 ? 2 : 0), {}); for (const c of [...f.cells, ...f.outline]) { assert.ok(c.x >= 0 && c.x < M.W && c.y >= 0 && c.y < M.H, `${k} stage ${st} in bounds`); } }
  }
  assert.equal(M.generate('sp:unicorn:x1').top, 'unicorn');
  assert.equal(M.evolveSpec(M.generate('sp:unicorn:x1'), 4).top, 'unicorn');
});

test('new pet names avoid rude words', () => {
  const M = require('../src/core/monster');
  for (let i = 0; i < 50000; i++) assert.ok(!/poo|ass|butt|fart|shit|dick/i.test(M.generate('n' + i.toString(36)).name));
});

test('no poop: warm pets are never shaded brown, hatchlings are round, pears never get a tuft', () => {
  const M = require('../src/core/monster');
  const hl = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [(h * 60 + 360) % 360, (mx + mn) / 2, d]; };
  for (let i = 0; i < 5000; i++) {
    const s = M.generate('you:u' + i);
    const [h, l, chroma] = hl(s.palette.shade);
    assert.ok(!(h >= 20 && h <= 50 && l < 0.42 && chroma < 0.6), `${s.seed} shade ${s.palette.shade} is brown`);
    assert.ok(!(s.shape === 'pear' && s.top === 'tuft'));
    assert.notEqual(M.evolveSpec(s, 1).top, 'tuft');
  }
});

test('animals: only newly made pets can be one, every kind draws on the canvas at every stage and mood', () => {
  const M = require('../src/core/monster');
  assert.equal(M.generate('you:chuabh').animal, undefined);                 // existing pets never turn into animals
  assert.equal(M.generate('you:alice:1a2b3c4d5e6f').animal, undefined);
  let animals = 0;
  for (let i = 0; i < 2000; i++) if (M.generate('m' + (36 ** 9 + i * 7919).toString(36)).animal) animals++;
  assert.ok(animals > 500 && animals < 900, String(animals));               // about a third of new pets
  for (const k of M.BEAST_KINDS) for (let i = 0; i < 10; i++) {
    const b = M.generate(`beast:${k}:${i}`); assert.equal(b.animal, k); assert.equal(M.speciesOf(b), `beast:${k}`);
    for (const st of [1, 2, 3, 4]) for (const fat of [0, 2]) for (const pose of [{}, { frame: 1, bob: -1, eye: 'happy', mouth: 'open' }, { eye: 'angry', mouth: 'grit', look: { x: -1, y: 1 } }, { eye: 'love', mouth: 'tongue' }]) {
      const f = M.compose(M.evolveSpec(b, st, fat), pose);
      for (const c of [...f.cells, ...f.outline]) assert.ok(c.x >= 0 && c.x < M.W && c.y >= 0 && c.y < M.H);
      const a = M.anchors(M.evolveSpec(b, st, fat));
      assert.ok(a.mouth.x < M.W && a.top >= -1);
    }
  }
});
