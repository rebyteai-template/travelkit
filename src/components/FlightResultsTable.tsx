import { useMemo, useState } from 'react'
import type { CompactJourney, CompactOption, CompactSegment } from '../frames.ts'
import { paxLabel, stopsLabel } from '../booking.ts'

function dateCn(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${Number(m[2])}月${m[3]}日` : iso
}

function money(amount: number, currency = 'CNY'): string {
  const prefix = currency.toUpperCase() === 'CNY' ? '¥' : `${currency} `
  return `${prefix}${amount.toLocaleString('zh-CN')}`
}

function priceDisplay(o: CompactOption): string {
  if (o.price.display && o.price.display !== '¥0') return o.price.display
  return money(o.price.amount, o.price.currency)
}

function customerPrice(o: CompactOption): string {
  const entries = Object.entries(o.price.perType ?? {})
  if (!entries.length) return `价格：${priceDisplay(o)} 含税/人`
  const parts = entries.map(([type, p]) => {
    const unit = p.unitTotal ?? (p.num ? (p.subtotal ?? 0) / p.num : 0)
    return `${paxLabel(type)} ${money(unit, o.price.currency)} 含税/人`
  })
  return `价格：${parts.join('，')}`
}

function airportName(code: string, name?: string, terminal?: string): string {
  const base = (name || code).trim()
  if (!terminal) return base
  const t = terminal.startsWith('T') ? terminal : terminal.replace(/[()]/g, '')
  if (base.includes(t) || base.includes(`(${t})`)) return base
  return `${base}(${t})`
}

function routeCell(s: CompactSegment): string {
  const routeCode = `${s.departure}${s.arrival}`
  return `${routeCode}  ${airportName(s.departure, s.departureName, s.departureTerminal)} → ${airportName(s.arrival, s.arrivalName, s.arrivalTerminal)}`
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

function journeyLabel(o: CompactOption, j: CompactJourney, index: number): string {
  const stops = stopsLabel(j.transferCount)
  if (o.journeys.length === 1) return stops
  if (o.journeys.length === 2) return `${index === 0 ? '去程' : '回程'}${stops}`
  return `第${index + 1}程${stops}`
}

function baggageForCopy(o: CompactOption): string {
  const byJourney = o.journeys.map((j, i) => {
    const bags = [...new Set(j.segments.map((s) => s.checkedBaggage).filter((x): x is string => Boolean(x)))]
    const bag = bags.join('，') || o.baggage || '未返回'
    if (o.journeys.length === 1) return bag
    const label = o.journeys.length === 2 ? (i === 0 ? '去程' : '回程') : `第${i + 1}程`
    return `${label}${bag}`
  })
  return `行李：${byJourney.join('，')}`
}

function copyText(o: CompactOption): string {
  const supplied = o.copyText?.trim()
  if (supplied) return supplied
  const lines: string[] = []
  let n = 1
  for (const journey of o.journeys) {
    for (const segment of journey.segments) {
      const plus = crossDays(journey, segment)
      lines.push(`${n}. ${segment.flightNo}  ${dateCn(segment.departureDate)}  ${segment.departure}${segment.arrival}  ${airportName(segment.departure, segment.departureName, segment.departureTerminal)} → ${airportName(segment.arrival, segment.arrivalName, segment.arrivalTerminal)}  ${segment.departureTime} - ${segment.arrivalTime}${plus ? `+${plus}` : ''}---${segment.cabin}`)
      n += 1
    }
  }
  lines.push(customerPrice(o))
  lines.push(baggageForCopy(o))
  lines.push('改期：未返回')
  lines.push('退票：未返回')
  return lines.join('\n')
}

interface FlightTableRow {
  key: string
  option: CompactOption
  optionKey: string
  optionNumber: number | ''
  selectionLabel: string
  journey: string
  flightNo: string
  date: string
  route: string
  time: string
  duration: string
  cabin: string
  baggage: string
  price: string
  source: string
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const el = document.createElement('textarea')
  el.value = text
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  document.body.removeChild(el)
}

export function FlightResultsTable({
  options,
  totalCount,
  onBook,
  busy,
}: {
  options: CompactOption[]
  totalCount?: number
  onBook: (label: string) => void
  busy: boolean
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const showTotal = useMemo(() => options.some((o) => o.journeys.length > 2), [options])
  const rows = useMemo<FlightTableRow[]>(() => options.flatMap((o) => {
    let rowIndex = 0
    const displayPrice = priceDisplay(o)
    const source = o.sourceDisplay || o.source || '未返回'
    const optionKey = `${o.displayNumber ?? o.optionNumber}:${o.optionNumber}:${o.journeys[0]?.segments[0]?.flightNo ?? ''}`
    return o.journeys.flatMap((j, ji) =>
      j.segments.map((s, si) => {
        const first = rowIndex === 0
        const journeyFirst = si === 0
        rowIndex += 1
        return {
          key: `${optionKey}-${ji}-${si}`,
          option: o,
          optionKey,
          optionNumber: first ? (o.displayNumber ?? o.optionNumber) : '',
          selectionLabel: o.selectionLabel ?? String(o.optionNumber),
          journey: journeyFirst ? journeyLabel(o, j, ji) : '',
          flightNo: s.flightNo,
          date: dateCn(s.departureDate),
          route: routeCell(s),
          time: timeCell(j, s),
          duration: journeyFirst ? durationCell(j) : '',
          cabin: s.cabin || o.cabin || '未返回',
          baggage: s.checkedBaggage || o.baggage || '未返回',
          price: first ? displayPrice : '',
          source: first ? source : '',
        }
      }),
    )
  }), [options])

  async function onCopy(o: CompactOption) {
    await writeClipboard(copyText(o))
    const optionKey = `${o.displayNumber ?? o.optionNumber}:${o.optionNumber}:${o.journeys[0]?.segments[0]?.flightNo ?? ''}`
    setCopied(optionKey)
    window.setTimeout(() => setCopied((current) => (current === optionKey ? null : current)), 1400)
  }

  return (
    <div className="results flight-table-block">
      <div className="results-head">
        <h2>航班方案</h2>
        <span className="muted">{totalCount ? `共匹配 ${totalCount} 条，` : ''}显示 {options.length} 个方案</span>
      </div>
      <div className="table-scroll">
        <table className="flight-table">
          <thead>
            <tr>
              <th>方案</th>
              <th>航程</th>
              <th>航班号</th>
              <th>日期</th>
              <th>航段</th>
              <th>时间</th>
              <th>飞行时长</th>
              <th>舱位</th>
              <th>行李</th>
              <th>价格</th>
              {showTotal ? <th>总价</th> : null}
              <th>供应渠道</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{row.optionNumber}</td>
                <td>{row.journey}</td>
                <td className="mono">{row.flightNo}</td>
                <td>{row.date}</td>
                <td className="route-cell">{row.route}</td>
                <td className="mono">{row.time}</td>
                <td>{row.duration}</td>
                <td>{row.cabin}</td>
                <td>{row.baggage}</td>
                <td className="num">{row.price}</td>
                {showTotal ? <td className="num">{row.price}</td> : null}
                <td>{row.source}</td>
                <td>
                  {row.optionNumber ? (
                    <div className="flight-actions">
                      <button type="button" onClick={() => onCopy(row.option)}>{copied === row.optionKey ? '已复制' : 'Copy'}</button>
                      <button type="button" disabled={busy} onClick={() => onBook(row.selectionLabel)}>验价</button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
