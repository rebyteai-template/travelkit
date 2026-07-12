/**
 * Deterministic regression for the "second message loads back only halfway" bug.
 * No relay / VM — exercises the finalize decision directly.
 *
 * Run: node --import tsx --test worker/turn-finalize.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldDrainTerminal,
  shouldRetryWindowError,
  turnExpired,
  MAX_TERMINAL_DRAINS,
  MAX_WINDOW_ERRORS,
} from './turn-finalize.ts'

const T0 = 1_000_000
const DEADLINE = T0 + 240_000
const HARD = T0 + 900_000

test('THE BUG: terminal signal arrives before the tail streams → drain, do not finalize', () => {
  // Both terminal paths (stream `done` and GET /tasks) can fire the beat the relay
  // flips terminal, before the delegated tool_result + manager summary are readable.
  assert.equal(
    shouldDrainTerminal({ sawText: false, terminalDrains: 0, now: T0, hardDeadline: HARD }),
    true,
    '一拿到 terminal 就 finalize 会丢掉随后到达的 tool_result + manager 总结',
  )
})

test('ACK POISON (task 77904658): sawText means text since the LAST tool_use, so an opening ack still drains', () => {
  // TaskDO resets sawText when a tool_use streams — by the time the terminal race
  // hits a delegated turn, an opening "好的，我马上委派…" has been invalidated and the
  // guard sees sawText=false. (The old `sawText || finalResult` short-circuit is gone:
  // an early finalResult rescued the text but still dropped the tool_result/cards.)
  assert.equal(
    shouldDrainTerminal({ sawText: false, terminalDrains: 0, now: T0, hardDeadline: HARD }),
    true,
  )
})

test('answer streamed → finalize immediately (no needless extra windows)', () => {
  assert.equal(
    shouldDrainTerminal({ sawText: true, terminalDrains: 0, now: T0, hardDeadline: HARD }),
    false,
  )
})

test('bounded: stop draining after MAX so a genuinely silent terminal turn still finalizes', () => {
  assert.equal(
    shouldDrainTerminal({ sawText: false, terminalDrains: MAX_TERMINAL_DRAINS - 1, now: T0, hardDeadline: HARD }),
    true,
    '尚未到上限，应继续 drain',
  )
  assert.equal(
    shouldDrainTerminal({ sawText: false, terminalDrains: MAX_TERMINAL_DRAINS, now: T0, hardDeadline: HARD }),
    false,
    '到上限必须 finalize，不能无限 drain',
  )
})

test('past the HARD deadline → finalize regardless (soft deadline no longer starves the drain)', () => {
  // A turn that hits terminal at 213s used to get only 27s of drain budget against
  // the 240s soft deadline; drains are bounded by count anyway, so the hard cap is
  // the right time bound.
  assert.equal(
    shouldDrainTerminal({ sawText: false, terminalDrains: 0, now: DEADLINE + 1, hardDeadline: HARD }),
    true,
    '过了软 deadline 仍可 drain（次数上限兜底）',
  )
  assert.equal(
    shouldDrainTerminal({ sawText: false, terminalDrains: 0, now: HARD + 1, hardDeadline: HARD }),
    false,
  )
})

test('THE BUG: one transient window error must NOT finalize the turn → retry', () => {
  // A single relay/D1 hiccup used to finalize 'failed' immediately: the browser got
  // `done`, the 正在处理 bubble vanished, and the still-running agent's answer had no
  // way back in until a manual refresh.
  assert.equal(shouldRetryWindowError({ errors: 1, now: T0, hardDeadline: HARD }), true)
  assert.equal(shouldRetryWindowError({ errors: MAX_WINDOW_ERRORS - 1, now: T0, hardDeadline: HARD }), true)
})

test('window errors are bounded: give up after MAX consecutive or past the hard deadline', () => {
  assert.equal(shouldRetryWindowError({ errors: MAX_WINDOW_ERRORS, now: T0, hardDeadline: HARD }), false)
  assert.equal(shouldRetryWindowError({ errors: 1, now: HARD + 1, hardDeadline: HARD }), false)
})

test('soft deadline: an alive relay keeps the turn going, an unreachable one does not', () => {
  const past = DEADLINE + 1
  // relay positively reports the task alive → extend up to the hard cap
  assert.equal(turnExpired({ now: past, deadline: DEADLINE, hardDeadline: HARD, relayStatus: 'running' }), false)
  // status query failed / unknown → no benefit of the doubt
  assert.equal(turnExpired({ now: past, deadline: DEADLINE, hardDeadline: HARD, relayStatus: undefined }), true)
  // terminal status is handled elsewhere — for expiry it counts as not-alive
  assert.equal(turnExpired({ now: past, deadline: DEADLINE, hardDeadline: HARD, relayStatus: 'completed' }), true)
})

test('hard deadline caps even an alive relay', () => {
  assert.equal(turnExpired({ now: HARD, deadline: DEADLINE, hardDeadline: HARD, relayStatus: 'running' }), true)
  // and before the soft deadline nothing expires
  assert.equal(turnExpired({ now: T0, deadline: DEADLINE, hardDeadline: HARD, relayStatus: undefined }), false)
})

test('drain converges: a drained window that finally captures text stops the loop', () => {
  // window N: terminal, nothing yet → drain
  let drains = 0
  assert.equal(shouldDrainTerminal({ sawText: false, terminalDrains: drains, now: T0, hardDeadline: HARD }), true)
  drains++
  // window N+1: reconnect replayed the tail, text now streamed → finalize
  assert.equal(shouldDrainTerminal({ sawText: true, terminalDrains: drains, now: T0, hardDeadline: HARD }), false)
})
