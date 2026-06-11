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

test('THE BUG: terminal status arrives before text+finalResult → drain, do not finalize empty', () => {
  // This is exactly what GET /tasks returns the beat the relay flips terminal:
  // status=completed but finalResult not yet populated, and no text streamed yet.
  assert.equal(
    shouldDrainTerminal({ sawText: false, finalResult: '', terminalDrains: 0, now: T0, deadline: DEADLINE }),
    true,
    '一拿到 terminal 就 finalize 会丢掉随后到达的 manager 总结（半截 bug）',
  )
  // undefined finalResult is the same case.
  assert.equal(
    shouldDrainTerminal({ sawText: false, finalResult: undefined, terminalDrains: 0, now: T0, deadline: DEADLINE }),
    true,
  )
  // whitespace-only finalResult counts as no answer → still drain.
  assert.equal(
    shouldDrainTerminal({ sawText: false, finalResult: '   \n', terminalDrains: 0, now: T0, deadline: DEADLINE }),
    true,
  )
})

test('have the answer → finalize immediately (no needless extra windows)', () => {
  // streamed text already captured
  assert.equal(
    shouldDrainTerminal({ sawText: true, finalResult: '', terminalDrains: 0, now: T0, deadline: DEADLINE }),
    false,
  )
  // finalResult present on the status response
  assert.equal(
    shouldDrainTerminal({ sawText: false, finalResult: '验价通过…', terminalDrains: 0, now: T0, deadline: DEADLINE }),
    false,
  )
})

test('bounded: stop draining after MAX so a genuinely silent terminal turn still finalizes', () => {
  assert.equal(
    shouldDrainTerminal({ sawText: false, finalResult: '', terminalDrains: MAX_TERMINAL_DRAINS - 1, now: T0, deadline: DEADLINE }),
    true,
    '尚未到上限，应继续 drain',
  )
  assert.equal(
    shouldDrainTerminal({ sawText: false, finalResult: '', terminalDrains: MAX_TERMINAL_DRAINS, now: T0, deadline: DEADLINE }),
    false,
    '到上限必须 finalize，不能无限 drain',
  )
})

test('past the turn deadline → finalize regardless', () => {
  assert.equal(
    shouldDrainTerminal({ sawText: false, finalResult: '', terminalDrains: 0, now: DEADLINE + 1, deadline: DEADLINE }),
    false,
  )
})

const HARD = T0 + 900_000

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
  assert.equal(shouldDrainTerminal({ sawText: false, finalResult: '', terminalDrains: drains, now: T0, deadline: DEADLINE }), true)
  drains++
  // window N+1: reconnect replayed the tail, text now streamed → finalize
  assert.equal(shouldDrainTerminal({ sawText: true, finalResult: '', terminalDrains: drains, now: T0, deadline: DEADLINE }), false)
})
