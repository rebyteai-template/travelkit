import { useEffect, useRef, useState } from 'react'

import type {
  FareSource,
  FlightRecommendations,
  RecommendationJourney,
  RecommendationPlan,
  RecommendationStatus,
  SearchResult,
} from '../frames.ts'
import { paxLabel } from '../booking.ts'
import { flightDateCn, flightMoney, flightRouteCell, journeyRoleLabel } from '../lib/flight-display.ts'
import { FlightResultsTable } from './FlightResultsTable.tsx'

export function recommendationMoney(amount: number, currency: string): string {
  return flightMoney(amount, currency)
}

export function recommendationStatusLabel(status: RecommendationStatus): string {
  if (status === 'loading') return '正在生成推荐方案'
  if (status === 'partial') return '推荐结果不完整'
  if (status === 'empty') return '没有符合条件的方案'
  if (status === 'expired') return '航班推荐'
  if (status === 'fatal_error') return '推荐生成失败'
  return '航班推荐'
}

export function buildRecommendationRetryPrompt(planId?: string): string {
  return planId
    ? `请重新验证推荐方案 planId: ${planId}，并返回新的 flight.recommendations 结构化结果。`
    : '请重新运行航班推荐，并返回新的 flight.recommendations 结构化结果。'
}

function passengerSummary(group: RecommendationPlan['passengerGroups'][number]): string {
  const labels = [
    group.passengers.adult ? `${group.passengers.adult} ${paxLabel('adult')}` : '',
    group.passengers.child ? `${group.passengers.child} ${paxLabel('child')}` : '',
    group.passengers.infant ? `${group.passengers.infant} ${paxLabel('infant')}` : '',
  ].filter(Boolean)
  return labels.join('、')
}

function roleLabel(journey: RecommendationJourney, index: number): string {
  return journeyRoleLabel(journey.role, index)
}

function fareSourceLabel(source: FareSource): string {
  if (source === 'roundtrip') return '往返查询'
  if (source === 'joint') return '联合查询'
  return '单独查询'
}

function planTotal(plan: RecommendationPlan) {
  return plan.customerQuoteTotal ?? plan.verifiedFareTotal
}

function passengerCount(group: RecommendationPlan['passengerGroups'][number]): number {
  return group.passengers.adult + group.passengers.child + group.passengers.infant
}

function ticketUnitPrice(
  ticket: RecommendationPlan['ticketGroups'][number],
  passengers: RecommendationPlan['passengerGroups'][number],
): string {
  const count = passengerCount(passengers)
  if (count <= 0) return recommendationMoney(ticket.verifiedPrice.amount, ticket.verifiedPrice.currency)
  const amount = Math.round((ticket.verifiedPrice.amount / count) * 100) / 100
  return `${recommendationMoney(amount, ticket.verifiedPrice.currency)}/人`
}

function CopyAction({ plan }: { plan: RecommendationPlan }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const resetTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  async function onCopy() {
    setState('copying')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(plan.copyText)
      setState('copied')
      window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => setState('idle'), 1600)
    } catch {
      setState('error')
    }
  }

  if (!plan.capabilities.canCopy) return null
  const copied = state === 'copied'
  return (
    <div className="recommend-copy">
      <button
        type="button"
        className={`recommend-copy-action ${copied ? 'is-copied' : ''}`.trim()}
        disabled={state === 'copying'}
        onClick={onCopy}
      >
        {copied ? (
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8 3 3 6-7" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="7" rx="1.5" /><path d="M10.5 5.5v-2h-7v7h2" /></svg>
        )}
        <span>{state === 'copying' ? '复制中…' : copied ? '已复制' : state === 'error' ? '复制失败' : '复制'}</span>
      </button>
      <span className="sr-only" aria-live="polite">
        {state === 'copied' ? '方案已复制到剪贴板' : state === 'error' ? '无法访问剪贴板，请手动复制' : ''}
      </span>
      {state === 'error' ? (
        <label className="recommend-copy-fallback">
          <span>无法访问剪贴板，请手动复制：</span>
          <textarea readOnly value={plan.copyText} onFocus={(event) => event.currentTarget.select()} />
        </label>
      ) : null}
    </div>
  )
}

function segmentPassengerFacts(plan: RecommendationPlan, journeyIndex: number, segmentIndex: number) {
  return plan.passengerGroups.map((passengers) => {
    const ticket = plan.ticketGroups.find((group) =>
      group.passengerGroupId === passengers.passengerGroupId && group.journeyIndexes.includes(journeyIndex))
    const fact = ticket?.segmentFacts?.find((item) =>
      item.journeyIndex === journeyIndex && item.segmentIndex === segmentIndex)
    return {
      id: passengers.passengerGroupId,
      passengers: passengerSummary(passengers),
      cabin: fact?.cabin ?? '未返回',
      baggage: fact?.baggage ?? '未返回',
    }
  })
}

