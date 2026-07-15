import type { FareVerification, FareJourney } from '../frames.ts'
import { PAX_LABELS, passengerName, docLabel, amountLine, isBookableFare, journeyFacts, lowStockWarning, type PassengerDraft } from '../booking.ts'
import { PassengerForm } from './PassengerForm.tsx'
import { ConfirmGate, type ConfirmRow } from './ConfirmGate.tsx'
import type { FlowMode } from '../store/ui.ts'

function journeyText(j: FareJourney): string {
  const { route, flights, stops } = journeyFacts(j)
  return `${route} · ${flights} · ${j.departureDate} ${j.departureTime}→${j.arrivalTime} · ${stops}`
}

function orderGate(fare: FareVerification, passengers: PassengerDraft[]): { rows: ConfirmRow[]; warning: string | null } {
  const rows: ConfirmRow[] = fare.journeys.map((j, i) => ({
    label: fare.journeys.length > 1 ? `航段 ${i + 1}` : '航班',
    value: journeyText(j),
  }))
  passengers.forEach((p, i) => {
    const tail = p.docNo ? `尾号 ${p.docNo.slice(-4)}` : ''
    rows.push({ label: `乘机人 ${i + 1}`, value: `${passengerName(p)} · ${PAX_LABELS[p.paxType]} · ${docLabel(p.docType)}${tail ? ` ${tail}` : ''}` })
  })
  const first = passengers[0]
  if (first) rows.push({ label: '联系人', value: `默认使用 ${passengerName(first)} ${first.phone}` })
  return { rows, warning: lowStockWarning(fare) }
}

/** The active booking write-flow step, rendered inline at the chat tail (no side bench): the
 *  passenger form, then the confirm gate. Returns null when `mode` is auto or
 *  the latest fare is absent/non-bookable. */
export function WriteFlow({
  mode,
  fare,
  orderDraft,
  onSubmitPassengers,
  onBackFromForm,
  onConfirmOrder,
  onCancelConfirm,
  busy,
}: {
  mode: FlowMode
  fare: FareVerification | null
  orderDraft: PassengerDraft[]
  onSubmitPassengers: (passengers: PassengerDraft[]) => void
  onBackFromForm: () => void
  onConfirmOrder: () => void
  onCancelConfirm: () => void
  busy: boolean
}) {
  if (!isBookableFare(fare)) return null
  if (mode === 'passengers') {
    return <PassengerForm initial={orderDraft} onSubmit={onSubmitPassengers} onBack={onBackFromForm} busy={busy} />
  }
  if (mode === 'confirm') {
    const { rows, warning } = orderGate(fare, orderDraft)
    return (
      <ConfirmGate
        title="确认创建订单"
        rows={rows}
        amountLine={amountLine(fare)}
        warning={warning}
        note="确认后我会为你创建订单，但不会自动支付。"
        confirmLabel="确认创建订单"
        onConfirm={onConfirmOrder}
        onCancel={onCancelConfirm}
        busy={busy}
      />
    )
  }
  return null
}
