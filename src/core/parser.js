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
    return ev;
  }

  if (d.type === 'user' && m.role === 'user' && !d.isSidechain && !d.isMeta) {
    if (hasToolResult(m.content)) return null;
    if (d.origin && d.origin.kind && d.origin.kind !== 'human') return null;
    if (d.parent_tool_use_id) return null;
    const text = textOf(m.content).trim();
    if (text.startsWith('[Request interrupted')) return { kind: 'interrupt', ts, sessionId };
    if (NOT_A_PROMPT.some((re) => re.test(text))) return null;
    const hasImage = Array.isArray(m.content) && m.content.some((b) => b && b.type === 'image');
    if (!text && !hasImage) return null;
    return { kind: 'prompt', ts, sessionId, chars: text.length, hint: complexityHint(text), uuid: d.uuid || '' };
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

module.exports = { parseLine, weighted, headline, textOf };
