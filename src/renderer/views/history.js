import { el, fmtTokens, fmtDur } from '../util.js';
import { runCards } from './runs.js';

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
  root.append(el('div', { class: 'stack' }, search, summary, list));

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
    const match = (r) => !words.length || words.every((w) => `${r.preview} ${r.cwd}`.toLowerCase().includes(w));
    const days = data.days.map((d) => ({ ...d, shown: d.runs.filter(match) })).filter((d) => d.shown.length);
    const total = data.days.reduce((n, d) => n + d.runs.length, 0);
    summary.textContent = !total ? 'No runs yet — they’ll show up here, grouped by day.'
      : words.length ? `${days.reduce((n, d) => n + d.shown.length, 0)} of ${total} runs match`
      : `${total} runs over ${data.days.length} day${data.days.length === 1 ? '' : 's'} · kept for ${data.keptDays} days`;
    if (!openDays.size && days[0]) openDays.add(days[0].day);              // today (or the latest day) starts open
    list.replaceChildren(...days.map((d) => {
      const open = words.length > 0 || openDays.has(d.day);
      const usd = d.usd != null ? ` · $${d.usd.toFixed(2)}` : '';
      const head = el('button', { class: 'dayhead', type: 'button', 'aria-expanded': String(open), onclick: () => { if (openDays.has(d.day)) openDays.delete(d.day); else openDays.add(d.day); draw(); } },
        el('span', { class: 'dname', text: dayName(d.day, now) }),
        el('span', { class: 'dsum', text: `${d.runs.length} run${d.runs.length === 1 ? '' : 's'} · ${fmtTokens(d.tokens)} tokens${usd} · ${fmtDur(d.seconds)}` }));
      return el('section', { class: 'day' }, head, open ? el('div', { class: 'runlist' }, ...d.shown.map((r) => cards.card({ now }, r))) : null);
    }));
  }

  search.addEventListener('input', () => { q = search.value; draw(); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; q = ''; draw(); } });

  return {
    update(s) {
      S = s;
      // reload when a run finished (or every few minutes for the "x ago" bits); otherwise nothing to do
      if (!root.hidden && (s.samples !== lastCount || Date.now() - loadedAt > 5 * 60e3)) { lastCount = s.samples; load(); }
    },
    setActive() {},
  };
}
