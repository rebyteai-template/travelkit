import { useCallback, useEffect, useRef, useState } from 'react'

import {
  BRIDGE_CHANNEL,
  type BridgeMessage,
  type CtripCapture,
  type CtripFlightQuote,
  type CtripQuoteTarget,
} from '@travelkit/contract'

/**
 * Talks to the Ctrip-price browser extension, if the operator installed one.
 *
 * The extension is OPTIONAL and always will be: the operator is a customer's employee on a
 * customer-managed machine, so we cannot install anything. Without one there is no Ctrip figure
 * in the plan cell at all — by design. A price typed by hand looks identical to one read off
 * Ctrip yet carries none of its evidence (which flight matched, out of how many, when), and an
 * operator's recollection of a fare is not a comparison we want to store or quote against.
 *
 * No credential crosses this bridge in either direction. We send a URL, we get public prices
 * back, and the write to our own API happens here — in the app, with the session it already has.
 */

/** Extensions announce themselves on load. If nothing has spoken by now, assume none is present
 *  and let the UI offer the install hint. Generous, because the content script only runs at
 *  `document_idle` and the app may well have rendered first. */
const READY_GRACE_MS = 2500

export interface CtripBridge {
  /** Whether an extension answered. `null` while we are still waiting to find out — the UI
   *  should show neither the shortcut nor the install hint during that window. */
  installed: boolean | null
  /** Ask the extension to read a Ctrip page. Resolves with the capture, or null if it could not
   *  be read (blocked, redesigned, timed out) — the caller shows `lastError` and leaves the
   *  button ready to try again. */
  capture: (url: string) => Promise<CtripCapture | null>
  /** Ask for ONE flight's quote, filtered inside the extension out of Ctrip's own search JSON.
   *  Same window plumbing as `capture`; resolves null on failure with `lastError` explaining. */
  quote: (url: string, target: CtripQuoteTarget) => Promise<CtripFlightQuote | null>
  /** The last failure's operator-facing reason, for a hint beside the read button. */
  lastError: string | null
  /** Build stamp of the extension that answered, so a stale reload is visible from the app. */
  version: string | null
}

/** A scrape opens a real page and waits for a lazily rendered list. The extension gives up at
 *  DEADLINE_MS (25s, extension/src/ctrip-content.ts); this must outlast that or we would report
 *  a timeout for a capture the extension is about to answer. */
const CAPTURE_TIMEOUT_MS = 30_000
/** A quote can legitimately take much longer: on a round trip the return payload only exists
 *  after 「选为去程」, and when Ctrip ignores the extension's synthetic click the fallback is a
 *  HUMAN clicking in the revealed window. The extension side gives up at 100s. */
const QUOTE_TIMEOUT_MS = 110_000

export function useCtripBridge(): CtripBridge {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  /** nonce → the promise waiting on it. The value is whatever the caller asked for — capture or
   *  quote — and each wrapper narrows its own result, so a crossed wire resolves null, not lies. */
  const waiting = useRef(new Map<string, (result: CtripCapture | CtripFlightQuote | null) => void>())

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Only our own frame, our own origin, our own channel tag. The embedding customer page is
      // cross-origin and cannot post here, but a co-resident content script in this frame could.
      // Comparing against our OWN origin is both the tightest check and the one that cannot drift
      // from wherever the app happens to be served (prod, a preview, dev on localhost).
      if (event.source !== window || event.origin !== window.location.origin) return
      const data = event.data as Partial<BridgeMessage> | null
      if (!data || data.channel !== BRIDGE_CHANNEL) return

      if (data.type === 'extension-ready') {
        setInstalled(true)
        setVersion(typeof data.version === 'string' ? data.version : null)
        return
      }
      if (data.type === 'capture' || data.type === 'quote' || data.type === 'capture-failed') {
        const nonce = 'nonce' in data ? String(data.nonce) : ''
        const resolve = waiting.current.get(nonce)
        if (!resolve) return
        waiting.current.delete(nonce)
        if (data.type === 'capture') {
          setLastError(null)
          resolve((data as Extract<BridgeMessage, { type: 'capture' }>).capture)
        } else if (data.type === 'quote') {
          setLastError(null)
          resolve((data as Extract<BridgeMessage, { type: 'quote' }>).quote)
        } else {
          setLastError((data as Extract<BridgeMessage, { type: 'capture-failed' }>).reason || '读取失败')
          resolve(null)
        }
      }
    }

    window.addEventListener('message', onMessage)
    // Ask, rather than only waiting to be told. The extension's own announce fires once at
    // `document_idle` and can beat this listener into existence; without a ping that miss is
    // permanent and looks identical to "not installed". Asking makes the order irrelevant.
    // Repeated a couple of times because the content script may still be injecting on a cold load.
    const ping = () => window.postMessage({ channel: BRIDGE_CHANNEL, type: 'ping' }, window.location.origin)
    ping()
    const retries = [250, 1000].map((delay) => window.setTimeout(ping, delay))
    const timer = window.setTimeout(() => setInstalled((current) => current ?? false), READY_GRACE_MS)
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
      retries.forEach(window.clearTimeout)
    }
  }, [])

  /** One request machine for both shapes: register the nonce, arm the give-up timer, post. */
  const ask = useCallback(
    <T extends CtripCapture | CtripFlightQuote>(url: string, timeoutMs: number, target?: CtripQuoteTarget) => {
      return new Promise<T | null>((resolve) => {
        const nonce = crypto.randomUUID()
        // Never leave a caller hanging: if no extension is listening, nothing will ever reply.
        // Cleared on the answering path, so a finished capture does not keep a timer (and the
        // closure over `resolve`) alive for another half minute.
        const timer = window.setTimeout(() => {
          waiting.current.delete(nonce)
          setLastError('携程读取超时，可重试')
          resolve(null)
        }, timeoutMs)
        waiting.current.set(nonce, (result) => {
          window.clearTimeout(timer)
          resolve(result as T | null)
        })
        window.postMessage(
          { channel: BRIDGE_CHANNEL, type: 'capture-request', nonce, url, ...(target ? { target } : {}) },
          window.location.origin,
        )
      })
    },
    [],
  )

  const capture = useCallback((url: string) => ask<CtripCapture>(url, CAPTURE_TIMEOUT_MS), [ask])
  const quote = useCallback(
    (url: string, target: CtripQuoteTarget) => ask<CtripFlightQuote>(url, QUOTE_TIMEOUT_MS, target),
    [ask],
  )

  return { installed, capture, quote, lastError, version }
}

