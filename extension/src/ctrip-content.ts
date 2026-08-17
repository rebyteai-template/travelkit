import {
  API_PROBE_CHANNEL,
  FLIGHT_NO_PATTERN,
  isRoundTripCapture,
  normalizeFlightNo,
  type CtripApiSample,
  type CtripCapture,
  type CtripFlightQuote,
  type CtripQuoteTarget,
  type ProbeFindAnswer,
  type ProbeFindRequest,
} from '@travelkit/contract'

import { FLIGHT_CARD_SELECTOR, extractCtripPrices, probe } from './extract/ctrip-extract.ts'

/** What the page-world probe overheard. Collected from the first moment this script runs, because
 *  the search response can land before the list finishes rendering — and does. */
const apiSamples: CtripApiSample[] = []
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return
  const data = event.data as { channel?: string; sample?: CtripApiSample } | null
  if (data?.channel !== API_PROBE_CHANNEL || !data.sample) return
  if (apiSamples.length < 8) apiSamples.push(data.sample)
})

/**
 * Waits for Ctrip's fare list to render, reads it, and reports back.
 *
 * The wait lives HERE and not in the service worker on purpose. An MV3 worker is torn down
 * after 30s idle and its timers are cancelled with it, so a `setTimeout` there may simply never
 * fire. A content script lives as long as its tab, so it can afford to be patient — the worker
 * stays purely event-driven and is woken by the message this file eventually sends.
 *
 * Patience is not optional: the list is lazily rendered and measurably needs more than six
 * seconds (a 6s wait came back empty on one route and twelve was reliable). The loop polls the
 * cheap `probe()` and parses exactly once, at the end — parsing on every tick meant reading
 * `innerText` off every div on the page ~30 times per capture, all but one of them discarded,
 * and doing it inside the very wait that exists to let the page render.
 */

/** Give up here. Past this the page is broken, blocked, or asking for a login — all cases where
 *  the honest answer is "I could not read it", not a half-rendered list.
 *  `useCtripBridge`'s CAPTURE_TIMEOUT_MS must stay comfortably above this. */
const DEADLINE_MS = 25_000
const POLL_MS = 500
/** Three seconds of an unchanging count, not one.
 *
 *  The list arrives in batches, and the gap between two batches is indistinguishable from a
 *  finished page. Measured against live pages through the real extension: two identical polls
 *  500ms apart happen at FOUR rows, and the capture stopped there — 4 rows off a PEK-CAN page
 *  that has 25, 5 off a round-trip page, 4 off a PVG-HKG page that has 23. Every route came back
 *  4-5 rows for this reason.
 *
 *  A short capture is not a visibly broken one: it parses cleanly, reports `flight-item`, and
 *  hands over a confident number for a page it barely read. */
const STABLE_POLLS = 6
/** ...and never settle before this, however quiet the page looks in its first second. A visible
 *  tab measurably needs ~12s for a full list; this is the floor under the stability check, not a
 *  replacement for it, so a genuinely finished page still leaves early — just not THAT early. */
const MIN_WAIT_MS = 8_000
/** How long a hidden tab gets to render before we suspect Chrome is withholding what the page
 *  needs and ask for it to be brought forward. Comfortably past the ~12s a visible tab takes,
 *  so a merely-slow page is never yanked into the operator's face. */
const REVEAL_AFTER_MS = 14_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** What the page was doing while we waited. Attached to failures because "nothing rendered"
 *  has several very different causes and guessing between them wasted a debugging round. */
interface Trace {
  elapsedMs: number
  visibility: string
  everHidden: boolean
  revealed: boolean
  counts: number[]
}

async function captureWhenReady(): Promise<{ capture: CtripCapture; trace: Trace }> {
  const started = Date.now()
  const counts: number[] = []
  let everHidden = false
  let revealed = false

  while (Date.now() - started < DEADLINE_MS) {
    const { count, blocked } = probe()
    counts.push(count)
    if (document.visibilityState === 'hidden') everHidden = true

    // A block page will never fill in; reporting it beats waiting out the deadline.
    if (blocked) break
    // `counts` is the only record of the sequence — the previous tick is the entry before this
    // one, so there is no separate counter to keep in step with it.
    const settled = count > 0
      && Date.now() - started >= MIN_WAIT_MS
      && counts.length >= STABLE_POLLS
      && counts.slice(-STABLE_POLLS).every((n) => n === count)
    if (settled) break

    // Nothing at all after a generous wait, and we are hidden: Chrome may be withholding the
    // work this page needs. Ask to be brought forward and keep going rather than failing —
    // an interruption the operator can see beats a capture that silently gave up.
    if (!revealed && count === 0 && document.visibilityState === 'hidden'
        && Date.now() - started > REVEAL_AFTER_MS) {
      revealed = true
      void chrome.runtime.sendMessage({ type: 'reveal-tab' })
    }

    await sleep(POLL_MS)
  }

  return {
    capture: { ...extractCtripPrices(), ...(apiSamples.length ? { apiSamples } : {}) },
    trace: {
      elapsedMs: Date.now() - started,
      visibility: document.visibilityState,
      everHidden,
      revealed,
      counts: counts.slice(-12),
    },
  }
}

