'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const setup = require('../src/core/setup');
const { SpendLedger, BUCKET_MS } = require('../src/core/spend');
const { BridgeReader } = require('../src/core/bridge');
const { paceOf, monthlyPeriod } = require('../src/core/pace');

const bridgeSource = path.join(__dirname, '..', 'bridge');
function env() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-bridge-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const opts = { env: { TOKKIE_HOME: path.join(home, '.tokkie'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, home };
  return { home, opts, file: path.join(home, '.claude', 'settings.json') };
}
const fakeSettings = (init = {}) => { const d = { spend: {}, ...init }; return { d, get: (k) => d[k], set: (p) => Object.assign(d, p) }; };

test('bridge install: copies the plugin, adds one plugin dir, keeps other settings, and restores the old status line', () => {
  const { opts, file } = env();
  const other = '/somewhere/else';
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', env: { FOO: '1', CLAUDE_CODE_PLUGIN_DIRS: other }, statusLine: { type: 'command', command: '"node" "/x/tokkie-statusline-hook.js"' } }));
  fs.mkdirSync(opts.env.TOKKIE_HOME, { recursive: true });
  fs.writeFileSync(path.join(opts.env.TOKKIE_HOME, 'statusline.json'), JSON.stringify({ previous: { type: 'command', command: 'mine.sh' } }));
  const r = setup.installBridge({ bridgeSource, opts });
  assert.equal(r.ok, true, r.error);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dir = setup.bridgeTarget(opts);
  assert.equal(s.theme, 'dark'); assert.equal(s.env.FOO, '1');
  assert.deepEqual(s.env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter), [other, dir]);
  assert.deepEqual(s.statusLine, { type: 'command', command: 'mine.sh' });
  for (const f of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.ok(!fs.existsSync(path.join(dir, 'tests')), 'tests are not shipped');
  assert.ok(fs.existsSync(file + '.tokkie-backup'));
  assert.equal(setup.bridgeStatus(opts).installed, true);
  // twice is harmless
  setup.installBridge({ bridgeSource, opts });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter).length, 2);
  // disconnect removes only our entry
  assert.equal(setup.uninstallBridge({ opts }).ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.env.CLAUDE_CODE_PLUGIN_DIRS, other); assert.equal(after.env.FOO, '1');
  assert.equal(setup.bridgeStatus(opts).installed, false);
});

test('bridge install on a fresh machine, and clean removal leaves no env block behind', () => {
  const { opts, file } = env();
  assert.equal(setup.installBridge({ bridgeSource, opts }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.CLAUDE_CODE_PLUGIN_DIRS, setup.bridgeTarget(opts));
  setup.uninstallBridge({ opts });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
});

test('bridge install refuses to touch settings it cannot parse', () => {
  const { opts, file } = env();
  fs.writeFileSync(file, '{ broken');
  const r = setup.installBridge({ bridgeSource, opts });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
});

test('spend ledger: first sight is a baseline, growth is counted, restarts count from zero', () => {
  let now = 1_000_000_000_000;
  const st = fakeSettings();
  const L = new SpendLedger(st, () => now);
  assert.equal(L.observe('code:a', 50, now), 0);           // already spent before we watched
  assert.equal(L.covers(now), true); assert.equal(L.covers(now - 1), false);
  now += 10 * 60e3; L.observe('code:a', 52.5, now);
  now += 10 * 60e3; L.observe('code:a', 1.25, now);         // count restarted
  assert.equal(L.since(0), 3.75);
  assert.equal(L.since(now - 5 * 60e3), 1.25);
  assert.deepEqual([...L.sessions()], ['a']);
  L.flush();
  const L2 = new SpendLedger(st, () => now);                 // survives a restart
  assert.equal(L2.since(0), 3.75);
  assert.ok(BUCKET_MS > 0);
});

test('bridge reader returns changed sessions and ignores junk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-br-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ sessionId: 'a', updatedAt: 5, costUsd: 1.5, turns: [{ at: 4, usd: 0.5 }, { bad: 1 }], context: { tokens: 1000, window: 200000, percent: 0.5 }, agentsRunning: 2 }));
  fs.writeFileSync(path.join(dir, 'b.json'), '{nope');
  const R = new BridgeReader(dir);
  const ch = R.poll(Date.now());
  assert.equal(ch.length, 1); assert.equal(ch[0].costUsd, 1.5); assert.equal(ch[0].turns.length, 1);
  assert.equal(R.poll(Date.now()).length, 0, 'unchanged files are not re-read');
  assert.equal(R.latest().agentsRunning, 2);
  assert.equal(new BridgeReader(path.join(dir, 'missing')).poll().length, 0);
});

test('pace: ahead of the clock, run-out projection, and monthly periods', () => {
  const H = 3600e3, now = Date.UTC(2026, 9, 7, 12);
  const p = paceOf({ id: 'five', pct: 80, resetsAt: now + 3 * H }, 1, now);     // 2h of 5h gone (40%), 80% used
  assert.equal(Math.round(p.elapsed), 40); assert.equal(Math.round(p.pace), 40); assert.equal(p.tone, 'alert');
  assert.ok(p.runOutAt > now && p.runOutAt < now + 3 * H);                         // runs out before the reset
  const calm = paceOf({ id: 'five', pct: 10, resetsAt: now + 3 * H }, 1, now);
  assert.equal(calm.tone, 'calm'); assert.equal(calm.runOutAt, null);
  const mp = monthlyPeriod(1, now);
  assert.equal(mp.start, Date.UTC(2026, 9, 1)); assert.equal(mp.end, Date.UTC(2026, 10, 1));
  const mp2 = monthlyPeriod(15, now);
  assert.equal(mp2.start, Date.UTC(2026, 8, 15)); assert.equal(mp2.end, Date.UTC(2026, 9, 15));
  assert.ok(paceOf({ id: 'extra', pct: 50 }, 1, now).pace > 0);                      // 50% used, ~20% of October gone
  assert.equal(paceOf({ id: 'seven', pct: 50 }, 1, now), null);                      // no reset time known → no pace
});
