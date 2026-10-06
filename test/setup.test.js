'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const setup = require('../src/core/setup');

function env() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-home-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const opts = { env: { TOKKIE_HOME: path.join(home, '.tokkie'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, home };
  return { home, opts, file: path.join(home, '.claude', 'settings.json') };
}
const hookSource = path.join(__dirname, '..', 'scripts', 'statusline-hook.js');

test('install preserves unrelated settings, backs up, and is reversible', () => {
  const { opts, file } = env();
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls)'] } }));
  const r = setup.install({ hookSource, execPath: '/x/Tokkie', opts, nodePath: "/usr/local/bin/node" });
  assert.equal(r.ok, true);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.theme, 'dark'); assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
  assert.match(s.statusLine.command, /tokkie-statusline/);
  assert.ok(fs.existsSync(file + '.tokkie-backup'));
  assert.equal(setup.status(opts).installed, true);
  setup.uninstall({ opts });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.statusLine, undefined); assert.equal(after.theme, 'dark');
});
test('an existing status line is preserved, chained, and restored on uninstall', () => {
  const { opts, file, home } = env();
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } }));
  const r = setup.install({ hookSource, execPath: '/x/Tokkie', opts, nodePath: "/usr/local/bin/node" });
  assert.equal(r.preserved, true);
  setup.install({ hookSource, execPath: '/x/Tokkie', opts, nodePath: "/usr/local/bin/node" }); // idempotent: must not chain to itself
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.tokkie', 'statusline.json'), 'utf8'));
  assert.equal(saved.previous.command, 'echo mine');
  setup.uninstall({ opts });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, 'echo mine');
});
test('refuses to overwrite a settings file it cannot parse', () => {
  const { opts, file } = env();
  fs.writeFileSync(file, '{ "oops": ');
  const r = setup.install({ hookSource, execPath: '/x/Tokkie', opts, nodePath: "/usr/local/bin/node" });
  assert.equal(r.ok, false); assert.equal(fs.readFileSync(file, 'utf8'), '{ "oops": ');
});
test('works when settings.json does not exist yet; falls back to app binary without node', () => {
  const { opts, file } = env();
  const r = setup.install({ hookSource, execPath: '/Apps/Tokkie', opts, nodePath: null });
  assert.equal(r.ok, true);
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, /"\/Apps\/Tokkie" --tokkie-statusline/);
});

test('the hook script writes limits, prints a summary, and chains to the previous status line', () => {
  const { spawnSync } = require('child_process');
  const { opts, home } = env();
  const lh = opts.env.TOKKIE_HOME; fs.mkdirSync(lh, { recursive: true });
  fs.writeFileSync(path.join(lh, 'statusline.json'), JSON.stringify({ previous: { command: 'echo CHAINED' } }));
  const payload = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1893456000 }, seven_day: { used_percentage: 41, resets_at: 1893999999 } } });
  const r = spawnSync(process.execPath, [hookSource], { input: payload, env: { ...process.env, TOKKIE_HOME: lh }, encoding: 'utf8' });
  assert.match(r.stdout, /CHAINED/);
  const j = JSON.parse(fs.readFileSync(path.join(lh, 'rate_limits.json'), 'utf8'));
  assert.equal(j.five_hour.used_percentage, 23.5); assert.equal(j.seven_day.resets_at, 1893999999); assert.ok(j.updated_at > 1e9);
  fs.rmSync(path.join(lh, 'statusline.json'));
  const r2 = spawnSync(process.execPath, [hookSource], { input: payload, env: { ...process.env, TOKKIE_HOME: lh }, encoding: 'utf8' });
  assert.equal(r2.stdout, '5h 24% · 7d 41%');
  const r3 = spawnSync(process.execPath, [hookSource], { input: 'not json', env: { ...process.env, TOKKIE_HOME: lh }, encoding: 'utf8' });
  assert.equal(r3.status, 0);
});
