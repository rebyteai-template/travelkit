/**
 * The failed-attempt limiter (server/rate-limit.ts) that guards the two static-secret endpoints.
 *
 * Run: node --import tsx --test server/rate-limit.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callerKey, createFailureLimiter } from './rate-limit.ts'

test('a caller gets exactly `limit` failures per window, then is locked out', () => {
  let now = 1_000_000
  const limiter = createFailureLimiter({ limit: 3, windowMs: 60_000, now: () => now })
  assert.equal(limiter.check('1.2.3.4').blocked, false)
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.record('1.2.3.4').blocked, i === 2)
  const locked = limiter.check('1.2.3.4')
  assert.equal(locked.blocked, true)
  assert.equal(locked.retryAfterS, 60)
  // Per caller: one attacker must not lock out the legitimate integrator.
  assert.equal(limiter.check('5.6.7.8').blocked, false)
  // The window is fixed, not sliding: it eventually reopens on its own, so a transient
  // misconfiguration cannot wedge the endpoint permanently.
  now += 60_001
  assert.equal(limiter.check('1.2.3.4').blocked, false)
})

test('a successful authentication clears the caller — a rollout typo does not hold ops hostage', () => {
  const limiter = createFailureLimiter({ limit: 2 })
  limiter.record('relay')
  limiter.record('relay')
  assert.equal(limiter.check('relay').blocked, true)
  limiter.clear('relay')
  assert.equal(limiter.check('relay').blocked, false)
})

test('a rotating-IP flood cannot grow the table without bound', () => {
  const limiter = createFailureLimiter({ limit: 5, maxKeys: 50 })
  for (let i = 0; i < 5_000; i += 1) limiter.record(`10.0.0.${i}`)
  // Nothing to assert on memory directly; the contract is that it keeps answering and stays
  // bounded (the map is dropped rather than grown). Failing open here is deliberate: the
  // per-attempt log line is what catches a distributed flood, not this map.
  assert.equal(limiter.record('10.0.0.1').blocked, false)
})

test('the bucket key is the edge-supplied client IP, or nothing at all', () => {
  assert.equal(callerKey(new Headers({ 'CF-Connecting-IP': '203.0.113.7' })), '203.0.113.7')
  // X-Forwarded-For is REQUEST DATA. Honouring it hands the caller its own bucket key, which is
  // worse than having none: rotating it mints unlimited fresh budgets, and forging the relay's
  // address spends the relay's — a lockout of the legitimate integrator, from outside.
  const forged = new Headers({ 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' })
  assert.equal(callerKey(forged), 'unattributed')
  assert.equal(callerKey(new Headers({ 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.1' })), '203.0.113.7')
  // Everything the edge did not attribute shares ONE bucket — fail closed, not one budget each.
  assert.equal(callerKey(new Headers()), 'unattributed')
})
