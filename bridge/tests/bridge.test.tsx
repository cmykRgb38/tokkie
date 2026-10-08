import { expect, mock, test } from 'claude-code/testing'

// A fake Claude Code: usage figures we control, and a file system we can read back.
function fakeHost(on: any, state: { cost: number; limits: any[] }) {
  const files: Record<string, string> = {}
  on('session.usage', () => ({ value: { startedAt: 1000, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: state.limits, cost: { usd: state.cost } } }))
  on('session.id', () => ({ value: 'S1' }))
  on('agent.list', () => ({ value: [{ id: 'a', description: 'x', type: 'general', status: 'running' }, { id: 'b', description: 'y', type: 'general', status: 'done' }] }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/private/tmp/tokkie-bridge-test' : '' }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => { files[e.path] = e.text; return { value: null } })
  on('fs.read', (_: unknown, e: { path: string }) => (e.path in files ? { value: files[e.path] } : { deny: 'missing' }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.end', () => ({}))
  on('session.measure', (_: unknown, e: any) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  return files
}

test('records the session cost and what each prompt cost', async ($, on) => {
  mock.clock(on, { now: 5000 })
  const state = { cost: 2.5, limits: [] as any[] }
  const files = fakeHost(on, state)
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  state.cost = 3.75
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done' } as never)
  const rec = JSON.parse(files['/private/tmp/tokkie-bridge-test/.tokkie/bridge/S1.json'])
  expect(rec.costUsd).toBe(3.75)
  expect(rec.turns.length).toBe(1)
  expect(rec.turns[0].usd).toBe(1.25)
  expect(rec.context.percent).toBe(25)
  expect(rec.agentsRunning).toBe(1)
  expect(files['/private/tmp/tokkie-bridge-test/.tokkie/rate_limits.json']).toBe(undefined)   // no plan windows → no limits file
})

test('writes plan limits in the format Tokkie reads, when the account has them', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  const state = { cost: 1, limits: [{ kind: 'five_hour', percentUsed: 42.5, resetsAt: '2027-01-15T08:00:00Z' }, { kind: 'seven_day', percentUsed: 61 }] }
  const files = fakeHost(on, state)
  await $.session.measure({ context: { window: 200000 }, rateLimits: state.limits, cost: { usd: 1 }, changed: ['rateLimits'] } as never)
  const lim = JSON.parse(files['/private/tmp/tokkie-bridge-test/.tokkie/rate_limits.json'])
  expect(lim.five_hour.used_percentage).toBe(42.5)
  expect(lim.five_hour.resets_at).toBe(Math.floor(Date.parse('2027-01-15T08:00:00Z') / 1000))
  expect(lim.seven_day.used_percentage).toBe(61)
  expect(lim.five_hour.updated_at).toBe(1_800_000_000)
})

test('draws Tokkie’s Dock above the prompt when Tokkie asks for it, and nothing otherwise', async ($, on) => {
  mock.clock(on, { now: 1_900_000_000_000 })
  const files = fakeHost(on, { cost: 1, limits: [] })
  const BAND = '/private/tmp/tokkie-bridge-test/.tokkie/band.json'
  files[BAND] = JSON.stringify({ updatedAt: 1_900_000_000_000 - 1000, show: true, alert: 'Not enough left for this prompt', items: [{ k: 'usage', label: 'Usage', value: '≈58% · $116', tone: 'good', tip: '≈58% of your $200 limit used' }, { k: 'pace', label: 'Pace', value: 'out 11 Oct', tone: 'bad' }, { k: 'status', label: 'Status', value: 'Done 1m' }, { k: 'tokens', label: 'Today', value: '1.43M · $7.32' }, { k: 'lastPrompt', label: 'Last prompt', value: '$0.50' }, { k: 'context', label: 'Context', value: '376k', tone: 'bad' }, { k: 'cache', label: 'Cache', value: '59m' }], avatar: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="1" height="1" fill="#fff"/></svg>' })
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'tokkie-bridge', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } } as never)
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /58%/ } as never)).toBeDefined()
    else expect(JSON.stringify(await ui.drawn()).includes('≈58% · $116')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /Not enough left/ } as never)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no such text/ } as never)).toBeUndefined()
    if (surface === 'desktop') {
      const svg: any = await ui.find({ type: 'Svg' } as never)
      expect(svg).toBeDefined()                                                                  // the bar is one SVG
      const src = JSON.stringify(await ui.drawn())
      expect(src.includes('"display":"none"') && src.includes('≈58% of your $200 limit used')).toBe(true)   // hover explanations, hidden until hovered
    }
    else expect(await ui.find({ type: 'Text', text: /◔/ } as never)).toBeDefined()               // glyphs in the terminal
    await ui.unmount()
  }
})

test('no bar when Tokkie is closed (stale file) or the bar is switched off', async ($, on) => {
  mock.clock(on, { now: 1_900_000_000_000 })
  const files = fakeHost(on, { cost: 1, limits: [] })
  const BAND = '/private/tmp/tokkie-bridge-test/.tokkie/band.json'
  on('ui.render', ($: any, e: any) => { const { Box } = $.ui.resolve(e); return <Box key="engine" /> })   // the engine's own (empty) band
  files[BAND] = JSON.stringify({ updatedAt: 1_900_000_000_000 - 10 * 60e3, show: true, items: [{ label: 'Usage', value: '54%' }] })
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  const ui = await $.ui.mount({ plugin: 'tokkie-bridge', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } } as never)
  expect(await ui.find({ type: 'Text', text: /54%/ } as never)).toBeUndefined()
  await ui.unmount()
})

