import type { FareVerification, FareJourney } from '../frames.ts'
import { cabinLabel, currencySymbol, fmtDuration, journeyFacts, lowStockWarning, paxLabel } from '../booking.ts'

function JourneyRow({ j }: { j: FareJourney }) {
  const { route, flights, stops } = journeyFacts(j)
  const cab = j.legs[0] ? cabinLabel(j.legs[0].cabinClass, j.legs[0].cabinCode) : ''
  return (
    <div className="fare-journey">
      <div className="fare-journey-main">
        <span className="fare-route">{route}</span>
        <span className="mono fare-flights">{flights}</span>
      </div>
      <div className="fare-journey-sub muted">
        {j.departureDate} {j.departureTime} → {j.arrivalDate} {j.arrivalTime}
        {' · '}{stops} {fmtDuration(j.duration)}
        {cab ? ` · ${cab}` : ''}
      </div>
    </div>
  )
}

export function FareDetailCard({
  fare,
  onContinue,
  busy,
}: {
  fare: FareVerification
  onContinue: () => void
  busy: boolean
}) {
  const cur = currencySymbol(fare)
  const hasDiscount = fare.publishTotal > fare.total
  const low = lowStockWarning(fare)
  const multiPax = fare.passengers.length > 1 || (fare.passengers[0]?.num ?? 1) > 1

  return (
    <div className="card fare-card">
      <div className="card-head">
        <h2>✅ 实时价格验证通过</h2>
        <span className="muted">下面是核验后的最终价格与规则</span>
      </div>

      <section className="fare-section">
        {fare.journeys.map((j, i) => <JourneyRow key={i} j={j} />)}
      </section>

      <section className="fare-section fare-price">
        <div className="fare-price-total">
          <span>应付总价</span>
          <strong>{cur}{fare.total}</strong>
        </div>
        <div className="fare-price-break muted">
          票面价 {cur}{fare.baseFare} + 税费 {cur}{fare.tax}
          {hasDiscount ? <span className="fare-strike"> 原价 {cur}{fare.publishTotal}</span> : null}
        </div>
        {multiPax ? (
          <div className="table-scroll">
            <table className="fare-pax">
              <tbody>
                {fare.passengers.map((p, i) => (
                  <tr key={i}>
                    <td>{paxLabel(p.passengerType)} ×{p.num}</td>
                    <td className="num">票面 {cur}{p.baseFare}</td>
                    <td className="num">税 {cur}{p.tax}</td>
                    <td className="num">小计 {cur}{p.salePrice * p.num}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {fare.baggage.length ? (
        <section className="fare-section">
          <h3>行李额</h3>
          {fare.baggage.map((b, i) => (
            <div key={i} className="fare-kv muted">
              {fare.baggage.length > 1 ? <span className="fare-tag">{paxLabel(b.passengerType)}</span> : null}
              {b.carryOn ? <div>手提：{b.carryOn}</div> : null}
              {b.checked ? <div>托运：{b.checked}</div> : null}
            </div>
          ))}
        </section>
      ) : null}

      {fare.fareRules.length ? (
        <section className="fare-section">
          <h3>退改规则</h3>
          {fare.fareRules.map((r, i) => (
            <div key={i} className="fare-kv muted">
              {fare.fareRules.length > 1 ? <span className="fare-tag">{paxLabel(r.passengerType)}</span> : null}
              {r.refundDescription ? <div>退票：{r.refundDescription}</div> : null}
              {r.changeDescription ? <div>改签：{r.changeDescription}</div> : null}
              <div>{r.canVoid ? '支持免费取消（以工具返回为准）' : '不支持免费取消'}</div>
            </div>
          ))}
        </section>
      ) : null}

      {low ? <div className="fare-warn">{low}</div> : null}

      <div className="fare-cta">
        <button disabled={busy} onClick={onContinue}>继续预订，收集乘机人信息</button>
        <p className="hint">确认验价无误后点此继续；我会引导你提供乘机人信息，创建订单前还会再次跟你确认，且不会自动支付。</p>
      </div>
    </div>
  )
}
