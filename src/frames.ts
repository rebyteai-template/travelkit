/**
 * Turns raw stream-json frames into the booking-domain state the bench renders.
 *
 * The bench is a mirror of the agent's TravelKit tool_results (DESIGN §4.1): we
 * walk the frames, recognise which travelkit tool produced each tool_result, and
 * derive a per-stage view model. The most recent successful domain tool decides
 * the active stage (a fresh search after a verify drops back to results).
 *
 * We read the FULL `assistant` / `user` / `result` frames and ignore the partial
 * `stream_event` deltas — simpler and good enough. Internal IDs
 * (solutionId/orderKey/coreSegmentId/airline codes) live only in the agent's
 * tool args and are never surfaced here.
 */
import type { PromptContent } from './api.ts'

// ── search (flight_search) ─────────────────────────────────────────────
export interface FlightLeg {
  departure: string
  departureTime: string
  departureDate?: string
  arrival: string
  arrivalTime: string
  arrivalDate?: string
  arrivalTerminal?: string | null
  departureTerminal?: string | null
}
export interface FlightOption {
  label: string
  priceTotal: number
  currency: string
  duration: string
  transferNum: number
  flights: string[]
  route: FlightLeg[]
  cabinClass: string
  cabinCode?: string
}
export interface SearchResult {
  options: FlightOption[]
  totalCount?: number
}

// ── verify (flight_verify_solution) ────────────────────────────────────
export interface FareLeg {
  flightNo: string
  departure: string
  arrival: string
  cabinClass: string
  cabinCode?: string
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
}

// ── chat + combined view ───────────────────────────────────────────────
export interface ChatBubble {
  key: string
  role: 'user' | 'assistant'
  text: string
  /** When set, the bubble renders as a link to this turn's rebyte run. */
  runUrl?: string
  /** Turn-level failure (DO `__error` frame) — rendered in the error palette. */
  error?: boolean
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

/** travelkit tool short-name → which stage it drives. */
function stageOfTool(name: string): Stage | null {
  if (name.endsWith('flight_search')) return 'search'
  if (name.endsWith('flight_verify_solution')) return 'verify'
  if (name.endsWith('flight_create_order') || name.endsWith('flight_order_detail') ||
      name.endsWith('flight_order_detail_by_external_id')) return 'order'
  if (name.endsWith('flight_pay_order')) return 'payment'
  return null
}

export function derive(prompts: PromptContent[]): DerivedView {
  const chat: ChatBubble[] = []
  const toolNameById = new Map<string, string>()
  let search: SearchResult | null = null
  let fare: FareVerification | null = null
  let notice: string | null = null
  let stage: Stage = 'idle'

  for (const p of prompts) {
    chat.push({ key: `u-${p.id}`, role: 'user', text: p.prompt })

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
        chat.push({ key: `e-${p.id}-${f.seq}`, role: 'assistant', text: data.__error, error: true })
        continue
      }

      // assistant turn: collect text bubbles + remember tool_use ids → names
      if (data.type === 'assistant' && isObj(data.message)) {
        const content = (data.message as Record<string, unknown>).content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!isObj(block)) continue
            if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
              toolNameById.set(block.id, block.name)
            }
          }
        }
        const text = textFromContent(content)
        if (text.trim()) {
          chat.push({ key: `a-${(data.message as Record<string, unknown>).id ?? f.seq}-${f.seq}`, role: 'assistant', text })
        }
      }

      // user turn carrying tool_result: route by which travelkit tool produced it
      if (data.type === 'user' && isObj(data.message)) {
        const content = (data.message as Record<string, unknown>).content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (!isObj(block) || block.type !== 'tool_result') continue
          const name = typeof block.tool_use_id === 'string' ? toolNameById.get(block.tool_use_id) ?? '' : ''
          const toolStage = stageOfTool(name)
          if (!toolStage) continue
          const payload = parseToolJson(textFromContent(block.content))
          if (!payload) continue

          if (toolStage === 'search') {
            const parsed = parseSearchResult(payload)
            if (parsed) { search = parsed; fare = null; notice = null; stage = 'search' }
          } else if (toolStage === 'verify') {
            if (payload.success === false) {
              notice = errorMessage(payload) ?? '该价格方案已失效，请重新选择其他方案。'
            } else {
              const parsed = parseVerify(payload)
              if (parsed) { fare = parsed; notice = null; stage = 'verify' }
            }
          }
          // order / payment stages parsed in a later milestone
        }
      }
    }
  }

  // de-dupe consecutive identical assistant bubbles (full message can repeat)
  const deduped: ChatBubble[] = []
  for (const b of chat) {
    const prev = deduped[deduped.length - 1]
    if (prev && prev.role === b.role && prev.text === b.text && prev.runUrl === b.runUrl) continue
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
    return null
  }
}

