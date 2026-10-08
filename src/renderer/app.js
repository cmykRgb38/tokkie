import { $, clamp, fmtDur, fmtClockDur, fmtTokens, fmtRange, fmtRunOut, fmtRunOutShort, chatAdvice } from './util.js';
import { Pet, EMOTES, PERSONALITY } from './pet.js';
import { usageView, kindUsed } from './views/usage.js';
import { alertState, acknowledge } from './alerts.js';
import { planView } from './views/plan.js';
import { petsView } from './views/pets.js';
import { historyView } from './views/history.js';
import { settingsView } from './views/settings.js';

if (!window.tokkie) await import('./dev/mock.js'); // opened in a plain browser: run against a mock backend
const bridge = window.tokkie;
const M = window.TokkieMonster;

let PANEL_W = 336, PANEL_H = 504;                 // the panel's size: drag its corner to change it (remembered)
const GAP = 6, MARGIN = 14;
const TABS = ['usage', 'plan', 'history', 'pets', 'settings'];

const bubbleEl = $('#bubble'), bubbleTitle = $('#bubbleTitle'), bubbleSub = $('#bubbleSub');
const appEl = $('#app'), stage = $('#stage'), canvas = $('#pet'), pills = $('#pills'), dockEl = $('#dock');
const panel = $('#panel'), chip = $('#chip');
let evoInit = false, evoBubbleUntil = 0, evoBubble = null;
const BUBBLE_ZONE = 44;
const TUCK = 26;                              // Dock-above: how far the pet's transparent headroom slides under the card (matches styles.css)                       // headroom above the pet reserved for the attention bubble (matches #stage padding-top)
let acked = { doneEnd: null, ask: null }, forced = null;
let optBubble = null;
let booted = false, layout = 'dock', place = 'below', dockH = 0, pillsH = 30, dockKey = '', warned = null, warnBubble = null, fitAlert = null, lastNextFit = 'ok';
let S = null, mode = 'collapsed', tab = 'usage', prevLast5h = null, lastEnd = null, doneUntil = 0, bubble = null, welcomed = false;

// ------------------------------------------------------------------------------------- API for views
const api = {
  setSettings: (p) => bridge.setSettings(p),
  estimate: (t) => bridge.estimate(t),
  estimateClipboard: () => bridge.ui.estimateClipboard(),
  connect: async () => { const r = await bridge.setup.connect(); views.settings.refreshSetup(); return r; },
  disconnect: async () => { const r = await bridge.setup.disconnect(); views.settings.refreshSetup(); return r; },
  setupStatus: () => bridge.setup.status(),
  sources: () => bridge.sources(),
  setReading: (id, pct) => bridge.setReading(id, pct),
  emote: (m) => pet.emote(m, m === 'sleep' ? 5000 : 3500),
  dismissWelcome: () => bridge.setSettings({ onboarded: true }),
  startTour: () => startTour(),
  openTab: (t) => setMode('expanded', t),
  openSession: (id) => bridge.ui.openSession(id),
  copyText: (t) => bridge.ui.copyText(t),
  promptText: (sid, uuid) => bridge.ui.promptText(sid, uuid),
  history: () => bridge.ui.history(),
  redeem: (code) => bridge.ui.redeem(code),
  optimize: (text) => bridge.ui.optimize(text),
  platform: () => (S ? S.platform : ''),
  hide: () => bridge.ui.hide(), quit: () => bridge.ui.quit(),
};
const views = {
  usage: usageView($('#view-usage'), api), plan: planView($('#view-plan'), api),
  pets: petsView($('#view-pets'), api), settings: settingsView($('#view-settings'), api), history: historyView($('#view-history'), api),
};

// ------------------------------------------------------------------------------------- pet
const pet = new Pet(canvas, { scale: 6 });
pet.start();
let seedShown = null;

/** sRGB hex → OKLCH hue (degrees) so the UI accent truly matches the pet's colour. */
function oklchHue(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = Math.cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
  const m = Math.cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
  const s = Math.cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return Math.round(((Math.atan2(b, a) * 180) / Math.PI + 360) % 360);
}

function applyTheme(st) {
  const light = matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = st.theme === 'auto' ? (light ? 'light' : 'dark') : st.theme;
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => S && applyTheme(S.settings));

// ------------------------------------------------------------------------------------- mood + copy

function finishMsToday(S) {
  const [h, m] = S.settings.finishBy.split(':').map(Number); const d = new Date(S.now); d.setHours(h, m, 0, 0); return d.getTime();
}

