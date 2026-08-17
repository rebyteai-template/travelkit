/**
 * The quote reader, against a real CA1359 node captured through the extension (test/fixtures).
 *
 * Run: node --import tsx --test contract/src/ctrip-quote.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { extractCtripQuote, isItineraryNode } from './index.ts'

const node = JSON.parse(readFileSync(new URL('../../test/fixtures/ctrip-node-CA1359.json', import.meta.url), 'utf8'))

test('reads the flight identity off the legs', () => {
  const quote = extractCtripQuote(node)
  assert.deepEqual(quote.flightNos, ['CA1359'])
  assert.equal(quote.legCount, 1)
  assert.equal(quote.departureDateTime, '2026-08-23 07:00:00')
  assert.equal(quote.arrivalDateTime, '2026-08-23 10:25:00')
})

test('the economy figure is the list-page fare, PRE-TAX, single adult', () => {
  const quote = extractCtripQuote(node)
  assert.equal(quote.economyLowestAdult, 670)
})

test('a cheaper RESTRICTED BUSINESS fare does not win', () => {
  // ¥1580 (cabin C, 4-5人) undercuts most economy fares. min(adultPrice) would take it; the
  // economy figure must not, and the overall-unrestricted figure must skip the restricted one too.
  const quote = extractCtripQuote(node)
  assert.notEqual(quote.economyLowestAdult, 1580)
  assert.equal(quote.overallLowestAdult, 670) // lowest UNRESTRICTED across all cabins is still 670
  const restricted = quote.fares.find((fare) => fare.restricted)
  assert.ok(restricted, 'the 4-5人 fare is present and flagged restricted')
  assert.equal(restricted?.adultPrice, 1580)
})

test('per-passenger prices are kept distinct, and there is no tax field to invent', () => {
  const quote = extractCtripQuote(node)
  const economy = quote.fares.find((fare) => fare.cabin === 'Y' && fare.adultPrice === 720)!
  assert.equal(economy.childPrice, 720)
  assert.equal(economy.infantPrice, 340)
  // Nothing in the node is a tax amount; the reader must not fabricate one. (Documented invariant.)
  assert.ok(!('tax' in quote))
})

test('business fares are visible but separated by cabin', () => {
  const quote = extractCtripQuote(node)
  const business = quote.fares.filter((fare) => fare.cabin === 'C')
  assert.ok(business.length >= 3)
  assert.ok(business.every((fare) => fare.cabin === 'C'))
})

test('a round-trip node states its cabin only in matchedKey, and is still read', () => {
  // Measured on a CA1359+CA9675 combination node: no top-level `cabin` on any of the ten fares,
  // so the economy figure came back blank while the all-cabin one resolved. Ctrip tags the same
  // fact as GRADE_Y / GRADE_C.
  const roundTrip = {
    flightSegments: [
      { flightList: [{ flightNo: 'CA1359', departureDateTime: '2026-08-23 07:00:00' }] },
      { flightList: [{ flightNo: 'CA9675', arrivalDateTime: '2026-08-27 11:10:00' }] },
    ],
    priceList: [
      { adultPrice: 1250, matchedKey: ['GRADE_Y', 'AIRLINE_CA'], restrictionList: [] },
      { adultPrice: 1470, matchedKey: ['GRADE_Y', 'AIRLINE_CA'], restrictionList: [] },
      { adultPrice: 6720, matchedKey: ['GRADE_C', 'AIRLINE_CA'], restrictionList: [] },
    ],
  }
  const quote = extractCtripQuote(roundTrip)
  assert.deepEqual(quote.flightNos, ['CA1359', 'CA9675'])
  assert.equal(quote.legCount, 2)
  assert.equal(quote.economyLowestAdult, 1250)
  assert.equal(quote.fares[2]?.cabin, 'C')
})

test('an explicit top-level cabin still wins over matchedKey', () => {
  const quote = extractCtripQuote({
    flightSegments: [{ flightList: [{ flightNo: 'CA1359' }] }],
    priceList: [{ adultPrice: 900, cabin: 'C', matchedKey: ['GRADE_Y'], restrictionList: [] }],
  })
  assert.equal(quote.fares[0]?.cabin, 'C')
  assert.equal(quote.economyLowestAdult, null)
})

test('isItineraryNode tells a fare-bearing node from a summary node', () => {
  assert.equal(isItineraryNode(node), true)
  assert.equal(isItineraryNode({ flightNo: 'CA9675' }), false) // a summary entry: no priceList
  assert.equal(isItineraryNode({ priceList: [], flightSegments: [] }), true)
  assert.equal(isItineraryNode(null), false)
})

test('an empty or malformed node degrades to nulls, not throws', () => {
  const quote = extractCtripQuote({})
  assert.equal(quote.economyLowestAdult, null)
  assert.deepEqual(quote.flightNos, [])
  assert.deepEqual(quote.fares, [])
})

test('a pairing node writes cabins @-prefixed and |-joined; all-economy still reads as Y', () => {
  // Measured on a SHA-CTU HO-pairing node: `"cabin":"@Y|@Y"`, one entry per leg. Before
  // normalizing, `cabin === 'Y'` missed it and a real ¥1600 unrestricted fare read as "no
  // economy" — and, with manual entry gone, as a button that flashed and did nothing.
  const combo = {
    flightSegments: [
      { flightList: [{ flightNo: 'HO1039', departureDateTime: '2026-08-21 07:20:00' }] },
      { flightList: [{ flightNo: 'CA4537', arrivalDateTime: '2026-08-23 10:10:00' }] },
    ],
    priceList: [
      { adultPrice: 1600, cabin: '@Y|@Y', restrictionList: [] },
      { adultPrice: 5200, cabin: '@C|@C', restrictionList: [] },
    ],
  }
  const quote = extractCtripQuote(combo)
  assert.equal(quote.fares[0]?.cabin, 'Y')
  assert.equal(quote.fares[1]?.cabin, 'C')
  assert.equal(quote.economyLowestAdult, 1600)
})

test('a mixed-cabin pairing is not an economy fare', () => {
  const quote = extractCtripQuote({
    flightSegments: [
      { flightList: [{ flightNo: 'HO1039' }] },
      { flightList: [{ flightNo: 'CA4537' }] },
    ],
    priceList: [{ adultPrice: 2400, cabin: '@Y|@C', restrictionList: [] }],
  })
  assert.equal(quote.fares[0]?.cabin, 'Y|C')
  assert.equal(quote.economyLowestAdult, null)
  assert.equal(quote.overallLowestAdult, 2400)
})
