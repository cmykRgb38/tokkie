// Browser-only mock backend so the UI can be developed and screenshot-tested without Electron.
const q = new URLSearchParams(location.search);
const now = Date.now();
const connected = q.get('connected') !== '0';
const state = {
  now, loaded: true, platform: q.get('platform') || 'darwin', version: '1.0.0', packaged: false, signature: 'you:demo',
  active: q.get('active') ? { start: now - 134000, chars: 600, elapsed: 134000 } : null, activeCount: 1, lastTurnEnd: now - 7 * 60e3, lastEvent: now - (q.get('idle') ? 40 * 60e3 : 5000),
  eta: q.get('active') ? { p25: 480, p50: 720, p75: 1080, p90: 1500 } : null,
  tokens: { today: 1_284_300, last5h: 342_100, week: 6_820_000, burn: 4200, weightedLast5h: 400000 },
  spark: Array.from({ length: 60 }, (_, i) => Math.max(0, Math.round(Math.sin(i / 6) * 3000 + 3200 + (i > 40 ? 6000 * Math.random() : 800 * Math.random())))),
  limits: connected ? { connected: true, five: { pct: Number(q.get('pct') || 38), resetsAt: now + 100 * 60e3, approx: true }, seven: { pct: 61, resetsAt: now + 3 * 86400e3, approx: false } } : { connected: false },
  hook: { installed: q.get('hook') === '1' }, meters: connected ? [{ id: 'five', label: '5-hour limit', pct: Number(q.get('pct') || 38), approx: false, resetsAt: now + 100 * 60e3, readAt: now - 4 * 60e3, source: 'claude-app' }, { id: 'seven', label: 'Weekly limit', pct: 61, approx: false, resetsAt: null, readAt: now - 4 * 60e3, source: 'claude-app' }] : [{ id: 'extra', label: 'Usage limit', pct: 23, approx: false, resetsAt: null, readAt: now - 12 * 60e3, source: 'claude-app' }],
  runs: [
    { start: now - 6 * 60e3, chars: 412, duration: 252, headline: 41000, tokens: 52000, est: { dur: { p25: 150, p50: 240, p75: 420, p90: 700 }, head: { p25: 22000, p50: 38000, p75: 70000, p90: 120000 } } },
    { start: now - 50 * 60e3, chars: 96, duration: 31, headline: 3200, tokens: 5000, est: null },
    { start: now - 95 * 60e3, chars: 1630, duration: 1260, headline: 310000, tokens: 400000, est: { dur: { p25: 200, p50: 400, p75: 700, p90: 1100 }, head: { p25: 40000, p50: 80000, p75: 150000, p90: 260000 } } },
  ], k5: 1000000,
  evolution: (() => { const e = Number(q.get('eaten') || 4.2e6), T = [0, 2e6, 10e6, 40e6]; let st = 1; T.forEach((t, i) => { if (e >= t) st = i + 1; }); const from = T[st - 1], to = T[st] ?? null; const pr = to == null ? 1 : (e - from) / (to - from); return { eaten: e, stage: st, name: ['Hatchling', 'Junior', 'Champion', 'Mega'][st - 1], fat: pr < 1 / 3 ? 0 : pr < 2 / 3 ? 1 : 2, progress: pr, from, next: to, nextName: to == null ? null : ['Hatchling', 'Junior', 'Champion', 'Mega'][st] }; })(),
  fallback: null, samples: 42, files: 14,
  settings: { finishBy: q.get('finish') || '18:30', bufferMin: 10, hotkey: 'CommandOrControl+Alt+Shift+L', clipboardWatch: false, launchAtLogin: false, alwaysOnTop: true, scale: 6,
    fallbackBudget5h: 0, monsters: { active: q.get('seed') || 'you:demo', saved: ['alpha', 'bravo'] }, theme: q.get('theme') || 'auto', notifyDone: true, onboarded: q.get('welcome') ? false : true, window: {} },
};
const subs = { state: [], estimate: [], command: [], cursor: [] };
const on = (k) => (cb) => { subs[k].push(cb); return () => {}; };
const fire = (k, p) => subs[k].forEach((f) => f(p));

window.tokkie = {
  getState: async () => state,
  estimate: async (text) => {
    const n = text.length, f = new Date(); const [h, m] = state.settings.finishBy.split(':'); f.setHours(h, m, 0, 0);
    const p50 = 120 + n * 0.9, mk = (v) => ({ p25: v * 0.6, p50: v, p75: v * 1.5, p90: v * 2.2 });
    const d = mk(p50), t0 = Date.now(), fin = f.getTime(), e50 = t0 + d.p50 * 1000, e90 = t0 + d.p90 * 1000;
    const verdict = t0 + 600000 >= fin ? 'over' : e90 + 600000 <= fin ? 'go' : e50 + 600000 <= fin ? 'tight' : 'stop';
    return { chars: n, promptTokens: Math.round(n / 4), duration: d, tokens: mk(30000 + n * 20), headline: mk(12000 + n * 9), share: { lo: 2, mid: 4, hi: 9 }, confidence: 'medium', n: 42, method: 'regression',
      plan: { verdict, sendBy: fin - 600000 - d.p90 * 1000, etaP50: e50, etaP90: e90, marginMin: 0 }, finishBy: fin, now: t0 };
  },
  setSettings: async (p) => { Object.assign(state.settings, p); setTimeout(() => fire('state', { ...state, now: Date.now() }), 0); return { ok: true }; },
  setup: { status: async () => ({ installed: connected, readable: true }), connect: async () => ({ ok: true }), disconnect: async () => ({ ok: true }) },
  sources: async () => [{ dir: '/Users/demo/.claude/projects', source: 'code' }, { dir: '/Users/demo/Library/Application Support/Claude/local-agent-mode-sessions/…/projects', source: 'cowork' }],
  onState: on('state'), onEstimate: on('estimate'), onCommand: on('command'), onCursor: on('cursor'),
  ui: { layout: async (l) => ({ placement: q.get('above') ? 'above' : 'below' }), ready() {}, dragStart() {}, dragMove() {}, dragEnd() {}, interactive() {}, quit() {}, hide() {}, openExternal() {}, revealSettings() {}, estimateClipboard() {} },
};
window.__mock = { fire, state };
