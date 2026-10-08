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
    ['status', 'Status', 'Working / done / idle.'], ['tokens', 'Tokens today', 'Claude Code + Cowork.'], ['lastPrompt', 'Last prompt cost', 'Exact $ of your last Claude Code prompt (needs the bridge).'],
    ['context', 'Context', 'How full the current conversation is.'], ['cache', 'Cache timer', 'Minutes left on the prompt cache — reply before it expires to save tokens.'], ['agents', 'Agents', 'Sub-agents running (needs the bridge).']];
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

  const hotBtn = el('button', { class: 'kbd', type: 'button', style: 'cursor:pointer' });
  const hotMsg = el('div', { class: 'd', style: 'color:var(--bad)', hidden: true });
  const hotStatus = el('div', { class: 'd' });
  let recording = false, S = null;
  hotBtn.addEventListener('click', () => { recording = true; hotBtn.textContent = 'Press keys…'; hotBtn.focus(); });
  hotBtn.addEventListener('blur', () => { recording = false; if (S) hotBtn.textContent = prettyKey(S.settings.hotkey, S.platform); });
  hotBtn.addEventListener('keydown', async (e) => {
    if (!recording) return;
    e.preventDefault();
    if (e.key === 'Escape') { hotBtn.blur(); return; }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const mods = []; const mac = S && S.platform === 'darwin';
    if (e.metaKey) mods.push(mac ? 'Command' : 'Super'); if (e.ctrlKey) mods.push(mac ? 'Control' : 'CommandOrControl'); if (e.altKey) mods.push('Alt'); if (e.shiftKey) mods.push('Shift');
    if (!mods.length) { hotMsg.hidden = false; hotMsg.textContent = 'Include ⌘/Ctrl, Alt or Shift.'; return; }
    const named = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Escape: 'Esc' };
    const key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : named[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    const r = await api.setSettings({ hotkey: [...mods, key].join('+') });
    hotMsg.hidden = r.ok; hotMsg.textContent = r.error || ''; hotBtn.blur();
  });

  const clip = toggle('Watch clipboard', 'Estimate automatically whenever you copy a long prompt.', 'clipboardWatch', api);
  const alertT = toggle('Pet reacts when Claude needs me', 'It hops and shows a blinking ! when a run finishes or goes quiet.', 'alertBubble', api);
  const bubbleT = toggle('Show the speech bubble', 'The “Done — awaiting your response” note above the pet.', 'speechBubble', api);
  const notify = toggle('Notify when done', 'A quiet alert when a run longer than a minute finishes.', 'notifyDone', api);
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
    group('Claude Code', bridgeRow, spendRow, dayRow),
    group('Prompt optimizer', optRow, optModeRow, optBtnT.row),
    group('On your desktop', layoutRow, dockBox),
    group('Appearance', field('Theme', null, theme.node), field('Pet size', null, size.node)),
    group('Estimate', hotRow, clip.row),
    group('Alerts', alertT.row, bubbleT.row, notify.row),
    group('System', login.row, top.row, budgetRow,
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
      if (!recording) hotBtn.textContent = prettyKey(st.hotkey, s.platform);
      const hk = s.hotkey, ok = !hk || hk.ok, fresh = hk && hk.firedAt && Date.now() - hk.firedAt < 15000;
      hotStatus.textContent = !ok ? '● Not active — another app is using it. Record a different one.'
        : fresh ? '✓ Received! The shortcut works.' : hk && hk.firedAt ? `● Active · last used ${fmtDur((Date.now() - hk.firedAt) / 1000)} ago` : '● Active — press it now to test';
      hotStatus.style.color = ok ? 'var(--good)' : 'var(--bad)';
      optBtnT.sw.setAttribute('aria-checked', String(st.optimizeButton !== false));
      for (const [t, k] of [[alertT, 'alertBubble'], [bubbleT, 'speechBubble'], [clip, 'clipboardWatch'], [notify, 'notifyDone'], [login, 'launchAtLogin'], [top, 'alwaysOnTop']]) t.sw.setAttribute('aria-checked', String(!!st[k]));
      bubbleT.sw.disabled = st.alertBubble === false; bubbleT.row.classList.toggle('is-disabled', st.alertBubble === false);
      login.sw.disabled = !s.packaged; login.row.title = s.packaged ? '' : 'Available in the installed app';
      if (document.activeElement !== budget) budget.value = st.fallbackBudget5h || '';
      budgetRow.hidden = s.limits.connected;
      ver.textContent = `Tokkie ${s.version}`;
    },
    refreshSetup,
  };
}