function describe(S) {
  const now = S.now, L = S.limits;
  const meters = S.meters || [], primary = meters[0] || null;
  const usedPct = primary ? primary.pct : null;
  const active = S.active, eta = S.eta;
  let mood = 'idle';
  const idleMs = now - (S.lastEvent || 0);
  const toFinish = finishMsToday(S) - now;
  if (active) mood = toFinish < 0 && toFinish > -3 * 3600e3 ? 'angry' : toFinish < 15 * 60e3 && toFinish >= 0 ? 'stress' : 'work';   // overtime = grumpy
  else if (now < doneUntil) mood = 'done';
  else if (bubble && now < bubble.until && (bubble.result.plan.verdict === 'stop' || bubble.result.plan.verdict === 'over')) mood = 'stress';
  else if (usedPct != null && usedPct >= 90) mood = 'hungry';
  else if (idleMs > pet.P.sleepMin * 60e3) mood = 'sleep';
  else if (idleMs > pet.P.boredMin * 60e3) mood = 'bored';

  let text, dot = 'idle', chipText, chipK = '';
  const rest = []; let restAtRest = false;
  if (bubble && now < bubble.until) {
    const r = bubble.result; const k = { go: 'good', tight: 'warn', stop: 'bad', over: 'bad' }[r.plan.verdict];
    text = `≈${fmtTokens(r.promptTokens)} tok · ${fmtRange(r.duration.p25, r.duration.p75)}`; dot = k;
  } else if (active) {
    const t = fmtClockDur(now - active.start); dot = 'live';
    const over = eta && (now - active.start) / 1000 > eta.p75;
    text = `Working ${t}` + (eta ? (over ? ' · longer than usual' : ` · usually ${fmtRange(eta.p25, eta.p75)}`) : ''); chipText = `Working ${t}`; chipK = 'live';
    rest.push({ text, dot: 'live', title: '' }); restAtRest = 'busy';
  } else {
    // At rest: one pill per item you picked in Settings (usage + tokens today by default).
    restAtRest = true;
    text = ''; dot = primary ? kindUsed(primary.pct) : 'idle';
  }

  if (!chipText) {
    if (now < doneUntil) chipText = 'Done!';
    else if (S.lastTurnEnd && now - S.lastTurnEnd < 3600e3) chipText = `Done · ${fmtDur((now - S.lastTurnEnd) / 1000)} ago`;
    else chipText = mood === 'sleep' ? 'Sleeping' : 'Idle';
  }
  const d = { mood, text, dot, chipText, chipK, eta };
  if (restAtRest) {
    for (const l of dockLines(S, d, S.settings.pills || {})) if (!(restAtRest === 'busy' && l.k === 'status')) rest.push({ text: l.pill, dot: l.dot || (l.tone && l.k !== 'status' ? l.tone : null), title: l.title });
    if (!rest.length) rest.push({ text: chipText, dot: null, title: '' });
    d.text = rest.map((p) => p.text).join(' · ');
  }
  d.pillList = rest.length ? rest : [{ text, dot, title: '' }];   // working / estimate states pin a single status pill
  return d;
}

// ------------------------------------------------------------------------------------- evolution
const FORM_NAMES = ['Hatchling', 'Junior', 'Champion', 'Mega'];
function syncEvolution(ev) {
  const seen = Math.max(1, Math.min(ev.stage, (S.settings.evolution && S.settings.evolution.stageSeen) || 1));
  const pinned = Math.min(ev.stage, (S.settings.evolution && S.settings.evolution.display) || 0);
  if (pinned) {
    // You picked a form in Pets: keep showing it. Growing up still gets a note, just no transformation.
    const fat = pinned === ev.stage ? ev.fat : 0;
    if (!evoInit) { evoInit = true; pet.setForm(pinned, fat); }
    else if (!pet.evo && (pet.form.stage !== pinned || pet.form.fat !== fat)) { if (pet.form.stage !== pinned) pet.evolveTo(pinned, fat); else pet.setForm(pinned, fat); }
    if (ev.stage > seen) {
      evoBubble = { title: `${pet.spec.name} grew into ${FORM_NAMES[ev.stage - 1]}!`, sub: `Still showing ${FORM_NAMES[pinned - 1]} — switch forms in Pets` };
      evoBubbleUntil = Date.now() + 10000;
      bridge.setSettings({ evolution: { stageSeen: ev.stage } });
    }
    return;
  }
  if (evoInit && !pet.evo && ev.stage > pet.form.stage && seen >= ev.stage) { pet.evolveTo(ev.stage, ev.fat); return; }   // back to the newest form after a pin: no "evolved!" note
  if (!evoInit) {
    evoInit = true;
    pet.setForm(seen, seen === ev.stage ? ev.fat : 0);                                           // show the form you last saw…
    if (ev.stage > seen) setTimeout(() => celebrateEvolution(ev, seen), 1500);                    // …and evolve if it grew while Tokkie was closed
  } else if (ev.stage > pet.form.stage && !pet.evo) celebrateEvolution(ev, pet.form.stage);
  else if (!pet.evo && ev.stage === pet.form.stage && ev.fat !== pet.form.fat) pet.setForm(ev.stage, ev.fat);
}
function celebrateEvolution(ev, fromStage) {
  const names = FORM_NAMES;
  pet.evolveTo(ev.stage, ev.fat);
  evoBubble = { title: `${pet.spec.name} evolved into ${names[ev.stage - 1]}!`, sub: `${names[fromStage - 1]} → ${names[ev.stage - 1]} · ate ${fmtTokens(ev.eaten)} tokens` };
  evoBubbleUntil = Date.now() + 10000;
  bridge.setSettings({ evolution: { stageSeen: ev.stage } });
}

// ------------------------------------------------------------------------------------- render
/** Keep pill elements stable (no flicker): update in place, add/remove only when the count changes. */
function renderPills(list) {
  while (pills.children.length > list.length) pills.lastChild.remove();
  list.forEach((p, i) => {
    let b = pills.children[i];
    if (!b) { b = document.createElement('button'); b.type = 'button'; b.className = 'pill'; b.innerHTML = '<span class="dot"></span><span class="ptext"></span>'; b.addEventListener('click', () => setMode('expanded')); pills.append(b); }
    const t = b.querySelector('.ptext'), dot = b.querySelector('.dot');
    if (t.textContent !== p.text) { t.textContent = p.text; t.classList.remove('swap'); void t.offsetWidth; t.classList.add('swap'); }
    dot.hidden = !p.dot; if (p.dot) dot.dataset.k = p.dot;
    b.title = p.title || '';
  });
}

