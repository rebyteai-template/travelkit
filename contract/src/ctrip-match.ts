/**
 * Picks the flight that is OURS out of what Ctrip returned.
 *
 * A search result is a whole route+date — 10 to 200 itineraries — and `ctripUrl` is built from
 * route and date alone, so every plan of the same route variant opens the SAME url. Neither the
 * url nor the page identifies a plan; the flight number is the only thing that does. Until that
 * was the key the comparison figure was the page's cheapest row: on a real PEK-CAN capture ¥610,
 * a TRANSFER itinerary, while the direct flight the plan actually quotes (CA1321) is ¥780. The
 * operator prices against this number, so a wrong row reverses the "are we cheaper" call.
 *
 * Two matchers, one rule each:
 *  - `matchQuoteNode` — the PRODUCTION path. Pins a node of Ctrip's own search JSON by flight
 *    number; on a round trip by BOTH legs' numbers.
 *  - `matchCtripFlight` — the DOM-capture counterpart, kept for the /ctrip-probe bench, which
 *    validates page reads (and their failure reasons) against real captures.
 *
 * Departure time only ever verifies a match, never makes one. Airport NAMES cannot cross-check:
 * our dictionary is city-oriented ("广州") while Ctrip prints the airport ("白云国际机场T3").
 *
 * Everything unresolved returns a reason and no price. A missing figure costs the operator a
 * lookup in a Ctrip tab; a wrong one costs a booking.
 */

import type { CtripCapture, CtripFlightRow } from './index.ts'

/** The little of a plan segment this needs. Deliberately structural — the contract package stays
 *  dependency-free, so it must not reach for the SPA's plan types. */
export interface PlanSegmentRef {
  flightNo: string
  /** Operating carrier's number when the plan is a codeshare. Ctrip lists the operating flight,
   *  we may hold the marketing one, and neither side is consistently the other. */
  opFlightNo?: string | null
  /** "HH:MM", as the plan states it. */
  departureTime: string
}

export interface PlanJourneyRef {
  transferCount: number
  segments: PlanSegmentRef[]
}

export type CtripMatchFailure =
  | 'blocked'
  | 'degraded-parse'
  | 'round-trip-page'
  | 'empty-capture'
  | 'transfer-plan'
  | 'ambiguous-flight-no'
  | 'time-mismatch'
  | 'flight-not-listed'

export type CtripMatch =
  | {
      status: 'matched'
      matchedBy: 'flightNo' | 'opFlightNo'
      flightNo: string
      row: CtripFlightRow
      /** Ctrip's listed fare: ONE passenger, PRE-TAX, cheapest sellable bucket on that flight.
       *  Not comparable to a plan total without saying all three out loud. */
      amount: number
    }
  | { status: 'unmatched'; reason: CtripMatchFailure; detail?: string }

/** Our side writes CA0841, Ctrip writes CA841. Same rule as the skill's `displayFlightNo`. */
export function normalizeFlightNo(flightNo: string | null | undefined): string {
  const raw = String(flightNo ?? '').trim()
  const match = /^([A-Za-z0-9]{2})0*(\d+)([A-Za-z]?)$/.exec(raw)
  return (match ? `${match[1]}${match[2]}${match[3]}` : raw).toUpperCase()
}

/** What a flight-number token looks like in Ctrip's text and JSON (airline code + 3-4 digits).
 *  One source: the probe, the card locator and the DOM extractor all build their regexes from
 *  this, so "what counts as a flight number" cannot drift between them. Compose it yourself —
 *  `new RegExp(FLIGHT_NO_PATTERN)` anchored or word-bounded as the site requires — rather than
 *  sharing a stateful `/g` RegExp instance across call sites. */
export const FLIGHT_NO_PATTERN = '[A-Z0-9]{2}\\d{3,4}'

/** The numbers that may pin a flight, in trial order: marketing first, operating fallback.
 *  Shared by both matchers so the priority rule exists once. */
function candidatesOf(
  flightNo: string | null | undefined,
  opFlightNo: string | null | undefined,
): Array<{ no: string; by: 'flightNo' | 'opFlightNo' }> {
  return [
    { no: normalizeFlightNo(flightNo), by: 'flightNo' as const },
    ...(opFlightNo ? [{ no: normalizeFlightNo(opFlightNo), by: 'opFlightNo' as const }] : []),
  ].filter((candidate) => candidate.no.length > 0)
}

