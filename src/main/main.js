'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, clipboard, ipcMain, screen, Notification, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Statusline hook mode: Claude Code runs `Tokkie --tokkie-statusline` when Node isn't installed.
if (process.argv.includes('--tokkie-statusline')) {
  if (process.platform === 'darwin') app.dock?.hide();
  require(path.join(__dirname, '..', '..', 'scripts', 'statusline-hook.js'));
  process.stdin.on('end', () => setTimeout(() => app.exit(0), 80));
  return;
}

const { Settings } = require('../core/settings');
const { Engine } = require('../core/engine');
const setup = require('../core/setup');
const legacy = require('../core/legacy');
const { transcriptRoots } = require('../core/paths');
const Monster = require('../core/monster');
const { trayBitmap } = require('./tray-icon');

app.setName('Tokkie');
app.setAppUserModelId?.('com.tokkie.pet'); // Windows: needed for notifications + taskbar identity
if (process.env.TOKKIE_USERDATA) app.setPath('userData', process.env.TOKKIE_USERDATA); // QA: isolated profile
// The first scan reads up to ~8 days of logs; collect the garbage straight afterwards so the idle footprint stays small.
let collect = () => {};
try { require('v8').setFlagsFromString('--expose-gc'); const g = require('vm').runInNewContext('gc'); collect = () => { g(); g(); }; } catch { /* optional */ }
const isMac = process.platform === 'darwin';
const SIGNATURE = `you:${os.userInfo().username}`;
const STATE_MS = 1000;

let win = null, tray = null, settings = null, engine = null;
let petRect = { x: 0, y: 0, w: 0, h: 0 };       // renderer-reported pet position inside the window
let layoutCache = null, placement = 'below';
let lastClipboard = '', lastCursor = { x: -1, y: -1 };

process.on('uncaughtException', (e) => console.error('uncaught', e));
process.on('unhandledRejection', (e) => console.error('unhandled', e));

// ---------------------------------------------------------------------------------------- helpers
const publicSettings = () => {
  const d = { ...settings.data };
  delete d.samples; delete d.calib;
  return d;
};

let hookCache = { at: 0, v: { installed: false } };
const hookStatus = () => { if (Date.now() - hookCache.at > 3000) hookCache = { at: Date.now(), v: { installed: !!setup.status().installed } }; return hookCache.v; };

function snapshot() {
  const s = engine.snapshot();
  return { ...s, hook: hookStatus(), hotkey: { accelerator: settings.get('hotkey'), ok: hotkeyOk, firedAt: hotkeyFiredAt }, settings: publicSettings(), signature: SIGNATURE, platform: process.platform, version: app.getVersion(), packaged: app.isPackaged };
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function clampToWork(b) {
  const disp = screen.getDisplayMatching(b);
  const wa = disp.workArea;
  return { ...b, x: Math.max(wa.x, Math.min(b.x, wa.x + wa.width - b.width)), y: Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height)) };
}

function showWindow(tab) {
  if (!win) return;
  if (!win.isVisible()) { win.showInactive(); refreshTray(); }
  if (tab) { win.focus(); send('command', { type: 'open', tab }); }
}

// ---------------------------------------------------------------------------------------- window
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const saved = settings.get('window');
  const w = 240, h = 170;
  const x = saved.x != null ? saved.x : wa.x + wa.width - w - 24;
  const y = saved.y != null ? saved.y : wa.y + wa.height - h - 24;
  win = new BrowserWindow({
    x, y, width: w, height: h, frame: false, transparent: true, hasShadow: false, resizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: settings.get('alwaysOnTop'), show: false, backgroundColor: '#00000000', title: 'Tokkie',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  if (isMac) { win.setAlwaysOnTop(!!settings.get('alwaysOnTop'), 'floating'); win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); }
  else win.setAlwaysOnTop(!!settings.get('alwaysOnTop'), 'screen-saver');
  // Never leave the user with an invisible app: reveal even if the renderer fails to boot.
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive(); }, 5000);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // The window is revealed after the renderer's first layout so it never flashes at the wrong size/position.
  if (process.env.TOKKIE_E2E) require('./e2e').attach(win, { screen, getPetRect: () => petRect, settings, fireHotkey: () => estimateClipboard(), clipboard });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });
}

