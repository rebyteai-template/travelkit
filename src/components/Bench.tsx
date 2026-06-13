import type { DerivedView, FareVerification, FareJourney } from '../frames.ts'
import { PAX_LABELS, passengerName, docLabel, amountLine, journeyFacts, lowStockWarning, type PassengerDraft } from '../booking.ts'
import { FlightCompareCards } from './FlightCompareCards.tsx'
import { FareDetailCard } from './FareDetailCard.tsx'
import { PassengerForm } from './PassengerForm.tsx'
import { ConfirmGate, type ConfirmRow } from './ConfirmGate.tsx'

export type BenchMode = 'auto' | 'passengers' | 'confirm'

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

export function Bench({
  view,
  mode,
  orderDraft,
  onBook,
  onContinue,
  onSubmitPassengers,
  onBackFromForm,
  onConfirmOrder,
  onCancelConfirm,
  busy,
}: {
  view: DerivedView
  mode: BenchMode
  orderDraft: PassengerDraft[]
  onBook: (label: string) => void
  onContinue: () => void
  onSubmitPassengers: (passengers: PassengerDraft[]) => void
  onBackFromForm: () => void
  onConfirmOrder: () => void
  onCancelConfirm: () => void
  busy: boolean
}) {
  const { stage, search, fare, notice } = view
  const hasAny = search || fare

  let body: React.ReactNode = null
  if (mode === 'passengers' && fare) {
    body = (
      <PassengerForm initial={orderDraft}
        onSubmit={onSubmitPassengers} onBack={onBackFromForm} busy={busy} />
    )
  } else if (mode === 'confirm' && fare) {
    const { rows, warning } = orderGate(fare, orderDraft)
    body = (
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
  } else if (stage === 'verify' && fare) {
    body = <FareDetailCard fare={fare} onContinue={onContinue} busy={busy} />
  } else if (search) {
    body = <FlightCompareCards options={search.options} totalCount={search.totalCount} onBook={onBook} busy={busy} />
  }

  return (
    <div className="bench">
      {notice ? <div className="bench-notice">{notice}</div> : null}
      {body}
      {!hasAny && !body ? (
        <div className="bench-empty">
          <div className="bench-empty-mark">✈</div>
          <p>右侧是你的订票工作台。</p>
          <p className="muted">在左侧告诉我出发地、目的地和日期，搜索结果会显示在这里。</p>
        </div>
      ) : null}
    </div>
  )
}
