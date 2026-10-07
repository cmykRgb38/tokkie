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
