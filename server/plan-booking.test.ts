import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { derive } from '../src/frames.ts'
import {
  buildPlanOrderConfirmPrompt,
  buildRecommendBookPrompt,
  buildRecommendBookRetryPrompt,
  buildRecommendationRetryPrompt,
  recognizeOperatorAction,
} from '../src/operator-actions.ts'
import type { PlanBooking, RecommendationPlan } from '../src/frames.ts'
import { buildOrderPrompt, type PassengerDraft } from '../src/booking.ts'
import { PlanBookingFlow } from '../src/components/PlanBookingFlow.tsx'
import { FlightRecommendationsView } from '../src/components/FlightRecommendations.tsx'
import type { PromptContent } from '../src/api.ts'

function promptWithToolResult(content: string, id = 'p1'): PromptContent {
  return {
    id,
    prompt: 'book',
    status: 'completed',
    created_at: '2026-07-27 00:00:00',
    completed_at: '2026-07-27 00:01:00',
    attachments: [],
    frames: [
      { seq: 1, data: { type: 'user', message: { content: [{ type: 'tool_result', content }] } } },
    ],
  }
}

function bookingGroup(overrides: Record<string, unknown> = {}) {
  return {
    ticketGroupId: 'tg-1',
    option: 1,
    passengerGroupId: 'economy',
    journeyIndexes: [0],
    fareSource: 'oneway',
    cabin: '经济 Y舱',
    exactPassengerCount: { adult: 1, child: 0, infant: 0 },
    verifiedPrice: { amount: 1000, currency: 'CNY' },
    previousPrice: { amount: 1000, currency: 'CNY' },
    changedFields: [],
    verifiedAt: '2026-07-27T08:00:00.000Z',
    validity: { status: 'verified', validUntil: '2026-07-27T08:05:00.000Z' },
    bookable: true,
    ...overrides,
  }
}

function bookingEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'flight-plan-booking/v1',
    resultType: 'flight.plan-booking',
    ok: true,
    status: 'ready',
    sessionDir: '/code/flight-sessions/2026-07-27/x',
    planId: 'plan:abc',
    bookable: true,
    changed: false,
    changedFields: [],
    verifiedAt: '2026-07-27T08:00:00.000Z',
    validity: { status: 'verified', validUntil: '2026-07-27T08:05:00.000Z' },
    verifiedFareTotal: { amount: 1000, currency: 'CNY' },
    previousFareTotal: { amount: 1000, currency: 'CNY' },
    orderCount: 1,
    splitOrder: false,
    ticketGroups: [bookingGroup()],
    capabilities: { canCreateOrders: true, canRetryVerification: true, canRequote: true },
    next: '确认后逐票组 order-create。',
    ...overrides,
  }
}

function changedTwoGroupEnvelope() {
  return bookingEnvelope({
    status: 'changed',
    changed: true,
    changedFields: ['price'],
    verifiedFareTotal: { amount: 2260, currency: 'CNY' },
    previousFareTotal: { amount: 2200, currency: 'CNY' },
    orderCount: 2,
    splitOrder: true,
    ticketGroups: [
      bookingGroup({
        ticketGroupId: 'tg-out',
        option: 3,
        verifiedPrice: { amount: 1060, currency: 'CNY' },
        previousPrice: { amount: 1000, currency: 'CNY' },
        changedFields: ['price'],
      }),
      bookingGroup({
        ticketGroupId: 'tg-back',
        option: 4,
        journeyIndexes: [1],
        verifiedPrice: { amount: 1200, currency: 'CNY' },
        previousPrice: { amount: 1200, currency: 'CNY' },
      }),
    ],
  })
}

function failedEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'flight-plan-booking/v1',
    resultType: 'flight.plan-booking',
    ok: false,
    status: 'failed',
    sessionDir: '/code/flight-sessions/2026-07-27/x',
    planId: 'plan:abc',
    bookable: false,
    errorType: 'expired_search',
    message: '搜索已过期',
    ticketGroups: [{ ticketGroupId: 'tg-1', verified: false }],
    capabilities: { canCreateOrders: false, canRetryVerification: false, canRequote: true },
    next: '重新 recommend。',
    ...overrides,
  }
}

