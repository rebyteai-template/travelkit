import { useEffect, useRef, useState } from 'react'

import type {
  CompactPrice,
  FareSource,
  FlightRecommendations,
  RecommendationJourney,
  RecommendationPlan,
  RecommendationStatus,
  SearchResult,
} from '../frames.ts'
import { adultUnitPrice, unquotableReason } from '../lib/ctrip-target.ts'

import type { ReferencePrice } from '../api.ts'
import { paxSummary, planTotal } from '../booking.ts'
import { buildRecommendationContinuationPrompt, buildRecommendationRetryPrompt } from '../operator-actions.ts'
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

function passengerSummary(group: RecommendationPlan['passengerGroups'][number]): string {
  return paxSummary(group.passengers)
}

function roleLabel(journey: RecommendationJourney, index: number): string {
  return journeyRoleLabel(journey.role, index)
}

function fareSourceLabel(source: FareSource): string {
  if (source === 'roundtrip') return '往返查询'
  if (source === 'joint') return '联合查询'
  return '单独查询'
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

/** The Chrome Web Store listing. UNLISTED: it never appears in store search, so this link is the
 *  one and only distribution channel — the cell offers it wherever a read button would sit. */
const EXTENSION_STORE_URL = 'https://chromewebstore.google.com/detail/dgggiiccaeaihlkpdabinmiighgdgkhc'

/** The whole Ctrip-comparison capability as one prop. Granting the object grants the cell, the
 *  way `onStartBooking` grants the booking entry; a caller with nowhere to store a reading passes
 *  nothing and renders no cell. Grouped so a shape change is one name in each signature instead
 *  of a four-signature ripple (which this feature has already paid once). */
export interface CtripCompare {
  /** planId → the stored comparison figure. */
  prices?: Record<string, ReferencePrice>
  /** Present only when a browser extension answered. Absent = no Ctrip figure can be obtained
   *  here at all; the plan's 携程比价 link is what remains. */
  onCapture?: (plan: RecommendationPlan) => Promise<void>
  /** Whether an extension answered the bridge ping. `false` puts the install link where the read
   *  button would be; `null` (the announce window is still open) renders neither, so a slow
   *  handshake does not flash an install hint at an operator who has the extension. */
  installed?: boolean | null
  /** planId → that plan's last failure reason. Per plan on purpose: one shared string painted
   *  every priceless cell with whichever plan failed last. */
  errors?: Record<string, string>
  /** Build stamp of the answering extension, surfaced as the button's tooltip. */
  version?: string | null
}

/**
 * The Ctrip comparison for one plan.
 *
 * Both figures shown here are PER ADULT. Ctrip prices one adult; our plan total covers every
 * passenger, so it is divided down by `adultUnitPrice` before the two are put side by side —
 * without that, a two-adult booking reads as though we were twice the price. The remaining
 * difference in basis is TAX: Ctrip's search fare excludes the airport fee and fuel surcharge,
 * ours includes them, and the plan carries no tax-exclusive figure to subtract. So the gap is
 * shown with that stated, and in the direction it actually errs — we look dearer than we are.
 *
 * It never judges the plan: no reordering, no dropping, no "cheaper elsewhere" warning
 * (CLAUDE.md 推荐边界) — it shows the numbers and stops.
 */
function ReferencePriceCell({ plan, price, onCapture, installed, captureError, captureVersion }: {
  plan: RecommendationPlan
  price?: ReferencePrice
  onCapture?: (plan: RecommendationPlan) => Promise<void>
  installed?: boolean | null
  captureError?: string | null
  captureVersion?: string | null
}) {
  const [capturing, setCapturing] = useState(false)

  const ourAdult = adultUnitPrice(plan)
  const blocked = unquotableReason(plan)

  async function runCapture() {
    if (!onCapture) return
    setCapturing(true)
    try {
      await onCapture(plan)
    } finally {
      setCapturing(false)
    }
  }

  const canCapture = Boolean(onCapture && !blocked)

  if (price) {
    // Compare like with like: per adult on both sides, or not at all.
    const comparable = ourAdult && price.currency === ourAdult.currency
    const gap = comparable ? Math.round((ourAdult.amount - price.amount) * 100) / 100 : null
    return (
      <div className="recommend-reference">
        <span className="recommend-reference-label">
          携程{price.source === 'ctrip-extension' ? '（插件读取）' : ''}
        </span>
        <strong className="recommend-reference-amount mono">
          {recommendationMoney(price.amount, price.currency)}
        </strong>
        <span className="recommend-reference-basis">/成人·不含税</span>
        {comparable && gap !== null ? (
          <span className={`recommend-reference-gap ${gap <= 0 ? 'is-cheaper' : 'is-dearer'}`}>
            我们 <span className="mono">{recommendationMoney(ourAdult.amount, ourAdult.currency)}</span>
            /成人·含税 ·
            {gap <= 0 ? ' 低 ' : ' 高 '}
            <span className="mono">{recommendationMoney(Math.abs(gap), ourAdult.currency)}</span>
            <span
              className="recommend-reference-caveat"
              title="携程为不含税票面价，我们含机建与燃油。实际差距比此处显示的更有利于我们；上游提供税前价后才能精确对齐。"
            >
              含税差未扣
            </span>
          </span>
        ) : (
          <span className="recommend-reference-caveat" title="该方案无纯成人票组或币种不同，无法按成人单价对齐">
            无法按成人单价对齐
          </span>
        )}
        {/* Re-read, not edit: every figure in this cell comes from Ctrip's own payload, so a
            wrong-looking number is fixed by reading again, never by typing over it. */}
        {canCapture ? (
          <button
            type="button"
            className="recommend-reference-capture"
            disabled={capturing}
            title={captureVersion ? `携程比价插件 ${captureVersion}` : undefined}
            onClick={() => void runCapture()}
          >
            {capturing ? '读取中…' : '重新读取'}
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="recommend-reference">
      <span className="recommend-reference-label">携程价</span>
      {canCapture ? (
        <button
          type="button"
          className="recommend-reference-capture"
          disabled={capturing}
          title={captureVersion ? `携程比价插件 ${captureVersion}` : undefined}
          onClick={() => void runCapture()}
        >
          {capturing ? '读取中…' : '自动读取'}
        </button>
      ) : blocked ? (
        /* Why there is no button, so its absence does not read as a broken extension. The plan's
           own 携程比价 link is still right there for anyone who wants to look. */
        <span className="recommend-reference-caveat">{blocked}</span>
      ) : installed === false ? (
        /* No extension answered: the read entry becomes the install entry. Chrome does not
           inject content scripts into already-open tabs on install, hence the reload note.
           `installed === null` (the announce window is still open) deliberately renders
           NOTHING here — see CtripCompare.installed. */
        <a
          className="recommend-reference-install"
          href={EXTENSION_STORE_URL}
          target="_blank"
          rel="noreferrer noopener"
          title="从 Chrome 应用商店安装比价插件（凭此链接安装，商店内搜索不到）；装好后刷新本页即可使用"
        >
          安装比价插件
        </a>
      ) : null}
      {captureError ? <span className="recommend-reference-error">{captureError}</span> : null}
    </div>
  )
}

function PlanSummary({ plan, busy, onAction, onStartBooking, ctripCompare }: {
  plan: RecommendationPlan
  busy: boolean
  onAction: (prompt: string) => void
  onStartBooking?: (plan: RecommendationPlan) => void
  ctripCompare?: CtripCompare
}) {
  const total = planTotal(plan)
  const canBook = Boolean(onStartBooking) && plan.capabilities.canBook && plan.validity.status === 'verified'
  return (
    <div className="recommend-plan-summary">
      <strong className="recommend-plan-label">{plan.label || '未返回'}</strong>
      <div className="recommend-plan-actions">
        <CopyAction plan={plan} />
        {plan.ctripUrl ? (
          <a className="recommend-ctrip-action" href={plan.ctripUrl} target="_blank" rel="noreferrer noopener">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3.5h3.5V7M12.5 3.5 7.5 8.5M12 9.5v2a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2" /></svg>
            <span>携程比价</span>
          </a>
        ) : null}
        {canBook ? (
          <button type="button" className="recommend-book-action" disabled={busy} onClick={() => onStartBooking!(plan)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h9M8 4.5 11.5 8 8 11.5" /></svg>
            <span>预订</span>
          </button>
        ) : null}
      </div>
      <div className="recommend-plan-total">
        <span className="recommend-plan-total-label">总价</span>
        <strong className="recommend-plan-total-amount mono">{recommendationMoney(total.amount, total.currency)}</strong>
      </div>
      {ctripCompare ? (
        <ReferencePriceCell
          plan={plan}
          price={ctripCompare.prices?.[plan.planId]}
          onCapture={ctripCompare.onCapture}
          installed={ctripCompare.installed}
          captureError={ctripCompare.errors?.[plan.planId]}
          captureVersion={ctripCompare.version}
        />
      ) : null}
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

function RecommendationTable({ plans, busy, onAction, onStartBooking, ctripCompare }: {
  plans: RecommendationPlan[]
  busy: boolean
  onAction: (prompt: string) => void
  onStartBooking?: (plan: RecommendationPlan) => void
  ctripCompare?: CtripCompare
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
                    <PlanSummary
                      plan={plan}
                      busy={busy}
                      onAction={onAction}
                      onStartBooking={onStartBooking}
                      ctripCompare={ctripCompare}
                    />
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

export function FlightRecommendationsView({ result, evidence = [], busy, onAction, isLatest = false, onStartBooking, staleNotice, ctripCompare }: {
  result: FlightRecommendations
  evidence?: SearchResult[]
  busy: boolean
  onAction: (prompt: string) => void
  /** The Ctrip-comparison capability (stored figures + capture entry). Display-only — it never
   *  reorders, filters or annotates a plan's standing (CLAUDE.md 推荐边界). See `CtripCompare`. */
  ctripCompare?: CtripCompare
  /** Grants the "load more" capability, the way `onContinue` grants the fare CTA. Only the
   *  task's newest recommendation may continue: the skill consumes a continuation token per
   *  page and mints a new one, so an older page's token is already dead. Withheld by default
   *  — a caller that forgets loses a button rather than offering one that fails. */
  isLatest?: boolean
  /** Grants the per-plan 预订 entry. Scope (which tables offer it) is the CALLER's rule —
   *  see ChatPanel — the button itself is additionally gated on the plan's canBook capability. */
  onStartBooking?: (plan: RecommendationPlan) => void
  /** A failed pre-order re-verification invalidates the WHOLE page (all plans shared one
   *  verification window) — shown as a banner, and the booking entries are withdrawn. */
  staleNotice?: string
}) {
  const [evidenceOpened, setEvidenceOpened] = useState(false)
  const isAlert = result.status === 'fatal_error' || result.status === 'empty'
  const explicitStatusText = result.message || result.reason
  const showState = result.plans.length === 0 || result.status === 'loading' || Boolean(explicitStatusText)
  const hasRetry = result.capabilities.canRetry
  // The token dies on its own clock, so re-render at expiry — otherwise the button survives
  // until some unrelated render and the click fails. 0 for pages that can never continue,
  // which also keeps stale pages from arming a timer.
  const expiresAt = isLatest && result.continuation ? Date.parse(result.continuation.expiresAt) : 0
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const untilExpiry = expiresAt - Date.now()
    if (untilExpiry <= 0) return
    const timer = window.setTimeout(() => setNow(Date.now()), untilExpiry)
    return () => window.clearTimeout(timer)
  }, [expiresAt])
  const canContinue = expiresAt > now
  // Retry lives in the state box when there is one; otherwise it joins the row under the
  // table. It is a recovery action, so it never gets its own slot above the result.
  const showRetryAction = hasRetry && !showState

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

      {staleNotice ? (
        <div className="recommendations-stale" role="alert">{staleNotice}</div>
      ) : null}

      {result.plans.length ? (
        <RecommendationTable
          plans={result.plans}
          busy={busy}
          onAction={onAction}
          onStartBooking={staleNotice ? undefined : onStartBooking}
          ctripCompare={ctripCompare}
        />
      ) : null}

      {/* One row under the table: ask for more, or start over. Retry sits quiet at the far end.
          A page that verified nothing still offers "more" — its snapshot keeps candidates, and
          another page budget beats the full re-run retry triggers. */}
      {canContinue || showRetryAction ? (
        <div className="recommendations-actions" aria-label="推荐操作">
          {canContinue ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(buildRecommendationContinuationPrompt())}
            >
              加载更多方案
            </button>
          ) : null}
          {showRetryAction ? (
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => onAction(buildRecommendationRetryPrompt())}
            >
              重试推荐
            </button>
          ) : null}
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