test('answers Tokkie’s optimize request once, on the user’s own Claude, and writes the reply back', async ($, on) => {
  const clock = mock.clock(on, { now: 1_900_000_000_000 })
  const files = fakeHost(on, { cost: 1, limits: [] })
  const H = '/private/tmp/tokkie-bridge-test/.tokkie'
  files[`${H}/requests/abc12345.json`] = JSON.stringify({ kind: 'optimize', model: 'haiku', prompt: 'fix the login thing pls' })
  let asked: any = null
  on('fs.list', (_: unknown, e: { path: string }) => ({ value: Object.keys(files).filter((f) => f.startsWith(e.path + '/')).map((f) => ({ name: f.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }))
  on('model.complete', (_: unknown, e: any) => { asked = e; return { value: { isAnswered: true, text: '{"optimized":"Fix the login bug in auth.ts","changes":["Named the file"],"questions":[]}', usage: { input_tokens: 400, output_tokens: 60 } } } })
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  await clock.advance(2500)
  const res = JSON.parse(files[`${H}/responses/abc12345.json`])
  expect(asked.model).toBe('haiku')
  expect(asked.prompt.includes('fix the login thing pls')).toBe(true)
  expect(res.text.includes('auth.ts')).toBe(true)
  // already answered: not asked again
  asked = null
  await clock.advance(3000)
  expect(asked).toBe(null)
})

test('✨ Optimize on the bar rewrites the typed prompt in place, and Undo puts it back', async ($, on) => {
  const clock = mock.clock(on, { now: 1_900_000_000_000 })
  const files = fakeHost(on, { cost: 1, limits: [] })
  files['/private/tmp/tokkie-bridge-test/.tokkie/band.json'] = JSON.stringify({ updatedAt: 1_900_000_000_000 - 1000, show: false, items: [], optimizer: { model: 'sonnet' } })
  let draft = 'fix the login thing pls', asked: any = null
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', (_: unknown, e: any) => { draft = e.text; return { isFilled: true } })
  on('model.complete', (_: unknown, e: any) => { asked = e; return { value: { isAnswered: true, text: '{"optimized":"Fix the login bug in src/auth.ts and add a test.","changes":["Named the file"],"questions":[]}', usage: { input_tokens: 1, output_tokens: 1 } } } })
  on('ui.render', ($$: any, e: any) => { const { Box } = $$.ui.resolve(e); return <Box key="engine" /> })
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  await clock.advance(10)
  for (const surface of ['desktop', 'terminal'] as const) {
    draft = 'fix the login thing pls'
    const ui = await $.ui.mount({ plugin: 'tokkie-bridge', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } } as never)
    expect(await ui.find({ key: 'opt' } as never)).toBeDefined()
    await ui.press({ key: 'opt' } as never)
    expect(asked.model).toBe('sonnet')
    expect(draft).toBe('Fix the login bug in src/auth.ts and add a test.')
    expect(await ui.find({ type: 'Text', text: /Named the file/ } as never)).toBeDefined()
    await ui.press({ key: 'undo' } as never)
    expect(draft).toBe('fix the login thing pls')
    await ui.unmount()
  }
})

test('the bar’s style × model picker takes effect at once and tell Tokkie', async ($, on) => {
  const clock = mock.clock(on, { now: 1_900_000_000_000 })
  const files = fakeHost(on, { cost: 1, limits: [] })
  const H = '/private/tmp/tokkie-bridge-test/.tokkie'
  files[`${H}/band.json`] = JSON.stringify({ updatedAt: 1_900_000_000_000 - 1000, show: false, items: [], optimizer: { model: 'haiku', mode: 'clearer' } })
  let draft = 'please could you maybe fix the login thing if possible thanks', asked: any = null
  on('prompt.read', () => ({ value: { text: draft, cursor: 0 } }))
  on('prompt.fill', (_: unknown, e: any) => { draft = e.text; return { isFilled: true } })
  on('model.complete', (_: unknown, e: any) => { asked = e; return { value: { isAnswered: true, text: '{"optimized":"Fix the login bug.","changes":["Cut filler"],"questions":[]}', usage: { input_tokens: 1, output_tokens: 1 } } } })
  on('ui.render', ($$: any, e: any) => { const { Box } = $$.ui.resolve(e); return <Box key="engine" /> })
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'tokkie-bridge', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } } as never)
  await (ui as any).select({ key: 'optcfg', value: 'shorter:opus' })
  expect(JSON.parse(files[`${H}/prefs.json`]).optimizerModel).toBe('opus')
  expect(JSON.parse(files[`${H}/prefs.json`]).optimizerMode).toBe('shorter')
  await ui.press({ key: 'opt' } as never)
  expect(asked.model).toBe('opus')
  expect(asked.system.includes('as few words as possible')).toBe(true)
  expect(draft).toBe('Fix the login bug.')
  await ui.unmount()
})
