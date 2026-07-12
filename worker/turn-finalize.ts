/**
 * Pure finalize-decision for TaskDO.alarm(), factored out so it's unit-testable
 * without instantiating a Durable Object (which imports `cloudflare:workers`).
 *
 * The bug it guards: on delegated turns the relay's events arrive in a tail-burst
 * (delegation tool_use → long gap → tool_result → manager text → `done{finalResult}`),
 * and the relay flips terminal (both on GET /tasks and as a stream `done`) a beat
 * BEFORE the trailing tool_result + text are readable from /events. Finalizing on the
 * bare terminal signal drops the agent's answer and the delegated tool_result that
 * feeds the bench cards. So while the turn is terminal but the tail hasn't streamed,
 * we drain a few more /events windows to catch it.
 *
 * `sawText` here means "assistant text since the LAST tool_use" (TaskDO resets it when
 * a tool_use streams): an opening ack ("好的，我马上委派…") before the delegation must
 * not count as the answer — that exact false positive skipped the drain and lost a
 * whole turn's tail in prod (2026-07-12, task 77904658). A present-but-early
 * `finalResult` doesn't short-circuit the drain either: the relay populates it a beat
 * before the tail events, so finalizing on it saves the text but still drops the
 * delegated tool_result (= no cards) — drains are near-instant reconnects on a
 * terminal task, so waiting for the streamed tail costs almost nothing.
 */

/** Extra windows to drain the relay's trailing tail+done after it flips terminal.
 *  Each drain against a terminal task converges in ~1s (the relay replays and closes
 *  with `done` immediately), so a higher cap buys real patience for lagging event
 *  synthesis without meaningfully delaying genuinely silent turns. */
export const MAX_TERMINAL_DRAINS = 8

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
  /** Streamed assistant text since the last tool_use (an opening ack before a
   *  delegation does NOT count — TaskDO resets this when a tool_use streams). */
  sawText: boolean
  /** How many windows we've already drained this turn after seeing terminal. */
  terminalDrains: number
  /** Current time and the turn's HARD deadline (drain never runs past it — the soft
   *  deadline is too tight: a turn finalizing at 213s would get only 27s of drain). */
  now: number
  hardDeadline: number
}

/** True → re-arm one more /events window to drain the tail before finalizing.
 *  False → the answer streamed (or drains/deadline exhausted): finalize now. */
export function shouldDrainTerminal(i: DrainInput): boolean {
  return !i.sawText && i.terminalDrains < MAX_TERMINAL_DRAINS && i.now < i.hardDeadline
}
