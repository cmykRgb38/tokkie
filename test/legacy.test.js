'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrate } = require('../src/core/legacy');

const hookSource = path.join(__dirname, '..', 'scripts', 'statusline-hook.js');

test('an existing "Larrie" install migrates: hook command, backup, home folder, settings — and is idempotent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-legacy-')), appData = path.join(home, 'AppSupport'), userData = path.join(appData, 'Tokkie');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.mkdirSync(path.join(home, '.larrie'), { recursive: true }); fs.mkdirSync(path.join(appData, 'Larrie'), { recursive: true });
  fs.writeFileSync(path.join(home, '.larrie', 'larrie-statusline-hook.js'), '// old');
  fs.writeFileSync(path.join(home, '.larrie', 'statusline.json'), JSON.stringify({ previous: { command: 'echo mine' } }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: `"/usr/local/bin/node" "${home}/.larrie/larrie-statusline-hook.js"` } }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json.larrie-backup'), '{}');
  fs.writeFileSync(path.join(appData, 'Larrie', 'settings.json'), JSON.stringify({ monsters: { active: 'rabc', saved: [] } }));
  const env = { CLAUDE_CONFIG_DIR: path.join(home, '.claude') };

  const done = migrate({ appData, userData, home, env, hookSource });
  assert.deepEqual(done.sort(), ['home', 'statusline', 'userData']);
  const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.theme, 'dark'); assert.equal(s.statusLine.command, `"/usr/local/bin/node" "${home}/.tokkie/tokkie-statusline-hook.js"`);
  assert.ok(fs.existsSync(path.join(home, '.tokkie', 'tokkie-statusline-hook.js')), 'hook script is where the command points');
  assert.ok(!fs.existsSync(path.join(home, '.tokkie', 'larrie-statusline-hook.js')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.tokkie', 'statusline.json'), 'utf8')).previous.command, 'echo mine', 'chained status line preserved');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json.tokkie-backup')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).monsters.active, 'rabc');
  assert.deepEqual(migrate({ appData, userData, home, env, hookSource }), [], 'second run is a no-op');
});
test('an install already renamed to "Munch" migrates to Tokkie too', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-legacy-')), appData = path.join(home, 'AppSupport'), userData = path.join(appData, 'Tokkie');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.mkdirSync(path.join(home, '.munch'), { recursive: true }); fs.mkdirSync(path.join(appData, 'Munch'), { recursive: true });
  fs.writeFileSync(path.join(home, '.munch', 'munch-statusline-hook.js'), '// old');
  fs.writeFileSync(path.join(home, '.munch', 'statusline.json'), JSON.stringify({ previous: { command: 'echo mine' } }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `"/n" "${home}/.munch/munch-statusline-hook.js"` } }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json.munch-backup'), '{}');
  fs.writeFileSync(path.join(appData, 'Munch', 'settings.json'), JSON.stringify({ monsters: { active: 'rxyz', saved: ['a'] } }));
  const env = { CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  assert.deepEqual(migrate({ appData, userData, home, env, hookSource }).sort(), ['home', 'statusline', 'userData']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).statusLine.command, `"/n" "${home}/.tokkie/tokkie-statusline-hook.js"`);
  assert.ok(fs.existsSync(path.join(home, '.tokkie', 'tokkie-statusline-hook.js'))); assert.ok(!fs.existsSync(path.join(home, '.tokkie', 'munch-statusline-hook.js')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.tokkie', 'statusline.json'), 'utf8')).previous.command, 'echo mine');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json.tokkie-backup')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).monsters.active, 'rxyz');
});

test('migration on a fresh machine does nothing and never throws', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-legacy-'));
  assert.deepEqual(migrate({ appData: path.join(home, 'x'), userData: path.join(home, 'y'), home, env: {}, hookSource }), []);
  assert.deepEqual(migrate({ home: '/nonexistent-dir-xyz', env: {} }), []);
});
