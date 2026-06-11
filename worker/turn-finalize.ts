/**
 * Pure finalize-decision for TaskDO.alarm(), factored out so it's unit-testable
 * without instantiating a Durable Object (which imports `cloudflare:workers`).
 *
 * The bug it guards: on delegated turns the relay's events arrive in a tail-burst
 * (delegation tool_use → long gap → tool_result → manager text → `done{finalResult}`),
 * and GET /tasks flips to a terminal status a beat BEFORE that trailing text + done
 * reach /events (and before its own finalResult field is populated). Finalizing on the
 * bare status there drops the agent's answer — the "second message loads back only
 * halfway then sticks" bug. So when the relay is terminal but we have neither streamed
 * text nor a finalResult yet, we drain a few more /events windows to catch the tail.
 */

/** Extra windows to drain the relay's trailing text+done after status flips terminal. */
export const MAX_TERMINAL_DRAINS = 4

/** Relay task statuses that mean the turn is over (mirrors the relay's vocabulary). */
export const TERMINAL_STATUSES = new Set(['completed', 'succeeded', 'failed', 'canceled', 'cancelled'])

/** Consecutive failed alarm windows tolerated before the turn is declared dead. One
 *  relay/D1 hiccup between windows must NOT kill a turn whose agent is still running —
 *  that's the "正在处理 disappears, chat stays blank until refresh" bug: the premature
 *  'failed' finalize sends `done` to the browser (loading bubble gone) while the relay
 *  keeps working, and nothing ever pushes the late answer. */
export const MAX_WINDOW_ERRORS = 3

/** True → the window error is worth another alarm; false → give up and finalize 'failed'. */
export function shouldRetryWindowError(i: { errors: number; now: number; hardDeadline: number }): boolean {
  return i.errors < MAX_WINDOW_ERRORS && i.now < i.hardDeadline
}

/**
 * Turn expiry is two-tier: past the soft deadline we only keep waiting when the relay
 * POSITIVELY reports the task alive (a fresh non-terminal status) — delegated turns
 * routinely outlive the soft window. An unreachable/unknown relay gets no benefit of
 * the doubt, and the hard deadline caps everything so a hung relay can't pin the
 * prompt at 'running' forever.
 */
export function turnExpired(i: { now: number; deadline: number; hardDeadline: number; relayStatus?: string }): boolean {
  const alive = !!i.relayStatus && !TERMINAL_STATUSES.has(i.relayStatus)
  return i.now >= (alive ? i.hardDeadline : i.deadline)
}

export interface DrainInput {
  /** Did we already stream assistant text this turn? */
  sawText: boolean
  /** finalResult from GET /tasks (lags the status flip — often empty when terminal). */
  finalResult?: string
  /** How many windows we've already drained this turn after seeing terminal. */
  terminalDrains: number
  /** Current time and the turn's hard deadline (drain never runs past it). */
  now: number
  deadline: number
}

/** True → re-arm one more /events window to drain the tail before finalizing.
 *  False → we have the answer (or exhausted drains / hit the deadline): finalize now. */
export function shouldDrainTerminal(i: DrainInput): boolean {
  const haveAnswer = i.sawText || !!i.finalResult?.trim()
  return !haveAnswer && i.terminalDrains < MAX_TERMINAL_DRAINS && i.now < i.deadline
}
