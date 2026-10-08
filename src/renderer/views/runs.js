import { el, icon, fmtTokens, fmtDur, fmtRange, fmtTime } from '../util.js';

/** How did the estimate hold up? 'in' = inside the typical range, 'near' = inside the worst-case bound, else 'off'. */
export function accuracy(actual, b) {
  if (!b || !(actual > 0)) return null;
  if (actual >= b.p25 && actual <= b.p75) return 'in';
  if (actual >= b.p25 / 2 && actual <= b.p90) return 'near';
  return 'off';
}
const ACC_TXT = { in: '✓ on target', near: '≈ close', off: '✗ off' };

/**
 * A run card (shared by Estimate → Recent runs and History): what you asked, what it cost, and — clicked — the whole
 * prompt with Copy / Open in Claude. Keeps which cards are open and the prompts it has loaded across redraws.
 * @param {object} api  @param {() => void} redraw  called when a card opens/closes or its prompt arrives
 */
export const fmtUsdRange = (c) => (c.p75 < 0.01 ? '<$0.01' : `$${c.p25.toFixed(2)}–${c.p75.toFixed(2)}`);

/** What a whole run with this prompt would likely use (not just the words): tokens, and $ when we know your rate. */
export async function runGuess(api, text) {
  let e; try { e = await api.estimate(text); } catch { return null; }
  if (!e || !e.headline) return null;
  return el('p', { class: 'muted', text: `A run with this prompt: ≈ ${fmtTokens(e.headline.p25)}–${fmtTokens(e.headline.p75)} tokens${e.cost ? ` · ${fmtUsdRange(e.cost)} at API prices` : ''}, judging by your past runs. A clearer prompt mostly saves by avoiding do-overs, which no estimate can see in advance.` });
}

/** No Claude Code (Chat / Cowork users): copy the request, paste it into Claude, get the better prompt back there. */
export function askInChat(api, r, note) {
  return el('div', { class: 'optchat' },
    el('p', { text: r.error }),
    el('div', { class: 'row', style: 'gap:6px;justify-content:flex-start;margin-top:6px' },
      el('button', { class: 'btn sm primary', type: 'button', text: 'Copy request', onclick: async (e) => { e.stopPropagation(); await api.copyText(r.chat); note('Copied. Paste it into a new Claude chat and send it.'); } }),
      el('button', { class: 'btn sm', type: 'button', text: 'Open Claude', onclick: async (e) => { e.stopPropagation(); const o = await api.openClaude(); if (!o || !o.ok) note('Couldn’t open Claude. Is the desktop app installed?'); } })),
    el('p', { class: 'muted', text: 'It asks Claude to rewrite your prompt, not to do the task. It uses a little of your usage, like any message.' }));
}

