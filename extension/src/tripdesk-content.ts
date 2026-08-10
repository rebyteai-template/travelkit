import { BRIDGE_CHANNEL, type BridgeMessage, type PageMessage } from '@travelkit/contract'

/**
 * The bridge between the TravelKit SPA and this extension.
 *
 * SECURITY, and the reason this file is deliberately tiny: it runs on the TravelKit origin,
 * where the app keeps its real credential in `sessionStorage.td_tk`. An isolated-world content
 * script can read that. This one does not, and must never be extended to — it forwards two
 * message shapes and nothing else. The whole design keeps credentials out of the extension:
 * we send public prices to the SPA, and the SPA writes them with the session it already has.
 * Because no token ever crosses this bridge, a co-resident extension listening on the same
 * window learns nothing worth having.
 *
 * A content script is used rather than `externally_connectable` because the app is framed by an
 * arbitrary customer page: Chrome would require that unknown top-frame origin in `matches`, so
 * that route cannot work here. Content scripts match on each frame's own URL, so `all_frames`
 * injects wherever the app is embedded.
 */

/** Ignore anything that is not this app talking to us: right window, right origin, right tag.
 *  The parent frame is cross-origin and cannot read these messages, but a co-resident script in
 *  THIS frame could post one, so the check is not decoration.
 *
 *  `location.origin` is the tightest check available and needs no constant: this script only
 *  runs on origins `content_scripts.matches` allowed, so the frame's own origin IS the allowed
 *  one. Keeping the allowlist in the manifest alone means there is exactly one place to audit. */
function isFromApp(event: MessageEvent): boolean {
  return event.source === window && event.origin === location.origin
}

window.addEventListener('message', (event: MessageEvent) => {
  if (!isFromApp(event)) return
  const data = event.data as Partial<PageMessage> | null
  if (!data || data.channel !== BRIDGE_CHANNEL || data.type !== 'capture-request') return
  if (typeof data.url !== 'string' || typeof data.nonce !== 'string') return

  // The URL is validated again in the service worker before any tab is opened — this side is
  // untrusted input even though it comes from our own app.
  void chrome.runtime.sendMessage({ type: 'request-capture', url: data.url, nonce: data.nonce })
})

/** Results come back from the service worker; hand them to the page. */
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (typeof message !== 'object' || message === null || !('type' in message)) return
  const tagged = message as { type: string; [key: string]: unknown }

  if (tagged.type === 'capture') {
    post({
      channel: BRIDGE_CHANNEL,
      type: 'capture',
      nonce: String(tagged.nonce),
      capture: tagged.capture as BridgeMessage extends { capture: infer C } ? C : never,
    } as BridgeMessage)
  } else if (tagged.type === 'capture-failed') {
    post({
      channel: BRIDGE_CHANNEL,
      type: 'capture-failed',
      nonce: String(tagged.nonce),
      url: String(tagged.url ?? ''),
      reason: String(tagged.reason ?? '读取失败'),
    })
  }
})

/** Always address this frame's own origin explicitly — never `'*'`, which would broadcast to
 *  whatever else is listening on this window. */
function post(message: BridgeMessage): void {
  window.postMessage(message, location.origin)
}

// Announce ourselves so the app can drop its "install the extension" hint. Carries only a
// version string.
post({ channel: BRIDGE_CHANNEL, type: 'extension-ready', version: chrome.runtime.getManifest().version })