/* --------------------------------- quote mode --------------------------------- */

/** Ask the page-world probe "which node is flight X". Request/response over the window; the
 *  probe holds the buffered payloads, we hold the patience. */
function findInPayloads(target: CtripQuoteTarget): Promise<Pick<ProbeFindAnswer, 'result' | 'payloadsSeen' | 'flightsSeen'>> {
  return new Promise((resolve) => {
    const nonce = crypto.randomUUID()
    const onAnswer = (event: MessageEvent) => {
      if (event.source !== window) return
      const data = event.data as Partial<ProbeFindAnswer> | null
      if (data?.channel !== API_PROBE_CHANNEL || data.type !== 'found' || data.nonce !== nonce) return
      window.removeEventListener('message', onAnswer)
      resolve({ result: data.result ?? null, payloadsSeen: data.payloadsSeen ?? 0, flightsSeen: data.flightsSeen ?? 0 })
    }
    window.addEventListener('message', onAnswer)
    window.postMessage(
      {
        channel: API_PROBE_CHANNEL,
        type: 'find',
        nonce,
        flightNo: target.flightNo,
        opFlightNo: target.opFlightNo ?? null,
        outbound: target.outbound
          ? { flightNo: target.outbound.flightNo, opFlightNo: target.outbound.opFlightNo ?? null }
          : null,
        ...(target.debug === true ? { debug: true } : {}),
      } satisfies ProbeFindRequest,
      '*',
    )
    // The probe answers synchronously today; the timeout only covers it not being injected at all.
    window.setTimeout(() => {
      window.removeEventListener('message', onAnswer)
      resolve({ result: null, payloadsSeen: -1, flightsSeen: 0 })
    }, 1_000)
  })
}

/** Find the target outbound's 「选为去程」 button, scrolled into view, with the viewport centre
 *  point a real mouse event would need. Returns null while the list is still rendering. */
