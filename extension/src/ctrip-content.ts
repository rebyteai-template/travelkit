import type { CtripCapture } from '@travelkit/contract'

import { extractCtripPrices } from './extract/ctrip-extract.ts'

/**
 * Waits for Ctrip's fare list to render, reads it, and reports back.
 *
 * The wait lives HERE and not in the service worker on purpose. An MV3 worker is torn down
 * after 30s idle and its timers are cancelled with it, so a `setTimeout` there may simply never
 * fire. A content script lives as long as its tab, so it can afford to be patient — the worker
 * stays purely event-driven and is woken by the message this file eventually sends.
 *
 * Patience is not optional: the list is lazily rendered and measurably needs more than six
 * seconds (a 6s wait came back empty on one route and twelve was reliable). Polling until the
 * count stops changing beats a fixed sleep — it returns early when the page is quick and still
 * covers a slow one.
 */

/** Give up here. Past this the page is broken, blocked, or asking for a login — all cases where
 *  the honest answer is "I could not read it", not a half-rendered list. */
const DEADLINE_MS = 25_000
const POLL_MS = 500
/** Two identical non-zero counts in a row means the list settled; stop early rather than
 *  burning the full deadline on a page that finished in three seconds. */
const STABLE_POLLS = 2
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
  const deadline = started + DEADLINE_MS
  const counts: number[] = []
  let previousCount = -1
  let stable = 0
  let everHidden = document.visibilityState === 'hidden'
  let revealed = false
  let latest = extractCtripPrices()

  const trace = (): Trace => ({
    elapsedMs: Date.now() - started,
    visibility: document.visibilityState,
    everHidden,
    revealed,
    counts: counts.slice(-12),
  })

  while (Date.now() < deadline) {
    latest = extractCtripPrices()
    counts.push(latest.count)
    if (document.visibilityState === 'hidden') everHidden = true
    // A block page will never fill in; reporting it immediately is more useful than waiting.
    if (latest.blocked) return { capture: latest, trace: trace() }
    if (latest.count > 0 && latest.count === previousCount) {
      stable += 1
      if (stable >= STABLE_POLLS) return { capture: latest, trace: trace() }
    } else {
      stable = 0
    }

    // Nothing at all after a generous wait, and we are hidden: Chrome may be withholding the
    // work this page needs. Ask to be brought forward and keep going rather than failing —
    // an interruption the operator can see beats a capture that silently gave up.
    if (!revealed && latest.count === 0 && document.visibilityState === 'hidden'
        && Date.now() - started > REVEAL_AFTER_MS) {
      revealed = true
      void chrome.runtime.sendMessage({ type: 'reveal-tab' })
    }

    previousCount = latest.count
    await sleep(POLL_MS)
  }
  return { capture: latest, trace: trace() }
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
  const neverRendered = trace.counts.every((n) => n === 0)
  const looksThrottled = neverRendered && trace.everHidden

  // `blocked` in practice means Ctrip refused a browser with no session — measured: a signed-in
  // profile renders the list from the same IP, a cookie-less one gets `whaleguard block`, and so
  // does a brand-new profile. So say what actually fixes it instead of "please retry", and ask
  // the background to bring this tab forward: logging in is something only a person can do here.
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

void run().catch((error: unknown) => {
  void chrome.runtime.sendMessage({
    type: 'ctrip-capture-failed',
    url: location.href,
    reason: error instanceof Error ? error.message : '读取失败',
  })
})
