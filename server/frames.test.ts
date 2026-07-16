import assert from 'node:assert/strict'
import { test } from 'node:test'

import { derive } from '../src/frames.ts'
import type { PromptContent } from '../src/api.ts'

function promptWithToolResult(content: string): PromptContent {
  return {
    id: 'p1',
    prompt: 'search',
    status: 'completed',
    created_at: '2026-07-08 00:00:00',
    completed_at: '2026-07-08 00:01:00',
    attachments: [],
    frames: [
      {
        seq: 1,
        data: {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', content }],
          },
        },
      },
    ],
  }
}

function compactSearch(optionNumber: number, flightNo: string, amount: number) {
  return {
    ok: true,
    searchedRequests: [{ uniqueCandidateCount: 1 }],
    displayOptions: [
      {
        optionNumber,
        solutionId: `sol-${flightNo.toLowerCase()}`,
        itineraryType: 'oneway',
        fareSource: 'oneway',
        ticketGroups: [{ index: 0, fareSource: 'oneway', journeyIndexes: [0], price: { amount, currency: 'CNY' } }],
        journeyType: '直飞',
        duration: '2h',
        durationMinutes: 120,
        cabin: '经济 H舱',
        baggage: '托运1*23kg',
        hasCheckedBaggage: true,
        capabilities: { canCopy: false, canBook: false },
        price: { amount, currency: 'CNY' },
        journeys: [
          {
            role: 'oneway',
            ticketGroupIndex: 0,
            origin: 'PEK',
            destination: 'SHA',
            departureDate: '2026-08-05',
            departureTime: '07:45',
            arrivalDate: '2026-08-05',
            arrivalTime: '10:05',
            duration: '2h20m',
            transferCount: 0,
            segments: [
              {
                flightNo,
                departure: 'PEK',
                departureName: '北京首都',
                departureDate: '2026-08-05',
                departureTime: '07:45',
                arrival: 'SHA',
                arrivalName: '上海虹桥',
                arrivalDate: '2026-08-05',
                arrivalTime: '10:05',
                cabin: '经济 H舱',
                checkedBaggage: '托运1*23kg',
              },
            ],
          },
        ],
      },
    ],
    displayMapping: { 1: {} },
    searchCoverage: {
      status: 'complete',
      required: ['oneway'],
      attempted: ['oneway'],
      completed: ['oneway'],
      missing: [],
    },
  }
}

function recommendationsResult() {
  return {
    schemaVersion: 'flight-recommendations/v1',
    resultType: 'flight.recommendations',
    status: 'success',
    coverageStatus: 'complete',
    alternateCoverageStatus: 'failed',
    budgetStatus: 'within_budget',
    capabilities: { canRetry: false, canReverify: false, canCopy: true },
    plans: [
      {
        planId: 'plan-morning-evening',
        label: '早去晚回',
        windowKey: 'morning|evening',
        windows: [
          { journeyIndex: 0, window: '06:00-09:00' },
          { journeyIndex: 1, window: '18:00-24:00' },
        ],
        journeys: [
          {
            journeyId: 'outbound',
            role: 'outbound',
            origin: 'PEK',
            destination: 'MEL',
            duration: '11h25m',
            transferCount: 0,
            segments: [{
              flightNo: 'CA165', departure: 'PEK', departureName: '北京首都', departureTerminal: 'T3',
              departureDate: '2026-08-14', departureTime: '07:00', arrival: 'MEL', arrivalName: '墨尔本',
              arrivalTerminal: 'T2', arrivalDate: '2026-08-14', arrivalTime: '20:25',
            }],
          },
          {
            journeyId: 'inbound',
            routeOptionId: 'hong-kong',
            routePriority: 'alternate',
            role: 'inbound',
            origin: 'SYD',
            destination: 'HKG',
            duration: '9h55m',
            transferCount: 0,
            segments: [{
              flightNo: 'HX18', departure: 'SYD', departureName: '悉尼', departureTerminal: 'T1',
              departureDate: '2026-08-24', departureTime: '18:15', arrival: 'HKG', arrivalName: '香港',
              arrivalTerminal: 'T1', arrivalDate: '2026-08-25', arrivalTime: '02:10',
            }],
          },
        ],
        passengerGroups: [
          { passengerGroupId: 'business', cabinClass: 'business', passengers: { adult: 1, child: 0, infant: 0 } },
          { passengerGroupId: 'economy', cabinClass: 'economy', passengers: { adult: 3, child: 0, infant: 0 } },
        ],
        ticketGroups: [
          {
            ticketGroupId: 'business-joint', passengerGroupId: 'business', journeyIndexes: [0, 1],
            fareSource: 'joint', source: 'meiya', cabin: '商务 Z/I舱', baggage: '托运2*32kg',
            exactPassengerCount: { adult: 1, child: 0, infant: 0 },
            verifiedPrice: { amount: 28400, currency: 'CNY' },
            verifiedAt: '2099-07-16T05:00:00.000Z',
            validity: { status: 'verified', validUntil: '2099-07-16T05:10:00.000Z' },
          },
          {
            ticketGroupId: 'economy-outbound', passengerGroupId: 'economy', journeyIndexes: [0],
            fareSource: 'oneway', source: 'meiya', cabin: '经济 T舱', baggage: '托运1*23kg',
            exactPassengerCount: { adult: 3, child: 0, infant: 0 },
            verifiedPrice: { amount: 11427, currency: 'CNY' },
            verifiedAt: '2099-07-16T05:00:00.000Z',
            validity: { status: 'verified', validUntil: '2099-07-16T05:10:00.000Z' },
          },
          {
            ticketGroupId: 'economy-inbound', passengerGroupId: 'economy', journeyIndexes: [1],
            fareSource: 'oneway', source: 'yinling', cabin: '经济 W舱', baggage: '托运1*23kg',
            exactPassengerCount: { adult: 3, child: 0, infant: 0 },
            verifiedPrice: { amount: 6423, currency: 'CNY' },
            verifiedAt: '2099-07-16T05:00:00.000Z',
            validity: { status: 'verified', validUntil: '2099-07-16T05:10:00.000Z' },
          },
        ],
        verifiedFareTotal: { amount: 46250, currency: 'CNY' },
        customerQuoteTotal: { amount: 46250, currency: 'CNY' },
        verifiedAt: '2099-07-16T05:00:00.000Z',
        validity: { status: 'verified', validUntil: '2099-07-16T05:10:00.000Z' },
        explanation: { reason: '覆盖早去晚回，价格最低。', limitation: '回程跨夜。' },
        copyText: '早去晚回\nCA165 / HX18\n总价 CNY 46250',
        capabilities: { canCopy: true, canReverify: false, canBook: false },
      },
    ],
  }
}

