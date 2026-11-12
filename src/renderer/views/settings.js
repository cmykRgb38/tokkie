import { el, icon, fmtTokens, fmtDur } from '../util.js';
import { prettyKey } from './plan.js';

// Two row shapes, used everywhere in Settings:
//  · field: label and explanation on top, the control below at full width (choices, inputs)
//  · switchRow: label (and explanation) with the on/off switch on the right
function field(label, desc, ...controls) {
  return el('div', { class: 'field' }, el('div', { class: 't', text: label }), desc ? el('div', { class: 'd', text: desc }) : null, ...controls.filter(Boolean));
}
function switchRow(label, desc, sw) {
  return el('div', { class: 'field inline' }, el('div', { class: 'ftext' }, el('div', { class: 't', text: label }), desc ? el('div', { class: 'd', text: desc }) : null), sw);
}
const group = (title, ...rows) => el('section', { class: 'sgroup', 'aria-label': title }, el('h3', { class: 'sh', text: title }), ...rows.filter(Boolean));

function toggle(label, desc, key, api) {
  const sw = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': label, 'aria-checked': 'false' });
  sw.addEventListener('click', () => api.setSettings({ [key]: sw.getAttribute('aria-checked') !== 'true' }));
  return { sw, row: switchRow(label, desc, sw) };
}

