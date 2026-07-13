/**
 * Turns raw stream-json frames into the booking-domain state the chat stream renders.
 *
 * The UI is a mirror of the agent's TravelKit tool_results (DESIGN §4.1): we
 * walk the frames, recognise which travelkit tool produced each tool_result, and
 * derive a per-stage view model. The most recent successful domain tool decides
 * the active stage (a fresh search after a verify drops back to results).
 *
 * We read the FULL `assistant` / `user` / `result` frames and ignore the partial
 * `stream_event` deltas — simpler and good enough. API-returned business fields
 * may surface in this internal workbench; credentials and request secrets must not.
 */
import type { Attachment, PromptContent } from './api.ts'

// ── search (simplifly-flyai-skill compact JSON) ────────────────────────────────
// The skill runs python scripts in the sandbox; the structured result we can parse
// is the COMPACT JSON (flight_search_compact.py stdout), replayed into our frames from
// the sub-session. `displayOptions` = the skill's curated recommendations, each fully
// structured, including solutionId for exact verify. `displayMapping` stays unused.
// Cards mirror whatever the skill recommended — the real
// filtering/refinement ("拉扯") happens conversationally in chat.
export interface CompactSegment {
  flightNo: string
  opFlightNo?: string
  departure: string        // IATA code
  departureName?: string   // e.g. "北京大兴"
  departureTerminal?: string
  departureDate: string
  departureTime: string
  arrival: string
  arrivalName?: string
  arrivalTerminal?: string
  arrivalDate: string
  arrivalTime: string
  flightTime?: string
  cabin: string            // already display form, e.g. "经济舱 T舱"
  checkedBaggage?: string  // e.g. "1件，20kg/件"
}
export interface CompactJourney {
  origin: string
  destination: string
  departureDate: string
  departureTime: string
  arrivalDate: string
  arrivalTime: string
  arrivalCrossDays?: number
  duration: string
  transferCount: number
  layovers?: string[]
  blockIndex?: number      // bookable-unit index: which separately-booked ticket this journey belongs to
  segments: CompactSegment[]
}
export interface CompactPrice {
  amount: number
  currency: string
  perType?: Record<string, { num?: number; unitTotal?: number; subtotal?: number }>
}
export interface CompactOption {
  optionNumber: number     // skill-visible option number; UI may displayNumber after merging
  solutionId?: string      // search result handle used for exact verify; orderKey remains agent-side
  displayNumber?: number   // UI-only number when multiple compact searches are merged into one table
  selectionLabel?: string  // disambiguation for verify prompts, e.g. "第2次搜索/报价结果的原始方案1"
  searchGroupIndex?: number // 1-based order when multiple compact searches are merged into one table
  section?: string
  tag?: string | null
  journeyType: string      // "单程直飞" | "单程中转N次" | "多程"
  duration: string         // "2h10m"
  durationMinutes: number
  cabin: string
  baggage?: string
  hasCheckedBaggage: boolean
  price: CompactPrice
  /** Combos only: each separately-booked ticket's own price + supply channel,
   *  indexed by journeys[].blockIndex. option.price is their sum. */
  blocks?: Array<{ price: CompactPrice; source?: string }>
  source?: string
  copyText?: string
  journeys: CompactJourney[]
}
export interface SearchResult {
  options: CompactOption[]
  totalCount?: number       // unique candidates matched (skill curated down to options[])
}

