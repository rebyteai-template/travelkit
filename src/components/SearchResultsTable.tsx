import type { FlightOption } from '../frames.ts'
import { cabinLabel, fmtDuration, stopsLabel } from '../booking.ts'

function fmtRoute(o: FlightOption): string {
  const first = o.route[0]
  const last = o.route[o.route.length - 1]
  if (!first || !last) return ''
  const dep = first.departure + (first.departureTerminal ? ` ${first.departureTerminal}` : '')
  const arr = last.arrival + (last.arrivalTerminal ? ` ${last.arrivalTerminal}` : '')
  return `${dep} → ${arr}`
}

function fmtTime(o: FlightOption): string {
  const first = o.route[0]
  const last = o.route[o.route.length - 1]
  if (!first || !last) return ''
  return `${first.departureTime}-${last.arrivalTime}｜${stopsLabel(o.transferNum)}约${fmtDuration(o.duration)}`
}

export function SearchResultsTable({
  options,
  totalCount,
  onBook,
  busy,
}: {
  options: FlightOption[]
  totalCount?: number
  onBook: (label: string) => void
  busy: boolean
}) {
  const cheapest = options.reduce((min, o) => (o.priceTotal < min ? o.priceTotal : min), Infinity)
  return (
    <div className="results">
      <div className="results-head">
        <h2>航班搜索结果</h2>
        {totalCount ? <span className="muted">共 {totalCount} 个方案</span> : null}
      </div>
      <div className="table-scroll">
        <table>
        <thead>
          <tr>
            <th>选项</th>
            <th>航班</th>
            <th>行程</th>
            <th>时间</th>
            <th>舱位</th>
            <th className="num">价格</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {options.map((o) => (
            <tr key={o.label} className={o.priceTotal === cheapest ? 'cheapest' : ''}>
              <td>{o.label}</td>
              <td className="mono">{o.flights.join(' / ')}</td>
              <td>{fmtRoute(o)}</td>
              <td>{fmtTime(o)}</td>
              <td>{cabinLabel(o.cabinClass, o.cabinCode)}</td>
              <td className="num">¥{o.priceTotal}{o.priceTotal === cheapest ? ' 🏷️' : ''}</td>
              <td>
                <button disabled={busy} onClick={() => onBook(o.label)}>预订</button>
              </td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>
      <p className="hint">点「预订」我会先帮你验价，确认后再收集乘机人信息。也可以直接在左侧补充筛选需求。</p>
    </div>
  )
}