export function settingsView(root, api) {
  const limitStatus = el('div', { class: 'd' }); const limitBtn = el('button', { class: 'btn sm', type: 'button' });
  const limitMsg = el('div', { class: 'd', style: 'color:var(--bad);max-width:none', hidden: true });
  limitBtn.addEventListener('click', async () => {
    limitBtn.disabled = true; let r;
    try { const st = await api.setupStatus(); r = st.installed ? await api.disconnect() : await api.connect(); } catch { r = { ok: false, error: 'Something went wrong — nothing was changed.' }; } finally { limitBtn.disabled = false; }
    limitMsg.hidden = r.ok; limitMsg.textContent = r.error || ''; refreshSetup();
  });

  const mkSeg = (opts, key, parse = (v) => v) => {
    const b = el('div', { class: 'seg', role: 'group' }, opts.map(([v, l]) => el('button', { type: 'button', 'data-v': String(v), 'aria-pressed': 'false', text: l, onclick: () => api.setSettings({ [key]: parse(v) }) })));
    return { node: b, set(val) { b.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === String(val)))); } };
  };
  const layout = mkSeg([['dock', 'Dock'], ['pills', 'Pills'], ['pet', 'Pet only']], 'layout');
  const DOCK_ITEMS = [['usage', 'Usage %', 'Your main limit, live (≈ = estimated since Claude’s last reading).'], ['pace', 'Pace', 'Ahead of or behind the clock, and when you’d run out.'],
    ['status', 'Status', 'Working / done / idle.'], ['next', 'Next prompt', 'Shows up when a long chat or an expired cache makes your next prompt pricey, with what a new chat would cost.'], ['tokens', 'Tokens today', 'Claude Code + Cowork.'], ['lastPrompt', 'Last prompt cost', 'Exact $ of your last Claude Code prompt (needs the bridge).'],
    ['context', 'Context', 'How full the current conversation is.'], ['cache', 'Cache timer', 'Minutes left on the prompt cache — reply before it expires to save tokens.'], ['agents', 'Agents', 'Sub-agents running (needs the bridge).'], ['codex', 'Codex', 'Your Codex limit, exactly as Codex reports it (shows when Codex is found).']];
  const dockToggles = DOCK_ITEMS.map(([k, l, d]) => {
    const sw = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': l, 'aria-checked': 'false' });
    // the same items drive the Dock and the Pills; each layout remembers its own picks
    sw.addEventListener('click', () => { const key = S.settings.layout === 'pills' ? 'pills' : 'dock'; api.setSettings({ [key]: { ...S.settings[key], [k]: sw.getAttribute('aria-checked') !== 'true' } }); });
    return { k, sw, row: switchRow(l, d, sw) };
  });
  const place = mkSeg([['below', 'Below'], ['above', 'Above'], ['claude', 'Claude bar']], 'dockPlace');
  const placeNote = el('div', { class: 'd note-inline' });
  const placeRow = field('Position', 'Where the Dock sits: under or over your pet, or as a bar above Claude Code’s prompt box.', place.node, placeNote);
  const itemsSummary = el('summary', { class: 'subhead' });
  const itemsBox = el('details', { class: 'items' }, itemsSummary, ...dockToggles.map((t) => t.row));
  const dockBox = el('div', { class: 'dockset' }, placeRow, itemsBox);

  const spendIn = el('input', { class: 'input', type: 'number', min: 0, step: 10, 'aria-label': 'Monthly spend limit in dollars', placeholder: 'Off' });
  spendIn.addEventListener('change', () => api.setSettings({ spendLimitUsd: Number(spendIn.value) || 0 }));
  // A calendar: pick the date Claude shows under “Resets …”; it repeats on that day every month.
  const dayIn = el('input', { class: 'input', type: 'date', 'aria-label': 'Next reset date' });
  dayIn.addEventListener('change', () => { const m = /^\d{4}-\d{2}-(\d{2})$/.exec(dayIn.value); if (m) api.setSettings({ resetDay: Number(m[1]) }); });
  const nextReset = (day, now) => {
    const at = (y, mo) => new Date(Date.UTC(y, mo, Math.min(day, new Date(Date.UTC(y, mo + 1, 0)).getUTCDate())));
    const t = new Date(now); let d = at(t.getUTCFullYear(), t.getUTCMonth()); if (d.getTime() <= now) d = at(t.getUTCFullYear(), t.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  };
  const spendRow = field('Spend limit ($ per month)', 'If Claude’s Usage page shows a dollar limit, enter it to see dollars.', el('div', { class: 'with-unit' }, el('span', { class: 'unit', text: '$' }), spendIn));
  const dayHint = el('div', { class: 'd' });
  const dayRow = field('Next reset', 'The date under “Resets …” on Claude’s Usage page.', dayIn, dayHint);
  const optModel = mkSeg([['haiku', 'Haiku'], ['sonnet', 'Sonnet'], ['opus', 'Opus']], 'optimizerModel');
  const optRow = field('Model', 'Haiku is fast and cheapest. Sonnet reads intent better. Opus is best, slowest and uses the most.', optModel.node);
  const optMode = mkSeg([['clearer', 'Clearer'], ['shorter', 'Shorter']], 'optimizerMode');
  const optModeRow = field('Style', 'Clearer adds what Claude would otherwise guess, so it’s often a little longer. Shorter keeps the meaning in the fewest tokens.', optMode.node);
  const optBtnT = toggle('Button in Claude Code', 'A ✨ Optimize button above Claude’s prompt box rewrites what you typed. Undo puts it back.', 'optimizeButton', api);
  const theme = mkSeg([['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], 'theme');
  const size = mkSeg([[5, 'S'], [6, 'M'], [8, 'L']], 'scale', Number);

  let S = null;
  /** A click-to-record shortcut button for one setting (the Estimate and the Optimize shortcuts). */
  function recorder(settingKey) {
    const btn = el('button', { class: 'kbd', type: 'button', style: 'cursor:pointer' });
    const msg = el('div', { class: 'd', style: 'color:var(--bad)', hidden: true });
    const rec = { btn, msg, recording: false };
    btn.addEventListener('click', () => { rec.recording = true; btn.textContent = 'Press keys…'; btn.focus(); });
    btn.addEventListener('blur', () => { rec.recording = false; if (S) btn.textContent = prettyKey(S.settings[settingKey], S.platform); });
    btn.addEventListener('keydown', async (e) => {
      if (!rec.recording) return;
      e.preventDefault();
      if (e.key === 'Escape') { btn.blur(); return; }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const mods = []; const mac = S && S.platform === 'darwin';
      if (e.metaKey) mods.push(mac ? 'Command' : 'Super'); if (e.ctrlKey) mods.push(mac ? 'Control' : 'CommandOrControl'); if (e.altKey) mods.push('Alt'); if (e.shiftKey) mods.push('Shift');
      if (!mods.length) { msg.hidden = false; msg.textContent = 'Include ⌘/Ctrl, Alt or Shift.'; return; }
      const named = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Escape: 'Esc' };
      const key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : named[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
      const r = await api.setSettings({ [settingKey]: [...mods, key].join('+') });
      msg.hidden = r.ok; msg.textContent = r.error || ''; btn.blur();
    });
    return rec;
  }
  const hot = recorder('hotkey'), optHot = recorder('optimizeHotkey');
  const hotBtn = hot.btn, hotMsg = hot.msg;
  const hotStatus = el('div', { class: 'd' }), optHotStatus = el('div', { class: 'd' });
  const optHotRow = el('div', { class: 'field' },
    el('div', { class: 'field-head' }, el('div', { class: 'ftext' }, el('div', { class: 't', text: 'Optimize shortcut' }), el('div', { class: 'd', text: 'For Chat and Cowork: copy your prompt, press this, then paste. The better version replaces it on your clipboard.' })), optHot.btn),
    optHotStatus, optHot.msg);
  // Sources: which AIs Tokkie tracks, each with what it can see right now
  const srcRow = (id, name) => {
    const sw = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': `Track ${name}`, 'aria-checked': 'true' });
    sw.addEventListener('click', () => api.setSettings({ providers: { [id]: sw.getAttribute('aria-checked') !== 'true' } }));
    const d = el('div', { class: 'd' });
    const row = el('div', { class: 'field inline' }, el('div', { class: 'ftext' }, el('div', { class: 't' }, el('span', { class: 'pdot', 'data-p': id, 'aria-hidden': 'true' }), ' ', name), d), sw);
    return { sw, d, row };
  };
  const srcClaude = srcRow('claude', 'Claude'), srcCodex = srcRow('codex', 'Codex');
  const stripT = toggle('Floating strip', 'A slim bar with the same items, tips and Optimize. Drag it just above Chat’s or Cowork’s prompt box; it stays there.', 'strip', api);

  const clip = toggle('Watch clipboard', 'Estimate automatically whenever you copy a long prompt.', 'clipboardWatch', api);
  const alertT = toggle('Pet reacts when a run finishes', 'It hops and shows a blinking ! when Claude or Codex finishes, or when Claude goes quiet mid-run.', 'alertBubble', api);
  const bubbleT = toggle('Show the speech bubble', 'The “Claude is done — your turn” note above the pet (or Codex, whichever finished).', 'speechBubble', api);
  const notify = toggle('Notify when done', 'A quiet alert when a run longer than a minute finishes.', 'notifyDone', api);
  const notifyR = toggle('Notify when a limit resets', 'When a limit you had used half or more of starts over, for Claude and Codex.', 'notifyReset', api);
  const notifyB = toggle('Notify when you earn a badge', 'Your pet celebrates either way; this adds a notification. Badges are in Pets → Badges.', 'notifyBadges', api);
  const notifyW = toggle('Weekly recap on Mondays', 'Monday morning: a short note on last week (runs, tokens, time). The full recap is at the top of History.', 'notifyRecap', api);
  const updT = toggle('Tell me about new versions', 'Once a day Tokkie asks GitHub for the newest version number. Nothing about you is sent, and this is the only time Tokkie goes online.', 'checkUpdates', api);
  const updStatus = el('div', { class: 'd' });
  const updBtn = el('button', { class: 'btn sm', type: 'button', hidden: true });
  let updUrl = '';
  updBtn.addEventListener('click', async () => {
    if (updUrl) { api.openExternal(updUrl); return; }
    updBtn.disabled = true; updBtn.textContent = 'Checking…';
    try { await api.checkUpdate(); } finally { updBtn.disabled = false; }
  });
  const updRow = el('div', { class: 'field inline', hidden: true }, el('div', { class: 'ftext' }, el('div', { class: 't', text: 'Version' }), updStatus), updBtn);
  const login = toggle('Launch at login', null, 'launchAtLogin', api);
  const top = toggle('Always on top', null, 'alwaysOnTop', api);

  const budget = el('input', { class: 'input', type: 'number', min: 0, step: 10000, 'aria-label': '5-hour token budget', placeholder: 'off' });
  budget.addEventListener('change', () => api.setSettings({ fallbackBudget5h: Number(budget.value) || 0 }));
  const budgetRow = field('5-hour token budget', 'Only used when Tokkie can’t read your plan’s limits.', budget);

  const srcBox = el('div', { class: 'src' }); const details = el('details', {}, el('summary', { class: 'muted', style: 'cursor:pointer', text: 'Where I read from' }), srcBox);
  details.addEventListener('toggle', async () => { if (details.open) { const s = await api.sources(); srcBox.replaceChildren(...(s.length ? s.map((x) => el('div', { text: `${x.source === 'cowork' ? 'Cowork' : 'Claude Code'} · ${x.dir}` })) : [el('div', { text: 'No transcript folders found yet.' })])); } });

  const ver = el('span', { class: 'muted' });
  const bridgeRow = el('div', { class: 'field' },
    el('div', { class: 'field-head' }, el('div', { class: 'ftext' }, el('div', { class: 't', text: 'Bridge' }), limitStatus), limitBtn), limitMsg);
  const layoutRow = field('Layout', 'What sits with your pet on the desktop.', layout.node);
  const hotRow = el('div', { class: 'field' },
    el('div', { class: 'field-head' }, el('div', { class: 'ftext' }, el('div', { class: 't', text: 'Shortcut' }), el('div', { class: 'd', text: 'Copy a prompt, then press this anywhere to estimate it. Click to record a new one.' })), hotBtn),
    hotStatus, hotMsg);
  root.append(el('div', { class: 'settings' },
    group('Sources', srcClaude.row, srcCodex.row),
    group('Claude Code', bridgeRow, spendRow, dayRow),
    group('Prompt optimizer', optRow, optModeRow, optBtnT.row, optHotRow),
    group('On your desktop', layoutRow, dockBox, stripT.row),
    group('Appearance', field('Theme', null, theme.node), field('Pet size', null, size.node)),
    group('Estimate', hotRow, clip.row),
    group('Alerts', alertT.row, bubbleT.row, notify.row, notifyR.row, notifyB.row, notifyW.row),
    group('System', updT.row, updRow, login.row, top.row, budgetRow,
      el('div', { class: 'field inline' }, el('div', { class: 'ftext' }, el('div', { class: 't', text: 'Tour' }), el('div', { class: 'd', text: 'A one-minute walk through what Tokkie can do.' })),
        el('button', { class: 'btn sm', type: 'button', text: 'Take the tour', onclick: () => api.startTour() }))),
    details,
    el('div', { class: 'sfoot' }, ver, el('div', { class: 'sfoot-actions' }, el('button', { class: 'btn sm quiet', type: 'button', text: 'Hide', onclick: () => api.hide() }), el('button', { class: 'btn sm quiet danger', type: 'button', text: 'Quit Tokkie', onclick: () => api.quit() })))));

  let setup = { installed: false };
  async function refreshSetup() {
    setup = await api.setupStatus();
    limitBtn.textContent = setup.installed ? 'Disconnect' : 'Connect';
    limitStatus.textContent = setup.installed
      ? (S && S.bridge && S.bridge.seen ? 'Connected. Exact Claude Code cost, context and agents.' : 'Installed. Starts reporting from your next new Claude Code session.')
      : setup.error === 'unparseable' ? 'Claude Code’s settings.json has a JSON error. Fix it first.' : 'A read-only helper inside Claude Code for exact cost, context and agents. Also powers ✨ Optimize.';
  }
  refreshSetup();

  return {
    update(s) {
      S = s; const st = s.settings;
      theme.set(st.theme); size.set(st.scale); layout.set(st.layout); optModel.set(st.optimizerModel || 'haiku'); optMode.set(st.optimizerMode || 'clearer');
      dockBox.hidden = st.layout === 'pet';
      placeRow.hidden = st.layout !== 'dock'; place.set(st.dockPlace || 'below');
      placeNote.hidden = st.layout !== 'dock' || st.dockPlace !== 'claude';
      placeNote.textContent = s.hook && s.hook.installed
        ? 'Shown as a bar above Claude Code’s prompt box (desktop Code tab and terminal), starting with your next new session. Tokkie stays on your desktop.'
        : 'Needs the Claude Code bridge — connect it above. Until then nothing is shown in Claude Code.';
      placeNote.style.color = s.hook && s.hook.installed ? '' : 'var(--warn)';
      const where = st.layout === 'pills' ? 'Pills' : st.dockPlace === 'claude' ? 'Claude bar' : 'Dock';
      const picks = st.layout === 'pills' ? (st.pills || {}) : (st.dock || {});
      let on = 0;
      for (const t of dockToggles) { const v = st.layout === 'pills' ? !!picks[t.k] : picks[t.k] !== false; if (v) on++; t.sw.setAttribute('aria-checked', String(v)); }
      itemsSummary.textContent = `What the ${where} shows · ${on} of ${dockToggles.length}`;
      if (document.activeElement !== spendIn) spendIn.value = st.spendLimitUsd || '';
      if (document.activeElement !== dayIn) dayIn.value = nextReset(st.resetDay || 1, Date.now());
      { const d = new Date(nextReset(st.resetDay || 1, Date.now()) + 'T00:00:00'); dayHint.textContent = `${d.toLocaleDateString([], { day: 'numeric', month: 'long' })} · repeats every month`; }
      dayRow.hidden = !(st.spendLimitUsd > 0);
      if (!hot.recording) hotBtn.textContent = prettyKey(st.hotkey, s.platform);
      if (!optHot.recording) optHot.btn.textContent = prettyKey(st.optimizeHotkey, s.platform);
      const ok2 = !s.optKey || s.optKey.ok;
      optHotStatus.textContent = ok2 ? '● Active' : '● Not active — another app is using it. Record a different one.';
      optHotStatus.style.color = ok2 ? 'var(--good)' : 'var(--bad)';
      stripT.sw.setAttribute('aria-checked', String(!!st.strip));
      { const pv = st.providers || {}, cx = (s.providers && s.providers.codex) || {};
        srcClaude.sw.setAttribute('aria-checked', String(pv.claude !== false)); srcCodex.sw.setAttribute('aria-checked', String(pv.codex !== false));
        srcClaude.d.textContent = 'Claude Code and Cowork runs, plus your plan % from the Claude app' + (s.bridge && s.bridge.seen ? ', and exact cost from the bridge.' : '.');
        srcCodex.d.textContent = pv.codex === false ? 'Off.' : !cx.available ? 'Not found on this computer. Install the ChatGPT desktop app or the Codex CLI and use Codex once.'
          : cx.limits ? `Found: runs and tokens from Codex, and exact limits (${cx.limits.plan ? cx.limits.plan + ' plan' : 'your plan'}). Codex’s login is never read.`
          : cx.limitsError === 'no-cli' ? 'Found: runs and tokens. Limits need the ChatGPT desktop app or the Codex CLI.' : 'Found: runs and tokens. Asking Codex for your limits…'; }
      const hk = s.hotkey, ok = !hk || hk.ok, fresh = hk && hk.firedAt && Date.now() - hk.firedAt < 15000;
      hotStatus.textContent = !ok ? '● Not active — another app is using it. Record a different one.'
        : fresh ? '✓ Received! The shortcut works.' : hk && hk.firedAt ? `● Active · last used ${fmtDur((Date.now() - hk.firedAt) / 1000)} ago` : '● Active — press it now to test';
      hotStatus.style.color = ok ? 'var(--good)' : 'var(--bad)';
      optBtnT.sw.setAttribute('aria-checked', String(st.optimizeButton !== false));
      for (const [t, k] of [[alertT, 'alertBubble'], [bubbleT, 'speechBubble'], [clip, 'clipboardWatch'], [notify, 'notifyDone'], [notifyR, 'notifyReset'], [notifyB, 'notifyBadges'], [notifyW, 'notifyRecap'], [updT, 'checkUpdates'], [login, 'launchAtLogin'], [top, 'alwaysOnTop']]) t.sw.setAttribute('aria-checked', String(!!st[k]));
      bubbleT.sw.disabled = st.alertBubble === false; bubbleT.row.classList.toggle('is-disabled', st.alertBubble === false);
      login.sw.disabled = !s.packaged; login.row.title = s.packaged ? '' : 'Available in the installed app';
      if (document.activeElement !== budget) budget.value = st.fallbackBudget5h || '';
      budgetRow.hidden = s.limits.connected;
      ver.textContent = `Tokkie ${s.version}`;
      { // new versions (only when you turned the check on)
        const u = s.update, on = !!st.checkUpdates;
        updRow.hidden = !on;
        updUrl = u && u.ok && u.newer ? u.url : '';
        updStatus.textContent = !u ? 'Checking…' : !u.ok ? `Couldn’t check (${u.error}).` : u.newer ? `Tokkie ${u.latest} is out. You have ${s.version}.` : `You have the newest (${s.version}).`;
        updStatus.style.color = u && u.ok && u.newer ? 'var(--good)' : '';
        updBtn.hidden = !on; if (!updBtn.disabled) updBtn.textContent = updUrl ? 'Download' : 'Check now';
      }
    },
    refreshSetup,
  };
}
