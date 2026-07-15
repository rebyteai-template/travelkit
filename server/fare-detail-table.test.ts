import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fareJourneyLabel } from '../src/components/FareDetailTable.tsx'
import { isBookableFare } from '../src/booking.ts'
import type { FareVerification } from '../src/frames.ts'
import { flightRouteCell } from '../src/lib/flight-display.ts'

test('verified fare labels use skill-provided journey roles', () => {
  assert.equal(fareJourneyLabel('oneway', 0, 0), '直飞')
  assert.equal(fareJourneyLabel('outbound', 1, 0), '去程中转1次')
  assert.equal(fareJourneyLabel('inbound', 0, 1), '回程直飞')
  assert.equal(fareJourneyLabel('leg', 0, 1), '第2程直飞')
})

test('verified fare routes preserve airport names and terminals from the skill', () => {
  assert.equal(flightRouteCell({
    departure: 'PEK',
    departureName: '北京首都',
    departureTerminal: 'T2',
    arrival: 'SHA',
    arrivalName: '上海虹桥',
    arrivalTerminal: 'T2',
  }), 'PEKSHA 北京首都(T2) → 上海虹桥(T2)')
})

test('booking flow follows the skill authorization', () => {
  const fare = { canBook: false } as FareVerification
  assert.equal(isBookableFare(null), false)
  assert.equal(isBookableFare(fare), false)
  assert.equal(isBookableFare({ ...fare, canBook: true }), false)
  assert.equal(isBookableFare({ ...fare, canBook: true, bookableUntil: new Date(Date.now() - 1).toISOString() }), false)
  assert.equal(isBookableFare({ ...fare, canBook: true, bookableUntil: new Date(Date.now() + 60_000).toISOString() }), true)
})
