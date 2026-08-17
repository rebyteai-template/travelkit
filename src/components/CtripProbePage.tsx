import { useCallback, useMemo, useState } from 'react'
import {
  CTRIP_CURRENCY,
  isRoundTripCapture,
  matchCtripFlight,
  normalizeFlightNo,
  type CtripCapture,
  type CtripFare,
  type CtripFlightQuote,
  type CtripFlightRow,
  type CtripMatch,
  type CtripQuoteTarget,
} from '@travelkit/contract'

import { useCtripBridge } from '../hooks/useCtripBridge.ts'
import type { CompactPrice } from '../frames.ts'

/** The OLD comparison figure: the page's cheapest listed fare, whatever flight it belongs to.
 *  This is the behavior the per-flight quote path replaced; the bench keeps it as the yardstick
 *  its tables compare against ("现在会填"→"旧行为会填"). Bench-only on purpose — a production
 *  caller reaching for it would be re-introducing the bug. */
function captureToPrice(capture: CtripCapture): CompactPrice | null {
  if (capture.blocked || !Number.isFinite(capture.lowest)) return null
  const amount = capture.lowest as number
  return amount > 0 ? { amount, currency: CTRIP_CURRENCY } : null
}

/**
 * A manual bench for the one thing the extension cannot decide on its own: WHICH flight of a
 * Ctrip result belongs to the plan being compared.
 *
 * The production path filters Ctrip's own search JSON by flight number (`bridge.quote` →
 * `matchQuoteNode`). This page exists to validate that against real pages: it drives the real
 * extension, shows the per-row DOM read next to the JSON quote, and demonstrates the OLD
 * page-lowest behavior (`captureToPrice`, kept below as the bench's own yardstick) that made
 * per-flight matching necessary — on domestic routes the cheapest row is routinely a transfer.
 *
 * Reachable at `/ctrip-probe` (a path, not a hash — the hash carries the embed credentials).
 * Not linked from the app: it is a bench, not a feature.
 */

interface Preset {
  label: string
  url: string
  note: string
}

const PRESETS: Preset[] = [
  {
    label: '单程 · 机场码',
    url: 'https://flights.ctrip.com/online/list/oneway-pek-can?depdate=2026-08-23',
    note: '基准用例。页面最低价常是中转航班，直飞方案会被低估。',
  },
  {
    label: '单程 · 城市码',
    url: 'https://flights.ctrip.com/online/list/oneway-bjs-can?depdate=2026-08-23',
    note: 'buildCtripUrl 透传用户写的码，城市码会把首都和大兴混进一页。',
  },
  {
    label: '往返',
    url: 'https://flights.ctrip.com/online/list/round-bjs-can?depdate=2026-08-23_2026-08-27',
    note: '整页应被拒绝：价格是「该去程 + 最便宜回程」的往返总价，不是单程价。',
  },
  {
    label: '国际线',
    url: 'https://flights.ctrip.com/online/list/oneway-pvg-hkg?depdate=2026-08-30',
    note: '国际线 cabin 字段为空，只能拿到裸价。',
  },
]

interface Check {
  ok: boolean
  label: string
  detail: string
}

interface RowGap {
  flightNo: string
  depTime: string
  isTransfer: boolean
  own: number
  filledNow: number
  gap: number
}

interface Outcome {
  capture: CtripCapture
  checks: Check[]
  gaps: RowGap[]
  lowestRow: CtripFlightRow | null
}

const asJourney = (flightNo: string, departureTime: string) => ({
  transferCount: 0,
  segments: [{ flightNo, departureTime }],
})

const describe = (match: CtripMatch) =>
  match.status === 'matched'
    ? `matched ¥${match.amount} (${match.matchedBy})`
    : `unmatched ${match.reason}${match.detail ? ` — ${match.detail}` : ''}`