/** The Dock: one line per thing you chose in Settings, skipping lines that have nothing to say yet. */
function dockLines(S, d, on = S.settings.dock || {}) {
  const now = S.now, out = [];
  const m = (S.meters || [])[0];
  const short = { five: '5-hour', seven: 'Weekly', extra: 'Usage', spend: 'Spend', budget: 'Budget' };
  if (on.usage !== false && m) {
    // A raw reading (no live estimate yet) can be hours old: say so instead of passing it off as "now".
    const age = now - (m.readAt || now), old = !m.approx && m.source !== 'estimate' && age > 30 * 60e3;
    const v = `${m.approx ? '≈' : ''}${Math.round(m.pct)}%` + (m.limitUsd ? ` · $${Math.round(m.usd)}/${Math.round(m.limitUsd)}` : '') + (old ? ` · ${fmtDur(age / 1000)} old` : '');
    const low = S.nextFit && S.nextFit.status !== 'ok' && S.nextFit.id === m.id;
    const needLimit = m.id === 'extra' && !m.limitUsd;
    out.push({ k: 'usage', label: short[m.id] || 'Usage', value: v, pill: `${m.approx ? '≈' : ''}${Math.round(m.pct)}% used` + (m.limitUsd ? ` · $${Math.round(m.usd)}` : '') + (old ? ` · ${fmtDur(age / 1000)} old` : ''), tone: low ? 'bad' : old ? '' : kindUsed(m.pct), dot: low ? 'bad' : old ? 'idle' : kindUsed(m.pct), title: `${m.label}${m.mode === 'dollars' ? ' — Claude Code part is exact dollars from the bridge' : m.approx ? ' — live estimate since Claude’s last reading' : old ? ` — Claude’s last reading, ${fmtDur(age / 1000)} ago. Open Claude → Settings → Usage to refresh it, or use Sync with Claude` : ''}${needLimit ? '. Enter your $ limit in Tokkie → Settings for dollars and a live estimate' : ''}` });
  }
  if (on.pace !== false && m && m.pace) {
    const p = m.pace, tone = p.tone === 'alert' ? 'bad' : p.tone === 'fast' ? 'warn' : 'good';
    const when = p.runOutAt ? new Date(p.runOutAt) : null;
    const whenTxt = when ? fmtRunOutShort(p.runOutAt, now) : '';
    const v = p.runOutAt ? `out ${whenTxt}` : p.pace > 0 ? `+${Math.round(p.pace)}% fast` : `${Math.round(-p.pace)}% under`;
    out.push({ k: 'pace', label: 'Pace', value: v, pill: v, tone, title: `${Math.round(m.pct)}% used with ${Math.round(p.elapsed)}% of the period gone${p.runOutAt ? ' — at this rate you run out before it resets' : ''}` });
  }
  if (on.status !== false) out.push({ k: 'status', label: 'Status', value: d.chipText, pill: d.chipText, tone: d.chipK === 'warn' ? 'warn' : '', dot: d.chipK === 'warn' ? 'warn' : S.active ? 'live' : null, title: d.text });
  const adv = on.next !== false ? chatAdvice(S.nextRun, now) : null;
  if (adv) out.push({ k: 'next', label: 'Next prompt', value: adv.value, pill: adv.value, tone: adv.tone, dot: adv.tone, title: `${adv.title}. ${adv.body}` });
  if (on.tokens !== false) out.push({ k: 'tokens', label: 'Today', pill: `${fmtTokens(S.tokens.today)} today`, value: fmtTokens(S.tokens.today) + (S.bridge && S.bridge.todayUsd >= 0.01 ? ` · $${S.bridge.todayUsd.toFixed(2)}` : ''), title: 'Tokens used today (Claude Code + Cowork)' + (S.bridge && S.bridge.todayUsd >= 0.01 ? '; dollars are exact Claude Code spend' : '') });
  if (on.lastPrompt !== false && S.lastPrompt && now - S.lastPrompt.at < 12 * 3600e3) out.push({ k: 'lastPrompt', label: 'Last prompt', value: `$${S.lastPrompt.usd.toFixed(2)}`, pill: `last $${S.lastPrompt.usd.toFixed(2)}`, title: 'Exact cost of your last Claude Code prompt' });
  if (on.context !== false && S.context && S.cache && now - S.cache.at < 3600e3) {
    const c = S.context, tone = c.tokens >= 300e3 ? 'bad' : c.tokens >= 100e3 ? 'warn' : '';
    out.push({ k: 'context', label: 'Context', value: fmtTokens(c.tokens) + (c.window ? ` / ${fmtTokens(c.window)}` : ''), pill: `ctx ${fmtTokens(c.tokens)}${c.window ? ` / ${fmtTokens(c.window)}` : ''}`, tone,
      title: c.tokens >= 300e3 ? 'Very long conversation — a fresh one is cheaper and sharper' : c.tokens >= 100e3 ? 'Getting long — /compact would make each reply cheaper' : 'How much the current conversation sends with every message' });
  }
  if (on.cache !== false && S.cache) {
    const left = S.cache.expiresAt - now;
    if (left > -30 * 60e3) {
      const v = left > 0 ? (left >= 60e3 ? `${Math.ceil(left / 60e3)}m left` : `${Math.ceil(left / 1000)}s left`) : 'expired';
      out.push({ k: 'cache', label: 'Cache', value: v, pill: `cache ${v}`, tone: left <= 0 ? 'bad' : left < 5 * 60e3 ? 'warn' : '', title: left > 0 ? 'Reply before this runs out and the conversation is re-read cheaply from cache' : 'The cache expired — the next message re-sends the whole conversation at full price' });
    }
  }
  if (on.agents !== false && S.agents > 0) out.push({ k: 'agents', label: 'Agents', value: `${S.agents} running`, pill: `${S.agents} agent${S.agents === 1 ? '' : 's'}`, dot: 'live', title: 'Sub-agents working right now' });
  return out;
}

function renderDock(lines) {
  const key = lines.map((l) => l.k).join(',');
  if (key !== dockKey) {
    dockKey = key;
    dockEl.replaceChildren(...lines.map((l) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'dline'; b.dataset.k = l.k;
      b.innerHTML = '<span class="dot" hidden></span><span class="dk"></span><span class="dv"></span>';
      b.addEventListener('click', () => setMode('expanded', l.k === 'status' ? 'plan' : 'usage'));
      return b;
    }));
  }
  lines.forEach((l, i) => {
    const b = dockEl.children[i]; if (!b) return;
    b.querySelector('.dk').textContent = l.label;
    const v = b.querySelector('.dv'); v.textContent = l.value; if (l.tone) v.dataset.k = l.tone; else delete v.dataset.k;
    const dot = b.querySelector('.dot'); dot.hidden = !l.dot; if (l.dot) dot.dataset.k = l.dot;
    b.title = l.title || '';
  });
}