test('derive parses compact search JSON before trailing shell output', () => {
  const compact = compactSearch(1, 'MU5186', 1000)
  const rawOption = compact.displayOptions[0] as unknown as Record<string, unknown>
  rawOption.verifiedAt = '2026-08-05T00:00:00.000Z'
  rawOption.priceBasis = 'verified'

  const view = derive([promptWithToolResult(`${JSON.stringify(compact)}\nShell cwd was reset to /code\n`)])
  assert.equal(view.stage, 'search')
  assert.equal(view.search?.options.length, 1)
  assert.equal(view.search?.options[0]?.solutionId, 'sol-mu5186')
  assert.equal(view.search?.options[0]?.priceBasis, 'verified')
  assert.equal(view.search?.options[0]?.itineraryType, 'oneway')
  assert.equal(view.search?.options[0]?.fareSource, 'oneway')
  assert.deepEqual(view.search?.options[0]?.ticketGroups?.map((group) => ({
    fareSource: group.fareSource,
    journeyIndexes: group.journeyIndexes,
  })), [{ fareSource: 'oneway', journeyIndexes: [0] }])
  assert.equal(view.search?.coverage?.status, 'complete')
  assert.deepEqual(view.chat.at(-1)?.coverage?.completed, ['oneway'])
  assert.equal(view.search?.options[0]?.journeys[0]?.role, 'oneway')
  assert.equal(view.search?.options[0]?.journeys[0]?.ticketGroupIndex, 0)
  assert.deepEqual(view.search?.options[0]?.capabilities, { canCopy: false, canBook: false })
  assert.equal(view.search?.options[0]?.blocks, undefined)
  assert.equal(view.chat.at(-1)?.cards?.length, 1)
})

test('a shape-valid empty search clears the current result and uses the aggregate count', () => {
  const populated = promptWithToolResult(JSON.stringify(compactSearch(1, 'MU5186', 1000)))
  populated.id = 'populated'
  const emptyPayload = {
    ...compactSearch(1, 'MU5186', 1000),
    displayOptions: [],
    displayMapping: {},
    searchedRequests: [{ uniqueCandidateCount: 1 }],
    summary: { afterFilters: 7 },
  }
  const cleared = promptWithToolResult(JSON.stringify(emptyPayload))
  cleared.id = 'cleared'

  const view = derive([populated, cleared])
  assert.equal(view.stage, 'search')
  assert.deepEqual(view.search?.options, [])
  assert.equal(view.search?.totalCount, 7)
})

test('derive parses combo blocks (per-ticket price/source) and journey blockIndex', () => {
  const compact = compactSearch(1, 'MU0583', 46071)
  const combo = compact.displayOptions[0] as Record<string, unknown>
  combo.solutionId = 'combo:abc123'
  combo.price = { amount: 46071, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 15357, subtotal: 46071 } } }
  combo.journeys = [
    { ...(combo.journeys as Record<string, unknown>[])[0], role: 'leg', ticketGroupIndex: 0, blockIndex: 0 },
    { ...(combo.journeys as Record<string, unknown>[])[0], role: 'leg', ticketGroupIndex: 1, blockIndex: 1 },
  ]
  combo.blocks = [
    { price: { amount: 45021, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 15007, subtotal: 45021 } } }, source: '美亚' },
    { price: { amount: 1050, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 350, subtotal: 1050 } } } },
  ]

  const view = derive([promptWithToolResult(JSON.stringify(compact))])
  const option = view.search?.options[0]
  assert.deepEqual(option?.journeys.map((j) => j.blockIndex), [0, 1])
  assert.deepEqual(option?.journeys.map((j) => j.ticketGroupIndex), [0, 1])
  assert.deepEqual(option?.blocks, [
    { price: { amount: 45021, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 15007, subtotal: 45021 } } }, source: '美亚' },
    { price: { amount: 1050, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 350, subtotal: 1050 } } }, source: undefined },
  ])
})