function bookablePlan(): RecommendationPlan {
  return {
    planId: 'plan:abc',
    label: '推荐方案 1',
    windows: [{ journeyIndex: 0, window: '09:00-12:00' }, { journeyIndex: 1, window: '18:00-21:00' }],
    journeys: [
      {
        journeyId: 'out', role: 'outbound', origin: 'SHA', destination: 'SIN', duration: '5h', transferCount: 0,
        segments: [{
          flightNo: 'MU567', departure: 'SHA', departureName: '上海虹桥', departureDate: '2026-08-02', departureTime: '09:00',
          arrival: 'SIN', arrivalName: '新加坡', arrivalDate: '2026-08-02', arrivalTime: '14:00',
        }],
      },
      {
        journeyId: 'back', role: 'inbound', origin: 'SIN', destination: 'SHA', duration: '5h', transferCount: 0,
        segments: [{
          flightNo: 'MU568', departure: 'SIN', departureName: '新加坡', departureDate: '2026-08-09', departureTime: '18:00',
          arrival: 'SHA', arrivalName: '上海虹桥', arrivalDate: '2026-08-09', arrivalTime: '23:00',
        }],
      },
    ],
    passengerGroups: [{ passengerGroupId: 'economy', cabinClass: 'economy', passengers: { adult: 1, child: 0, infant: 0 } }],
    ticketGroups: [
      {
        ticketGroupId: 'tg-out', passengerGroupId: 'economy', journeyIndexes: [0], fareSource: 'oneway',
        cabin: '经济 Y舱', exactPassengerCount: { adult: 1, child: 0, infant: 0 },
        verifiedPrice: { amount: 1000, currency: 'CNY' }, verifiedAt: '2099-07-16T05:00:00.000Z',
        validity: { status: 'verified', validUntil: '2099-07-16T05:10:00.000Z' },
      },
      {
        ticketGroupId: 'tg-back', passengerGroupId: 'economy', journeyIndexes: [1], fareSource: 'oneway',
        cabin: '经济 Y舱', exactPassengerCount: { adult: 1, child: 0, infant: 0 },
        verifiedPrice: { amount: 1200, currency: 'CNY' }, verifiedAt: '2099-07-16T05:00:00.000Z',
        validity: { status: 'verified', validUntil: '2099-07-16T05:10:00.000Z' },
      },
    ],
    verifiedFareTotal: { amount: 2200, currency: 'CNY' },
    customerQuoteTotal: { amount: 2200, currency: 'CNY' },
    verifiedAt: '2099-07-16T05:00:00.000Z',
    validity: { status: 'verified', validUntil: '2099-07-16T05:10:00.000Z' },
    copyText: 'MU567/MU568 客户报价总价 CNY 2200',
    capabilities: { canCopy: true, canReverify: false, canBook: true },
  }
}

function recommendationsEnvelope() {
  const plan = bookablePlan()
  return {
    schemaVersion: 'flight-recommendations/v1',
    resultType: 'flight.recommendations',
    status: 'success',
    coverageStatus: 'complete',
    budgetStatus: 'within_budget',
    capabilities: { canRetry: false, canReverify: false, canCopy: true },
    plans: [plan],
  }
}

// ── derive: contract routing ─────────────────────────────────────────────

test('a ready plan-booking envelope becomes view.planBooking and one durable bubble', () => {
  const view = derive([promptWithToolResult(JSON.stringify(bookingEnvelope()))])
  assert.ok(view.planBooking)
  assert.equal(view.planBooking.ok, true)
  assert.equal(view.planBooking.status, 'ready')
  assert.equal(view.planBooking.planId, 'plan:abc')
  assert.equal(view.planBooking.ticketGroups[0]!.option, 1)
  assert.equal(view.chat.filter((b) => b.planBooking).length, 1)
})