/** One heads-up per limit when it passes 75% and 90% (levels already passed when Tokkie starts don't nag). */
function checkWarnings(S) {
  const levels = [75, 90];
  if (!warned) { warned = {}; for (const m of S.meters || []) warned[m.id] = levels.filter((l) => m.pct >= l).pop() || 0; return; }
  for (const m of S.meters || []) {
    const hit = levels.filter((l) => m.pct >= l).pop() || 0;
    if (hit > (warned[m.id] || 0)) {
      warnBubble = { id: m.id, hit, until: Date.now() + 12000 };   // its text is worked out on every render, so it never disagrees with the panel
      pet.emote('surprised', 1500);
    }
    if (hit < (warned[m.id] || 0) && m.pct < 70) warned[m.id] = 0;     // it reset: arm again
    else warned[m.id] = Math.max(warned[m.id] || 0, hit);
  }
}

const pctTxt = (x) => (x < 1 ? '<1' : String(Math.round(x)));
/** Plain words for "will it fit": needs ~X–Y% (or $) of a limit that has Z left. */
function fitWords(f) {
  const need = f.usd ? `$${f.usd.p50.toFixed(2)}–${f.usd.p75.toFixed(2)}` : `${pctTxt(f.need.p50)}–${pctTxt(f.need.p75)}%`;
  const left = f.usd ? `$${f.usd.left.toFixed(2)} (${pctTxt(f.left)}%)` : `${pctTxt(f.left)}%`;
  return { need, left, line: f.left <= 0.05 ? `${f.label} is used up` : `Needs ~${need} · ${left} of ${f.label} left` };
}
/** A prompt you estimated won't fit → red; might not → amber. Also warns once when even a typical prompt no longer fits. */
function checkFit(S) {
  const nf = S.nextFit;
  const st = nf ? nf.status : 'ok';
  if (st !== 'ok' && st !== lastNextFit && warned) {
    const w = fitWords(nf);
    fitAlert = { kind: st === 'no' ? 'done' : 'ask', title: st === 'no' ? 'Not enough left for your next prompt' : 'Running low — your next prompt may not fit', sub: w.line, until: Date.now() + 15000 };
    pet.emote('surprised', 1500);
  }
  lastNextFit = st;
}
// What each chip is, in plain words — shown when you hover it in the Claude bar.
const BAR_LABEL = { usage: 'Plan usage', pace: 'Pace', status: 'Claude', next: 'Next prompt', tokens: 'Today', lastPrompt: 'Last prompt', context: 'Conversation size', cache: 'Prompt cache', agents: 'Sub-agents' };
function barTip(l) {
  // the card's title already shows "Label: reading"; the body only says what it means
  const t = (l.title || '').trim();
  switch (l.k) {
    case 'usage': return (t.replace(/^[^—]*— ?/, '') || 'From Claude’s own usage readings') + '.';
    case 'status': return 'What Claude is doing right now.';
    case 'lastPrompt': return 'Exact cost of your last Claude Code prompt.';
    case 'agents': return 'Sub-agents working right now.';
    case 'next': return t;
    default: return t ? t.replace(/[.\s]*$/, '.') : '';
  }
}

/** The Claude bar is one row: shortest wording of each item (the icon says what it is). */
function barText(l) {
  const v = String(l.value);
  if (l.k === 'usage') return v.replace(/\/\d+( · |$)/, '$1');                       // ≈58% · $115/200 → ≈58% · $115
  if (l.k === 'pace') return v.replace('out today ', 'out ').replace('out tomorrow ', 'out tmrw ');   // the bar is one tight row
  if (l.k === 'status') return v.replace(/ · (\d+\w*)( \d+s)? ago$/, ' $1');   // Done · 1m 19s ago → Done 1m
  if (l.k === 'context') return v.replace(/ · \d+%$/, '');
  if (l.k === 'cache') return v.replace(' left', '');
  if (l.k === 'agents') return v.replace(' running', '');
  if (l.k === 'next') return v.replace(/ next$/, '');
  return v;
}

/**
 * The Claude bar shows every item switched on in Settings, each as an icon and a short reading ("93%", "390k");
 * the full reading and what it means are in the capsule's hover card. The chat items (size, cache, next prompt)
 * are about the chat the bar sits in: Tokkie sends them for each recent chat and the bridge picks its own.
 */
const CHAT_KEYS = ['context', 'cache', 'next'];
function shortValue(l) {
  const v = barText(l);
  switch (l.k) {
    case 'usage': case 'tokens': return v.split(' · ')[0];                       // ≈93% · $185 → ≈93%
    case 'pace': return /^out /.test(v) ? v.slice(4) : v.replace(/ (fast|under)$/, '');
    case 'status': return v.split(' ')[0];                                        // Done 1m → Done
    case 'context': return v.split(' / ')[0];
    default: return v;
  }
}
const barItem = (l) => ({ k: l.k, label: BAR_LABEL[l.k] || l.label, value: barText(l), short: shortValue(l), tone: l.tone, tip: barTip(l) });
function barItems(S, lines) {
  const out = [];
  const fit = fitAlert && Date.now() < fitAlert.until ? `${fitAlert.title}: ${fitAlert.sub}.` : S.nextFit && S.nextFit.status !== 'ok' ? `${S.nextFit.status === 'no' ? 'Not enough left for a typical prompt' : 'Running low'}: ${fitWords(S.nextFit).line}.` : '';
  if (fit) out.push({ k: 'alert', label: 'Heads-up', value: fit.replace(/\.$/, ''), short: '', tone: 'bad', tip: '' });
  for (const l of lines) out.push(barItem(l));
  return out;
}
/** One chat's own items, in the Dock's format (so they read the same everywhere). */
function chatLines(r, now, on = {}) {
  if (!r) return [];
  const out = [], ctx = r.ctx, left = r.expiresAt - now;
  if (on.next !== false) { const adv = chatAdvice(r, now); if (adv) out.push({ k: 'next', label: 'Next prompt', value: adv.value, tone: adv.tone, title: `${adv.title}. ${adv.body}` }); }
  if (on.context !== false) out.push({ k: 'context', label: 'Context', value: fmtTokens(ctx), tone: ctx >= 300e3 ? 'bad' : ctx >= 100e3 ? 'warn' : '',
    title: ctx >= 300e3 ? 'Very long conversation — a fresh one is cheaper and sharper' : ctx >= 100e3 ? 'Getting long — /compact would make each reply cheaper' : 'How much the current conversation sends with every message' });
  if (on.cache !== false && left > -30 * 60e3) {
    const v = left > 0 ? (left >= 60e3 ? `${Math.ceil(left / 60e3)}m left` : `${Math.ceil(left / 1000)}s left`) : 'expired';
    out.push({ k: 'cache', label: 'Cache', value: v, tone: left <= 0 ? 'bad' : left < 5 * 60e3 ? 'warn' : '', title: left > 0 ? 'Reply before this runs out and the conversation is re-read cheaply from cache' : 'The cache expired — the next message re-sends the whole conversation at full price' });
  }
  return out;
}

