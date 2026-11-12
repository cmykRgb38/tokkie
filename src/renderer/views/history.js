import { el, icon, fmtTokens, fmtDur } from '../util.js';
import { runCards } from './runs.js';
import { Pet } from '../pet.js';

const shortDate = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
const hourLabel = (h) => { const f = (x) => new Date(2000, 0, 1, x % 24).toLocaleTimeString([], { hour: 'numeric' }); return `${f(h)}–${f(h + 1)}`; };
const vsText = (v) => (v == null ? '' : v === 0 ? '= same' : `${v > 0 ? '▲' : '▼'} ${Math.abs(v)}%`);

/**
 * The weekly recap card: a week of runs at a glance, compared with the week before, with ‹ › to look back.
 * No prompts and no folder names on it, so "Copy as image" is safe to paste to friends.
 */
function recapCard(api) {
  let offset = 0, R = null, S = null, busy = false, key = '';
  const title = el('div', { class: 'rc-title' }), sub = el('div', { class: 'rc-sub' });
  const prev = el('button', { class: 'btn sm quiet rc-nav', type: 'button', 'aria-label': 'Earlier week', text: '‹', onclick: () => go(offset + 1) });
  const next = el('button', { class: 'btn sm quiet rc-nav', type: 'button', 'aria-label': 'Later week', text: '›', onclick: () => go(offset - 1) });
  const petCv = el('canvas', { class: 'rc-pet', 'aria-hidden': 'true' }); const pet = new Pet(petCv, { scale: 2, spriteOnly: true }); let petKey = '';
  const stats = el('div', { class: 'rc-stats' });
  const chart = el('div', { class: 'rc-chart', role: 'img' });
  const facts = el('ul', { class: 'rc-facts' });
  const brand = el('div', { class: 'rc-brand', text: 'Tokkie' });
  const copy = el('button', { class: 'btn sm rc-copy', type: 'button' }, icon('clip'), el('span', { text: 'Copy as image' }));
  const msg = el('span', { class: 'muted rc-msg', 'aria-live': 'polite' });
  const card = el('section', { class: 'recap', 'aria-label': 'Weekly recap' },
    el('div', { class: 'rc-head' }, petCv, el('div', { class: 'rc-titles' }, title, sub), el('div', { class: 'rc-navs' }, prev, next)),
    stats, chart, facts, el('div', { class: 'rc-foot' }, brand, msg, copy));

  async function go(o) { offset = Math.max(0, Math.min(12, o)); await load(); }
  async function load() {
    if (busy) return; busy = true;
    try { R = await api.recap(offset); } finally { busy = false; }
    draw();
  }
  copy.addEventListener('click', async () => {
    card.scrollIntoView({ block: 'nearest' });
    card.classList.add('shot');                         // the picture leaves out the buttons
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b = card.getBoundingClientRect();
    let ok = false;
    try { ok = !!(await api.copyImage({ x: b.left, y: b.top, width: b.width, height: b.height })).ok; } finally { card.classList.remove('shot'); }
    msg.textContent = ok ? 'Copied: paste it anywhere' : 'Couldn’t copy the picture';
    setTimeout(() => { msg.textContent = ''; }, 4000);
  });

  const stat = (value, label, vs) => el('div', { class: 'rc-stat' }, el('b', { text: value }), el('span', { text: label }),
    vs ? el('i', { 'data-up': String(!vs.startsWith('▼')), text: vs }) : null);

  function draw() {
    if (!R) return;
    const thisWeek = R.offset === 0;
    title.textContent = thisWeek ? 'This week' : R.offset === 1 ? 'Last week' : `Week of ${shortDate(R.from)}`;
    sub.textContent = `${shortDate(R.from)} – ${shortDate(R.to - 1)}${thisWeek ? ' · so far' : ''}`;
    prev.disabled = !R.hasEarlier || offset >= 12; next.disabled = offset === 0;
    const hrs = R.seconds >= 3600 ? `${(R.seconds / 3600).toFixed(1)} h` : R.seconds ? fmtDur(R.seconds) : '0';
    stats.replaceChildren(stat(String(R.runs), R.runs === 1 ? 'run' : 'runs', vsText(R.vs.runs)), stat(fmtTokens(R.tokens), 'tokens', vsText(R.vs.tokens)), stat(hrs, 'AI working', vsText(R.vs.seconds)));
    for (const i of stats.querySelectorAll('i')) i.title = thisWeek ? 'So far, compared with the whole week before' : 'Compared with the week before';
    // seven little bars, Monday to Sunday, tallest = the busiest day
    const max = Math.max(1, ...R.days.map((d) => d.tokens));
    chart.setAttribute('aria-label', R.days.map((d) => `${new Date(d.day).toLocaleDateString([], { weekday: 'long' })}: ${d.runs} runs`).join(', '));
    chart.replaceChildren(...R.days.map((d) => el('div', { class: 'rc-day' + (d.future ? ' future' : '') + (R.busiest && d.day === R.busiest.day ? ' top' : ''), title: `${d.runs} runs · ${fmtTokens(d.tokens)} tokens` },
      el('div', { class: 'rc-col' }, el('i', { style: `--h:${d.tokens ? Math.max(0.06, d.tokens / max) : 0}` })),
      el('span', { text: new Date(d.day).toLocaleDateString([], { weekday: 'narrow' }) }))));
    const items = [];
    if (!R.runs) items.push(thisWeek ? 'Nothing yet this week.' : 'No runs that week.');
    if (R.busiest) items.push(`Busiest day: ${new Date(R.busiest.day).toLocaleDateString([], { weekday: 'long' })} (${R.busiest.runs} runs, ${fmtTokens(R.busiest.tokens)} tokens)`);
    if (R.longest) items.push(`Longest run: ${fmtDur(R.longest.duration)}${R.codex ? ` with ${R.longest.provider === 'codex' ? 'Codex' : 'Claude'}` : ''}`);
    if (R.peakHour != null && R.runs >= 3) items.push(`Most active: ${hourLabel(R.peakHour)}`);
    if (R.codex && R.claude) items.push(`Claude ${R.claude} runs · Codex ${R.codex} runs`);
    if (R.usd != null) items.push(`Claude Code spend: $${R.usd.toFixed(2)}`);
    if (R.streak >= 2) items.push(`🔥 ${R.streak}-day streak${thisWeek ? '' : ' at the end of the week'}`);
    if (R.badges.length) items.push(`New badge${R.badges.length > 1 ? 's' : ''}: ${R.badges.map((b) => b.name).join(', ')}`);
    facts.replaceChildren(...items.map((t) => el('li', { text: t })));
    drawPet();
  }
  function drawPet() {
    if (!S) return;
    const seed = S.settings.monsters.active || S.signature, evo = S.evolution || { stage: 2, fat: 0 };
    const shown = (S.settings.evolution && S.settings.evolution.display) || 0, st = shown && shown < evo.stage ? shown : evo.stage;
    const k = `${seed}:${st}:${evo.fat}`; if (k === petKey) return; petKey = k;
    pet.setSeed(seed); pet.setForm(st, st === evo.stage ? evo.fat : 0);
  }
  return {
    node: card,
    update(s) {
      S = s; drawPet();
      const k = `${s.samples}:${new Date().toDateString()}:${s.badges ? s.badges.earned : 0}`;
      if (k !== key) { key = k; load(); }
    },
  };
}

