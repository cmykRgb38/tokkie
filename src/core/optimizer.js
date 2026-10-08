'use strict';
/**
 * Prompt optimizer: asks Claude (through the Tokkie bridge, on the user's own Claude Code login) to rewrite a prompt
 * so the run wastes fewer steps. Request/response files under ~/.tokkie; Tokkie itself makes no network calls.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLAIM_MS = 8000;      // a Claude Code session with the bridge picks a request up within ~1 s
const ANSWER_MS = 90000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (f) => { try { fs.accessSync(f); return true; } catch { return false; } };

/** Pull {optimized, changes, questions} out of the model's reply (tolerates a code fence or stray prose). */
function parseReply(text) {
  const t = String(text || '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(t.slice(a, b + 1));
    if (typeof j.optimized !== 'string' || !j.optimized.trim()) return null;
    const list = (x, n) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 160)).slice(0, n) : []);
    return { optimized: j.optimized.trim(), changes: list(j.changes, 4), questions: list(j.questions, 3).filter((q) => !/^none\.?$/i.test(q)) };
  } catch { return null; }
}

async function optimize(home, prompt, model = 'haiku', { claimMs = CLAIM_MS, answerMs = ANSWER_MS, mode = 'clearer' } = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const dirs = { req: path.join(home, 'requests'), claim: path.join(home, 'claims'), res: path.join(home, 'responses') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const files = { req: path.join(dirs.req, id + '.json'), claim: path.join(dirs.claim, id + '.json'), res: path.join(dirs.res, id + '.json') };
  const cleanup = () => { for (const f of Object.values(files)) fs.rmSync(f, { force: true }); };
  fs.writeFileSync(files.req, JSON.stringify({ kind: 'optimize', model: ['sonnet', 'opus'].includes(model) ? model : 'haiku', prompt: String(prompt).slice(0, 20000), mode: mode === 'shorter' ? 'shorter' : 'clearer', at: Date.now() }));
  try {
    const t0 = Date.now();
    while (!exists(files.claim) && !exists(files.res)) {
      if (Date.now() - t0 > claimMs) return { ok: false, unclaimed: true, error: 'No Claude Code session picked it up. Open Claude Code (the desktop Code tab or a terminal) with the Tokkie bridge connected, then try again.' };
      await sleep(250);
    }
    while (!exists(files.res)) {
      if (Date.now() - t0 > answerMs) return { ok: false, error: 'Claude took too long to answer. Try again in a moment.' };
      await sleep(300);
    }
    const r = JSON.parse(fs.readFileSync(files.res, 'utf8'));
    if (r.error) return { ok: false, error: r.error };
    const parsed = parseReply(r.text);
    if (!parsed) return { ok: false, error: 'Claude’s answer wasn’t in the expected shape. Try again.' };
    return { ok: true, ...parsed, model: r.model || model, usage: r.usage || null };
  } finally { cleanup(); }
}

/**
 * For people without Claude Code (Chat / Cowork only): the same request as text to paste into Claude yourself.
 * Plain words, no JSON, so the answer reads naturally in a chat.
 */
function chatRequest(prompt, mode = 'clearer') {
  const how = mode === 'shorter'
    ? 'Shorten it: say exactly the same thing in as few words as possible. Keep every requirement, name, number and constraint, and my language. Add nothing new.'
    : 'Make it clearer so you waste fewer steps and get it right first time: state the goal and what "done" looks like, name the specific things I mentioned (never invent any), state limits on scope, and drop filler. Keep my language and tone, and keep it as short as it can be while clear. No titles or preambles. If something essential is missing, put a short [placeholder] and ask me about it.';
  return `Please rewrite my prompt below before I send it. Don't do the task yet.\n${how}\nReply with the rewritten prompt first, then up to 3 short bullets on what you changed.\n\n--- my prompt ---\n${String(prompt).slice(0, 20000)}`;
}

/** Old request/claim/response files (e.g. Tokkie quit mid-request) are cleared on start. */
function sweep(home, now = Date.now()) {
  for (const d of ['requests', 'claims', 'responses']) {
    let names = []; try { names = fs.readdirSync(path.join(home, d)); } catch { continue; }
    for (const n of names) { const f = path.join(home, d, n); try { if (now - fs.statSync(f).mtimeMs > 10 * 60e3) fs.rmSync(f, { force: true }); } catch { /* gone */ } }
  }
}

module.exports = { chatRequest, optimize, parseReply, sweep };
