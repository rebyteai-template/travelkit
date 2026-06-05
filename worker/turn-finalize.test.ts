/**
 * Deterministic regression for the "second message loads back only halfway" bug.
 * No relay / VM — exercises the finalize decision directly.
 *
 * Run: node --import tsx --test worker/turn-finalize.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldDrainTerminal, MAX_TERMINAL_DRAINS } from './turn-finalize.ts'

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

test('drain converges: a drained window that finally captures text stops the loop', () => {
  // window N: terminal, nothing yet → drain
  let drains = 0
  assert.equal(shouldDrainTerminal({ sawText: false, finalResult: '', terminalDrains: drains, now: T0, deadline: DEADLINE }), true)
  drains++
  // window N+1: reconnect replayed the tail, text now streamed → finalize
  assert.equal(shouldDrainTerminal({ sawText: true, finalResult: '', terminalDrains: drains, now: T0, deadline: DEADLINE }), false)
})
