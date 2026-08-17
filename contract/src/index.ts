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

// Used in `CtripFlightQuote` below; also re-exported at the foot of this file for consumers.
import type { CtripQuoteExtract } from './ctrip-quote.ts'

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
  /** What Ctrip's own search endpoints returned to the page, summarized. Investigative only —
   *  it tells us whether the JSON holds the full result set (the DOM demonstrably does not) and
   *  which fields carry the fare and its tax basis. Not read by any product code yet. */
  apiSamples?: CtripApiSample[]
}

/** The SHAPE of one search response, never the response. Bodies run to megabytes and there is no
 *  point moving one across the bridge before we know which fields matter. */
export interface CtripApiSample {
  url: string
  size: number
  topKeys: string[]
  /** Distinct flight numbers in the payload. Compare against `CtripCapture.count`: a gap is the
   *  measure of how much the rendered list is dropping. */
  flightNoCount: number
  flightNos: string[]
  /** Field names that look like money or a tax basis — the answer to "is this the pre-tax list
   *  fare or a total?", which decides whether the comparison is even like-for-like. */
  priceKeys: string[]
  sampleNode: string | null
}

/** Page-world probe → content script. Not part of the SPA bridge; it never leaves the tab. */
export const API_PROBE_CHANNEL = 'travelkit-ctrip-api-probe' as const

/** Ctrip quotes CNY on the mainland site; the field exists so the app never has to assume. */
export const CTRIP_CURRENCY = 'CNY'

/** How a plan's comparison figure got here. The UI writes only 'ctrip-extension' now that manual
 *  entry is gone; 'manual' remains for rows stored before that and for the API's own callers. */
export type ReferencePriceSource = 'manual' | 'ctrip-extension'

/** Upper bound on a comparison figure, applied at the server write gate. A wrong number here is
 *  worse than none — the operator quotes against it — so an absurd parse dies at save time. */
export const MAX_REFERENCE_AMOUNT = 10_000_000

/** The one place "is this a usable comparison figure" is decided. */
export const isUsableReferenceAmount = (amount: unknown): amount is number =>
  typeof amount === 'number' && Number.isFinite(amount) && amount > 0 && amount <= MAX_REFERENCE_AMOUNT

/** Messages the extension puts on the page bridge, addressed to the TravelKit SPA.
 *
 *  The bridge deliberately carries NO credential in either direction. The extension scrapes and
 *  hands over public prices; the SPA writes them with the embed session it already holds. That
 *  is why there is no token in any of these shapes — there is nothing here worth stealing. */
/** The flight a quote request is FOR. This crossing the bridge is the design change that makes
 *  the comparison same-flight by construction: the SPA already knows which plan is being
 *  compared, so the extension filters Ctrip's own search JSON down to this one flight instead of
 *  handing back a page for the app to guess at. */
export interface CtripQuoteTarget {
  /** As the plan states it — zero-padded forms (CA0841) are normalized before comparing. */
  flightNo: string
  /** Operating carrier's number for codeshares; tried when `flightNo` finds nothing. */
  opFlightNo?: string | null
  /** YYYY-MM-DD. */
  departureDate: string
  /** HH:MM, used to verify the match, never to make one. */
  departureTime: string
  /** Round-trip pages only, and load-bearing twice over. It is the outbound whose 「选为去程」
   *  the extension clicks so that the return payload (exact combination totals for THAT
   *  outbound) comes into existence — one click on one button, never any typing; if the
   *  synthetic click is ignored the tab is revealed and a person does it. And it is the second
   *  PIN on the match itself: a combination node only counts when it contains this flight too,
   *  because the step-1 list already pairs every outbound with its cheapest return, so the
   *  return number alone can match a pairing we did not choose (see `matchQuoteNode`). */
  outbound?: { flightNo: string; opFlightNo?: string | null; departureTime?: string } | null
  /** Bench only: also compute and carry the archaeology fields below (`prices`/`dates`/`times`/
   *  `raw`). Production quotes leave this unset and travel light — the raw node alone runs to
   *  200KB and crosses four hops nobody reads it at. */
  debug?: boolean
}

/** Validate an untrusted `CtripQuoteTarget` at a trust boundary (the extension's service worker,
 *  which receives it from a content script). Strings only, bounded — the target steers which
 *  flight gets READ, so a malformed one costs a failed lookup, not a wrong action. Lives here,
 *  beside the type, because a hand-rolled copy in the extension had already drifted: it dropped
 *  `outbound.opFlightNo`, silently disabling the codeshare pin the matcher and its tests support. */
export function asQuoteTarget(raw: unknown): CtripQuoteTarget | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.flightNo !== 'string' || !candidate.flightNo || candidate.flightNo.length > 10) return undefined
  const no = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= 10 ? value : null
  const outbound = candidate.outbound as Record<string, unknown> | null | undefined
  const outboundNo = outbound && typeof outbound === 'object' ? no(outbound.flightNo) : null
  return {
    flightNo: candidate.flightNo,
    opFlightNo: no(candidate.opFlightNo),
    departureDate: typeof candidate.departureDate === 'string' ? candidate.departureDate.slice(0, 10) : '',
    departureTime: typeof candidate.departureTime === 'string' ? candidate.departureTime.slice(0, 5) : '',
    ...(outboundNo
      ? {
          outbound: {
            flightNo: outboundNo,
            opFlightNo: no((outbound as Record<string, unknown>).opFlightNo),
            ...(typeof (outbound as Record<string, unknown>).departureTime === 'string'
              ? { departureTime: ((outbound as Record<string, unknown>).departureTime as string).slice(0, 5) }
              : {}),
          },
        }
      : {}),
    ...(candidate.debug === true ? { debug: true } : {}),
  }
}

