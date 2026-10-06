/** "Does the pet need to tap you on the shoulder?" — pure logic, unit tested. */

export const MIN_RUN_SEC = 15;       // shorter runs finish while you're watching; don't nag
export const QUIET_MS = 60 * 1000;   // a running task with no activity this long may be waiting on you
export const MAX_AGE_MS = 2 * 3600e3;

/**
 * @param {{active:object|null, lastTurnEnd:number, lastTurn?:{end:number,dur:number}, now:number}} S
 * @param {{doneEnd:number, ask:{lastTs:number}|null}} acked  what the user has already dismissed
 * @returns {null | {kind:'done', since:number} | {kind:'ask', quietMs:number}}
 */
export function alertState(S, acked, enabled = true) {
  if (!enabled) return null;
  const { active, now } = S;
  if (active) {
    const quietMs = now - active.lastTs;
    if (quietMs > QUIET_MS && !(acked.ask && acked.ask.lastTs === active.lastTs)) return { kind: 'ask', quietMs };
    return null;
  }
  const t = S.lastTurn;
  if (S.lastTurnEnd && S.lastTurnEnd > acked.doneEnd && now - S.lastTurnEnd < MAX_AGE_MS && t && t.end === S.lastTurnEnd && t.dur >= MIN_RUN_SEC) return { kind: 'done', since: S.lastTurnEnd };
  return null;
}

/** Mark whatever is currently alerting as seen. */
export function acknowledge(S, acked) {
  const a = { doneEnd: acked.doneEnd, ask: acked.ask };
  a.doneEnd = Math.max(a.doneEnd, S.lastTurnEnd || 0);
  if (S.active) a.ask = { lastTs: S.active.lastTs };
  return a;
}
