/**
 * Deriving the Ctrip question, and our comparable figure, from a plan.
 *
 * The regression that matters is `adultUnitPrice`: before it, the table compared Ctrip's
 * one-adult pre-tax fare against a plan total covering EVERY passenger. On a two-adult booking
 * that overstates us by ~2x — far more than the margin being bid for.
 *
 * Run: node --import tsx --test src/lib/ctrip-target.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { adultUnitPrice, quoteTargetFor, unquotableReason } from './ctrip-target.ts'
import type { RecommendationPlan } from '../frames.ts'

/** The target when the plan is quotable, null when refused — most tests only care about one side. */
const targetOf = (p: RecommendationPlan) => {
  const result = quoteTargetFor(p)
  return 'target' in result ? result.target : null
}

const segment = (flightNo: string, departureDate: string, departureTime: string, opFlightNo?: string) => ({
  flightNo,
  ...(opFlightNo ? { opFlightNo } : {}),
  departure: 'PEK',
  departureDate,
  departureTime,
  arrival: 'CAN',
  arrivalDate: departureDate,
  arrivalTime: '10:25',
})

const plan = (over: Partial<RecommendationPlan>): RecommendationPlan =>
  ({
    planId: 'p1',
    windows: [],
    journeys: [],
    passengerGroups: [{ passengerGroupId: 'g1', cabinClass: 'economy', passengers: { adult: 2, child: 0, infant: 0 } }],
    ticketGroups: [],
    verifiedFareTotal: { amount: 2000, currency: 'CNY' },
    verifiedAt: '2026-08-13T00:00:00Z',
    validity: { status: 'verified', validUntil: '2026-08-13T01:00:00Z' },
    copyText: '',
    ctripUrl: 'https://flights.ctrip.com/online/list/oneway-pek-can?depdate=2026-08-23',
    capabilities: { canCopy: true, canReverify: false, canBook: true },
    ...over,
  }) as RecommendationPlan

const oneway = () =>
  plan({
    journeys: [{ journeyId: 'j1', role: 'oneway', origin: 'PEK', destination: 'CAN', duration: '3h25m', transferCount: 0, segments: [segment('CA1359', '2026-08-23', '07:00')] }],
    ticketGroups: [{ ticketGroupId: 't1', passengerGroupId: 'g1', journeyIndexes: [0], fareSource: 'oneway', exactPassengerCount: { adult: 2, child: 0, infant: 0 }, verifiedAt: '', validity: { status: 'verified', validUntil: '' }, verifiedPrice: { amount: 1700, currency: 'CNY' } }],
  } as Partial<RecommendationPlan>)

const roundTrip = (ticketGroups: unknown[]) =>
  plan({
    journeys: [
      { journeyId: 'j1', role: 'outbound', origin: 'PEK', destination: 'CAN', duration: '3h25m', transferCount: 0, segments: [segment('CA1359', '2026-08-23', '07:00')] },
      { journeyId: 'j2', role: 'inbound', origin: 'CAN', destination: 'PEK', duration: '3h25m', transferCount: 0, segments: [segment('CA9675', '2026-08-27', '07:45')] },
    ],
    ticketGroups,
  } as Partial<RecommendationPlan>)

