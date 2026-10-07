'use strict';
/**
 * One-click connection to Claude Code's statusline so Tokkie can read your real plan-limit %.
 * Safe by construction: backs up settings.json, preserves any existing status line (the hook chains to it),
 * refuses to touch a settings file it cannot parse, and is fully reversible.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { claudeConfigDirs, tokkieHome } = require('./paths');

const MARKER = 'tokkie-statusline';

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
function readJson(f) { const v = JSON.parse(fs.readFileSync(f, 'utf8')); if (!isPlainObject(v)) throw new SyntaxError('not a JSON object'); return v; }
const realTarget = (f) => { try { return fs.realpathSync(f); } catch { return f; } };   // write through symlinks (dotfile setups)
function writeJsonAtomic(file, obj) {
  const f = realTarget(file);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let mode; try { mode = fs.statSync(f).mode & 0o777; } catch { /* new file */ }
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', mode ? { mode } : undefined);
  try { fs.renameSync(tmp, f); } catch (e) {
    // Windows can refuse to rename over a file another process has open — fall back to an in-place write.
    try { fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n'); } finally { fs.rmSync(tmp, { force: true }); }
  }
}

function settingsPath(opts = {}) {
  const dirs = claudeConfigDirs(opts.env, opts.home);
  const dir = dirs[0] || path.join(opts.home || require('os').homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

/**
 * Absolute path of the user's node, or null. Apps launched from Finder/Start have a minimal PATH, and Claude Code runs the
 * status line in the user's shell — so ask a login shell, and store the absolute path rather than relying on PATH.
 */
function findNode() {
  try {
    const win = process.platform === 'win32';
    const r = win ? spawnSync('where', ['node'], { encoding: 'utf8', timeout: 4000 })
      : spawnSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'command -v node'], { encoding: 'utf8', timeout: 5000 });
    const line = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && fs.existsSync(l))[0];
    return line || null;
  } catch { return null; }
}

/** Command Claude Code should run. Prefers system node; falls back to the app binary itself. */
function hookCommand({ hookFile, execPath, nodePath = findNode() }) {
  const q = (s) => `"${s}"`;
  return nodePath ? `${q(nodePath)} ${q(hookFile)}` : `${q(execPath)} --${MARKER}`;
}

function status(opts = {}) {
  const file = settingsPath(opts);
  let s;
  try { s = readJson(file); } catch (e) { return { file, installed: false, readable: e.code === 'ENOENT', error: e.code === 'ENOENT' ? null : 'unparseable' }; }
  const cmd = isPlainObject(s.statusLine) ? s.statusLine.command : undefined;
  return { file, readable: true, installed: typeof cmd === 'string' && cmd.includes(MARKER), existing: cmd && !cmd.includes(MARKER) ? cmd : null };
}

function install({ hookSource, execPath, opts = {}, nodePath }) {
  try { return installUnsafe({ hookSource, execPath, opts, nodePath }); } catch (e) { return { ok: false, error: `Couldn't update Claude Code's settings (${e.code || e.message}). Nothing was changed.` }; }
}

function installUnsafe({ hookSource, execPath, opts, nodePath }) {
  const file = settingsPath(opts);
  const home = tokkieHome(opts.env, opts.home);
  let s = {};
  if (fs.existsSync(file)) {
    try { s = readJson(file); } catch { return { ok: false, error: `Couldn't parse ${file}. Fix its JSON, then try again — I won't overwrite it.` }; }
    const bak = file + '.tokkie-backup';
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  }
  fs.mkdirSync(home, { recursive: true });
  const hookFile = path.join(home, `${MARKER}-hook.js`);
  fs.copyFileSync(hookSource, hookFile);

  const cur = isPlainObject(s.statusLine) ? s.statusLine : null;
  if (cur && cur.command && !String(cur.command).includes(MARKER)) {
    writeJsonAtomic(path.join(home, 'statusline.json'), { previous: cur });
  }
  s.statusLine = { type: 'command', command: hookCommand({ hookFile, execPath, nodePath }) };
  writeJsonAtomic(file, s);
  return { ok: true, file, preserved: !!(cur && cur.command && !String(cur.command).includes(MARKER)) };
}

function uninstall({ opts = {} } = {}) {
  try { return uninstallUnsafe({ opts }); } catch (e) { return { ok: false, error: `Couldn't restore Claude Code's settings (${e.code || e.message}).` }; }
}

function uninstallUnsafe({ opts }) {
  const file = settingsPath(opts);
  const home = tokkieHome(opts.env, opts.home);
  let s;
  try { s = readJson(file); } catch { return { ok: true, file }; }
  if (!(s.statusLine && String(s.statusLine.command).includes(MARKER))) return { ok: true, file };
  let prev = null;
  try { prev = readJson(path.join(home, 'statusline.json')).previous; } catch { /* none */ }
  if (prev) s.statusLine = prev; else delete s.statusLine;
  writeJsonAtomic(file, s);
  return { ok: true, file, restored: !!prev };
}

