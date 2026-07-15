import { useMemo } from 'react'
import type { FareVerification } from '../frames.ts'
import { amountLine, currencySymbol, isBookableFare, lowStockWarning, stopsLabel } from '../booking.ts'
import { flightRouteCell } from '../lib/flight-display.ts'

function dateCn(iso?: string): string {
  if (!iso) return '未返回'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${Number(m[2])}月${m[3]}日` : iso
}

function crossDay(dep?: string, arr?: string): string {
  if (!dep || !arr || arr <= dep) return ''
  const a = Date.parse(`${dep}T00:00:00Z`)
  const b = Date.parse(`${arr}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '(+1)'
  const days = Math.max(0, Math.round((b - a) / 86400000))
  return days ? `(+${days})` : ''
}

export function fareJourneyLabel(role: FareVerification['journeys'][number]['role'], transferNum: number, index: number): string {
  const stops = stopsLabel(transferNum)
  if (role === 'outbound') return `去程${stops}`
  if (role === 'inbound') return `回程${stops}`
  if (role === 'leg') return `第${index + 1}程${stops}`
  return stops
}

export function FareDetailTable({
  fare,
  busy,
  onContinue,
}: {
  fare: FareVerification
  busy: boolean
  onContinue?: () => void
}) {
  const warning = lowStockWarning(fare)
  const totalAmount = `${currencySymbol(fare)}${fare.total.toLocaleString('zh-CN')}`
  const rows = useMemo(() => fare.journeys.flatMap((j, ji) =>
    j.legs.map((leg, li) => ({
      key: `${ji}-${li}`,
      journey: fareJourneyLabel(j.role, j.transferNum, ji),
      leg,
      duration: li === 0 ? j.duration : '',
    })),
  ), [fare])

  return (
    <div className="results fare-table-block">
      <div className="results-head">
        <h2>验价结果</h2>
        <span className="muted">{amountLine(fare)}</span>
      </div>
      <div className="table-scroll">
        <table className="flight-table">
          <thead>
            <tr>
              <th>航程</th>
              <th>航班号</th>
              <th>日期</th>
              <th>航段</th>
              <th>时间</th>
              <th>飞行时长</th>
              <th>舱位</th>
              <th>行李</th>
              <th>价格</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key}>
                <td>{row.journey}</td>
                <td className="mono">{row.leg.flightNo}</td>
                <td>{dateCn(row.leg.departureDate)}</td>
                <td className="route-cell">
                  {flightRouteCell(row.leg)}
                </td>
                <td className="mono">
                  {row.leg.departureTime && row.leg.arrivalTime
                    ? `${row.leg.departureTime}-${row.leg.arrivalTime}${crossDay(row.leg.departureDate, row.leg.arrivalDate)}`
                    : '未返回'}
                </td>
                <td>{row.duration || ''}</td>
                <td>{row.leg.cabinClass || '未返回'}</td>
                <td>{row.leg.checkedBaggage || fare.baggage[0]?.checked || '未返回'}</td>
                <td className="num">{index === 0 ? totalAmount : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {fare.changeNotice ? <div className="fare-warn">{fare.changeNotice}</div> : null}
      {warning ? <div className="fare-warn">{warning}</div> : null}
      {onContinue && isBookableFare(fare) ? (
        <div className="fare-cta">
          <button disabled={busy} onClick={onContinue}>继续预订</button>
        </div>
      ) : null}
    </div>
  )
}
