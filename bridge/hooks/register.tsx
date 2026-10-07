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
        .map((x: any) => ({ k: typeof x.k === 'string' ? x.k.slice(0, 16) : '', label: x.label.slice(0, 24), value: x.value.slice(0, 40), tone: ['good', 'warn', 'bad'].includes(x.tone) ? x.tone : '', tip: typeof x.tip === 'string' ? x.tip.slice(0, 200) : '' }))
      const avatar = typeof j.avatar === 'string' && j.avatar.startsWith('<svg') && j.avatar.length < 20000 ? j.avatar : undefined
      next = { items, alert: typeof j.alert === 'string' && j.alert ? j.alert.slice(0, 120) : undefined, avatar }
    }
  } catch { /* no file: Tokkie isn't showing a bar */ }
  const prev = await read($, band)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, band, () => next)
}

// Chip colours (border + value), and a neutral for chips with nothing to flag.
const TONE: Record<string, string> = { good: '#4fc98a', warn: '#e8b931', bad: '#f06a5f' }
const NEUTRAL = '#6b6b78'
const ICON_GREY = '#8d8d99'                 // readable on both light and dark

// 24×24 line icons (desktop / editor / mobile draw them; the terminal gets a glyph instead).
const ICON_PATHS: Record<string, string> = {
  usage: '<path d="M4.5 18a9 9 0 1 1 15 0"/><path d="M12 14l4-5"/>',
  pace: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  status: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.5l2.8 2.8L16.5 9"/>',
  tokens: '<path d="M5 19V11M10 19V6M15 19v-9M20 19V4"/>',
  lastPrompt: '<path d="M5 5h14v10H10l-5 4z"/><path d="M12 7.5v5M10.2 8.6c0-.7.8-1.1 1.8-1.1s1.8.5 1.8 1.2-.8 1-1.8 1.1-1.8.5-1.8 1.2.8 1.1 1.8 1.1 1.8-.4 1.8-1.1"/>',
  context: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/>',
  cache: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.8M10 3h4"/>',
  agents: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9.5 13h0M14.5 13h0"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.2h0"/>',
}
const GLYPH: Record<string, string> = { usage: '◔', pace: '↯', status: '✓', tokens: '▮', lastPrompt: '$', context: '≡', cache: '◷', agents: '⚙', alert: '!' }
const k = (key: string) => (ICON_PATHS[key] ? key : 'status')

const icon = (k: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[k] || ICON_PATHS.status}</svg>`

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
    const table = $.ui.resolve(e) as any
    const { Box, Text } = table
    if (e.surface !== 'terminal' && table.Svg) {
      const Svg = table.Svg as any
      // One slim row: icon + value per item, no boxes. Hovering an item lights it and reveals a line saying
      // what it means (the surface's own hover-reveal: no hook runs, nothing leaves the drawing).
      const HL = '#8080802e'
      return (
        <Box flexDirection="column" overflow="hidden">
          {b.alert ? <Text color={TONE.bad} wrap="truncate">⚠ {b.alert}</Text> : null}
          <Box flexDirection="row" flexWrap="nowrap" overflow="hidden" alignItems="center" columnGap={1}>
            {b.avatar ? (
              <Box key="tk" paddingX={1} hover={{ scope: 'tokkie-about', backgroundColor: HL }}>
                <Svg source={b.avatar} alt="Tokkie" width={14} height={14} />
              </Box>
            ) : null}
            {b.items.map((it, i) => {
              const color = it.tone ? TONE[it.tone] : undefined
              return (
                <Box key={`c${i}`} flexDirection="row" flexShrink={0} alignItems="center" columnGap={1} paddingX={1} hover={{ scope: `tokkie-${i}`, backgroundColor: HL }}>
                  <Svg source={icon(k(it.k), color || ICON_GREY)} alt={it.label} width={12} height={12} />
                  <Text color={color} wrap="truncate">{it.value}</Text>
                </Box>
              )
            })}
          </Box>
          <Box key="tip-about" display="none" hover={{ scope: 'tokkie-about', display: 'flex' }}>
            <Text dimColor wrap="truncate">Tokkie — your usage pet. Hover an item to see what it means.</Text>
          </Box>
          {b.items.map((it, i) => (
            <Box key={`t${i}`} display="none" hover={{ scope: `tokkie-${i}`, display: 'flex' }}>
              <Text dimColor wrap="truncate"><Text bold>{it.label}</Text>{it.tip ? ` — ${it.tip}` : ''}</Text>
            </Box>
          ))}
        </Box>
      )
    }
    // the terminal can't draw SVG: one line of glyph + value
    return (
      <Box flexDirection="column">
        {b.alert ? <Text color={TONE.bad} wrap="truncate">! {b.alert}</Text> : null}
        <Box flexDirection="row" flexWrap="nowrap" overflow="hidden" columnGap={2}>
          <Text bold>Tokkie</Text>
          {b.items.map((it, i) => (
            <Text key={String(i)} wrap="truncate"><Text color={it.tone ? TONE[it.tone] : NEUTRAL}>{GLYPH[it.k] || '•'} </Text><Text color={it.tone ? TONE[it.tone] : undefined}>{it.value}</Text></Text>
          ))}
        </Box>
      </Box>
    )
  })
}
