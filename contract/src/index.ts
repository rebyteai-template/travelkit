/**
 * The wire contract between the Ctrip-price browser extension and the TravelKit app.
 *
 * Types only, and the package it lives in has no dependencies — that is what keeps React and
 * workers-types out of the extension bundle, and `chrome` types out of the Worker. Both sides
 * import it with `import type`, so it contributes zero runtime bytes to either.
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

/** The ±1 week low-fare strip Ctrip renders above the list. Free to collect while we are there. */
export interface CtripCalendarEntry {
  date: string
  lowest: number | null
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
  calendar: CtripCalendarEntry[]
  flights: CtripFlightRow[]
}

/** Ctrip quotes CNY on the mainland site; the field exists so the app never has to assume. */
export const CTRIP_CURRENCY = 'CNY'

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

/** Namespace tag on every bridge message. Both sides check it (plus the window origin) before
 *  looking at anything else, so unrelated postMessage traffic on the same window is ignored. */
export const BRIDGE_CHANNEL = 'travelkit-ctrip-bridge' as const
