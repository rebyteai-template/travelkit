import type { CompactOption, CompactJourney } from '../frames.ts'
import { fmtDuration } from '../booking.ts'

/** Search-stage bench: render the simplifly-flyai-skill skill's recommended options as side-by-side
 *  cards. Each card = one "方案" an OP can present/quote to a customer. The cards mirror what
 *  the skill curated; the real refinement (改时段/要转机/限价/往返…) happens in chat, and a
 *  fresh search just re-renders here. Selection rides the public 序号 (optionNumber) — the
 *  private solutionId stays agent-side and never reaches the UI. */

function crossedDays(j: CompactJourney): number {
  if (!j.departureDate || !j.arrivalDate || j.arrivalDate <= j.departureDate) return 0
  const a = Date.parse(`${j.departureDate}T00:00:00Z`)
  const b = Date.parse(`${j.arrivalDate}T00:00:00Z`)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : 1
}

function Journey({ j, multi, idx }: { j: CompactJourney; multi: boolean; idx: number }) {
  const plus = crossedDays(j)
  const tag = idx === 0 ? '去程' : idx === 1 ? '回程' : `第${idx + 1}程`
  return (
    <div className="fc-journey">
      {multi ? <div className="fc-journey-tag">{tag}</div> : null}
      {j.segments.map((s, i) => (
        <div key={i} className="fc-seg">
          <span className="fc-flightno mono">{s.flightNo}</span>
          <span className="fc-port">{s.departureName}{s.departureTerminal ? ` ${s.departureTerminal}` : ''}</span>
          <span className="fc-time">{s.departureTime}</span>
          <span className="fc-arrow">→</span>
          <span className="fc-port">{s.arrivalName}{s.arrivalTerminal ? ` ${s.arrivalTerminal}` : ''}</span>
          <span className="fc-time">
            {s.arrivalTime}
            {plus && i === j.segments.length - 1 ? <sup className="fc-plus1">+{plus}</sup> : null}
          </span>
        </div>
      ))}
    </div>
  )
}

export function FlightCompareCards({
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
  const cheapest = options.reduce((m, o) => Math.min(m, o.price.amount), Infinity)
  return (
    <div className="results">
      <div className="results-head">
        <h2>航班方案</h2>
        <span className="muted">
          {totalCount ? `共匹配 ${totalCount} 条，` : ''}为你精选 {options.length} 个方案
        </span>
      </div>
      <div className="flight-cards">
        {options.map((o) => {
          const low = o.price.amount === cheapest
          const multi = o.journeys.length > 1
          return (
            <div key={o.optionNumber} className={`flight-card${low ? ' cheapest' : ''}`}>
              <div className="fc-top">
                <span className="fc-badge">{o.journeyType}</span>
                {low ? <span className="fc-badge fc-low">最低价</span> : null}
              </div>
              <div className="fc-price">{o.price.display}</div>
              <div className="fc-journeys">
                {o.journeys.map((j, i) => <Journey key={i} j={j} multi={multi} idx={i} />)}
              </div>
              <div className="fc-meta muted">
                总时长 {fmtDuration(o.duration)} · {o.cabin} · 行李 {o.baggage ?? '未返回'}
              </div>
              <button className="fc-cta" disabled={busy} onClick={() => onBook(String(o.optionNumber))}>
                选这个 · 去验价
              </button>
            </div>
          )
        })}
      </div>
      <p className="hint">点「选这个」我按序号验价；也可以在左侧继续描述需求（改时段、要转机、限价、往返…），我会重新搜并刷新这里。</p>
    </div>
  )
}
