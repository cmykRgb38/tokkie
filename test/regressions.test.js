'use strict';
// Regression tests for defects found in independent code review.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { Settings } = require('../src/core/settings');
const { Store } = require('../src/core/store');
const { parseLine } = require('../src/core/parser');
const { compute } = require('../src/core/limits');
const setup = require('../src/core/setup');
const { A, U } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-reg-'));
const hookSource = path.join(__dirname, '..', 'scripts', 'statusline-hook.js');

test('settings round-trip: saved pet, collection, calibration and samples survive a restart', () => {
  const f = path.join(tmp(), 's.json');
  const a = new Settings(f);
  a.set({ monsters: { active: 'rabc123', saved: ['x', 'y'] }, calib: { five: { k: 123456 }, seven: { k: 9e6 } }, finishBy: '17:45', scale: 8,
    samples: [{ start: 1, duration: 30, chars: 100, tokens: 5 }] });
  a.save();
  const b = new Settings(f);
  assert.equal(b.get('monsters').active, 'rabc123'); assert.deepEqual(b.get('monsters').saved, ['x', 'y']);
  assert.equal(b.get('calib').five.k, 123456); assert.equal(b.get('calib').seven.k, 9e6);
  assert.equal(b.get('finishBy'), '17:45'); assert.equal(b.get('scale'), 8); assert.equal(b.get('samples').length, 1);
});
test('settings tolerate corrupt / hostile files', () => {
  const f = path.join(tmp(), 's.json');
  for (const body of ['{', 'null', '[]', '{"samples":{},"monsters":null,"calib":5,"window":"x"}', '{"samples":[null,1,{"start":"a"}],"monsters":{"saved":"nope"}}']) {
    fs.writeFileSync(f, body);
    const s = new Settings(f);
    assert.ok(Array.isArray(s.get('samples'))); assert.ok(Array.isArray(s.get('monsters').saved)); assert.equal(typeof s.get('monsters').active, 'string');
    assert.equal(s.get('samples').length, 0);
  }
});

test('turn-end fires beyond the sample cap and reports the turn that just finished', () => {
  const { MAX_SAMPLES } = require('../src/core/store');
  const T = Date.now() - 400 * 3600e3, s = new Store(); const got = [];
  for (let i = 0; i < MAX_SAMPLES + 10; i++) { // fill past the cap with historic turns
    const t = T + i * 1000 * 4; s.ingest(parseLine(U(t, 'hi', { s: 'old' }))); s.ingest(parseLine(A(t + 5000, 'm' + i, { s: 'old', stop: 'end_turn' })));
  }
  assert.equal(s.samples.length, MAX_SAMPLES);
  s.onSample = (x) => got.push(x);
  const t = Date.now() - 20000;
  s.ingest(parseLine(U(t, 'one', { s: 'S1' }))); s.ingest(parseLine(U(t + 100, 'two', { s: 'S2' })));
  s.ingest(parseLine(A(t + 9000, 'a1', { s: 'S1', stop: 'end_turn' }))); s.ingest(parseLine(A(t + 9500, 'a2', { s: 'S2', stop: 'end_turn' })));
  assert.equal(got.length, 2, 'both concurrent turns reported'); assert.deepEqual(got.map((g) => g.sessionId).sort(), ['S1', 'S2']);
  assert.equal(s.samples.length, MAX_SAMPLES);
});

test('slash-command wrapper lines do not start a phantom turn', () => {
  assert.equal(parseLine(U(Date.now(), '<command-name>/model</command-name>\n<command-message>model</command-message>')), null);
  assert.equal(parseLine(U(Date.now(), '<command-message>init is running…</command-message>')), null);
});