test('a one-way plan asks about its only flight, and carries the url to ask on', () => {
  const result = quoteTargetFor(oneway())
  assert.ok('target' in result)
  const { target, url } = result
  assert.equal(target.flightNo, 'CA1359')
  assert.equal(target.departureDate, '2026-08-23')
  assert.equal(target.departureTime, '07:00')
  assert.equal(target.outbound, undefined)
  assert.match(url, /^https:\/\/flights\.ctrip\.com\//)
})

test('a round trip asks about the RETURN, and names the outbound to select', () => {
  // Ctrip only prices a round trip after an outbound is chosen; the node that then appears
  // carries the combination total for exactly this pair.
  const target = targetOf(roundTrip([
    { ticketGroupId: 't1', passengerGroupId: 'g1', journeyIndexes: [0, 1], fareSource: 'oneway', exactPassengerCount: { adult: 2, child: 0, infant: 0 }, verifiedAt: '', validity: { status: 'verified', validUntil: '' }, verifiedPrice: { amount: 2500, currency: 'CNY' } },
  ]))
  assert.equal(target?.flightNo, 'CA9675')
  assert.equal(target?.outbound?.flightNo, 'CA1359')
})

test('a codeshare carries the operating number too', () => {
  const withOp = plan({
    journeys: [{ journeyId: 'j1', role: 'oneway', origin: 'PEK', destination: 'CAN', duration: '3h', transferCount: 0, segments: [segment('CZ9999', '2026-08-23', '07:55', 'CA1351')] }],
  } as Partial<RecommendationPlan>)
  assert.equal(targetOf(withOp)?.opFlightNo, 'CA1351')
})

test('a transfer plan is refused with the reason the cell shows', () => {
  const transfer = plan({
    journeys: [{ journeyId: 'j1', role: 'oneway', origin: 'PEK', destination: 'CAN', duration: '7h', transferCount: 1, segments: [segment('ZH9155', '2026-08-23', '16:35'), segment('ZH1234', '2026-08-23', '20:00')] }],
  } as Partial<RecommendationPlan>)
  assert.equal(targetOf(transfer), null)
  assert.match(unquotableReason(transfer) ?? '', /中转/)
})

test('the button and the request can no longer disagree: every refusal carries a reason', () => {
  // These were the drift cases: quoteTargetFor returned null while unquotableReason said
  // "quotable", leaving a button that flashed and did nothing.
  const noUrl = plan({ ctripUrl: undefined } as unknown as Partial<RecommendationPlan>)
  assert.match(unquotableReason(noUrl) ?? '', /携程对应链接/)

  const noJourneys = plan({ journeys: [] } as Partial<RecommendationPlan>)
  assert.match(unquotableReason(noJourneys) ?? '', /缺少航班信息/)

  // Two journeys with an inbound but no outbound role: previously quotable-per-reason,
  // untargetable-per-builder.
  const noOutboundRole = plan({
    journeys: [
      { journeyId: 'j1', role: 'leg', origin: 'PEK', destination: 'CAN', duration: '3h25m', transferCount: 0, segments: [segment('CA1359', '2026-08-23', '07:00')] },
      { journeyId: 'j2', role: 'inbound', origin: 'CAN', destination: 'PEK', duration: '3h25m', transferCount: 0, segments: [segment('CA9675', '2026-08-27', '07:45')] },
    ],
  } as Partial<RecommendationPlan>)
  assert.match(unquotableReason(noOutboundRole) ?? '', /去程/)
})

test('regression: our figure is PER ADULT, not the whole booking', () => {
  // ¥1700 covers two adults. Comparing 1700 against Ctrip's one-adult 670 would say we are
  // ¥1030 more expensive; the honest comparison is 850 against 670.
  const price = adultUnitPrice(oneway())
  assert.equal(price?.amount, 850)
  assert.equal(price?.currency, 'CNY')
})

test('a round trip issued as two tickets sums before dividing', () => {
  const price = adultUnitPrice(roundTrip([
    { ticketGroupId: 't1', passengerGroupId: 'g1', journeyIndexes: [0], fareSource: 'oneway', exactPassengerCount: { adult: 2, child: 0, infant: 0 }, verifiedAt: '', validity: { status: 'verified', validUntil: '' }, verifiedPrice: { amount: 1400, currency: 'CNY' } },
    { ticketGroupId: 't2', passengerGroupId: 'g1', journeyIndexes: [1], fareSource: 'oneway', exactPassengerCount: { adult: 2, child: 0, infant: 0 }, verifiedAt: '', validity: { status: 'verified', validUntil: '' }, verifiedPrice: { amount: 1100, currency: 'CNY' } },
  ]))
  assert.equal(price?.amount, 1250) // (1400 + 1100) / 2
})

test('a booking with children yields no adult figure rather than a blended one', () => {
  const family = plan({
    passengerGroups: [{ passengerGroupId: 'g1', cabinClass: 'economy', passengers: { adult: 2, child: 1, infant: 0 } }],
    journeys: [{ journeyId: 'j1', role: 'oneway', origin: 'PEK', destination: 'CAN', duration: '3h', transferCount: 0, segments: [segment('CA1359', '2026-08-23', '07:00')] }],
    ticketGroups: [{ ticketGroupId: 't1', passengerGroupId: 'g1', journeyIndexes: [0], fareSource: 'oneway', exactPassengerCount: { adult: 2, child: 1, infant: 0 }, verifiedAt: '', validity: { status: 'verified', validUntil: '' }, verifiedPrice: { amount: 2400, currency: 'CNY' } }],
  } as Partial<RecommendationPlan>)
  assert.equal(adultUnitPrice(family), null)
})

test('mixed currencies refuse to sum', () => {
  const price = adultUnitPrice(roundTrip([
    { ticketGroupId: 't1', passengerGroupId: 'g1', journeyIndexes: [0], fareSource: 'oneway', exactPassengerCount: { adult: 2, child: 0, infant: 0 }, verifiedAt: '', validity: { status: 'verified', validUntil: '' }, verifiedPrice: { amount: 1400, currency: 'CNY' } },
    { ticketGroupId: 't2', passengerGroupId: 'g1', journeyIndexes: [1], fareSource: 'oneway', exactPassengerCount: { adult: 2, child: 0, infant: 0 }, verifiedAt: '', validity: { status: 'verified', validUntil: '' }, verifiedPrice: { amount: 200, currency: 'USD' } },
  ]))
  assert.equal(price, null)
})