test('derive preserves multiple compact searches in one turn', () => {
  const prompt = promptWithToolResult('')
  prompt.frames = [
    {
      seq: 1,
      data: {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: JSON.stringify(compactSearch(1, 'NH0964', 27364)) }] },
      },
    },
    {
      seq: 2,
      data: {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: JSON.stringify(compactSearch(1, 'JL0022', 25798)) }] },
      },
    },
    {
      seq: 3,
      data: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '汇总如下' }] },
      },
    },
  ]

  const view = derive([prompt])
  const cardBubbles = view.chat.filter((b) => b.cards)
  assert.equal(cardBubbles.length, 2)
  assert.equal(cardBubbles[0]?.cards?.length, 1)
  assert.equal(cardBubbles[1]?.cards?.length, 1)
  const firstCard = cardBubbles[0]?.cards?.[0]
  const secondCard = cardBubbles[1]?.cards?.[0]
  const latestSearch = view.search?.options[0]
  if (!firstCard || !secondCard || !latestSearch) throw new Error('expected card-backed searches')
  assert.equal(firstCard.journeys[0]?.segments[0]?.flightNo, 'NH0964')
  assert.equal(secondCard.journeys[0]?.segments[0]?.flightNo, 'JL0022')
  assert.equal(latestSearch.journeys[0]?.segments[0]?.flightNo, 'JL0022')
})

test('versioned search keeps the structured UI table when the agent also writes markdown tables', () => {
  const search = compactSearch(1, 'CA165', 14932) as Record<string, unknown>
  search.schemaVersion = 'flight-search/v1'
  search.resultType = 'flight.search'
  const prompt = promptWithToolResult('')
  prompt.frames = [
    { seq: 1, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(search) }] } } },
    { seq: 2, data: { type: 'assistant', message: { content: [{ type: 'text', text: '搜索完成\n\n| 航班 | 价格 |\n| --- | --- |\n| CA165 | ¥14932 |' }] } } },
  ]

  const view = derive([prompt])
  assert.equal(view.chat.filter((bubble) => bubble.cards).length, 1)
  assert.equal(view.chat.find((bubble) => bubble.cards)?.cards?.[0]?.journeys[0]?.segments[0]?.flightNo, 'CA165')
  assert.equal(view.chat.find((bubble) => bubble.text.includes('搜索完成'))?.text, '搜索完成')
})

test('a final proposal replaces search and pricing tables with one OP card', () => {
  const search = compactSearch(1, 'CA165', 14932) as Record<string, unknown>
  search.schemaVersion = 'flight-search/v1'
  search.resultType = 'flight.search'
  const pricing = compactSearch(6, 'CA165', 14932) as Record<string, unknown>
  pricing.schemaVersion = 'flight-pricing/v1'
  pricing.resultType = 'flight.pricing'
  const proposal = {
    schemaVersion: 'flight-proposal/v1',
    resultType: 'flight.proposal',
    ok: true,
    title: '客户报价方案',
    journeys: [
      {
        role: 'outbound',
        itinerary: {
          origin: 'PEK', destination: 'MEL', duration: '11h25m', transferCount: 0,
          segments: [{
            flightNo: 'CA165', departure: 'PEK', departureName: '北京首都', departureTerminal: 'T3',
            departureDate: '2026-08-14', departureTime: '01:00', arrival: 'MEL', arrivalName: '墨尔本',
            arrivalTerminal: 'T2', arrivalDate: '2026-08-14', arrivalTime: '14:25', cabin: '商务 Z舱',
          }],
        },
        fares: [
          { passengers: 1, passengerType: 'adult', cabin: '商务 Z舱', baggage: '托运2*32kg', unitPrice: 13255, subtotal: 13255 },
          { passengers: 3, passengerType: 'adult', cabin: '经济 T舱', baggage: '托运1*23kg', unitPrice: 3809, subtotal: 11427 },
        ],
        subtotal: 24682,
      },
      {
        role: 'inbound',
        itinerary: {
          origin: 'SYD', destination: 'HKG', duration: '9h55m', transferCount: 0,
          segments: [{
            flightNo: 'HX18', departure: 'SYD', departureName: '悉尼', departureTerminal: 'T1',
            departureDate: '2026-08-24', departureTime: '11:15', arrival: 'HKG', arrivalName: '香港',
            arrivalTerminal: 'T1', arrivalDate: '2026-08-24', arrivalTime: '19:10', cabin: '商务 I舱',
          }],
        },
        fares: [
          { passengers: 1, passengerType: 'adult', cabin: '商务 I舱', baggage: '托运2*32kg', unitPrice: 15145, subtotal: 15145 },
          { passengers: 3, passengerType: 'adult', cabin: '经济 W舱', baggage: '托运1*23kg', unitPrice: 2141, subtotal: 6423 },
        ],
        subtotal: 21568,
      },
    ],
    total: { amount: 46250, currency: 'CNY' },
    copyText: '1. CA165\n1人 商务 Z舱\n3人 经济 T舱\n\n2. HX18\n1人 商务 I舱\n3人 经济 W舱',
    capabilities: { canCopy: true, canBook: false },
  }
  const prompt = promptWithToolResult('')
  prompt.frames = [
    { seq: 1, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(search) }] } } },
    { seq: 2, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(pricing) }] } } },
    { seq: 3, data: { type: 'assistant', message: { content: [{ type: 'text', text: '最终如下\n\n| 航班 | 价格 |\n| --- | --- |\n| CA165 | ¥13255 |' }] } } },
    { seq: 4, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(proposal) }] } } },
  ]

  const view = derive([prompt])
  assert.equal(view.chat.filter((bubble) => bubble.cards).length, 0)
  assert.equal(view.chat.filter((bubble) => bubble.proposal).length, 1)
  assert.equal(view.chat.find((bubble) => bubble.proposal)?.proposal?.journeys.length, 2)
  assert.equal(view.chat.find((bubble) => bubble.proposal)?.proposal?.journeys[0]?.fares.length, 2)
  assert.equal(view.chat.find((bubble) => bubble.text.includes('最终如下'))?.text, '最终如下')
})

