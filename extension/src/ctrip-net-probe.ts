/**
 * Reads the JSON Ctrip's own page already received. Runs in the PAGE world at `document_start`,
 * early enough to wrap `fetch`/`XHR` before the search fires.
 *
 * Why this and not the DOM: the rendered list is a projection of that JSON, and a PARTIAL one —
 * measured at 4 rows off a search response carrying 197 flights. The JSON does not depend on
 * what got painted, and it carries what the list page never renders: per-flight adult fare, tax,
 * totals. That is the whole comparison, same-flight and same-basis, in one place.
 *
 * It only OBSERVES. Nothing here issues a request, computes a signature, or replays anything —
 * the page's own code makes every network move, so the traffic Ctrip sees is exactly what this
 * operator's ordinary browsing produces.
 *
 * Two jobs, one wrap:
 *  - report the SHAPE of every search response (bench display; schema archaeology);
 *  - buffer the parsed payloads and answer `find` requests from the content script — "which node
 *    is flight X" — so the multi-megabyte body never leaves this tab, only the one node does.
 */

import {
  API_PROBE_CHANNEL as CHANNEL,
  FLIGHT_NO_PATTERN,
  extractCtripQuote,
  isItineraryNode,
  matchQuoteNode,
  normalizeFlightNo,
  type CtripQuoteResult,
  type ProbeFindRequest,
} from '@travelkit/contract'

/** Ctrip's search endpoints. Deliberately narrow — every other request the page makes is noise. */
const SEARCH_API = /\/(search|flightlist|batchSearch|products|lowestPrice)/i

/** Airline + number, composed from the one shared pattern the DOM extractor also builds from. */
const FLIGHT_NO = new RegExp(`\\b(${FLIGHT_NO_PATTERN})\\b`, 'g')
const FLIGHT_NO_EXACT = new RegExp(`^${FLIGHT_NO_PATTERN}$`)

/** Newest first. Two is not enough on a round trip (outbound payload, then the return payload
 *  after 「选为去程」); four leaves room for the page re-searching on its own. */
const MAX_PAYLOADS = 4
const MAX_RAW_CHARS = 200_000

interface BufferedPayload {
  url: string
  /** One entry per itinerary node, with its flight numbers computed ONCE at buffer time. The
   *  find handler used to re-walk every node on every poll — a depth-8 recursive walk across
   *  ~200 nodes × 4 payloads, repeated every 1.5s for up to 100s, inside Ctrip's own page. The
   *  nodes never change after parse, so neither does this. */
  entries: Array<{ node: unknown; nos: string[] }>
}

const payloads: BufferedPayload[] = []

/* ---------------------------------- walkers ---------------------------------- */

/** The array of real ITINERARY nodes — ones that carry both flightSegments and a priceList.
 *
 *  The earlier "first array that mentions a flight number" was too loose: a round-trip step-2
 *  response also contains flight-number-only summary/filter arrays, and grabbing one of those
 *  matched the return flight (CA9675) but surfaced no price. Requiring `isItineraryNode` picks the
 *  array that actually has fares. Falls back to the loose test only if nothing qualifies, so an
 *  unknown schema still yields something to look at on the bench. */
function findItineraryList(root: unknown, depth = 0): unknown[] | null {
  if (depth > 6 || root === null || typeof root !== 'object') return null
  if (Array.isArray(root)) {
    if (root.some(isItineraryNode)) return root.filter(isItineraryNode)
    for (const item of root) {
      const found = findItineraryList(item, depth + 1)
      if (found) return found
    }
    return null
  }
  for (const value of Object.values(root as Record<string, unknown>)) {
    const found = findItineraryList(value, depth + 1)
    if (found) return found
  }
  return null
}

/** Flight numbers in one node, normalized. Key-named fields first; a stringify scan as the
 *  fallback so an unknown spelling still yields candidates (itineraryId embeds the number too). */
function flightNosOf(node: unknown): string[] {
  const found = new Set<string>()
  const walk = (value: unknown, depth: number) => {
    if (depth > 8 || value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        /flight(no|number)/i.test(key) && typeof child === 'string'
        && FLIGHT_NO_EXACT.test(child.trim())
      ) found.add(normalizeFlightNo(child))
      else if (child && typeof child === 'object') walk(child, depth + 1)
    }
  }
  walk(node, 0)
  if (!found.size) {
    for (const match of JSON.stringify(node).slice(0, 60_000).matchAll(new RegExp(FLIGHT_NO.source, 'g'))) {
      found.add(normalizeFlightNo(match[1]!))
    }
  }
  return [...found]
}

