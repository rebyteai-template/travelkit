import type { CtripCapture } from '@travelkit/contract'

/**
 * Relay between the two content scripts. It opens the Ctrip tab, remembers which TravelKit tab
 * asked, and routes the result back.
 *
 * Purely event-driven, because an MV3 service worker is disposable: it is killed after 30s idle
 * and module-level state dies with it. Every request that must outlive a single message therefore
 * goes to `chrome.storage.session`, and nothing here ever sleeps or polls — the long wait belongs
 * to the ctrip content script, which lives as long as its tab.
 *
 * It carries no credential. The capture is public price data on its way back to the SPA, which
 * does the authenticated write itself, so there is nothing in this worker worth stealing.
 */

/** ctrip tabId → who asked. Session-scoped: pending work is meaningless across a browser restart. */
const PENDING_KEY = 'pendingCaptures'

interface Pending {
  /** Correlates the reply with the SPA's request. */
  nonce: string
  /** The TravelKit tab to answer. */
  sourceTabId: number
  /** Set when we spawned a popup window for this capture, so it can be cleaned up again.
   *  Absent for the plain-tab fallback, whose tab we leave alone. */
  windowId?: number
}

type PendingMap = Record<string, Pending>

async function readPending(): Promise<PendingMap> {
  const stored = await chrome.storage.session.get(PENDING_KEY)
  return (stored[PENDING_KEY] as PendingMap | undefined) ?? {}
}

async function writePending(map: PendingMap): Promise<void> {
  await chrome.storage.session.set({ [PENDING_KEY]: map })
}

async function takePending(tabId: number): Promise<Pending | undefined> {
  const map = await readPending()
  const entry = map[String(tabId)]
  if (entry) {
    delete map[String(tabId)]
    await writePending(map)
  }
  return entry
}

/** Only ever open Ctrip. The URL arrives over the page bridge, so it is treated as untrusted
 *  input: anything but a Ctrip flight-list URL is refused rather than opened. */
function isCtripListUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'flights.ctrip.com'
  } catch {
    return false
  }
}

/**
 * Open the page somewhere it will actually render, without stealing the operator's focus.
 *
 * A background tab does not work: measured, a foreground tab captures and a background one
 * comes back with zero flights every time. Chrome withholds painting and rAF from hidden tabs
 * and Ctrip's list needs them, so `active: false` produces a page that never fills in.
 *
 * An unfocused popup window threads the needle. Its tab is the active tab OF THAT WINDOW, so
 * `document.visibilityState` is `visible` and the list renders — while `focused: false` leaves
 * keyboard focus in TravelKit, which is the part the operator actually cared about. It is
 * offset rather than stacked exactly behind, because a fully occluded window can be marked
 * hidden by Chrome and we would be back to the throttled case.
 */
async function openCapture(url: string, nonce: string, sourceTabId: number): Promise<void> {
  let tabId: number | undefined
  let windowId: number | undefined

  try {
    const win = await chrome.windows.create({
      url,
      focused: false,
      type: 'popup',
      width: 1100,
      height: 780,
      top: 60,
      left: 60,
    })
    windowId = win?.id
    tabId = win?.tabs?.[0]?.id
  } catch {
    /* popup blocked or unsupported — fall through to a plain tab */
  }

  // Last resort. It renders poorly in the background, but a capture that reports zero flights
  // is a reported failure, not a wrong price, and the content script will ask to be revealed.
  if (tabId === undefined) {
    const tab = await chrome.tabs.create({ url, active: false })
    tabId = tab.id
    windowId = undefined
  }
  if (tabId === undefined) return

  const map = await readPending()
  map[String(tabId)] = { nonce, sourceTabId, windowId }
  await writePending(map)
}

async function reply(tabId: number, message: unknown): Promise<void> {
  // The TravelKit tab may have been closed mid-scrape; a failed send is expected, not an error.
  try {
    await chrome.tabs.sendMessage(tabId, message)
  } catch {
    /* the asking tab is gone — drop the result */
  }
}

