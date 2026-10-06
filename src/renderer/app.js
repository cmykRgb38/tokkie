import { $, clamp, fmtDur, fmtClockDur, fmtTokens, fmtRange } from './util.js';
import { Pet, EMOTES } from './pet.js';
import { usageView, kindUsed } from './views/usage.js';
import { alertState, acknowledge } from './alerts.js';
import { planView } from './views/plan.js';
import { petsView } from './views/pets.js';
import { settingsView } from './views/settings.js';

if (!window.tokkie) await import('./dev/mock.js'); // opened in a plain browser: run against a mock backend
const bridge = window.tokkie;
const M = window.TokkieMonster;

const PANEL_W = 336, PANEL_H = 504, GAP = 6, MARGIN = 14, PILL_H = 30;
const TABS = ['usage', 'plan', 'pets', 'settings'];

const bubbleEl = $('#bubble'), bubbleTitle = $('#bubbleTitle'), bubbleSub = $('#bubbleSub');
const appEl = $('#app'), stage = $('#stage'), canvas = $('#pet'), pills = $('#pills');
const panel = $('#panel'), chip = $('#chip');
let evoInit = false, evoBubbleUntil = 0, evoBubble = null;
const BUBBLE_ZONE = 44;                       // headroom above the pet reserved for the attention bubble (matches #stage padding-top)
let acked = { doneEnd: null, ask: null }, forced = null;
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
  hide: () => bridge.ui.hide(), quit: () => bridge.ui.quit(),
};
const views = {
  usage: usageView($('#view-usage'), api), plan: planView($('#view-plan'), api),
  pets: petsView($('#view-pets'), api), settings: settingsView($('#view-settings'), api),
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
  else if (idleMs > 20 * 60e3) mood = 'sleep';
  else if (idleMs > 6 * 60e3) mood = 'bored';

  let text, dot = 'idle', chipText, chipK = '';
  const rest = [];
  if (bubble && now < bubble.until) {
    const r = bubble.result; const k = { go: 'good', tight: 'warn', stop: 'bad', over: 'bad' }[r.plan.verdict];
    text = `≈${fmtTokens(r.promptTokens)} tok · ${fmtRange(r.duration.p25, r.duration.p75)}`; dot = k;
  } else if (active) {
    const t = fmtClockDur(now - active.start); dot = 'live';
    const over = eta && (now - active.start) / 1000 > eta.p75;
    text = `Working ${t}` + (eta ? (over ? ' · longer than usual' : ` · usually ${fmtRange(eta.p25, eta.p75)}`) : ''); chipText = `Working ${t}`; chipK = 'live';
  } else {
    // At rest: separate pills so every number is readable at a glance — percentages used, like Claude's own Settings → Usage.
    const short = { five: '5h', seven: 'weekly', extra: 'usage', budget: 'budget' };
    meters.slice(0, 3).forEach((m, i) => {
      const age = Math.max(0, (now - m.readAt) / 1000);
      rest.push({ text: `${m.approx ? '≈' : ''}${Math.round(m.pct)}% ${i === 0 ? 'used' : short[m.id] || ''}`.trim(), dot: kindUsed(m.pct),
        title: `${m.label} — ${m.source === 'estimate' ? 'from your token budget' : m.approx && m.baseline != null ? 'live estimate; Claude said ' + Math.round(m.baseline) + '% ' + fmtDur(age) + ' ago' : age < 90 ? 'just now' : 'last Claude reading ' + fmtDur(age) + ' ago'}` });
    });
    rest.push({ text: `${fmtTokens(S.tokens.today)} today`, title: 'Tokens used today (Claude Code + Cowork)' });
    if (rest.length > 3) rest.splice(2, 1);          // keep the row to three pills: drop the third meter before the token count
    text = rest.map((p) => p.text).join(' · '); dot = primary ? kindUsed(primary.pct) : 'idle';
  }

  if (!chipText) {
    if (now < doneUntil) chipText = 'Done!';
    else if (S.lastTurnEnd && now - S.lastTurnEnd < 3600e3) chipText = `Done · ${fmtDur((now - S.lastTurnEnd) / 1000)} ago`;
    else chipText = mood === 'sleep' ? 'Sleeping' : 'Idle';
  }
  const pillList = rest.length ? rest : [{ text, dot, title: '' }];   // working / estimate states pin a single status pill
  return { mood, text, dot, chipText, chipK, eta, pillList };
}

