import { el, icon, fmtTokens, fmtDur, fmtPct, clamp } from '../util.js';

/** Colour by how much is USED (matches Claude's own Settings → Usage bar, which fills as you use more). */
export const kindUsed = (used) => (used >= 90 ? 'bad' : used >= 70 ? 'warn' : 'good');

function meterNode(title, id, api) {
  const val = el('span', { class: 'left' });
  const fill = el('i');
  const bar = el('div', { class: 'bar', role: 'progressbar', 'aria-label': title, 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill);
  const foot = el('div', { class: 'foot' });
  // "Sync with Claude": type the % Claude's own Usage page shows → exact now, and a new calibration point for the live estimate.
  const input = el('input', { class: 'input', type: 'text', inputmode: 'decimal', 'aria-label': `${title}: percentage shown by Claude`, placeholder: 'e.g. 36', style: 'width:70px;height:28px;text-align:center' });
  const saveBtn = el('button', { class: 'btn sm primary', type: 'button', text: 'Save' });
  const msg = el('span', { class: 'muted' });
  const syncRow = el('div', { class: 'syncrow', hidden: true }, el('span', { class: 'muted', text: 'Claude says' }), input, el('span', { class: 'muted', text: '%' }), saveBtn, msg);
  const syncBtn = el('button', { class: 'btn sm quiet', type: 'button', text: 'Sync with Claude', title: 'Open Claude → Settings → Usage and type the percentage it shows' });
  const commit = async () => {
    const v = parseFloat(String(input.value).replace('%', '').replace(',', '.'));
    if (!(v >= 0 && v <= 100)) { msg.textContent = 'Enter a number from 0 to 100'; msg.style.color = 'var(--bad)'; return; }
    const r = await api.setReading(id, v);
    if (r && r.ok) { syncRow.hidden = true; syncBtn.hidden = false; input.value = ''; msg.textContent = ''; } else { msg.textContent = 'Could not save'; msg.style.color = 'var(--bad)'; }
  };
  saveBtn.addEventListener('click', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { e.stopPropagation(); syncRow.hidden = true; syncBtn.hidden = false; } });
  syncBtn.addEventListener('click', () => { syncRow.hidden = false; syncBtn.hidden = true; msg.textContent = ''; input.focus(); });
  const root = el('div', { class: 'meter' }, el('div', { class: 'top' }, el('span', { class: 'label', text: title }), val), bar, foot, el('div', { class: 'syncwrap' }, syncBtn, syncRow));
  return {
    root,
    set(m, now) {
      val.textContent = `${m.approx ? '≈ ' : ''}${fmtPct(m.pct)}% used`;
      fill.style.setProperty('--p', String(clamp(m.pct, 0, 100) / 100)); bar.dataset.k = kindUsed(m.pct); bar.setAttribute('aria-valuenow', Math.round(m.pct));
      const age = Math.max(0, (now - m.readAt) / 1000);
      const who = m.source === 'manual' ? 'you said' : 'Claude said';
      const note = m.source === 'estimate' ? 'from your token budget'
        : m.source === 'manual' && age < 90 ? 'from you · just now'
        : m.approx && m.baseline != null ? `live estimate · ${who} ${fmtPct(m.baseline)}% ${fmtDur(age)} ago`
        : age < 90 ? 'just now' : `Claude's last reading ${fmtDur(age)} ago`;
      const how = m.mode === 'dollars' ? 'Claude only saves a reading now and then. Since then, Claude Code spend is exact (from the bridge); Cowork and Chat are estimated from tokens.'
        : m.approx ? 'Claude only saves a reading now and then. Tokkie adds what you have used since, calibrated against Claude’s earlier readings.' : '';
      const parts = [el('span', { text: note, title: how })];
      if (m.limitUsd) parts.push(el('span', { class: 'val', text: `$${m.usd.toFixed(2)} of $${Math.round(m.limitUsd)}` }));
      else if (m.id === 'extra') parts.push(el('button', { class: 'btn sm quiet', type: 'button', text: 'Claude shows a $ limit? Enter it →', title: 'Type the $ limit from Claude → Settings → Usage (e.g. $600) for dollars and a live estimate', onclick: () => api.openTab('settings') }));
      if (m.resetsAt && m.resetsAt > now) parts.push(el('span', { text: `resets in ${fmtDur((m.resetsAt - now) / 1000)}` }));
      if (m.pace) {
        const p = m.pace, out = p.runOutAt ? new Date(p.runOutAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null;
        const txt = out ? `At this pace you run out ~${out}` : p.pace > 0 ? `Using ${Math.round(p.pace)}% faster than the clock` : `On pace · ${Math.round(-p.pace)}% to spare`;
        parts.push(el('span', { class: 'pace', 'data-k': p.tone, text: txt, title: `${fmtPct(m.pct)}% used, ${Math.round(p.elapsed)}% of this period gone` }));
      }
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
  const connectMsg = el('p'); const connectBtn = el('button', { class: 'btn primary', type: 'button' }, icon('plug'), 'Connect the bridge');
  const connectErr = el('p', { class: 'muted', hidden: true, style: 'color:var(--bad)' });
  const connect = el('div', { class: 'connect' }, el('strong', { text: 'Show your plan usage' }), connectMsg, connectBtn, connectErr);
  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    let r; try { r = await api.connect(); } catch { r = { ok: false, error: 'Something went wrong — nothing was changed.' }; } finally { connectBtn.disabled = false; }
    connectErr.hidden = r.ok; if (!r.ok) connectErr.textContent = r.error;
  });
  const waiting = el('div', { class: 'connect', style: 'border-style:solid;border-color:var(--accent)' }, el('strong', { text: '✓ Bridge connected — waiting for a reading' }),
    el('p', { text: 'Start a new Claude Code session: the bridge reports exact cost straight away, and plan % where your plan provides it. Open Claude’s desktop app (Settings → Usage) to give me a percentage to start from.' }),
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
        if (!nodes.has(m.id)) nodes.set(m.id, meterNode(m.label, m.id, api));
        const n = nodes.get(m.id); n.set(m, now); list.push(n.root);
      }
      if (!meters.length) {
        if (S.hook && S.hook.installed) list.push(waiting);
        else { connectMsg.textContent = 'Open Claude’s desktop app once so I can read its usage readings, or connect the Claude Code bridge for exact cost. You can undo it any time in Settings.'; list.push(connect); }
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
