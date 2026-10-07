import type { Engine, Register, SessionRateLimit } from 'claude-code'

// Tokkie bridge — the desktop pet's eyes inside Claude Code.
// It only READS what Claude Code already measures ($.session.usage) and writes it to one file per
// session under ~/.tokkie/bridge/, plus plan limits (when the account has them) to ~/.tokkie/rate_limits.json.
// No network, no prompts changed, no programs run.

const MAX_TURNS = 30

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
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
}