/** Keep the copied hook current after app updates. Cheap; safe to call on every start. */
function refreshHook({ hookSource, opts = {} }) {
  try {
    const dst = path.join(tokkieHome(opts.env, opts.home), `${MARKER}-hook.js`);
    if (fs.existsSync(dst) && fs.readFileSync(dst, 'utf8') !== fs.readFileSync(hookSource, 'utf8')) fs.copyFileSync(hookSource, dst);
  } catch { /* best effort */ }
}

module.exports = { MARKER, settingsPath, status, install, uninstall, hookCommand, refreshHook, findNode };

// ---------------------------------------------------------------------------------------- the Claude Code bridge
/*
 * The bridge is a tiny read-only Claude Code plugin (bridge/ in this repo) that writes the session's exact cost, context
 * and plan limits to ~/.tokkie. Claude Code loads plugins from the folders listed in CLAUDE_CODE_PLUGIN_DIRS, which we add
 * to the `env` block of its settings.json — one entry, backed up first, removed again on Disconnect.
 */
const BRIDGE_DIR = 'claude-bridge';
const ENV_KEY = 'CLAUDE_CODE_PLUGIN_DIRS';
const bridgeTarget = (opts = {}) => path.join(tokkieHome(opts.env, opts.home), BRIDGE_DIR);
const splitDirs = (v) => String(v || '').split(path.delimiter).map((x) => x.trim()).filter(Boolean);

/** Copy a folder file by file (works out of the packaged app's asar archive too). Skips tests. */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === 'tests' || ent.name === 'node_modules') continue;
    const a = path.join(src, ent.name), b = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(a, b);
    else { const data = fs.readFileSync(a); let same = false; try { same = fs.readFileSync(b).equals(data); } catch { /* new */ } if (!same) fs.writeFileSync(b, data); }
  }
}

function bridgeStatus(opts = {}) {
  const file = settingsPath(opts), dir = bridgeTarget(opts);
  let s;
  try { s = readJson(file); } catch (e) { return { file, installed: false, error: e.code === 'ENOENT' ? null : 'unparseable' }; }
  const dirs = splitDirs(isPlainObject(s.env) ? s.env[ENV_KEY] : '');
  return { file, installed: dirs.includes(dir) && fs.existsSync(path.join(dir, 'hooks', 'register.ts')) };
}

function installBridge({ bridgeSource, opts = {} }) {
  try {
    const file = settingsPath(opts), dir = bridgeTarget(opts);
    let s = {};
    if (fs.existsSync(file)) {
      try { s = readJson(file); } catch { return { ok: false, error: `Couldn't parse ${file}. Fix its JSON, then try again — I won't overwrite it.` }; }
      const bak = file + '.tokkie-backup';
      if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    }
    copyTree(bridgeSource, dir);
    // The old status-line connection never runs in the desktop app; the bridge replaces it, so put the user's own status line back.
    if (isPlainObject(s.statusLine) && String(s.statusLine.command).includes(MARKER)) {
      let prev = null;
      try { prev = readJson(path.join(tokkieHome(opts.env, opts.home), 'statusline.json')).previous; } catch { /* none */ }
      if (prev) s.statusLine = prev; else delete s.statusLine;
    }
    const env = isPlainObject(s.env) ? s.env : {};
    const dirs = splitDirs(env[ENV_KEY]);
    if (!dirs.includes(dir)) dirs.push(dir);
    s.env = { ...env, [ENV_KEY]: dirs.join(path.delimiter) };
    writeJsonAtomic(file, s);
    return { ok: true, file };
  } catch (e) { return { ok: false, error: `Couldn't update Claude Code's settings (${e.code || e.message}). Nothing was changed.` }; }
}

function uninstallBridge({ opts = {} } = {}) {
  try {
    const file = settingsPath(opts), dir = bridgeTarget(opts);
    let s;
    try { s = readJson(file); } catch { return { ok: true, file }; }
    if (isPlainObject(s.env) && ENV_KEY in s.env) {
      const dirs = splitDirs(s.env[ENV_KEY]).filter((d) => d !== dir);
      if (dirs.length) s.env[ENV_KEY] = dirs.join(path.delimiter); else delete s.env[ENV_KEY];
      if (!Object.keys(s.env).length) delete s.env;
      writeJsonAtomic(file, s);
    }
    return { ok: true, file };
  } catch (e) { return { ok: false, error: `Couldn't restore Claude Code's settings (${e.code || e.message}).` }; }
}

/** After an app update, keep the installed bridge's files current (only when it is installed). */
function refreshBridge({ bridgeSource, opts = {} }) {
  try { if (bridgeStatus(opts).installed) copyTree(bridgeSource, bridgeTarget(opts)); } catch { /* best effort */ }
}

module.exports.bridgeStatus = bridgeStatus;
module.exports.installBridge = installBridge;
module.exports.uninstallBridge = uninstallBridge;
module.exports.refreshBridge = refreshBridge;
module.exports.bridgeTarget = bridgeTarget;