// Dev/QA aid: TOKKIE_SHOT=/tmp/x.png [TOKKIE_TAB=plan] [TOKKIE_SHOT_DELAY=1500] → capture the window and quit.
function maybeScreenshot() {
  const out = process.env.TOKKIE_SHOT;
  if (!out) return;
  const tab = process.env.TOKKIE_TAB;
  setTimeout(() => { if (tab) send('command', { type: 'open', tab }); }, 1500);
  if (process.env.TOKKIE_EST) setTimeout(() => { const t = process.env.TOKKIE_EST; send('estimate', { source: 'hotkey', text: t, result: engine.estimate(t) }); }, 2000);
  setTimeout(async () => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    const b = win.getBounds();
    console.log('SHOT', out, JSON.stringify(b));
    app.quit();
  }, Number(process.env.TOKKIE_SHOT_DELAY || 2200));
}

// ---------------------------------------------------------------------------------------- tray
function refreshTray() {
  const spec = Monster.generate(settings.get('monsters').active || SIGNATURE);
  const { buffer, width, height } = trayBitmap(spec);
  const img = nativeImage.createFromBitmap(buffer, { width, height, scaleFactor: 2 });
  if (!tray) tray = new Tray(img); else tray.setImage(img);
  tray.setToolTip('Tokkie');
  const mod = isMac ? '⌘' : 'Ctrl';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Hide Tokkie' : 'Show Tokkie', click: () => { if (win.isVisible()) win.hide(); else showWindow(); refreshTray(); } },
    { label: 'Open panel', click: () => showWindow('usage') },
    { label: `Estimate copied prompt  (${settings.get('hotkey').replace('CommandOrControl', mod)})`, click: estimateClipboard },
    { type: 'separator' },
    { label: 'Quit Tokkie', click: () => app.quit() },
  ]));
}

// ---------------------------------------------------------------------------------------- hotkey / clipboard
let hotkeyOk = false, hotkeyFiredAt = 0;
function registerHotkey(acc) {
  globalShortcut.unregisterAll();
  try { hotkeyOk = !!globalShortcut.register(acc, estimateClipboard) && globalShortcut.isRegistered(acc); } catch { hotkeyOk = false; }
  return hotkeyOk;
}
/** Electron ≥ 40 made clipboard reads asynchronous in the main process; this works whether the call is sync or async. */
async function readClipboardText() {
  try { const t = await clipboard.readText(); return typeof t === 'string' ? t : ''; } catch { return ''; }
}

async function estimateClipboard() {
  try {
    const text = await readClipboardText();
    hotkeyFiredAt = Date.now();
    if (process.env.TOKKIE_DEBUG) console.log('HOTKEY_FIRED chars=' + text.length);
    showWindow();
    send('state', snapshot());     // lets Settings confirm "received" the instant the key is pressed
    if (!text.trim()) { send('estimate', { source: 'hotkey', text: '', result: null }); send('command', { type: 'open', tab: 'plan' }); return; }
    send('estimate', { source: 'hotkey', text, result: engine.estimate(text) });
    send('command', { type: 'open', tab: 'plan' });
  } catch (e) { console.error('estimate shortcut failed', e); }
}
async function pollClipboard() {
  if (!settings.get('clipboardWatch')) return;
  const text = await readClipboardText();
  if (text === lastClipboard) return;
  lastClipboard = text;
  if (text.length >= 40 && text.length <= 200000) send('estimate', { source: 'clipboard', text, result: engine.estimate(text) });
}