function bandAlert(S) {
  if (fitAlert && Date.now() < fitAlert.until) return `${fitAlert.title} — ${fitAlert.sub}`;
  const nf = S.nextFit;
  if (nf && nf.status !== 'ok') return `${nf.status === 'no' ? 'Not enough left for a typical prompt' : 'Running low'} — ${fitWords(nf).line}`;
  const adv = chatAdvice(S.nextRun, S.now);
  if (adv && adv.tone === 'bad') return adv.alert;
  return '';
}

function applyLayout() {
  const want = ['dock', 'pills', 'pet'].includes(S.settings.layout) ? S.settings.layout : 'dock';
  const where = ['below', 'above', 'claude'].includes(S.settings.dockPlace) ? S.settings.dockPlace : 'below';
  const collapsed = mode !== 'expanded';
  pills.hidden = !collapsed || want !== 'pills';
  dockEl.hidden = !collapsed || want !== 'dock' || where === 'claude';
  appEl.dataset.layout = want; appEl.dataset.place = where;
  let relayout = want !== layout || where !== place;
  layout = want; place = where;
  if (!dockEl.hidden) { const h = dockEl.offsetHeight; if (Math.abs(h - dockH) > 1) { dockH = h; relayout = true; } }
  if (!pills.hidden) { const h = pills.offsetHeight; if (h && Math.abs(h - pillsH) > 1) { pillsH = h; relayout = true; } }
  if (relayout && collapsed && booted) sendLayout();
}

/** Apply the remembered panel size (and keep the CSS in step). */
function applyPanelSize(w, h) {
  PANEL_W = Math.max(336, Math.min(760, Math.round(w))); PANEL_H = Math.max(420, Math.min(1100, Math.round(h)));
  document.documentElement.style.setProperty('--panel-w', PANEL_W + 'px'); document.documentElement.style.setProperty('--panel-h', PANEL_H + 'px');
}
let resizing = null;
function render() {
  if (!S) return;
  if (!resizing) { const wv = S.settings.window || {}; if ((wv.panelW || 336) !== PANEL_W || (wv.panelH || 504) !== PANEL_H) { applyPanelSize(wv.panelW || 336, wv.panelH || 504); if (booted && mode === 'expanded') sendLayout(); } }
  pet.setPersonality(S.settings.personality || 'cheerful');
  applyTheme(S.settings);
  const { active, saved } = S.settings.monsters;
  const ev = S.evolution || { stage: 2, fat: 0, name: 'Junior', eaten: 0 };
  if (active !== seedShown) {
    seedShown = active; const spec = pet.setSeed(active);
    $('#petName').textContent = spec.name;
    document.documentElement.style.setProperty('--h', oklchHue(spec.palette.body));
    pet.setForm(pet.form.stage, pet.form.fat);
  }
  syncEvolution(ev);
  if (pet.scale !== S.settings.scale) { pet.setScale(S.settings.scale); sendLayout(); }

  if (lastEnd !== null && (S.lastTurnEnd || 0) > lastEnd) doneUntil = S.now + 4000;   // first state only sets the baseline, so a turn finishing right after launch still celebrates
  lastEnd = S.lastTurnEnd || 0;
  if (prevLast5h != null && S.tokens.last5h > prevLast5h) pet.feed(clamp(Math.round((S.tokens.last5h - prevLast5h) / 1500), 1, 10));
  prevLast5h = S.tokens.last5h;
  pet.intensity = clamp(S.tokens.burn / 3000, 1, 3);

  const d = describe(S);
  checkWarnings(S);
  checkFit(S);
  if (acked.doneEnd === null) acked = { doneEnd: S.lastTurnEnd || 0, ask: null };       // first state is the baseline: old finishes don't alert
  const enabled = S.settings.alertBubble !== false;
  const al = forced && Date.now() < forced.until ? { kind: forced.kind, since: S.now - 150000, quietMs: 90000 } : alertState(S, acked, enabled);
  const showBubble = S.settings.speechBubble !== false;
  if (al && al.kind === 'ask') { d.chipText = `Needs you? · quiet ${fmtDur(al.quietMs / 1000)}`; d.chipK = 'warn'; }   // one story: the chip, Dock and bubble agree
  if (optBubble && Date.now() < optBubble.until && mode !== 'expanded') {
    bubbleEl.hidden = false; bubbleEl.dataset.kind = 'opt'; bubbleTitle.textContent = optBubble.title;
    bubbleSub.textContent = optBubble.undo ? 'Click to undo' : optBubble.sub;
  } else if (al && mode !== 'expanded') {
    d.mood = al.kind === 'done' ? 'alert' : 'ask';
    bubbleEl.hidden = !showBubble; bubbleEl.dataset.kind = al.kind;
    if (al.kind === 'done') { bubbleTitle.textContent = 'Done — awaiting your response'; bubbleSub.textContent = `${fmtDur((S.now - al.since) / 1000)} ago · click to dismiss`; }
    else { bubbleTitle.textContent = 'May need your approval'; bubbleSub.textContent = `Quiet for ${fmtDur(al.quietMs / 1000)} · click to dismiss`; }
  } else if (fitAlert && Date.now() < fitAlert.until && mode !== 'expanded') {
    // never silenced by the speech-bubble switch: this is the one you asked for
    d.mood = fitAlert.kind === 'done' ? 'stress' : d.mood;
    bubbleEl.hidden = false; bubbleEl.dataset.kind = fitAlert.kind; bubbleTitle.textContent = fitAlert.title; bubbleSub.textContent = fitAlert.sub;
  } else if (warnBubble && Date.now() < warnBubble.until && mode !== 'expanded' && showBubble) {
    const wm = (S.meters || []).find((x) => x.id === warnBubble.id);
    bubbleEl.hidden = false; bubbleEl.dataset.kind = 'ask';
    bubbleTitle.textContent = wm ? `${wm.label}: ${Math.round(wm.pct)}% used` : 'Running low';
    bubbleSub.textContent = wm && wm.pace && wm.pace.runOutAt ? `At this pace you run out ${fmtRunOut(wm.pace.runOutAt, S.now)}` : warnBubble.hit >= 90 ? 'Nearly out — save it for what matters' : 'Three quarters gone';
  } else if (Date.now() < evoBubbleUntil && evoBubble && mode !== 'expanded' && showBubble) {
    bubbleEl.hidden = false; bubbleEl.dataset.kind = 'evo'; bubbleTitle.textContent = '✨ ' + evoBubble.title; bubbleSub.textContent = evoBubble.sub;
  } else bubbleEl.hidden = true;
  pet.setMood(d.mood);
  renderPills(d.pillList);
  const lines = S.settings.layout === 'dock' ? dockLines(S, d) : null;
  if (lines) renderDock(lines);
  const stripLines = S.settings.strip ? lines || dockLines(S, d) : null;
  if (stripLines) bridge.ui.strip?.({ items: stripLines.map((l) => ({ k: l.k, label: BAR_LABEL[l.k] || l.label, value: barText(l), tone: l.tone, tip: barTip(l) })), alert: bandAlert(S) });
  applyLayout();
  const inClaude = !!lines && place === 'claude';
  const chats = {};
  if (inClaude) for (const [id, r] of Object.entries(S.chats || {})) chats[id] = chatLines(r, S.now, S.settings.dock || {}).map(barItem);
  bridge.ui.band?.({ show: inClaude, items: inClaude ? barItems(S, lines) : [], chats, alert: '' });
  chip.textContent = d.chipText; chip.dataset.k = d.chipK;
  $('#petTraits').textContent = ev.eaten < 1000 ? `${ev.name} · just hatched` : `${ev.name} · ${fmtTokens(ev.eaten)} eaten`;

  if (mode === 'expanded') { for (const t of TABS) if (t === tab) views[t].update(S); }
  else views.usage.update(S);
  views.settings.update(S); views.pets.update(S);
  views.plan.update(S);
}

