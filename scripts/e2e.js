// `npm run e2e` — launches the real app against an isolated, pre-onboarded profile and runs src/main/e2e.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkie-e2e-'));
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, finishBy: '18:30' }));
const electron = require('electron');
const r = spawnSync(electron, ['.'], { cwd: path.join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, TOKKIE_USERDATA: profile, TOKKIE_HOME: path.join(profile, 'home'), TOKKIE_E2E: '1' } });
fs.rmSync(profile, { recursive: true, force: true });
process.exit(r.status ?? 1);