// ---------------------------------------------------------------------------------------- IPC
function setupIpc() {
  ipcMain.handle('state', () => snapshot());
  ipcMain.handle('estimate', (_e, text) => engine.estimate(String(text || '').slice(0, 200_000)));

  ipcMain.handle('settings:set', (_e, patch) => {
    const out = { ok: true };
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'bad request' };
    const allowed = ['finishBy', 'bufferMin', 'hotkey', 'clipboardWatch', 'launchAtLogin', 'alwaysOnTop', 'scale', 'fallbackBudget5h', 'monsters', 'window', 'onboarded', 'theme', 'notifyDone', 'alertBubble', 'speechBubble', 'evolution'];
    const clean = {};
    for (const k of allowed) if (Object.prototype.hasOwnProperty.call(patch, k)) clean[k] = patch[k];
    const bool = ['clipboardWatch', 'launchAtLogin', 'alwaysOnTop', 'onboarded', 'notifyDone', 'alertBubble', 'speechBubble'];
    for (const k of bool) if (k in clean) clean[k] = !!clean[k];
    if ('theme' in clean && !['auto', 'light', 'dark'].includes(clean.theme)) delete clean.theme;
    if ('finishBy' in clean && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(clean.finishBy))) delete clean.finishBy;
    if ('evolution' in clean) { const n = Math.round(Number(clean.evolution && clean.evolution.stageSeen)); clean.evolution = Number.isFinite(n) ? { ...settings.get('evolution'), stageSeen: Math.max(1, Math.min(4, n)) } : undefined; if (!clean.evolution) delete clean.evolution; }
    if ('hotkey' in clean && (typeof clean.hotkey !== 'string' || clean.hotkey.length > 60)) delete clean.hotkey;
    if ('monsters' in clean && (!clean.monsters || typeof clean.monsters !== 'object')) delete clean.monsters;
    if ('window' in clean) { const w = clean.window || {}; clean.window = {}; for (const k of ['x', 'y']) if (Number.isFinite(w[k])) clean.window[k] = Math.round(w[k]); if (typeof w.expanded === 'boolean') clean.window.expanded = w.expanded; if (['usage', 'plan', 'pets', 'settings'].includes(w.tab)) clean.window.tab = w.tab; }
    if ('hotkey' in clean) {
      const prev = settings.get('hotkey');
      if (!registerHotkey(clean.hotkey)) { registerHotkey(prev); delete clean.hotkey; out.ok = false; out.error = 'That shortcut is taken or invalid.'; }
    }
    if ('monsters' in clean) { const m = clean.monsters; clean.monsters = { active: String(m.active || SIGNATURE), saved: (m.saved || []).map(String).slice(0, 5) }; }
    if ('bufferMin' in clean) clean.bufferMin = Math.max(0, Math.min(120, Number(clean.bufferMin) || 0));
    if ('fallbackBudget5h' in clean) clean.fallbackBudget5h = Math.max(0, Number(clean.fallbackBudget5h) || 0);
    if ('scale' in clean) clean.scale = [5, 6, 8].includes(Number(clean.scale)) ? Number(clean.scale) : 6;
    if ('window' in clean) clean.window = { ...settings.get('window'), ...clean.window };
    settings.set(clean);
    if ('alwaysOnTop' in clean && win) win.setAlwaysOnTop(!!clean.alwaysOnTop, isMac ? 'floating' : 'screen-saver');
    if ('launchAtLogin' in clean && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR) app.setLoginItemSettings({ openAtLogin: !!clean.launchAtLogin });
    if ('monsters' in clean) refreshTray();
    send('state', snapshot());
    return out;
  });

  ipcMain.handle('setup:status', () => setup.status());
  ipcMain.handle('setup:connect', () => {
    const hookSource = path.join(__dirname, '..', '..', 'scripts', 'statusline-hook.js');
    const r = setup.install({ hookSource, execPath: process.execPath });
    hookCache.at = 0; send('state', snapshot());
    return r;
  });
  ipcMain.handle('setup:disconnect', () => { const r = setup.uninstall(); hookCache.at = 0; send('state', snapshot()); return r; });
  ipcMain.handle('sources', () => transcriptRoots().map((r) => ({ dir: r.dir, source: r.source })));

  // Layout: the renderer owns sizes; we anchor the pet so it never jumps when the panel opens/closes.
  const okRect = (r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite);
  const okSpec = (s) => s && Number.isFinite(s.w) && Number.isFinite(s.h) && s.w > 0 && s.h > 0 && s.w < 2000 && s.h < 2000 && okRect(s.pet);
  ipcMain.handle('ui:layout', (_e, l) => {
    if (!win || !l || !okSpec(l.collapsed) || !okSpec(l.below) || !okSpec(l.above)) return { placement };
    if (l.initial) {
      const wa0 = screen.getPrimaryDisplay().workArea, sv = settings.get('window'), c = l.collapsed;
      petRect = c.pet; placement = 'below';
      const x = sv.x != null ? sv.x - c.pet.x : wa0.x + wa0.width - c.w - 24, y = sv.y != null ? sv.y - c.pet.y : wa0.y + wa0.height - c.h - 24;
      win.setBounds(clampToWork({ x: Math.round(x), y: Math.round(y), width: c.w, height: c.h }));
      return { placement };
    }
    const b = win.getBounds();
    const oldPetX = b.x + petRect.x, oldPetY = b.y + petRect.y;
    const disp = screen.getDisplayMatching(b), wa = disp.workArea;
    if (l.mode === 'expanded') placement = (oldPetY + (l.below.pet.h / 2)) > wa.y + wa.height / 2 ? 'above' : 'below';
    else placement = 'below';
    const spec = l.mode === 'expanded' ? l[placement] : l.collapsed;
    petRect = spec.pet;
    const next = clampToWork({ x: Math.round(oldPetX - spec.pet.x), y: Math.round(oldPetY - spec.pet.y), width: spec.w, height: spec.h });
    win.setBounds(next);
    layoutCache = l;
    return { placement };
  });
  ipcMain.on('ui:petrect', (_e, r) => { petRect = r; });

  let dragStart = null;
  ipcMain.on('ui:dragStart', () => { if (win) dragStart = win.getPosition(); });
  ipcMain.on('ui:dragMove', (_e, d) => {
    if (!win || !dragStart || !d || !Number.isFinite(d.dx) || !Number.isFinite(d.dy)) return;
    const b = win.getBounds();   // setBounds (not setPosition) keeps the size fixed on mixed-DPI Windows setups
    win.setBounds({ x: Math.round(dragStart[0] + d.dx), y: Math.round(dragStart[1] + d.dy), width: b.width, height: b.height });
  });
  ipcMain.on('ui:dragEnd', () => {
    dragStart = null;
    // Persist the *pet's* screen position (independent of whether the panel is open or which side it opened on).
    if (win) { const b = win.getBounds(); settings.set({ window: { ...settings.get('window'), x: b.x + petRect.x, y: b.y + petRect.y } }); }
  });
  ipcMain.on('ui:interactive', (_e, on) => { if (win) win.setIgnoreMouseEvents(!on, { forward: true }); });
  ipcMain.on('ui:ready', () => { if (win && !win.isVisible()) { win.showInactive(); maybeScreenshot(); } });
  ipcMain.on('ui:estimateClipboard', () => estimateClipboard());
  ipcMain.on('ui:quit', () => app.quit());
  ipcMain.on('ui:hide', () => { win?.hide(); refreshTray(); });
  ipcMain.on('ui:openExternal', (_e, url) => { if (/^https:\/\/[^\s]+$/.test(String(url))) shell.openExternal(url); });
  ipcMain.on('ui:revealSettings', () => { shell.showItemInFolder(settings.file); });
}