test('a changed multi-group envelope keeps per-group diffs and split-order facts', () => {
  const view = derive([promptWithToolResult(JSON.stringify(changedTwoGroupEnvelope()))])
  const booking = view.planBooking!
  assert.equal(booking.status, 'changed')
  assert.deepEqual(booking.changedFields, ['price'])
  assert.equal(booking.splitOrder, true)
  assert.deepEqual(booking.ticketGroups.map((group) => group.option), [3, 4])
  assert.equal(booking.ticketGroups[0]!.previousPrice.amount, 1000)
  assert.equal(booking.ticketGroups[0]!.verifiedPrice.amount, 1060)
})

test('a failed envelope still parses behind the Bash non-zero-exit prefix', () => {
  // The skill prints the failure envelope and exits 2; Claude Code prefixes the
  // result with "Exit code 2". The stale-page signal must survive that transport.
  const framed: PromptContent = {
    ...promptWithToolResult(''),
    frames: [
      { seq: 0, data: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: {} }] } } },
      { seq: 1, data: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-bash', content: `Exit code 2\n${JSON.stringify(failedEnvelope())}` }] } } },
    ],
  }
  const view = derive([framed])
  assert.ok(view.planBooking, 'the failed envelope must be recognized')
  assert.equal(view.planBooking.ok, false)
  assert.equal(view.planBooking.errorType, 'expired_search')
  assert.equal(view.chat.filter((b) => b.planBooking).length, 1)
})

test('a failed envelope parses as the authoritative not-sellable signal', () => {
  const view = derive([promptWithToolResult(JSON.stringify(failedEnvelope({ invalidatesRecommendationPage: true })))])
  const booking = view.planBooking!
  assert.equal(booking.ok, false)
  assert.equal(booking.status, 'failed')
  assert.equal(booking.errorType, 'expired_search')
  assert.equal(booking.message, '搜索已过期')
  assert.equal(booking.invalidatesRecommendationPage, true, 'the skill verdict rides through verbatim')
  assert.equal(booking.capabilities.canCreateOrders, false)
  assert.equal(booking.capabilities.canRequote, true)

  const planLocal = derive([promptWithToolResult(JSON.stringify(failedEnvelope()))]).planBooking!
  assert.equal(planLocal.invalidatesRecommendationPage, false, 'absent verdict defaults to plan-local')
})

test('contract violations fail closed to an invalid plan-booking record', () => {
  const violations: Array<Record<string, unknown>> = [
    // group sum does not match the envelope total
    bookingEnvelope({ verifiedFareTotal: { amount: 1200, currency: 'CNY' } }),
    // splitOrder inconsistent with orderCount
    bookingEnvelope({ splitOrder: true }),
    // envelope diff is not the union of group diffs
    bookingEnvelope({ status: 'changed', changed: true, changedFields: ['price'] }),
    // duplicate option numbers
    changedTwoGroupEnvelope().ticketGroups
      ? (() => { const e = changedTwoGroupEnvelope(); (e.ticketGroups as Array<Record<string, unknown>>)[1]!.option = 3; return e })()
      : {},
    // ok and status disagree
    bookingEnvelope({ ok: false }),
    // a success envelope may not carry an unbookable group
    bookingEnvelope({ ticketGroups: [bookingGroup({ bookable: false })] }),
    // currencies must agree
    bookingEnvelope({ previousFareTotal: { amount: 1000, currency: 'USD' } }),
  ]
  for (const [index, payload] of violations.entries()) {
    const view = derive([promptWithToolResult(JSON.stringify(payload))])
    assert.ok(view.planBooking, `violation ${index} must still surface a record`)
    assert.equal(view.planBooking.ok, false, `violation ${index} must fail closed`)
    assert.equal(view.planBooking.errorType, 'invalid_plan_booking_contract', `violation ${index}`)
    assert.equal(view.planBooking.capabilities.canCreateOrders, false, `violation ${index}`)
  }
})

test('two plan-booking results for different plans in one turn fail closed', () => {
  const prompt = promptWithToolResult(JSON.stringify(bookingEnvelope()))
  prompt.frames.push({
    seq: 2,
    data: {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: JSON.stringify(bookingEnvelope({ planId: 'plan:other' })) }] },
    },
  })
  const view = derive([prompt])
  assert.equal(view.planBooking!.ok, false)
  assert.equal(view.planBooking!.errorType, 'invalid_plan_booking_contract')
})

