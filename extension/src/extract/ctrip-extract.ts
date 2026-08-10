import type { CtripCapture, CtripCalendarEntry, CtripFlightRow, ExtractStrategy } from '@travelkit/contract'

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
 */

const clean = (value: string | null | undefined): string => (value || '').replace(/\s+/g, ' ').trim()

/** Ctrip writes fares as `¥479起` / `¥1,286`. Keep the number, drop the decoration. */
function money(text: string | null | undefined): number | null {
  const match = /¥\s?([\d,]+)/.exec(text || '')
  if (!match?.[1]) return null
  const amount = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(amount) ? amount : null
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
    flightNo: /\b([A-Z0-9]{2}\d{3,4})\b/.exec(text)?.[1] ?? null,
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
 *  Reported as `fallback-scan` so a redesign is visible in the data rather than silent. */
function fallbackNodes(): Element[] {
  const smallest = new Map<string, HTMLElement>()
  for (const node of document.querySelectorAll<HTMLElement>('div')) {
    const text = node.innerText || ''
    if (text.length > 600 || !/¥\d/.test(text)) continue
    const key = /\b([A-Z0-9]{2}\d{3,4})\b/.exec(text)?.[1]
    if (!key) continue
    const previous = smallest.get(key)
    if (!previous || text.length < (previous.innerText || '').length) smallest.set(key, node)
  }
  return [...smallest.values()]
}

/** The ±1 week low-fare strip above the list — useful for date haggling, free to collect. */
function parseCalendar(): CtripCalendarEntry[] {
  const seen = new Set<string>()
  const entries: CtripCalendarEntry[] = []
  for (const node of document.querySelectorAll<HTMLElement>('*')) {
    if (node.children.length) continue
    const date = clean(node.textContent)
    if (!/^\d{2}-\d{2}周[一二三四五六日]$/.test(date) || seen.has(date)) continue
    const lowest = money(node.parentElement?.innerText)
    if (lowest === null) continue
    seen.add(date)
    entries.push({ date, lowest })
  }
  return entries
}

export function extractCtripPrices(): CtripCapture {
  const bodyText = document.body?.innerText || ''
  let strategy: ExtractStrategy = 'flight-item'
  let nodes = [...document.querySelectorAll('.flight-item')]
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
    blocked: /whaleguard|安全验证|请输入验证码/.test(bodyText),
    count: flights.length,
    lowest: fares.length ? Math.min(...fares) : null,
    calendar: parseCalendar(),
    flights,
  }
}
