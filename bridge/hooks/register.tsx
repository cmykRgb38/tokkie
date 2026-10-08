import { atom, read, update } from 'claude-code'
import type { Engine, Register, SessionRateLimit } from 'claude-code'

import type { Band, BandItem, OptState } from '../types'

// Tokkie bridge — the desktop pet's eyes inside Claude Code.
// It only READS what Claude Code already measures ($.session.usage) and writes it to one file per
// session under ~/.tokkie/bridge/, plus plan limits (when the account has them) to ~/.tokkie/rate_limits.json.
// When you pick "Dock: in Claude Code" in Tokkie, it also draws Tokkie's Dock as a bar above the prompt (from ~/.tokkie/band.json).
// When you ask Tokkie to optimize a prompt, it also asks Claude for a rewrite (on your own Claude login).
// No prompts changed, no programs run.

const MAX_TURNS = 30
const BAND_STALE_MS = 2 * 60e3      // Tokkie rewrites band.json every few seconds; older means Tokkie is closed
const band = atom({ plugin: 'tokkie-bridge', key: 'band' } as const, null as Band)
const opt = atom({ plugin: 'tokkie-bridge', key: 'opt' } as const, { busy: false } as OptState)

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
    const optimizer = j.optimizer && MODELS.includes(j.optimizer.model) ? { model: j.optimizer.model, mode: j.optimizer.mode === 'shorter' ? 'shorter' : 'clearer' } : undefined
    if (fresh && (j.show === true || optimizer) && Array.isArray(j.items)) {
      const items: BandItem[] = j.items.slice(0, 10).filter((x: any) => x && typeof x.label === 'string' && typeof x.value === 'string')
        .map((x: any) => ({ k: typeof x.k === 'string' ? x.k.slice(0, 16) : '', label: x.label.slice(0, 24), value: x.value.slice(0, 40), tone: ['good', 'warn', 'bad'].includes(x.tone) ? x.tone : '', tip: typeof x.tip === 'string' ? x.tip.slice(0, 200) : '' }))
      const avatar = typeof j.avatar === 'string' && j.avatar.startsWith('<svg') && j.avatar.length < 20000 ? j.avatar : undefined
      next = { items: j.show === true ? items : [], showItems: j.show === true, optimizer, alert: j.show === true && typeof j.alert === 'string' && j.alert ? j.alert.slice(0, 120) : undefined, avatar }
    }
  } catch { /* no file: Tokkie isn't showing a bar */ }
  const prev = await read($, band)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, band, () => next)
}

// Chip colours (border + value), and a neutral for chips with nothing to flag.
// ---- prompt optimizer --------------------------------------------------------------------------------------------
// Tokkie drops a request in ~/.tokkie/requests/<id>.json; the first Claude Code session that claims it asks Claude
// (on the user's own login) and writes ~/.tokkie/responses/<id>.json. Nothing else is read or sent.
const OPTIMIZER_SYSTEM = `You improve prompts that a person is about to send to Claude Code, an AI coding agent working in their project.
Goal: the same intent, but a run that wastes fewer steps and gets a more accurate result.
Rewrite the prompt so that it:
- states the goal and the expected outcome specifically;
- names the files, functions or areas the person mentioned (never invent paths, names or facts);
- states constraints and scope limits (what not to touch);
- says what "done" looks like and asks Claude to verify it when that makes sense;
- drops filler and padding, keeping the person's language and tone (if they wrote in Chinese, answer in Chinese).
Keep it as short as it can be while being clear. Do not pad it: no titles or preambles ("Feature request:", "Task:"),
no restating the context back, no requirements the person did not ask for. If the prompt is already clear, change little.
If essential information is missing, do not invent it: add a short [placeholder] only where essential and list it under questions.
Reply with only a JSON object, no prose and no code fence:
{"optimized": "<the rewritten prompt>", "changes": ["<up to 4 short phrases>"], "questions": ["<up to 3 short questions, or none>"]}`

// ✂ Shorter: same meaning in as few tokens as possible — nothing added.
const SHORTER_SYSTEM = `You shorten prompts that a person is about to send to Claude Code, an AI coding agent.
Rewrite the prompt to say exactly the same thing in as few words as possible: drop filler, politeness, repetition and
hedging; keep every requirement, name, number and constraint; keep the person's language. Do not add anything new.
If it is already as short as it can be, return it unchanged.
Reply with only a JSON object, no prose and no code fence:
{"optimized": "<the shortened prompt>", "changes": ["<up to 3 short phrases>"], "questions": []}`
const MODELS = ['haiku', 'sonnet', 'opus']
const systemFor = (mode: string) => (mode === 'shorter' ? SHORTER_SYSTEM : OPTIMIZER_SYSTEM)

