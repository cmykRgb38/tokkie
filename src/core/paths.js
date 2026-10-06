'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** Directories that may hold the Claude desktop app's data (Cowork lives here). */
function desktopAppDirs(env = process.env, platform = process.platform, home = os.homedir()) {
  const out = [];
  if (platform === 'darwin') out.push(path.join(home, 'Library', 'Application Support', 'Claude'));
  else if (platform === 'win32') {
    const appdata = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    out.push(path.join(appdata, 'Claude'));
    // Microsoft Store (MSIX) installs virtualise %APPDATA%.
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    try {
      for (const d of fs.readdirSync(path.join(local, 'Packages'))) {
        if (/^(Claude|AnthropicPBC\.Claude)/i.test(d)) out.push(path.join(local, 'Packages', d, 'LocalCache', 'Roaming', 'Claude'));
      }
    } catch { /* no Packages dir */ }
  } else out.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude'));
  return out;
}

/** Claude Code config dirs (~/.claude, $CLAUDE_CONFIG_DIR, XDG location). */
function claudeConfigDirs(env = process.env, home = os.homedir()) {
  const dirs = [];
  if (env.CLAUDE_CONFIG_DIR) dirs.push(...env.CLAUDE_CONFIG_DIR.split(path.delimiter).filter(Boolean));
  dirs.push(path.join(home, '.claude'), path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'claude'));
  return [...new Set(dirs)].filter(isDir);
}

const SKIP = new Set(['node_modules', '.git', 'outputs', 'uploads', 'mnt', 'rpm', 'Cache', 'Code Cache', 'GPUCache']);

/** Find every `.claude/projects` directory below `root` (bounded depth, skips heavy folders). */
function findProjectDirs(root, maxDepth = 7) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.name === 'projects' && path.basename(dir) === '.claude') found.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** Every transcript root we should watch. */
function transcriptRoots(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const roots = [];
  for (const d of claudeConfigDirs(env, home)) {
    const p = path.join(d, 'projects');
    if (isDir(p)) roots.push({ dir: p, source: 'code' });
  }
  for (const app of desktopAppDirs(env, opts.platform || process.platform, home)) {
    if (!isDir(app)) continue;
    for (const p of findProjectDirs(path.join(app, 'local-agent-mode-sessions'))) roots.push({ dir: p, source: 'cowork' });
  }
  return roots;
}

/** Recursively list *.jsonl transcripts below a projects dir (includes sub-agent logs). */
function listTranscripts(dir, maxDepth = 5) {
  const files = [];
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(dir, 0);
  return files;
}

/** Where Tokkie keeps files shared with the statusline hook (outside Electron so a plain node script can use it). */
function tokkieHome(env = process.env, home = os.homedir()) {
  return env.TOKKIE_HOME || path.join(home, '.tokkie');
}

module.exports = { desktopAppDirs, claudeConfigDirs, findProjectDirs, transcriptRoots, listTranscripts, tokkieHome };
