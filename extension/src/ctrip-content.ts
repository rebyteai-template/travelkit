import type { CtripCapture } from '@travelkit/contract'

import { extractCtripPrices, probe } from './extract/ctrip-extract.ts'

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
    const settled = count > 0 && counts.slice(-STABLE_POLLS).every((n) => n === count)
    if (settled && counts.length >= STABLE_POLLS) break

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
    capture: extractCtripPrices(),
    trace: {
      elapsedMs: Date.now() - started,
      visibility: document.visibilityState,
      everHidden,
      revealed,
      counts: counts.slice(-12),
    },
  }
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

void run().catch((error: unknown) => {
  void chrome.runtime.sendMessage({
    type: 'ctrip-capture-failed',
    url: location.href,
    reason: error instanceof Error ? error.message : '读取失败',
  })
})
