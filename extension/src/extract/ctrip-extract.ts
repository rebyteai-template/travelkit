import { FLIGHT_NO_PATTERN, type CtripCapture, type CtripFlightRow, type ExtractStrategy } from '@travelkit/contract'

/**
 * Reads the fare list off a rendered flights.ctrip.com page.
 *
 * This runs in the operator's own browser, in their own session, on a page they opened. There is
 * nothing to evade here — from a residential IP the page simply renders — so this is a parser,
 * not a scraper-with-tricks. (Verified against four routes; the same request from a datacenter
 * IP is refused outright with `whaleguard block`, which is why this cannot live on a server.)
 *
 * It fails CLOSED. When the anchors are gone it says so via `strategy`/`count` instead of
 * returning a plausible number: the figure feeds a price the operator is about to quote, and a
 * wrong one is worse than none. The UI's answer to an empty capture is "type it in yourself".
 *
 * Split into a cheap probe and a full parse on purpose. The caller polls for up to 25s while the
 * list lazily renders, and the expensive work — reading `innerText` off every div — is exactly
 * what would run on the ticks where nothing has rendered yet. `probe()` answers "is it there"
 * for the price of one `querySelectorAll`; `extractCtripPrices()` runs once, at the end.
 */

const clean = (value: string | null | undefined): string => (value || '').replace(/\s+/g, ' ').trim()

/** Ctrip's own semantic container for one fare row. Owned here — the card locator in
 *  ctrip-content.ts uses this too, so a Ctrip class rename is one edit, seen by both. */
export const FLIGHT_CARD_SELECTOR = '.flight-item'

/** One flight-number token, composed from the shared pattern. */
const FLIGHT_NO_TOKEN = new RegExp(`\\b(${FLIGHT_NO_PATTERN})\\b`)

/** Ctrip writes fares as `¥479起` / `¥1,286`. Keep the number, drop the decoration. */
function money(text: string | null | undefined): number | null {
  const match = /¥\s?([\d,]+)/.exec(text || '')
  if (!match?.[1]) return null
  const amount = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(amount) ? amount : null
}

/** `textContent`, not `innerText`: the latter is layout-dependent and forces a synchronous
 *  reflow of the whole page, which is not something to do on a 500ms poll. */
const isBlocked = (): boolean => /whaleguard|安全验证|请输入验证码/.test(document.body?.textContent || '')

/** How many fare rows are on the page right now, and whether we are reading Ctrip's own
 *  container or guessing. Cheap enough to call twice a second. */
export function probe(): { count: number; strategy: ExtractStrategy; blocked: boolean } {
  const items = document.querySelectorAll(FLIGHT_CARD_SELECTOR).length
  if (items > 0) return { count: items, strategy: 'flight-item', blocked: false }
  return { count: 0, strategy: 'fallback-scan', blocked: isBlocked() }
}

function parseCard(node: Element): CtripFlightRow {
  const text = (node as HTMLElement).innerText || ''
  const lines = text.split('\n').map(clean).filter(Boolean)
  const prices = (text.match(/¥\s?[\d,]+/g) || []).map(money).filter((n): n is number => n !== null)
  // Discount badges ("已减¥15") are also ¥ figures on the card. Exclude them, then take the
  // largest of what is left — the fare, not a saving.
  const discounts = (text.match(/已减¥\s?[\d,]+/g) || []).map(money).filter((n): n is number => n !== null)
  const fares = prices.filter((price) => !discounts.includes(price))
  const airports = lines.filter((line) => /机场|国际$/.test(line) && line.length < 20)
  const times = text.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g) || []
  const firstLine = lines[0]

  return {
    flightNo: FLIGHT_NO_TOKEN.exec(text)?.[1] ?? null,
    airline: firstLine && !/^\d/.test(firstLine) ? firstLine : null,
    aircraft: /(?:波音|空客)[^\s|]*/.exec(text)?.[0] ?? null,
    depTime: times[0] ?? null,
    arrTime: times[1] ?? null,
    depAirport: airports[0] ?? null,
    arrAirport: airports[1] ?? null,
    price: fares.length ? Math.max(...fares) : null,
    cabin: /经济舱[\d.]*折?|公务舱|头等舱/.exec(text)?.[0] ?? null,
    discountOff: discounts.length ? Math.max(...discounts) : null,
    seatsLeft: Number(/剩(\d+)张/.exec(text)?.[1]) || null,
    isTransfer: /中转|经停/.test(text),
  }
}

/** Last resort when `.flight-item` is gone: find the smallest container per flight number.
 *  Reported as `fallback-scan` so a redesign is visible in the data rather than silent.
 *  Deliberately NOT called while polling — it reads `innerText` (whole rendered subtree) off
 *  every div on the page, so it only runs once, after the wait is over. */
function fallbackNodes(): Element[] {
  const smallest = new Map<string, { node: HTMLElement; length: number }>()
  for (const node of document.querySelectorAll<HTMLElement>('div')) {
    // Cheap rejects first — `innerText` is the expensive part, so do not touch it until the
    // node has at least passed a textContent-based sniff.
    const raw = node.textContent || ''
    if (raw.length > 600 || !/¥\d/.test(raw)) continue
    const key = FLIGHT_NO_TOKEN.exec(raw)?.[1]
    if (!key) continue
    const text = node.innerText || ''
    const previous = smallest.get(key)
    if (!previous || text.length < previous.length) smallest.set(key, { node, length: text.length })
  }
  return [...smallest.values()].map((entry) => entry.node)
}

/** The full parse. Run once, when the list has settled or the wait has run out. */
export function extractCtripPrices(): CtripCapture {
  let strategy: ExtractStrategy = 'flight-item'
  let nodes = [...document.querySelectorAll(FLIGHT_CARD_SELECTOR)]
  if (!nodes.length) {
    strategy = 'fallback-scan'
    nodes = fallbackNodes()
  }

  const flights = nodes.map(parseCard).filter((row): row is CtripFlightRow => Boolean(row.flightNo && row.price))
  const fares = flights.map((row) => row.price).filter((price): price is number => price !== null)

  return {
    url: location.href,
    capturedAt: new Date().toISOString(),
    strategy,
    blocked: isBlocked(),
    count: flights.length,
    lowest: fares.length ? Math.min(...fares) : null,
    flights,
  }
}
