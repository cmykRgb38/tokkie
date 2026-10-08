// The floating strip: the Claude bar's items for people in Chat or Cowork. Drag it anywhere (it remembers where),
// hover an item for what it means, and Optimize rewrites whatever prompt is on your clipboard.
const api = window.tokkie, ui = api.stripUi;
const bar = document.getElementById('bar'), tip = document.getElementById('tip');

const PATHS = {
  usage: '<path d="M4.5 18a9 9 0 1 1 15 0"/><path d="M12 14l4-5"/>',
  pace: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  status: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.5l2.8 2.8L16.5 9"/>',
  next: '<path d="M4 12h11"/><path d="M11 7l5 5-5 5"/><path d="M20 5v14"/>',
  tokens: '<path d="M5 19V11M10 19V6M15 19v-9M20 19V4"/>',
  lastPrompt: '<path d="M5 5h14v10H10l-5 4z"/><path d="M12 7.5v5"/>',
  context: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/>',
  cache: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.8M10 3h4"/>',
  agents: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.2h0"/>',
  sparkle: '<path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6z"/><path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z"/>',
  open: '<path d="M6 15l6-6 6 6"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${PATHS[k] || PATHS.status}</svg>`;
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let data = { items: [], alert: '', optKey: '' }, hoverTip = null, toast = null, toastTimer = null;

function render() {
  const items = [...(data.alert ? [{ k: 'alert', label: 'Heads-up', value: '!', tone: 'bad', tip: data.alert }] : []), ...data.items];
  bar.innerHTML = '<span class="grip" aria-hidden="true"></span>'
    + items.map((x, i) => `<span class="it" data-i="${i}" data-k="${x.tone || ''}" data-key="${esc(x.k)}">${svg(x.k)}<span class="v">${esc(x.value)}</span></span>`).join('')
    + (items.length ? '<span class="sep"></span>' : '')
    + `<button class="opt" type="button" aria-label="Optimize the prompt on your clipboard">${svg('sparkle')}Optimize</button>`
    + `<button class="ico" type="button" aria-label="Open Tokkie" data-open="1">${svg('open')}</button>`;
  bar._items = items;
  ui.width(Math.max(bar.offsetWidth + 16, 440));
  paintTip();
}

function paintTip() {
  const t = toast || hoverTip;
  if (!t) { tip.hidden = true; return; }
  tip.hidden = false; tip.dataset.kind = t.kind || '';
  tip.classList.toggle('click', !!(toast && toast.undo));
  tip.innerHTML = `<b>${esc(t.title)}</b>${t.sub ? `<br>${esc(t.sub)}` : ''}`;
  const left = Math.max(8, Math.min((t.x || 8), window.innerWidth - tip.offsetWidth - 8));
  tip.style.left = left + 'px';
}

// hover: what each item means (the strip's own tooltips, instant and readable)
bar.addEventListener('mouseover', (e) => {
  const it = e.target.closest('.it'), b = e.target.closest('button');
  if (it) { const x = bar._items[+it.dataset.i]; hoverTip = { title: `${x.label}: ${x.value}`, sub: x.tip, x: it.offsetLeft + bar.offsetLeft }; }
  else if (b && b.classList.contains('opt')) hoverTip = { title: 'Optimize your prompt', sub: `Copy it first (select it in Claude’s box and copy), then click. A clearer version replaces it on your clipboard: just paste. Shortcut: ${data.optKey}.`, x: b.offsetLeft + bar.offsetLeft };
  else if (b) hoverTip = { title: 'Open Tokkie', sub: 'Usage, estimates, history and settings.', x: b.offsetLeft + bar.offsetLeft };
  else hoverTip = { title: 'Tokkie strip', sub: 'Drag to move it, for example just above Claude’s prompt box. Turn it off in Settings → On your desktop.', x: 8 };
  paintTip();
});
bar.addEventListener('mouseleave', () => { hoverTip = null; paintTip(); });

// clicks pass through the empty part of the window; only the bar and a clickable note take them
let interactive = false;
document.addEventListener('mousemove', (e) => {
  const on = !!(e.target.closest && (e.target.closest('.bar') || e.target.closest('.tip.click'))) || !!drag;
  if (on !== interactive) { interactive = on; api.ui.interactive(on); }
});

// drag from anywhere on the bar except the buttons; a click on an item opens the panel
let drag = null;
bar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  drag = { sx: e.screenX, sy: e.screenY, moved: false, it: e.target.closest('.it') };
  bar.setPointerCapture(e.pointerId);
});
bar.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.sx, dy = e.screenY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  if (!drag.moved) { drag.moved = true; bar.classList.add('dragging'); hoverTip = null; paintTip(); ui.dragStart(); }
  ui.dragMove({ dx, dy });
});
bar.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.moved) ui.dragEnd();
  else if (drag.it) { const x = bar._items[+drag.it.dataset.i]; ui.open(x && x.k === 'next' ? 'plan' : 'usage'); }
  bar.classList.remove('dragging'); drag = null;
});
bar.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.open) ui.open('usage'); else api.ui.optimizeClipboard();
});
tip.addEventListener('click', async () => { if (toast && toast.undo) { await api.ui.undoOptimize(); } });

api.onCommand((c) => {
  if (!c || c.type !== 'optToast') return;
  clearTimeout(toastTimer);
  toast = { ...c, x: 8 };
  paintTip();
  if (c.kind !== 'busy') toastTimer = setTimeout(() => { toast = null; paintTip(); }, c.undo ? 12000 : 7000);
});
ui.onStrip((p) => {
  data = p;
  if (p.theme === 'light' || p.theme === 'dark') document.documentElement.dataset.theme = p.theme; else delete document.documentElement.dataset.theme;
  render();
});