/** One flight's quote, read from the search response Ctrip sent its own page.
 *
 *  Production reads `extract` (the typed per-cabin fares) plus the identity fields. The optional
 *  archaeology fields — every money-looking leaf, every date/time-looking leaf, the raw node —
 *  exist for the bench, are computed only when the target carries `debug`, and let an unexpected
 *  schema be read off a live response. */
export interface CtripFlightQuote {
  url: string
  capturedAt: string
  /** Which requested number matched, post-normalization. */
  flightNo: string
  matchedBy: 'flightNo' | 'opFlightNo'
  /** Every flight number in the matched node — more than one means codeshare or a bundled leg,
   *  and the bench needs to show that rather than have it silently absorbed. */
  flightNos: string[]
  /** Which response the node came from, and how many flights that response carried. */
  payloadUrl: string
  payloadFlightCount: number
  /** The structured reading — per-passenger pre-tax fares and the economy comparison figure.
   *  Present whenever the matched node was a real itinerary; absent if only a summary node matched. */
  extract?: CtripQuoteExtract
  /** Archaeology, `debug` targets only: money-looking leaves as dotted path → value. */
  prices?: Array<{ path: string; value: number }>
  /** Archaeology, `debug` targets only: date/time-looking leaves. */
  dates?: string[]
  times?: string[]
  /** Archaeology, `debug` targets only: the matched node JSON-stringified, capped. */
  raw?: string
  rawTruncated?: boolean
}

/** The probe's in-tab find protocol (content script ↔ page-world probe, over `API_PROBE_CHANNEL`;
 *  never crosses the SPA bridge). Typed here so the two ends cannot drift apart silently. */
export interface ProbeFindRequest {
  channel: typeof API_PROBE_CHANNEL
  type: 'find'
  nonce: string
  flightNo: string
  opFlightNo?: string | null
  outbound?: { flightNo?: string; opFlightNo?: string | null } | null
  debug?: boolean
}

/** What the probe answers with: the quote minus the envelope the content script adds. */
export type CtripQuoteResult = Omit<CtripFlightQuote, 'url' | 'capturedAt'>

export interface ProbeFindAnswer {
  channel: typeof API_PROBE_CHANNEL
  type: 'found'
  nonce: string
  result: CtripQuoteResult | null
  payloadsSeen: number
  flightsSeen: number
}

export type BridgeMessage =
  /** Extension announcing itself so the SPA can stop offering the install hint. */
  | { channel: typeof BRIDGE_CHANNEL; type: 'extension-ready'; version: string }
  /** A completed scrape, tagged with the page it came from so the SPA can match it to a plan. */
  | { channel: typeof BRIDGE_CHANNEL; type: 'capture'; nonce: string; capture: CtripCapture }
  /** One flight's quote, filtered out of Ctrip's own JSON inside the extension. */
  | { channel: typeof BRIDGE_CHANNEL; type: 'quote'; nonce: string; quote: CtripFlightQuote }
  /** A scrape that could not produce a usable figure. `reason` is for the operator, not a metric.
   *  Shared by capture and quote requests — the caller knows which one it asked for. */
  | { channel: typeof BRIDGE_CHANNEL; type: 'capture-failed'; nonce: string; url: string; reason: string }

/** Messages the SPA puts on the bridge, addressed to the extension. */
export type PageMessage =
  /** Asking the extension to open a Ctrip page and read it. `nonce` correlates the reply.
   *  With `target` set, the extension answers with a `quote` for that one flight instead of a
   *  DOM capture — same window plumbing, different reader. */
  | { channel: typeof BRIDGE_CHANNEL; type: 'capture-request'; nonce: string; url: string; target?: CtripQuoteTarget }
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

/** Which flight is OURS, out of what Ctrip returned. `matchQuoteNode` is the production rule
 *  (pins a payload node by flight numbers, both legs on a round trip); `matchCtripFlight` is the
 *  DOM-capture counterpart, used by the /ctrip-probe bench to validate page reads against it. */
export {
  matchCtripFlight,
  matchQuoteNode,
  normalizeFlightNo,
  FLIGHT_NO_PATTERN,
  isRoundTripCapture,
  type CtripMatch,
  type CtripMatchFailure,
  type PlanJourneyRef,
  type PlanSegmentRef,
  type QuoteNodeTarget,
} from './ctrip-match.ts'

/** The production reader for a single itinerary node pulled from Ctrip's own search JSON:
 *  per-passenger pre-tax fares by cabin, with the restricted/business traps filtered out. */
export { extractCtripQuote, isItineraryNode, type CtripFare } from './ctrip-quote.ts'
export type { CtripQuoteExtract }