test('a rerun for the same plan in one turn is a refresh: last result wins', () => {
  const prompt = promptWithToolResult(JSON.stringify(bookingEnvelope()))
  prompt.frames.push({
    seq: 2,
    data: {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          content: JSON.stringify(bookingEnvelope({
            status: 'changed',
            changed: true,
            changedFields: ['price'],
            verifiedFareTotal: { amount: 1060, currency: 'CNY' },
            ticketGroups: [bookingGroup({
              verifiedPrice: { amount: 1060, currency: 'CNY' },
              changedFields: ['price'],
            })],
          })),
        }],
      },
    },
  })
  const view = derive([prompt])
  assert.equal(view.planBooking!.status, 'changed')
  assert.equal(view.planBooking!.verifiedFareTotal!.amount, 1060)
  assert.equal(view.chat.filter((b) => b.planBooking).length, 1)
})

test('a plan-booking turn does not erase the recommendation table', () => {
  const view = derive([
    promptWithToolResult(JSON.stringify(recommendationsEnvelope()), 'p1'),
    promptWithToolResult(JSON.stringify(bookingEnvelope()), 'p2'),
  ])
  assert.ok(view.recommendations)
  assert.equal(view.recommendations.plans.length, 1)
  assert.equal(view.recommendations.plans[0]!.capabilities.canBook, true)
  assert.ok(view.planBooking)
  assert.equal(view.chat.filter((b) => b.recommendations).length, 1)
  assert.equal(view.chat.filter((b) => b.planBooking).length, 1)
})

// ── booking helpers ──────────────────────────────────────────────────────

test('the booking prompt asks for the minimum, hands judging to order-prepare, and bans tables', () => {
  const prompt = buildRecommendBookPrompt(bookablePlan())
  assert.match(prompt, /^我要预订推荐方案 1（SHA→SIN、SIN→SHA MU567\/MU568，总价 ¥2,200）。planId: plan:abc。/)
  assert.match(prompt, /姓名\+身份证号/)
  assert.match(prompt, /手机号\+邮箱/)
  assert.match(prompt, /不要表格、不要长清单/)
  assert.match(prompt, /任意格式/)
  assert.match(prompt, /order-prepare 判定是否齐全/)
  assert.match(prompt, /与验价结果一起给我核对/)
  assert.match(prompt, /不要停下等我确认/)
  assert.match(prompt, /重新验价（recommend-book）/)
  assert.match(prompt, /未经我明确确认不要创建订单/)
  assert.doesNotMatch(prompt, /该票价另要求/)

  // Per-fare API requirements fold into the same one-pass checklist.
  const demanding = bookablePlan()
  demanding.ticketGroups[0]!.requiredPassengerInfos = ['travelDocumentExpireDate', 'travelDocumentIssuedPlace']
  demanding.ticketGroups[1]!.requiredPassengerInfos = ['travelDocumentExpireDate']
  assert.match(
    buildRecommendBookPrompt(demanding),
    /该票价另要求提供：travelDocumentExpireDate、travelDocumentIssuedPlace。/,
  )

  assert.match(buildRecommendBookRetryPrompt('plan:abc'), /recommend-book，planId: plan:abc/)
})