test('a recommendation result is authoritative regardless of frame order and retains search as evidence', () => {
  const recommendation = recommendationsResult()
  const search = compactSearch(1, 'CA165', 14932) as Record<string, unknown>
  search.schemaVersion = 'flight-search/v1'
  search.resultType = 'flight.search'
  const prompt = promptWithToolResult('')
  prompt.frames = [
    { seq: 1, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(recommendation) }] } } },
    { seq: 2, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(compactVerify('AA2883', 4000)) }] } } },
    { seq: 3, data: { type: 'assistant', message: { content: [{ type: 'text', text: '中间表\n\n| 航班 | 价格 |\n| --- | --- |\n| CA165 | ¥14932 |' }] } } },
    { seq: 4, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(search) }] } } },
  ]

  const view = derive([prompt])
  assert.equal(view.stage, 'recommendation')
  assert.equal(view.fare, null)
  assert.equal(view.recommendations?.plans[0]?.planId, 'plan-morning-evening')
  assert.equal(view.recommendations?.alternateCoverageStatus, 'failed')
  assert.equal(view.recommendations?.plans[0]?.journeys[1]?.routeOptionId, 'hong-kong')
  assert.equal(view.recommendations?.plans[0]?.journeys[1]?.routePriority, 'alternate')
  assert.equal(view.chat.filter((bubble) => bubble.recommendations).length, 1)
  assert.equal(view.chat.some((bubble) => bubble.cards || bubble.fare || bubble.proposal), false)
  assert.equal(view.chat.find((bubble) => bubble.recommendations)?.evidence?.length, 1)
  assert.equal(view.chat.find((bubble) => bubble.text.includes('中间表'))?.text, '中间表')
})

test('a new recommendation result outranks a legacy proposal emitted later in the same turn', () => {
  const legacy = {
    schemaVersion: 'flight-proposal/v1', resultType: 'flight.proposal', ok: true, title: '旧报价',
    journeys: [{
      role: 'oneway',
      itinerary: {
        origin: 'PEK', destination: 'SHA', duration: '2h', transferCount: 0,
        segments: [{
          flightNo: 'MU5186', departure: 'PEK', departureDate: '2026-08-05', departureTime: '07:45',
          arrival: 'SHA', arrivalDate: '2026-08-05', arrivalTime: '10:05', cabin: '经济 H舱',
        }],
      },
      fares: [{ passengers: 1, passengerType: 'adult', cabin: '经济 H舱', baggage: '1件', unitPrice: 1000, subtotal: 1000 }],
      subtotal: 1000,
    }],
    total: { amount: 1000, currency: 'CNY' }, copyText: '旧报价', capabilities: { canCopy: true, canBook: false },
  }
  const prompt = promptWithToolResult('')
  prompt.frames = [
    { seq: 1, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(recommendationsResult()) }] } } },
    { seq: 2, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(legacy) }] } } },
  ]

  const view = derive([prompt])
  assert.equal(view.chat.some((bubble) => bubble.proposal), false)
  assert.equal(view.chat.filter((bubble) => bubble.recommendations).length, 1)
})

test('multiple plan-bearing recommendation results in one turn fail closed instead of taking the last result', () => {
  const first = recommendationsResult()
  const second = structuredClone(first)
  second.plans[0]!.planId = 'plan-from-separate-recommend-call'
  second.plans[0]!.label = '另一次独立 recommend 的方案'
  const prompt = promptWithToolResult('')
  prompt.frames = [
    { seq: 1, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(first) }] } } },
    { seq: 2, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(second) }] } } },
  ]

  const view = derive([prompt])
  assert.equal(view.stage, 'recommendation')
  assert.equal(view.recommendations?.status, 'fatal_error')
  assert.equal(view.recommendations?.plans.length, 0)
  assert.match(view.recommendations?.message ?? '', /多个独立的推荐结果/)
  assert.equal(view.chat.filter((bubble) => bubble.recommendations).length, 1)
})

