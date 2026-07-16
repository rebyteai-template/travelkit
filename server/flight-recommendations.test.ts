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
          verifiedPrice: { amount: 12000, currency: 'CNY' }, verifiedAt: '2099-07-16T05:00:00.000Z',
          validity: { status: 'verified', validUntil: '2099-07-16T05:10:00.000Z' },
        },
        {
          ticketGroupId: 'economy-ticket', passengerGroupId: 'economy', journeyIndexes: [0], fareSource: 'oneway',
          cabin: '经济 T舱', exactPassengerCount: { adult: 3, child: 0, infant: 0 },
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

test('recommendation renderer shows one physical itinerary with cabin lines and collapsed read-only evidence', () => {
  const html = renderToStaticMarkup(createElement(FlightRecommendationsView, {
    result: resultFixture(),
    evidence: [searchEvidence()],
    busy: false,
    onAction: () => {},
  }))

  assert.equal(html.match(/<strong class="mono">CA165<\/strong>/g)?.length, 1)
  assert.match(html, /商务 Z舱/)
  assert.match(html, /经济 T舱/)
  assert.match(html, /备选路线/)
  assert.match(html, /<details class="recommend-evidence">/)
  assert.match(html, /查看中间搜索证据/)
  assert.doesNotMatch(html, /<th>操作<\/th>/)
  assert.doesNotMatch(html, />验价<\/button>/)
  assert.match(html, />Copy<\/button>/)
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
  assert.match(partialHtml, />Copy<\/button>/)
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
  assert.doesNotMatch(html, />Copy<\/button>/)
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