function SegmentFactLines({ plan, journeyIndex, segmentIndex, field }: {
  plan: RecommendationPlan
  journeyIndex: number
  segmentIndex: number
  field: 'cabin' | 'baggage'
}) {
  const rows = segmentPassengerFacts(plan, journeyIndex, segmentIndex)
  return (
    <div className="recommend-detail-lines">
      {rows.map((row) => (
        <div key={row.id}><strong>{row.passengers}</strong><span> · {row[field]}</span></div>
      ))}
    </div>
  )
}

function PlanSummary({ plan, busy, onAction }: {
  plan: RecommendationPlan
  busy: boolean
  onAction: (prompt: string) => void
}) {
  const total = planTotal(plan)
  return (
    <div className="recommend-plan-summary">
      <div className="recommend-plan-title-row">
        <strong className="recommend-plan-label">{plan.label || '未返回'}</strong>
        <CopyAction plan={plan} />
      </div>
      <div className="recommend-plan-total">
        <span className="recommend-plan-total-label">总价</span>
        <strong className="recommend-plan-total-amount mono">{recommendationMoney(total.amount, total.currency)}</strong>
      </div>
      <ul className="recommend-plan-journeys">
        {plan.journeys.map((journey, journeyIndex) => (
          <li key={journey.journeyId}>
            <span>第{journeyIndex + 1}程</span>
            <span className="mono">{plan.windows.find((item) => item.journeyIndex === journeyIndex)?.window ?? '未返回'}</span>
          </li>
        ))}
      </ul>
      {plan.validity.status === 'expired' ? (
        <span className="recommend-validity">价格已过期</span>
      ) : null}
      {plan.capabilities.canReverify ? (
        <div className="recommend-actions">
          <button type="button" disabled={busy} onClick={() => onAction(buildRecommendationRetryPrompt(plan.planId))}>重新验价</button>
        </div>
      ) : null}
    </div>
  )
}

function TicketPriceLines({ plan, tickets }: {
  plan: RecommendationPlan
  tickets: RecommendationPlan['ticketGroups']
}) {
  return (
    <div className="recommend-ticket-lines recommend-price-lines">
      {tickets.map((ticket) => {
        const passengers = plan.passengerGroups.find((group) => group.passengerGroupId === ticket.passengerGroupId)!
        return (
          <div key={ticket.ticketGroupId}>
            <span className={`recommend-source-badge is-${ticket.fareSource}`}>{fareSourceLabel(ticket.fareSource)}</span>
            <strong>{passengerSummary(passengers)}</strong>
            <strong className="recommend-fare-price mono">{ticketUnitPrice(ticket, passengers)}</strong>
          </div>
        )
      })}
    </div>
  )
}

function TicketSourceLines({ plan, tickets }: {
  plan: RecommendationPlan
  tickets: RecommendationPlan['ticketGroups']
}) {
  return (
    <div className="recommend-ticket-lines recommend-channel-lines">
      {tickets.map((ticket) => {
        const passengers = plan.passengerGroups.find((group) => group.passengerGroupId === ticket.passengerGroupId)!
        return (
          <div key={ticket.ticketGroupId}>
            <strong>{passengerSummary(passengers)}</strong>
            <span> · {ticket.source || '未返回'}</span>
          </div>
        )
      })}
    </div>
  )
}

function recommendationRows(plan: RecommendationPlan) {
  return plan.journeys.flatMap((journey, journeyIndex) =>
    journey.segments.map((segment, segmentIndex) => {
      const tickets = segmentIndex === 0
        ? plan.ticketGroups.filter((ticket) => Math.min(...ticket.journeyIndexes) === journeyIndex)
        : []
      const row = {
        journey,
        journeyIndex,
        segment,
        segmentIndex,
        tickets,
        isFirstPlanRow: journeyIndex === 0 && segmentIndex === 0,
        isFirstJourneyRow: segmentIndex === 0,
      }
      return row
    }),
  )
}