test('an identical recommendation result replay in one turn is de-duplicated rather than treated as a conflict', () => {
  const payload = recommendationsResult()
  const prompt = promptWithToolResult('')
  prompt.frames = [
    { seq: 1, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(payload) }] } } },
    { seq: 2, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(payload) }] } } },
  ]

  const view = derive([prompt])
  assert.equal(view.recommendations?.status, 'success')
  assert.equal(view.recommendations?.plans[0]?.planId, 'plan-morning-evening')
})

test('malformed explicit recommendation results fail closed instead of falling through to evidence', () => {
  const invalidPayloads = [
    { ...recommendationsResult(), schemaVersion: 'flight-recommendations/v999' },
    { ...recommendationsResult(), plans: [] },
    (() => {
      const value = structuredClone(recommendationsResult())
      value.plans[0]!.ticketGroups[2]!.journeyIndexes = [0]
      return value
    })(),
    (() => {
      const value = structuredClone(recommendationsResult())
      value.plans[0]!.ticketGroups[2]!.verifiedPrice.currency = 'USD'
      return value
    })(),
    (() => {
      const value = structuredClone(recommendationsResult())
      value.plans[0]!.copyText = ''
      return value
    })(),
    (() => {
      const value = structuredClone(recommendationsResult())
      value.plans[0]!.ticketGroups[0]!.exactPassengerCount.adult = 2
      return value
    })(),
  ]

  for (const payload of invalidPayloads) {
    const prompt = promptWithToolResult('')
    prompt.frames = [
      { seq: 1, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(compactSearch(1, 'CA165', 14932)) }] } } },
      { seq: 2, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(payload) }] } } },
    ]
    const view = derive([prompt])
    assert.equal(view.stage, 'recommendation')
    assert.equal(view.recommendations?.status, 'fatal_error')
    assert.equal(view.chat.some((bubble) => bubble.cards), false)
  }

  const missingResultType = {
    ...compactSearch(1, 'CA165', 14932),
    schemaVersion: 'flight-recommendations/v1',
  }
  delete (missingResultType as { resultType?: string }).resultType
  const view = derive([promptWithToolResult(JSON.stringify(missingResultType))])
  assert.equal(view.stage, 'recommendation')
  assert.equal(view.recommendations?.status, 'fatal_error')
  assert.equal(view.chat.some((bubble) => bubble.cards), false)
})

test('recommendation sets reject duplicate plan identities and more than ten plans', () => {
  const duplicatePlan = structuredClone(recommendationsResult())
  duplicatePlan.plans.push(structuredClone(duplicatePlan.plans[0]!))
  const tooMany = structuredClone(recommendationsResult())
  tooMany.plans = Array.from({ length: 11 }, (_, index) => ({
    ...structuredClone(tooMany.plans[0]!),
    planId: `plan-${index}`,
    windowKey: `window-${index}`,
  }))

  for (const payload of [duplicatePlan, tooMany]) {
    const view = derive([promptWithToolResult(JSON.stringify(payload))])
    assert.equal(view.recommendations?.status, 'fatal_error')
  }
})

test('recommendation sets render distinct plans that share the same time window', () => {
  const payload = structuredClone(recommendationsResult())
  const transferPlan = structuredClone(payload.plans[0]!)
  transferPlan.planId = 'plan-transfer-same-window'
  transferPlan.label = '同一时间窗的一次中转方案'
  transferPlan.journeys[0]!.transferCount = 1
  payload.plans.push(transferPlan)

  const view = derive([promptWithToolResult(JSON.stringify(payload))])
  assert.equal(view.recommendations?.status, 'success')
  assert.deepEqual(view.recommendations?.plans.map((plan) => plan.planId), [
    'plan-morning-evening',
    'plan-transfer-same-window',
  ])
})

test('recommendation windowKey is optional and the ten-plan cap is inclusive', () => {
  const payload = structuredClone(recommendationsResult())
  payload.plans = Array.from({ length: 10 }, (_, index) => {
    const plan = structuredClone(payload.plans[0]!)
    plan.planId = `plan-${index}`
    delete (plan as { windowKey?: string }).windowKey
    plan.windows[0]!.window = `${String(index).padStart(2, '0')}:00-${String(index + 1).padStart(2, '0')}:00`
    return plan
  })

  const view = derive([promptWithToolResult(JSON.stringify(payload))])
  assert.equal(view.recommendations?.status, 'success')
  assert.equal(view.recommendations?.plans.length, 10)
  assert.equal(view.recommendations?.plans[0]?.windowKey, undefined)
})