// ------------------------------------------------------------------------------------- layout
function petCss() { return { w: parseFloat(canvas.style.width), h: parseFloat(canvas.style.height) }; }
function layoutPayload(initial) {
  const { w: sw, h: sh } = petCss();
  let cw = Math.max(sw + 2 * MARGIN, 340), ch = MARGIN + BUBBLE_ZONE + sh + GAP + pillsH + MARGIN, cy = MARGIN + BUBBLE_ZONE;
  const cx = Math.round((cw - sw) / 2);
  if (layout === 'pet' || (layout === 'dock' && place === 'claude')) ch = MARGIN + BUBBLE_ZONE + sh + MARGIN;
  else if (layout === 'dock') {
    // the Dock card sits under the pet, or above it (then the pet and its bubble sit below the card)
    ch = MARGIN + BUBBLE_ZONE + sh + GAP + dockH + MARGIN;
    // the bubble floats over the Dock, and the pet's empty headroom (particles only) tucks under the card
    if (place === 'above') { ch = MARGIN + dockH + GAP - TUCK + sh + MARGIN; cy = MARGIN + dockH + GAP - TUCK; }
  }
  const ew = PANEL_W + 2 * MARGIN, eh = MARGIN + BUBBLE_ZONE + sh + GAP + PANEL_H + MARGIN;
  const rect = (w, y) => ({ x: Math.round((w - sw) / 2), y, w: sw, h: sh });
  return { initial: !!initial, mode,
    collapsed: { w: cw, h: ch, pet: { x: cx, y: cy, w: sw, h: sh } },
    below: { w: ew, h: eh, pet: rect(ew, MARGIN + BUBBLE_ZONE) },
    above: { w: ew, h: eh, pet: rect(ew, MARGIN + PANEL_H + GAP + BUBBLE_ZONE) } };
}
let layoutChain = Promise.resolve();
/** Layout calls are serialised: rapid clicks must not apply placements out of order. */
function sendLayout(initial) {
  const run = async () => { const r = await bridge.ui.layout(layoutPayload(initial)); appEl.className = r.placement; return r; };
  const p = layoutChain.then(run, run); layoutChain = p.catch(() => {}); return p;
}

function ackNow() { if (S) { acked = acknowledge(S, acked); forced = null; render(); } }
bubbleEl.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (optBubble && Date.now() < optBubble.until) { const undo = optBubble.undo; optBubble = null; if (undo) await bridge.ui.undoOptimize(); render(); return; }
  ackNow();
});