// ── verify (simplifly-flyai-skill compact: flight_verify_selected.py) ──────────
// The verify result is COMPACT family too — a Bash result recognised by shape
// (`selectedOption`+`verifiedOption`), NOT an MCP tool by name. `verifiedOption` re-states the
// chosen option re-priced; `comparison` flags any change. orderKey stays
// in the script's private fields and is never read here. FareVerification is the booking fare
// model the write-flow consumes; compact fills what it has and leaves the rest empty (the card
// hides those) rather than faking per-pax splits / structured rules / availability.
export interface FareLeg {
  flightNo: string
  departure: string
  departureDate?: string
  departureTime?: string
  arrival: string
  arrivalDate?: string
  arrivalTime?: string
  cabinClass: string
  cabinCode?: string
  checkedBaggage?: string
  availability?: number
}
export interface FareJourney {
  origin: string
  destination: string
  departureDate?: string
  departureTime?: string
  arrivalDate?: string
  arrivalTime?: string
  duration: string
  transferNum: number
  legs: FareLeg[]
}
export interface FarePassengerLine {
  passengerType: string
  baseFare: number
  tax: number
  salePrice: number
  num: number
}
export interface BaggageInfo {
  passengerType: string
  carryOn?: string
  checked?: string
}
export interface FareRuleInfo {
  passengerType: string
  canVoid: boolean
  refundDescription?: string
  changeDescription?: string
}
export interface FareVerification {
  currency: string
  total: number
  baseFare: number
  tax: number
  publishTotal: number
  journeys: FareJourney[]
  passengers: FarePassengerLine[]
  baggage: BaggageInfo[]
  fareRules: FareRuleInfo[]
  minAvailability: number | null
  /** Compact verify gives the price split as a ready display string ("票价 ¥X + 税费 ¥Y"), not
   *  structured base/tax numbers — carried here so the card and order prompt show it verbatim. */
  priceBreakdownDisplay?: string
  /** Set when the re-priced solution differs from what the user picked (price/baggage/etc changed)
   *  — a Chinese advisory the card surfaces before the user continues to passenger collection. */
  changeNotice?: string
}

// ── chat + combined view ───────────────────────────────────────────────
export interface ChatBubble {
  key: string
  role: 'user' | 'assistant'
  text: string
  /** UTC timestamp this bubble was "sent": the prompt's created_at for the user turn, its
   *  completed_at (falling back to created_at while running) for assistant turns. The UI converts
   *  to the viewer's local timezone — see src/lib/time.ts. Absent on the rebyte run link. */
  ts?: string
  /** When set, the bubble renders as a link to this turn's rebyte run. */
  runUrl?: string
  /** Turn-level failure (DO `__error` frame) — rendered in the error palette. */
  error?: boolean
  /** Inline 方案 cards attached to this assistant turn (chat-stream): the simplifly-flyai-skill
   *  compact search rendered as selectable cards, with the agent's redundant markdown
   *  table stripped from `text`. Each search keeps its own bubble → full history. */
  cards?: CompactOption[]
  totalCount?: number
  /** Inline verify (fare) card attached to the verify turn — same chat-stream treatment as
   *  `cards`. The latest verify's fare is the SAME object as `DerivedView.fare`, so the panel
   *  shows the "继续预订" CTA only on that one (`b.fare === view.fare`). */
  fare?: FareVerification
  /** Images/files the user attached to this turn — rendered above the user bubble (thumbnails /
   *  file chips). Set only on user bubbles, only when non-empty. */
  attachments?: Attachment[]
}

export type Stage = 'idle' | 'search' | 'verify' | 'order' | 'payment'

