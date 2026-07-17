import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  buildRecommendationRetryPrompt,
  FlightRecommendationsView,
  recommendationStatusLabel,
} from '../src/components/FlightRecommendations.tsx'
import type { FlightRecommendations, SearchResult } from '../src/frames.ts'

function resultFixture(): FlightRecommendations {
  return {
    schemaVersion: 'flight-recommendations/v1',
    resultType: 'flight.recommendations',
    status: 'success',
    coverageStatus: 'complete',
    budgetStatus: 'within_budget',
    capabilities: { canRetry: false, canReverify: false, canCopy: true },
    plans: [{
      planId: 'plan-1',
      label: '上午出发',
      windows: [{ journeyIndex: 0, window: '09:00-18:00' }],
      journeys: [{
        journeyId: 'outbound', routeOptionId: 'melbourne', routePriority: 'alternate', role: 'oneway', origin: 'PEK', destination: 'MEL', duration: '11h25m', transferCount: 0,
        segments: [{
          flightNo: 'CA165', departure: 'PEK', departureName: '北京首都', departureDate: '2026-08-14', departureTime: '10:00',
          arrival: 'MEL', arrivalName: '墨尔本', arrivalDate: '2026-08-14', arrivalTime: '23:25',
        }],
      }],
      passengerGroups: [
        { passengerGroupId: 'business', cabinClass: 'business', passengers: { adult: 1, child: 0, infant: 0 } },
        { passengerGroupId: 'economy', cabinClass: 'economy', passengers: { adult: 3, child: 0, infant: 0 } },
      ],
      ticketGroups: [
        {
          ticketGroupId: 'business-ticket', passengerGroupId: 'business', journeyIndexes: [0], fareSource: 'oneway',
          cabin: '商务 Z舱', exactPassengerCount: { adult: 1, child: 0, infant: 0 },
          segmentFacts: [{ journeyIndex: 0, segmentIndex: 0, cabin: '商务 Z舱', baggage: '托运2*32kg' }],
          verifiedPrice: { amount: 12000, currency: 'CNY' }, verifiedAt: '2099-07-16T05:00:00.000Z',
          validity: { status: 'verified', validUntil: '2099-07-16T05:10:00.000Z' },
        },
        {
          ticketGroupId: 'economy-ticket', passengerGroupId: 'economy', journeyIndexes: [0], fareSource: 'oneway',
          cabin: '经济 T舱', exactPassengerCount: { adult: 3, child: 0, infant: 0 },
          segmentFacts: [{ journeyIndex: 0, segmentIndex: 0, cabin: '经济 T舱', baggage: '托运1*23kg' }],
          verifiedPrice: { amount: 9000, currency: 'CNY' }, verifiedAt: '2099-07-16T05:00:00.000Z',
          validity: { status: 'verified', validUntil: '2099-07-16T05:10:00.000Z' },
        },
      ],
      verifiedFareTotal: { amount: 21000, currency: 'CNY' },
      customerQuoteTotal: { amount: 21000, currency: 'CNY' },
      verifiedAt: '2099-07-16T05:00:00.000Z',
      validity: { status: 'verified', validUntil: '2099-07-16T05:10:00.000Z' },
      copyText: 'CA165\n客户报价总价 CNY 21000',
      capabilities: { canCopy: true, canReverify: false, canBook: false },
    }],
  }
}

function searchEvidence(): SearchResult {
  return {
    options: [{
      optionNumber: 1,
      solutionId: 'evidence-only',
      journeyType: '直飞', duration: '11h25m', durationMinutes: 685, cabin: '经济 T舱', hasCheckedBaggage: false,
      price: { amount: 9000, currency: 'CNY' },
      journeys: [{
        origin: 'PEK', destination: 'MEL', departureDate: '2026-08-14', departureTime: '10:00',
        arrivalDate: '2026-08-14', arrivalTime: '23:25', duration: '11h25m', transferCount: 0,
        segments: [{
          flightNo: 'CA165', departure: 'PEK', departureDate: '2026-08-14', departureTime: '10:00',
          arrival: 'MEL', arrivalDate: '2026-08-14', arrivalTime: '23:25', cabin: '经济 T舱',
        }],
      }],
    }],
  }
}