async function setMode(next, toTab) {
  if (next === 'expanded') ackNow();       // opening the panel means you've seen it
  if (toTab) tab = toTab;
  if (next === mode && !toTab) return;
  mode = next;
  const r = await sendLayout();
  appEl.className = mode === 'expanded' ? r.placement : 'below'; appEl.dataset.mode = mode;
  panel.hidden = mode !== 'expanded'; applyLayout(); stage.setAttribute('aria-expanded', String(mode === 'expanded'));
  if (mode === 'expanded') { selectTab(tab); $(`#tab-${tab}`).focus({ preventScroll: true }); } else if (document.activeElement && panel.contains(document.activeElement)) stage.focus({ preventScroll: true });
  views.pets.setActive(mode === 'expanded' && tab === 'pets');
}

function selectTab(t) {
  tab = t;
  for (const name of TABS) {
    $(`#tab-${name}`).setAttribute('aria-selected', String(name === t));
    $(`#tab-${name}`).tabIndex = name === t ? 0 : -1;
    $(`#view-${name}`).hidden = name !== t;
  }
  views.pets.setActive(t === 'pets');
  if (S) views[t].update(S);
  if (t === 'settings') views.settings.refreshSetup();
}

// Re-fit the pixel grid when the window moves between displays with different pixel density; pause drawing while hidden.
(function watchDpr() { const mq = matchMedia(`(resolution: ${devicePixelRatio}dppx)`); mq.addEventListener('change', () => { pet.fit(); pet.draw(); sendLayout(); watchDpr(); }, { once: true }); })();
document.addEventListener('visibilitychange', () => { pet.visible = !document.hidden; });

// ------------------------------------------------------------------------------------- events
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
$('.tabs').addEventListener('keydown', (e) => {
  const i = TABS.indexOf(tab); const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
  if (n == null) return; e.preventDefault(); const t = TABS[(n + TABS.length) % TABS.length]; selectTab(t); $(`#tab-${t}`).focus();
});
$('#collapse').addEventListener('click', () => setMode('collapsed'));

// Resize the panel from any corner: dragging outward grows it. The pet stays put, so width grows evenly on both sides
// and height grows away from the pet — which is why a corner near the screen edge isn't a dead end any more.
const endResize = () => {
  if (!resizing) return; resizing = null; sendLayout();
  bridge.setSettings({ window: { panelW: PANEL_W, panelH: PANEL_H } });
};
for (const grip of document.querySelectorAll('.grip')) {
  const c = grip.dataset.c || 'br';
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    resizing = { x: e.screenX, y: e.screenY, w: PANEL_W, h: PANEL_H, sx: c.endsWith('l') ? -1 : 1, sy: c.startsWith('t') ? -1 : 1, t: 0 };
  });
  grip.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const dx = (e.screenX - resizing.x) * resizing.sx, dy = (e.screenY - resizing.y) * resizing.sy;
    applyPanelSize(resizing.w + dx * 2, resizing.h + dy);
    const now = performance.now(); if (now - resizing.t > 30) { resizing.t = now; sendLayout(); }
  });
  grip.addEventListener('pointerup', endResize); grip.addEventListener('pointercancel', endResize);
  grip.addEventListener('dblclick', () => { applyPanelSize(336, 504); sendLayout(); bridge.setSettings({ window: { panelW: 336, panelH: 504 } }); });
}

addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && tourStep >= 0) { endTour(); return; }
  if (e.key === 'Escape' && mode === 'expanded' && !e.defaultPrevented) setMode('collapsed');
});

// drag the pet anywhere; a click (no movement) toggles the panel
let drag = null;
stage.addEventListener('pointerdown', (e) => { if (e.button !== 0 || e.target.closest('#bubble')) return; try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic or released pointer */ } drag = { x: e.screenX, y: e.screenY, moved: false }; bridge.ui.dragStart(); });
stage.addEventListener('pointermove', (e) => {
  if (!drag) return; const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
  if (drag.moved) bridge.ui.dragMove({ dx, dy });
});
// Left-click plays with the pet; right-click opens/closes the panel; left-drag moves it.
stage.addEventListener('pointerup', () => { if (!drag) return; if (drag.moved) bridge.ui.dragEnd(); else { ackNow(); pet.poke(); } drag = null; });
stage.addEventListener('contextmenu', (e) => { e.preventDefault(); if (drag) { drag = null; } ackNow(); setMode(mode === 'expanded' ? 'collapsed' : 'expanded'); });
stage.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pet.poke(); setMode(mode === 'expanded' ? 'collapsed' : 'expanded'); } });
// Petting: hover for a couple of seconds and it falls in love.
let petTimer = null;
stage.addEventListener('pointerenter', () => { pet.hovered = true; clearTimeout(petTimer); petTimer = setTimeout(() => { if (!drag) pet.emote(pet.P.hover, 3800); }, pet.P.hoverMs); });
stage.addEventListener('pointerleave', () => { pet.hovered = false; clearTimeout(petTimer); });
stage.addEventListener('pointercancel', () => { drag = null; });

// click-through everywhere except our own pixels
let interactive = null;
const setInteractive = (v) => { if (v !== interactive) { interactive = v; bridge.ui.interactive(v); } };
document.addEventListener('mousemove', (e) => setInteractive(!!e.target.closest('[data-hit]') || (drag != null)));
document.documentElement.addEventListener('mouseleave', () => { if (!drag) setInteractive(false); });