test('non-plan recommendation states parse without reviving search evidence as primary output', () => {
  for (const status of ['loading', 'empty', 'fatal_error'] as const) {
    const payload = {
      schemaVersion: 'flight-recommendations/v1',
      resultType: 'flight.recommendations',
      status,
      coverageStatus: status === 'fatal_error' ? 'failed' : 'partial',
      budgetStatus: 'within_budget',
      capabilities: { canRetry: true, canReverify: false, canCopy: false },
      message: `state:${status}`,
      plans: [],
    }
    const view = derive([promptWithToolResult(JSON.stringify(payload))])
    assert.equal(view.stage, 'recommendation')
    assert.equal(view.recommendations?.status, status)
    assert.equal(view.chat.filter((bubble) => bubble.recommendations).length, 1)
  }
})

test('recommendations do not change state based on a local price-expiry clock', () => {
  const payload = structuredClone(recommendationsResult())
  for (const plan of payload.plans) {
    plan.verifiedAt = '2020-01-01T00:00:00.000Z'
    plan.validity.validUntil = '2020-01-01T00:05:00.000Z'
    for (const ticket of plan.ticketGroups) {
      ticket.verifiedAt = plan.verifiedAt
      ticket.validity.validUntil = plan.validity.validUntil
    }
  }

  const view = derive([promptWithToolResult(JSON.stringify(payload))])
  assert.equal(view.recommendations?.status, 'success')
  assert.equal(view.recommendations?.plans[0]?.validity.status, 'verified')
  assert.deepEqual(view.recommendations?.plans[0]?.capabilities, {
    canCopy: true,
    canReverify: false,
    canBook: false,
  })
  assert.equal(view.recommendations?.capabilities.canRetry, false)
})

function compactVerify(flightNo: string, amount: number) {
  return {
    schemaVersion: 'flight-verify/v1',
    resultType: 'flight.verify',
    ok: true,
    verification: {
      status: 'verified',
      verifiedAt: '2026-10-01T08:00:00.000Z',
      validUntil: '2026-10-01T08:05:00.000Z',
      changed: false,
      changedFields: [],
    },
    selectedOption: { optionNumber: 1 },
    verifiedOption: {
      itineraryType: 'oneway',
      availability: 2,
      source: 'meiya',
      capabilities: { canCopy: false, canBook: true },
      transitAdvisory: { status: 'complete', facts: [{ baggageThrough: true }] },
      price: {
        amount,
        currency: 'CNY',
        fareTotal: amount - 200,
        taxTotal: 200,
        perType: { adult: { num: 2, unitFare: (amount - 200) / 2, unitTax: 100, unitTotal: amount / 2, subtotal: amount } },
      },
      journeys: [
        {
          role: 'oneway',
          ticketGroupIndex: 0,
          origin: 'SLC',
          destination: 'BUF',
          departureDate: '2026-10-02',
          departureTime: '11:20',
          arrivalDate: '2026-10-02',
          arrivalTime: '20:05',
          duration: '6h45m',
          transferCount: 0,
          segments: [
            {
              flightNo,
              departure: 'SLC',
              departureName: '盐湖城',
              departureTerminal: 'T1',
              departureDate: '2026-10-02',
              departureTime: '11:20',
              arrival: 'BUF',
              arrivalName: '布法罗',
              arrivalTerminal: 'T2',
              arrivalDate: '2026-10-02',
              arrivalTime: '20:05',
              cabin: '经济 T舱',
            },
          ],
        },
      ],
    },
    fareRules: { refund: [{ condition: '起飞前', fee: 210 }] },
  }
}

test('derive preserves explicit verified-option semantics instead of guessing them in the UI', () => {
  const payload = compactVerify('AA2883', 4000)
  const view = derive([promptWithToolResult(JSON.stringify(payload))])
  const fare = view.fare
  if (!fare) throw new Error('expected verified fare')

  assert.equal(fare.schemaVersion, 'flight-verify/v1')
  assert.equal(fare.verifiedAt, '2026-10-01T08:00:00.000Z')
  assert.equal(fare.bookableUntil, '2026-10-01T08:05:00.000Z')
  assert.equal(fare.itineraryType, 'oneway')
  assert.equal(fare.journeys[0]?.role, 'oneway')
  assert.equal(fare.journeys[0]?.ticketGroupIndex, 0)
  assert.equal(fare.journeys[0]?.legs[0]?.departureName, '盐湖城')
  assert.equal(fare.journeys[0]?.legs[0]?.arrivalTerminal, 'T2')
  assert.equal(fare.baseFare, 3800)
  assert.equal(fare.tax, 200)
  assert.deepEqual(fare.passengers, [{ passengerType: 'adult', baseFare: 1900, tax: 100, salePrice: 2000, num: 2 }])
  assert.equal(fare.minAvailability, 2)
  assert.equal(fare.source, 'meiya')
  assert.equal(fare.canBook, true)
  assert.deepEqual(fare.transitAdvisory, { status: 'complete', facts: [{ baggageThrough: true }] })
  assert.deepEqual(fare.fareRules, { refund: [{ condition: '起飞前', fee: 210 }] })
})