export function runCards(api, redraw, { when = 'ago' } = {}) {
  const opened = new Set(), texts = new Map(), fulls = new Map(), opts = new Map();
  function card(s, r) {
    const id = `${r.sessionId}:${r.start}`, isOpen = opened.has(id);
    const share = s.k5 && r.tokens ? (r.tokens / s.k5) * 100 : null;
    const tok = r.headline ? `≈ ${fmtTokens(r.headline)} tokens${share != null ? ` · ${share < 1 ? '<1' : Math.round(share)}% of 5h` : ''}` : '';
    const chips = [];
    if (r.est) {
      const a = accuracy(r.duration, r.est.dur), b = r.headline ? accuracy(r.headline, r.est.head) : null;
      chips.push(el('span', { class: 'acc', 'data-k': a, title: `Estimated ${fmtRange(r.est.dur.p25, r.est.dur.p75)}` }, `time ${ACC_TXT[a]}`));
      if (b) chips.push(el('span', { class: 'acc', 'data-k': b, title: `Estimated ${fmtTokens(r.est.head.p25)}–${fmtTokens(r.est.head.p75)} tokens` }, `tokens ${ACC_TXT[b]}`));
    }
    const project = r.cwd ? r.cwd.split(/[\\/]/).filter(Boolean).pop() : '';
    const where = r.source === 'cowork' ? 'Cowork' : project;
    // Claude Code runs can be reopened in the Claude app; Cowork has no such link.
    const canOpen = r.source !== 'cowork' && /^[0-9a-f-]{36}$/i.test(r.sessionId || '');
    const resumeCmd = canOpen ? `${r.cwd ? `cd "${r.cwd}" && ` : ''}claude --resume ${r.sessionId}` : '';
    const msg = el('div', { class: 'muted', hidden: true, style: 'color:var(--good)' });
    const note = (t, ms = 4000) => { msg.textContent = t; msg.hidden = false; setTimeout(() => { msg.hidden = true; }, ms); };
    const stop = (fn) => async (e) => { e.stopPropagation(); await fn(); };
    const full = el('div', { class: 'rfull', tabindex: '0', text: texts.get(id) || (r.hasText ? 'Loading…' : r.preview || '') });
    const actions = el('div', { class: 'ractions' },
      el('button', { class: 'btn sm', type: 'button', text: 'Copy prompt', onclick: stop(async () => { const t = fulls.get(id) || texts.get(id) || r.preview || ''; await api.copyText(t); note(`Prompt copied (${t.length.toLocaleString()} characters).`); }) }),
      canOpen ? el('button', { class: 'btn sm quiet', type: 'button', text: 'Open in Claude', title: 'Opens this conversation in the Claude app, with the prompt copied so ⌘F ⌘V finds it', onclick: stop(async () => {
        // Claude can open the conversation, not a message in it: copy the prompt's first line so ⌘F ⌘V finds it.
        const find = r.find || (r.preview || '').slice(0, 60);
        if (find) await api.copyText(find);
        const res = await api.openSession(r.sessionId);
        const mac = api.platform() === 'darwin';
        if (!res || !res.ok) note('Couldn’t open Claude — is the desktop app installed?');
        else note(`Opened. To jump to this prompt press ${mac ? '⌘F' : 'Ctrl+F'} then ${mac ? '⌘V' : 'Ctrl+V'} in Claude.`, 9000);
      }) }) : null,
      canOpen ? el('button', { class: 'btn sm quiet', type: 'button', text: 'Copy resume command', title: resumeCmd, onclick: stop(async () => { await api.copyText(resumeCmd); note('Copied — paste it in a terminal to continue this conversation.'); }) }) : null);
    // ✨ Optimize an old prompt: a better version to copy for next time (asks Claude through the bridge)
    const optOut = el('div', { class: 'opt', hidden: !opts.has(id) });
    const drawOpt = () => {
      const o = opts.get(id); if (!o) return;
      optOut.hidden = false;
      if (o.busy) { optOut.replaceChildren(el('p', { class: 'muted', text: 'Asking Claude for a better version…' })); return; }
      if (!o.ok) { optOut.replaceChildren(o.chat ? askInChat(api, o, note) : el('p', { class: 'muted', style: 'color:var(--bad)', text: o.error })); return; }
      optOut.replaceChildren(...[
        el('div', { class: 'label with-ic' }, icon('sparkle'), `Better next time · prompt text ${o.before} → ${o.after} tokens`),
        el('div', { class: 'rfull', text: o.optimized }),
        o.changes.length ? el('ul', { class: 'optlist' }, o.changes.map((c) => el('li', { text: c }))) : null,
        o.questions.length ? el('div', { class: 'optq' }, el('b', { text: 'Fill in before sending: ' }), o.questions.join(' · ')) : null,
        el('button', { class: 'btn sm primary', type: 'button', text: 'Copy optimized', onclick: stop(async () => { await api.copyText(o.optimized); note('Optimized prompt copied.'); }) }),
        o.guess ? el('p', { class: 'muted', text: o.guess }) : null,
        el('p', { class: 'muted', text: `That counts only the words you type. ${r.headline ? `The run itself used ≈ ${fmtTokens(r.headline)}: ` : 'A run uses far more: '}mostly Claude reading files, thinking and writing. A clearer prompt saves there, by cutting wrong turns, not by being shorter.` }),
      ].filter(Boolean));
    };
    drawOpt();
    actions.prepend(el('button', { class: 'btn sm', type: 'button', title: 'Ask Claude for a clearer version of this prompt', onclick: stop(async () => {
      const text = fulls.get(id) || texts.get(id) || r.preview || '';
      opts.set(id, { busy: true }); drawOpt();
      let res; try { res = await api.optimize(text); } catch { res = { ok: false, error: 'Something went wrong.' }; }
      opts.set(id, res && res.ok ? { ok: true, optimized: res.optimized, changes: res.changes, questions: res.questions, before: res.before.promptTokens, after: res.after.promptTokens } : { ok: false, error: (res && res.error) || 'Couldn’t optimize.', chat: res && res.chat });
      drawOpt();
      if (res && res.ok) { const g = await runGuess(api, res.optimized); if (g && opts.get(id)?.ok) { opts.get(id).guess = g.textContent; drawOpt(); } }
    }) }, icon('sparkle'), 'Optimize'));
    const detail = el('div', { class: 'rdetail', hidden: !isOpen, onclick: (e) => e.stopPropagation() }, full, actions, optOut, msg);
    const card = el('div', { class: 'run openable', role: 'button', 'aria-expanded': String(isOpen), tabindex: '0', title: isOpen ? '' : 'Click to see the full prompt' },
      el('div', { class: 'row' }, el('span', { class: 'muted', text: `${when === 'clock' ? fmtTime(r.start) : `${fmtDur((s.now - r.start) / 1000)} ago`}${where ? ` · ${where}` : ''}` }), el('span', { class: 'val', text: `took ${fmtDur(r.duration)}` })),
      r.preview && !isOpen ? el('div', { class: 'rprompt', text: `“${r.preview}${r.chars > 140 ? '…' : ''}”` }) : null,
      el('div', { class: 'rtok', text: (tok || 'tokens not recorded') + (r.usd != null ? ` · $${r.usd.toFixed(2)}` : '') }),
      chips.length ? el('div', { class: 'chips2' }, el('span', { class: 'muted', text: 'estimate:' }), chips) : null,   // only runs you estimated say how it went
      detail);
    const toggle = async () => {
      if (opened.has(id)) opened.delete(id); else opened.add(id);
      redraw();
      if (opened.has(id) && !texts.has(id) && r.hasText) {
        const t = await api.promptText(r.sessionId, r.uuid);
        // very long prompts: show the first part in the scroll box; Copy prompt still copies all of it
        const more = t && t.total > t.text.length ? `\n\n… ${(t.total - t.text.length).toLocaleString()} more characters — use Copy prompt for the whole thing.` : '';
        texts.set(id, t ? t.text + more : r.preview || '(this prompt is no longer in Claude’s logs)');
        if (t) fulls.set(id, t.full);
        redraw();
      }
    };
    card.addEventListener('click', toggle);
    card.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); toggle(); } });
    return card;
  }


  return { card, key: () => [...opened].join() + '|' + texts.size };
}
