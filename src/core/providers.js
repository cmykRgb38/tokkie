'use strict';
/**
 * The AIs Tokkie tracks. A provider says where its activity is kept and how to turn it into Tokkie's events
 * (prompt · usage · interrupt), each tagged with the provider's id, so everything downstream (the pet, estimates,
 * history, the Dock) works for any of them.
 *
 *  · Claude: Claude Code + Cowork transcripts (JSONL, followed line by line by the Tailer).
 *  · Codex (next): its desktop app keeps turns in SQLite (~/.codex/state_5.sqlite, thread_history_1.sqlite) and
 *    exact limits behind its own app-server (account/rateLimits/read), so it gets a reader of its own. Tokkie never
 *    reads Codex's login: the app-server handles that itself.
 */
const { transcriptRoots } = require('./paths');
const { parseLine } = require('./parser');

const PROVIDERS = [
  {
    id: 'claude', name: 'Claude',
    transcripts: (o) => transcriptRoots(o),
    parse: parseLine,
    hint: /"type"\s*:\s*"(?:assistant|user)"|"compact_boundary"/,            // cheap pre-filter: only these lines can become events
  },
];

const providerById = (id) => PROVIDERS.find((p) => p.id === id) || null;

/** Every transcript folder to follow, for the providers switched on (enabled(id) → false turns one off). */
function transcriptSources(opts = {}, enabled = () => true) {
  const out = [];
  for (const p of PROVIDERS) {
    if (!p.transcripts || !enabled(p.id)) continue;
    for (const r of p.transcripts(opts)) out.push({ ...r, provider: p.id });
  }
  return out;
}

module.exports = { PROVIDERS, providerById, transcriptSources };
