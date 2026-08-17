/**
 * Turns ONE Ctrip itinerary node — filtered out of the page's own search JSON — into the numbers
 * the comparison actually needs. This is the production reader; the generic path/value scan in the
 * probe was only ever archaeology.
 *
 * The schema, confirmed against a live CA1359 response (test/fixtures/ctrip-node-CA1359.json):
 *
 *   flightSegments[].flightList[]   the legs — flightNo, departureDateTime, airports
 *   priceList[]                     ONE ENTRY PER SELLABLE FARE, not per flight:
 *     adultPrice / childPrice / infantPrice   per passenger type, and PRE-TAX
 *     cabin        "Y" economy · "C" business — the PHYSICAL cabin
 *     seatClass    booking sub-class ("K","L",…) with discountRate
 *     restrictionList[]  e.g. {MultiPerson "4-5人"} — a fare not everyone can buy
 *
 * Two traps this encodes, both learned from the real node:
 *
 *  1. NO TAX. `adultPrice` equals the list-page fare (¥670) exactly; `freeOilFeeAndTax` is a
 *     boolean flag, not an amount, and the airport-fee/fuel surcharge appears only on the booking
 *     page. So this figure is PRE-TAX, single-passenger — it is NOT like-for-like with a
 *     TravelKit total that includes tax. The caller must reconcile the basis, not assume it away.
 *
 *  2. The cheapest `adultPrice` on the flight can be a RESTRICTED BUSINESS fare. On CA1359 a
 *     ¥1580 entry undercuts most economy fares — it is a cabin-C, 4-5-passengers-only deal. Taking
 *     min(adultPrice) blindly repeats the very "cheapest row" bug we left the DOM to escape, one
 *     level down. The economy figure filters to cabin Y with no restrictions.
 */

import { normalizeFlightNo } from './ctrip-match.ts'

/** One sellable fare on a flight. */
export interface CtripFare {
  /** Physical cabin: "Y" economy, "C" business, "F" first — Ctrip's own coding. */
  cabin: string
  /** Booking sub-class, e.g. "K". */
  seatClass: string | null
  /** Set for named products like "超级经济舱". */
  specialClassName?: string
  /** PRE-TAX, single adult. */
  adultPrice: number | null
  childPrice: number | null
  infantPrice: number | null
  /** 0.2 = 2折; 1 = full fare. */
  discountRate: number | null
  /** True when the fare carries a restrictionList (multi-passenger-only, etc.) and so is not
   *  a fare an arbitrary booking can use. */
  restricted: boolean
}

export interface CtripQuoteExtract {
  /** Every flight number across the itinerary's legs, normalized. One for a direct flight, two+
   *  for a round-trip combination node or a transfer. */
  flightNos: string[]
  legCount: number
  departureDateTime: string | null
  arrivalDateTime: string | null
  fares: CtripFare[]
  /** Lowest unrestricted economy (cabin Y) adult fare — the comparison figure for an economy
   *  plan. PRE-TAX, single adult. Null when the flight sells no unrestricted economy fare. */
  economyLowestAdult: number | null
  /** Lowest unrestricted adult fare in ANY cabin, for reference/diagnostics. */
  overallLowestAdult: number | null
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null

/** Which cabin this fare is for.
 *
 *  A one-way node states it as a top-level `cabin` ("Y"/"C"). Round-trip combination nodes have
 *  been measured writing it two OTHER ways, and both have to be read for one-way and round-trip
 *  to answer the same question:
 *   - one cabin per leg, @-prefixed and |-joined — "@Y|@Y" (SHA-CTU pairing node);
 *   - no `cabin` field at all, the fact tagged in `matchedKey` as `GRADE_Y` / `GRADE_C`
 *     (CA1359+CA9675, ten fares, none with a cabin field). */
function cabinOf(entry: Record<string, unknown>): string {
  if (typeof entry.cabin === 'string' && entry.cabin) return normalizeCabin(entry.cabin)
  const keys = Array.isArray(entry.matchedKey) ? entry.matchedKey : []
  for (const key of keys) {
    const grade = /^GRADE_([A-Z])$/.exec(String(key))
    if (grade) return grade[1]!
  }
  return ''
}

/** "Y" stays "Y"; "@Y|@Y" — legs all in one cabin — collapses to that cabin so the economy
 *  filter sees it. A MIXED pairing ("@Y|@C") keeps the joined form "Y|C" on purpose: it then
 *  matches no single-cabin filter, which is right, because a fare with a business leg is not an
 *  economy fare however its total compares. */
function normalizeCabin(raw: string): string {
  const parts = raw.split('|').map((part) => part.replace(/^@/, '').trim()).filter(Boolean)
  if (!parts.length) return ''
  return parts.every((part) => part === parts[0]) ? parts[0]! : parts.join('|')
}

function fareOf(entry: Record<string, unknown>): CtripFare {
  const seat = ((entry.priceUnitList as Array<Record<string, unknown>> | undefined)?.[0]
    ?.flightSeatList as Array<Record<string, unknown>> | undefined)?.[0]
  const restrictions = entry.restrictionList
  return {
    cabin: cabinOf(entry),
    seatClass: seat && typeof seat.seatClass === 'string' ? seat.seatClass : null,
    ...(seat && typeof seat.specialClassName === 'string' ? { specialClassName: seat.specialClassName } : {}),
    adultPrice: num(entry.adultPrice),
    childPrice: num(entry.childPrice),
    infantPrice: num(entry.infantPrice),
    discountRate: seat && typeof seat.discountRate === 'number' ? seat.discountRate : null,
    restricted: Array.isArray(restrictions) && restrictions.length > 0,
  }
}

/** True when `node` looks like a Ctrip itinerary: it has a priceList and at least one flight
 *  number. Used both here and by the probe to pick the RIGHT array out of a response that also
 *  carries flight-number-only summary arrays (which is what made a round-trip return match a
 *  flight but show no price). */
export function isItineraryNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  const record = node as Record<string, unknown>
  return Array.isArray(record.priceList) && Array.isArray(record.flightSegments)
}

export function extractCtripQuote(node: unknown): CtripQuoteExtract {
  const record = (node && typeof node === 'object' ? node : {}) as Record<string, unknown>
  const segments = Array.isArray(record.flightSegments) ? record.flightSegments : []
  const legs: Array<Record<string, unknown>> = []
  for (const segment of segments) {
    const list = (segment as Record<string, unknown>)?.flightList
    if (Array.isArray(list)) legs.push(...(list as Array<Record<string, unknown>>))
  }

  const flightNos = [...new Set(legs.map((leg) => normalizeFlightNo(String(leg.flightNo ?? ''))).filter((no) => no.length > 0))]
  const first = legs[0]
  const last = legs[legs.length - 1]

  const priceList = Array.isArray(record.priceList) ? (record.priceList as Array<Record<string, unknown>>) : []
  const fares = priceList.map(fareOf)

  const usable = (fare: CtripFare): boolean => !fare.restricted && fare.adultPrice !== null
  const min = (list: CtripFare[]): number | null =>
    list.length ? Math.min(...list.map((fare) => fare.adultPrice as number)) : null

  return {
    flightNos,
    legCount: legs.length,
    departureDateTime: first && typeof first.departureDateTime === 'string' ? first.departureDateTime : null,
    arrivalDateTime: last && typeof last.arrivalDateTime === 'string' ? last.arrivalDateTime : null,
    fares,
    economyLowestAdult: min(fares.filter((fare) => usable(fare) && fare.cabin === 'Y')),
    overallLowestAdult: min(fares.filter(usable)),
  }
}
