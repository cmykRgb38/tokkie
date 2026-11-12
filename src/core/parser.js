'use strict';
/**
 * Turns raw Claude Code / Cowork transcript lines into small normalised events.
 * Pure functions, no I/O — everything here is unit tested against real log shapes.
 */

const { complexityHint } = require('./tokens');

const NOT_A_PROMPT = [/^<command-(?:name|message|args)>/, /^<local-command-/, /^<system-reminder>/, /^<task-notification>/, /^Caveat:/, /^\[Request interrupted/];

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

const hasToolResult = (content) => Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
const IMAGE_TOKENS = 1600;   // about what one screenshot-sized image costs in context

/** A short, local-only name for what a tool call put into the chat ("Read main.js", "Ran npm test"). */
function toolLabel(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  const clip = (t, n = 32) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  switch (name) {
    case 'Read': case 'NotebookRead': return `Read ${base(i.file_path || i.notebook_path) || 'a file'}`;
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return `${name === 'Write' ? 'Wrote' : 'Edited'} ${base(i.file_path || i.notebook_path) || 'a file'}`;
    case 'Bash': case 'PowerShell': {
      // name the program, not the "cd somewhere &&" or "FOO=1" in front: "Ran sed", "Ran npm test", "Ran git diff"
      const cmd = String(i.command || '').split('\n')[0].replace(/^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, '').replace(/^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '');
      const w = cmd.trim().split(/\s+/).filter(Boolean), prog = base(w[0] || '');
      if (!prog) return 'Ran a command';
      const sub = /^(npm|npx|pnpm|yarn|git|node|python3?|cargo|go|docker|make|claude|codex|gh|bun|deno)$/.test(prog) && w[1] && !w[1].startsWith('-') && !/[<>|&;]/.test(w[1]) ? ' ' + base(w[1]) : '';
      return clip(`Ran ${prog}${sub}`, 28);
    }
    case 'Grep': return i.pattern ? `Searched “${clip(i.pattern, 20)}”` : 'Searched files';
    case 'Glob': return i.pattern ? `Listed ${clip(i.pattern, 24)}` : 'Listed files';
    case 'WebFetch': { let h = ''; try { h = new URL(i.url).host; } catch { /* not a url */ } return h ? `Fetched ${h}` : 'Fetched a page'; }
    case 'WebSearch': return 'Web search';
    case 'Task': case 'Agent': return 'Agent report';
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
      return m ? `${m[2].replace(/_/g, ' ')} (${m[1].replace(/^plugin_[^_]+_/, '')})` : clip(name || 'Tool', 24);
    }
  }
}

/** How much one tool result adds to the chat: text ≈ chars/4, plus a flat cost per image. */
function resultTokens(b) {
  const c = b.content;
  if (typeof c === 'string') return Math.round(c.length / 4);
  if (!Array.isArray(c)) return 0;
  let t = 0;
  for (const x of c) if (x && x.type === 'text' && typeof x.text === 'string') t += x.text.length / 4; else if (x && x.type === 'image') t += IMAGE_TOKENS;
  return Math.round(t);
}

/**
 * @returns {null | {kind:'usage'|'prompt'|'end'|'interrupt', ts:number, ...}}
 *   usage:  one assistant message (may be emitted several times with growing numbers; consumers upsert by id)
 *   prompt: a human prompt that starts a turn
 *   end:    the main agent finished its turn
 */
function parseLine(line) {
  let d;
  try { d = typeof line === 'string' ? JSON.parse(line) : line; } catch { return null; }
  if (!d || typeof d !== 'object') return null;
  const ts = Date.parse(d.timestamp);
  if (!Number.isFinite(ts)) return null;
  // /compact (or auto-compact): the chat starts over from a summary, so what was bloating it is gone
  if (d.type === 'system' && d.subtype === 'compact_boundary' && !d.isSidechain) return { kind: 'compact', ts, sessionId: d.sessionId || '' };
  const m = d.message;
  if (!m || typeof m !== 'object') return null;
  const sessionId = d.sessionId || d.session_id || '';

  if (d.type === 'assistant' && m.usage && m.id) {
    const u = m.usage;
    const ev = {
      kind: 'usage', ts, sessionId, id: m.id, model: m.model || '', sidechain: !!d.isSidechain,
      input: u.input_tokens | 0, output: u.output_tokens | 0,
      cacheWrite: u.cache_creation_input_tokens | 0, cacheRead: u.cache_read_input_tokens | 0,
      ending: !d.isSidechain && !!m.stop_reason && m.stop_reason !== 'tool_use',
      ttl: u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens > 0 ? '1h' : u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens > 0 ? '5m' : null,
    };
    // the tools it called, so their results can be named later ("Read main.js") when we look at what fills the chat
    if (!d.isSidechain && Array.isArray(m.content)) {
      const tools = m.content.filter((b) => b && b.type === 'tool_use' && b.id).map((b) => ({ id: b.id, label: toolLabel(b.name, b.input) }));
      if (tools.length) ev.tools = tools;
    }
    return ev;
  }

  if (d.type === 'user' && m.role === 'user' && !d.isSidechain && !d.isMeta) {
    if (hasToolResult(m.content)) {
      const items = m.content.filter((b) => b && b.type === 'tool_result' && b.tool_use_id).map((b) => ({ id: b.tool_use_id, tokens: resultTokens(b) }));
      return items.length ? { kind: 'results', ts, sessionId, items } : null;
    }
    if (d.origin && d.origin.kind && d.origin.kind !== 'human') return null;
    if (d.parent_tool_use_id) return null;
    const text = textOf(m.content).trim();
    if (text.startsWith('[Request interrupted')) return { kind: 'interrupt', ts, sessionId };
    if (NOT_A_PROMPT.some((re) => re.test(text))) return null;
    const images = Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'image').length : 0, hasImage = images > 0;
    if (!text && !hasImage) return null;
    // a one-line preview (local only) so a run can be recognised later, and where it ran (to reopen it)
    const preview = text.replace(/\s+/g, ' ').slice(0, 140) || (hasImage ? '[image]' : '');
    const find = (text.split('\n').find((l) => l.trim()) || '').trim().slice(0, 60);   // what to search for in the chat (one line)
    return { kind: 'prompt', ts, sessionId, chars: text.length, images, summary: !!d.isCompactSummary, hint: complexityHint(text), uuid: d.uuid || '', preview, find, cwd: typeof d.cwd === 'string' ? d.cwd : '' };
  }
  return null;
}

/** Weighted tokens: how much an event "costs" against rate limits. Cache reads are heavily discounted. */
function weighted(e) {
  return e.input + e.output + e.cacheWrite + e.cacheRead * 0.1;
}
/** Headline tokens people recognise: everything except cache reads. */
function headline(e) {
  return e.input + e.output + e.cacheWrite;
}

module.exports = { parseLine, weighted, headline, textOf, toolLabel, IMAGE_TOKENS };