/** Close a popup window we created for a capture. Never touches a window we did not spawn. */
async function disposePopup(windowId: number | undefined): Promise<void> {
  if (windowId === undefined) return
  try {
    await chrome.windows.remove(windowId)
  } catch {
    /* already gone */
  }
}

/** Bring the tab forward instead of closing it, for the failures a person has to resolve —
 *  chiefly Ctrip refusing a browser with no session, where the fix is to log in on that page.
 *  Closing it would hide the one thing the operator needs to act on. */
async function revealTab(tabId: number, windowId?: number): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { active: true })
    // The capture window is deliberately unfocused; activating a tab inside it is not enough to
    // put it where the operator can see it, so raise the window as well.
    if (windowId !== undefined) await chrome.windows.update(windowId, { focused: true })
  } catch {
    /* gone */
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void (async () => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    const tagged = message as { type: string; [key: string]: unknown }

    if (tagged.type === 'request-capture') {
      const url = typeof tagged.url === 'string' ? tagged.url : ''
      const nonce = typeof tagged.nonce === 'string' ? tagged.nonce : ''
      const sourceTabId = sender.tab?.id
      if (!nonce || sourceTabId === undefined) return
      if (!isCtripListUrl(url)) {
        await reply(sourceTabId, { type: 'capture-failed', nonce, url, reason: '不是携程航班列表地址' })
        return
      }
      await openCapture(url, nonce, sourceTabId)
      return
    }

    // Results arrive from the ctrip tab; `sender.tab.id` is how we know which request they answer.
    const ctripTabId = sender.tab?.id
    if (ctripTabId === undefined) return

    // A hidden tab that still has not rendered asks to be shown. Chrome withholds painting and
    // rAF from background tabs, and if Ctrip's list turns out to need either, being visible is
    // the only way through — better a visible tab than a capture that quietly failed.
    if (tagged.type === 'reveal-tab') {
      const map = await readPending()
      await revealTab(ctripTabId, map[String(ctripTabId)]?.windowId)
      return
    }

    if (tagged.type === 'ctrip-capture') {
      const pending = await takePending(ctripTabId)
      if (!pending) return
      await reply(pending.sourceTabId, {
        type: 'capture',
        nonce: pending.nonce,
        capture: tagged.capture as CtripCapture,
      })
      // Dispose of the popup WE spawned — one per capture would litter the desktop. This is not
      // the tab-closing the operator asked us to drop: that was a tab in their own window.
      await disposePopup(pending.windowId)
      return
    }

    if (tagged.type === 'ctrip-capture-failed') {
      const pending = await takePending(ctripTabId)
      if (!pending) return
      const needsPerson = tagged.needsPerson === true
      // Logged so a failed capture can be diagnosed from the service worker console instead of
      // by re-running it and hoping. Carries only page-shape numbers — no prices, no identity.
      console.warn('[ctrip] capture failed', {
        url: tagged.url,
        reason: tagged.reason,
        trace: tagged.trace,
      })
      await reply(pending.sourceTabId, {
        type: 'capture-failed',
        nonce: pending.nonce,
        url: typeof tagged.url === 'string' ? tagged.url : '',
        reason: typeof tagged.reason === 'string' ? tagged.reason : '读取失败',
      })
      // Surface the tab when a person has something to DO there (log in, or look at a page
      // that would not render behind their back). Otherwise leave it be — the operator asked
      // that these tabs not vanish, and a closed tab takes the evidence with it.
      if (needsPerson) await revealTab(ctripTabId, pending.windowId)
    }
  })()
  // Nothing here answers synchronously; the reply travels back as its own message.
  sendResponse(undefined)
  return false
})

/** A tab closed before it reported leaves a dangling entry; drop it so the map cannot grow. */
chrome.tabs.onRemoved.addListener((tabId) => {
  void takePending(tabId)
})
