/**
 * The matcher, against captures actually scraped off Ctrip (test/fixtures).
 *
 * The regression that matters is the last one. Before `matchCtripFlight` existed the comparison
 * figure was `capture.lowest`; on this real PEK-CAN page that is ¥610, a TRANSFER itinerary,
 * while the direct flight a plan would quote is ¥780. The error has a direction: it makes Ctrip
 * look cheaper than it is, so the operator concludes we are more expensive and walks away from a
 * booking we would have won. That is the same direction as the tax-basis gap (our totals include
 * tax, Ctrip lists pre-tax), so the two compound rather than cancel.
 *
 * Run: node --import tsx --test contract/src/ctrip-match.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { matchCtripFlight, matchQuoteNode, normalizeFlightNo, type CtripCapture } from './index.ts'

const fixture = (name: string): CtripCapture =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')) as CtripCapture

const oneway = fixture('ctrip-oneway-pek-can.json')
const round = fixture('ctrip-round-bjs-can.json')

const direct = (flightNo: string, departureTime: string, opFlightNo?: string) => ({
  transferCount: 0,
  segments: [{ flightNo, departureTime, ...(opFlightNo ? { opFlightNo } : {}) }],
})

test('leading zeros are stripped on both sides', () => {
  assert.equal(normalizeFlightNo('CA0841'), 'CA841')
  assert.equal(normalizeFlightNo('CA1359'), 'CA1359')
  assert.equal(normalizeFlightNo('3U08633'), '3U8633')
  assert.equal(normalizeFlightNo(null), '')
})

test('a plan matches its own row at its own fare', () => {
  const match = matchCtripFlight(direct('CA1321', '09:00'), oneway)
  assert.equal(match.status, 'matched')
  assert.equal(match.status === 'matched' && match.amount, 780)
})

test('a zero-padded plan number still finds Ctrip\'s row', () => {
  assert.equal(matchCtripFlight(direct('CA01359', '07:00'), oneway).status, 'matched')
})

test('a codeshare falls through to the operating number', () => {
  const match = matchCtripFlight(direct('CZ9999', '07:55', 'CA1351'), oneway)
  assert.equal(match.status === 'matched' && match.matchedBy, 'opFlightNo')
  assert.equal(match.status === 'matched' && match.amount, 769)
})

test('a departure-time mismatch is refused rather than filled', () => {
  const match = matchCtripFlight(direct('CA1321', '09:05'), oneway)
  assert.equal(match.status === 'unmatched' && match.reason, 'time-mismatch')
})

test('a transfer plan has nothing it can safely match', () => {
  const plan = {
    transferCount: 1,
    segments: [
      { flightNo: 'ZH9155', departureTime: '16:35' },
      { flightNo: 'ZH1234', departureTime: '20:00' },
    ],
  }
  assert.equal(matchCtripFlight(plan, oneway).status === 'unmatched' && matchCtripFlight(plan, oneway).reason, 'transfer-plan')
})

test('a direct plan never matches a transfer card', () => {
  // ZH9155 IS on the page — as the first leg of a 2-stop itinerary priced ¥610.
  const match = matchCtripFlight(direct('ZH9155', '16:35'), oneway)
  assert.equal(match.status, 'unmatched')
})

test('the round-trip page is refused wholesale', () => {
  // CA1359 sits right there at ¥1259 — a round-trip total for a return nobody picked.
  const match = matchCtripFlight(direct('CA1359', '07:00'), round)
  assert.equal(match.status === 'unmatched' && match.reason, 'round-trip-page')
})

test('blocked and degraded captures are refused', () => {
  assert.equal(
    matchCtripFlight(direct('CA1321', '09:00'), { ...oneway, blocked: true }).status === 'unmatched'
      && matchCtripFlight(direct('CA1321', '09:00'), { ...oneway, blocked: true }).reason,
    'blocked',
  )
  const degraded = matchCtripFlight(direct('CA1321', '09:00'), { ...oneway, strategy: 'fallback-scan' })
  assert.equal(degraded.status === 'unmatched' && degraded.reason, 'degraded-parse')
})

test('a flight Ctrip does not list yields nothing — never the page low', () => {
  const match = matchCtripFlight(direct('MU5102', '14:30'), oneway)
  assert.equal(match.status, 'unmatched')
  assert.notEqual(JSON.stringify(match), JSON.stringify({ amount: oneway.lowest }))
})

test('regression: the page low belongs to a different flight', () => {
  const lowestRow = oneway.flights.find((row) => row.price === oneway.lowest)!
  assert.equal(lowestRow.isTransfer, true, 'fixture premise: this page is won by a transfer')

  const match = matchCtripFlight(direct('CA1321', '09:00'), oneway)
  assert.equal(match.status, 'matched')
  const ours = match.status === 'matched' ? match.amount : 0
  assert.equal(ours, 780)
  assert.equal(oneway.lowest, 610)
  // ¥170 understated, in the direction that loses the booking.
  assert.equal(ours - (oneway.lowest as number), 170)
})

/* ------------------------------- matchQuoteNode ------------------------------- */

test('one-way: one number pins the node, absence refuses it', () => {
  assert.deepEqual(matchQuoteNode(['MU9192'], { flightNo: 'MU9192' }), { no: 'MU9192', by: 'flightNo' })
  assert.equal(matchQuoteNode(['MU9191'], { flightNo: 'MU9192' }), null)
})

test('regression: a step-1 cheapest-return pairing must NOT match on the return alone', () => {
  // Measured on SHA-CTU 08-21/08-23: the target was HO1039+CA4537, and the step-1 payload's
  // CA8541 card — paired with ITS cheapest return, which happened to be CA4537 — answered
  // first, at ¥1600, before 「选为去程」 was ever clicked. Right return, wrong trip.
  const target = { flightNo: 'CA4537', outbound: { flightNo: 'HO1039' } }
  assert.equal(matchQuoteNode(['CA8541', 'CA4537'], target), null)
  // The true pairing (step-2 payload, or step-1 when ours IS the cheapest combination) matches.
  assert.deepEqual(matchQuoteNode(['HO1039', 'CA4537'], target), { no: 'CA4537', by: 'flightNo' })
})

test('codeshare numbers pin either way, on the priced flight and on the outbound', () => {
  assert.deepEqual(
    matchQuoteNode(['CZ5693'], { flightNo: 'MF4693', opFlightNo: 'CZ5693' }),
    { no: 'CZ5693', by: 'opFlightNo' },
  )
  // The outbound listed under its operating number still satisfies the pin.
  assert.deepEqual(
    matchQuoteNode(['HO1039', 'CA4537'], { flightNo: 'CA4537', outbound: { flightNo: 'MF1039', opFlightNo: 'HO1039' } }),
    { no: 'CA4537', by: 'flightNo' },
  )
})

test('zero-padded forms normalize on both sides before comparing', () => {
  assert.deepEqual(matchQuoteNode(['CA841'], { flightNo: 'CA0841' }), { no: 'CA841', by: 'flightNo' })
  assert.deepEqual(
    matchQuoteNode(['CA0841', 'CA4537'], { flightNo: 'CA4537', outbound: { flightNo: 'CA841' } }),
    { no: 'CA4537', by: 'flightNo' },
  )
})