const dayName = (t, now) => {
  const d = new Date(t), today = new Date(now); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - t) / 86400e3);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
};

/** History: every run Tokkie remembers (90 days), by day, searchable. Loaded on demand, not every second. */
export function historyView(root, api) {
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search your prompts…', 'aria-label': 'Search prompts', spellcheck: 'false' });
  const summary = el('p', { class: 'muted' });
  const list = el('div', { class: 'days' });
  // which AI: shown only when there's more than one in the history
  let who = 'all';
  const whoBtns = [['all', 'All'], ['claude', 'Claude'], ['codex', 'Codex']].map(([k, l]) => el('button', { type: 'button', 'data-k': k, 'aria-pressed': String(k === who),
    onclick: () => { who = k; for (const b of whoBtns) b.setAttribute('aria-pressed', String(b.dataset.k === who)); draw(); } },
    k === 'all' ? null : el('span', { class: 'pdot', 'data-p': k, 'aria-hidden': 'true' }), l));
  const whoSeg = el('div', { class: 'seg who', role: 'group', 'aria-label': 'Which AI', hidden: true }, ...whoBtns);
  const recap = recapCard(api);
  root.append(el('div', { class: 'stack' }, recap.node, search, whoSeg, summary, list));

  let data = null, S = null, loading = false, loadedAt = 0, lastCount = -1, q = '';
  const openDays = new Set();
  const cards = runCards(api, () => draw(), { when: 'clock' });

  async function load() {
    if (loading) return; loading = true;
    try { data = await api.history(); loadedAt = Date.now(); } finally { loading = false; }
    draw();
  }

  function draw() {
    if (!data) { summary.textContent = 'Loading…'; return; }
    const now = Date.now();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const multi = data.days.some((d) => d.runs.some((r) => r.provider === 'codex'));
    whoSeg.hidden = !multi; if (!multi) who = 'all';
    const mine = (r) => who === 'all' || (r.provider || 'claude') === who;
    const match = (r) => mine(r) && (!words.length || words.every((w) => `${r.preview} ${r.cwd}`.toLowerCase().includes(w)));
    const days = data.days.map((d) => ({ ...d, shown: d.runs.filter(match) })).filter((d) => d.shown.length);
    const total = data.days.reduce((n, d) => n + d.runs.filter(mine).length, 0);
    summary.textContent = !total ? 'No runs yet — they’ll show up here, grouped by day.'
      : words.length || who !== 'all' ? `${days.reduce((n, d) => n + d.shown.length, 0)} of ${total} runs${words.length ? ' match' : ` with ${who === 'codex' ? 'Codex' : 'Claude'}`}`
      : `${total} runs over ${data.days.length} day${data.days.length === 1 ? '' : 's'} · kept for ${data.keptDays} days`;
    if (!openDays.size && days[0]) openDays.add(days[0].day);              // today (or the latest day) starts open
    list.replaceChildren(...days.map((d) => {
      const open = words.length > 0 || openDays.has(d.day);
      // the day's totals follow the filter (Claude's $ only when Claude is in view)
      const runs = who === 'all' ? d.runs : d.shown;
      const tokens = runs.reduce((a, r) => a + (r.headline || 0), 0), seconds = runs.reduce((a, r) => a + (r.duration || 0), 0);
      const usd = who !== 'codex' && d.usd != null ? ` · $${d.usd.toFixed(2)}` : '';
      const head = el('button', { class: 'dayhead', type: 'button', 'aria-expanded': String(open), onclick: () => { if (openDays.has(d.day)) openDays.delete(d.day); else openDays.add(d.day); draw(); } },
        el('span', { class: 'dname', text: dayName(d.day, now) }),
        el('span', { class: 'dsum', text: `${runs.length} run${runs.length === 1 ? '' : 's'} · ${fmtTokens(tokens)} tokens${usd} · ${fmtDur(seconds)}` }));
      return el('section', { class: 'day' }, head, open ? el('div', { class: 'runlist' }, ...d.shown.map((r) => cards.card({ now }, r))) : null);
    }));
  }

  search.addEventListener('input', () => { q = search.value; draw(); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; q = ''; draw(); } });

  return {
    update(s) {
      S = s;
      if (!root.hidden) recap.update(s);
      // reload when a run finished (or every few minutes for the "x ago" bits); otherwise nothing to do
      if (!root.hidden && (s.samples !== lastCount || Date.now() - loadedAt > 5 * 60e3)) { lastCount = s.samples; load(); }
    },
    setActive() {},
  };
}