let serving = false
let sessionKey = ''
async function serveRequests($: Engine) {
  if (serving) return
  serving = true
  try {
    const dir = await tokkieHome($)
    let entries: { name: string; kind: string }[] = []
    try { entries = await $.fs.list(`${dir}/requests`) } catch { return }
    if (!sessionKey) sessionKey = `${await $.session.id()}-${Math.floor(Math.random() * 1e9)}`
    for (const e of entries) {
      if (e.kind !== 'file' || !/^[a-z0-9-]{8,40}\.json$/.test(e.name)) continue
      const id = e.name.slice(0, -5)
      const exists = async (f: string) => { try { await $.fs.read(f); return true } catch { return false } }
      if (await exists(`${dir}/responses/${id}.json`) || await exists(`${dir}/claims/${id}.json`)) continue
      // claim it; if several sessions race, the last writer wins and only that one answers
      await $.fs.write(`${dir}/claims/${id}.json`, sessionKey)
      await $.clock.sleep(400)
      let owner = ''
      try { owner = await $.fs.read(`${dir}/claims/${id}.json`) as string } catch { continue }
      if (owner !== sessionKey) continue
      let req: any
      try { req = JSON.parse(await $.fs.read(`${dir}/requests/${e.name}`) as string) } catch { continue }
      const out: Record<string, unknown> = { id, at: await $.clock.now() }
      if (req.kind !== 'optimize' || typeof req.prompt !== 'string' || !req.prompt.trim()) out.error = 'bad request'
      else {
        const model = MODELS.includes(req.model) ? req.model : 'haiku'
        const r = await $.model.complete({ model, system: systemFor(req.mode), prompt: `<prompt>\n${req.prompt.slice(0, 20000)}\n</prompt>`, maxTokens: 3000, effort: 'low' } as any)
        if (r.isAnswered) { out.text = r.text; out.usage = r.usage; out.model = model }
        else out.error = (r as any).reason === 'api-error' ? `Claude returned an error (${(r as any).status ?? '?'})` : `No answer (${(r as any).reason})`
      }
      await $.fs.write(`${dir}/responses/${id}.json`, JSON.stringify(out))
    }
  } catch { /* never get in Claude's way */ } finally { serving = false }
}

/** Rough token count (≈ 4 characters a token; CJK ≈ 1 a token) — for the before/after line only. */
function roughTokens(t: string): number {
  const cjk = (t.match(/[\u3000-\u9fff\uac00-\ud7af]/g) || []).length
  return Math.max(1, Math.round((t.length - cjk) / 4 + cjk))
}
function parseOptimized(text: string): { optimized: string; changes: string[]; questions: string[] } | null {
  const a = text.indexOf('{'), b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const j = JSON.parse(text.slice(a, b + 1))
    if (typeof j.optimized !== 'string' || !j.optimized.trim()) return null
    const list = (x: unknown, n: number) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string' && v.trim() && !/^none\.?$/i.test(v)).map((v: string) => v.trim().slice(0, 120)).slice(0, n) : [])
    return { optimized: j.optimized.trim(), changes: list(j.changes, 4), questions: list(j.questions, 3) }
  } catch { return null }
}

/** ✨ Optimize, from the bar: rewrite what's typed in the prompt box, in place (Undo puts the original back). */
async function optimizeDraft($: Engine, model: string, mode: string) {
  const cur = await read($, opt)
  if (cur.busy) return
  const { text } = await $.prompt.read()
  if (!text.trim()) { await update($, opt, () => ({ busy: false, error: 'Type a prompt first, then Optimize.' })); return }
  await update($, opt, (o) => ({ busy: true, model: o.model, mode: o.mode }))
  try {
    const r = await $.model.complete({ model, system: systemFor(mode), prompt: `<prompt>\n${text.slice(0, 20000)}\n</prompt>`, maxTokens: 3000, effort: 'low' } as any)
    const parsed = r.isAnswered ? parseOptimized(r.text) : null
    if (!parsed) { await update($, opt, () => ({ busy: false, error: r.isAnswered ? 'Claude’s answer wasn’t usable — try again.' : 'Claude couldn’t answer — try again.' })); return }
    // the person may have kept typing while Claude worked: only replace what we optimized
    const now = (await $.prompt.read()).text
    if (now !== text) { await update($, opt, () => ({ busy: false, error: 'You edited the prompt while it was optimizing — press Optimize again.' })); return }
    await $.prompt.fill({ text: parsed.optimized, mode: 'replace' })
    await update($, opt, (o) => ({ busy: false, model: o.model, mode: o.mode, original: text, optimized: parsed.optimized, before: roughTokens(text), after: roughTokens(parsed.optimized), changes: parsed.changes, questions: parsed.questions }))
  } catch { await update($, opt, () => ({ busy: false, error: 'Something went wrong — try again.' })) }
}
async function undoOptimize($: Engine) {
  const cur = await read($, opt)
  if (cur.original) await $.prompt.fill({ text: cur.original, mode: 'replace' })
  await update($, opt, (o) => ({ busy: false, model: o.model, mode: o.mode }))
}
/** A model or mode picked on the bar: used at once, and handed to Tokkie so its Settings match. */
async function setOptPref($: Engine, key: 'model' | 'mode', value: string) {
  await update($, opt, (o) => ({ ...o, [key]: value, error: undefined }))
  try {
    const dir = await tokkieHome($)
    const o = await read($, opt)
    await $.fs.write(`${dir}/prefs.json`, JSON.stringify({ at: await $.clock.now(), optimizerModel: o.model, optimizerMode: o.mode }))
  } catch { /* Tokkie will just keep its own setting */ }
}

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
// The pet in the bar: a small square, about the height of the bar's text.
const AVATAR_H = 14
const k = (key: string) => (ICON_PATHS[key] ? key : 'status')