export interface DerivedView {
  chat: ChatBubble[]
  stage: Stage
  search: SearchResult | null
  fare: FareVerification | null
  /** Last domain-tool failure surfaced to the user (e.g. price expired). */
  notice: string | null
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => isObj(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function parseCompactPricePerType(raw: unknown): CompactPrice['perType'] | undefined {
  if (!isObj(raw)) return undefined
  const perType: NonNullable<CompactPrice['perType']> = {}
  for (const [passengerType, value] of Object.entries(raw)) {
    if (!isObj(value)) continue
    const line: NonNullable<CompactPrice['perType']>[string] = {}
    if (typeof value.num === 'number' && Number.isFinite(value.num)) line.num = num(value.num)
    if (typeof value.unitTotal === 'number' && Number.isFinite(value.unitTotal)) line.unitTotal = num(value.unitTotal)
    if (typeof value.subtotal === 'number' && Number.isFinite(value.subtotal)) line.subtotal = num(value.subtotal)
    perType[passengerType] = line
  }
  return Object.keys(perType).length ? perType : undefined
}

function parseCompactPrice(raw: unknown): CompactPrice {
  const price = isObj(raw) ? raw : {}
  return {
    amount: num(price.amount),
    currency: str(price.currency),
    perType: parseCompactPricePerType(price.perType),
  }
}

export function derive(prompts: PromptContent[]): DerivedView {
  const chat: ChatBubble[] = []
  let search: SearchResult | null = null
  let fare: FareVerification | null = null
  let notice: string | null = null
  let stage: Stage = 'idle'
  // Signature of the last rendered card set, so a re-surfaced identical compact (the verify
  // turn re-reads the search compact file) doesn't render the same 方案 cards twice.
  let lastCardsSig = ''

  for (const p of prompts) {
    // The user turn is stamped with when it was sent; every assistant bubble in this turn is
    // stamped with the turn's completion (created_at while it's still streaming).
    const userTs = p.created_at
    const replyTs = p.completed_at ?? p.created_at
    // Attach the key only when there are attachments, so an optimistic turn (undefined) and a
    // reloaded one (server may send []) derive the identical user bubble (I0).
    chat.push({ key: `u-${p.id}`, role: 'user', text: p.prompt, ts: userTs, ...(p.attachments?.length ? { attachments: p.attachments } : {}) })
    // Hold this prompt's latest search / verify; attach to the next assistant text (stripping its
    // redundant markdown table), else flush as a standalone card bubble at prompt end.
    let pendingSearches: SearchResult[] = []
    let pendingFare: FareVerification | null = null
    let successfulVerifyCount = 0

    for (const f of p.frames) {
      const data = f.data
      if (!isObj(data)) continue

      // rebyte run link for this turn (emitted by the DO when the relay task starts)
      if (typeof data.__rebyte_run === 'string') {
        chat.push({ key: `r-${p.id}-${f.seq}`, role: 'assistant', text: '', runUrl: `https://app.rebyte.ai/run/${data.__rebyte_run}` })
        continue
      }

      // turn failure (timeout / relay error) — without this bubble a failed turn is
      // indistinguishable from a blank chat once the loading indicator clears
      if (typeof data.__error === 'string' && data.__error.trim()) {
        chat.push({ key: `e-${p.id}-${f.seq}`, role: 'assistant', text: data.__error, error: true, ts: replyTs })
        continue
      }

      // assistant turn: collect text bubbles
      if (data.type === 'assistant' && isObj(data.message)) {
        const content = (data.message as Record<string, unknown>).content
        // Only a frame with real text consumes pendingSearch — a tool_use-only frame (e.g. the
        // sub-agent's `Write`) has empty text and must NOT swallow the cards before the summary.
        const text = textFromContent(content)
        if (text.trim()) {
          const key = `a-${p.id}-${(data.message as Record<string, unknown>).id ?? f.seq}-${f.seq}`
          const bubble: ChatBubble = { key, role: 'assistant', text, ts: replyTs }
          chat.push(bubble)
        }
      }

      // user turn carrying a tool_result. Both card-driving shapes are simplifly-flyai-skill COMPACT
      // family (Bash results — the skill talks direct HTTP, never MCP), so we route by SHAPE, not
      // tool name: search by `displayOptions`+`displayMapping`, verify by `selectedOption`+`verifiedOption`.
      if (data.type === 'user' && isObj(data.message)) {
        const content = (data.message as Record<string, unknown>).content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (!isObj(block) || block.type !== 'tool_result') continue
          const raw = textFromContent(block.content)

          // compact search — cheap signature gate before parsing the (large) JSON
          if (raw.includes('"displayOptions"') && raw.includes('"displayMapping"')) {
            const payload = parseToolJson(raw)
            const parsed = payload && parseCompactSearch(payload)
            if (parsed) {
              search = parsed; fare = null; notice = null; stage = 'search'
              // Signature covers every option's full itinerary (all legs, all segments, dates), not
              // just the first flight — otherwise two different multi-leg searches that share a first
              // leg (e.g. both start MU0583) collide and the second table is silently dropped.
              const sig = parsed.options
                .map((o) => `${o.optionNumber}:${o.price.amount}:${o.journeys.map((j) => j.segments.map((s) => `${s.flightNo}@${s.departureDate}`).join('+')).join('>')}`)
                .join('|')
              if (sig !== lastCardsSig) {
                pendingSearches.push(parsed)
                lastCardsSig = sig
              }
              continue
            }
          }

          // compact verify (fare card) — shape gate; on expiry/failure surface a notice and keep
          // the prior stage so the user re-picks from the agent's refreshed (inline) search.
          if (raw.includes('"verifiedOption"') && raw.includes('"selectedOption"')) {
            const payload = parseToolJson(raw)
            if (!payload) continue
            if (payload.ok !== true) {
              notice = verifyErrorNotice(payload)
            } else {
              const parsed = parseCompactVerify(payload)
              if (parsed) {
                successfulVerifyCount += 1
                fare = parsed; pendingFare = parsed; notice = null; stage = 'verify'
              }
            }
            continue
          }
          // order / payment stages parsed in a later milestone
        }
      }
    }

    // Domain cards render at the turn tail so a retry/ack text frame cannot consume them before the
    // real final answer arrives. Keep each compact search as its own table; merging multi-leg or
    // multi-request searches into one giant table makes unrelated trip segments indistinguishable.
    if (pendingSearches.length) {
      pendingSearches.forEach((searchResult, index) => {
        chat.push({
          key: `cards-${p.id}-${index}`,
          role: 'assistant',
          text: '',
          cards: searchResult.options,
          totalCount: searchResult.totalCount,
          ts: replyTs,
        })
      })
    }
    // A turn that verifies several options is an agent comparison, not a single actionable fare.
    // Rendering the last successful verify as "the" fare card surfaces arbitrary alternatives
    // (for example WN3888) after the agent already summarized the real choice in text.
    if (pendingFare && successfulVerifyCount === 1) {
      chat.push({ key: `fare-${p.id}`, role: 'assistant', text: '', fare: pendingFare, ts: replyTs })
    }
  }

  // de-dupe consecutive identical assistant bubbles; never drop a card- or attachment-bearing bubble
  const deduped: ChatBubble[] = []
  for (const b of chat) {
    const prev = deduped[deduped.length - 1]
    if (!b.cards && !b.fare && !b.attachments && prev && prev.role === b.role && prev.text === b.text && prev.runUrl === b.runUrl && !prev.cards && !prev.fare && !prev.attachments) continue
    deduped.push(b)
  }
  return { chat: deduped, stage, search, fare, notice }
}

function parseToolJson(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null
  try {
    const json = JSON.parse(raw)
    return isObj(json) ? json : null
  } catch {
    const extracted = firstJsonObject(raw)
    if (!extracted) return null
    try {
      const json = JSON.parse(extracted)
      return isObj(json) ? json : null
    } catch {
      return null
    }
  }
}

/** Bash tool_result sometimes appends shell bookkeeping after stdout. The skill's first stdout
 *  object is still the authoritative compact payload; ignore anything after its closing brace. */
function firstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  return null
}