/** A `round-` url is Ctrip's "pick the outbound" step. Its prices are round-trip totals for that
 *  outbound plus the CHEAPEST return — a return we did not choose and cannot see. Measured on
 *  BJS-CAN: CA1359 shows ¥1259 there against ¥670 as a one-way, so matching it would overstate
 *  Ctrip by roughly the price of a second ticket. Reaching the real pairing needs a click into a
 *  second step that has no url of its own, so the whole page is refused instead. */
export function isRoundTripCapture(capture: Pick<CtripCapture, 'url'>): boolean {
  try {
    return new URL(capture.url).pathname.includes('/online/list/round-')
  } catch {
    return false
  }
}

/** The slice of a quote target that node-matching needs. Structural for the same reason as
 *  `PlanSegmentRef`: this package must not reach for the SPA's or the extension's types. */
export interface QuoteNodeTarget {
  flightNo: string
  opFlightNo?: string | null
  outbound?: { flightNo?: string; opFlightNo?: string | null } | null
}

/** Which of the target's numbers pins a payload node to OUR itinerary — null when the node is
 *  not it. `nos` is the node's own flight numbers; both sides are normalized before comparing.
 *
 *  The primary numbers name the flight being priced: the only leg one-way, the RETURN on a
 *  round trip. When the target carries an outbound the node must contain one of ITS numbers
 *  too. Without that second pin the round-trip step-1 payload answers first and wrongly: its
 *  nodes are (outbound + that outbound's CHEAPEST return) pairings, so the return number alone
 *  matches whichever pairing happens to share it. Measured on SHA-CTU: HO1039+CA4537 wanted,
 *  CA8541+CA4537 answered — right return, wrong outbound, a price for a trip nobody chose. */
export function matchQuoteNode(
  nos: string[],
  target: QuoteNodeTarget,
): { no: string; by: 'flightNo' | 'opFlightNo' } | null {
  const normalized = nos.map((no) => normalizeFlightNo(no))
  const wanted = candidatesOf(target.flightNo, target.opFlightNo)
  const hit = wanted.find((candidate) => normalized.includes(candidate.no))
  if (!hit) return null

  const outboundNos = [target.outbound?.flightNo, target.outbound?.opFlightNo]
    .filter((no): no is string => typeof no === 'string' && no.trim().length > 0)
    .map((no) => normalizeFlightNo(no))
  if (outboundNos.length && !outboundNos.some((no) => normalized.includes(no))) return null
  return hit
}

export function matchCtripFlight(journey: PlanJourneyRef, capture: CtripCapture): CtripMatch {
  if (capture.blocked) return { status: 'unmatched', reason: 'blocked' }
  if (capture.strategy === 'fallback-scan') return { status: 'unmatched', reason: 'degraded-parse' }
  if (isRoundTripCapture(capture)) return { status: 'unmatched', reason: 'round-trip-page' }
  if (!capture.flights.length) return { status: 'unmatched', reason: 'empty-capture' }

  // Ctrip's transfer cards expose only their FIRST leg's number, with the whole itinerary's
  // endpoints and duration around it. There is no way to tell from the page whether the rest of
  // that itinerary is ours, so a multi-segment plan has nothing here it can safely match.
  if (journey.transferCount > 0 || journey.segments.length > 1) {
    return { status: 'unmatched', reason: 'transfer-plan' }
  }

  const segment = journey.segments[0]
  if (!segment) return { status: 'unmatched', reason: 'transfer-plan' }

  const candidates = candidatesOf(segment.flightNo, segment.opFlightNo)

  // A direct plan must never match a transfer card: same flight number on the first leg, entirely
  // different itinerary and price.
  const direct = capture.flights.filter((row) => !row.isTransfer)

  for (const candidate of candidates) {
    const hits = direct.filter((row) => normalizeFlightNo(row.flightNo) === candidate.no)
    if (!hits.length) continue
    if (hits.length > 1) {
      return { status: 'unmatched', reason: 'ambiguous-flight-no', detail: candidate.no }
    }
    const row = hits[0]!
    if (row.depTime !== segment.departureTime) {
      return {
        status: 'unmatched',
        reason: 'time-mismatch',
        detail: `${candidate.no} 携程 ${row.depTime ?? '—'} / 方案 ${segment.departureTime}`,
      }
    }
    if (!Number.isFinite(row.price) || (row.price as number) <= 0) {
      return { status: 'unmatched', reason: 'flight-not-listed', detail: `${candidate.no} 无价格` }
    }
    return { status: 'matched', matchedBy: candidate.by, flightNo: candidate.no, row, amount: row.price as number }
  }

  return {
    status: 'unmatched',
    reason: 'flight-not-listed',
    detail: candidates.map((candidate) => candidate.no).join(' / '),
  }
}