/** Everything this page asserts, run against whatever the live page turned out to contain. */
function evaluate(capture: CtripCapture): Outcome {
  const checks: Check[] = []
  const usable = capture.flights.filter((row) => row.flightNo && Number.isFinite(row.price))
  const direct = usable.filter((row) => !row.isTransfer)
  const transfers = usable.filter((row) => row.isTransfer)
  const filledNow = captureToPrice(capture)?.amount ?? null
  const lowestRow = usable.reduce<CtripFlightRow | null>(
    (best, row) => (best === null || (row.price as number) < (best.price as number) ? row : best),
    null,
  )

  // On a round-trip page the right answer is the opposite one: every row must be REFUSED, because
  // its price is a round-trip total for a return nobody picked. Asserting "matches itself" there
  // would fail the matcher for doing exactly what it should.
  const roundTrip = isRoundTripCapture(capture)

  // Every direct row, treated as "our plan", must come back as itself at its own fare.
  const selfMatch = direct.map((row) =>
    matchCtripFlight(asJourney(row.flightNo!, row.depTime ?? ''), capture),
  )
  const selfOk = roundTrip
    ? selfMatch.filter((m) => m.status === 'unmatched' && m.reason === 'round-trip-page')
    : selfMatch.filter((m, i) => m.status === 'matched' && m.amount === direct[i]!.price)
  checks.push({
    ok: direct.length > 0 && selfOk.length === direct.length,
    label: roundTrip
      ? '往返页的每一行都被拒绝（价格是往返总价，不能当单程价填）'
      : '每个直飞行都能匹配到自己、且价格是它自己的',
    detail: `${selfOk.length}/${direct.length}` + (
      selfOk.length === direct.length ? '' : ` — 首个意外：${describe(selfMatch[selfOk.length]!)}`
    ),
  })

  // Zero-padded plan numbers (CA0841) must still find Ctrip's CA841.
  const paddedNo = direct[0]?.flightNo?.replace(/^([A-Z0-9]{2})(\d)/, '$10$2')
  const padded = direct[0]
    ? matchCtripFlight(asJourney(paddedNo!, direct[0].depTime ?? ''), capture)
    : null
  checks.push({
    ok: roundTrip ? padded?.status === 'unmatched' : padded?.status === 'matched',
    label: `前导零形式（${paddedNo ?? 'CA0841'}）${roundTrip ? '同样被整页拒绝' : '也能匹配'}`,
    detail: padded ? describe(padded) : '页面无直飞行可测',
  })

  // A transfer card must never satisfy a direct plan.
  const transferProbe = transfers[0]
    ? matchCtripFlight(asJourney(transfers[0].flightNo!, transfers[0].depTime ?? ''), capture)
    : null
  checks.push({
    ok: transfers.length === 0 || transferProbe?.status === 'unmatched',
    label: '中转卡片不会被直飞方案匹配上',
    detail: transferProbe ? describe(transferProbe) : '本页无中转行',
  })

  // The dangerous default: an unknown flight must yield nothing, not the page low.
  const missing = matchCtripFlight(asJourney('ZZ9999', '00:00'), capture)
  checks.push({
    ok: missing.status === 'unmatched',
    label: '页面没有的航班 → 留空（绝不回退整页最低价）',
    detail: describe(missing),
  })

  // A right number on the wrong flight is the failure mode, so time has to be checked.
  const wrongTime = direct[0]
    ? matchCtripFlight(asJourney(direct[0].flightNo!, '03:33'), capture)
    : null
  checks.push({
    ok: wrongTime?.status === 'unmatched',
    label: '起飞时刻对不上 → 拒绝',
    detail: wrongTime ? describe(wrongTime) : '页面无直飞行可测',
  })

  // The decisive comparison: what the page's own search returned, against what the DOM gave up.
  // If the payload holds 25 flights and the list rendered 4, the fix is to stop reading the DOM.
  const apiFlights = Math.max(0, ...(capture.apiSamples ?? []).map((sample) => sample.flightNoCount))
  checks.unshift({
    ok: apiFlights === 0 ? capture.count >= 8 : capture.count >= apiFlights,
    label: 'DOM 读到的 vs 携程自己 API 返回的',
    detail: apiFlights
      ? `DOM ${capture.count} 行 / API ${apiFlights} 班 — ${
          capture.count >= apiFlights ? 'DOM 没丢' : `DOM 丢了 ${apiFlights - capture.count} 班`
        }`
      : `DOM ${capture.count} 行 · 未捕获到 API 响应（探针没装上，或该页不走这些端点）`,
  })

  const gaps: RowGap[] = usable.map((row) => ({
    flightNo: normalizeFlightNo(row.flightNo),
    depTime: row.depTime ?? '—',
    isTransfer: row.isTransfer,
    own: row.price as number,
    filledNow: filledNow ?? 0,
    gap: (filledNow ?? 0) - (row.price as number),
  }))

  return { capture, checks, gaps, lowestRow }
}