/** Money-looking leaves as dotted path → value: the candidates for "the fare" and "the tax". */
function moneyOf(node: unknown): Array<{ path: string; value: number }> {
  const out: Array<{ path: string; value: number }> = []
  const walk = (value: unknown, path: string, depth: number) => {
    if (out.length >= 60 || depth > 8 || value === null) return
    if (Array.isArray(value)) {
      value.slice(0, 4).forEach((child, index) => walk(child, `${path}[${index}]`, depth + 1))
      return
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (typeof child === 'number' && /price|tax|total|amount|fee/i.test(key)) {
          out.push({ path: path ? `${path}.${key}` : key, value: child })
        } else walk(child, path ? `${path}.${key}` : key, depth + 1)
      }
    }
  }
  walk(node, '', 0)
  return out
}

/** Date- and time-looking string leaves, for verifying the match is the right departure. */
function datesTimesOf(node: unknown): { dates: string[]; times: string[] } {
  const dates = new Set<string>()
  const times = new Set<string>()
  const walk = (value: unknown, depth: number) => {
    if (depth > 8 || value === null || (dates.size > 11 && times.size > 11)) return
    if (Array.isArray(value)) { value.slice(0, 4).forEach((child) => walk(child, depth + 1)); return }
    if (typeof value === 'object') { Object.values(value as Record<string, unknown>).forEach((child) => walk(child, depth + 1)); return }
    if (typeof value !== 'string') return
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) dates.add(value.slice(0, 16))
    else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(value)) times.add(value)
  }
  walk(node, 0)
  return { dates: [...dates].slice(0, 12), times: [...times].slice(0, 12) }
}

/** `path: type = sample` per line, depth-limited — the schema of one itinerary, for the bench. */
function describeShape(node: unknown, prefix = '', depth = 0, out: string[] = []): string | null {
  if (out.length > 140 || depth > 5 || node === null || node === undefined) return out.join('\n') || null
  if (Array.isArray(node)) {
    if (node.length) describeShape(node[0], `${prefix}[0]`, depth + 1, out)
    else out.push(`${prefix}: []`)
    return out.join('\n') || null
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      describeShape(value, prefix ? `${prefix}.${key}` : key, depth + 1, out)
      if (out.length > 140) break
    }
    return out.join('\n') || null
  }
  out.push(`${prefix}: ${typeof node} = ${String(node).slice(0, 40)}`)
  return out.join('\n') || null
}

/* ------------------------------ response handling ----------------------------- */

