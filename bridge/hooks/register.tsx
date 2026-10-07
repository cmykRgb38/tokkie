import { atom, read, update } from 'claude-code'
import type { Engine, Register, SessionRateLimit } from 'claude-code'

import type { Band, BandItem } from '../types'

// Tokkie bridge — the desktop pet's eyes inside Claude Code.
// It only READS what Claude Code already measures ($.session.usage) and writes it to one file per
// session under ~/.tokkie/bridge/, plus plan limits (when the account has them) to ~/.tokkie/rate_limits.json.
// When you pick "Dock: in Claude Code" in Tokkie, it also draws Tokkie's Dock as a bar above the prompt (from ~/.tokkie/band.json).
// No network, no prompts changed, no programs run.

const MAX_TURNS = 30
const BAND_STALE_MS = 2 * 60e3      // Tokkie rewrites band.json every few seconds; older means Tokkie is closed
const band = atom({ plugin: 'tokkie-bridge', key: 'band' } as const, null as Band)

// What each finished prompt cost, newest last: { at, usd }. The module's own memory: a reload starts it over.
let turns: { at: number; usd: number }[] = []
let costBase: number | null = null
let home = ''

async function tokkieHome($: Engine): Promise<string> {
  if (home) return home
  const custom = await $.env.get('TOKKIE_HOME')
  const user = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  home = custom || `${user}/.tokkie`
  return home
}

function secondsOf(iso: string | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

const KEYS: Record<string, string> = { five_hour: 'five_hour', seven_day: 'seven_day', spend_limit: 'spend_limit' }

async function writeLimits($: Engine, dir: string, limits: readonly SessionRateLimit[], now: number) {
  const file = `${dir}/rate_limits.json`
  let current: Record<string, unknown> = {}
  try { current = JSON.parse(await $.fs.read(file) as string) } catch { /* first reading */ }
  const at = Math.floor(now / 1000)
  const next: Record<string, unknown> = { ...current, updated_at: at, source: 'tokkie-bridge' }
  for (const l of limits) {
    const key = KEYS[l.kind]
    if (!key || !Number.isFinite(l.percentUsed)) continue
    next[key] = { used_percentage: l.percentUsed, resets_at: secondsOf(l.resetsAt), updated_at: at }
  }
  await $.fs.write(file, JSON.stringify(next))
}

async function save($: Engine, reason: string) {
  const usage = await $.session.usage()
  const id = await $.session.id()
  const now = await $.clock.now()
  let agentsRunning = 0
  try { agentsRunning = (await $.agent.list()).filter(a => a.status === 'running').length } catch { /* not available */ }
  const dir = await tokkieHome($)
  const record = {
    v: 1,
    sessionId: id,
    updatedAt: now,
    reason,
    startedAt: usage.startedAt,
    costUsd: usage.cost?.usd ?? null,
    rateLimits: usage.rateLimits,
    context: { tokens: usage.context?.tokens ?? null, window: usage.context?.window ?? null, percent: usage.context?.percent ?? null },
    agentsRunning,
    turns,
  }
  await $.fs.write(`${dir}/bridge/${id}.json`, JSON.stringify(record))
  if (usage.rateLimits.length) await writeLimits($, dir, usage.rateLimits, now)
}

async function recordTurn($: Engine) {
  const usage = await $.session.usage()
  const cost = usage.cost?.usd
  if (cost === undefined) return
  if (costBase !== null && cost >= costBase) {
    turns.push({ at: await $.clock.now(), usd: Math.round((cost - costBase) * 1e6) / 1e6 })
    if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS)
  }
  costBase = cost
}

/** Pick up what Tokkie wants shown above the prompt. Nothing (or a stale file) means no bar. */
async function refreshBand($: Engine) {
  let next: Band = null
  try {
    const dir = await tokkieHome($)
    const j = JSON.parse(await $.fs.read(`${dir}/band.json`) as string)
    const fresh = Number.isFinite(j.updatedAt) && (await $.clock.now()) - j.updatedAt < BAND_STALE_MS
    if (fresh && j.show === true && Array.isArray(j.items)) {
      const items: BandItem[] = j.items.slice(0, 10).filter((x: any) => x && typeof x.label === 'string' && typeof x.value === 'string')
        .map((x: any) => ({ label: x.label.slice(0, 24), value: x.value.slice(0, 40), tone: ['good', 'warn', 'bad'].includes(x.tone) ? x.tone : '' }))
      next = { items, alert: typeof j.alert === 'string' && j.alert ? j.alert.slice(0, 120) : undefined }
    }
  } catch { /* no file: Tokkie isn't showing a bar */ }
  const prev = await read($, band)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, band, () => next)
}

const TONE: Record<string, string> = { good: 'green', warn: 'yellow', bad: 'red' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try { await refreshBand($); $.clock.every(3000, () => refreshBand($).catch(() => {})) } catch { /* ignore */ }
    try {
      const usage = await $.session.usage()
      costBase = usage.cost?.usd ?? null
      await save($, 'start')
    } catch { /* never get in Claude's way */ }
    return result
  })

  // After each main-thread prompt: what that prompt cost (its subagents included).
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    try { await recordTurn($); await save($, 'turn') } catch { /* ignore */ }
    return result
  })

  // Pushed by Claude Code after each turn and whenever a plan window moves a point.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try { await save($, 'measure') } catch { /* ignore */ }
    return result
  })

  on('session.end', async ($, e, next) => {
    try { await save($, 'end') } catch { /* ignore */ }
    return next(e)
  })

  // Tokkie's Dock, as a one-line bar above the prompt (only when chosen in Tokkie → Settings → Dock position).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, band)
    if (e.props.hasSurvey || !b || !b.items.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {b.alert ? <Text color="red" bold wrap="truncate">⚠ {b.alert}</Text> : null}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text bold>Tokkie</Text>
          {b.items.map((it, i) => (
            <Text key={String(i)} wrap="truncate">
              <Text dimColor>{it.label} </Text>
              <Text bold color={it.tone ? TONE[it.tone] : undefined}>{it.value}</Text>
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