test('per-fare required passenger fields pass through both envelopes and fail closed when malformed', () => {
  const rec = recommendationsEnvelope()
  ;(rec.plans[0]!.ticketGroups[0] as unknown as Record<string, unknown>).requiredPassengerInfos = ['travelDocument', 'nationality']
  const view = derive([promptWithToolResult(JSON.stringify(rec))])
  assert.deepEqual(view.recommendations!.plans[0]!.ticketGroups[0]!.requiredPassengerInfos, ['travelDocument', 'nationality'])

  const badRec = recommendationsEnvelope()
  ;(badRec.plans[0]!.ticketGroups[0] as unknown as Record<string, unknown>).requiredPassengerInfos = [42]
  assert.equal(derive([promptWithToolResult(JSON.stringify(badRec))]).recommendations!.status, 'fatal_error')

  const booking = derive([promptWithToolResult(JSON.stringify(bookingEnvelope({
    ticketGroups: [bookingGroup({ requiredPassengerInfos: ['travelDocumentExpireDate'] })],
  })))]).planBooking!
  assert.deepEqual(booking.ticketGroups[0]!.requiredPassengerInfos, ['travelDocumentExpireDate'])

  const badBooking = derive([promptWithToolResult(JSON.stringify(bookingEnvelope({
    ticketGroups: [bookingGroup({ requiredPassengerInfos: 'travelDocument' })],
  })))]).planBooking!
  assert.equal(badBooking.errorType, 'invalid_plan_booking_contract')
})

function draft(name: string): PassengerDraft {
  return {
    paxType: 'adult', docType: 'idcard', nameCn: name, surnameEn: '', givenNamesEn: '',
    birthday: '1990-01-01', gender: 'M', nationality: '中国', docNo: '110101199001011234',
    passportExpiry: '', phone: '13800138000', email: '',
  }
}

test('the order-confirm prompt acknowledges split and change but carries no passenger data', () => {
  const booking = derive([promptWithToolResult(JSON.stringify(changedTwoGroupEnvelope()))]).planBooking as PlanBooking
  const prompt = buildPlanOrderConfirmPrompt(booking)
  assert.match(prompt, /^我已确认创建订单：planId: plan:abc，总额 ¥2,260，共 2 张订单。/)
  assert.match(prompt, /分票组拆单出票我已知悉/)
  assert.match(prompt, /价格的变化我已确认/)
  assert.match(prompt, /对话中已收集的乘机人信息/)
  assert.match(prompt, /--confirm/)
  assert.match(prompt, /不要自动支付/)
  assert.doesNotMatch(prompt, /orderKey/i)
  assert.doesNotMatch(prompt, /证件号码|出生日期/)
})

test('button-built protocol prompts render as action chips, typed text does not', () => {
  assert.equal(
    recognizeOperatorAction(buildRecommendBookPrompt(bookablePlan())),
    '预订推荐方案 1 · ¥2,200 · 先收集乘机人再验价',
  )
  assert.equal(recognizeOperatorAction(buildRecommendBookRetryPrompt('plan:abc')), '重试下单前验价')
  const booking = derive([promptWithToolResult(JSON.stringify(changedTwoGroupEnvelope()))]).planBooking as PlanBooking
  assert.equal(
    recognizeOperatorAction(buildPlanOrderConfirmPrompt(booking)),
    '确认创建订单 · 总额 ¥2,260 · 分 2 单',
  )
  const singleBooking = derive([promptWithToolResult(JSON.stringify(bookingEnvelope()))]).planBooking as PlanBooking
  assert.equal(
    recognizeOperatorAction(buildPlanOrderConfirmPrompt(singleBooking)),
    '确认创建订单 · 总额 ¥1,000',
  )
  const fare = { currency: 'CNY', total: 660, baseFare: 600, tax: 60, publishTotal: 660, journeys: [], passengers: [], baggage: [], fareRules: null, minAvailability: null, canBook: true } as never
  assert.equal(recognizeOperatorAction(buildOrderPrompt([draft('唐一')], fare)), '确认创建订单')
  assert.equal(recognizeOperatorAction(buildRecommendationRetryPrompt('plan:abc')), '重新验价该方案')
  assert.equal(recognizeOperatorAction(buildRecommendationRetryPrompt()), '重试推荐')
  assert.equal(recognizeOperatorAction('查明天北京飞上海的机票，1 人，直飞'), undefined)
  assert.equal(recognizeOperatorAction('再来一些方案。'), undefined)

  const actionPrompt = promptWithToolResult(JSON.stringify(bookingEnvelope()))
  actionPrompt.prompt = buildRecommendBookPrompt(bookablePlan())
  const view = derive([actionPrompt])
  assert.equal(view.chat[0]!.action, '预订推荐方案 1 · ¥2,200 · 先收集乘机人再验价')
  const typedPrompt = promptWithToolResult(JSON.stringify(bookingEnvelope()))
  assert.equal(derive([typedPrompt]).chat[0]!.action, undefined)
})