/** simplifly-flyai-skill compact search JSON → search view model. Tool-name agnostic: this is
 *  a Bash result (python script stdout), recognised by its `displayOptions`/`displayMapping`
 *  shape. We read only the public `displayOptions`; `displayMapping` stays unused. */
function parseCompactSearch(json: Record<string, unknown>): SearchResult | null {
  if (!Array.isArray(json.displayOptions) || !isObj(json.displayMapping)) return null
  const options: CompactOption[] = []
  for (const raw of json.displayOptions) {
    const o = toCompactOption(raw)
    if (o) options.push(o)
  }
  if (!options.length) return null
  const sr = Array.isArray(json.searchedRequests) && isObj(json.searchedRequests[0]) ? json.searchedRequests[0] : null
  const totalCount = sr && typeof sr.uniqueCandidateCount === 'number' ? sr.uniqueCandidateCount : undefined
  return { options, totalCount }
}

function toCompactOption(raw: unknown): CompactOption | null {
  if (!isObj(raw)) return null
  const optionNumber = num(raw.optionNumber)
  if (!optionNumber) return null

  const journeys: CompactJourney[] = []
  for (const j of Array.isArray(raw.journeys) ? raw.journeys : []) {
    if (!isObj(j)) continue
    const segments: CompactSegment[] = []
    for (const s of Array.isArray(j.segments) ? j.segments : []) {
      if (!isObj(s)) continue
      segments.push({
        flightNo: str(s.flightNo),
        opFlightNo: str(s.opFlightNo) || undefined,
        departure: str(s.departure),
        departureName: str(s.departureName) || undefined,
        departureTerminal: str(s.departureTerminal) || undefined,
        departureDate: str(s.departureDate),
        departureTime: str(s.departureTime),
        arrival: str(s.arrival),
        arrivalName: str(s.arrivalName) || undefined,
        arrivalTerminal: str(s.arrivalTerminal) || undefined,
        arrivalDate: str(s.arrivalDate),
        arrivalTime: str(s.arrivalTime),
        flightTime: str(s.flightTime) || undefined,
        cabin: str(s.cabin),
        checkedBaggage: str(s.checkedBaggage) || undefined,
      })
    }
    if (!segments.length) continue
    journeys.push({
      origin: str(j.origin),
      destination: str(j.destination),
      departureDate: str(j.departureDate),
      departureTime: str(j.departureTime),
      arrivalDate: str(j.arrivalDate),
      arrivalTime: str(j.arrivalTime),
      arrivalCrossDays: num(j.arrivalCrossDays) || undefined,
      duration: str(j.duration),
      transferCount: num(j.transferCount),
      layovers: Array.isArray(j.layovers) ? j.layovers.map(str).filter(Boolean) : undefined,
      blockIndex: num(j.blockIndex),
      segments,
    })
  }
  if (!journeys.length) return null

  const price = parseCompactPrice(raw.price)
  // Verbatim from the skill — no recomputed labels, no defaulted currency, no
  // synthesized display strings. Missing data stays missing; the table shows "--".
  const blocks: NonNullable<CompactOption['blocks']> = []
  for (const b of Array.isArray(raw.blocks) ? raw.blocks : []) {
    if (!isObj(b)) continue
    blocks.push({ price: parseCompactPrice(b.price), source: str(b.source) || undefined })
  }
  return {
    optionNumber,
    solutionId: str(raw.solutionId) || undefined,
    section: str(raw.section) || undefined,
    tag: str(raw.tag) || null,
    journeyType: str(raw.journeyType),
    duration: str(raw.duration),
    durationMinutes: num(raw.durationMinutes),
    cabin: str(raw.cabin),
    baggage: str(raw.baggage) || undefined,
    hasCheckedBaggage: raw.hasCheckedBaggage === true,
    price,
    blocks: blocks.length > 1 ? blocks : undefined,
    source: str(raw.source) || undefined,
    copyText: str(raw.copyText) || undefined,
    journeys,
  }
}

