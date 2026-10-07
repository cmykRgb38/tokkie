import { el, icon, fmtTokens, fmtDur } from '../util.js';
import { prettyKey } from './plan.js';

function toggle(label, desc, key, api, S) {
  const sw = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': label, 'aria-checked': 'false' });
  sw.addEventListener('click', () => api.setSettings({ [key]: sw.getAttribute('aria-checked') !== 'true' }));
  return { sw, row: el('div', { class: 'row' }, el('div', {}, el('div', { class: 't', text: label }), desc ? el('div', { class: 'd', text: desc }) : null), sw) };
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
    return { k, sw, row: el('div', { class: 'row sub', title: d }, el('div', { class: 't', text: l }), sw) };
  });
  const place = mkSeg([['below', 'Below'], ['above', 'Above'], ['claude', 'Claude bar']], 'dockPlace');
  const placeNote = el('div', { class: 'd', style: 'max-width:none;padding:0 0 6px 12px' });
  const placeRow = el('div', { class: 'row sub' }, el('div', { class: 't', text: 'Position' }), place.node);
  const itemsTitle = el('div', { class: 'd', text: 'Shown' });
  const dockBox = el('div', { class: 'dockset' }, placeRow, placeNote, itemsTitle, ...dockToggles.map((t) => t.row));

  const spendIn = el('input', { class: 'input', type: 'number', min: 0, step: 10, 'aria-label': 'Monthly spend limit in dollars', placeholder: 'off' });
  spendIn.addEventListener('change', () => api.setSettings({ spendLimitUsd: Number(spendIn.value) || 0 }));
  // A calendar: pick the date Claude shows under “Resets …”; it repeats on that day every month.
  const dayIn = el('input', { class: 'input', type: 'date', style: 'width:140px', 'aria-label': 'Next reset date' });
  dayIn.addEventListener('change', () => { const m = /^\d{4}-\d{2}-(\d{2})$/.exec(dayIn.value); if (m) api.setSettings({ resetDay: Number(m[1]) }); });
  const nextReset = (day, now) => {
    const at = (y, mo) => new Date(Date.UTC(y, mo, Math.min(day, new Date(Date.UTC(y, mo + 1, 0)).getUTCDate())));
    const t = new Date(now); let d = at(t.getUTCFullYear(), t.getUTCMonth()); if (d.getTime() <= now) d = at(t.getUTCFullYear(), t.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  };
  const spendRow = el('div', { class: 'row' }, el('div', {}, el('div', { class: 't', text: 'Spend limit ($ / month)' }), el('div', { class: 'd', text: 'If Claude’s Usage page shows a $ limit, enter it to see dollars.' })), spendIn);
  const dayRow = el('div', { class: 'row sub' }, el('div', {}, el('div', { class: 't', text: 'Next reset' }), el('div', { class: 'd', text: 'The date under “Resets …” on Claude’s Usage page. Repeats monthly.' })), dayIn);
  const optModel = mkSeg([['haiku', 'Haiku'], ['sonnet', 'Sonnet'], ['opus', 'Opus']], 'optimizerModel');
  const optRow = el('div', { class: 'row' }, el('div', {}, el('div', { class: 't', text: '✨ Prompt optimizer' }), el('div', { class: 'd', text: 'Haiku: fast & cheapest. Sonnet: reads intent better. Opus: best, slowest, most usage.' })), optModel.node);
  const optBtnT = toggle('Optimize button in Claude Code', 'A ✨ Optimize button above Claude’s prompt box rewrites what you typed (Undo puts it back). Needs the bridge.', 'optimizeButton', api);
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
  const budgetRow = el('div', { class: 'row' }, el('div', {}, el('div', { class: 't', text: '5-hour token budget' }), el('div', { class: 'd', text: 'Only used until plan limits are connected.' })), budget);

  const srcBox = el('div', { class: 'src' }); const details = el('details', {}, el('summary', { class: 'muted', style: 'cursor:pointer', text: 'Where I read from' }), srcBox);
  details.addEventListener('toggle', async () => { if (details.open) { const s = await api.sources(); srcBox.replaceChildren(...(s.length ? s.map((x) => el('div', { text: `${x.source === 'cowork' ? 'Cowork' : 'Claude Code'} · ${x.dir}` })) : [el('div', { text: 'No transcript folders found yet.' })])); } });

  const ver = el('span', { class: 'muted' });
  root.append(el('div', { class: 'stack' },
    el('div', { class: 'set' },
      el('div', { class: 'row' }, el('div', {}, el('div', { class: 't', text: 'Claude Code bridge' }), limitStatus), limitBtn),
      limitMsg, spendRow, dayRow, optRow, optBtnT.row,
      el('div', { class: 'row' }, el('div', { class: 't', text: 'Layout' }), layout.node), dockBox,
      el('div', { class: 'row' }, el('div', { class: 't', text: 'Theme' }), theme.node),
      el('div', { class: 'row' }, el('div', { class: 't', text: 'Pet size' }), size.node),
      el('div', { class: 'row' }, el('div', {}, el('div', { class: 't', text: 'Estimate shortcut' }), el('div', { class: 'd', text: 'Copy your prompt (⌘C), then press this.' }), hotStatus, hotMsg), hotBtn),
      alertT.row, bubbleT.row, clip.row, notify.row, login.row, top.row, budgetRow),
    details,
    el('div', { class: 'row' }, ver, el('div', { style: 'display:flex;gap:4px' }, el('button', { class: 'btn sm quiet', type: 'button', text: 'Hide', onclick: () => api.hide() }), el('button', { class: 'btn sm quiet danger', type: 'button', text: 'Quit Tokkie', onclick: () => api.quit() })))));

  let setup = { installed: false };
  async function refreshSetup() {
    setup = await api.setupStatus();
    limitBtn.textContent = setup.installed ? 'Disconnect' : 'Connect';
    limitStatus.textContent = setup.installed
      ? (S && S.bridge && S.bridge.seen ? 'Connected · exact Claude Code cost, context and agents' : 'Installed · starts reporting from your next new Claude Code session')
      : setup.error === 'unparseable' ? 'Claude Code’s settings.json has a JSON error — fix it first' : 'Read-only helper inside Claude Code for exact cost, context & agents';
  }
  refreshSetup();

  return {
    update(s) {
      S = s; const st = s.settings;
      theme.set(st.theme); size.set(st.scale); layout.set(st.layout); optModel.set(st.optimizerModel || 'haiku');
      dockBox.hidden = st.layout === 'pet';
      placeRow.hidden = st.layout !== 'dock'; place.set(st.dockPlace || 'below');
      placeNote.hidden = st.layout !== 'dock' || st.dockPlace !== 'claude';
      placeNote.textContent = s.hook && s.hook.installed
        ? 'Shown as a bar above Claude Code’s prompt box (desktop Code tab and terminal), starting with your next new session. Tokkie stays on your desktop.'
        : 'Needs the Claude Code bridge — connect it above. Until then nothing is shown in Claude Code.';
      placeNote.style.color = s.hook && s.hook.installed ? '' : 'var(--warn)';
      itemsTitle.textContent = st.layout === 'pills' ? 'Pills shown under your pet' : st.dockPlace === 'claude' ? 'Shown in the bar' : 'Shown in the Dock';
      const picks = st.layout === 'pills' ? (st.pills || {}) : (st.dock || {});
      for (const t of dockToggles) t.sw.setAttribute('aria-checked', String(st.layout === 'pills' ? !!picks[t.k] : picks[t.k] !== false));
      if (document.activeElement !== spendIn) spendIn.value = st.spendLimitUsd || '';
      if (document.activeElement !== dayIn) dayIn.value = nextReset(st.resetDay || 1, Date.now());
      dayRow.hidden = !(st.spendLimitUsd > 0);
      if (!recording) hotBtn.textContent = prettyKey(st.hotkey, s.platform);
      const hk = s.hotkey, ok = !hk || hk.ok, fresh = hk && hk.firedAt && Date.now() - hk.firedAt < 15000;
      hotStatus.textContent = !ok ? '● Not active — another app is using it. Record a different one.'
        : fresh ? '✓ Received! The shortcut works.' : hk && hk.firedAt ? `● Active · last used ${fmtDur((Date.now() - hk.firedAt) / 1000)} ago` : '● Active — press it now to test';
      hotStatus.style.color = ok ? 'var(--good)' : 'var(--bad)';
      optBtnT.sw.setAttribute('aria-checked', String(st.optimizeButton !== false));
      for (const [t, k] of [[alertT, 'alertBubble'], [bubbleT, 'speechBubble'], [clip, 'clipboardWatch'], [notify, 'notifyDone'], [login, 'launchAtLogin'], [top, 'alwaysOnTop']]) t.sw.setAttribute('aria-checked', String(!!st[k]));
      bubbleT.sw.disabled = st.alertBubble === false; bubbleT.row.style.opacity = st.alertBubble === false ? '.5' : '';
      login.sw.disabled = !s.packaged; login.row.title = s.packaged ? '' : 'Available in the installed app';
      if (document.activeElement !== budget) budget.value = st.fallbackBudget5h || '';
      budgetRow.hidden = s.limits.connected;
      ver.textContent = `Tokkie ${s.version}`;
    },
    refreshSetup,
  };
}