// ── render ───────────────────────────────────────────────────────────────

test('every recommendation table offers a compact 预订 action unless withheld or stale', () => {
  const result = { ...recommendationsEnvelope() } as never
  const withEntry = renderToStaticMarkup(createElement(FlightRecommendationsView, {
    result, busy: false, onAction: () => {}, isLatest: true, onStartBooking: () => {},
  }))
  assert.match(withEntry, /recommend-book-action/)
  assert.match(withEntry, />预订</)

  // Booking is planId-addressed and re-verified — an OLDER page keeps its entry.
  const olderPage = renderToStaticMarkup(createElement(FlightRecommendationsView, {
    result, busy: false, onAction: () => {}, isLatest: false, onStartBooking: () => {},
  }))
  assert.match(olderPage, /recommend-book-action/)

  const withheld = renderToStaticMarkup(createElement(FlightRecommendationsView, {
    result, busy: false, onAction: () => {}, isLatest: true,
  }))
  assert.doesNotMatch(withheld, /recommend-book-action/)

  const stale = renderToStaticMarkup(createElement(FlightRecommendationsView, {
    result, busy: false, onAction: () => {}, isLatest: true, onStartBooking: () => {},
    staleNotice: '该方案已不可售：需要重新给客户报价。',
  }))
  assert.doesNotMatch(stale, /recommend-book-action/)
  assert.match(stale, /该方案已不可售/)
})

function flowProps(overrides: Record<string, unknown> = {}) {
  return {
    flow: { planId: 'plan:abc' },
    plan: bookablePlan(),
    booking: null as PlanBooking | null,
    busy: false,
    onConfirmOrders: () => {},
    onRetryVerify: () => {},
    onRequote: () => {},
    onClose: () => {},
    ...overrides,
  }
}

test('the booking surface materializes only from a matching structured result', () => {
  // Collection is conversational: while no matching envelope exists, render nothing.
  assert.equal(renderToStaticMarkup(createElement(PlanBookingFlow, flowProps())), '')

  const changedBooking = derive([promptWithToolResult(JSON.stringify(changedTwoGroupEnvelope()))]).planBooking
  const confirm = renderToStaticMarkup(createElement(PlanBookingFlow, flowProps({ booking: changedBooking })))
  assert.match(confirm, /确认变化并创建订单/)
  assert.match(confirm, /订单 1\/2/)
  assert.match(confirm, /原报价 ¥2,200/)
  assert.match(confirm, /确认分 2 单创建/)
  assert.match(confirm, /价格较报价有变化/)
  assert.match(confirm, /乘机人信息以你在对话中与 Kitty 确认的为准/)
  assert.match(confirm, /取消预订/)

  const failedBooking = derive([promptWithToolResult(JSON.stringify(failedEnvelope()))]).planBooking
  const failed = renderToStaticMarkup(createElement(PlanBookingFlow, flowProps({ booking: failedBooking })))
  assert.match(failed, /该方案已不可售/)
  assert.match(failed, /重新报价/)
  assert.doesNotMatch(failed, /重试验价/)

  const retryable = derive([promptWithToolResult(JSON.stringify(failedEnvelope({
    errorType: 'transit_advisory_incomplete',
    message: '中转事实不完整',
    capabilities: { canCreateOrders: false, canRetryVerification: true, canRequote: true },
  })))]).planBooking
  const retry = renderToStaticMarkup(createElement(PlanBookingFlow, flowProps({ booking: retryable })))
  assert.match(retry, /下单前验价未通过/)
  assert.match(retry, /重试验价/)

  const mismatched = renderToStaticMarkup(createElement(PlanBookingFlow, flowProps({
    booking: changedBooking ? { ...changedBooking, planId: 'plan:other' } : null,
  })))
  assert.equal(mismatched, '')
})
