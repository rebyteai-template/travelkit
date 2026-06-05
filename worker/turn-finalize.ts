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