// ------------------------------------------------------------------------------------- evolution
function syncEvolution(ev) {
  const seen = Math.max(1, Math.min(ev.stage, (S.settings.evolution && S.settings.evolution.stageSeen) || 1));
  if (!evoInit) {
    evoInit = true;
    pet.setForm(seen, seen === ev.stage ? ev.fat : 0);                                           // show the form you last saw…
    if (ev.stage > seen) setTimeout(() => celebrateEvolution(ev, seen), 1500);                    // …and evolve if it grew while Tokkie was closed
  } else if (ev.stage > pet.form.stage && !pet.evo) celebrateEvolution(ev, pet.form.stage);
  else if (!pet.evo && ev.stage === pet.form.stage && ev.fat !== pet.form.fat) pet.setForm(ev.stage, ev.fat);
}
function celebrateEvolution(ev, fromStage) {
  const names = ['Hatchling', 'Junior', 'Champion', 'Mega'];
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

function render() {
  if (!S) return;
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
  $('#petTraits').textContent = `${ev.name} · ${fmtTokens(ev.eaten)} eaten`;
  if (pet.scale !== S.settings.scale) { pet.setScale(S.settings.scale); sendLayout(); }

  if (lastEnd !== null && (S.lastTurnEnd || 0) > lastEnd) doneUntil = S.now + 4000;   // first state only sets the baseline, so a turn finishing right after launch still celebrates
  lastEnd = S.lastTurnEnd || 0;
  if (prevLast5h != null && S.tokens.last5h > prevLast5h) pet.feed(clamp(Math.round((S.tokens.last5h - prevLast5h) / 1500), 1, 10));
  prevLast5h = S.tokens.last5h;
  pet.intensity = clamp(S.tokens.burn / 3000, 1, 3);

  const d = describe(S);
  if (acked.doneEnd === null) acked = { doneEnd: S.lastTurnEnd || 0, ask: null };       // first state is the baseline: old finishes don't alert
  const enabled = S.settings.alertBubble !== false;
  const al = forced && Date.now() < forced.until ? { kind: forced.kind, since: S.now - 150000, quietMs: 90000 } : alertState(S, acked, enabled);
  const showBubble = S.settings.speechBubble !== false;
  if (al && mode !== 'expanded') {
    d.mood = al.kind === 'done' ? 'alert' : 'ask';
    bubbleEl.hidden = !showBubble; bubbleEl.dataset.kind = al.kind;
    if (al.kind === 'done') { bubbleTitle.textContent = 'Done — awaiting your response'; bubbleSub.textContent = `${fmtDur((S.now - al.since) / 1000)} ago · click to dismiss`; }
    else { bubbleTitle.textContent = 'Quiet for ' + fmtDur(al.quietMs / 1000) + ' — may need your approval'; bubbleSub.textContent = 'click to dismiss'; }
  } else if (Date.now() < evoBubbleUntil && evoBubble && mode !== 'expanded' && showBubble) {
    bubbleEl.hidden = false; bubbleEl.dataset.kind = 'evo'; bubbleTitle.textContent = '✨ ' + evoBubble.title; bubbleSub.textContent = evoBubble.sub;
  } else bubbleEl.hidden = true;
  pet.setMood(d.mood);
  renderPills(d.pillList);
  chip.textContent = d.chipText; chip.dataset.k = d.chipK;

  if (mode === 'expanded') { for (const t of TABS) if (t === tab) views[t].update(S); }
  else views.usage.update(S);
  views.settings.update(S); views.pets.update(S);
  views.plan.update(S);
}

// ------------------------------------------------------------------------------------- layout
function petCss() { return { w: parseFloat(canvas.style.width), h: parseFloat(canvas.style.height) }; }
function layoutPayload(initial) {
  const { w: sw, h: sh } = petCss();
  const cw = Math.max(sw + 2 * MARGIN, 340), ch = MARGIN + BUBBLE_ZONE + sh + GAP + PILL_H + MARGIN;
  const ew = PANEL_W + 2 * MARGIN, eh = MARGIN + BUBBLE_ZONE + sh + GAP + PANEL_H + MARGIN;
  const rect = (w, y) => ({ x: Math.round((w - sw) / 2), y, w: sw, h: sh });
  return { initial: !!initial, mode,
    collapsed: { w: cw, h: ch, pet: rect(cw, MARGIN + BUBBLE_ZONE) },
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
bubbleEl.addEventListener('click', (e) => { e.stopPropagation(); ackNow(); });

async function setMode(next, toTab) {
  if (next === 'expanded') ackNow();       // opening the panel means you've seen it
  if (toTab) tab = toTab;
  if (next === mode && !toTab) return;
  mode = next;
  const r = await sendLayout();
  appEl.className = mode === 'expanded' ? r.placement : 'below'; appEl.dataset.mode = mode;
  panel.hidden = mode !== 'expanded'; pills.hidden = mode === 'expanded'; stage.setAttribute('aria-expanded', String(mode === 'expanded'));
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
  if (n == null) return; e.preventDefault(); const t = TABS[(n + 4) % 4]; selectTab(t); $(`#tab-${t}`).focus();
});
$('#collapse').addEventListener('click', () => setMode('collapsed'));

addEventListener('keydown', (e) => { if (e.key === 'Escape' && mode === 'expanded' && !e.defaultPrevented) setMode('collapsed'); });

// drag the pet anywhere; a click (no movement) toggles the panel
let drag = null;
stage.addEventListener('pointerdown', (e) => { if (e.button !== 0 || e.target.closest('#bubble')) return; try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic or released pointer */ } drag = { x: e.screenX, y: e.screenY, moved: false }; bridge.ui.dragStart(); });
stage.addEventListener('pointermove', (e) => {
  if (!drag) return; const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
  if (drag.moved) bridge.ui.dragMove({ dx, dy });
});
stage.addEventListener('pointerup', () => { if (!drag) return; if (drag.moved) bridge.ui.dragEnd(); else { ackNow(); pet.poke(); setMode(mode === 'expanded' ? 'collapsed' : 'expanded'); } drag = null; });
stage.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pet.poke(); setMode(mode === 'expanded' ? 'collapsed' : 'expanded'); } });
// Petting: hover for a couple of seconds and it falls in love.
let petTimer = null;
stage.addEventListener('pointerenter', () => { clearTimeout(petTimer); petTimer = setTimeout(() => { if (!drag) pet.emote('love', 3800); }, 2200); });
stage.addEventListener('pointerleave', () => clearTimeout(petTimer));
stage.addEventListener('pointercancel', () => { drag = null; });