bridge.onCursor((p) => {
  const r = stage.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height * 0.6;
  const dx = p.x - cx, dy = p.y - cy;
  // follow the cursor anywhere on screen: the direction matters, not the distance (it used to stop past 1400 px)
  const near = 24;                                          // right on top of the pet: look straight ahead
  pet.lookAt(Math.abs(dx) < near && Math.abs(dy) < near ? { x: 0, y: 0 } : { x: Math.max(-1, Math.min(1, dx / 90)), y: Math.max(-1, Math.min(1, dy / 90)) });
});
bridge.onCommand((c) => {
  if (c.type === 'open') setMode('expanded', c.tab);
  if (c.type === 'optToast') {        // clipboard Optimize (shortcut or the strip): say what happened next to the pet
    optBubble = { ...c, until: Date.now() + (c.kind === 'busy' ? 120000 : c.undo ? 12000 : 7000) };
    if (mode === 'expanded' && c.kind !== 'busy') views.plan.flash(`${c.title}${c.sub ? ` · ${c.sub}` : ''}`);
    pet.emote(c.kind === 'ok' ? 'love' : c.kind === 'warn' ? 'surprised' : 'work', c.kind === 'busy' ? 8000 : 1500);
    render();
  }
});
bridge.onEstimate((e) => {
  if (!e.result) { views.plan.flash('Your clipboard is empty — copy your prompt first (⌘C / Ctrl+C), then press the shortcut again.'); return; }
  bubble = { until: Date.now() + 25000, result: e.result };
  const f = e.result.fit;
  if (f && f.status !== 'ok') fitAlert = { kind: f.status === 'no' ? 'done' : 'ask', title: f.status === 'no' ? 'Not enough left for this prompt' : 'This prompt may not fit', sub: fitWords(f).line, until: Date.now() + 25000 };
  if (e.source === 'hotkey') views.plan.setResult(e.text, e.result);
  render();
});
bridge.onState((s) => { S = withEta(s); render(); firstRun(); });

function withEta(s) { return s; }
function firstRun() {
  if (welcomed || !S || S.settings.onboarded) return; welcomed = true;
  setTimeout(() => startTour(), 700);
}

// ------------------------------------------------------------------------------------- the tour
// Seven short steps over the real panel: each one opens its tab and points at it. Replay from Settings.
const tourEl = $('#tour');
let tourStep = -1;
function tourSteps() {
  const mac = S && S.platform === 'darwin', key = S ? prettyHotkey(S.settings.hotkey, mac) : '', optKey = S ? prettyHotkey(S.settings.optimizeHotkey || '', mac) : '';
  const name = pet.spec ? pet.spec.name : 'Tokkie';
  return [
    { tab: 'usage', title: `Hi, I’m ${name}!`, body: 'I sit on your desktop and keep an eye on your Claude usage. Click me to play, right-click me to open or close this panel, and drag me anywhere.' },
    { tab: 'usage', title: 'Usage', body: 'How much of your plan you’ve used, live, and when you’d run out at this pace. I’ll warn you at 75% and 90%.' },
    { tab: 'plan', title: 'Estimate', body: `Copy a prompt and press ${key} from anywhere: I’ll guess how long it runs and whether it fits before your “Done by” time.` },
    { tab: 'plan', title: 'Optimize', body: `Optimize asks Claude to rewrite a prompt so the run wastes fewer steps. Clearer makes it precise (it may get a bit longer); Shorter trims words. Pick Haiku, Sonnet or Opus to do the rewrite. It’s here, on every prompt in History and on the Claude bar. In Chat or Cowork: copy your prompt, press ${optKey}, then paste.` },
    { tab: 'history', title: 'History', body: 'Every prompt for 90 days, by day. Click one to read it in full, copy it, or reopen that chat in Claude.' },
    { tab: 'pets', title: 'Pets', body: 'I eat tokens and evolve. Collect pets, pick my personality, and hunt for the 6 secret ones.' },
    { tab: 'settings', title: 'Settings', body: 'Connect the Claude Code bridge for exact dollars, a bar above Claude’s prompt box and one-click Optimize. Using Chat or Cowork? Turn on the floating strip. You can replay this tour here any time.' },
  ];
}
function prettyHotkey(acc, mac) { return acc.split('+').map((k) => ({ CommandOrControl: mac ? '⌘' : 'Ctrl', Command: '⌘', Control: mac ? '⌃' : 'Ctrl', Alt: mac ? '⌥' : 'Alt', Shift: mac ? '⇧' : 'Shift' }[k] || k)).join(mac ? ' ' : ' + '); }
function startTour() { tourStep = 0; setMode('expanded', 'usage').then(drawTour); }
function endTour() {
  tourStep = -1; tourEl.hidden = true;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('tour-hl'));
  bridge.setSettings({ onboarded: true });
}
function drawTour() {
  const steps = tourSteps(), st = steps[tourStep];
  if (!st) { endTour(); return; }
  if (tab !== st.tab) selectTab(st.tab);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('tour-hl', b.dataset.tab === st.tab && tourStep > 0));
  const last = tourStep === steps.length - 1;
  const btn = (text, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = text; b.addEventListener('click', fn); return b; };
  const dots = document.createElement('div'); dots.className = 'tour-dots';
  steps.forEach((_, i) => { const d = document.createElement('i'); if (i === tourStep) d.className = 'on'; dots.append(d); });
  const h = document.createElement('strong'); h.textContent = st.title;
  const p = document.createElement('p'); p.textContent = st.body;
  const nav = document.createElement('div'); nav.className = 'tour-nav';
  nav.append(btn('Skip', 'btn sm quiet', endTour), dots,
    ...(tourStep > 0 ? [btn('Back', 'btn sm', () => { tourStep--; drawTour(); })] : []),
    btn(last ? 'Done' : 'Next', 'btn sm primary', () => { tourStep++; drawTour(); }));
  tourEl.replaceChildren(h, p, nav);
  tourEl.hidden = false;
  tourEl.querySelector('.btn.primary').focus({ preventScroll: true });
}

// ------------------------------------------------------------------------------------- boot
setInteractive(false);
try {
  S = await bridge.getState();
  render();
  await sendLayout(true);
  booted = true;
} catch (e) { console.error('boot failed', e); }
bridge.ui.ready();   // always reveal the window, even if something above failed
firstRun();
setInterval(() => { if (S) { try { S.now = Date.now(); render(); } catch (e) { console.error('render failed', e); } } }, 1000);

window.__tokkie = { pet, emotes: EMOTES, previewForm: (stage, fat = 0) => celebrateEvolution({ stage, fat, eaten: 0 }, pet.form.stage), forceAlert: (kind) => { forced = { kind, until: Date.now() + 8000 }; render(); }, startTour }; // handy for QA and the dev console
