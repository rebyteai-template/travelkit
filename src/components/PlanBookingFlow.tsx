import type { PlanBooking, PlanBookingTicketGroup, RecommendationPlan } from '../frames.ts'
import { journeyRoute, paxSummary, planBookingChangeLabels } from '../booking.ts'
import { flightMoney } from '../lib/flight-display.ts'
import { ConfirmGate, type ConfirmRow } from './ConfirmGate.tsx'

function orderRowValue(group: PlanBookingTicketGroup, plan: RecommendationPlan): string {
  const route = journeyRoute(
    group.journeyIndexes
      .map((index) => plan.journeys[index])
      .filter((journey): journey is RecommendationPlan['journeys'][number] => Boolean(journey)),
  )
  const price = group.changedFields.includes('price')
    ? `${flightMoney(group.verifiedPrice.amount, group.verifiedPrice.currency)}（原 ${flightMoney(group.previousPrice.amount, group.previousPrice.currency)}）`
    : flightMoney(group.verifiedPrice.amount, group.verifiedPrice.currency)
  return [route || '行程见方案', group.cabin, paxSummary(group.exactPassengerCount), price]
    .filter(Boolean)
    .join(' · ')
}

function bookingGate(booking: PlanBooking, plan: RecommendationPlan): { rows: ConfirmRow[]; warning: string | null } {
  const rows: ConfirmRow[] = booking.ticketGroups.map((group, index) => ({
    label: booking.splitOrder ? `订单 ${index + 1}/${booking.orderCount}` : '订单',
    value: orderRowValue(group, plan),
  }))
  const transitNotices = booking.ticketGroups
    .map((group) => group.transitNotice)
    .filter((notice): notice is string => Boolean(notice))
  const warning = booking.changed
    ? `验价后${planBookingChangeLabels(booking.changedFields)}较报价有变化，请与客户确认后再下单。`
    : transitNotices[0] ?? null
  return { rows, warning }
}

/** The booking confirm surface for a recommended plan. Passenger collection happens in the
 *  conversation (the agent asks, the operator pastes), so while that is under way this
 *  renders nothing at all — it materializes only when the plan's recommend-book result is
 *  in, as either the diff/split confirm gate or the stale-plan card. */
export function PlanBookingFlow({
  plan,
  booking,
  busy,
  onConfirmOrders,
  onRetryVerify,
  onRequote,
  onClose,
}: {
  /** The plan being booked (null = no flow open), resolved by App across every table. */
  plan: RecommendationPlan | null
  /** DerivedView.planBooking (the task's newest recommend-book result, any plan). */
  booking: PlanBooking | null
  busy: boolean
  onConfirmOrders: (booking: PlanBooking) => void
  onRetryVerify: () => void
  onRequote: () => void
  onClose: () => void
}) {
  if (!plan) return null
  const matched = booking && booking.planId === plan.planId ? booking : null
  if (!matched) return null

  if (!matched.ok) {
    const retryable = matched.capabilities.canRetryVerification
    return (
      <div className="card gate">
        <div className="card-head">
          <h2>{retryable ? '下单前验价未通过' : '该方案已不可售'}</h2>
          <span className="muted">{retryable ? '可重试验价；未通过前不会下单' : '需要重新给客户报价'}</span>
        </div>
        {matched.message ? <div className="fare-warn">{matched.message}</div> : null}
        <div className="gate-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>关闭</button>
          {retryable ? <button onClick={onRetryVerify} disabled={busy}>重试验价</button> : null}
          {matched.capabilities.canRequote ? (
            <button className="gate-confirm" onClick={onRequote} disabled={busy}>重新报价</button>
          ) : null}
        </div>
      </div>
    )
  }

  const { rows, warning } = bookingGate(matched, plan)
  const total = matched.verifiedFareTotal!
  const amount = matched.changed && matched.previousFareTotal
    ? `总额：${flightMoney(total.amount, total.currency)}（原报价 ${flightMoney(matched.previousFareTotal.amount, matched.previousFareTotal.currency)}）`
    : `总额：${flightMoney(total.amount, total.currency)}`
  const splitNote = matched.splitOrder
    ? `该方案将分 ${matched.orderCount} 张订单出票（每票组一单、各自有订单号）。`
    : ''
  const note = `${splitNote}乘机人信息以你在对话中与 Kitty 确认的为准。确认后我会创建订单，但不会自动支付；验价 5 分钟内有效，超时需重新验价。`
  return (
    <ConfirmGate
      title={matched.changed ? '确认变化并创建订单' : '确认创建订单'}
      rows={rows}
      amountLine={amount}
      warning={warning}
      note={note}
      confirmLabel={matched.splitOrder ? `确认分 ${matched.orderCount} 单创建` : '确认创建订单'}
      cancelLabel="取消预订"
      onConfirm={() => onConfirmOrders(matched)}
      onCancel={onClose}
      busy={busy}
    />
  )
}
