import { el, icon, fmtTokens, fmtDur, fmtPct, clamp, fmtRunOut } from '../util.js';

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
  syncBtn.className = 'btn sm';                       // a real button, like Clipboard and Optimize elsewhere
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
      // what matters first: the pace/run-out line, then dollars, then where the number comes from
      const parts = [];
      if (m.pace) {
        const p = m.pace, out = p.runOutAt ? fmtRunOut(p.runOutAt, now) : null;
        const txt = out ? `At this pace you run out ${out}` : p.pace > 0 ? `Using ${Math.round(p.pace)}% faster than the clock` : `On pace · ${Math.round(-p.pace)}% to spare`;
        parts.push(el('span', { class: 'pace', 'data-k': p.tone, text: txt, title: `${fmtPct(m.pct)}% used, ${Math.round(p.elapsed)}% of this period gone` }));
      }
      if (m.limitUsd) parts.push(el('span', { class: 'val', text: `$${m.usd.toFixed(2)} of $${Math.round(m.limitUsd)}` }));
      else if (m.id === 'extra') parts.push(el('button', { class: 'btn sm quiet', type: 'button', text: 'Claude shows a $ limit? Enter it →', title: 'Type the $ limit from Claude → Settings → Usage (e.g. $600) for dollars and a live estimate', onclick: () => api.openTab('settings') }));
      if (m.resetsAt && m.resetsAt > now) parts.push(el('span', { text: `resets in ${fmtDur((m.resetsAt - now) / 1000)}` }));
      parts.push(el('span', { class: 'prov', text: note, title: how }));
      foot.replaceChildren(...parts);
    },
  };
}

