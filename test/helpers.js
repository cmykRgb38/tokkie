'use strict';
let n = 0;
const iso = (ms) => new Date(ms).toISOString();
const A = (ts, id, o = {}) => JSON.stringify({ type: 'assistant', timestamp: iso(ts), sessionId: o.s || 's1', isSidechain: !!o.side,
  message: { id, model: 'claude-x', role: 'assistant', stop_reason: o.stop === undefined ? 'tool_use' : o.stop,
    usage: { input_tokens: o.i ?? 2, output_tokens: o.o ?? 100, cache_creation_input_tokens: o.cw ?? 1000, cache_read_input_tokens: o.cr ?? 5000 } } });
const U = (ts, text, o = {}) => JSON.stringify({ type: 'user', timestamp: iso(ts), sessionId: o.s || 's1', uuid: 'u' + (++n), isSidechain: !!o.side, isMeta: !!o.meta,
  origin: o.origin, message: { role: 'user', content: text } });
const TR = (ts, o = {}) => JSON.stringify({ type: 'user', timestamp: iso(ts), sessionId: o.s || 's1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
module.exports = { A, U, TR, iso };
