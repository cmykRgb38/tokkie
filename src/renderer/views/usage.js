import { el, icon, fmtTokens, fmtDur, fmtPct, clamp } from '../util.js';

/** Colour by how much is USED (matches Claude's own Settings → Usage bar, which fills as you use more). */
export const kindUsed = (used) => (used >= 90 ? 'bad' : used >= 70 ? 'warn' : 'good');

function meterNode(title) {
  const val = el('span', { class: 'left' });
  const fill = el('i');
  const bar = el('div', { class: 'bar', role: 'progressbar', 'aria-label': title, 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill);
  const foot = el('div', { class: 'foot' });
  const root = el('div', { class: 'meter' }, el('div', { class: 'top' }, el('span', { class: 'label', text: title }), val), bar, foot);
  return {
    root,
    set(m, now) {
      val.textContent = `${m.approx ? '≈ ' : ''}${fmtPct(m.pct)}% used`;
      fill.style.width = clamp(m.pct, 0, 100) + '%'; bar.dataset.k = kindUsed(m.pct); bar.setAttribute('aria-valuenow', Math.round(m.pct));
      const age = Math.max(0, (now - m.readAt) / 1000);
      const note = m.source === 'estimate' ? 'from your token budget'
        : m.approx && m.baseline != null ? `live estimate · Claude said ${fmtPct(m.baseline)}% ${fmtDur(age)} ago`
        : age < 90 ? 'just now' : `Claude's last reading ${fmtDur(age)} ago`;
      const parts = [el('span', { text: note, title: m.approx ? 'Claude only saves a reading now and then. Tokkie adds what you have used since, calibrated against Claude’s earlier readings.' : '' })];
      if (m.resetsAt && m.resetsAt > now) parts.push(el('span', { text: `resets in ${fmtDur((m.resetsAt - now) / 1000)}` }));
      foot.replaceChildren(...parts);
    },
  };
}

export function usageView(root, api) {
  const welcome = el('div', { class: 'welcome', hidden: true },
    el('strong', { text: 'Hi, I live here now.' }),
    el('ul', {}, el('li', { text: 'I read your Claude usage on this computer — nothing leaves it.' }),
      el('li', { text: 'Click me to open or close this panel. Drag me anywhere.' }),
      el('li', { text: 'Copy a prompt and press my shortcut to see how long it will take.' })),
    el('div', { class: 'row' }, el('span'), el('button', { class: 'btn sm primary', type: 'button', text: 'Got it', onclick: () => api.dismissWelcome() })));

  const nodes = new Map();                 // meter id → component (kept so bars animate instead of re-mounting)
  const connectMsg = el('p'); const connectBtn = el('button', { class: 'btn primary', type: 'button' }, icon('plug'), 'Connect Claude Code');
  const connectErr = el('p', { class: 'muted', hidden: true, style: 'color:var(--bad)' });
  const connect = el('div', { class: 'connect' }, el('strong', { text: 'Show your plan usage' }), connectMsg, connectBtn, connectErr);
  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    let r; try { r = await api.connect(); } catch { r = { ok: false, error: 'Something went wrong — nothing was changed.' }; } finally { connectBtn.disabled = false; }
    connectErr.hidden = r.ok; if (!r.ok) connectErr.textContent = r.error;
  });
  const waiting = el('div', { class: 'connect', style: 'border-style:solid;border-color:var(--accent)' }, el('strong', { text: '✓ Connected — waiting for the first reading' }),
    el('p', { text: 'Your plan percentage appears after the next reply in Claude Code running in a terminal or your IDE. Until then I’m showing token counts only.' }),
    el('button', { class: 'btn sm quiet', type: 'button', text: 'Disconnect', onclick: () => api.disconnect() }));

  const vToday = el('div', { class: 'v' }), vFive = el('div', { class: 'v' }), vBurn = el('div', { class: 'v' });
  const stat = (k, v) => el('div', { class: 'stat' }, el('div', { class: 'k', text: k }), v);
  const stats = el('div', { class: 'stats' }, stat('Today', vToday), stat('Last 5 hours', vFive), stat('Burn rate', vBurn));

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'spark'); svg.setAttribute('viewBox', '0 0 300 52'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img');
  const area = document.createElementNS(NS, 'path'); area.setAttribute('class', 'area'); const line = document.createElementNS(NS, 'path'); line.setAttribute('class', 'line');
  svg.append(area, line);
  const sparkNote = el('span');
  const sparkWrap = el('div', {}, svg, el('div', { class: 'spark-foot' }, el('span', { text: '60 min ago' }), sparkNote, el('span', { text: 'now' })));
  const foot = el('p', { class: 'muted' });
  const metersBox = el('div', { class: 'stack' });
  root.append(el('div', { class: 'stack' }, welcome, metersBox, el('div', { class: 'divider' }), stats, sparkWrap, foot));

  let lastIds = '';
  return {
    update(S) {
      welcome.hidden = !!S.settings.onboarded;
      const now = S.now, list = [];
      const meters = Array.isArray(S.meters) ? S.meters : [];
      for (const m of meters) {
        if (!nodes.has(m.id)) nodes.set(m.id, meterNode(m.label));
        const n = nodes.get(m.id); n.set(m, now); list.push(n.root);
      }
      if (!meters.length) {
        if (S.hook && S.hook.installed) list.push(waiting);
        else { connectMsg.textContent = 'One click adds a tiny status-line hook so Tokkie can show how much of your plan you’ve used. You can undo it any time in Settings.'; list.push(connect); }
      }
      const ids = meters.map((m) => m.id).join() + (meters.length ? '' : S.hook && S.hook.installed ? 'w' : 'c');
      if (ids !== lastIds || metersBox.childElementCount !== list.length) { metersBox.replaceChildren(...list); lastIds = ids; }

      vToday.textContent = fmtTokens(S.tokens.today); vFive.textContent = fmtTokens(S.tokens.last5h);
      vBurn.textContent = S.tokens.burn > 50 ? `${fmtTokens(S.tokens.burn)}/min` : 'idle';
      const sp = S.spark, max = Math.max(1, ...sp), W = 300, H = 52, step = W / (sp.length - 1);
      const pts = sp.map((v, i) => [i * step, H - 3 - (v / max) * (H - 9)]);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      line.setAttribute('d', d); area.setAttribute('d', `${d} L${W} ${H} L0 ${H} Z`);
      sparkNote.textContent = max > 1 ? `peak ${fmtTokens(max)}/min` : 'quiet hour';
      svg.setAttribute('aria-label', `Token activity over the last hour. ${sparkNote.textContent}.`);
      foot.textContent = S.files ? `Percentages come from Claude itself and include Chat. Token counts cover Claude Code + Cowork (${S.files} logs).` : 'No Claude sessions found yet — start one and I’ll pick it up.';
    },
  };
}