test('versioned roundtrip roles survive the full verify adapter', () => {
  const payload = compactVerify('AA2883', 4000)
  payload.verifiedOption.itineraryType = 'roundtrip'
  payload.verifiedOption.journeys[0]!.role = 'outbound'
  payload.verifiedOption.journeys.push({
    ...payload.verifiedOption.journeys[0]!,
    role: 'inbound',
    origin: 'BUF',
    destination: 'SLC',
    departureDate: '2026-10-09',
    segments: payload.verifiedOption.journeys[0]!.segments.map((segment) => ({
      ...segment,
      departure: 'BUF',
      departureName: '布法罗',
      arrival: 'SLC',
      arrivalName: '盐湖城',
      departureDate: '2026-10-09',
      arrivalDate: '2026-10-09',
    })),
  })

  const fare = derive([promptWithToolResult(JSON.stringify(payload))]).fare
  assert.equal(fare?.itineraryType, 'roundtrip')
  assert.deepEqual(fare?.journeys.map((journey) => journey.role), ['outbound', 'inbound'])
})

test('legacy verify results remain readable but cannot authorize copy or booking', () => {
  const payload = compactVerify('AA2883', 4000) as unknown as Record<string, unknown>
  delete payload.schemaVersion
  delete payload.resultType
  delete payload.verification
  const verified = payload.verifiedOption as Record<string, unknown>
  verified.capabilities = { canCopy: false, canBook: true }
  delete verified.itineraryType
  const journeys = verified.journeys as Array<Record<string, unknown>>
  delete journeys[0]!.role
  delete journeys[0]!.ticketGroupIndex

  const fare = derive([promptWithToolResult(JSON.stringify(payload))]).fare
  if (!fare) throw new Error('expected legacy fare')
  assert.equal(fare.canBook, false)
  assert.equal(fare.journeys[0]?.role, 'oneway')
})

test('unknown verify contract versions do not become actionable fare data', () => {
  const payload = { ...compactVerify('AA2883', 4000), schemaVersion: 'flight-verify/v999' }
  assert.equal(derive([promptWithToolResult(JSON.stringify(payload))]).fare, null)
})

test('failed or unsupported verify invalidates a prior actionable fare', () => {
  const success = promptWithToolResult(JSON.stringify(compactVerify('AA2883', 4000)))
  success.id = 'success'
  const failed = promptWithToolResult(JSON.stringify({
    schemaVersion: 'flight-verify/v1',
    resultType: 'flight.verify',
    ok: false,
    verification: { status: 'failed', verifiedAt: null, changed: false, changedFields: [] },
    errorType: 'expired_search',
    message: '搜索已过期',
  }))
  failed.id = 'failed'
  const afterFailure = derive([success, failed])
  assert.equal(afterFailure.fare, null)
  assert.notEqual(afterFailure.stage, 'verify')
  assert.match(afterFailure.notice ?? '', /过期/)

  const unknown = promptWithToolResult(JSON.stringify({ ...compactVerify('AA2883', 4000), schemaVersion: 'flight-verify/v999' }))
  unknown.id = 'unknown'
  const afterUnknown = derive([success, unknown])
  assert.equal(afterUnknown.fare, null)
  assert.notEqual(afterUnknown.stage, 'verify')
  assert.match(afterUnknown.notice ?? '', /版本|必备字段/)
})

test('v1 rejects partial capabilities and missing required fare facts', () => {
  const variants: Array<(payload: ReturnType<typeof compactVerify>) => void> = [
    (payload) => { payload.verifiedOption.capabilities = { canCopy: true } as { canCopy: boolean; canBook: boolean } },
    (payload) => { payload.verifiedOption.capabilities = { canCopy: true, canBook: true } },
    (payload) => { delete (payload.verification as { verifiedAt?: string }).verifiedAt },
    (payload) => { delete (payload.verification as { validUntil?: string }).validUntil },
    (payload) => { delete (payload.verifiedOption.price as { amount?: number }).amount },
    (payload) => { payload.verifiedOption.price.currency = '' },
    (payload) => { payload.verifiedOption.journeys[0]!.segments = [] },
  ]
  for (const mutate of variants) {
    const payload = compactVerify('AA2883', 4000)
    mutate(payload)
    assert.equal(derive([promptWithToolResult(JSON.stringify(payload))]).fare, null)
  }
})

test('derive does not render the last fare card when a turn verifies multiple alternatives', () => {
  const prompt = promptWithToolResult('')
  prompt.frames = [
    {
      seq: 1,
      data: {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: JSON.stringify(compactVerify('AA2883', 3858)) }] },
      },
    },
    {
      seq: 2,
      data: {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: JSON.stringify(compactVerify('WN3888', 3978)) }] },
      },
    },
    {
      seq: 3,
      data: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '| 方案 | 价格 |\n|---|---|\n| AA | ¥3858 |\n| WN | ¥3978 |' }] },
      },
    },
  ]

  const view = derive([prompt])
  assert.equal(view.fare, null)
  assert.notEqual(view.stage, 'verify')

  assert.equal(view.chat.some((b) => b.fare), false)
  assert.match(view.chat.at(-1)?.text ?? '', /\| WN \| ¥3978 \|/)
})

