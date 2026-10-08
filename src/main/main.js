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
// Your own pet's seed. Up to 1.0.18 it was just the username, so two people with the same login name (common on
// company laptops) got the same pet. New installs add a random id; existing installs keep the pet they have.
const LEGACY_SIGNATURE = `you:${os.userInfo().username}`;
let SIGNATURE = LEGACY_SIGNATURE;
function ownSeed(settings) {
  let seed = settings.get('seed');
  if (!seed) {
    const m = settings.get('monsters') || {};
    const existing = m.active || (m.saved || []).length;            // installed before: keep the pet they know
    seed = existing ? LEGACY_SIGNATURE : `${LEGACY_SIGNATURE}:v2:${require('crypto').randomBytes(6).toString('hex')}`;   // v2: can be an animal
    settings.set({ seed });
  }
  return seed;
}
const STATE_MS = 1000;

let win = null, tray = null, settings = null, engine = null;
let petRect = { x: 0, y: 0, w: 0, h: 0 };       // renderer-reported pet position inside the window
let layoutCache = null, placement = 'below', homePet = null;   // homePet: where the pet sat before the panel opened
let lastClipboard = '', lastCursor = { x: -1, y: -1 };

process.on('uncaughtException', (e) => console.error('uncaught', e));
process.on('unhandledRejection', (e) => console.error('unhandled', e));

// ---------------------------------------------------------------------------------------- helpers
const publicSettings = () => {
  const d = { ...settings.data };
  delete d.samples; delete d.calib; delete d.spend;
  return d;
};

let hookCache = { at: 0, v: { installed: false } };
const hookStatus = () => { if (Date.now() - hookCache.at > 3000) hookCache = { at: Date.now(), v: { installed: !!setup.bridgeStatus().installed, legacy: !!setup.status().installed } }; return hookCache.v; };
// Packaged: shipped as a plain folder next to the app (outside the asar, so the plugin's .d.ts contract survives packaging).
const BRIDGE_SOURCE = app.isPackaged ? path.join(process.resourcesPath, 'bridge') : path.join(__dirname, '..', '..', 'bridge');

function snapshot() {
  const s = engine.snapshot();
  return { ...s, hook: hookStatus(), hotkey: { accelerator: settings.get('hotkey'), ok: hotkeyOk, firedAt: hotkeyFiredAt }, optKey: { accelerator: settings.get('optimizeHotkey'), ok: optKeyOk }, settings: publicSettings(), signature: SIGNATURE, platform: process.platform, version: app.getVersion(), packaged: app.isPackaged };
}

let bandLast = '', bandAt = 0;
const bandItem = (x) => ({ k: String(x.k || '').slice(0, 16), label: String(x.label || '').slice(0, 24), value: String(x.value || '').slice(0, 48), short: String(x.short == null ? x.value || '' : x.short).slice(0, 20), tone: ['good', 'warn', 'bad'].includes(x.tone) ? x.tone : '', tip: String(x.tip || '').slice(0, 480) });
function writeBand(b) {
  try {
    const avatar = b && typeof b.avatar === 'string' && /^<svg[^]*<\/svg>$/.test(b.avatar) && b.avatar.length < 20000 && !/<script|on\w+=/i.test(b.avatar) ? b.avatar : '';
    const optimizer = settings.get('optimizeButton') && setup.bridgeStatus().installed ? { model: settings.get('optimizerModel') || 'haiku', mode: settings.get('optimizerMode') || 'clearer' } : undefined;
    const clean = { show: !!(b && b.show), optimizer, alert: b && typeof b.alert === 'string' ? b.alert.slice(0, 120) : '', avatar,
      items: (b && Array.isArray(b.items) ? b.items : []).slice(0, 10).map(bandItem), chats: {} };
    // each recent chat's own capsule, keyed by its session id: the bar in that chat shows it
    if (b && b.chats && typeof b.chats === 'object') for (const [id, x] of Object.entries(b.chats).slice(0, 12)) if (/^[0-9a-f-]{36}$/i.test(id) && Array.isArray(x)) clean.chats[id] = x.slice(0, 3).map(bandItem);
    const key = JSON.stringify(clean), now = Date.now();
    if (key === bandLast && now - bandAt < 30e3) return;          // rewrite unchanged content only to keep it fresh
    if (!clean.show && !clean.optimizer && bandLast && !JSON.parse(bandLast).show && now - bandAt < 300e3) return;
    bandLast = key; bandAt = now;
    const dir = require('../core/paths').tokkieHome();
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'band.json'), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: now, ...clean })); fs.renameSync(tmp, f);
  } catch (e) { console.error('band write failed', e.message); }
}

