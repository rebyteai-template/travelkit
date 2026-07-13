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
        journeyType: '直飞',
        duration: '2h',
        durationMinutes: 120,
        cabin: '经济 H舱',
        baggage: '托运1*23kg',
        hasCheckedBaggage: true,
        price: { amount, currency: 'CNY' },
        journeys: [
          {
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
  }
}

test('derive parses compact search JSON before trailing shell output', () => {
  const compact = compactSearch(1, 'MU5186', 1000)

  const view = derive([promptWithToolResult(`${JSON.stringify(compact)}\nShell cwd was reset to /code\n`)])
  assert.equal(view.stage, 'search')
  assert.equal(view.search?.options.length, 1)
  assert.equal(view.search?.options[0]?.solutionId, 'sol-mu5186')
  assert.equal(view.search?.options[0]?.blocks, undefined)
  assert.equal(view.chat.at(-1)?.cards?.length, 1)
})

test('derive parses combo blocks (per-ticket price/source) and journey blockIndex', () => {
  const compact = compactSearch(1, 'MU0583', 46071)
  const combo = compact.displayOptions[0] as Record<string, unknown>
  combo.solutionId = 'combo:abc123'
  combo.price = { amount: 46071, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 15357, subtotal: 46071 } } }
  combo.journeys = [
    { ...(combo.journeys as Record<string, unknown>[])[0], blockIndex: 0 },
    { ...(combo.journeys as Record<string, unknown>[])[0], blockIndex: 1 },
  ]
  combo.blocks = [
    { price: { amount: 45021, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 15007, subtotal: 45021 } } }, source: '美亚' },
    { price: { amount: 1050, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 350, subtotal: 1050 } } } },
  ]

  const view = derive([promptWithToolResult(JSON.stringify(compact))])
  const option = view.search?.options[0]
  assert.deepEqual(option?.journeys.map((j) => j.blockIndex), [0, 1])
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

function compactVerify(flightNo: string, amount: number) {
  return {
    ok: true,
    selectedOption: { optionNumber: 1 },
    verifiedOption: {
      price: { amount, currency: 'CNY' },
      journeys: [
        {
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
              departureDate: '2026-10-02',
              departureTime: '11:20',
              arrival: 'BUF',
              arrivalDate: '2026-10-02',
              arrivalTime: '20:05',
              cabin: '经济 T舱',
            },
          ],
        },
      ],
    },
  }
}

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