const icon = (k: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[k] || ICON_PATHS.status}</svg>`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try { await refreshBand($); $.clock.every(3000, () => refreshBand($).catch(() => {})) } catch { /* ignore */ }
    try { $.clock.every(1000, () => serveRequests($).catch(() => {})) } catch { /* ignore */ }
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
    if (e.props.hasSurvey || !b || (!b.items.length && !b.optimizer)) return next(e)
    const table = $.ui.resolve(e) as any
    const { Box, Text, Button } = table
    const o = await read($, opt)
    // what the bar uses: a pick made on the bar wins until Tokkie's own setting catches up with it
    const model = o.model && MODELS.includes(o.model) ? o.model : b.optimizer ? b.optimizer.model : 'haiku'
    const mode = o.mode === 'shorter' || o.mode === 'clearer' ? o.mode : b.optimizer ? b.optimizer.mode : 'clearer'
    const { Select } = table
    const label = o.busy ? (mode === 'shorter' ? '✂ Shortening…' : '✨ Optimizing…') : mode === 'shorter' ? '✂ Shorten' : '✨ Optimize'
    const optButton = b.optimizer && Button ? (
      <Box key="optbox" flexDirection="row" columnGap={1} alignItems="center">
        <Button key="opt" label={label} onPress={() => { if (!o.busy) void optimizeDraft($, model, mode) }} />
        {Select ? <Select key="optmode" options={[{ value: 'clearer', label: '✨ Clearer' }, { value: 'shorter', label: '✂ Shorter' }]} value={mode} onSelect={(v: string) => { void setOptPref($, 'mode', v) }} /> : null}
        {Select ? <Select key="optmodel" options={[{ value: 'haiku', label: 'Haiku' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }]} value={model} onSelect={(v: string) => { void setOptPref($, 'model', v) }} /> : null}
      </Box>
    ) : null
    const undoButton = o.original && Button ? <Button key="undo" label="Undo" onPress={() => { void undoOptimize($) }} /> : null
    // the result line wraps onto as many rows as it needs, so nothing is cut off
    const optLine = o.error ? <Text color={TONE.warn} wrap="wrap">{o.error}</Text>
      : o.optimized ? (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1} alignItems="flex-start">
            <Box flexGrow={1} flexShrink={1}><Text dimColor wrap="wrap">{`${mode === 'shorter' ? '✂' : '✨'} ${o.before} → ${o.after} tokens`}{o.changes && o.changes.length ? ` · ${o.changes.join(' · ')}` : ''}</Text></Box>
            {undoButton}
          </Box>
          {o.questions && o.questions.length ? <Text color={TONE.warn} wrap="wrap">Fill in before sending: {o.questions.join(' · ')}</Text> : null}
        </Box>
      ) : null
    if (e.surface !== 'terminal' && table.Svg) {
      const Svg = table.Svg as any
      // One slim row: icon + value per item, no boxes. Hovering an item lights it and reveals a line saying
      // what it means (the surface's own hover-reveal: no hook runs, nothing leaves the drawing).
      const HL = '#8080802e'
      return (
        <Box flexDirection="column" overflow="hidden">
          {b.alert ? <Text color={TONE.bad} wrap="truncate">⚠ {b.alert}</Text> : null}
          {/* wraps onto more rows when the window is narrow, so nothing is cut off */}
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={0}>
            {b.avatar && b.showItems ? (
              <Box key="tk" paddingX={1} hover={{ scope: 'tokkie-about', backgroundColor: HL }}>
                <Svg source={b.avatar} alt="Tokkie" width={AVATAR_H} height={AVATAR_H} />
              </Box>
            ) : null}
            {optButton}
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
          {optLine}
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
        {optLine}
        <Box flexDirection="row" flexWrap="nowrap" overflow="hidden" columnGap={2}>
          {optButton}
          {b.showItems ? <Text bold>Tokkie</Text> : null}
          {b.items.map((it, i) => (
            <Text key={String(i)} wrap="truncate"><Text color={it.tone ? TONE[it.tone] : NEUTRAL}>{GLYPH[it.k] || '•'} </Text><Text color={it.tone ? TONE[it.tone] : undefined}>{it.value}</Text></Text>
          ))}
        </Box>
      </Box>
    )
  })
}