function summarize(url: string, body: string): void {
  if (!body || body.length < 64) return

  let parsed: unknown = null
  try {
    parsed = JSON.parse(body)
  } catch {
    /* not JSON — still worth reporting the size and the flight numbers seen */
  }

  // Buffer anything that carries an itinerary list; `find` answers come out of this. Flight
  // numbers are computed per node HERE, once — every later find poll only scans these arrays.
  const list = parsed ? findItineraryList(parsed) : null
  if (list) {
    payloads.unshift({ url, entries: list.map((node) => ({ node, nos: flightNosOf(node) })) })
    payloads.length = Math.min(payloads.length, MAX_PAYLOADS)
  }

  // Investigative sample. The numbers come from the buffered nodes when we have them (already
  // computed); the full-body regex scan is only the fallback for an unrecognized schema. The
  // priceKeys scan is capped — fare keys repeat identically per node, the head of the body names
  // them all — because bodies run to megabytes and this runs on the operator's ordinary browsing.
  const buffered = list ? payloads[0]!.entries : null
  const flightNos = buffered
    ? [...new Set(buffered.flatMap((entry) => entry.nos))]
    : [...new Set(body.match(FLIGHT_NO) ?? [])]
  const priceKeys = [...new Set(
    (body.slice(0, 100_000).match(/"([a-zA-Z]*(?:price|Price|fare|Fare|tax|Tax|amount|Amount|total|Total)[a-zA-Z]*)"\s*:/g) ?? [])
      .map((match) => match.replace(/[":\s]/g, '')),
  )].slice(0, 30)

  const sample = {
    url: url.slice(0, 200),
    size: body.length,
    topKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed as object).slice(0, 20) : [],
    flightNoCount: flightNos.length,
    flightNos: flightNos.slice(0, 40),
    priceKeys,
    sampleNode: list ? describeShape(list[0]) : null,
  }
  window.postMessage({ channel: CHANNEL, sample }, '*')
  // Also to the console: when the DOM read fails there is no capture to attach this to, and that
  // is precisely the case worth looking at — an empty list next to a full payload.
  console.log('[travelkit probe]', sample.url, `${sample.flightNoCount} flights`, sample)
}

/* ----------------------------------- find ------------------------------------ */

/** Which node is flight X. Answered from the newest payload backwards, request/response with no
 *  pending state — the content script polls, so a payload that arrives later (the return leg
 *  after 「选为去程」) is picked up on its next ask. The request shape is `ProbeFindRequest`
 *  (contract), so the two ends of this channel cannot drift apart silently. */
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return
  const data = event.data as Partial<ProbeFindRequest> | null
  if (!data || data.channel !== CHANNEL || data.type !== 'find' || !data.nonce) return

  const target = {
    flightNo: typeof data.flightNo === 'string' ? data.flightNo : '',
    opFlightNo: typeof data.opFlightNo === 'string' ? data.opFlightNo : null,
    outbound: data.outbound && typeof data.outbound === 'object' ? data.outbound : null,
  }

  let result: CtripQuoteResult | null = null
  for (const payload of payloads) {
    for (const { node, nos } of payload.entries) {
      const hit = matchQuoteNode(nos, target)
      if (!hit) continue
      result = {
        flightNo: hit.no,
        matchedBy: hit.by,
        flightNos: nos,
        payloadUrl: payload.url.slice(0, 200),
        payloadFlightCount: payload.entries.length,
        // The structured reading. Present when the matched node is a real itinerary; a summary
        // node would extract to empty fares, which is itself the signal we grabbed the wrong array.
        extract: extractCtripQuote(node),
        // Archaeology only on request: the raw node alone runs to 200KB and would cross four
        // message hops nobody reads it at on a production quote.
        ...(data.debug === true
          ? (() => {
              const raw = JSON.stringify(node)
              const { dates, times } = datesTimesOf(node)
              return {
                prices: moneyOf(node),
                dates,
                times,
                raw: raw.slice(0, MAX_RAW_CHARS),
                rawTruncated: raw.length > MAX_RAW_CHARS,
              }
            })()
          : {}),
      }
      break
    }
    if (result) break
  }

  window.postMessage({
    channel: CHANNEL,
    type: 'found',
    nonce: data.nonce,
    result,
    payloadsSeen: payloads.length,
    flightsSeen: payloads.reduce((sum, payload) => sum + payload.entries.length, 0),
  }, '*')
})

/* ---------------------------------- wrapping ---------------------------------- */

const originalFetch = window.fetch
window.fetch = async function (...args: Parameters<typeof fetch>) {
  // `window`, never `this`. This file is bundled as an ES module, so at the call site `this` is
  // `undefined` and `fetch.apply(undefined, …)` throws `Illegal invocation` — which does not fail
  // the probe, it fails EVERY request the page makes. Measured: the list went from 4 rows to 0.
  // A wrapper around a host function is only safe if it is invisible when it does nothing.
  const response = await originalFetch.apply(window, args)
  const url = String(args[0] instanceof Request ? args[0].url : args[0] ?? '')
  if (SEARCH_API.test(url)) {
    response
      .clone()
      .text()
      .then((body) => summarize(url, body))
      .catch(() => {})
  }
  return response
}

const originalOpen = XMLHttpRequest.prototype.open
const originalSend = XMLHttpRequest.prototype.send
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __tkUrl?: string }, ...args: unknown[]) {
  this.__tkUrl = String(args[1] ?? '')
  return originalOpen.apply(this, args as Parameters<typeof originalOpen>)
}
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __tkUrl?: string }, ...args: unknown[]) {
  if (SEARCH_API.test(this.__tkUrl ?? '')) {
    this.addEventListener('load', () => {
      // Guarded: reading `responseText` THROWS (InvalidStateError) when `responseType` is
      // anything but '' or 'text'. Same rule as the fetch wrapper — the page must not be able to
      // tell this is here.
      try {
        const body = typeof this.responseText === 'string' ? this.responseText : ''
        summarize(this.__tkUrl ?? '', body)
      } catch { /* not a text response — nothing to summarize */ }
    })
  }
  return originalSend.apply(this, args as Parameters<typeof originalSend>)
}