// click-through everywhere except our own pixels
let interactive = null;
const setInteractive = (v) => { if (v !== interactive) { interactive = v; bridge.ui.interactive(v); } };
document.addEventListener('mousemove', (e) => setInteractive(!!e.target.closest('[data-hit]') || (drag != null)));
document.documentElement.addEventListener('mouseleave', () => { if (!drag) setInteractive(false); });

bridge.onCursor((p) => {
  const r = stage.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height * 0.6;
  const dx = p.x - cx, dy = p.y - cy;
  pet.lookAt(Math.hypot(dx, dy) > 1400 ? { x: 0, y: 0 } : { x: dx / 55, y: dy / 55 });
});
bridge.onCommand((c) => { if (c.type === 'open') setMode('expanded', c.tab); });
bridge.onEstimate((e) => {
  if (!e.result) { views.plan.flash('Your clipboard is empty — copy your prompt first (⌘C / Ctrl+C), then press the shortcut again.'); return; }
  bubble = { until: Date.now() + 25000, result: e.result };
  if (e.source === 'hotkey') views.plan.setResult(e.text, e.result);
  render();
});
bridge.onState((s) => { S = withEta(s); render(); firstRun(); });

function withEta(s) { return s; }
function firstRun() {
  if (welcomed || !S || S.settings.onboarded) return; welcomed = true;
  setTimeout(() => setMode('expanded', 'usage'), 700);
}

// ------------------------------------------------------------------------------------- boot
setInteractive(false);
try {
  S = await bridge.getState();
  render();
  await sendLayout(true);
} catch (e) { console.error('boot failed', e); }
bridge.ui.ready();   // always reveal the window, even if something above failed
firstRun();
setInterval(() => { if (S) { try { S.now = Date.now(); render(); } catch (e) { console.error('render failed', e); } } }, 1000);

window.__tokkie = { pet, emotes: EMOTES, previewForm: (stage, fat = 0) => celebrateEvolution({ stage, fat, eaten: 0 }, pet.form.stage), forceAlert: (kind) => { forced = { kind, until: Date.now() + 8000 }; render(); } }; // handy for QA and the dev console