/** simplifly-flyai-skill compact verify JSON (flight_verify_selected.py stdout) → fare view model.
 *  Recognised by shape (`selectedOption`+`verifiedOption`), like the compact search. We read the
 *  curated `verifiedOption` summary only; orderKey stays in the script's private fields.
 *  Compact carries no per-passenger price split, structured fare rules, or seat availability — those
 *  stay empty (the card hides them) rather than being faked. */
function parseCompactVerify(json: Record<string, unknown>): FareVerification | null {
  const verified = isObj(json.verifiedOption) ? json.verifiedOption : null
  if (!verified) return null

  const journeys: FareJourney[] = []
  for (const j of Array.isArray(verified.journeys) ? verified.journeys : []) {
    if (!isObj(j)) continue
    const legs: FareLeg[] = []
    for (const s of Array.isArray(j.segments) ? j.segments : []) {
      if (!isObj(s)) continue
      // compact `cabin` is already a display string ("经济舱 T舱"); carry it as cabinClass.
      legs.push({
        flightNo: str(s.flightNo),
        departure: str(s.departure),
        departureDate: str(s.departureDate) || undefined,
        departureTime: str(s.departureTime) || undefined,
        arrival: str(s.arrival),
        arrivalDate: str(s.arrivalDate) || undefined,
        arrivalTime: str(s.arrivalTime) || undefined,
        cabinClass: str(s.cabin),
        checkedBaggage: str(s.checkedBaggage) || undefined,
      })
    }
    if (!legs.length) continue
    journeys.push({
      origin: str(j.origin),
      destination: str(j.destination),
      departureDate: str(j.departureDate) || undefined,
      departureTime: str(j.departureTime) || undefined,
      arrivalDate: str(j.arrivalDate) || undefined,
      arrivalTime: str(j.arrivalTime) || undefined,
      duration: str(j.duration),
      transferNum: num(j.transferCount),
      legs,
    })
  }
  if (!journeys.length) return null

  const price = isObj(verified.price) ? verified.price : {}
  const total = num(price.amount)
  const currency = str(price.currency) || 'CNY'

  // passenger rows from the verify request's counts (compact has no per-type price split) — enough
  // to seed the right number of form rows; salePrice stays 0 so the card hides the per-pax table.
  const passengers: FarePassengerLine[] = []
  const reqCount = isObj(json.request) && isObj(json.request.passengerCount) ? json.request.passengerCount : null
  for (const t of ['adult', 'child', 'infant'] as const) {
    const n = reqCount ? num(reqCount[t]) : 0
    if (n > 0) passengers.push({ passengerType: t, baseFare: 0, tax: 0, salePrice: 0, num: n })
  }
  if (!passengers.length) passengers.push({ passengerType: 'adult', baseFare: 0, tax: 0, salePrice: 0, num: 1 })

  // solution-level baggage string; only surfaced when the fare actually includes checked baggage.
  const baggage: BaggageInfo[] = []
  const bagStr = str(verified.baggage)
  if (verified.hasCheckedBaggage === true && bagStr) baggage.push({ passengerType: 'adult', checked: bagStr })

  return {
    currency,
    total,
    baseFare: 0,
    tax: 0,
    publishTotal: total,
    journeys,
    passengers,
    baggage,
    fareRules: [],
    minAvailability: null,
    priceBreakdownDisplay: str(verified.priceBreakdownDisplay) || undefined,
    changeNotice: buildChangeNotice(json.comparison),
  }
}

/** A successful verify whose re-priced solution differs from the user's pick → a short Chinese
 *  advisory the card shows before continuing. Undefined when nothing material changed. */
function buildChangeNotice(comparison: unknown): string | undefined {
  if (!isObj(comparison) || comparison.changed !== true) return undefined
  const labels: Record<string, string> = { flights: '航班', price: '价格', cabin: '舱位', baggage: '行李额', hasCheckedBaggage: '是否含托运' }
  const fields = (Array.isArray(comparison.changedFields) ? comparison.changedFields : [])
    .map((f) => labels[str(f)])
    .filter((x): x is string => Boolean(x))
  if (!fields.length) return undefined
  return `验价后${fields.join('、')}较所选有变化，请确认后再继续预订。`
}

/** Verify failed (expired search / rejected) → a user-facing notice. The agent re-runs search on
 *  expiry, so we point the user back to the refreshed options rather than the dead solution. */
function verifyErrorNotice(payload: Record<string, unknown>): string {
  if (str(payload.errorType) === 'expired_search') return '该方案价格/库存可能已过期，请从最新搜索结果中重新选择。'
  return str(payload.message) || '实时验价未通过，请稍后重试或重新选择其他方案。'
}