/** Codex's limits, exactly as Codex reports them (no syncing needed): one bar per window, named by its length. */
function codexWindowNode() {
  const val = el('span', { class: 'left' }), fill = el('i'), lab = el('span', { class: 'label' });
  const bar = el('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill), foot = el('div', { class: 'foot' });
  const root = el('div', { class: 'meter' }, el('div', { class: 'top' }, lab, val), bar, foot);
  return { root, set(w, now) {
    lab.textContent = w.label; val.textContent = `${fmtPct(w.pct)}% used`; bar.setAttribute('aria-label', `Codex ${w.label}`);
    fill.style.setProperty('--p', String(clamp(w.pct, 0, 100) / 100)); bar.dataset.k = kindUsed(w.pct); bar.setAttribute('aria-valuenow', Math.round(w.pct));
    const parts = [];
    if (w.resetsAt && w.mins) {                              // pace: how much of the window has gone vs how much is used
      const elapsed = clamp(1 - (w.resetsAt - now) / (w.mins * 60e3), 0, 1) * 100;
      if (elapsed > 2 && w.pct > 0) {
        const rate = w.pct / elapsed;                                          // >1: using faster than the clock
        const usedMs = (w.mins * 60e3) * elapsed / 100, perMs = w.pct / Math.max(1, usedMs);
        const outAt = rate > 1 ? now + (100 - w.pct) / perMs : null;            // when 100% is reached at this rate
        const k = rate > 1.25 ? 'alert' : rate > 1 ? 'fast' : 'ok';
        parts.push(el('span', { class: 'pace', 'data-k': k, text: outAt && outAt < w.resetsAt ? `At this pace you run out ${fmtRunOut(outAt, now)}` : rate > 1 ? `Using ${Math.round((rate - 1) * 100)}% faster than the clock` : 'On pace' }));
      }
    }
    if (w.resetsAt && w.resetsAt > now) parts.push(el('span', { text: `resets in ${fmtDur((w.resetsAt - now) / 1000)}` }));
    parts.push(el('span', { class: 'prov', text: 'exact, from Codex' }));
    foot.replaceChildren(...parts);
  } };
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
  const fiveK = stats.children[1].firstChild;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'spark'); svg.setAttribute('viewBox', '0 0 300 52'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img');
  const area = document.createElementNS(NS, 'path'); area.setAttribute('class', 'area'); const line = document.createElementNS(NS, 'path'); line.setAttribute('class', 'line');
  svg.append(area, line);
  const sparkNote = el('span');
  const sparkWrap = el('div', {}, svg, el('div', { class: 'spark-foot' }, el('span', { text: '60 min ago' }), sparkNote, el('span', { text: 'now' })));
  const foot = el('p', { class: 'muted' });
  const metersBox = el('div', { class: 'stack' });
  // One section per AI, with chips on top to jump between them (shown once there's more than one).
  const chip = (id, name) => { const v = el('span', { class: 'pv' }); const b = el('button', { class: 'prov-chip', type: 'button', 'data-p': id, onclick: () => sections[id].scrollIntoView({ behavior: 'smooth', block: 'start' }) }, el('span', { class: 'pdot', 'data-p': id }), el('span', { text: name }), v); b.v = v; return b; };
  const chips = { claude: chip('claude', 'Claude'), codex: chip('codex', 'Codex') };
  const chipRow = el('div', { class: 'prov-chips', role: 'navigation', 'aria-label': 'AIs Tokkie is tracking', hidden: true }, chips.claude, chips.codex);
  const head = (id, name) => { const sub = el('span', { class: 'muted' }); const h = el('div', { class: 'prov-head' }, el('span', { class: 'pdot', 'data-p': id }), el('span', { class: 'pname', text: name }), sub); h.sub = sub; return h; };
  const claudeHead = head('claude', 'Claude'), codexHead = head('codex', 'Codex');
  const codexMeters = el('div', { class: 'stack' }), codexFoot = el('p', { class: 'muted' }), codexNodes = [];
  const sections = {
    claude: el('section', { class: 'stack prov-sec', 'data-p': 'claude' }, claudeHead, metersBox, el('div', { class: 'divider' }), stats, sparkWrap, foot),
    codex: el('section', { class: 'stack prov-sec', 'data-p': 'codex', hidden: true }, codexHead, codexMeters, codexFoot),
  };
  root.append(el('div', { class: 'stack' }, welcome, chipRow, sections.claude, sections.codex));

  let lastIds = '';
  return {
    update(S) {
      welcome.hidden = true;                 // the guided tour replaces this card
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

      vToday.textContent = fmtTokens(S.tokens.today);
      const sameAsToday = Math.abs(S.tokens.last5h - S.tokens.today) < Math.max(1, S.tokens.today * 0.02);
      fiveK.textContent = sameAsToday ? 'This week' : 'Last 5 hours';
      vFive.textContent = fmtTokens(sameAsToday ? S.tokens.week : S.tokens.last5h);
      vBurn.textContent = S.tokens.burn > 50 ? `${fmtTokens(S.tokens.burn)}/min` : 'idle';
      const sp = S.spark, max = Math.max(1, ...sp), W = 300, H = 52, step = W / (sp.length - 1);
      // square-root scale: one big spike no longer flattens the rest of the hour into a line
      const sq = Math.sqrt(max);
      const pts = sp.map((v, i) => [i * step, H - 3 - (Math.sqrt(v) / sq) * (H - 9)]);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      line.setAttribute('d', d); area.setAttribute('d', `${d} L${W} ${H} L0 ${H} Z`);
      sparkNote.textContent = max > 1 ? `peak ${fmtTokens(max)}/min` : 'quiet hour';
      svg.setAttribute('aria-label', `Token activity over the last hour. ${sparkNote.textContent}.`);
      // Codex: shown once it's found and switched on
      const cx = S.providers && S.providers.codex, showCodex = !!(cx && cx.on && cx.available);
      sections.codex.hidden = !showCodex; chipRow.hidden = !showCodex; claudeHead.hidden = !showCodex;
      if (showCodex) {
        const ws = (cx.limits && cx.limits.windows) || [];
        while (codexNodes.length < ws.length) codexNodes.push(codexWindowNode());
        ws.forEach((w, i) => codexNodes[i].set(w, now));
        const want = codexNodes.slice(0, ws.length).map((n) => n.root);
        if (codexMeters.childElementCount !== want.length || want.some((n, i) => codexMeters.children[i] !== n)) codexMeters.replaceChildren(...(want.length ? want : [el('p', { class: 'muted', text: cx.limitsError === 'no-cli' ? 'Limits need the ChatGPT desktop app or the Codex CLI on this computer. Runs and tokens still show in History.' : 'Asking Codex for your limits…' })]));
        codexHead.sub.textContent = [cx.limits && cx.limits.plan ? cx.limits.plan.charAt(0).toUpperCase() + cx.limits.plan.slice(1) : '', cx.active ? 'working now' : ''].filter(Boolean).join(' · ');
        codexFoot.textContent = `Today: ${cx.today.runs} run${cx.today.runs === 1 ? '' : 's'} · ${fmtTokens(cx.today.tokens)} tokens. Read from Codex on this computer; its login is never touched.`;
        const top = (m) => (m ? `${fmtPct(m.pct)}%` : '–');
        chips.claude.v.textContent = top(meters[0]); chips.codex.v.textContent = top(ws[0]);
        chips.claude.dataset.k = meters[0] ? kindUsed(meters[0].pct) : ''; chips.codex.dataset.k = ws[0] ? kindUsed(ws[0].pct) : '';
        claudeHead.sub.textContent = S.active && S.active.provider !== 'codex' ? 'working now' : '';
      }
      foot.textContent = S.files ? `Percentages come from Claude itself and include Chat. Token counts cover Claude Code + Cowork (${S.files} logs).` : 'No Claude sessions found yet — start one and I’ll pick it up.';
    },
  };
}
