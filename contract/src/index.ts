/**
 * The wire contract between the Ctrip-price browser extension and the TravelKit app.
 *
 * Mostly types, plus the few constants and the one predicate that both sides must agree on.
 * The package has NO dependencies, which is what keeps React and workers-types out of the
 * extension bundle and `chrome` types out of the Worker — that, not the absence of runtime
 * code, is the property worth preserving here.
 *
 * Nothing here is a booking fact. Everything in this file was read off a third party's web page
 * and is only ever an operator hint (see migrations/0014).
 */

/** Which parser produced a capture. `flight-item` is Ctrip's own semantic container and the
 *  result we trust; `fallback-scan` means that class was gone and we pattern-matched instead,
 *  which is worth surfacing because a redesign shows up here first. */
export type ExtractStrategy = 'flight-item' | 'fallback-scan'

/** One flight row as Ctrip rendered it. Every field is optional-by-nullability because a
 *  redesign can drop any of them, and a missing field must degrade the row rather than the run. */
export interface CtripFlightRow {
  flightNo: string | null
  airline: string | null
  aircraft: string | null
  depTime: string | null
  arrTime: string | null
  depAirport: string | null
  arrAirport: string | null
  /** The fare Ctrip lists. NOTE: pre-tax — Ctrip's list page excludes the airport fee and fuel
   *  surcharge, while TravelKit plan totals are tax-inclusive. Do not compare the two without
   *  saying so; see docs and the un-normalized gap label in the UI. */
  price: number | null
  cabin: string | null
  discountOff: number | null
  seatsLeft: number | null
  isTransfer: boolean
}

/** One scrape of one Ctrip list page.
 *
 *  `blocked` and a `fallback-scan` strategy with `count: 0` are the fail-closed signals: the
 *  extension reports that it could not read the page rather than inventing a number, and the UI
 *  falls back to asking the operator to type one. A wrong price here would misprice a quote. */
export interface CtripCapture {
  url: string
  capturedAt: string
  strategy: ExtractStrategy
  blocked: boolean
  count: number
  /** Cheapest listed fare, or null when nothing parsed. */
  lowest: number | null
  flights: CtripFlightRow[]
}

/** Ctrip quotes CNY on the mainland site; the field exists so the app never has to assume. */
export const CTRIP_CURRENCY = 'CNY'

/** How a plan's comparison figure got here. Typed once: the SPA, the Worker and the extension
 *  all name these two, and a third source must be impossible to add in only one of them. */
export type ReferencePriceSource = 'manual' | 'ctrip-extension'

/** Upper bound on a comparison figure, shared so the input cannot accept what the endpoint
 *  refuses. It rejected values above this while the UI happily submitted them, and with no
 *  error path on the mutation the 400 was invisible: the field cleared and the operator
 *  believed the number had saved. */
export const MAX_REFERENCE_AMOUNT = 10_000_000

/** The one place "is this a usable comparison figure" is decided. */
export const isUsableReferenceAmount = (amount: unknown): amount is number =>
  typeof amount === 'number' && Number.isFinite(amount) && amount > 0 && amount <= MAX_REFERENCE_AMOUNT

/** Messages the extension puts on the page bridge, addressed to the TravelKit SPA.
 *
 *  The bridge deliberately carries NO credential in either direction. The extension scrapes and
 *  hands over public prices; the SPA writes them with the embed session it already holds. That
 *  is why there is no token in any of these shapes — there is nothing here worth stealing. */
export type BridgeMessage =
  /** Extension announcing itself so the SPA can stop offering the install hint. */
  | { channel: typeof BRIDGE_CHANNEL; type: 'extension-ready'; version: string }
  /** A completed scrape, tagged with the page it came from so the SPA can match it to a plan. */
  | { channel: typeof BRIDGE_CHANNEL; type: 'capture'; nonce: string; capture: CtripCapture }
  /** A scrape that could not produce a usable figure. `reason` is for the operator, not a metric. */
  | { channel: typeof BRIDGE_CHANNEL; type: 'capture-failed'; nonce: string; url: string; reason: string }

/** Messages the SPA puts on the bridge, addressed to the extension. */
export type PageMessage =
  /** Asking the extension to open a Ctrip page and read it. `nonce` correlates the reply. */
  | { channel: typeof BRIDGE_CHANNEL; type: 'capture-request'; nonce: string; url: string }
  /** "Anyone there?" — the app asks on mount and the extension answers `extension-ready`.
   *
   *  Needed because the extension's unsolicited announce fires once, at `document_idle`,
   *  which can easily land BEFORE React has attached its listener; that message is then gone
   *  and the app would decide, wrongly and permanently, that no extension is installed.
   *  Making the app able to ask removes the ordering from the equation entirely. */
  | { channel: typeof BRIDGE_CHANNEL; type: 'ping' }

/** Ctrip's flight-list origin. The extension derives its `content_scripts` match from it and
 *  the recognizer below checks against it, so widening to another OTA is a one-line change. */
export const CTRIP_ORIGIN = 'https://flights.ctrip.com' as const

/** Is this a Ctrip flight-list URL?
 *
 *  One rule, three gates: what the extension will OPEN, what the server will STORE, and what the
 *  app will RENDER as a link. Those were three separate spellings — two `startsWith` checks and
 *  one parsed-hostname check — which already disagreed: an uppercase host passed the extension
 *  and failed the server, so the tab opened, the scrape worked, and the stored row silently lost
 *  its "where did this number come from" link. Parsing is the correct form; `startsWith` on a
 *  raw string is fooled by case and by anything before the first `/`.
 *
 *  Length is capped because the value is echoed back into the UI. */
export function isCtripFlightListUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2048) return false
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.hostname}`.toLowerCase() === CTRIP_ORIGIN
  } catch {
    return false
  }
}

/** Namespace tag on every bridge message. Both sides check it (plus the window origin) before
 *  looking at anything else, so unrelated postMessage traffic on the same window is ignored. */
export const BRIDGE_CHANNEL = 'travelkit-ctrip-bridge' as const