/** Remember the species of every pet you've had (own, active, saved) for the album. */
function noteAlbum() {
  try {
    const m = settings.get('monsters'), album = { ...(settings.get('album') || {}) };
    let changed = false;
    for (const seed of [SIGNATURE, m.active, ...(m.saved || [])].filter(Boolean)) {
      const k = Monster.speciesOf(Monster.generate(seed));
      if (!album[k]) { album[k] = seed; changed = true; }
    }
    if (changed) settings.set({ album });
  } catch { /* cosmetic */ }
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
  if (process.env.TOKKIE_E2E) require('./e2e').attach(win, { screen, getPetRect: () => petRect, settings, fireHotkey: () => estimateClipboard(), clipboard, fireOptKey: () => optimizeClipboard(), getStrip: () => strip });
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
  if (process.env.TOKKIE_TOUR_NEXT) setTimeout(() => win.webContents.executeJavaScript(`for (let i = 0; i < ${Number(process.env.TOKKIE_TOUR_NEXT)}; i++) document.querySelector('#tour .btn.primary')?.click()`), 2600);
  if (process.env.TOKKIE_ALERT) setTimeout(() => win.webContents.executeJavaScript(`window.__tokkie.forceAlert(${JSON.stringify(process.env.TOKKIE_ALERT)})`), 1800);
  if (process.env.TOKKIE_SCROLL) setTimeout(() => win.webContents.executeJavaScript(`document.querySelectorAll('.view').forEach((v) => { v.scrollTop = ${Number(process.env.TOKKIE_SCROLL) || 0}; })`), Number(process.env.TOKKIE_SHOT_DELAY || 2200) - 400);
  if (process.env.TOKKIE_SHOT_JS) setTimeout(() => win.webContents.executeJavaScript(process.env.TOKKIE_SHOT_JS).catch(() => {}), 2600);   // QA: one scripted step before the shot
  if (process.env.TOKKIE_OPTTOAST) setTimeout(() => optToast({ kind: 'ok', title: `Optimized ✓ Paste it with ${isMac ? '⌘V' : 'Ctrl+V'}`, sub: 'Prompt text 7 → 108 tokens · click here to undo', undo: true }), 2400);
  if (process.env.TOKKIE_OPT) setTimeout(() => win.webContents.executeJavaScript(`[...document.querySelectorAll('#view-plan button')].find((b) => b.textContent.trim() === 'Optimize' && !b.closest('.run'))?.click()`), 2600);
  if (process.env.TOKKIE_EST) setTimeout(() => { const t = process.env.TOKKIE_EST; send('estimate', { source: 'hotkey', text: t, result: engine.estimate(t) }); }, 2000);
  setTimeout(async () => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    if (strip && !strip.isDestroyed()) {          // the floating strip too (TOKKIE_STRIP_HOVER=<item key> shows that item's tip)
      if (process.env.TOKKIE_STRIP_HOVER) { await strip.webContents.executeJavaScript(`(()=>{const k=${JSON.stringify(process.env.TOKKIE_STRIP_HOVER)};const t=k==='opt'?document.querySelector('button.opt'):document.querySelector('.it[data-key="'+k+'"]');t&&t.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));})()`); await new Promise((r) => setTimeout(r, 300)); }
      fs.writeFileSync(out.replace(/\.png$/, '-strip.png'), (await strip.webContents.capturePage()).toPNG());
    }
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
let hotAcc = null, optAcc = null, optKeyOk = false;
function bindKey(prev, acc, fn) {
  if (prev) { try { globalShortcut.unregister(prev); } catch { /* gone */ } }
  try { return !!globalShortcut.register(acc, fn) && globalShortcut.isRegistered(acc); } catch { return false; }
}
// the two shortcuts can't share keys; a clash leaves the current one untouched
function registerHotkey(acc) { if (acc === optAcc) return false; hotkeyOk = bindKey(hotAcc, acc, estimateClipboard); hotAcc = hotkeyOk ? acc : null; return hotkeyOk; }
function registerOptKey(acc) { if (acc === hotAcc) return false; optKeyOk = bindKey(optAcc, acc, optimizeClipboard); optAcc = optKeyOk ? acc : null; return optKeyOk; }
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

// ---------------------------------------------------------------------------------------- ✨ Optimize
// Claude rewrites the prompt (through the bridge, on the user's own login). Shared by the panel, the strip and the shortcut.
let optimizing = false;
async function runOptimize(text) {
  text = String(text || '').slice(0, 20000);
  if (!text.trim()) return { ok: false, error: 'Paste a prompt first.' };
  const opt = require('../core/optimizer'), mode = settings.get('optimizerMode');
  // No Claude Code here (Chat / Cowork users): hand back the request to paste into Claude instead.
  const viaChat = (why, tip) => ({ ok: false, error: why, chat: opt.chatRequest(text, mode), tip });
  // The loophole for Chat / Cowork people: any Code-tab session in the Claude app (even idle, in the background) does the rewriting.
  if (!setup.bridgeStatus().installed) return viaChat('Automatic Optimize needs a Claude Code session. You can ask Claude in Chat instead:', 'To make it automatic: Tokkie → Settings → Connect the bridge, then open the Claude app’s Code tab and start a session. It can sit in the background; Optimize then works from anywhere, Chat and Cowork included.');
  if (optimizing) return { ok: false, error: 'Already optimizing one — hang on.' };
  optimizing = true;
  try {
    const r = await opt.optimize(require('../core/paths').tokkieHome(), text, settings.get('optimizerModel'), { mode });
    if (!r.ok) return r.unclaimed ? viaChat('No Claude Code session is open to do it automatically. Ask Claude in Chat instead:', 'To make it automatic: open the Claude app’s Code tab and start a session (a new one, so it loads the bridge). Leave it in the background; Optimize then works from Chat and Cowork too.') : r;
    const { estimateTokens } = require('../core/tokens');
    return { ...r, before: { promptTokens: estimateTokens(text) }, after: { promptTokens: estimateTokens(r.optimized) } };
  } finally { optimizing = false; }
}

// Copy → shortcut (or the strip's button) → paste: the Chat / Cowork stand-in for the Claude bar's in-place Optimize.
// Tokkie never types into other apps; the better prompt goes on your clipboard and you paste it. Undo puts yours back.
let optUndo = null;
function optToast(t) { const m = { type: 'optToast', ...t }; send('command', m); sendStrip('command', m); }
async function optimizeClipboard() {
  const text = await readClipboardText();
  const key = prettyAccel(settings.get('optimizeHotkey'));
  if (!text.trim()) { optToast({ kind: 'warn', title: 'Copy your prompt first', sub: `Select it in Claude’s box (${isMac ? '⌘A ⌘C' : 'Ctrl+A Ctrl+C'}), then press ${key} or click Optimize.` }); return; }
  if (win && !win.isVisible()) { win.showInactive(); refreshTray(); }
  optToast({ kind: 'busy', title: 'Optimizing your prompt…', sub: `${(settings.get('optimizerMode') === 'shorter' ? 'Shorter' : 'Clearer')} · ${cap(settings.get('optimizerModel') || 'haiku')}` });
  const r = await runOptimize(text);
  const paste = isMac ? '⌘V' : 'Ctrl+V';
  if (r.ok) {
    try { await clipboard.writeText(r.optimized); lastClipboard = r.optimized; } catch { /* clipboard busy */ }
    optUndo = text;
    optToast({ kind: 'ok', title: `Optimized ✓ Paste it with ${paste}`, sub: `Prompt text ${r.before.promptTokens} → ${r.after.promptTokens} tokens · click here to undo`, undo: true });
  } else if (r.chat) {
    try { await clipboard.writeText(r.chat); lastClipboard = r.chat; } catch { /* clipboard busy */ }
    optUndo = text;
    optToast({ kind: 'ok', title: `Copied a request for Claude: paste it with ${paste}`, sub: 'No Code session is open, so Claude rewrites it in your chat. Keep a Code tab session open to make it automatic.', undo: true });
  } else optToast({ kind: 'warn', title: 'Couldn’t optimize', sub: r.error || 'Something went wrong.' });
}
async function undoClipboardOptimize() {
  if (optUndo == null) return { ok: false };
  try { await clipboard.writeText(optUndo); lastClipboard = optUndo; } catch { return { ok: false }; }
  optUndo = null; optToast({ kind: 'ok', title: 'Your original prompt is back on the clipboard', sub: '' });
  return { ok: true };
}
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
function prettyAccel(acc) {
  return String(acc || '').split('+').map((k) => ({ CommandOrControl: isMac ? '⌘' : 'Ctrl', Command: '⌘', Control: isMac ? '⌃' : 'Ctrl', Alt: isMac ? '⌥' : 'Alt', Shift: isMac ? '⇧' : 'Shift' }[k] || k)).join(isMac ? '' : '+');
}

// ---------------------------------------------------------------------------------------- floating strip
// A slim always-on-top bar you drag above Chat's or Cowork's prompt box: the Claude bar's items, tips and Optimize.
// Its window is a little taller than the bar (the hover tip shows above it); the empty part lets clicks through.
let strip = null, stripLast = '';
const STRIP_H = 132;
function ensureStrip() {
  if (!settings.get('strip')) { if (strip && !strip.isDestroyed()) strip.destroy(); strip = null; return; }
  if (strip) return;
  const wa = screen.getPrimaryDisplay().workArea, pos = settings.get('stripPos') || {}, w = 520;
  const b = clampToWork({ x: pos.x != null ? pos.x : Math.round(wa.x + (wa.width - w) / 2), y: pos.y != null ? pos.y : wa.y + wa.height - STRIP_H - 150, width: w, height: STRIP_H });
  strip = new BrowserWindow({
    ...b, frame: false, transparent: true, hasShadow: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, show: false, backgroundColor: '#00000000', title: 'Tokkie strip', focusable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (isMac) { strip.setAlwaysOnTop(true, 'floating'); strip.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); }
  else strip.setAlwaysOnTop(true, 'screen-saver');
  strip.setIgnoreMouseEvents(true, { forward: true });
  strip.loadFile(path.join(__dirname, '..', 'renderer', 'strip.html'));
  strip.webContents.on('will-navigate', (e) => e.preventDefault());
  strip.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  strip.webContents.on('did-finish-load', () => { stripLast = ''; if (lastStripPayload) sendStrip('strip', lastStripPayload); if (strip && !strip.isDestroyed()) strip.showInactive(); });
  strip.on('closed', () => { strip = null; });
}
let lastStripPayload = null;
function sendStrip(channel, payload) { if (strip && !strip.isDestroyed()) strip.webContents.send(channel, payload); }
function updateStrip(p) {
  const clean = { theme: settings.get('theme'), optKey: prettyAccel(settings.get('optimizeHotkey')), alert: typeof p.alert === 'string' ? p.alert.slice(0, 200) : '',
    items: (Array.isArray(p.items) ? p.items : []).slice(0, 10).map((x) => ({ k: String(x.k || '').slice(0, 16), label: String(x.label || '').slice(0, 24), value: String(x.value || '').slice(0, 40), tone: ['good', 'warn', 'bad'].includes(x.tone) ? x.tone : '', tip: String(x.tip || '').slice(0, 400) })) };
  lastStripPayload = clean;
  const key = JSON.stringify(clean); if (key === stripLast) return; stripLast = key;
  sendStrip('strip', clean);
}

// ---------------------------------------------------------------------------------------- IPC
function setupIpc() {
  ipcMain.handle('state', () => snapshot());
  ipcMain.handle('estimate', (_e, text) => engine.estimate(String(text || '').slice(0, 200_000)));

  ipcMain.handle('settings:set', (_e, patch) => {
    const out = { ok: true };
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'bad request' };
    const allowed = ['finishBy', 'bufferMin', 'hotkey', 'clipboardWatch', 'launchAtLogin', 'alwaysOnTop', 'scale', 'fallbackBudget5h', 'monsters', 'window', 'onboarded', 'theme', 'notifyDone', 'alertBubble', 'speechBubble', 'evolution', 'spendLimitUsd', 'resetDay', 'layout', 'dock', 'personality', 'dockPlace', 'pills', 'optimizerModel', 'optimizeButton', 'optimizerMode', 'optimizeHotkey', 'strip', 'stripPos'];
    const clean = {};
    for (const k of allowed) if (Object.prototype.hasOwnProperty.call(patch, k)) clean[k] = patch[k];
    const bool = ['clipboardWatch', 'launchAtLogin', 'alwaysOnTop', 'onboarded', 'notifyDone', 'alertBubble', 'speechBubble', 'strip'];
    for (const k of bool) if (k in clean) clean[k] = !!clean[k];
    if ('theme' in clean && !['auto', 'light', 'dark'].includes(clean.theme)) delete clean.theme;
    if ('finishBy' in clean && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(clean.finishBy))) delete clean.finishBy;
    if ('evolution' in clean) {
      const e = clean.evolution || {}, next = { ...settings.get('evolution') };
      const seen = Math.round(Number(e.stageSeen)), disp = Math.round(Number(e.display));
      if ('stageSeen' in e && Number.isFinite(seen)) next.stageSeen = Math.max(1, Math.min(4, seen));
      if ('display' in e && Number.isFinite(disp)) next.display = Math.max(0, Math.min(4, disp));
      clean.evolution = next;
    }
    if ('spendLimitUsd' in clean) clean.spendLimitUsd = Math.max(0, Math.min(1e6, Math.round((Number(clean.spendLimitUsd) || 0) * 100) / 100));
    if ('resetDay' in clean) clean.resetDay = Math.max(1, Math.min(31, Math.round(Number(clean.resetDay)) || 1));
    if ('layout' in clean && !['dock', 'pills', 'pet'].includes(clean.layout)) delete clean.layout;
    if ('personality' in clean && !['cheerful', 'playful', 'sleepy', 'grumpy', 'shy'].includes(clean.personality)) delete clean.personality;
    for (const key of ['dock', 'pills']) if (key in clean) { const d = clean[key] || {}, cur = settings.get(key); clean[key] = { ...cur }; for (const k of Object.keys(cur)) if (typeof d[k] === 'boolean') clean[key][k] = d[k]; }
    if ('dockPlace' in clean && !['below', 'above', 'claude'].includes(clean.dockPlace)) delete clean.dockPlace;
    if ('optimizerModel' in clean && !['haiku', 'sonnet', 'opus'].includes(clean.optimizerModel)) delete clean.optimizerModel;
    if ('optimizeButton' in clean) clean.optimizeButton = !!clean.optimizeButton;
    if ('optimizerMode' in clean && !['clearer', 'shorter'].includes(clean.optimizerMode)) delete clean.optimizerMode;
    if ('hotkey' in clean && (typeof clean.hotkey !== 'string' || clean.hotkey.length > 60)) delete clean.hotkey;
    if ('monsters' in clean && (!clean.monsters || typeof clean.monsters !== 'object')) delete clean.monsters;
    if ('window' in clean) { const w = clean.window || {}; clean.window = {}; for (const k of ['x', 'y']) if (Number.isFinite(w[k])) clean.window[k] = Math.round(w[k]); if (typeof w.expanded === 'boolean') clean.window.expanded = w.expanded; if (['usage', 'plan', 'history', 'pets', 'settings'].includes(w.tab)) clean.window.tab = w.tab; for (const [k, lo, hi] of [['panelW', 336, 760], ['panelH', 420, 1100]]) if (Number.isFinite(w[k])) clean.window[k] = Math.max(lo, Math.min(hi, Math.round(w[k]))); }
    if ('hotkey' in clean) {
      const prev = settings.get('hotkey');
      if (!registerHotkey(clean.hotkey)) { registerHotkey(prev); delete clean.hotkey; out.ok = false; out.error = 'That shortcut is taken or invalid.'; }
    }
    if ('optimizeHotkey' in clean && (typeof clean.optimizeHotkey !== 'string' || clean.optimizeHotkey.length > 60)) delete clean.optimizeHotkey;
    if ('optimizeHotkey' in clean) {
      const prev = settings.get('optimizeHotkey');
      if (!registerOptKey(clean.optimizeHotkey)) { registerOptKey(prev); delete clean.optimizeHotkey; out.ok = false; out.error = 'That shortcut is taken or invalid.'; }
    }
    if ('stripPos' in clean) { const p = clean.stripPos || {}; clean.stripPos = Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: Math.round(p.x), y: Math.round(p.y) } : { x: null, y: null }; }
    if ('monsters' in clean) { const m = clean.monsters; clean.monsters = { active: String(m.active || SIGNATURE).slice(0, 80), saved: (m.saved || []).map((x) => String(x).slice(0, 80)).slice(0, 12), hideOwn: !!m.hideOwn }; }
    if ('bufferMin' in clean) clean.bufferMin = Math.max(0, Math.min(120, Number(clean.bufferMin) || 0));
    if ('fallbackBudget5h' in clean) clean.fallbackBudget5h = Math.max(0, Number(clean.fallbackBudget5h) || 0);
    if ('scale' in clean) clean.scale = [5, 6, 8].includes(Number(clean.scale)) ? Number(clean.scale) : 6;
    if ('window' in clean) clean.window = { ...settings.get('window'), ...clean.window };
    settings.set(clean);
    if ('alwaysOnTop' in clean && win) win.setAlwaysOnTop(!!clean.alwaysOnTop, isMac ? 'floating' : 'screen-saver');
    if ('launchAtLogin' in clean && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR) app.setLoginItemSettings({ openAtLogin: !!clean.launchAtLogin });
    if ('monsters' in clean) { refreshTray(); noteAlbum(); }
    if ('strip' in clean) ensureStrip();
    if ('stripPos' in clean && strip && clean.stripPos.x != null) strip.setPosition(clean.stripPos.x, clean.stripPos.y);
    send('state', snapshot());
    return out;
  });

  ipcMain.handle('usage:setReading', (_e, id, pct) => { const ok = engine.setManualReading(String(id), Number(pct)); send('state', snapshot()); return { ok }; });
  ipcMain.handle('setup:status', () => setup.bridgeStatus());
  ipcMain.handle('setup:connect', () => { const r = setup.installBridge({ bridgeSource: BRIDGE_SOURCE }); hookCache.at = 0; send('state', snapshot()); return r; });
  ipcMain.handle('setup:disconnect', () => { const r = setup.uninstallBridge(); setup.uninstall(); hookCache.at = 0; send('state', snapshot()); return r; });
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
    let oldPetX = b.x + petRect.x, oldPetY = b.y + petRect.y;
    // A panel that can't fit on a short screen nudges the pet; closing it puts the pet back exactly where it was.
    if (l.mode === 'expanded' && !homePet) homePet = { x: oldPetX, y: oldPetY };
    if (l.mode !== 'expanded' && homePet) { oldPetX = homePet.x; oldPetY = homePet.y; homePet = null; }
    const disp = screen.getDisplayMatching(b), wa = disp.workArea;
    if (l.mode === 'expanded') {
      // open where the whole panel fits without moving the pet; otherwise the side with more room
      const fitsBelow = oldPetY - l.below.pet.y + l.below.h <= wa.y + wa.height, fitsAbove = oldPetY - l.above.pet.y >= wa.y;
      const lower = (oldPetY + (l.below.pet.h / 2)) > wa.y + wa.height / 2;
      placement = fitsBelow && (!lower || !fitsAbove) ? 'below' : fitsAbove ? 'above' : lower ? 'above' : 'below';
    }
    else placement = 'below';
    const spec = l.mode === 'expanded' ? l[placement] : l.collapsed;
    petRect = spec.pet;
    const next = clampToWork({ x: Math.round(oldPetX - spec.pet.x), y: Math.round(oldPetY - spec.pet.y), width: spec.w, height: spec.h });
    win.setBounds(next);
    layoutCache = l;
    return { placement };
  });
  ipcMain.on('ui:petrect', (_e, r) => { petRect = r; });
  // The Dock as a bar above Claude Code's prompt: the bridge draws whatever we leave in ~/.tokkie/band.json.
  ipcMain.on('ui:band', (_e, b) => writeBand(b));

  let dragStart = null;
  ipcMain.on('ui:dragStart', () => { if (win) dragStart = win.getPosition(); homePet = null; });
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
  ipcMain.on('ui:interactive', (e, on) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setIgnoreMouseEvents(!on, { forward: true }); });
  ipcMain.on('ui:strip', (_e, p) => { if (p && typeof p === 'object') updateStrip(p); });
  let stripDrag = null;
  ipcMain.on('strip:dragStart', () => { if (strip) stripDrag = strip.getBounds(); });
  ipcMain.on('strip:dragMove', (_e, d) => { if (strip && stripDrag && d && Number.isFinite(d.dx) && Number.isFinite(d.dy)) strip.setPosition(Math.round(stripDrag.x + d.dx), Math.round(stripDrag.y + d.dy)); });
  ipcMain.on('strip:dragEnd', () => { if (!strip || !stripDrag) return; stripDrag = null; const b = clampToWork(strip.getBounds()); strip.setBounds(b); settings.set({ stripPos: { x: b.x, y: b.y } }); });
  ipcMain.on('strip:width', (_e, w) => { if (!strip || !Number.isFinite(w)) return; const b = strip.getBounds(), nw = Math.max(200, Math.min(1400, Math.round(w))); if (nw !== b.width) strip.setBounds(clampToWork({ ...b, width: nw })); });
  ipcMain.on('strip:open', (_e, tab) => showWindow(['usage', 'plan', 'history', 'pets', 'settings'].includes(tab) ? tab : 'usage'));
  ipcMain.on('ui:ready', () => { if (win && !win.isVisible()) { win.showInactive(); maybeScreenshot(); } });
  ipcMain.on('ui:estimateClipboard', () => estimateClipboard());
  ipcMain.on('ui:quit', () => app.quit());
  ipcMain.on('ui:hide', () => { win?.hide(); refreshTray(); });
  // Reopen a Claude Code conversation: the Claude app's own resume link (session ids are UUIDs; nothing else passes).
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  ipcMain.handle('ui:openSession', async (_e, id) => {
    if (!UUID.test(String(id))) return { ok: false };
    try { await shell.openExternal(`claude://resume?session=${id}`); return { ok: true }; } catch { return { ok: false }; }
  });
  ipcMain.handle('ui:openClaude', async () => { try { await shell.openExternal('claude://'); return { ok: true }; } catch { return { ok: false }; } });
  ipcMain.handle('runs:history', () => engine.history());
  ipcMain.handle('prompt:optimize', (_e, text) => runOptimize(text));
  ipcMain.on('ui:optimizeClipboard', () => optimizeClipboard());
  ipcMain.handle('opt:undo', () => undoClipboardOptimize());
  // Secret codes → special pets. Wrong guesses are rate-limited so the codes can't be brute-forced from the UI.
  let codeTries = [];
  ipcMain.handle('pets:redeem', (_e, code) => {
    const now = Date.now(); codeTries = codeTries.filter((t) => now - t < 60e3);
    if (codeTries.length >= 10) return { ok: false, error: 'Too many tries — wait a minute.' };
    const kind = require('../core/secrets').redeem(code);
    if (!kind) { codeTries.push(now); return { ok: false, error: 'That code doesn’t unlock anything.' }; }
    const seed = `sp:${kind}:${require('crypto').randomBytes(4).toString('hex')}`;
    const m = settings.get('monsters');
    settings.set({ monsters: { ...m, active: seed, saved: m.saved.length < 12 ? [...m.saved, seed] : m.saved } });
    noteAlbum(); refreshTray(); send('state', snapshot());
    return { ok: true, kind, seed, saved: m.saved.length < 12, name: Monster.generate(seed).name };
  });
  ipcMain.handle('run:prompt', (_e, sid, uuid) => engine.promptText(String(sid), String(uuid)));
  ipcMain.handle('ui:copyText', async (_e, t) => { const v = String(t).slice(0, 1_000_000); try { await clipboard.writeText(v); lastClipboard = v; return { ok: true }; } catch { return { ok: false }; } });
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
    SIGNATURE = ownSeed(settings);
    if (!settings.get('monsters').active) settings.set({ monsters: { ...settings.get('monsters'), active: SIGNATURE } });
    noteAlbum();
    engine = new Engine({ settings });
    setupIpc();
    createWindow();
    refreshTray();
    // v1 shipped ⌘⇧L as the default and it clashed with editors/browsers; anyone still on that untouched default moves to the new one.
    if (settings.get('hotkey') === 'CommandOrControl+Shift+L') settings.set({ hotkey: 'CommandOrControl+Alt+Shift+L' });
    registerHotkey(settings.get('hotkey')) || console.warn('hotkey unavailable');
    registerOptKey(settings.get('optimizeHotkey')) || console.warn('optimize hotkey unavailable');
    ensureStrip();
    setup.refreshHook({ hookSource: path.join(__dirname, '..', '..', 'scripts', 'statusline-hook.js') });
    setup.refreshBridge({ bridgeSource: BRIDGE_SOURCE });
    require('../core/optimizer').sweep(require('../core/paths').tokkieHome());
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
    // A model or Clearer/Shorter picked on the Claude bar becomes Tokkie's setting too.
    let prefsAt = 0;
    setInterval(() => {
      try {
        const f = path.join(require('../core/paths').tokkieHome(), 'prefs.json');
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!(j.at > prefsAt)) return;
        const first = prefsAt === 0; prefsAt = j.at;
        if (first && Date.now() - j.at > 10e3) return;          // an old pick from before Tokkie started: ignore
        const patch = {};
        if (['haiku', 'sonnet', 'opus'].includes(j.optimizerModel)) patch.optimizerModel = j.optimizerModel;
        if (['clearer', 'shorter'].includes(j.optimizerMode)) patch.optimizerMode = j.optimizerMode;
        if (Object.keys(patch).length) { settings.set(patch); send('state', snapshot()); }
      } catch { /* no picks yet */ }
    }, 2000);
    // Pointer position → eyes follow the cursor (only while visible; ~12 Hz is plenty).
    setInterval(() => {
      if (!win || !win.isVisible() || process.env.TOKKIE_E2E) return;   // tests drive the cursor themselves
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

  app.on('will-quit', () => { globalShortcut.unregisterAll(); engine?.stop(); bandLast = ''; writeBand({ show: false }); });
  app.on('window-all-closed', (e) => e.preventDefault());
}
