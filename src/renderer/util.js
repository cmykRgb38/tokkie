export const $ = (s, r = document) => r.querySelector(s);

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') n.style.cssText = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
}
export const icon = (id) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'ic'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', `#i-${id}`); s.append(u); return s; };

export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (a < 1e6) return Math.round(n / 1000) + 'k';
  if (a < 1e7) return (n / 1e6).toFixed(2).replace(/0$/, '').replace(/\.0$/, '') + 'M';
  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** 75 → "1m 15s"; 3700 → "1h 02m" */
export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (sec < 600) { const s = sec % 60; return `${Math.floor(sec / 60)}m${s ? ' ' + String(s).padStart(2, '0') + 's' : ''}`; }
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h}h ${String(mm).padStart(2, '0')}m` : `${h}h`;
}
/** Stopwatch: 134 → "2:14" */
export const fmtClockDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Compact human range: (540, 1080) → "9–18 min"; (20, 50) → "20–50 sec"; (4000, 9000) → "1.1–2.5 hr" */
export function fmtRange(loSec, hiSec) {
  if (hiSec < 90) { const lo = Math.round(loSec), hi = Math.round(hiSec); return lo >= hi ? `~${hi} sec` : `${Math.max(1, lo)}–${hi} sec`; }
  if (hiSec >= 5400) { const h = (x) => (x / 3600).toFixed(1).replace(/\.0$/, ''); return h(loSec) === h(hiSec) ? `~${h(hiSec)} hr` : `${h(loSec)}–${h(hiSec)} hr`; }
  const lo = Math.max(1, Math.round(loSec / 60)), hi = Math.round(hiSec / 60);
  return lo >= hi ? `~${hi} min` : `${lo}–${hi} min`;
}
export const fmtTime = (ms) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
export const fmtPct = (p) => (p < 1 && p > 0 ? '<1' : p >= 99.5 ? '100' : String(Math.round(p)));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Forgiving time parser: "6:30pm", "18.30", "1830", "6pm", "18" → "18:30" (24h string) or null. */
export function parseTime(input) {
  const m = /^\s*(\d{1,2})(?:[:.\s]?(\d{2}))?\s*([ap])?\.?m?\.?\s*$/i.exec(String(input || ''));
  if (!m) return null;
  let h = +m[1]; const min = m[2] ? +m[2] : 0;
  if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0); }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
/** "18:30" → local-time label (respecting the user's 12/24h preference). */
export function labelForHHMM(hhmm) { const [h, m] = hhmm.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return fmtTime(d.getTime()); }

/** When a limit runs out, said one way everywhere: "today 7:50 pm", "tomorrow 9:10 am" or "Sat 10 Oct, 7:50 am" (to 10 minutes). */
export function fmtRunOut(ts, now = Date.now()) {
  const d = new Date(Math.round(ts / 600e3) * 600e3);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
  const days = Math.floor((d.getTime() - day0.getTime()) / 86400e3);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}
/** Short form for tight spots (Dock, Claude bar): "today 7:50 pm" / "Sat 10 Oct". */
export function fmtRunOutShort(ts, now = Date.now()) {
  const f = fmtRunOut(ts, now);
  return /^(today|tomorrow)/.test(f) ? f : f.split(',')[0];
}

const usd = (v) => (v < 0.01 ? '<$0.01' : v < 10 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`);
/**
 * Plain words for what the chat you're in adds to a prompt's cost (engine's `chat` / `nextRun`): every step re-reads
 * the whole conversation, and an expired cache makes the first step re-write all of it. null when it doesn't matter.
 */
export function chatAdvice(c, now = Date.now(), { prompt = false } = {}) {
  if (!c) return null;
  const times = Math.max(1, c.times || 1), big = times >= 2, coldBig = c.cold && c.ctx >= 50e3;
  if (!big && !coldBig) return null;
  const size = fmtTokens(c.ctx), where = c.where ? ` (${c.where}${c.source === 'cowork' ? ' · Cowork' : ''})` : '';
  const soon = !c.cold && c.expiresAt - now < 10 * 60e3 ? Math.max(1, Math.ceil((c.expiresAt - now) / 60e3)) : 0;
  const here = c.cost ? `≈ ${usd(c.cost.p50)}` : '', fresh = c.newCost ? `≈ ${usd(c.newCost.p50)}` : '';
  const title = c.cold ? `Cache expired on this ${size} chat` : `This ${size} chat makes prompts ~${Math.round(times)}× pricier`;
  const body = `Your current chat${where} is ${size} tokens, and every step of a run re-reads all of it.`
    + (c.cold ? ` Its cache has expired, so the first step also re-writes all ${size} at full price.` : soon ? ` Its cache expires in ${soon} min: send soon, or start fresh.` : '')
    + (here && fresh ? ` ${prompt ? 'This prompt' : 'A typical run'} here ${here}; in a new chat ${fresh}.` : ` About ${Math.round(times)}× the usage of the same prompt in a new chat.`)
    + ' In Claude Code type /clear (fresh) or /compact (keeps a summary); in Chat or Cowork start a new chat.';
  const value = here || `~${Math.round(times)}× new chat`;
  const alert = c.cold ? `Cache expired on this ${size} chat: the next message re-writes it all${here ? ` (${here})` : ''}. /compact or a new chat is cheaper.`
    : `This ${size} chat makes each prompt ~${Math.round(times)}× pricier than a new one${here ? ` (${here} vs ${fresh})` : ''}.`;
  return { title, body, value, alert, tone: c.cold || times >= 5 ? 'bad' : 'warn', usd };
}
