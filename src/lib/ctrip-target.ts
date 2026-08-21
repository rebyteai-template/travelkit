import type { CtripQuoteTarget } from '@travelkit/contract'

import type { CompactPrice, RecommendationPlan } from '../frames.ts'

/**
 * Turns a recommended plan into "which flight do we ask Ctrip about", and into the one figure of
 * ours that is comparable with what Ctrip answers.
 *
 * Both halves exist because the two sides count differently. Ctrip's search JSON prices ONE ADULT
 * and EXCLUDES tax; a plan's `verifiedFareTotal` is EVERY passenger and INCLUDES it. Comparing
 * them as they stand is wrong twice over — on a two-adult booking it is wrong by roughly a factor
 * of two, which is larger than the margin the operator is bidding for.
 *
 * Passenger count we can fix here, from the plan's own ticket groups. Tax we cannot: the plan
 * carries no tax-exclusive figure, so the remaining gap has to be labelled rather than computed
 * away (see the UI's 口径 note).
 */

/** What to ask the extension for — or why this plan has no answerable question.
 *
 *  ONE ladder decides "can this plan be compared": the button's visibility, the message shown in
 *  its place, and the request actually sent all read this return value. It used to be three
 *  parallel predicates (this function returning null, `unquotableReason`, and a re-check at the
 *  call site), and they drifted: a plan the reason-function called quotable could still produce
 *  no target, leaving a button that flashed and did nothing.
 *
 *  Refusing with a reason is the point: the alternative is asking about the first leg and
 *  quietly comparing the wrong thing. */
export function quoteTargetFor(
  plan: RecommendationPlan,
): { target: CtripQuoteTarget; url: string } | { reason: string } {
  if (!plan.ctripUrl) return { reason: '此行程没有携程对应链接' }
  const journeys = plan.journeys
  if (!journeys.length) return { reason: '该方案缺少航班信息' }
  // Ctrip's itinerary nodes key on a single flight per direction. A connection has two, and its
  // second leg is invisible on the card the extension would match.
  if (journeys.some((journey) => journey.transferCount > 0 || journey.segments.length !== 1)) {
    return { reason: '中转行程无法在携程按航班比价' }
  }
  if (journeys.length > 2) return { reason: '多程行程暂不支持比价' }

  const leadOf = (index: number) => journeys[index]?.segments[0]

  if (journeys.length === 1) {
    const segment = leadOf(0)
    if (!segment) return { reason: '该方案缺少航班信息' }
    return {
      url: plan.ctripUrl,
      target: {
        flightNo: segment.flightNo,
        opFlightNo: segment.opFlightNo ?? null,
        departureDate: segment.departureDate,
        departureTime: segment.departureTime,
      },
    }
  }

  const outboundIndex = journeys.findIndex((journey) => journey.role === 'outbound')
  const inboundIndex = journeys.findIndex((journey) => journey.role === 'inbound')
  if (inboundIndex < 0) return { reason: '缺口程暂不支持比价' }
  if (outboundIndex < 0) return { reason: '缺少明确的去程，暂不支持比价' }
  const outbound = leadOf(outboundIndex)
  const inbound = leadOf(inboundIndex)
  if (!outbound || !inbound) return { reason: '该方案缺少航班信息' }
  // The RETURN flight is what gets looked up: Ctrip only prices a round trip once an outbound
  // is chosen, and the resulting node carries the combination total for exactly this pair.
  return {
    url: plan.ctripUrl,
    target: {
      flightNo: inbound.flightNo,
      opFlightNo: inbound.opFlightNo ?? null,
      departureDate: inbound.departureDate,
      departureTime: inbound.departureTime,
      outbound: {
        flightNo: outbound.flightNo,
        opFlightNo: outbound.opFlightNo ?? null,
        departureTime: outbound.departureTime,
      },
    },
  }
}

/** Shared shape of both adult-unit figures: read one amount per ticket group off an adults-only
 *  passenger group, sum, divide by the adult count. A `read` returning null for any ticket voids
 *  the whole figure — a partial sum would silently compare a fraction of the itinerary. */
function adultUnit(
  plan: RecommendationPlan,
  read: (ticket: RecommendationPlan['ticketGroups'][number]) => number | null | undefined,
): CompactPrice | null {
  const group = plan.passengerGroups.find(
    (candidate) =>
      candidate.passengers.adult > 0 && candidate.passengers.child === 0 && candidate.passengers.infant === 0,
  )
  if (!group) return null

  const tickets = plan.ticketGroups.filter((ticket) => ticket.passengerGroupId === group.passengerGroupId)
  if (!tickets.length) return null

  const currency = tickets[0]!.verifiedPrice.currency
  // Mixed currencies cannot be summed, and guessing a conversion here would invent precision.
  if (tickets.some((ticket) => ticket.verifiedPrice.currency !== currency)) return null

  let total = 0
  for (const ticket of tickets) {
    const amount = read(ticket)
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null
    total += amount
  }
  const adults = group.passengers.adult
  if (total <= 0 || adults <= 0) return null

  return { amount: Math.round((total / adults) * 100) / 100, currency }
}

/** Our price for ONE adult, tax included — what the traveller actually pays us.
 *
 *  Read off an adults-only passenger group so no child or infant fare is averaged in. A group's
 *  ticket groups are summed first: a round trip may be issued as one covering both journeys or as
 *  two covering one each, and only the sum is the traveller's price either way. Null when the plan
 *  has no adults-only group (e.g. a single-child booking) — a figure we cannot derive honestly is
 *  better absent than approximated. */
export function adultUnitPrice(plan: RecommendationPlan): CompactPrice | null {
  return adultUnit(plan, (ticket) => ticket.verifiedPrice.amount)
}

/** Our PRE-TAX fare for ONE adult — the true like-for-like counterpart to Ctrip's `adultPrice`
 *  (Ctrip's list fare excludes airport fee and fuel surcharge). Needs every ticket group to carry
 *  the verify API's fare/tax split (`verifiedPrice.fareTotal`); older skill output without it
 *  yields null, and the cell falls back to showing both bases side by side without subtracting. */
export function adultPreTaxUnitPrice(plan: RecommendationPlan): CompactPrice | null {
  return adultUnit(plan, (ticket) => ticket.verifiedPrice.fareTotal)
}

/** Why this plan cannot be compared, for the cell to show instead of a dead button. Derived from
 *  `quoteTargetFor` so the button can never disagree with the request it would send. */
export function unquotableReason(plan: RecommendationPlan): string | null {
  const result = quoteTargetFor(plan)
  return 'reason' in result ? result.reason : null
}
