import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildRows, buildVerifyPrompt } from '../src/components/FlightResultsTable.tsx'
import type { CompactOption } from '../src/frames.ts'

const option: CompactOption = {
  optionNumber: 1,
  solutionId: 'sol-direct-bag',
  displayNumber: 3,
  journeyType: '直飞',
  duration: '2h20m',
  durationMinutes: 140,
  cabin: '经济 H舱',
  baggage: '托运1*23kg',
  hasCheckedBaggage: true,
  price: {
    amount: 1280,
    currency: 'CNY',
    perType: { adult: { num: 2, unitTotal: 640, subtotal: 1280 } },
  },
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
          flightNo: 'MU5186',
          departure: 'PEK',
          departureDate: '2026-08-05',
          departureTime: '07:45',
          arrival: 'SHA',
          arrivalDate: '2026-08-05',
          arrivalTime: '10:05',
          cabin: '经济 H舱',
          checkedBaggage: '托运1*23kg',
        },
      ],
    },
  ],
}

test('buildVerifyPrompt binds verify to solutionId and includes row facts', () => {
  const prompt = buildVerifyPrompt(option)

  assert.match(prompt, /solutionId: sol-direct-bag/)
  assert.match(prompt, /verify --solution-id/)
  assert.match(prompt, /passengers: adult=2, child=0, infant=0/)
  assert.match(prompt, /MU5186 2026-08-05 PEKSHA 07:45-10:05 经济 H舱/)
  assert.match(prompt, /expected displayed price: ¥1,280/)
  assert.doesNotMatch(prompt, /表格序号|displayNumber/)
})

const comboLeg = (flightNo: string, from: string, to: string, date: string) => ({
  origin: from,
  destination: to,
  departureDate: date,
  departureTime: '10:00',
  arrivalDate: date,
  arrivalTime: '14:00',
  duration: '4h',
  transferCount: 0,
  segments: [
    { flightNo, departure: from, departureDate: date, departureTime: '10:00', arrival: to, arrivalDate: date, arrivalTime: '14:00', cabin: '经济' },
  ],
})

const comboOption: CompactOption = {
  optionNumber: 1,
  solutionId: 'combo:9064d66cf1ca49',
  journeyType: '多程',
  duration: '40h',
  durationMinutes: 2400,
  cabin: '经济',
  baggage: '托运1*23kg',
  hasCheckedBaggage: true,
  price: { amount: 46071, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 15357, subtotal: 46071 } } },
  journeys: [
    comboLeg('MU0583', 'PVG', 'LAX', '2026-09-27'),
    comboLeg('DL1194', 'LAX', 'SLC', '2026-09-29'),
    comboLeg('WN3888', 'SLC', 'BUF', '2026-10-02'),
    comboLeg('MU0588', 'JFK', 'PVG', '2026-10-07'),
  ],
}

test('buildVerifyPrompt on a 4-leg combo binds the combo solutionId and lists every leg', () => {
  const prompt = buildVerifyPrompt(comboOption)

  assert.match(prompt, /solutionId: combo:9064d66cf1ca49/)
  assert.match(prompt, /verify --solution-id/)
  assert.match(prompt, /passengers: adult=3, child=0, infant=0/)
  for (const flightNo of ['MU0583', 'DL1194', 'WN3888', 'MU0588']) {
    assert.match(prompt, new RegExp(flightNo))
  }
  assert.match(prompt, /expected displayed price: ¥46,071/)
})

test('combo rows show each ticket price/source on its block first row and the sum as 总价', () => {
  const combo: CompactOption = {
    ...comboOption,
    journeys: comboOption.journeys.map((j, i) => ({ ...j, blockIndex: i })),
    blocks: [
      { price: { amount: 20001, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 6667, subtotal: 20001 } } }, source: '美亚' },
      { price: { amount: 1050, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 350, subtotal: 1050 } } }, source: 'yinling' },
      { price: { amount: 2658, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 886, subtotal: 2658 } } }, source: 'yinling' },
      { price: { amount: 22362, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 7454, subtotal: 22362 } } } },
    ],
  }

  const rows = buildRows([combo], [])
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map((r) => r.price), ['成人 ¥6,667/人', '成人 ¥350/人', '成人 ¥886/人', '成人 ¥7,454/人'])
  assert.deepEqual(rows.map((r) => r.source), ['美亚', 'yinling', 'yinling', '--'])
  assert.deepEqual(rows.map((r) => r.total), ['¥46,071（3人）', '', '', ''])
})

test('a jointly-booked block (two journeys, one ticket) prices only its first row', () => {
  const combo: CompactOption = {
    ...comboOption,
    journeys: [
      { ...comboLeg('MU0583', 'PVG', 'LAX', '2026-09-27'), blockIndex: 0 },
      { ...comboLeg('MU0588', 'JFK', 'PVG', '2026-10-07'), blockIndex: 0 },
      { ...comboLeg('DL1194', 'LAX', 'SLC', '2026-09-29'), blockIndex: 1 },
    ],
    blocks: [
      { price: { amount: 45000, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 15000, subtotal: 45000 } } }, source: '美亚' },
      { price: { amount: 1071, currency: 'CNY', perType: { adult: { num: 3, unitTotal: 357, subtotal: 1071 } } }, source: 'yinling' },
    ],
  }

  const rows = buildRows([combo], [])
  assert.deepEqual(rows.map((r) => r.price), ['成人 ¥15,000/人', '', '成人 ¥357/人'])
  assert.deepEqual(rows.map((r) => r.source), ['美亚', '', 'yinling'])
  assert.deepEqual(rows.map((r) => r.total), ['¥46,071（3人）', '', ''])
})

test('a single-ticket option shows the unit price and party total', () => {
  const rows = buildRows([option], [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.price, '成人 ¥640/人')
  assert.equal(rows[0]?.total, '¥1,280（2人）')
  assert.equal(rows[0]?.source, '--')
})