/** The endpoint state: ask for ONE flight, get ONE node back — no list crosses the bridge.
 *  Investigative rendering: until the payload schema is pinned, show every money-looking leaf
 *  and the raw node, so the real field paths can be read off a live response. */
function QuoteBench({ bridge }: { bridge: ReturnType<typeof useCtripBridge> }) {
  const [kind, setKind] = useState<'oneway' | 'round'>('oneway')
  const [url, setUrl] = useState('https://flights.ctrip.com/online/list/oneway-pek-can?depdate=2026-08-23')
  const [flightNo, setFlightNo] = useState('CA1359')
  const [time, setTime] = useState('07:00')
  const [outboundNo, setOutboundNo] = useState('CA1359')
  const [returnNo, setReturnNo] = useState('CA9675')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CtripFlightQuote | { error: string } | null>(null)

  const applyKind = (next: 'oneway' | 'round') => {
    setKind(next)
    setResult(null)
    setUrl(next === 'oneway'
      ? 'https://flights.ctrip.com/online/list/oneway-pek-can?depdate=2026-08-23'
      : 'https://flights.ctrip.com/online/list/round-bjs-can?depdate=2026-08-23_2026-08-27')
  }

  const run = async () => {
    setBusy(true)
    setResult(null)
    try {
      // `debug` asks the probe for the archaeology fields (raw node, path/value scans) that
      // production quotes no longer carry.
      const target: CtripQuoteTarget = kind === 'oneway'
        ? { flightNo, departureDate: '2026-08-23', departureTime: time, debug: true }
        : {
            flightNo: returnNo,
            departureDate: '2026-08-27',
            departureTime: '',
            outbound: { flightNo: outboundNo },
            debug: true,
          }
      const quote = await bridge.quote(url, target)
      setResult(quote ?? { error: bridge.lastError ?? '扩展未返回结果' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={{ border: '2px solid #1565c0', borderRadius: 8, padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <strong>按航班取价（终态路径：JSON 内筛选，桥上只回一条）</strong>
        <button type="button" onClick={() => applyKind('oneway')} disabled={kind === 'oneway'}>单程</button>
        <button type="button" onClick={() => applyKind('round')} disabled={kind === 'round'}>往返</button>
        <button type="button" onClick={() => void run()} disabled={busy}>{busy ? '取价中…' : '取这一班的价'}</button>
      </div>
      <p style={{ margin: '0 0 8px', opacity: 0.7, fontSize: 13 }}>
        {kind === 'oneway'
          ? '扩展从携程自己的搜索响应里筛出目标航班，整页 JSON 不出 tab。'
          : '扩展先替你点一次目标去程的「选为去程」（只点这一下，不输入），等第二次响应出现后筛出回程 —— 合成点击若被携程忽略，窗口会自动弹到你面前，请手动点那一下。'}
      </p>
      <input value={url} onChange={(event) => setUrl(event.target.value)}
        style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: 6, marginBottom: 6 }} />
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, fontSize: 13, alignItems: 'center' }}>
        {kind === 'oneway' ? (
          <>
            <label>航班号 <input value={flightNo} onChange={(event) => setFlightNo(event.target.value)} style={{ width: 90 }} /></label>
            <label>起飞 <input value={time} onChange={(event) => setTime(event.target.value)} style={{ width: 60 }} /></label>
          </>
        ) : (
          <>
            <label>去程（要点掉的） <input value={outboundNo} onChange={(event) => setOutboundNo(event.target.value)} style={{ width: 90 }} /></label>
            <label>回程（要取价的） <input value={returnNo} onChange={(event) => setReturnNo(event.target.value)} style={{ width: 90 }} /></label>
          </>
        )}
      </div>

      {result && 'error' in result ? (
        <p style={{ color: '#c62828' }}>取价失败：{result.error}</p>
      ) : result ? (
        <>
          <p style={{ margin: '8px 0 4px' }}>
            命中 <strong className="mono">{result.flightNo}</strong>（{result.matchedBy}）
            · 该响应共 {result.payloadFlightCount} 班 · 节点内航班号：{result.flightNos.join(', ')}
          </p>

          {result.extract ? (
            <div style={{ margin: '8px 0', padding: 10, background: '#e8f5e9', borderRadius: 6 }}>
              <div style={{ fontSize: 15 }}>
                经济舱最低（裸价·单成人）：
                <strong>{result.extract.economyLowestAdult != null ? `¥${result.extract.economyLowestAdult}` : '—'}</strong>
                {result.extract.overallLowestAdult != null && result.extract.overallLowestAdult !== result.extract.economyLowestAdult
                  ? <span style={{ opacity: 0.7 }}>（含公务舱全舱最低 ¥{result.extract.overallLowestAdult}）</span>
                  : null}
              </div>
              {result.extract.economyLowestAdult == null && result.extract.fares.length > 0 ? (
                <div style={{ fontSize: 12, color: '#e65100' }}>
                  没有一档被判成经济舱。实际 cabin 值：
                  <code>{[...new Set(result.extract.fares.map((fare: CtripFare) => fare.cabin || '(空)'))].join(' , ')}</code>
                  {' '}· 限购档 {result.extract.fares.filter((fare: CtripFare) => fare.restricted).length} 个
                </div>
              ) : null}
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {result.extract.legCount} 段 · {result.extract.departureDateTime ?? '—'} → {result.extract.arrivalDateTime ?? '—'}
                {' · '}⚠️ 携程此价<strong>不含税</strong>（机建+燃油在预订页才加），与我们的含税总价口径不同
              </div>
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12 }}>全部 {result.extract.fares.length} 个价格档</summary>
                <table style={{ fontSize: 12, borderCollapse: 'collapse', marginTop: 6 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid #bbb' }}>
                      <th style={{ paddingRight: 12 }}>舱</th><th style={{ paddingRight: 12 }}>子舱/折扣</th>
                      <th style={{ paddingRight: 12 }}>成人</th><th style={{ paddingRight: 12 }}>儿童</th>
                      <th style={{ paddingRight: 12 }}>婴儿</th><th>限制</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.extract.fares.map((fare: CtripFare, index: number) => (
                      <tr key={index} style={{ borderBottom: '1px solid #eee', opacity: fare.restricted ? 0.55 : 1 }}>
                        <td>{fare.cabin === 'Y' ? '经济' : fare.cabin === 'C' ? '公务' : fare.cabin}{fare.specialClassName ? `·${fare.specialClassName}` : ''}</td>
                        <td>{fare.seatClass ?? '—'}{fare.discountRate != null ? ` ${Math.round(fare.discountRate * 100)}%` : ''}</td>
                        <td>{fare.adultPrice != null ? `¥${fare.adultPrice}` : '—'}</td>
                        <td>{fare.childPrice != null ? `¥${fare.childPrice}` : '—'}</td>
                        <td>{fare.infantPrice != null ? `¥${fare.infantPrice}` : '—'}</td>
                        <td>{fare.restricted ? '限购' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          ) : (
            <p style={{ color: '#e65100', fontSize: 13 }}>
              ⚠️ 匹配到了航班号但没读到价格结构 —— 命中的可能是摘要节点而非行程节点。节点原文见下。
            </p>
          )}

          <p style={{ margin: '0 0 4px', fontSize: 12, opacity: 0.6 }}>
            原始扫描：日期 {result.dates?.join(', ') || '—'} · 时刻 {result.times?.join(', ') || '—'}
          </p>
          <table style={{ fontSize: 12, borderCollapse: 'collapse', marginBottom: 8 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}><th>价格类字段路径</th><th>值</th></tr>
            </thead>
            <tbody>
              {(result.prices ?? []).map((price) => (
                <tr key={price.path} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ fontFamily: 'monospace', paddingRight: 12 }}>{price.path}</td>
                  <td>{price.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.raw ? (
            <>
              <button type="button" onClick={() => void navigator.clipboard.writeText(result.raw!)}>
                复制节点原文{result.rawTruncated ? '（已截断）' : ''}
              </button>
              <details>
                <summary style={{ cursor: 'pointer' }}>节点原文</summary>
                <pre style={{ fontSize: 10, background: '#fafafa', padding: 8, overflow: 'auto', maxHeight: 260 }}>{result.raw}</pre>
              </details>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

export function CtripProbePage() {
  const bridge = useCtripBridge()
  const [urls, setUrls] = useState(() => PRESETS.map((preset) => preset.url))
  const [busy, setBusy] = useState<number | null>(null)
  const [outcomes, setOutcomes] = useState<Record<number, Outcome | { error: string }>>({})

  const run = useCallback(
    async (index: number) => {
      setBusy(index)
      try {
        const capture = await bridge.capture(urls[index]!)
        setOutcomes((prev) => ({
          ...prev,
          [index]: capture ? evaluate(capture) : { error: bridge.lastError ?? '扩展未返回结果' },
        }))
      } finally {
        setBusy(null)
      }
    },
    [bridge, urls],
  )

  const report = useMemo(
    () =>
      JSON.stringify(
        Object.entries(outcomes).map(([index, outcome]) => ({
          case: PRESETS[Number(index)]?.label,
          url: urls[Number(index)],
          ...('error' in outcome
            ? { error: outcome.error }
            : {
                capturedAt: outcome.capture.capturedAt,
                strategy: outcome.capture.strategy,
                rows: outcome.capture.count,
                filledNow: captureToPrice(outcome.capture)?.amount ?? null,
                lowestIsTransfer: outcome.lowestRow?.isTransfer ?? null,
                checks: outcome.checks.map((c) => ({ ok: c.ok, label: c.label, detail: c.detail })),
                worstGap: outcome.gaps.reduce((max, g) => Math.max(max, Math.abs(g.gap)), 0),
                gaps: outcome.gaps,
                apiSamples: outcome.capture.apiSamples ?? null,
              }),
        })),
        null,
        1,
      ),
    [outcomes, urls],
  )

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: 24, fontSize: 14, lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>携程比价 · 同航班匹配验证台</h1>
      <p style={{ opacity: 0.75, marginTop: 0 }}>
        用真实扩展抓真实页面，逐条验证「这一行是不是我们的航班」。
        线上真表已改走按航班号的 quote 路径；下面「现在会填」演示的是被替换掉的旧行为
        （整页最低价，<code>captureToPrice</code> → <code>capture.lowest</code>），留作对照。
      </p>

      <div style={{ padding: '8px 12px', borderRadius: 6, background: bridge.installed ? '#e8f5e9' : '#fff3e0', marginBottom: 16 }}>
        {bridge.installed
          ? `扩展已连接${bridge.version ? ` · ${bridge.version}` : ''}`
          : '扩展未连接 — 需要 dev 版扩展（NODE_ENV=development 构建，manifest 才含 localhost:4000）'}
        {bridge.lastError ? <span style={{ color: '#c62828' }}> · 最近错误：{bridge.lastError}</span> : null}
      </div>

      <QuoteBench bridge={bridge} />

      {PRESETS.map((preset, index) => {
        const outcome = outcomes[index]
        return (
          <section key={preset.label} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <strong>{preset.label}</strong>
              <button type="button" onClick={() => void run(index)} disabled={busy !== null}>
                {busy === index ? '抓取中…' : '抓取并自检'}
              </button>
              <a href={urls[index]} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                手动打开
              </a>
            </div>
            <p style={{ margin: '0 0 8px', opacity: 0.7, fontSize: 13 }}>{preset.note}</p>
            <input
              value={urls[index]}
              onChange={(event) =>
                setUrls((prev) => prev.map((url, i) => (i === index ? event.target.value : url)))
              }
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: 6 }}
            />

            {outcome && 'error' in outcome ? (
              <p style={{ color: '#c62828' }}>抓取失败：{outcome.error}</p>
            ) : outcome ? (
              <>
                <p style={{ margin: '10px 0 4px' }}>
                  抓到 {outcome.capture.count} 行 · strategy={outcome.capture.strategy} ·
                  <strong> 现在会填 ¥{captureToPrice(outcome.capture)?.amount ?? '—'}</strong>
                  {outcome.lowestRow?.isTransfer ? (
                    <span style={{ color: '#c62828' }}> ← 这是中转航班的价</span>
                  ) : null}
                </p>

                <ul style={{ margin: '8px 0', paddingLeft: 18 }}>
                  {outcome.checks.map((check) => (
                    <li key={check.label} style={{ color: check.ok ? '#2e7d32' : '#c62828' }}>
                      {check.ok ? '✓' : '✗'} {check.label} — <span style={{ opacity: 0.8 }}>{check.detail}</span>
                    </li>
                  ))}
                </ul>

                <details>
                  <summary style={{ cursor: 'pointer' }}>
                    每行的误差（现在会填 vs 这班自己的价）
                  </summary>
                  <table style={{ width: '100%', fontSize: 12, marginTop: 8, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
                        <th>航班</th><th>起飞</th><th>自己的价</th><th>现在会填</th><th>误差</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outcome.gaps.map((gap) => (
                        <tr key={`${gap.flightNo}-${gap.depTime}`} style={{ borderBottom: '1px solid #f0f0f0' }}>
                          <td style={{ fontFamily: 'monospace' }}>
                            {gap.flightNo}{gap.isTransfer ? ' (中转)' : ''}
                          </td>
                          <td>{gap.depTime}</td>
                          <td>¥{gap.own}</td>
                          <td>¥{gap.filledNow}</td>
                          <td style={{ color: gap.gap === 0 ? '#2e7d32' : '#c62828' }}>
                            {gap.gap === 0 ? '0' : gap.gap}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>

                {outcome.capture.apiSamples?.length ? (
                  <details>
                    <summary style={{ cursor: 'pointer' }}>
                      携程自己的 API 响应（{outcome.capture.apiSamples.length} 个）— 有没有含税价就看这里
                    </summary>
                    {outcome.capture.apiSamples.map((sample) => (
                      <div key={sample.url} style={{ fontSize: 12, marginTop: 8 }}>
                        <div style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{sample.url}</div>
                        <div>
                          {Math.round(sample.size / 1024)} KB · <strong>{sample.flightNoCount} 班</strong> ·
                          顶层字段 {sample.topKeys.join(', ') || '—'}
                        </div>
                        <div>价格类字段：{sample.priceKeys.join(', ') || '—'}</div>
                        {sample.sampleNode ? (
                          <pre style={{ fontSize: 10, background: '#fafafa', padding: 8, overflow: 'auto', maxHeight: 160 }}>
                            {sample.sampleNode}
                          </pre>
                        ) : null}
                      </div>
                    ))}
                  </details>
                ) : null}
              </>
            ) : null}
          </section>
        )
      })}

      {Object.keys(outcomes).length > 0 ? (
        <>
          <button type="button" onClick={() => void navigator.clipboard.writeText(report)}>
            复制全部结果 JSON
          </button>
          <pre style={{ fontSize: 11, background: '#fafafa', padding: 12, overflow: 'auto', maxHeight: 300 }}>
            {report}
          </pre>
        </>
      ) : null}
    </div>
  )
}
