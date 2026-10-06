// npm 11+ may skip Electron's postinstall download. Make `npm start` self-healing.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let dir;
try { dir = path.dirname(require.resolve('electron/package.json')); }
catch { console.error('Electron is not installed. Run `npm install` first.'); process.exit(1); }

if (!fs.existsSync(path.join(dir, 'path.txt'))) {
  console.log('Downloading the Electron runtime (one-time, ~100 MB)…');
  const r = spawnSync(process.execPath, [path.join(dir, 'install.js')], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('Electron download failed. Check your connection and run `npm start` again.'); process.exit(r.status || 1); }
}
