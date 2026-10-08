import { el, icon, fmtTokens, fmtDur, fmtRange, fmtTime, clamp, parseTime, labelForHHMM } from '../util.js';
import { runCards } from './runs.js';

export { accuracy } from './runs.js';

export function prettyKey(acc, platform) {
  const mac = platform === 'darwin';
  // keys spaced apart (⌘ ⌥ ⇧ L), the way macOS menus show them; "Ctrl + Alt + Shift + L" elsewhere
  return acc.split('+').map((k) => ({ CommandOrControl: mac ? '⌘' : 'Ctrl', Command: '⌘', Control: mac ? '⌃' : 'Ctrl', Alt: mac ? '⌥' : 'Alt', Option: '⌥', Shift: mac ? '⇧' : 'Shift' }[k] || k)).join(mac ? ' ' : ' + ');
}

const TITLES = { go: ['good', 'Go for it'], tight: ['warn', 'Cutting it close'], stop: ['bad', 'Better wait'], over: ['bad', 'Past your finish time'] };

export function planView(root, api) {
  const finish = el('input', { class: 'input', type: 'text', inputmode: 'text', autocomplete: 'off', 'aria-label': 'Finish by', title: 'e.g. 6:30pm or 18:30', style: 'width:72px;text-align:center' });
  const commitFinish = () => {
    const v = parseTime(finish.value);
    if (v) { api.setSettings({ finishBy: v }); finish.value = labelForHHMM(v); finish.removeAttribute('aria-invalid'); rerun(); }
    else { finish.setAttribute('aria-invalid', 'true'); }
  };
  finish.addEventListener('change', commitFinish);
  finish.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish.blur(); } });

  // ✨ Optimize what's in the box (the same rewrite the Claude bar's button does, but here you copy the result)
  const untilEl = el('span', { class: 'until' });
  const optLabel = el('span', { text: 'Optimize' });
  const optBtn = el('button', { class: 'btn sm', type: 'button', title: 'Ask Claude for a clearer version of this prompt' }, icon('sparkle'), optLabel);
  const optBox = el('div', { class: 'opt', hidden: true });
  optBtn.addEventListener('click', async () => {
    const text = ta.value;
    if (!text.trim()) { flash('Paste a prompt first, then Optimize.'); return; }
    optBtn.disabled = true; optLabel.textContent = 'Optimizing…';
    optBox.hidden = false; optBox.replaceChildren(el('p', { class: 'muted', text: 'Asking Claude for a clearer version…' }));
    let r;
    try { r = await api.optimize(text); } catch { r = { ok: false, error: 'Something went wrong.' }; } finally { optBtn.disabled = !ta.value.trim(); optLabel.textContent = 'Optimize'; }
    if (!r || !r.ok) { optBox.replaceChildren(el('p', { class: 'muted', style: 'color:var(--bad)', text: (r && r.error) || 'Couldn’t optimize.' })); return; }
    optBox.replaceChildren(...[
      el('div', { class: 'row' }, el('span', { class: 'label with-ic' }, icon('sparkle'), `${r.before.promptTokens} → ${r.after.promptTokens} tokens · ${r.model[0].toUpperCase() + r.model.slice(1)}`),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => { optBox.hidden = true; } }, icon('x'))),
      el('div', { class: 'rfull', text: r.optimized }),
      r.changes.length ? el('ul', { class: 'optlist' }, r.changes.map((c) => el('li', { text: c }))) : null,
      r.questions.length ? el('div', { class: 'optq' }, el('b', { text: 'Fill in before sending: ' }), r.questions.join(' · ')) : null,
      el('div', { class: 'row', style: 'gap:6px;justify-content:flex-start' },
        el('button', { class: 'btn sm primary', type: 'button', text: 'Copy optimized', onclick: async () => { await api.copyText(r.optimized); flash('Optimized prompt copied — paste it into Claude.'); } }),
        el('button', { class: 'btn sm', type: 'button', text: 'Use it here', title: 'Put it in the box above and estimate it', onclick: () => { ta.value = r.optimized; ta.dispatchEvent(new Event('input', { bubbles: true })); optBox.hidden = true; } })),
      el('p', { class: 'muted', text: 'A clearer prompt saves by avoiding wasted steps, not by being shorter — so it may be a little longer. Send it, then compare in Recent runs.' }),
    ].filter(Boolean));
  });

  const ta = el('textarea', { class: 'input', rows: 2, placeholder: 'Paste your prompt here…', 'aria-label': 'Prompt to estimate', spellcheck: 'false' });
  const meta = el('span', { class: 'muted num' });
  const clipBtn = el('button', { class: 'btn sm icon-only', type: 'button', title: 'Estimate whatever is on your clipboard', 'aria-label': 'Estimate clipboard', onclick: () => api.estimateClipboard() }, icon('clip'));
  const out = el('div', { class: 'stack', 'aria-live': 'polite' });
  ta.maxLength = 50000;
  optBtn.disabled = true;                                   // nothing to optimize yet
  ta.addEventListener('input', () => { optBtn.disabled = !ta.value.trim(); });

  const runsBox = el('div', { class: 'runs' });
  root.append(el('div', { class: 'stack' },
    el('div', { class: 'row' }, el('label', { class: 'label', style: 'display:flex;align-items:center;gap:8px;white-space:nowrap' }, 'Done by', finish, untilEl), clipBtn),
    el('div', { style: 'display:grid;gap:6px' }, ta, el('div', { class: 'row' }, meta, optBtn)),
    optBox,
    out, runsBox));

  let S = null, last = null, timer = null, seq = 0, charsText = '', untilText = '';
  let flashText = '', flashUntil = 0;
  const flash = (msg) => { flashText = msg; flashUntil = Date.now() + 6000; paintMeta(); setTimeout(paintMeta, 6100); };
  const paintMeta = () => {
    const flashing = Date.now() < flashUntil;
    meta.textContent = flashing ? flashText : charsText;
    untilEl.textContent = untilText;
    meta.style.color = flashing ? 'var(--warn)' : '';
  };

  let emptyNode = null, hotkeyKbd = null;
  function empty() {
    if (emptyNode) { if (out.firstChild !== emptyNode) out.replaceChildren(emptyNode); if (S) { hotkeyKbd.textContent = prettyKey(S.settings.hotkey, S.platform); hotkeyKbd.style.opacity = !S.hotkey || S.hotkey.ok ? '' : '.45'; hotkeyKbd.title = !S.hotkey || S.hotkey.ok ? '' : 'This shortcut is not active — change it in Settings'; } return; }
    hotkeyKbd = el('span', { class: 'kbd', text: S ? prettyKey(S.settings.hotkey, S.platform) : '' });
    emptyNode = el('div', { class: 'empty' },
      el('strong', { text: 'Know before you hit enter' }),
      el('ol', {}, el('li', {}, 'Write your prompt in Claude, then select it all and ', el('b', { text: 'copy' }), ' it (⌘C / Ctrl+C).'),
        el('li', {}, 'Press ', hotkeyKbd, ' from anywhere — no need to open Tokkie — or paste it above.'),
        el('li', {}, 'I’ll tell you roughly how long it will run and whether it fits before your finish time.')));
    out.replaceChildren(emptyNode);
  }

  function render(r) {
    last = r;
    const { plan, duration: d, tokens: t, share } = r;
    const [k, title] = TITLES[plan.verdict];
    const fin = fmtTime(r.finishBy);
    let msg;
    if (plan.verdict === 'over') msg = `It’s already past ${fin}. This would take about ${fmtRange(d.p25, d.p90)} — best saved for tomorrow.`;
    else if (plan.verdict === 'go') msg = `Likely done by ${fmtTime(plan.etaP50)}, worst case ${fmtTime(plan.etaP90)} — ${fmtDur(Math.max(0, (r.finishBy - plan.etaP90) / 1000))} to spare before ${fin}.`;
    else if (plan.verdict === 'tight') msg = `Most runs finish by ${fmtTime(plan.etaP50)}, but a slow one could run to ${fmtTime(plan.etaP90)}, past ${fin}.` + (plan.sendBy > r.now ? ` Send it by ${fmtTime(plan.sendBy)} to be safe.` : ' Trim it or send it now and check back.');
    else msg = `Usually ${fmtRange(d.p25, d.p75)}, so you’d finish around ${fmtTime(plan.etaP50)} — after ${fin}. Queue it for tomorrow or split it into a smaller first step.`;

    // Timeline: now → finish, zoomed to the run when the finish time is far away so the band stays readable.
    const toP90 = plan.etaP90 - r.now, toFinish = r.finishBy - r.now;
    const far = toFinish > toP90 * 3;
    const domain = (far ? toP90 * 1.5 : Math.max(toFinish, toP90) * 1.1);
    const pos = (ms) => clamp(((ms - r.now) / domain) * 100, 0, 100);
    const lo = pos(r.now + d.p25 * 1000), hi = pos(plan.etaP90), mid = pos(plan.etaP50), end = pos(r.finishBy);
    const showEnd = plan.verdict !== 'over' && !far;
    const tl = el('div', { class: 'tl', role: 'img', 'aria-label': `Timeline: expected finish ${fmtTime(plan.etaP50)}, worst case ${fmtTime(plan.etaP90)}, your finish time ${fin}` },
      el('div', { class: 'track' }), el('div', { class: 'band', style: `left:${lo}%;width:${Math.max(3, hi - lo)}%` }), el('div', { class: 'mid', style: `left:calc(${mid}% - 1px)` }),
      showEnd ? el('div', { class: 'end', style: `left:calc(${end}% - 1px)` }) : null,
      el('span', { class: 'lbl', style: 'left:0', text: 'now' }),
      el('span', { class: 'lbl', style: showEnd ? (end > 72 ? `right:${100 - end}%;margin-right:6px;color:var(--bad)` : `left:${end}%;margin-left:6px;color:var(--bad)`) : 'right:0', text: showEnd ? fin : plan.verdict === 'over' ? '' : `${fin} ›` }));

    const shareTxt = share ? `${share.lo < 1 ? '<1' : Math.round(share.lo)}–${Math.max(1, Math.round(share.hi))}% of 5-hour limit` : '';
    const conf = r.confidence === 'low' ? `Still learning your pace (${r.n} run${r.n === 1 ? '' : 's'} so far). Treat this as a rough guess.`
      : r.confidence === 'medium' ? `Based on your last ${r.n} runs.` : `Based on your last ${Math.min(r.n, 300)} runs. Big agentic tasks still vary a lot.`;
    paintMeta();
    // Will it fit in what's left of your limit? (the tightest limit we can measure)
    const f = r.fit, pct = (x) => (x < 1 ? '<1' : String(Math.round(x)));
    const need = f ? (f.usd ? `$${f.usd.p50.toFixed(2)}–${f.usd.p75.toFixed(2)}` : `${pct(f.need.p50)}–${pct(f.need.p75)}%`) : '';
    const left = f ? (f.usd ? `$${f.usd.left.toFixed(2)}` : `${pct(f.left)}%`) : '';
    const fitBox = f && f.status !== 'ok'
      ? el('div', { class: 'verdict', 'data-k': f.status === 'no' ? 'bad' : 'warn', role: 'alert' }, el('span', { class: 'dot', 'data-k': f.status === 'no' ? 'bad' : 'warn' }),
        el('h3', { text: f.status === 'no' ? 'Not enough left for this prompt' : 'This prompt may not fit' }),
        el('p', { text: f.left <= 0.05 ? `Your ${f.label} is used up.` : `It needs about ${need} and only ${left} of your ${f.label} is left${f.status === 'no' ? ' — it will likely stop partway.' : ' — a heavy run could hit the limit.'} Split it into a smaller first step${f.id === 'five' ? ' or wait for the 5-hour reset' : ''}.` }))
      : null;
    out.replaceChildren(
      ...(fitBox ? [fitBox] : []),
      el('div', { class: 'verdict', 'data-k': k }, el('span', { class: 'dot', 'data-k': k }), el('h3', { text: title }), el('p', { text: msg }), tl),
      el('div', { class: 'kv' },
        el('div', { class: 'row' }, el('span', { text: 'Run time' }), el('span', { text: fmtRange(d.p25, d.p75) })),
        el('div', { class: 'row' }, el('span', { text: 'Tokens it will use' }), el('span', { text: `≈ ${fmtTokens(r.headline.p25)}–${fmtTokens(r.headline.p75)}` })),
        f ? el('div', { class: 'row' }, el('span', { text: 'Limit impact' }), el('span', { text: `≈ ${need} · ${left} left`, title: `${f.label}: this prompt’s likely share vs what’s left`, style: f.status === 'no' ? 'color:var(--bad)' : f.status === 'risky' ? 'color:var(--warn)' : '' }))
          : el('div', { class: 'row' }, el('span', { text: 'Limit impact' }), el('span', { text: share ? `≈ ${shareTxt}` : 'connect limits for %', style: share ? '' : 'font-weight:500;color:var(--ink-3)' }))),
      el('p', { class: 'muted', text: conf }));
  }

  async function run() {
    const text = ta.value; const mine = ++seq;
    if (!text.trim()) { last = null; empty(); charsText = ''; paintMeta(); return; }
    const r = await api.estimate(text); if (mine !== seq) return;
    charsText = `${text.length.toLocaleString()} chars · ≈${fmtTokens(r.promptTokens)} tokens`;
    render(r);
  }
  const rerun = () => { clearTimeout(timer); timer = setTimeout(run, 120); };
  ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });

  let runsKey = '';
  // Recent runs. The live card redraws every second; the list only when runs change, so an opened card stays open.
  const runsHead = el('div', { class: 'row' }, el('span', { class: 'label', text: 'Recent runs' }), el('span', { class: 'muted', text: 'click one to see the full prompt' }));
  const liveBox = el('div'), listBox = el('div', { class: 'runlist' });
  runsBox.replaceChildren(runsHead, liveBox, listBox);
  const cards = runCards(api, () => { runsKey = ''; renderRuns(S); });
  let liveKey = '';

  function renderLive(s) {
    const a = s.active;
    const k = a ? JSON.stringify([a.start, a.headline, Math.floor(s.now / 1000), s.eta && s.eta.p50]) : '';
    if (k === liveKey) return; liveKey = k;
    if (!a) { liveBox.replaceChildren(); return; }
    liveBox.replaceChildren(el('div', { class: 'run live' },
      el('div', { class: 'row' }, el('span', { class: 'muted' }, el('span', { class: 'dot', 'data-k': 'live' }), ` Running now${a.cwd ? ` · ${a.cwd.split(/[\\/]/).filter(Boolean).pop()}` : a.source === 'cowork' ? ' · Cowork' : ''}`),
        el('span', { class: 'val', text: fmtDur((s.now - a.start) / 1000) })),
      a.preview ? el('div', { class: 'rprompt', text: `“${a.preview}${a.chars > 140 ? '…' : ''}”` }) : null,
      el('div', { class: 'rtok', text: a.headline ? `≈ ${fmtTokens(a.headline)} tokens so far` : 'starting…' }),
      s.eta ? el('div', { class: 'muted', text: `usually ${fmtRange(s.eta.p25, s.eta.p75)}` }) : null));
  }

  function renderRuns(s) {
    renderLive(s);
    const key = JSON.stringify([s.runs, s.k5, Math.floor(s.now / 60000), cards.key()]);
    if (key === runsKey) return; runsKey = key;
    const runs = s.runs || [];
    if (!runs.length) { listBox.replaceChildren(el('p', { class: 'muted', text: 'Runs you make will appear here with the prompt, how long it took and what it cost.' })); return; }
    listBox.replaceChildren(...runs.map((r) => cards.card(s, r)), el('button', { class: 'btn sm quiet', type: 'button', text: 'See all history by day →', onclick: () => api.openTab('history') }));
  }

  return {
    update(s) {
      S = s; renderRuns(s);
      if (document.activeElement !== finish && !finish.hasAttribute('aria-invalid')) finish.value = labelForHHMM(s.settings.finishBy);
      const fb = new Date(s.now); const [h, m] = s.settings.finishBy.split(':').map(Number); fb.setHours(h, m, 0, 0);
      const left = (fb - s.now) / 1000;
      untilText = left > 0 ? `${fmtDur(left)} to go` : 'past finish time';
      paintMeta();
      if (!last && !ta.value.trim()) empty();
      else if (last && s.now - last.now > 30000) rerun();     // keep ETAs honest as the clock moves
    },
    flash,
    setText(text) { ta.value = text.slice(0, 20000); run(); },
    setResult(text, result) { ta.value = text.slice(0, 20000); optBtn.disabled = !ta.value.trim(); charsText = `${text.length.toLocaleString()} chars · ≈${fmtTokens(result.promptTokens)} tokens`; render(result); },
    focus() { ta.focus(); },
  };
}