function locateOutbound(outbound: { flightNo: string; departureTime?: string }):
  { button: HTMLElement; x: number; y: number } | null {
  const wanted = normalizeFlightNo(outbound.flightNo)
  for (const card of document.querySelectorAll<HTMLElement>(FLIGHT_CARD_SELECTOR)) {
    const text = card.innerText || ''
    const nos = [...text.matchAll(new RegExp(`\\b(${FLIGHT_NO_PATTERN})\\b`, 'g'))].map((match) => normalizeFlightNo(match[1]!))
    if (!nos.includes(wanted)) continue
    if (outbound.departureTime && !text.includes(outbound.departureTime)) continue
    const label = [...card.querySelectorAll<HTMLElement>('*')]
      .find((el) => !el.children.length && /选为去程/.test(el.textContent || ''))
    if (!label) return null
    const button = label.closest<HTMLElement>('.btn') ?? label
    // A real mouse event is delivered to whatever is at those coordinates, so the button has to
    // actually be on screen — off-viewport coordinates would land on nothing.
    button.scrollIntoView({ block: 'center' })
    const rect = button.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return { button, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }
  return null
}

/** Filter Ctrip's own search JSON down to ONE flight and hand back its node. The page never
 *  renders most of what the payload holds (measured: 4 rows painted, 197 flights returned), so
 *  the DOM path is not consulted at all here. */
async function runQuote(target: CtripQuoteTarget): Promise<void> {
  const isRound = isRoundTripCapture({ url: location.href })
  const started = Date.now()
  const deadline = started + (isRound ? 100_000 : 45_000)
  let emptyPolls = 0

  /** How far the outbound selection has escalated. Cheapest first: a plain click costs nothing
   *  and shows no warning bar, so the debugger is only reached once that has demonstrably been
   *  ignored, and a person only after BOTH have been. */
  let stage: 'none' | 'synthetic' | 'trusted' | 'person' = 'none'
  let stageAt = 0
  const SYNTHETIC_GRACE_MS = 6_000
  const TRUSTED_GRACE_MS = 15_000

  // The last poll's counts, kept for the failure message: re-asking after the loop would run
  // the whole match scan once more just to word two integers.
  let payloadsSeen = 0
  let flightsSeen = 0

  while (Date.now() < deadline) {
    const found = await findInPayloads(target)
    const result = found.result
    if (found.payloadsSeen >= 0) {
      payloadsSeen = found.payloadsSeen
      flightsSeen = found.flightsSeen
    }

    if (result) {
      const quote: CtripFlightQuote = { ...result, url: location.href, capturedAt: new Date().toISOString() }
      await chrome.runtime.sendMessage({ type: 'ctrip-quote', quote })
      return
    }

    // Round trip: the return fares do not exist until an outbound is selected.
    if (isRound && target.outbound?.flightNo && payloadsSeen > 0) {
      const now = Date.now()
      const waited = now - stageAt

      if (stage === 'none') {
        const spot = locateOutbound(target.outbound)
        if (spot) {
          spot.button.click()
          stage = 'synthetic'
          stageAt = now
        }
      } else if (stage === 'synthetic' && waited > SYNTHETIC_GRACE_MS) {
        // `isTrusted: false` was ignored. Ask the worker for a real mouse event at the button.
        const spot = locateOutbound(target.outbound)
        stage = 'trusted'
        stageAt = now
        if (spot) void chrome.runtime.sendMessage({ type: 'trusted-click', x: spot.x, y: spot.y })
      } else if (stage === 'trusted' && waited > TRUSTED_GRACE_MS) {
        // Even a real click produced no return payload — hand it to the operator.
        stage = 'person'
        void chrome.runtime.sendMessage({ type: 'reveal-tab' })
      }
    }

    // One-way: once payloads exist and settle, a missing flight is an answer, not a timeout.
    if (!isRound && payloadsSeen > 0 && ++emptyPolls >= 5) break

    if (probe().blocked) break
    await sleep(1_500)
  }

  const blocked = probe().blocked
  await chrome.runtime.sendMessage({
    type: 'ctrip-capture-failed',
    url: location.href,
    needsPerson: blocked || (isRound && stage !== 'person'),
    reason: blocked
      ? '携程未登录（或要求验证）。已为你打开该标签页，登录后重试'
      : payloadsSeen > 0
        ? `携程返回的 ${flightsSeen} 班中没有 ${target.flightNo}${isRound ? '（往返需先选定去程，请在打开的页面点击「选为去程」后重试）' : '（可能已售罄或停售）'}`
        : '未捕获到携程的搜索响应（页面可能未完成加载）',
  })
}

async function run() {
  const { capture, trace } = await captureWhenReady()
  // Report the failure explicitly rather than sending an empty capture that reads like a
  // successful zero-flight day. The SPA turns this into "未识别，请手填".
  const failed = capture.blocked || capture.count === 0 || capture.lowest === null
  if (!failed) {
    await chrome.runtime.sendMessage({ type: 'ctrip-capture', capture })
    return
  }

  // Distinguish "the page never rendered while we were hidden" from "we read the page and it
  // did not parse" — same empty result, opposite fixes, and only the trace tells them apart.
  const looksThrottled = trace.counts.every((n) => n === 0) && trace.everHidden

  // `blocked` in practice means Ctrip refused a browser with no session — measured: a signed-in
  // profile renders the list from the same IP, a cookie-less one gets `whaleguard block`, and so
  // does a brand-new profile. So say what actually fixes it instead of "please retry".
  await chrome.runtime.sendMessage({
    type: 'ctrip-capture-failed',
    url: location.href,
    // Bring the tab forward whenever a person could plausibly act on it — logging in, or
    // simply looking at a page that refused to render behind their back.
    needsPerson: capture.blocked || looksThrottled,
    reason: capture.blocked
      ? '携程未登录（或要求验证）。已为你打开该标签页，登录后重试'
      : looksThrottled
        ? `携程页在后台未渲染（等待 ${Math.round(trace.elapsedMs / 1000)} 秒仍为空）。已切到该标签页，请重试`
        : capture.strategy === 'fallback-scan'
          ? '页面结构无法识别（携程可能已改版）'
          : '未读到航班价格',
    trace,
  })
}

/** Which job is this tab running? Pull, not push: the worker holds the pending map, and asking
 *  on startup is race-free where a pushed message could land before this listener exists. */
async function dispatch(): Promise<void> {
  let target: CtripQuoteTarget | null = null
  try {
    const job = (await chrome.runtime.sendMessage({ type: 'ctrip-job' })) as { target?: CtripQuoteTarget | null } | undefined
    target = job?.target ?? null
  } catch {
    /* worker asleep or gone — the DOM capture path needs no job details */
  }
  if (target?.flightNo) return runQuote(target)
  return run()
}

void dispatch().catch((error: unknown) => {
  void chrome.runtime.sendMessage({
    type: 'ctrip-capture-failed',
    url: location.href,
    reason: error instanceof Error ? error.message : '读取失败',
  })
})