function RecommendationTable({ plans, busy, onAction }: {
  plans: RecommendationPlan[]
  busy: boolean
  onAction: (prompt: string) => void
}) {
  return (
    <div className="table-scroll recommend-table-scroll">
      <table className="recommend-table">
        <thead>
          <tr>
            <th scope="col">方案</th>
            <th scope="col">航程</th>
            <th scope="col">航班号</th>
            <th scope="col">日期</th>
            <th scope="col">航段</th>
            <th scope="col">时间</th>
            <th scope="col">飞行时长</th>
            <th scope="col">舱位</th>
            <th scope="col">行李</th>
            <th scope="col">价格</th>
            <th scope="col">供应渠道</th>
          </tr>
        </thead>
        {plans.map((plan) => {
          const rows = recommendationRows(plan)
          return (
            <tbody key={plan.planId} className="recommend-plan-group">
              {rows.map((row) => (
              <tr
                key={`${row.journey.journeyId}-${row.segmentIndex}`}
                className={`recommend-segment-row ${row.isFirstJourneyRow ? 'is-journey-start' : ''}`.trim()}
              >
                {row.isFirstPlanRow ? (
                  <th scope="rowgroup" rowSpan={rows.length} className="recommend-plan-cell">
                    <PlanSummary plan={plan} busy={busy} onAction={onAction} />
                  </th>
                ) : null}
                {row.isFirstJourneyRow ? (
                  <th scope="rowgroup" rowSpan={row.journey.segments.length} className="recommend-journey-cell">
                    <div className="recommend-journey-summary">
                      <strong>{roleLabel(row.journey, row.journeyIndex)}</strong>
                      <span> · {row.journey.transferCount ? `中转 ${row.journey.transferCount} 次` : '直飞'}</span>
                    </div>
                  </th>
                ) : null}
                <td className="recommend-flight-cell">
                  <strong className="mono">{row.segment.flightNo}</strong>
                </td>
                <td className="recommend-date-cell">{flightDateCn(row.segment.departureDate)}</td>
                <td className="recommend-route-cell">
                  {flightRouteCell(row.segment)}
                </td>
                <td className="recommend-time-cell mono">
                  {row.segment.departureTime}–{row.segment.arrivalTime}
                  {row.segment.arrivalDate > row.segment.departureDate ? ' (+1)' : ''}
                </td>
                <td className="recommend-duration-cell mono">
                  {row.segment.flightTime ?? '未返回'}
                </td>
                <td className="recommend-cabin-cell">
                  <SegmentFactLines plan={plan} journeyIndex={row.journeyIndex} segmentIndex={row.segmentIndex} field="cabin" />
                </td>
                <td className="recommend-baggage-cell">
                  <SegmentFactLines plan={plan} journeyIndex={row.journeyIndex} segmentIndex={row.segmentIndex} field="baggage" />
                </td>
                <td className="recommend-fare-cell">
                  {row.tickets.length ? <TicketPriceLines plan={plan} tickets={row.tickets} /> : null}
                </td>
                <td className="recommend-channel-cell">
                  {row.tickets.length ? <TicketSourceLines plan={plan} tickets={row.tickets} /> : null}
                </td>
              </tr>
              ))}
            </tbody>
          )
        })}
      </table>
    </div>
  )
}

export function FlightRecommendationsView({ result, evidence = [], busy, onAction }: {
  result: FlightRecommendations
  evidence?: SearchResult[]
  busy: boolean
  onAction: (prompt: string) => void
}) {
  const [evidenceOpened, setEvidenceOpened] = useState(false)
  const isAlert = result.status === 'fatal_error' || result.status === 'empty'
  const explicitStatusText = result.message || result.reason
  const showState = result.plans.length === 0 || result.status === 'loading' || Boolean(explicitStatusText)
  const hasRetry = result.capabilities.canRetry

  return (
    <section
      className="recommendations"
      aria-labelledby={showState ? 'recommendations-title' : undefined}
      aria-label={showState ? undefined : '航班推荐'}
    >
      {showState ? (
        <div
          className={`recommendations-state ${isAlert ? 'is-error' : ''}`.trim()}
          role={isAlert ? 'alert' : 'status'}
          aria-live="polite"
          aria-busy={result.status === 'loading'}
        >
          <div>
            <span className="recommend-kicker">航班推荐</span>
            <h2 id="recommendations-title">{result.plans.length ? '航班推荐' : recommendationStatusLabel(result.status)}</h2>
            {explicitStatusText ? <p>{explicitStatusText}</p> : null}
          </div>
          {hasRetry ? <button type="button" disabled={busy} onClick={() => onAction(buildRecommendationRetryPrompt())}>重试推荐</button> : null}
        </div>
      ) : null}

      {!showState && hasRetry ? (
        <div className="recommendations-actions">
          <button type="button" disabled={busy} onClick={() => onAction(buildRecommendationRetryPrompt())}>重试推荐</button>
        </div>
      ) : null}

      {result.plans.length ? (
        <RecommendationTable plans={result.plans} busy={busy} onAction={onAction} />
      ) : null}

      {evidence.length ? (
        <details className="recommend-evidence" onToggle={(event) => {
          if (event.currentTarget.open) setEvidenceOpened(true)
        }}>
          <summary>查看中间搜索证据（{evidence.length} 组）</summary>
          {evidenceOpened ? (
            <div className="recommend-evidence-list">
              {evidence.map((search, index) => (
                <FlightResultsTable
                  key={index}
                  options={search.options}
                  totalCount={search.totalCount}
                  coverage={search.coverage}
                  readOnly
                />
              ))}
            </div>
          ) : null}
        </details>
      ) : null}
    </section>
  )
}