test('limits: per-window timestamps, and garbage values never produce NaN', () => {
  const NOW = Date.now(), s = new Store({ now: () => NOW });
  const L = { updated_at: NOW / 1000, five_hour: { used_percentage: 20, resets_at: NOW / 1000 + 7200 }, seven_day: { used_percentage: 'x', resets_at: 'abc' } };
  const r = compute(L, s, {}, NOW);
  assert.equal(r.connected, true); assert.equal(r.seven, null); assert.ok(Number.isFinite(r.five.pct));
  assert.equal(compute({ five_hour: { used_percentage: 5, resets_at: NaN } }, s, {}, NOW).connected, false);
  assert.equal(compute({ five_hour: { used_percentage: 5, resets_at: NOW / 1000 + 100 } }, s, {}, NOW).connected, false, 'no timestamp → unusable, not NaN');
  // a stale seven_day must keep ITS OWN timestamp when only five_hour refreshes
  const old = NOW / 1000 - 3600;
  const r2 = compute({ updated_at: NOW / 1000, five_hour: { used_percentage: 5, resets_at: NOW / 1000 + 100, updated_at: NOW / 1000 }, seven_day: { used_percentage: 50, resets_at: NOW / 1000 + 9999, updated_at: old } }, s, {}, NOW);
  assert.equal(Math.round((NOW - r2.seven.stale * 0) ), NOW); assert.equal(r2.seven.stale, true);
});

test('hook: many concurrent sessions never corrupt the limits file or blank the status line', async () => {
  const lh = tmp();
  const payload = (p) => JSON.stringify({ rate_limits: { five_hour: { used_percentage: p, resets_at: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { used_percentage: p / 2, resets_at: Math.floor(Date.now() / 1000) + 86400 } } });
  const runs = Array.from({ length: 12 }, (_, i) => new Promise((res) => {
    const c = spawn(process.execPath, [hookSource], { env: { ...process.env, TOKKIE_HOME: lh } }); let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.on('close', () => res(out)); c.stdin.end(payload(10 + i));
  }));
  const outs = await Promise.all(runs);
  for (const o of outs) assert.match(o, /^5h \d+% · 7d \d+%$/, `blank/garbled status line: "${o}"`);
  const j = JSON.parse(fs.readFileSync(path.join(lh, 'rate_limits.json'), 'utf8'));
  assert.ok(j.five_hour.used_percentage >= 10 && j.five_hour.updated_at > 0);
  assert.deepEqual(fs.readdirSync(lh).filter((x) => x.endsWith('.tmp')), [], 'no temp files left behind');
});

test('setup: null/array settings.json is refused, symlinked settings are written through, failures return {ok:false}', () => {
  const home = tmp(); fs.mkdirSync(path.join(home, '.claude'));
  const opts = { env: { TOKKIE_HOME: path.join(home, '.tokkie'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, home };
  const file = path.join(home, '.claude', 'settings.json');
  for (const body of ['null', '[]', '"str"']) {
    fs.writeFileSync(file, body);
    assert.equal(setup.install({ hookSource, execPath: '/x', opts, nodePath: '/n' }).ok, false); assert.equal(fs.readFileSync(file, 'utf8'), body);
    assert.equal(setup.status(opts).installed, false);
  }
  // symlink (dotfiles): the real file must be updated and the link preserved
  const real = path.join(home, 'dotfiles-settings.json'); fs.writeFileSync(real, JSON.stringify({ theme: 'dark' })); fs.rmSync(file); fs.symlinkSync(real, file);
  assert.equal(setup.install({ hookSource, execPath: '/x', opts, nodePath: '/n' }).ok, true);
  assert.ok(fs.lstatSync(file).isSymbolicLink()); assert.match(fs.readFileSync(real, 'utf8'), /tokkie-statusline/);
  setup.uninstall({ opts }); assert.doesNotMatch(fs.readFileSync(real, 'utf8'), /tokkie-statusline/);
  // unwritable target → clean error, no throw
  const ro = path.join(tmp(), 'ro'); fs.mkdirSync(ro); fs.chmodSync(ro, 0o500);
  const r = setup.install({ hookSource, execPath: '/x', opts: { env: { TOKKIE_HOME: path.join(ro, 'lh'), CLAUDE_CONFIG_DIR: ro }, home }, nodePath: '/n' });
  fs.chmodSync(ro, 0o700);
  if (process.getuid && process.getuid() !== 0) assert.equal(r.ok, false);
});

test('hook command quoting survives spaces and is absolute', () => {
  const c = setup.hookCommand({ hookFile: 'C:\\Users\\A B\\.tokkie\\tokkie-statusline-hook.js', execPath: 'C:\\Apps\\Tokkie.exe', nodePath: 'C:\\Program Files\\nodejs\\node.exe' });
  assert.equal(c, '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\A B\\.tokkie\\tokkie-statusline-hook.js"');
});