test('recommendation renderer uses one dense comparison table with exact segment facts and collapsed evidence', () => {
  const html = renderToStaticMarkup(createElement(FlightRecommendationsView, {
    result: resultFixture(),
    evidence: [searchEvidence()],
    busy: false,
    onAction: () => {},
  }))

  assert.match(html, /<table class="recommend-table">/)
  for (const heading of ['方案', '航程', '航班号', '日期', '航段', '时间', '飞行时长', '舱位', '行李', '价格', '供应渠道']) {
    assert.match(html, new RegExp(`<th scope="col">${heading}<\\/th>`))
  }
  assert.doesNotMatch(html, /<th scope="col">总价<\/th>/)
  assert.match(html, /recommend-plan-total-label">总价<\/span><strong class="recommend-plan-total-amount mono">¥21,000<\/strong>/)
  assert.equal(html.match(/class="recommend-segment-row/g)?.length, 1)
  assert.equal(html.match(/CA165/g)?.length, 1)
  assert.match(html, /商务 Z舱/)
  assert.match(html, /经济 T舱/)
  assert.match(html, /托运2\*32kg/)
  assert.match(html, /recommend-source-badge is-oneway">单独查询/)
  assert.doesNotMatch(html, /覆盖 单程/)
  assert.doesNotMatch(html, /多程票总价见下方票组/)
  assert.doesNotMatch(html, /<article/)
  assert.doesNotMatch(html, /主选路线|备选路线|PEK → MEL/)
  assert.match(html, /<details class="recommend-evidence">/)
  assert.match(html, /查看中间搜索证据/)
  assert.doesNotMatch(html, /<th>操作<\/th>/)
  assert.doesNotMatch(html, />验价<\/button>/)
  assert.doesNotMatch(html, /实时查询价/)
  assert.match(html, /<ul class="recommend-plan-journeys"><li><span>第1程<\/span><span class="mono">09:00-18:00<\/span><\/li><\/ul>/)
  assert.match(html, /<div class="recommend-plan-title-row"><strong class="recommend-plan-label">上午出发<\/strong><div class="recommend-copy">/)
  assert.match(html, /class="recommend-copy-action"[^>]*><svg[^>]*aria-hidden="true"[^>]*>.*<span>复制<\/span><\/button>/)
  assert.doesNotMatch(html, />Copy<\/button>/)
})

test('each physical segment becomes one standard table row while plan and journey facts print once', () => {
  const result = resultFixture()
  const plan = result.plans[0]!
  const journey = plan.journeys[0]!
  journey.transferCount = 1
  journey.segments[0]!.arrival = 'PVG'
  journey.segments[0]!.arrivalName = '上海浦东'
  journey.segments[0]!.arrivalTime = '12:15'
  journey.segments[0]!.flightTime = '2h15m'
  journey.segments.push({
    flightNo: 'CA177', departure: 'PVG', departureName: '上海浦东', departureDate: '2026-08-14', departureTime: '14:00',
    arrival: 'MEL', arrivalName: '墨尔本', arrivalDate: '2026-08-15', arrivalTime: '06:30',
  })
  for (const ticket of plan.ticketGroups) {
    ticket.segmentFacts!.push({
      journeyIndex: 0,
      segmentIndex: 1,
      cabin: ticket.passengerGroupId === 'business' ? '商务 I舱' : '经济 L舱',
      baggage: ticket.passengerGroupId === 'business' ? '第二段托运2*30kg' : '第二段托运1*20kg',
    })
  }

  const html = renderToStaticMarkup(createElement(FlightRecommendationsView, { result, busy: false, onAction: () => {} }))
  assert.equal(html.match(/class="recommend-segment-row/g)?.length, 2)
  assert.match(html, /<th scope="rowgroup" rowSpan="2" class="recommend-plan-cell">/)
  assert.match(html, /<th scope="rowgroup" rowSpan="2" class="recommend-journey-cell">/)
  assert.doesNotMatch(html, /recommend-total-cell/)
  assert.equal(html.match(/recommend-plan-total-amount/g)?.length, 1)
  assert.equal(html.match(/上午出发/g)?.length, 1)
  assert.equal(html.match(/<th scope="rowgroup" rowSpan="2" class="recommend-journey-cell"><div class="recommend-journey-summary"><strong>单程<\/strong><span> · 中转 1 次<\/span><\/div>/g)?.length, 1)
  assert.equal(html.match(/CA165/g)?.length, 1)
  assert.equal(html.match(/CA177/g)?.length, 1)
  assert.match(html, /商务 Z舱/)
  assert.match(html, /商务 I舱/)
  assert.match(html, /经济 T舱/)
  assert.match(html, /经济 L舱/)
  assert.match(html, /第二段托运2\*30kg/)
  assert.match(html, /第二段托运1\*20kg/)
  assert.match(html, /recommend-duration-cell mono">2h15m/)
  assert.match(html, /recommend-duration-cell mono">未返回/)
})

test('ticket-group totals render as per-person prices while the plan card keeps the whole-order total', () => {
  const result = resultFixture()
  const plan = result.plans[0]!
  const economyTicket = plan.ticketGroups[1]!
  economyTicket.verifiedPrice.amount = 4821
  plan.verifiedFareTotal.amount = 16821
  plan.customerQuoteTotal!.amount = 16821

  const html = renderToStaticMarkup(createElement(FlightRecommendationsView, { result, busy: false, onAction: () => {} }))

  assert.match(html, /<strong>3 成人<\/strong><strong class="recommend-fare-price mono">¥1,607\/人<\/strong>/)
  assert.match(html, /recommend-plan-total-amount mono">¥16,821<\/strong>/)
  assert.doesNotMatch(html, />¥4,821<\/strong>/)

  economyTicket.verifiedPrice.amount = 4822
  plan.verifiedFareTotal.amount = 16822
  plan.customerQuoteTotal!.amount = 16822
  const roundedHtml = renderToStaticMarkup(createElement(FlightRecommendationsView, { result, busy: false, onAction: () => {} }))
  assert.match(roundedHtml, /recommend-fare-price mono">¥1,607.33\/人<\/strong>/)
})

test('missing segment facts never fall back to ticket-level aggregates', () => {
  const result = resultFixture()
  for (const ticket of result.plans[0]!.ticketGroups) {
    ticket.cabin = `票组汇总${ticket.cabin}`
    ticket.baggage = ticket.segmentFacts![0]!.baggage
    delete ticket.segmentFacts
  }

  const html = renderToStaticMarkup(createElement(FlightRecommendationsView, { result, busy: false, onAction: () => {} }))
  assert.match(html, /recommend-cabin-cell"><div class="recommend-detail-lines"><div><strong>1 成人<\/strong><span> · 未返回<\/span><\/div><div><strong>3 成人<\/strong><span> · 未返回<\/span>/)
  assert.match(html, /recommend-baggage-cell"><div class="recommend-detail-lines"><div><strong>1 成人<\/strong><span> · 未返回<\/span><\/div><div><strong>3 成人<\/strong><span> · 未返回<\/span>/)
  assert.doesNotMatch(html, /票组汇总|托运2\*32kg|托运1\*23kg/)
})

test('new segment facts never reuse ticket-wide aggregates for a missing field', () => {
  const result = resultFixture()
  const ticket = result.plans[0]!.ticketGroups[0]!
  ticket.cabin = '票组汇总舱位'
  ticket.baggage = '票组汇总行李'
  delete ticket.segmentFacts![0]!.cabin
  delete ticket.segmentFacts![0]!.baggage

  const html = renderToStaticMarkup(createElement(FlightRecommendationsView, { result, busy: false, onAction: () => {} }))
  assert.match(html, /recommend-cabin-cell"><div class="recommend-detail-lines"><div><strong>1 成人<\/strong><span> · 未返回<\/span>/)
  assert.match(html, /recommend-baggage-cell"><div class="recommend-detail-lines"><div><strong>1 成人<\/strong><span> · 未返回<\/span>/)
  assert.doesNotMatch(html, /票组汇总舱位|票组汇总行李/)
})

test('joint fares keep one ticket price while each journey shows its own cabin fact', () => {
  const result = resultFixture()
  const plan = result.plans[0]!
  plan.journeys.push({
    journeyId: 'inbound', role: 'leg', origin: 'NRT', destination: 'SHE', duration: '7h25m', transferCount: 1,
    segments: [{
      flightNo: 'HO1380', departure: 'NRT', departureDate: '2026-08-02', departureTime: '13:20',
      arrival: 'SHE', arrivalDate: '2026-08-02', arrivalTime: '20:45',
    }],
  })
  plan.windows.push({ journeyIndex: 1, window: '09:00-18:00' })
  for (const ticket of plan.ticketGroups) {
    ticket.journeyIndexes = [1, 0]
    ticket.fareSource = 'joint'
    ticket.segmentFacts!.push({
      journeyIndex: 1,
      segmentIndex: 0,
      cabin: ticket.passengerGroupId === 'business' ? '商务 I舱' : '经济 H舱',
      baggage: ticket.passengerGroupId === 'business' ? '托运2*32kg' : '托运1*23kg',
    })
  }

  const html = renderToStaticMarkup(createElement(FlightRecommendationsView, { result, busy: false, onAction: () => {} }))
  assert.match(html, /商务 Z舱/)
  assert.match(html, /商务 I舱/)
  assert.match(html, /<ul class="recommend-plan-journeys"><li><span>第1程<\/span><span class="mono">09:00-18:00<\/span><\/li><li><span>第2程<\/span><span class="mono">09:00-18:00<\/span><\/li><\/ul>/)
  assert.match(html, /recommend-source-badge is-joint">联合查询/)
  assert.equal(html.match(/¥12,000/g)?.length, 1)
  assert.ok(html.indexOf('¥12,000') < html.indexOf('HO1380'))
  assert.doesNotMatch(html, /多程票总价见下方票组/)
})

test('round-trip fare construction stays distinct from journey topology', () => {
  const result = resultFixture()
  result.plans[0]!.ticketGroups[0]!.fareSource = 'roundtrip'

  const html = renderToStaticMarkup(createElement(FlightRecommendationsView, { result, busy: false, onAction: () => {} }))
  assert.match(html, /recommend-source-badge is-roundtrip">往返查询/)
})

test('partial state renders plans without inventing a coverage warning', () => {
  const partial = resultFixture()
  partial.status = 'partial'
  partial.coverageStatus = 'partial'
  partial.budgetStatus = 'exhausted'
  partial.capabilities.canRetry = true
  const partialHtml = renderToStaticMarkup(createElement(FlightRecommendationsView, { result: partial, busy: false, onAction: () => {} }))
  assert.doesNotMatch(partialHtml, /推荐结果不完整/)
  assert.doesNotMatch(partialHtml, /搜索覆盖不完整/)
  assert.doesNotMatch(partialHtml, /全部组合中的最低价/)
  assert.match(partialHtml, />重试推荐<\/button>/)
  assert.match(partialHtml, /class="recommend-copy-action"[^>]*>.*<span>复制<\/span><\/button>/)
})

test('partial state shows only an explicit skill message and its retry capability', () => {
  const partial = resultFixture()
  partial.status = 'partial'
  partial.message = '部分票价构造未完成，请按需重试。'
  partial.capabilities.canRetry = true
  const html = renderToStaticMarkup(createElement(FlightRecommendationsView, { result: partial, busy: false, onAction: () => {} }))
  assert.match(html, /部分票价构造未完成，请按需重试。/)
  assert.match(html, />重试推荐<\/button>/)
  assert.doesNotMatch(html, /is-warning/)
})

test('expired plan renders the skill-owned state and authorized Reverify action', () => {
  const expired = resultFixture()
  expired.status = 'expired'
  expired.capabilities = { canRetry: false, canReverify: true, canCopy: false }
  expired.plans[0]!.validity.status = 'expired'
  expired.plans[0]!.capabilities = { canCopy: false, canReverify: true, canBook: false }
  for (const ticket of expired.plans[0]!.ticketGroups) ticket.validity.status = 'expired'

  const html = renderToStaticMarkup(createElement(FlightRecommendationsView, { result: expired, busy: false, onAction: () => {} }))
  assert.match(html, /价格已过期/)
  assert.match(html, />重新验价<\/button>/)
  assert.doesNotMatch(html, /实时查询价/)
  assert.doesNotMatch(html, /recommend-copy-action/)
})

test('empty and fatal states provide retry semantics and stable labels', () => {
  assert.equal(recommendationStatusLabel('empty'), '没有符合条件的方案')
  assert.match(buildRecommendationRetryPrompt('plan-1'), /plan-1/)
  const empty = resultFixture()
  empty.status = 'empty'
  empty.capabilities.canRetry = true
  empty.plans = []
  const html = renderToStaticMarkup(createElement(FlightRecommendationsView, { result: empty, busy: false, onAction: () => {} }))
  assert.match(html, /role="alert"/)
  assert.match(html, />重试推荐<\/button>/)
})
