import { useEffect, useRef, useState } from 'react'

import type {
  FlightRecommendations,
  RecommendationJourney,
  RecommendationPlan,
  RecommendationStatus,
  SearchResult,
} from '../frames.ts'
import { cabinLabel, paxLabel } from '../booking.ts'
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

function fareSourceLabel(source: string): string {
  if (source === 'roundtrip') return '往返票'
  if (source === 'joint') return '联合 / 开口程票'
  return '单程票'
}

function planTotal(plan: RecommendationPlan) {
  return plan.customerQuoteTotal ?? plan.verifiedFareTotal
}

function windowLabel(plan: RecommendationPlan): string {
  return plan.windows
    .slice()
    .sort((left, right) => left.journeyIndex - right.journeyIndex)
    .map((item) => `${roleLabel(plan.journeys[item.journeyIndex]!, item.journeyIndex)} ${item.window}`)
    .join(' · ')
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
  return (
    <div className="recommend-copy">
      <button type="button" disabled={state === 'copying'} onClick={onCopy}>
        {state === 'copying' ? '复制中…' : state === 'copied' ? '已复制' : 'Copy'}
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

function JourneyCard({ plan, journey, index }: { plan: RecommendationPlan; journey: RecommendationJourney; index: number }) {
  const first = journey.segments[0]!
  const last = journey.segments[journey.segments.length - 1]!
  const route = journey.segments.map(flightRouteCell).join(' / ')
  const flightNumbers = journey.segments.map((segment) => segment.flightNo).join(' → ')
  const relevantTickets = plan.ticketGroups.filter((group) => group.journeyIndexes.includes(index))
  return (
    <section className="recommend-journey" aria-labelledby={`${plan.planId}-${journey.journeyId}`}>
      <div className="recommend-journey-head">
        <h4 id={`${plan.planId}-${journey.journeyId}`}>
          {roleLabel(journey, index)} · {journey.origin} → {journey.destination}
          {journey.routePriority === 'alternate' ? <span className="recommend-route-priority">备选路线</span> : null}
        </h4>
        <span>{journey.transferCount ? `中转 ${journey.transferCount} 次` : '直飞'}</span>
      </div>
      <div className="recommend-flight-facts">
        <strong className="mono">{flightNumbers}</strong>
        <span>{flightDateCn(first.departureDate)} · {first.departureTime}–{last.arrivalTime}{last.arrivalDate > first.departureDate ? ' (+1)' : ''}</span>
        <span>{route} · {journey.duration}</span>
      </div>
      <div className="recommend-cabin-lines" aria-label="乘客和舱位">
        {relevantTickets.map((ticket) => {
          const passengers = plan.passengerGroups.find((group) => group.passengerGroupId === ticket.passengerGroupId)!
          return (
            <div key={ticket.ticketGroupId}>
              <span><strong>{passengerSummary(passengers)} · {ticket.cabin ?? cabinLabel(passengers.cabinClass)}</strong>{ticket.baggage ? ` · ${ticket.baggage}` : ''}</span>
              <span className="muted">
                {ticket.journeyIndexes.length === 1
                  ? recommendationMoney(ticket.verifiedPrice.amount, ticket.verifiedPrice.currency)
                  : '多程票总价见下方票组'}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function PlanCard({ plan, busy, onAction }: {
  plan: RecommendationPlan
  busy: boolean
  onAction: (prompt: string) => void
}) {
  const total = planTotal(plan)
  return (
    <article className="recommend-plan" aria-labelledby={`${plan.planId}-title`}>
      <header className="recommend-plan-head">
        <div>
          <span className="recommend-kicker">{windowLabel(plan)}</span>
          <h3 id={`${plan.planId}-title`}>{plan.label || '航班推荐方案'}</h3>
          <span className="recommend-validity">{plan.validity.status === 'expired' ? '价格已过期' : '实时查询价'}</span>
        </div>
        <div className="recommend-plan-total">
          <strong>{recommendationMoney(total.amount, total.currency)}</strong>
          <span>{plan.customerQuoteTotal ? '客户报价总价' : '查询总价'}</span>
        </div>
        <div className="recommend-actions">
          <CopyAction plan={plan} />
          {plan.capabilities.canReverify ? (
            <button type="button" disabled={busy} onClick={() => onAction(buildRecommendationRetryPrompt(plan.planId))}>重新验价</button>
          ) : null}
        </div>
      </header>

      <div className="recommend-journeys">
        {plan.journeys.map((journey, index) => <JourneyCard key={journey.journeyId} plan={plan} journey={journey} index={index} />)}
      </div>

      <section className="recommend-tickets" aria-label="票组明细">
        <h4>票组</h4>
        {plan.ticketGroups.map((ticket) => {
          const passengers = plan.passengerGroups.find((group) => group.passengerGroupId === ticket.passengerGroupId)!
          const journeys = ticket.journeyIndexes.map((journeyIndex) => roleLabel(plan.journeys[journeyIndex]!, journeyIndex)).join(' + ')
          return (
            <div key={ticket.ticketGroupId} className="recommend-ticket-row">
              <span><strong>{passengerSummary(passengers)} · {fareSourceLabel(ticket.fareSource)}</strong> · 覆盖 {journeys}{ticket.source ? ` · ${ticket.source}` : ''}</span>
              <strong>{recommendationMoney(ticket.verifiedPrice.amount, ticket.verifiedPrice.currency)}</strong>
            </div>
          )
        })}
      </section>

      {plan.explanation ? (
        <p className="recommend-explanation">
          {plan.explanation.reason}{plan.explanation.limitation ? ` 局限：${plan.explanation.limitation}` : ''}
        </p>
      ) : null}
    </article>
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
        <div className="recommend-plan-list">
          {result.plans.map((plan) => <PlanCard key={plan.planId} plan={plan} busy={busy} onAction={onAction} />)}
        </div>
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