// ---------------------------------------------------------------------------------------- lifecycle
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { showWindow('usage'); });

  app.whenReady().then(async () => {
    if (isMac) app.dock?.hide();
    legacy.migrate({ appData: app.getPath('appData'), userData: app.getPath('userData'), home: os.homedir(), hookSource: path.join(__dirname, '..', '..', 'scripts', 'statusline-hook.js'), skipUserData: !!process.env.TOKKIE_USERDATA });
    settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
    if (!settings.get('monsters').active) settings.set({ monsters: { ...settings.get('monsters'), active: SIGNATURE } });
    engine = new Engine({ settings });
    setupIpc();
    createWindow();
    refreshTray();
    // v1 shipped ⌘⇧L as the default and it clashed with editors/browsers; anyone still on that untouched default moves to the new one.
    if (settings.get('hotkey') === 'CommandOrControl+Shift+L') settings.set({ hotkey: 'CommandOrControl+Alt+Shift+L' });
    registerHotkey(settings.get('hotkey')) || console.warn('hotkey unavailable');
    setup.refreshHook({ hookSource: path.join(__dirname, '..', '..', 'scripts', 'statusline-hook.js') });
    const reclamp = () => { if (win && !win.isDestroyed()) win.setBounds(clampToWork(win.getBounds())); };
    screen.on('display-removed', reclamp); screen.on('display-metrics-changed', reclamp);

    engine.on('change', () => {
      if (changeTimer) return;
      changeTimer = setTimeout(() => { changeTimer = null; send('state', snapshot()); }, 250);
    });
    let changeTimer = null;
    engine.on('turn-end', ({ duration }) => {
      if (!settings.get('notifyDone') || duration < 60 || !Notification.isSupported()) return;
      const m = Math.floor(duration / 60), s = Math.round(duration % 60);
      const n = new Notification({ title: 'Claude finished', body: `Done after ${m}m ${String(s).padStart(2, '0')}s.`, silent: true });
      n.on('click', () => showWindow('usage'));
      n.show();
    });
    setInterval(() => { if (win && win.isVisible()) send('state', snapshot()); }, STATE_MS);
    setInterval(pollClipboard, 700);
    // Pointer position → eyes follow the cursor (only while visible; ~12 Hz is plenty).
    setInterval(() => {
      if (!win || !win.isVisible()) return;
      const p = screen.getCursorScreenPoint(), b = win.getBounds();
      const x = p.x - b.x, y = p.y - b.y;
      if (x === lastCursor.x && y === lastCursor.y) return;
      lastCursor = { x, y }; send('cursor', lastCursor);
    }, 90);

    try { await engine.start(); } catch (e) { console.error('engine failed to start', e); }
    collect();
    send('state', snapshot());
    if (process.env.TOKKIE_DEBUG) setTimeout(() => console.log('MEM', JSON.stringify(process.memoryUsage()), JSON.stringify(app.getAppMetrics().map((m) => [m.type, Math.round(m.memory.workingSetSize / 1024)]))), 3000);
  });

  app.on('will-quit', () => { globalShortcut.unregisterAll(); engine?.stop(); });
  app.on('window-all-closed', (e) => e.preventDefault());
}
