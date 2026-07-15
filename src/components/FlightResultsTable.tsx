import { useMemo } from 'react'
import type { CompactJourney, CompactOption, CompactPrice, CompactSegment, FareSource, SearchCoverage } from '../frames.ts'
import { flightRouteCell } from '../lib/flight-display.ts'
import { stopsLabel } from '../booking.ts'

/** Shown whenever upstream data is missing. The table never substitutes data
 *  from another level or invents text — gaps stay visible so they get fixed
 *  at the source (skill/API), not papered over here. */
const NO_DATA = '--'

function dateCn(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${Number(m[2])}月${m[3]}日` : iso
}

function money(amount: number, currency: string): string {
  if (!Number.isFinite(amount) || amount <= 0 || !currency) return NO_DATA
  const prefix = currency.toUpperCase() === 'CNY' ? '¥' : `${currency} `
  return `${prefix}${amount.toLocaleString('zh-CN')}`
}

function optionPrice(o: CompactOption): string {
  return money(o.price.amount, o.price.currency)
}

function passengerCount(price: CompactPrice): number {
  return Object.values(price.perType ?? {}).reduce((sum, item) =>
    sum + (typeof item.num === 'number' && Number.isFinite(item.num) && item.num > 0 ? item.num : 0), 0)
}

function passengerTypeLabel(type: string): string {
  if (type === 'adult') return '成人'
  if (type === 'child') return '儿童'
  if (type === 'infant') return '婴儿'
  return type
}

function unitPrice(price: CompactPrice): string | null {
  const entries = Object.entries(price.perType ?? {})
    .filter(([, item]) => typeof item.unitTotal === 'number' && Number.isFinite(item.unitTotal) && item.unitTotal > 0)
  if (!entries.length) return null
  return entries.map(([type, item]) => `${passengerTypeLabel(type)} ${money(item.unitTotal ?? 0, price.currency)}/人`).join('；')
}

function partyPrice(price: CompactPrice): string {
  const display = money(price.amount, price.currency)
  const count = passengerCount(price)
  if (count > 1) return `${display}（${count}人）`
  return count === 1 ? display : `${display}（总价）`
}

function displayPrice(price: CompactPrice): string {
  return passengerCount(price) > 1 ? unitPrice(price) ?? partyPrice(price) : money(price.amount, price.currency)
}

function hasUnitPrice(price: CompactPrice): boolean {
  return unitPrice(price) !== null
}

function hasCompleteUnitPrices(option: CompactOption): boolean {
  const prices = option.blocks?.length && option.blocks.length > 1
    ? option.blocks.map((block) => block.price)
    : [option.price]
  return prices.every((price) => passengerCount(price) <= 1 || hasUnitPrice(price))
}

function sharedPassengerCount(options: CompactOption[]): number | null {
  const counts = options.map((option) => passengerCount(option.price))
  if (!counts.length || counts.some((count) => count <= 0)) return null
  return counts.every((count) => count === counts[0]) ? counts[0] ?? null : null
}

function crossDays(j: CompactJourney, s: CompactSegment): number {
  if (s.arrivalDate && s.departureDate && s.arrivalDate > s.departureDate) {
    const a = Date.parse(`${s.departureDate}T00:00:00Z`)
    const b = Date.parse(`${s.arrivalDate}T00:00:00Z`)
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.max(0, Math.round((b - a) / 86400000))
  }
  return j.arrivalCrossDays ?? 0
}

function timeCell(j: CompactJourney, s: CompactSegment): string {
  const plus = crossDays(j, s)
  return `${s.departureTime}-${s.arrivalTime}${plus ? `(+${plus})` : ''}`
}

function durationCell(j: CompactJourney): string {
  const layover = j.layovers?.length ? `（中转 ${j.layovers.join(' / ')}）` : ''
  return `${j.duration}${layover}`
}

function optionBadges(o: CompactOption, isRecommended: boolean): string[] {
  const tags = new Set<string>()
  if (isRecommended) tags.add('推荐')
  if (o.priceBasis === 'verified') tags.add('已验价')
  if (o.tag) tags.add(o.tag)
  return [...tags]
}

export function optionActionLabel(o: CompactOption): string {
  return o.priceBasis === 'verified' ? '选择' : '验价'
}

function optionSummary(o: CompactOption): string {
  const firstJourney = o.journeys[0]
  const firstSegment = firstJourney?.segments[0]
  if (!firstJourney || !firstSegment) return `方案 ${o.displayNumber ?? o.optionNumber}`
  const unit = passengerCount(o.price) > 1 ? unitPrice(o.price) : null
  const price = unit ? `${unit} · ${partyPrice(o.price)}` : optionPrice(o)
  return `方案 ${o.displayNumber ?? o.optionNumber} · ${firstSegment.flightNo} · ${timeCell(firstJourney, firstSegment)} · ${price}`
}

function passengerCountForPrompt(o: CompactOption): string {
  const perType = o.price.perType ?? {}
  const count = (type: string) => perType[type]?.num ?? 0
  const adult = count('adult')
  const child = count('child')
  const infant = count('infant')
  if (adult || child || infant) return `adult=${adult}, child=${child}, infant=${infant}`
  return '沿用本次查询的乘客人数'
}

export function buildVerifyPrompt(o: CompactOption): string {
  const selector = o.selectionLabel ?? `原始方案${o.optionNumber}`
  const checks = o.journeys.flatMap((journey, ji) =>
    journey.segments.map((segment) => {
      const role = journeyRole(o, journey, ji)
      const label = role === 'outbound' ? '去程' : role === 'inbound' ? '回程' : role === 'leg' ? `第${ji + 1}程` : ''
      return `${label}${segment.flightNo} ${segment.departureDate} ${segment.departure}${segment.arrival} ${segment.departureTime}-${segment.arrivalTime} ${segment.cabin || NO_DATA}`
    }),
  )
  const selection = o.solutionId
    ? `- solutionId: ${o.solutionId}`
    : `- ${selector}`
  const verifyCommand = o.solutionId
    ? '请使用 simplifly-flyai-skill verify --solution-id 核验这个 solutionId 的实时价格和可售性。'
    : '请使用 simplifly-flyai-skill verify 核验这个方案的实时价格和可售性。'
  return [
    o.priceBasis === 'verified'
      ? '请选择以下已验价方案，优先复用本次搜索刚保存的验价结果进入下一步；仅在结果已过期时重新请求供应商。'
      : '请对以下方案做实时验价。',
    '',
    'selection:',
    selection,
    o.solutionId ? '' : `- originalOptionNumber: ${o.optionNumber}`,
    `- passengers: ${passengerCountForPrompt(o)}`,
    '',
    'expected itinerary:',
    ...checks.map((check) => `- ${check}`),
    '',
    `expected displayed price: ${optionPrice(o)}`,
    '',
    `${verifyCommand} 验价成功后返回价格、舱位、行李是否变化；不要下单。`,
  ].filter(Boolean).join('\n')
}

function isLegacyRoundTrip(o: CompactOption): boolean {
  const [outbound, inbound] = o.journeys
  if (o.journeys.length !== 2 || !outbound || !inbound) return false
  return outbound.origin === inbound.destination && outbound.destination === inbound.origin
}

// Current results carry the skill-owned role. Route inference exists only so
// saved pre-contract results remain readable; it does not authorize actions.
function journeyRole(o: CompactOption, j: CompactJourney, index: number): NonNullable<CompactJourney['role']> {
  if (j.role) return j.role
  if (o.journeys.length === 1) return 'oneway'
  if (isLegacyRoundTrip(o)) return index === 0 ? 'outbound' : 'inbound'
  return 'leg'
}

function journeyLabel(o: CompactOption, j: CompactJourney, index: number): string {
  const stops = stopsLabel(j.transferCount)
  const role = journeyRole(o, j, index)
  if (role === 'outbound') return `去程${stops}`
  if (role === 'inbound') return `回程${stops}`
  if (role === 'leg') return `第${index + 1}程${stops}`
  return stops
}

const shortFareSourceLabel: Record<FareSource, string> = {
  roundtrip: '往返',
  joint: '联合',
  oneway: '单程',
}
const fareSourceOrder: Record<FareSource, number> = { roundtrip: 0, joint: 1, oneway: 2 }

export function fareSourceLabel(option: CompactOption): string {
  if (!option.fareSource) return NO_DATA
  const ticketCount = option.ticketGroups?.length ?? 1
  if (option.fareSource === 'roundtrip') return `往返联查 · ${ticketCount}票`
  if (option.fareSource === 'joint') return `联合查询 · ${ticketCount}票`
  if (option.fareSource === 'oneway') return ticketCount > 1 ? `单程组合 · ${ticketCount}票` : '单程 · 1票'
  const sources = [...new Set((option.ticketGroups ?? []).map((group) => shortFareSourceLabel[group.fareSource]))]
  return sources.length ? `${sources.join(' + ')} · ${ticketCount}票` : NO_DATA
}

export function searchCoverageLabel(coverage: SearchCoverage): string {
  const names = (sources: FareSource[]) => [...sources]
    .sort((left, right) => fareSourceOrder[left] - fareSourceOrder[right])
    .map((source) => shortFareSourceLabel[source])
    .join('、')
  if (coverage.status === 'complete') {
    return coverage.completed.length > 1 ? `已比较：${names(coverage.completed)}` : `已查询：${names(coverage.completed)}`
  }
  const completed = coverage.completed.length ? `已完成${names(coverage.completed)}查询` : '尚无查询完成'
  const missing = coverage.missing.length ? `未完成${names(coverage.missing)}比价` : '查询覆盖不完整'
  return `${completed}；${missing}`
}

interface FlightTableRow {
  key: string
  option: CompactOption
  optionKey: string
  optionNumber: number | ''
  journey: string
  fareSource: string
  flightNo: string
  date: string
  route: string
  time: string
  duration: string
  cabin: string
  baggage: string
  price: string   // combo: this ticket's own price (on its first row); single: the option price
  total: string   // option total (= sum of ticket prices for combos), on the option's first row
  source: string
  recommended: boolean
  badges: string[]
}

interface FlightOptionGroup {
  key: string
  title: string
  options: CompactOption[]
}

function sectionTitle(section?: string): string {
  const title = section?.trim() || '航班方案'
  return title.startsWith('【') ? title : `【${title}】`
}

function groupBySection(options: CompactOption[]): FlightOptionGroup[] {
  const groups: FlightOptionGroup[] = []
  const byKey = new Map<string, FlightOptionGroup>()
  for (const option of options) {
    const raw = option.section?.trim() || '航班方案'
    let group = byKey.get(raw)
    if (!group) {
      group = { key: raw, title: sectionTitle(raw), options: [] }
      byKey.set(raw, group)
      groups.push(group)
    }
    group.options.push(option)
  }
  return groups
}

export function buildRows(options: CompactOption[], recommendedOptions: CompactOption[]): FlightTableRow[] {
  return options.flatMap((o) => {
    let rowIndex = 0
    const totalPrice = partyPrice(o.price)
    // A combo is several separately-booked tickets: price/source per ticket,
    // using the skill-owned ticket group (blockIndex is legacy compatibility).
    const blocks = o.blocks ?? []
    const isCombo = blocks.length > 1
    const optionKey = `${o.displayNumber ?? o.optionNumber}:${o.optionNumber}:${o.journeys[0]?.segments[0]?.flightNo ?? ''}`
    const isRecommended = recommendedOptions.includes(o)
    const badges = optionBadges(o, isRecommended)
    return o.journeys.flatMap((j, ji) => {
      const blockIndex = j.ticketGroupIndex ?? j.blockIndex ?? 0
      const previousJourney = ji > 0 ? o.journeys[ji - 1] : undefined
      const prevBlockIndex = previousJourney
        ? previousJourney.ticketGroupIndex ?? previousJourney.blockIndex ?? 0
        : null
      const blockStart = prevBlockIndex === null || blockIndex !== prevBlockIndex
      const block = blocks[blockIndex]
      return j.segments.map((s, si) => {
        const first = rowIndex === 0
        const journeyFirst = si === 0
        const blockFirst = journeyFirst && blockStart
        rowIndex += 1
        return {
          key: `${optionKey}-${ji}-${si}`,
          option: o,
          optionKey,
          optionNumber: first ? (o.displayNumber ?? o.optionNumber) : '',
          journey: journeyFirst ? journeyLabel(o, j, ji) : '',
          fareSource: first ? fareSourceLabel(o) : '',
          flightNo: s.flightNo,
          date: dateCn(s.departureDate),
          route: flightRouteCell(s),
          time: timeCell(j, s),
          duration: journeyFirst ? durationCell(j) : '',
          // Segment-level facts only: a missing value renders NO_DATA rather
          // than borrowing the option-level aggregate.
          cabin: s.cabin || NO_DATA,
          baggage: s.checkedBaggage || NO_DATA,
          price: isCombo
            ? (blockFirst ? (block ? displayPrice(block.price) : NO_DATA) : '')
            : (first ? displayPrice(o.price) : ''),
          total: first ? totalPrice : '',
          source: isCombo
            ? (blockFirst ? (block?.source || NO_DATA) : '')
            : (first ? (o.source || NO_DATA) : ''),
          recommended: isRecommended,
          badges: first ? badges : [],
        }
      })
    })
  })
}

export function FlightResultsTable({
  options,
  totalCount,
  coverage,
  onBook,
  busy,
}: {
  options: CompactOption[]
  totalCount?: number
  coverage?: SearchCoverage
  onBook: (prompt: string) => void
  busy: boolean
}) {
  // A total column makes the price scope explicit for split tickets and for
  // parties. When an upstream fallback lacks a passenger split, keep the party
  // total visible instead of guessing a per-person amount.
  const showTotal = useMemo(
    () => options.some((o) => (o.blocks?.length ?? 0) > 1 || passengerCount(o.price) > 1),
    [options],
  )
  const priceHeader = useMemo(
    () => options.every(hasCompleteUnitPrices) && options.some((o) => passengerCount(o.price) > 1)
      ? '单价（含税/人）'
      : '价格（含税）',
    [options],
  )
  const totalHeader = useMemo(() => {
    const count = sharedPassengerCount(options)
    return count ? `${count}人总价` : '总价（含税）'
  }, [options])
  const groups = useMemo(() => groupBySection(options), [options])
  // The skill tags its own picks (最低价 / 直飞最快 / 综合推荐); highlight those.
  const recommendedOptions = useMemo(
    () => options.filter((o) => /推荐|综合/.test(o.tag ?? '')),
    [options],
  )
  const rowsByGroup = useMemo(() =>
    groups.map((group) => ({ ...group, rows: buildRows(group.options, recommendedOptions) })),
  [groups, recommendedOptions])

  return (
    <div className="results flight-table-block">
      <div className="results-head flight-results-summary">
        <h2>航班方案</h2>
        <span className="muted">{totalCount ? `共匹配 ${totalCount} 条，` : ''}显示 {options.length} 个方案</span>
      </div>
      {coverage ? (
        <div className={`flight-search-coverage ${coverage.status === 'complete' ? '' : 'is-warning'}`.trim()}>
          {searchCoverageLabel(coverage)}
        </div>
      ) : null}
      {recommendedOptions.length ? (
        <div className="flight-recommend">
          <span className="option-badge">推荐</span>
          <span>{recommendedOptions.map(optionSummary).join('；')}</span>
        </div>
      ) : null}
      {rowsByGroup.map((group) => (
        <section key={group.key} className="flight-section">
          <h3>{group.title}</h3>
          <div className="table-scroll">
            <table className="flight-table">
              <thead>
                <tr>
                  <th>方案</th>
                  <th>操作</th>
                  <th>航程</th>
                  <th>票价来源</th>
                  <th>航班号</th>
                  <th>日期</th>
                  <th>航段</th>
                  <th>时间</th>
                  <th>飞行时长</th>
                  <th>舱位</th>
                  <th>行李</th>
                  <th>{priceHeader}</th>
                  {showTotal ? <th>{totalHeader}</th> : null}
                  <th>供应渠道</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.key} className={row.recommended ? 'recommended' : undefined}>
                    <td className="option-cell">
                      {row.optionNumber ? (
                        <div className="option-mark">
                          <span className="option-num">{row.optionNumber}</span>
                          {row.badges.map((badge) => <span key={badge} className="option-badge">{badge}</span>)}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {row.optionNumber ? (
                        <div className="flight-actions">
                          <button type="button" disabled={busy} onClick={() => onBook(buildVerifyPrompt(row.option))}>{optionActionLabel(row.option)}</button>
                        </div>
                      ) : null}
                    </td>
                    <td>{row.journey}</td>
                    <td>{row.fareSource}</td>
                    <td className="mono">{row.flightNo}</td>
                    <td>{row.date}</td>
                    <td className="route-cell">{row.route}</td>
                    <td className="mono">{row.time}</td>
                    <td>{row.duration}</td>
                    <td>{row.cabin}</td>
                    <td>{row.baggage}</td>
                    <td className="num">{row.price}</td>
                    {showTotal ? <td className="num">{row.total}</td> : null}
                    <td>{row.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}
