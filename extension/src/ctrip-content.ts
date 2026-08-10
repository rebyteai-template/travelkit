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
const DEADLINE_MS = 20_000
const POLL_MS = 500
/** Two identical non-zero counts in a row means the list settled; stop early rather than
 *  burning the full deadline on a page that finished in three seconds. */
const STABLE_POLLS = 2

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function captureWhenReady(): Promise<CtripCapture> {
  const deadline = Date.now() + DEADLINE_MS
  let previousCount = -1
  let stable = 0
  let latest = extractCtripPrices()

  while (Date.now() < deadline) {
    latest = extractCtripPrices()
    // A block page will never fill in; reporting it immediately is more useful than waiting.
    if (latest.blocked) return latest
    if (latest.count > 0 && latest.count === previousCount) {
      stable += 1
      if (stable >= STABLE_POLLS) return latest
    } else {
      stable = 0
    }
    previousCount = latest.count
    await sleep(POLL_MS)
  }
  return latest
}

async function run() {
  const capture = await captureWhenReady()
  // Report the failure explicitly rather than sending an empty capture that reads like a
  // successful zero-flight day. The SPA turns this into "未识别，请手填".
  const failed = capture.blocked || capture.count === 0 || capture.lowest === null
  await chrome.runtime.sendMessage(
    failed
      ? {
          type: 'ctrip-capture-failed',
          url: location.href,
          reason: capture.blocked
            ? '携程要求验证，请在该标签页完成后重试'
            : capture.strategy === 'fallback-scan'
              ? '页面结构无法识别（携程可能已改版）'
              : '未读到航班价格',
        }
      : { type: 'ctrip-capture', capture },
  )
}

void run().catch((error: unknown) => {
  void chrome.runtime.sendMessage({
    type: 'ctrip-capture-failed',
    url: location.href,
    reason: error instanceof Error ? error.message : '读取失败',
  })
})