function compactCombo(optionNumber: number, amount: number, legs: Array<{ flightNo: string; from: string; to: string; date: string; time: string }>) {
  return {
    ok: true,
    searchedRequests: [{ uniqueCandidateCount: 1 }],
    displayOptions: [
      {
        optionNumber,
        solutionId: `combo:${legs.map((l) => l.flightNo).join('-').toLowerCase()}`,
        journeyType: '多程',
        duration: '30h',
        durationMinutes: 1800,
        cabin: '经济',
        baggage: '托运1*23kg',
        hasCheckedBaggage: true,
        price: { amount, currency: 'CNY', display: `¥${amount}`, perType: { adult: { num: 3, unitTotal: Math.round(amount / 3), subtotal: amount } } },
        journeys: legs.map((l) => ({
          origin: l.from,
          destination: l.to,
          departureDate: l.date,
          departureTime: l.time,
          arrivalDate: l.date,
          arrivalTime: l.time,
          duration: '5h',
          transferCount: 0,
          segments: [
            {
              flightNo: l.flightNo,
              departure: l.from,
              departureDate: l.date,
              departureTime: l.time,
              arrival: l.to,
              arrivalDate: l.date,
              arrivalTime: l.time,
              cabin: '经济',
            },
          ],
        })),
      },
    ],
    displayMapping: { 1: {} },
  }
}

test('two multi-leg searches sharing a first leg both render (no signature collision)', () => {
  // Both option-1 start MU0583; only the later legs differ. The old first-flight-only
  // signature collided and dropped the second table — the full-itinerary signature keeps both.
  const first = compactCombo(1, 45900, [
    { flightNo: 'MU0583', from: 'PVG', to: 'LAX', date: '2026-09-27', time: '13:10' },
    { flightNo: 'DL1194', from: 'LAX', to: 'SLC', date: '2026-09-29', time: '11:34' },
  ])
  const second = compactCombo(1, 46200, [
    { flightNo: 'MU0583', from: 'PVG', to: 'LAX', date: '2026-09-27', time: '13:10' },
    { flightNo: 'WN3888', from: 'LAX', to: 'SLC', date: '2026-09-29', time: '06:00' },
  ])
  const prompt = promptWithToolResult('')
  prompt.frames = [
    { seq: 1, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(first) }] } } },
    { seq: 2, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(second) }] } } },
  ]

  const cardBubbles = derive([prompt]).chat.filter((b) => b.cards)
  assert.equal(cardBubbles.length, 2)
  assert.equal(cardBubbles[0]?.cards?.[0]?.journeys[1]?.segments[0]?.flightNo, 'DL1194')
  assert.equal(cardBubbles[1]?.cards?.[0]?.journeys[1]?.segments[0]?.flightNo, 'WN3888')
})

test('an identical compact re-read in a later frame is de-duplicated', () => {
  // The verify turn re-reads the same search compact; that exact repeat must not render twice.
  const same = compactCombo(1, 45900, [
    { flightNo: 'MU0583', from: 'PVG', to: 'LAX', date: '2026-09-27', time: '13:10' },
    { flightNo: 'DL1194', from: 'LAX', to: 'SLC', date: '2026-09-29', time: '11:34' },
  ])
  const prompt = promptWithToolResult('')
  prompt.frames = [
    { seq: 1, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(same) }] } } },
    { seq: 2, data: { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(same) }] } } },
  ]

  assert.equal(derive([prompt]).chat.filter((b) => b.cards).length, 1)
})

test('a 2-journey round-trip compact renders one card with both legs', () => {
  const rt = compactCombo(1, 15200, [
    { flightNo: 'CA0841', from: 'PEK', to: 'VIE', date: '2026-09-06', time: '02:55' },
    { flightNo: 'CA0842', from: 'VIE', to: 'PEK', date: '2026-09-12', time: '13:30' },
  ])
  const view = derive([promptWithToolResult(JSON.stringify(rt))])
  const card = view.chat.filter((b) => b.cards).at(0)?.cards?.[0]
  if (!card) throw new Error('expected a card')
  assert.equal(card.journeys.length, 2)
  assert.equal(card.journeys[0]?.segments[0]?.flightNo, 'CA0841')
  assert.equal(card.journeys[1]?.segments[0]?.flightNo, 'CA0842')
})

test('a truncated compact search does not crash derive or render a card', () => {
  // Passes the substring gate ("displayOptions"+"displayMapping") but is not valid JSON.
  const truncated = '{"ok":true,"displayMapping":{},"displayOptions":[{"optionNumber":1,"price":{"amount":100'
  const view = derive([promptWithToolResult(truncated)])
  assert.notEqual(view.stage, 'search')
  assert.equal(view.chat.filter((b) => b.cards).length, 0)
})

test('assistant text keys are unique across prompts with the same frame seq', () => {
  const first = promptWithToolResult('')
  first.id = 'prompt-a'
  first.prompt = 'first'
  first.frames = [
    {
      seq: 8,
      data: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'first answer' }] },
      },
    },
  ]

  const second = promptWithToolResult('')
  second.id = 'prompt-b'
  second.prompt = 'second'
  second.frames = [
    {
      seq: 8,
      data: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'second answer' }] },
      },
    },
  ]

  const keys = derive([first, second]).chat.map((b) => b.key)
  assert.equal(new Set(keys).size, keys.length)
})
