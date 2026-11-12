'use strict';
/**
 * Tokkie's promises, checked on every test run so a future change can't quietly break them:
 *   1. it never talks to the internet (no network code at all; links only open in your browser when you click them),
 *   2. it never reads a login, token, cookie or keychain (Claude's, Codex's or your browser's),
 *   3. the only programs it starts are the ones listed here, for the reasons given.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function files(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, ...dir.split('/')), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;   // always '/', so names match the lists below on Windows too
    if (e.isDirectory()) { if (!['node_modules', 'tests', 'dev'].includes(e.name)) files(rel, out); }
    else if (/\.(js|mjs|cjs|ts|tsx|html)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const SHIPPED = [...files('src'), ...files('bridge'), 'scripts/statusline-hook.js'].filter((f) => !f.endsWith('/e2e.js'));   // e2e.js only runs under the test harness
const UPDATES = 'src/core/updates.js';
const read = (f) => fs.readFileSync(path.join(ROOT, ...f.split('/')), 'utf8').replace(/\r\n/g, '\n');   // Windows checkouts may use CRLF

test('no network code ships: nothing can send your data anywhere', () => {
  const NET = [
    /require\(\s*['"](?:node:)?(?:https?|http2|net|tls|dgram|dns|undici)['"]\s*\)/, /from\s+['"](?:node:)?(?:https?|http2|net|tls|dgram|dns|undici)['"]/,
    /\bfetch\s*\(/, /XMLHttpRequest/, /new\s+WebSocket/, /EventSource/, /sendBeacon/, /\bnet\.request\b/, /electron['"]\)\.net\b/, /\{[^}]*\bnet\b[^}]*\}\s*=\s*require\(\s*['"]electron['"]/,
  ];
  const hits = [];
  for (const f of SHIPPED) { if (f === UPDATES) continue; const s = read(f); for (const re of NET) if (re.test(s)) hits.push(`${f}: ${re}`); }
  assert.deepEqual(hits, []);
});

test('the one exception, the update check: off by default, GitHub only, and it sends nothing about you', () => {
  const s = read(UPDATES);
  const urls = [...s.matchAll(/https?:\/\/[^\s'"`]+/g)].map((m) => m[0]);
  for (const u of urls) assert.match(u, /^https:\/\/(api\.)?github\.com\/(repos\/)?\$\{REPO\}/, u);
  assert.equal((s.match(/\bget\(/g) || []).length, 1, 'exactly one request');
  assert.doesNotMatch(s, /method:\s*['"](POST|PUT|PATCH)/i);
  assert.doesNotMatch(s, /\bbody\s*:/);
  const call = /get\(LATEST_URL, \{ headers: \{ Accept: '[^']+', 'User-Agent': 'Tokkie-update-check' \} \}\)/;
  assert.match(s, call, 'a plain GET with a generic User-Agent');
  const { DEFAULTS } = require('../src/core/settings');
  assert.equal(DEFAULTS.checkUpdates, false, 'off until you turn it on');
  const main = read('src/main/main.js');
  assert.match(main, /async function checkUpdates\(force = false\) \{\n  if \(!settings\.get\('checkUpdates'\)/, 'never checks unless switched on');
  assert.equal((main.match(/checkForUpdate\(/g) || []).length, 1);
});

test('links open only in your browser, and only https or Claude’s own app', () => {
  const s = read('src/main/main.js');
  const opens = s.match(/shell\.openExternal\([^)]*\)/g) || [];
  assert.ok(opens.length > 0);
  for (const o of opens) assert.match(o, /openExternal\((url|`claude:\/\/resume\?session=\$\{id\}`|'claude:\/\/')\)/, o);
  for (const m of s.matchAll(/if \(\/\^https:[^)]*\)\.test\([^)]*\)\) shell\.openExternal\(url\)/g)) assert.ok(m);   // every plain URL is checked for https first
});

test('the pages cannot load or send anything from outside (CSP)', () => {
  for (const f of ['src/renderer/index.html', 'src/renderer/strip.html']) {
    const csp = (/Content-Security-Policy" content="([^"]+)"/.exec(read(f)) || [])[1] || '';
    assert.match(csp, /default-src 'self'/, f);
    assert.doesNotMatch(csp, /https?:|connect-src|\*/, f);
  }
});

test('no logins, tokens, cookies or keychains are read', () => {
  const SECRET = [
    /\.credentials\.json/, /auth\.json/, /\bkeychain\b/i, /find-(?:generic|internet)-password/, /\bkeytar\b/, /safeStorage/,
    /Cookies['"`/]/, /Login Data/, /oauth[_-]?token/i, /access[_-]?token/i, /refresh[_-]?token/i, /session[_-]?token/i, /CLAUDE_CODE_OAUTH/,
  ];
  const hits = [];
  for (const f of SHIPPED) { const s = read(f); for (const re of SECRET) if (re.test(s)) hits.push(`${f}: ${re}`); }
  assert.deepEqual(hits, []);
});

test('the only programs Tokkie starts are these', () => {
  const ALLOWED = {
    'src/core/codex.js': ["spawn(this.bin, ['app-server']"],                 // Codex's own app-server, to ask for your limits (it uses its own login)
    'src/core/setup.js': ["spawnSync('where', ['node']", "spawnSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'command -v node']"],   // finding node for the status line hook
    'scripts/statusline-hook.js': ['spawnSync(prev.command'],               // your previous status line, which the hook keeps running
  };
  for (const f of SHIPPED) {
    const s = read(f);
    const calls = s.match(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\((?!\))[^\n]{0,60}/g) || [];
    const real = calls.filter((c) => !/^exec\s*\(\s*(String|seed|hhmm|name|dayIn|input)/.test(c) && !/^exec\(/.test(c));   // RegExp.exec, not child_process
    for (const c of real) assert.ok((ALLOWED[f] || []).some((a) => c.startsWith(a)), `${f} starts an unlisted program: ${c}`);
    if (/require\(\s*['"](?:node:)?child_process['"]\s*\)/.test(s)) assert.ok(ALLOWED[f], `${f} uses child_process but is not on the list`);
  }
});

test('Codex limits are asked from Codex itself, read-only: no account, login or logout calls', () => {
  const s = read('src/core/codex.js');
  const methods = [...s.matchAll(/method:\s*'([^']+)'|_call\(\s*'([^']+)'|request\(\s*'([^']+)'/g)].map((m) => m[1] || m[2] || m[3]);
  assert.ok(methods.includes('account/rateLimits/read'), JSON.stringify(methods));
  for (const m of methods) assert.match(m, /^(initialize|initialized|account\/rateLimits\/read)$/, m);
});