function errorMessage(payload: Record<string, unknown>): string | null {
  const err = payload.error
  if (isObj(err) && typeof err.message === 'string') return err.message
  return null
}

function parseSearchResult(json: Record<string, unknown>): SearchResult | null {
  const data = isObj(json.data) ? json.data : null
  const options = data && Array.isArray(data.displayOptions) ? (data.displayOptions as FlightOption[]) : null
  if (!options) return null
  return { options, totalCount: data && typeof data.totalCount === 'number' ? data.totalCount : undefined }
}

/** coreSegmentId looks like `20260605-PKX-SHA-CZ8899`; the raw id is hidden, but
 *  the airports + flight number it encodes are all safe to display. */
function parseCoreSegment(id: string): { departure: string; arrival: string; flightNo: string } {
  const parts = id.split('-')
  return { departure: parts[1] ?? '', arrival: parts[2] ?? '', flightNo: parts[3] ?? '' }
}

function parseVerify(json: Record<string, unknown>): FareVerification | null {
  const data = isObj(json.data) ? json.data : null
  if (!data) return null

  // price breakdown (sum across passenger types)
  const priceDetail = isObj(data.priceDetail) ? data.priceDetail : null
  const priceList = priceDetail && Array.isArray(priceDetail.priceList) ? priceDetail.priceList : []
  const passengers: FarePassengerLine[] = []
  let total = 0, baseFare = 0, tax = 0, publishTotal = 0, currency = 'CNY'
  for (const row of priceList) {
    if (!isObj(row)) continue
    const n = num(row.num) || 1
    const fare = num(row.price)
    const t = num(row.tax)
    const sale = num(row.salePrice) || fare + t
    const pub = num(row.publishPrice) || sale
    if (typeof row.currency === 'string') currency = row.currency
    passengers.push({ passengerType: str(row.passengerType) || 'adult', baseFare: fare, tax: t, salePrice: sale, num: n })
    total += sale * n
    baseFare += fare * n
    tax += t * n
    publishTotal += pub * n
  }

  // journeys → legs (parse coreSegmentId for airports + flight number)
  const journeys: FareJourney[] = []
  const baggage: BaggageInfo[] = []
  const seenBaggage = new Set<string>()
  let minAvailability: number | null = null
  const rawJourneys = Array.isArray(data.journeys) ? data.journeys : []
  for (const j of rawJourneys) {
    if (!isObj(j)) continue
    const legs: FareLeg[] = []
    const segs = Array.isArray(j.segments) ? j.segments : []
    for (const s of segs) {
      if (!isObj(s)) continue
      const core = parseCoreSegment(str(s.coreSegmentId))
      const avail = typeof s.availability === 'number' ? s.availability : undefined
      if (avail !== undefined) minAvailability = minAvailability === null ? avail : Math.min(minAvailability, avail)
      legs.push({
        flightNo: core.flightNo,
        departure: core.departure,
        arrival: core.arrival,
        cabinClass: str(s.cabinClass),
        cabinCode: str(s.cabinCode) || undefined,
        availability: avail,
      })
      // baggage rules (already human-readable descriptions), dedup per passenger type
      const rules = Array.isArray(s.baggageRules) ? s.baggageRules : []
      for (const r of rules) {
        if (!isObj(r)) continue
        const ptype = str(r.passengerType) || 'adult'
        if (seenBaggage.has(ptype)) continue
        seenBaggage.add(ptype)
        const carryOn = isObj(r.carryOn) ? str(r.carryOn.description) : ''
        const checked = isObj(r.checked) ? str(r.checked.description) : ''
        if (carryOn || checked) baggage.push({ passengerType: ptype, carryOn: carryOn || undefined, checked: checked || undefined })
      }
    }
    journeys.push({
      origin: str(j.origin),
      destination: str(j.destination),
      departureDate: str(j.departureDate) || undefined,
      departureTime: str(j.departureTime) || undefined,
      arrivalDate: str(j.arrivalDate) || undefined,
      arrivalTime: str(j.arrivalTime) || undefined,
      duration: str(j.duration),
      transferNum: num(j.transferNum),
      legs,
    })
  }

  // fare rules (descriptions are already plain Chinese)
  const fareRules: FareRuleInfo[] = []
  const rawRules = Array.isArray(data.fareRules) ? data.fareRules : []
  for (const r of rawRules) {
    if (!isObj(r)) continue
    fareRules.push({
      passengerType: str(r.passengerType) || 'adult',
      canVoid: r.canVoid === true,
      refundDescription: str(r.refundDescription) || undefined,
      changeDescription: str(r.changeDescription) || undefined,
    })
  }

  if (!journeys.length && !passengers.length) return null
  return { currency, total, baseFare, tax, publishTotal, journeys, passengers, baggage, fareRules, minAvailability }
}
