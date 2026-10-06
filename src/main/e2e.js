'use strict';
// QA harness (TOKKIE_E2E=1): drives the real window through the main flows and asserts invariants. Exits non-zero on failure.
const { app } = require('electron');

exports.attach = (win, { screen, getPetRect, settings, fireHotkey, clipboard }) => {
  const results = []; const errors = [];
  const ok = (name, cond, extra = '') => { results.push([name, !!cond]); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const petPos = () => { const b = win.getBounds(), r = getPetRect(); return { x: b.x + r.x, y: b.y + r.y }; };
  const near = (a, b, t = 1.5) => Math.abs(a.x - b.x) <= t && Math.abs(a.y - b.y) <= t;
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(msg); });
  win.webContents.on('render-process-gone', () => errors.push('render process gone'));

  const click = (sel) => js(`(()=>{const s=document.querySelector('${sel}');const r=s.getBoundingClientRect();const o={bubbles:true,pointerId:1,button:0,clientX:r.left+r.width/2,clientY:r.top+r.height/2,screenX:100,screenY:100};s.dispatchEvent(new PointerEvent('pointerdown',o));s.dispatchEvent(new PointerEvent('pointerup',o));})()`);
  const state = () => js(`({mode:document.getElementById('app').dataset.mode, cls:document.getElementById('app').className, panelHidden:document.getElementById('panel').hidden, pill:document.getElementById('pills').textContent, tab:[...document.querySelectorAll('.tabs button')].find(b=>b.getAttribute('aria-selected')==='true').dataset.tab, visibleViews:[...document.querySelectorAll('.view')].filter(v=>!v.hidden).map(v=>v.id)})`);

  win.webContents.once('did-finish-load', async () => {
    try {
      await wait(3500);                                    // initial scan + first layout
      const wa = screen.getPrimaryDisplay().workArea;
      win.setPosition(wa.x + Math.round(wa.width / 2), wa.y + 80); await wait(300);   // upper half: panel should open below
      await js(`window.tokkie.setSettings({onboarded:true})`); await wait(400);

      let st = await state(); ok('boots collapsed with a pill', st.mode === 'collapsed' && st.pill.length > 3, JSON.stringify(st));
      ok('window starts visible', win.isVisible());
      const p0 = petPos(), b0 = win.getBounds();

      await click('#stage'); await wait(700); st = await state();
      ok('click pet → panel opens below (pet in upper half)', st.mode === 'expanded' && st.cls === 'below' && !st.panelHidden);
      ok('pet does not jump when panel opens', near(petPos(), p0), JSON.stringify([p0, petPos()]));
      const b1 = win.getBounds(); ok('window grew to fit panel', b1.height > b0.height + 300 && b1.y >= wa.y && b1.y + b1.height <= wa.y + wa.height);

      for (const tab of ['plan', 'pets', 'settings', 'usage']) {
        await js(`document.getElementById('tab-${tab}').click()`); await wait(250); st = await state();
        ok(`tab ${tab} shows only its view`, st.tab === tab && st.visibleViews.join() === `view-${tab}`);
      }

      await js(`document.getElementById('tab-plan').click()`); await wait(200);
      await js(`(()=>{const t=document.querySelector('#view-plan textarea');t.value='Refactor the whole billing module and add comprehensive tests for every endpoint. 1. keep compat 2. update docs';t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await wait(900);
      const verdict = await js(`document.querySelector('#view-plan .verdict h3')?.textContent || null`);
      ok('typing a prompt produces a verdict', ['Go for it', 'Cutting it close', 'Better wait', 'Past your finish time'].includes(verdict), `"${verdict}"`);
      const rows = await js(`[...document.querySelectorAll('#view-plan .kv .row')].map(r=>r.textContent)`);
      ok('estimate shows run time, tokens and plan impact', rows.length === 3 && /\d/.test(rows[0]) && /≈/.test(rows[1]), JSON.stringify(rows));

      const verdictBefore = verdict;
      await js(`(()=>{const f=document.querySelector('#view-plan input');f.value='6.00 am';f.dispatchEvent(new Event('change',{bubbles:true}));})()`); await wait(700);
      const verdict2 = await js(`document.querySelector('#view-plan .verdict h3')?.textContent`);
      ok('changing finish time to the past flips the verdict', verdict2 === 'Past your finish time', `${verdictBefore} → ${verdict2}`);
      await js(`(()=>{const f=document.querySelector('#view-plan input');f.value='11:59pm';f.dispatchEvent(new Event('change',{bubbles:true}));})()`); await wait(500);
      ok('finish time persisted as 24h', settings.get('finishBy') === '23:59', settings.get('finishBy'));

      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await wait(600); st = await state();
      ok('Esc collapses the panel', st.mode === 'collapsed' && st.panelHidden);
      ok('pet returns to the same spot', near(petPos(), p0), JSON.stringify([p0, petPos()]));

      // drag
      const before = win.getBounds();
      await js(`(()=>{const s=document.querySelector('#stage');const o=(x,y)=>({bubbles:true,pointerId:2,button:0,screenX:x,screenY:y});s.dispatchEvent(new PointerEvent('pointerdown',o(500,500)));s.dispatchEvent(new PointerEvent('pointermove',o(560,530)));s.dispatchEvent(new PointerEvent('pointerup',o(560,530)));})()`);
      await wait(500); const after = win.getBounds();
      ok('dragging moves the window by the pointer delta', Math.abs(after.x - before.x - 60) <= 1 && Math.abs(after.y - before.y - 30) <= 1, `dx=${after.x - before.x} dy=${after.y - before.y}`);
      await wait(600);
      st = await state(); ok('a drag does not toggle the panel', st.mode === 'collapsed');
      const saved = settings.get('window'); ok('pet position saved', saved.x != null && near({ x: saved.x, y: saved.y }, petPos()), JSON.stringify(saved));

      // bottom edge → panel opens above
      win.setPosition(wa.x + Math.round(wa.width / 2), wa.y + wa.height - win.getBounds().height - 10); await wait(300);
      const pb = petPos(); await click('#stage'); await wait(700); st = await state();
      ok('pet near bottom → panel opens above', st.cls === 'above' && st.mode === 'expanded', st.cls);
      ok('pet does not jump (above)', near(petPos(), pb), JSON.stringify([pb, petPos()]));
      const bb = win.getBounds(); ok('window stays inside the work area', bb.y >= wa.y && bb.y + bb.height <= wa.y + wa.height && bb.x >= wa.x && bb.x + bb.width <= wa.x + wa.width);
      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await wait(500);

      // monster generate/save via settings round-trip
      await js(`window.tokkie.setSettings({monsters:{active:'r12345678',saved:['a','b']}})`); await wait(500);
      const m = settings.get('monsters'); ok('pet selection persists', m.active === 'r12345678' && m.saved.length === 2);
      await js(`window.tokkie.setSettings({monsters:{active:'x',saved:['1','2','3','4','5','6','7']}})`); await wait(200);
      ok('collection capped at 5', settings.get('monsters').saved.length === 5);
      await js(`window.tokkie.setSettings({hotkey:'Not+A+Real+Key'})`); await wait(200);
      ok('invalid hotkey is rejected, old one kept', settings.get('hotkey') === 'CommandOrControl+Alt+Shift+L');
      await js(`window.tokkie.setSettings({__proto__:{x:1},evil:'x',samples:[1],finishBy:'7:00'})`); await wait(200);
      ok('unknown/unsafe settings keys are ignored', settings.get('evil') === undefined && !(settings.get('samples') || []).includes(1));

      // ---- interactivity: emotes, poking, keyboard, eye tracking
      const mood = (code) => js(`(()=>{const p=window.__tokkie.pet;${code}})()`);
      for (const m of ['done', 'surprised', 'angry', 'sleep']) { await mood(`p.emote('${m}', 5000)`); ok(`emote "${m}" takes over the pet`, (await mood(`return p.mood`)) === m); }
      await mood(`p.override = null; p.clicks = []`);
      for (let i = 0; i < 5; i++) await mood(`p.poke()`);
      ok('poking five times makes it angry', (await mood(`return p.mood`)) === 'angry', await mood(`return JSON.stringify({mood:p.mood,o:p.override,n:p.clicks.length,base:p.base})`));
      await mood(`p.override = null; p.look = {x: 2, y: 0}`);
      const lookRight = await mood(`return JSON.stringify(window.TokkieMonster.compose(p.spec, {look:{x:1,y:0}}).cells)`), lookLeft = await mood(`return JSON.stringify(window.TokkieMonster.compose(p.spec, {look:{x:-1,y:0}}).cells)`);
      ok('eyes follow the cursor (left ≠ right)', lookLeft !== lookRight);
      ok('cursor position reaches the pet', (await mood(`return p.look.x`)) === 2);
      await js(`document.getElementById('stage').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`); await wait(700); st = await state();
      ok('Enter on the focused pet opens the panel (keyboard access)', st.mode === 'expanded');
      await js(`document.getElementById('tab-pets').click()`); await wait(300);
      const chips = await js(`[...document.querySelectorAll('#view-pets .chips button')].map(b=>b.textContent)`);
      ok('Pets tab offers the emotion buttons', chips.length === 7, chips.join(','));
      await js(`document.querySelector('#view-pets .chips button:nth-child(5)').click()`); await wait(200);
      ok('clicking "Angry" makes the pet angry', (await mood(`return p.mood`)) === 'angry');
      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await wait(500);

      // The shortcut's whole path (minus the OS key delivery): clipboard → estimate → panel opens on the Estimate tab with a verdict.
      await clipboard.writeText('Refactor the billing module, migrate to the new API and add comprehensive tests for every endpoint.');
      fireHotkey(); await wait(900); st = await state();
      ok('shortcut handler opens the panel on the Estimate tab', st.mode === 'expanded' && st.tab === 'plan', JSON.stringify([st.mode, st.tab]));
      const hv = await js(`document.querySelector('#view-plan .verdict h3')?.textContent || null`);
      ok('shortcut handler shows an estimate for the copied prompt', !!hv, hv);
      const fired = await js(`window.tokkie.getState().then((s) => s.hotkey.firedAt)`); ok('Settings can confirm the shortcut was received', fired > 0, String(fired));
      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await wait(500);
      await clipboard.writeText(''); fireHotkey(); await wait(700);
      const flashed = await js(`document.querySelector('#view-plan .muted.num')?.textContent || ''`);
      ok('empty clipboard → asks you to copy first', /clipboard is empty/i.test(flashed), flashed.slice(0, 60));
      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await wait(500);
      // ---- attention alerts
      const bub = () => js(`(()=>{const b=document.getElementById('bubble');const r=b.getBoundingClientRect();return {hidden:b.hidden,kind:b.dataset.kind,role:b.getAttribute('role'),title:document.getElementById('bubbleTitle').textContent,top:r.top,left:r.left,right:r.right,vw:innerWidth}})()`);
      await js(`window.__tokkie.forceAlert('done')`); await wait(500);
      let b = await bub();
      ok('"done" alert shows an accessible speech bubble', !b.hidden && b.kind === 'done' && b.role === 'alert' && /awaiting your response/i.test(b.title), JSON.stringify(b));
      ok('bubble fits inside the window', b.top >= 0 && b.left >= 0 && b.right <= b.vw, `${Math.round(b.left)}..${Math.round(b.right)} of ${b.vw}`);
      ok('pet reacts to the alert', (await mood(`return p.mood`)) === 'alert');
      await js(`document.getElementById('bubble').click()`); await wait(400); b = await bub();
      ok('clicking the bubble dismisses it', b.hidden === true);
      await js(`window.__tokkie.forceAlert('ask')`); await wait(400); b = await bub();
      ok('"may need approval" alert uses the amber variant', !b.hidden && b.kind === 'ask' && (await mood(`return p.mood`)) === 'ask');
      await js(`document.getElementById('bubble').click()`); await wait(300);
      await js(`window.tokkie.setSettings({ speechBubble: false })`); await wait(400);
      await js(`window.__tokkie.forceAlert('done')`); await wait(500); b = await bub();
      ok('speech bubble can be switched off: no bubble, but the pet still reacts', b.hidden === true && (await mood(`return p.mood`)) === 'alert');
      await js(`window.tokkie.setSettings({ speechBubble: true })`); await wait(300);
      await js(`window.__tokkie.forceAlert('done')`); await wait(500); b = await bub();
      ok('switching the bubble back on shows it again', b.hidden === false);
      await js(`document.getElementById('bubble').click()`); await wait(300);
      const wb = win.getBounds(); ok('pet stays on screen with the bubble zone reserved', wb.y >= wa.y && wb.y + wb.height <= wa.y + wa.height);
      // ---- evolution
      const evo0 = await js(`window.tokkie.getState().then((s) => s.evolution)`);
      ok('a brand-new install starts as a Hatchling and has not eaten history', evo0.stage === 1 && evo0.eaten < 2e6 && (await mood(`return p.form.stage`)) === 1, JSON.stringify([evo0.stage, Math.round(evo0.eaten)]));
      await js(`window.__tokkie.previewForm(3, 1)`); await wait(3000);
      ok('evolution animation ends in the new form', (await mood(`return JSON.stringify([p.form.stage, p.form.fat, !!p.evo])`)) === '[3,1,false]');
      b = await bub();
      ok('evolution announces itself with a bubble', !b.hidden && b.kind === 'evo' && /evolved into Champion/.test(b.title), b.title);
      await js(`document.getElementById('bubble').click()`); await wait(300);
      await js(`document.getElementById('stage').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`); await wait(600);
      await js(`document.getElementById('tab-pets').click()`); await wait(400);
      const forms = await js(`[...document.querySelectorAll('#view-pets .form')].map((f) => f.textContent + (f.getAttribute('aria-current') === 'true' ? '*' : ''))`);
      ok('Pets tab shows all four forms with the unlocked ones named and the rest hidden', forms.length === 4 && forms[0].startsWith('Hatchling') && forms[3].includes('???'), forms.join(' | '));
      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await wait(500);
      // ---- "Sync with Claude": type the % Claude shows → the meter re-anchors to it
      await js(`document.getElementById('stage').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`); await wait(600);
      await js(`document.getElementById('tab-usage').click()`); await wait(400);
      const hasMeter = await js(`!!document.querySelector('#view-usage .meter')`);
      if (hasMeter) {
        await js(`document.querySelector('#view-usage .syncwrap button').click()`); await wait(200);
        await js(`(()=>{const i=document.querySelector('#view-usage .syncrow input'); i.value='38'; i.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#view-usage .syncrow .btn.primary').click();})()`); await wait(1500);
        const shown = await js(`document.querySelector('#view-usage .meter .left').textContent + ' | ' + document.querySelector('#view-usage .meter .foot').textContent`);
        ok('typing the % Claude shows re-anchors the meter', /\b38%|\b39%/.test(shown) && /you/i.test(shown), shown);
        const stored = await js(`window.tokkie.getState().then((s) => s.manualCount)`); ok('the reading is remembered', stored === 1, String(stored));
        await js(`document.querySelector('#view-usage .syncwrap button').click()`); await wait(200);
        await js(`(()=>{const i=document.querySelector('#view-usage .syncrow input'); i.value='abc'; document.querySelector('#view-usage .syncrow .btn.primary').click();})()`); await wait(400);
        const bad = await js(`document.querySelector('#view-usage .syncrow .muted:last-child').textContent`);
        ok('nonsense input is rejected with a message', /0 to 100/.test(bad) && (await js(`window.tokkie.getState().then((s) => s.manualCount)`)) === 1, bad);
      } else ok('sync control skipped (no usage meter on this machine)', true);
      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await wait(500);
      let hk; try { hk = await js(`(async () => { const s = await window.tokkie.getState(); return JSON.stringify(s.hotkey); })()`); hk = JSON.parse(hk); } catch (e) { hk = { err: e.message }; }
      ok('the estimate shortcut is registered and matches what the UI shows', hk && hk.ok === true && hk.accelerator === 'CommandOrControl+Alt+Shift+L', JSON.stringify(hk));
      ok('no renderer console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    } catch (e) { ok('e2e harness threw', false, e.stack); }
    const failed = results.filter((r) => !r[1]).length;
    console.log(`\nE2E ${results.length - failed}/${results.length} passed`);
    app.exit(failed ? 1 : 0);
  });
};
