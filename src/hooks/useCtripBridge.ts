import { useCallback, useEffect, useRef, useState } from 'react'

import {
  BRIDGE_CHANNEL,
  CTRIP_CURRENCY,
  TRAVELKIT_ORIGIN,
  type BridgeMessage,
  type CtripCapture,
} from '@travelkit/contract'

/**
 * Talks to the Ctrip-price browser extension, if the operator installed one.
 *
 * The extension is OPTIONAL and always will be: the operator is a customer's employee on a
 * customer-managed machine, so we cannot install anything. Typing the price in by hand is the
 * baseline flow; this hook is the shortcut for people who chose to add the extension. Everything
 * degrades to the manual input, including a scrape that fails.
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
   *  be read (blocked, redesigned, timed out) — the caller falls back to asking for manual entry. */
  capture: (url: string) => Promise<CtripCapture | null>
  /** The last failure's operator-facing reason, for a hint beside the manual input. */
  lastError: string | null
}

/** A scrape opens a real tab and waits for a lazily rendered list; the extension gives up at 20s,
 *  so this has to outlast that or we would report a timeout the extension is about to answer. */
const CAPTURE_TIMEOUT_MS = 30_000

export function useCtripBridge(): CtripBridge {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  /** nonce → the promise waiting on it. */
  const waiting = useRef(new Map<string, (capture: CtripCapture | null) => void>())

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Only our own frame, our own origin, our own channel tag. The embedding customer page is
      // cross-origin and cannot post here, but a co-resident content script in this frame could.
      if (event.source !== window || event.origin !== TRAVELKIT_ORIGIN) return
      const data = event.data as Partial<BridgeMessage> | null
      if (!data || data.channel !== BRIDGE_CHANNEL) return

      if (data.type === 'extension-ready') {
        setInstalled(true)
        return
      }
      if (data.type === 'capture' || data.type === 'capture-failed') {
        // An extension that answers is installed, whatever the answer was.
        setInstalled(true)
        const nonce = 'nonce' in data ? String(data.nonce) : ''
        const resolve = waiting.current.get(nonce)
        if (!resolve) return
        waiting.current.delete(nonce)
        if (data.type === 'capture') {
          setLastError(null)
          resolve((data as Extract<BridgeMessage, { type: 'capture' }>).capture)
        } else {
          setLastError((data as Extract<BridgeMessage, { type: 'capture-failed' }>).reason || '读取失败')
          resolve(null)
        }
      }
    }

    window.addEventListener('message', onMessage)
    const timer = window.setTimeout(() => setInstalled((current) => current ?? false), READY_GRACE_MS)
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
    }
  }, [])

  const capture = useCallback((url: string) => {
    return new Promise<CtripCapture | null>((resolve) => {
      const nonce = crypto.randomUUID()
      waiting.current.set(nonce, resolve)
      window.postMessage({ channel: BRIDGE_CHANNEL, type: 'capture-request', nonce, url }, TRAVELKIT_ORIGIN)
      // Never leave a caller hanging: if no extension is listening, nothing will ever reply.
      window.setTimeout(() => {
        if (!waiting.current.has(nonce)) return
        waiting.current.delete(nonce)
        setLastError('读取超时，请手动填写')
        resolve(null)
      }, CAPTURE_TIMEOUT_MS)
    })
  }, [])

  return { installed, capture, lastError }
}

/** Pull the figure we want out of a capture: the cheapest listed fare.
 *
 *  Returns null rather than a guess when the page yielded nothing usable — this number becomes a
 *  price the operator quotes against, so "I could not read it" has to stay distinguishable from
 *  "it is cheap". Note the basis: Ctrip lists fares PRE-TAX while our plan totals include tax;
 *  the UI labels the gap as un-normalized rather than pretending they are comparable. */
export function captureToPrice(capture: CtripCapture): { amount: number; currency: string } | null {
  if (capture.blocked || capture.lowest === null || capture.lowest <= 0) return null
  return { amount: capture.lowest, currency: CTRIP_CURRENCY }
}
