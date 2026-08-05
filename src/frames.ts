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
import { CHANGE_FIELD_LABELS } from './booking.ts'
import { recognizeOperatorAction } from './operator-actions.ts'
import {
  isUserQuestionAnswer,
  parseUserQuestionRequest,
  type UserQuestionAnswer,
  type UserQuestionRequest,
} from './user-question.ts'
import { deriveAgentActivityRun, type AgentActivityRun } from './agent-activity.ts'

// ── search (simplifly-flyai-skill CLI JSON) ────────────────────────────────
// `displayOptions` contains the skill CLI's curated recommendations, each fully
// structured, including solutionId for exact verify. `displayMapping` stays unused.
// Cards mirror the skill's deterministic, already-filtered recommendations;
// conversational refinement changes the constraints and asks the skill to run
// the same pipeline again.
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
export type ItineraryType = 'oneway' | 'roundtrip' | 'multi_city'
export type JourneyRole = 'oneway' | 'outbound' | 'inbound' | 'leg'
export type FareSource = 'oneway' | 'roundtrip' | 'joint'
export type OptionFareSource = FareSource | 'mixed'
export interface CompactJourney {
  role?: JourneyRole
  ticketGroupIndex?: number
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
export interface CompactTicketGroup {
  index: number
  fareSource: FareSource
  journeyIndexes: number[]
  price?: CompactPrice
  source?: string
}
export interface CompactOption {
  optionNumber: number     // skill-visible option number; UI may displayNumber after merging
  solutionId?: string      // search result handle used for exact verify; orderKey remains agent-side
  displayNumber?: number   // UI-only number when multiple compact searches are merged into one table
  selectionLabel?: string  // disambiguation for verify prompts, e.g. "第2次搜索/报价结果的原始方案1"
  searchGroupIndex?: number // 1-based order when multiple compact searches are merged into one table
  section?: string
  tag?: string | null
  verifiedAt?: string
  priceBasis?: 'search' | 'pricing' | 'verified'
  itineraryType?: ItineraryType
  fareSource?: OptionFareSource
  ticketGroups?: CompactTicketGroup[]
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
  capabilities?: { canCopy: boolean; canBook: boolean }
  journeys: CompactJourney[]
}
export interface SearchResult {
  options: CompactOption[]
  totalCount?: number       // unique candidates matched (skill curated down to options[])
  coverage?: SearchCoverage
}
export interface SearchCoverage {
  status: 'complete' | 'partial' | 'failed'
  required: FareSource[]
  attempted: FareSource[]
  completed: FareSource[]
  missing: FareSource[]
}

// ── authoritative recommendations (several complete, verified plans) ────
export type RecommendationStatus = 'loading' | 'success' | 'partial' | 'empty' | 'expired' | 'fatal_error'
export type RecommendationCoverageStatus = 'complete' | 'partial' | 'failed'
export type RecommendationBudgetStatus = 'within_budget' | 'exhausted'
export type RecommendationValidityStatus = 'verified' | 'expired'

export interface RecommendationWindow {
  journeyIndex: number
  window: string
}

export interface RecommendationSegment {
  flightNo: string
  opFlightNo?: string
  departure: string
  departureName?: string
  departureTerminal?: string
  departureDate: string
  departureTime: string
  arrival: string
  arrivalName?: string
  arrivalTerminal?: string
  arrivalDate: string
  arrivalTime: string
  flightTime?: string
}

export interface RecommendationJourney {
  journeyId: string
  routeOptionId?: string
  routePriority?: 'primary' | 'alternate'
  role: JourneyRole
  origin: string
  destination: string
  duration: string
  transferCount: number
  segments: RecommendationSegment[]
}

export interface RecommendationPassengerGroup {
  passengerGroupId: string
  cabinClass: string
  passengers: { adult: number; child: number; infant: number }
}

export interface RecommendationTicketGroup {
  ticketGroupId: string
  passengerGroupId: string
  journeyIndexes: number[]
  fareSource: FareSource
  source?: string
  cabin?: string
  baggage?: string
  segmentFacts?: RecommendationTicketSegmentFact[]
  exactPassengerCount: { adult: number; child: number; infant: number }
  verifiedAt: string
  validity: { status: RecommendationValidityStatus; validUntil: string }
  verifiedPrice: CompactPrice
  /** API-declared passenger fields this fare requires before order creation —
   *  folded into the booking prompt so collection happens in one pass. */
  requiredPassengerInfos?: string[]
}

export interface RecommendationTicketSegmentFact {
  journeyIndex: number
  segmentIndex: number
  cabin?: string
  baggage?: string
}

export interface RecommendationPlan {
  planId: string
  label?: string
  windowKey?: string
  windows: RecommendationWindow[]
  journeys: RecommendationJourney[]
  passengerGroups: RecommendationPassengerGroup[]
  ticketGroups: RecommendationTicketGroup[]
  verifiedFareTotal: CompactPrice
  customerQuoteTotal?: CompactPrice
  verifiedAt: string
  validity: { status: RecommendationValidityStatus; validUntil: string }
  explanation?: { reason: string; limitation?: string }
  copyText: string
  /** Skill-built Ctrip flight-list deep link for manual price comparison; display-only. */
  ctripUrl?: string
  capabilities: { canCopy: boolean; canReverify: boolean; canBook: boolean }
}

export interface FlightRecommendations {
  schemaVersion: 'flight-recommendations/v1'
  resultType: 'flight.recommendations'
  status: RecommendationStatus
  coverageStatus: RecommendationCoverageStatus
  alternateCoverageStatus?: RecommendationCoverageStatus | 'not_requested'
  budgetStatus: RecommendationBudgetStatus
  message?: string
  reason?: string
  missingFareConstructions?: FareSource[]
  diagnostics?: Record<string, unknown>
  capabilities: { canRetry: boolean; canReverify: boolean; canCopy: boolean }
  plans: RecommendationPlan[]
  continuation?: {
    hasMore: true
    token: string
    expiresAt: string
    nextPage: number
    pageSize: number
    /** The skill's own continuation menu, carried opaquely: TravelKit asks for more and lets
     *  the agent pick the mode, so it must not pin the set of valid values. */
    modes: string[]
  }
}

// ── verify (simplifly-flyai-skill CLI JSON) ──────────
// Versioned results are decoded by schema and result type. A shape-based legacy
// adapter remains for saved history, but it never enables copy or booking actions.
export interface FareLeg {
  flightNo: string
  departure: string
  departureName?: string
  departureTerminal?: string
  departureDate?: string
  departureTime?: string
  arrival: string
  arrivalName?: string
  arrivalTerminal?: string
  arrivalDate?: string
  arrivalTime?: string
  cabinClass: string
  cabinCode?: string
  checkedBaggage?: string
  availability?: number
}
export interface FareJourney {
  role: JourneyRole
  ticketGroupIndex: number
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
export interface FareVerification {
  schemaVersion?: string
  itineraryType?: ItineraryType
  verifiedAt?: string
  bookableUntil?: string
  currency: string
  total: number
  baseFare: number
  tax: number
  publishTotal: number
  journeys: FareJourney[]
  passengers: FarePassengerLine[]
  baggage: BaggageInfo[]
  fareRules: unknown
  minAvailability: number | null
  source?: string
  canBook: boolean
  transitAdvisory?: unknown
  /** Compact verify gives the price split as a ready display string ("票价 ¥X + 税费 ¥Y"), not
   *  structured base/tax numbers — carried here so the card and order prompt show it verbatim. */
  priceBreakdownDisplay?: string
  /** Set when the re-priced solution differs from what the user picked (price/baggage/etc changed)
   *  — a Chinese advisory the card surfaces before the user continues to passenger collection. */
  changeNotice?: string
}

// ── plan booking (recommend-book: pre-order re-verification of one plan) ──
// The skill re-verifies a recommended plan's ticket groups right before order
// creation, keeps the fresh orderKeys session-private, and reports bookability
// plus the diff against what the plan originally showed. sessionDir is a
// sandbox path and is deliberately not carried into UI state.
export type PlanBookingStatus = 'ready' | 'changed' | 'failed'

export interface PlanBookingTicketGroup {
  ticketGroupId: string
  /** order-create --option address for this group, staged by the skill in its session. */
  option: number
  passengerGroupId: string
  journeyIndexes: number[]
  fareSource: FareSource
  source?: string
  cabin?: string
  baggage?: string
  exactPassengerCount: { adult: number; child: number; infant: number }
  verifiedPrice: CompactPrice
  /** What the recommendation showed for this group when it was quoted. */
  previousPrice: CompactPrice
  requiredPassengerInfos?: string[]
  changedFields: string[]
  verifiedAt: string
  validity: { status: 'verified'; validUntil: string }
  /** The skill's transfer advisory notice, verbatim; absent for direct flights. */
  transitNotice?: string
  bookable: boolean
}

export interface PlanBooking {
  schemaVersion: 'flight-plan-booking/v1'
  resultType: 'flight.plan-booking'
  ok: boolean
  status: PlanBookingStatus
  planId: string
  bookable: boolean
  changed: boolean
  changedFields: string[]
  verifiedAt?: string
  validity?: { status: 'verified'; validUntil: string }
  verifiedFareTotal?: CompactPrice
  previousFareTotal?: CompactPrice
  orderCount: number
  splitOrder: boolean
  ticketGroups: PlanBookingTicketGroup[]
  errorType?: string
  message?: string
  /** The skill's explicit verdict that this failure killed the whole recommendation
   *  page (shared verification window) — applied mechanically, never inferred. */
  invalidatesRecommendationPage?: boolean
  capabilities: { canCreateOrders: boolean; canRetryVerification: boolean; canRequote: boolean }
}

// ── chat + combined view ───────────────────────────────────────────────
export interface ChatBubble {
  key: string
  role: 'user' | 'assistant'
  text: string
  /** Set when this user turn is a recognized workbench action (a button-built protocol
   *  prompt, not something a person typed). The UI renders a compact action chip with
   *  this label instead of a fake user-speech bubble; the wire prompt stays verbatim. */
  action?: string
  /** UTC timestamp this bubble was "sent": the prompt's created_at for the user turn, its
   *  completed_at (falling back to created_at while running) for assistant turns. The UI converts
   *  to the viewer's local timezone — see src/lib/time.ts. */
  ts?: string
  /** Turn-level failure (DO `__error` frame) — rendered in the error palette. */
  error?: boolean
  /** Inline 方案 cards attached to this assistant turn (chat-stream): the simplifly-flyai-skill
   *  compact search rendered as selectable cards, with the agent's redundant markdown
   *  table stripped from `text`. Each search keeps its own bubble → full history. */
  cards?: CompactOption[]
  totalCount?: number
  coverage?: SearchCoverage
  /** Inline verify (fare) card attached to the verify turn — same chat-stream treatment as
   *  `cards`. The latest verify's fare is the SAME object as `DerivedView.fare`, so the panel
   *  shows the "继续预订" CTA only on that one (`b.fare === view.fare`). */
  fare?: FareVerification
  /** Authoritative multi-plan result. Search results used to create it are retained as
   *  collapsed, read-only evidence on the same bubble and never regain primary status. */
  recommendations?: FlightRecommendations
  evidence?: SearchResult[]
  /** Pre-order re-verification result for one recommended plan (recommend-book). The chat
   *  bubble is a compact status record; the interactive confirm surface renders from
   *  `DerivedView.planBooking` in the booking flow at the chat tail. */
  planBooking?: PlanBooking
  /** Images/files the user attached to this turn — rendered above the user bubble (thumbnails /
   *  file chips). Set only on user bubbles, only when non-empty. */
  attachments?: Attachment[]
  /** A top-level manager clarification that pauses this prompt until answered.
   *  It is a first-class chat item, not assistant prose or a new user turn. */
  question?: UserQuestionRequest
  questionAnswer?: UserQuestionAnswer
  promptId?: string
  /** One compact, collapsible run summary. Structured business results stay separate. */
  activity?: AgentActivityRun
  /** This turn's raw rebyte run id, rendered as a copy affordance on the activity line so a
   *  user/PM can hand it back to report a problem. NOT a link: every run belongs to the single
   *  org account now, but the embedded workbench user has no rebyte dashboard login to follow
   *  a link with — the id is a debugging handle for ops, not something to click through to. */
  runId?: string
}

export type Stage = 'idle' | 'search' | 'verify' | 'recommendation' | 'order' | 'payment'

export interface DerivedView {
  chat: ChatBubble[]
  stage: Stage
  search: SearchResult | null
  fare: FareVerification | null
  recommendations: FlightRecommendations | null
  /** Newest recommend-book result in the task (last-wins), matched to the booking flow by planId. */
  planBooking: PlanBooking | null
  /** Last domain-tool failure surfaced to the user (e.g. price expired). */
  notice: string | null
  /** The latest unanswered manager question. While present, the normal composer
   *  stays disabled and the inline question owns user input. */
  pendingQuestion: ChatBubble | null
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

/** Does this bubble carry anything besides prose? One list, so a new payload kind is added
 *  in one place instead of being negated twice inside the de-dupe condition. */
function carriesPayload(b: ChatBubble): boolean {
  return Boolean(
    b.cards || b.fare || b.recommendations || b.planBooking
    || b.attachments || b.question || b.activity,
  )
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

function parseCapabilities(raw: unknown): NonNullable<CompactOption['capabilities']> | null {
  if (!isObj(raw)) return null
  if (typeof raw.canCopy !== 'boolean' || typeof raw.canBook !== 'boolean') return null
  return { canCopy: raw.canCopy === true, canBook: raw.canBook === true }
}

const RECOMMENDATIONS_SCHEMA_VERSION = 'flight-recommendations/v1'
const RECOMMENDATIONS_RESULT_TYPE = 'flight.recommendations'

/** Absent → []; present but malformed → null (caller fails closed). */
function parseRequiredPassengerInfos(raw: unknown): string[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const fields = raw.filter((field): field is string => typeof field === 'string' && field.trim() !== '')
  if (fields.length !== raw.length || new Set(fields).size !== fields.length) return null
  return fields
}

function parsePositivePrice(raw: unknown): CompactPrice | null {
  if (!isObj(raw) || typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || raw.amount <= 0) return null
  if (typeof raw.currency !== 'string' || !raw.currency.trim()) return null
  return { amount: raw.amount, currency: raw.currency, perType: parseCompactPricePerType(raw.perType) }
}

function parseRecommendationCapabilities(raw: unknown): RecommendationPlan['capabilities'] | null {
  if (!isObj(raw)) return null
  if (typeof raw.canCopy !== 'boolean' || typeof raw.canReverify !== 'boolean' || typeof raw.canBook !== 'boolean') return null
  return { canCopy: raw.canCopy, canReverify: raw.canReverify, canBook: raw.canBook }
}

function parseRecommendationPassengerCount(raw: unknown): RecommendationPassengerGroup['passengers'] | null {
  if (!isObj(raw)) return null
  const values = [raw.adult, raw.child, raw.infant]
  if (!values.every((count) => typeof count === 'number' && Number.isInteger(count) && count >= 0)) return null
  const adult = raw.adult as number
  const child = raw.child as number
  const infant = raw.infant as number
  if (adult + child + infant <= 0) return null
  return { adult, child, infant }
}

function parseRecommendationSegment(raw: unknown): RecommendationSegment | null {
  if (!isObj(raw)) return null
  const required = [raw.flightNo, raw.departure, raw.departureDate, raw.departureTime, raw.arrival, raw.arrivalDate, raw.arrivalTime]
  if (!required.every((value) => typeof value === 'string' && value.trim())) return null
  return {
    flightNo: str(raw.flightNo),
    ...(str(raw.opFlightNo) ? { opFlightNo: str(raw.opFlightNo) } : {}),
    departure: str(raw.departure),
    ...(str(raw.departureName) ? { departureName: str(raw.departureName) } : {}),
    ...(str(raw.departureTerminal) ? { departureTerminal: str(raw.departureTerminal) } : {}),
    departureDate: str(raw.departureDate),
    departureTime: str(raw.departureTime),
    arrival: str(raw.arrival),
    ...(str(raw.arrivalName) ? { arrivalName: str(raw.arrivalName) } : {}),
    ...(str(raw.arrivalTerminal) ? { arrivalTerminal: str(raw.arrivalTerminal) } : {}),
    arrivalDate: str(raw.arrivalDate),
    arrivalTime: str(raw.arrivalTime),
    ...(str(raw.flightTime) ? { flightTime: str(raw.flightTime) } : {}),
  }
}

function parseRecommendationPlan(raw: unknown): RecommendationPlan | null {
  if (!isObj(raw)) return null
  const planId = str(raw.planId).trim()
  const windowKey = str(raw.windowKey).trim()
  if (!planId || !Array.isArray(raw.journeys) || !raw.journeys.length) return null

  const journeys: RecommendationJourney[] = []
  const journeyIds = new Set<string>()
  for (const item of raw.journeys) {
    if (!isObj(item) || !isJourneyRole(item.role) || !Array.isArray(item.segments) || !item.segments.length) return null
    const journeyId = str(item.journeyId).trim()
    const origin = str(item.origin).trim()
    const destination = str(item.destination).trim()
    const duration = str(item.duration).trim()
    const routeOptionId = str(item.routeOptionId).trim()
    const routePriority = item.routePriority === 'primary' || item.routePriority === 'alternate'
      ? item.routePriority
      : undefined
    if ((routeOptionId && !routePriority) || (!routeOptionId && routePriority)) return null
    if (!journeyId || journeyIds.has(journeyId) || !origin || !destination || !duration) return null
    if (typeof item.transferCount !== 'number' || !Number.isInteger(item.transferCount) || item.transferCount < 0) return null
    const segments = item.segments.map(parseRecommendationSegment)
    if (segments.some((segment) => !segment)) return null
    journeyIds.add(journeyId)
    journeys.push({
      journeyId,
      ...(routeOptionId ? { routeOptionId, routePriority } : {}),
      role: item.role,
      origin,
      destination,
      duration,
      transferCount: item.transferCount,
      segments: segments as RecommendationSegment[],
    })
  }

  if (!Array.isArray(raw.windows) || raw.windows.length !== journeys.length) return null
  const windows: RecommendationWindow[] = []
  const windowJourneys = new Set<number>()
  for (const item of raw.windows) {
    if (!isObj(item) || typeof item.journeyIndex !== 'number' || !Number.isInteger(item.journeyIndex)) return null
    if (item.journeyIndex < 0 || item.journeyIndex >= journeys.length || windowJourneys.has(item.journeyIndex)) return null
    const window = str(item.window).trim()
    if (!window) return null
    windowJourneys.add(item.journeyIndex)
    windows.push({ journeyIndex: item.journeyIndex, window })
  }

  if (!Array.isArray(raw.passengerGroups) || !raw.passengerGroups.length) return null
  const passengerGroups: RecommendationPassengerGroup[] = []
  const passengerGroupIds = new Set<string>()
  for (const item of raw.passengerGroups) {
    if (!isObj(item)) return null
    const passengerGroupId = str(item.passengerGroupId).trim()
    const cabinClass = str(item.cabinClass).trim()
    const passengers = parseRecommendationPassengerCount(item.passengers)
    if (!passengerGroupId || passengerGroupIds.has(passengerGroupId) || !cabinClass || !passengers) return null
    passengerGroupIds.add(passengerGroupId)
    passengerGroups.push({
      passengerGroupId,
      cabinClass,
      passengers,
    })
  }

  if (!Array.isArray(raw.ticketGroups) || !raw.ticketGroups.length) return null
  const ticketGroups: RecommendationTicketGroup[] = []
  const ticketGroupIds = new Set<string>()
  for (const item of raw.ticketGroups) {
    if (!isObj(item) || !isFareSource(item.fareSource) || !Array.isArray(item.journeyIndexes) || !item.journeyIndexes.length) return null
    const ticketGroupId = str(item.ticketGroupId).trim()
    const passengerGroupId = str(item.passengerGroupId).trim()
    if (!ticketGroupId || ticketGroupIds.has(ticketGroupId) || !passengerGroupIds.has(passengerGroupId)) return null
    const journeyIndexes = item.journeyIndexes as number[]
    if (journeyIndexes.some((value) => typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= journeys.length)) return null
    const journeyIndexSet = new Set(journeyIndexes)
    if (journeyIndexSet.size !== journeyIndexes.length) return null
    const verifiedPrice = parsePositivePrice(item.verifiedPrice)
    if (!verifiedPrice) return null
    const exactPassengerCount = parseRecommendationPassengerCount(item.exactPassengerCount)
    const passengerGroup = passengerGroups.find((group) => group.passengerGroupId === passengerGroupId)
    if (!exactPassengerCount || !passengerGroup || (
      exactPassengerCount.adult !== passengerGroup.passengers.adult
      || exactPassengerCount.child !== passengerGroup.passengers.child
      || exactPassengerCount.infant !== passengerGroup.passengers.infant
    )) return null
    const verifiedAt = str(item.verifiedAt)
    if (!verifiedAt || !Number.isFinite(Date.parse(verifiedAt)) || !isObj(item.validity)) return null
    const validityStatus = item.validity.status
    const validUntil = str(item.validity.validUntil)
    if ((validityStatus !== 'verified' && validityStatus !== 'expired') || !validUntil || !Number.isFinite(Date.parse(validUntil))) return null
    if (Date.parse(validUntil) <= Date.parse(verifiedAt)) return null
    let segmentFacts: RecommendationTicketSegmentFact[] | undefined
    if (item.segmentFacts !== undefined) {
      if (!Array.isArray(item.segmentFacts)) return null
      const expectedFactCount = journeyIndexes
        .reduce((count, journeyIndex) => count + journeys[journeyIndex]!.segments.length, 0)
      if (item.segmentFacts.length !== expectedFactCount) return null
      const factKeys = new Set<string>()
      segmentFacts = []
      for (const fact of item.segmentFacts) {
        if (!isObj(fact) || !Number.isInteger(fact.journeyIndex) || !Number.isInteger(fact.segmentIndex)) return null
        const journeyIndex = fact.journeyIndex as number
        const segmentIndex = fact.segmentIndex as number
        if (!journeyIndexSet.has(journeyIndex)) return null
        if (segmentIndex < 0 || segmentIndex >= journeys[journeyIndex]!.segments.length) return null
        const key = `${journeyIndex}:${segmentIndex}`
        if (factKeys.has(key)) return null
        factKeys.add(key)
        if (fact.cabin !== undefined && (typeof fact.cabin !== 'string' || !fact.cabin.trim())) return null
        if (fact.baggage !== undefined && (typeof fact.baggage !== 'string' || !fact.baggage.trim())) return null
        const cabin = typeof fact.cabin === 'string' ? fact.cabin.trim() : ''
        const baggage = typeof fact.baggage === 'string' ? fact.baggage.trim() : ''
        segmentFacts.push({
          journeyIndex,
          segmentIndex,
          ...(cabin ? { cabin } : {}),
          ...(baggage ? { baggage } : {}),
        })
      }
    }
    const requiredPassengerInfos = parseRequiredPassengerInfos(item.requiredPassengerInfos)
    if (requiredPassengerInfos === null) return null
    ticketGroupIds.add(ticketGroupId)
    ticketGroups.push({
      ticketGroupId,
      passengerGroupId,
      journeyIndexes,
      fareSource: item.fareSource,
      ...(str(item.source) ? { source: str(item.source) } : {}),
      ...(str(item.cabin) ? { cabin: str(item.cabin) } : {}),
      ...(str(item.baggage) ? { baggage: str(item.baggage) } : {}),
      ...(segmentFacts ? { segmentFacts } : {}),
      exactPassengerCount,
      verifiedAt,
      validity: { status: validityStatus, validUntil },
      verifiedPrice,
      ...(requiredPassengerInfos.length ? { requiredPassengerInfos } : {}),
    })
  }

  // Every passenger/cabin group must be covered by ticket groups exactly once for every journey.
  for (const passengerGroupId of passengerGroupIds) {
    const counts = Array.from({ length: journeys.length }, () => 0)
    for (const group of ticketGroups) {
      if (group.passengerGroupId !== passengerGroupId) continue
      for (const journeyIndex of group.journeyIndexes) counts[journeyIndex] = (counts[journeyIndex] ?? 0) + 1
    }
    if (counts.some((count) => count !== 1)) return null
  }

  const verifiedFareTotal = parsePositivePrice(raw.verifiedFareTotal)
  const customerQuoteTotal = raw.customerQuoteTotal === undefined ? undefined : parsePositivePrice(raw.customerQuoteTotal)
  if (!verifiedFareTotal || raw.customerQuoteTotal !== undefined && !customerQuoteTotal) return null
  const currency = verifiedFareTotal.currency
  if (ticketGroups.some((group) => group.verifiedPrice.currency !== currency)) return null
  if (customerQuoteTotal && customerQuoteTotal.currency !== currency) return null
  const ticketTotal = ticketGroups.reduce((sum, group) => sum + group.verifiedPrice.amount, 0)
  if (Math.abs(ticketTotal - verifiedFareTotal.amount) > 0.001) return null

  const verifiedAt = str(raw.verifiedAt)
  if (!verifiedAt || !Number.isFinite(Date.parse(verifiedAt)) || !isObj(raw.validity)) return null
  const validityStatus = raw.validity.status
  const validUntil = str(raw.validity.validUntil)
  if ((validityStatus !== 'verified' && validityStatus !== 'expired') || !validUntil || !Number.isFinite(Date.parse(validUntil))) return null
  if (Date.parse(validUntil) <= Date.parse(verifiedAt)) return null
  if (ticketGroups.some((group) => group.validity.status !== validityStatus)) return null
  const latestTicketVerification = Math.max(...ticketGroups.map((group) => Date.parse(group.verifiedAt)))
  const earliestTicketExpiry = Math.min(...ticketGroups.map((group) => Date.parse(group.validity.validUntil)))
  if (Date.parse(verifiedAt) !== latestTicketVerification || Date.parse(validUntil) !== earliestTicketExpiry) return null
  const capabilities = parseRecommendationCapabilities(raw.capabilities)
  if (!capabilities) return null
  const copyText = str(raw.copyText)
  if (capabilities.canCopy && (!copyText.trim() || !customerQuoteTotal || validityStatus !== 'verified')) return null
  if (validityStatus === 'expired' && (capabilities.canCopy || !capabilities.canReverify)) return null

  let explanation: RecommendationPlan['explanation']
  if (raw.explanation !== undefined) {
    if (!isObj(raw.explanation) || !str(raw.explanation.reason).trim()) return null
    explanation = {
      reason: str(raw.explanation.reason),
      ...(str(raw.explanation.limitation).trim() ? { limitation: str(raw.explanation.limitation) } : {}),
    }
  }

  return {
    planId,
    ...(str(raw.label).trim() ? { label: str(raw.label) } : {}),
    ...(windowKey ? { windowKey } : {}),
    windows,
    journeys,
    passengerGroups,
    ticketGroups,
    verifiedFareTotal,
    ...(customerQuoteTotal ? { customerQuoteTotal } : {}),
    verifiedAt,
    validity: { status: validityStatus, validUntil },
    ...(explanation ? { explanation } : {}),
    copyText,
    // Display-only link; an absent or non-Ctrip URL just drops the field, never the plan.
    ...(str(raw.ctripUrl).startsWith('https://flights.ctrip.com/') ? { ctripUrl: str(raw.ctripUrl) } : {}),
    capabilities,
  }
}

function parseRecommendations(raw: Record<string, unknown>): FlightRecommendations | null {
  if (raw.resultType !== RECOMMENDATIONS_RESULT_TYPE || raw.schemaVersion !== RECOMMENDATIONS_SCHEMA_VERSION) return null
  const status = raw.status
  const coverageStatus = raw.coverageStatus
  const alternateCoverageStatus = raw.alternateCoverageStatus
  const budgetStatus = raw.budgetStatus
  if (status !== 'loading' && status !== 'success' && status !== 'partial' && status !== 'empty' && status !== 'expired' && status !== 'fatal_error') return null
  if (coverageStatus !== 'complete' && coverageStatus !== 'partial' && coverageStatus !== 'failed') return null
  if (alternateCoverageStatus !== undefined
    && alternateCoverageStatus !== 'complete'
    && alternateCoverageStatus !== 'partial'
    && alternateCoverageStatus !== 'failed'
    && alternateCoverageStatus !== 'not_requested') return null
  if (budgetStatus !== 'within_budget' && budgetStatus !== 'exhausted') return null
  // How many plans a page carries is the skill's product decision (its own
  // MAX_RECOMMENDATION_RESULTS), not a TravelKit contract term. Mirroring the number here
  // would reject every result the day the skill changes it.
  if (!Array.isArray(raw.plans)) return null
  const planBearing = status === 'success' || status === 'partial' || status === 'expired'
  if (planBearing !== (raw.plans.length > 0)) return null
  const plans = raw.plans.map(parseRecommendationPlan)
  if (plans.some((plan) => !plan)) return null
  const typedPlans = plans as RecommendationPlan[]
  if (new Set(typedPlans.map((plan) => plan.planId)).size !== typedPlans.length) return null
  if (status === 'expired' && typedPlans.some((plan) => plan.validity.status !== 'expired')) return null
  if ((status === 'success' || status === 'partial') && typedPlans.some((plan) => plan.validity.status !== 'verified')) return null
  if (!isObj(raw.capabilities)) return null
  const { canRetry, canReverify, canCopy } = raw.capabilities
  if (typeof canRetry !== 'boolean' || typeof canReverify !== 'boolean' || typeof canCopy !== 'boolean') return null
  const capabilities = { canRetry, canReverify, canCopy }
  const missingFareConstructions = raw.missingFareConstructions === undefined
    ? undefined
    : Array.isArray(raw.missingFareConstructions) && raw.missingFareConstructions.every(isFareSource)
      ? raw.missingFareConstructions as FareSource[]
      : null
  if (missingFareConstructions === null) return null
  if (raw.diagnostics !== undefined && !isObj(raw.diagnostics)) return null
  let continuation: FlightRecommendations['continuation']
  if (raw.continuation !== undefined) {
    if (!isObj(raw.continuation) || raw.continuation.hasMore !== true) return null
    const token = str(raw.continuation.token).trim()
    const expiresAt = str(raw.continuation.expiresAt).trim()
    const nextPage = raw.continuation.nextPage
    const pageSize = raw.continuation.pageSize
    const modes = raw.continuation.modes
    if (
      !token
      || !expiresAt
      || !Number.isFinite(Date.parse(expiresAt))
      || typeof nextPage !== 'number'
      || !Number.isInteger(nextPage)
      || nextPage < 2
      || typeof pageSize !== 'number'
      || !Number.isInteger(pageSize)
      || pageSize < 1
      || !Array.isArray(modes)
      || !modes.length
      // Which modes exist is the skill's menu, and TravelKit no longer picks one. Requiring a
      // closed set here would fail the whole page closed the day the skill adds a third.
      || modes.some((mode) => typeof mode !== 'string' || !mode.trim())
    ) return null
    continuation = {
      hasMore: true,
      token,
      expiresAt,
      nextPage,
      pageSize,
      modes: modes as string[],
    }
  }
  return {
    schemaVersion: RECOMMENDATIONS_SCHEMA_VERSION,
    resultType: RECOMMENDATIONS_RESULT_TYPE,
    status,
    coverageStatus,
    ...(alternateCoverageStatus !== undefined ? { alternateCoverageStatus } : {}),
    budgetStatus,
    ...(str(raw.message).trim() ? { message: str(raw.message) } : {}),
    ...(str(raw.reason).trim() ? { reason: str(raw.reason) } : {}),
    ...(missingFareConstructions ? { missingFareConstructions } : {}),
    ...(isObj(raw.diagnostics) ? { diagnostics: raw.diagnostics } : {}),
    capabilities,
    plans: typedPlans,
    ...(continuation ? { continuation } : {}),
  }
}

function invalidRecommendations(message = '推荐结果版本或必备字段不受支持，请重新生成推荐。'): FlightRecommendations {
  return {
    schemaVersion: RECOMMENDATIONS_SCHEMA_VERSION,
    resultType: RECOMMENDATIONS_RESULT_TYPE,
    status: 'fatal_error',
    coverageStatus: 'failed',
    budgetStatus: 'within_budget',
    message,
    reason: 'invalid_recommendation_contract',
    capabilities: { canRetry: true, canReverify: false, canCopy: false },
    plans: [],
  }
}

const PLAN_BOOKING_SCHEMA_VERSION = 'flight-plan-booking/v1'
const PLAN_BOOKING_RESULT_TYPE = 'flight.plan-booking'
const PLAN_BOOKING_CHANGED_FIELDS = ['price', 'cabin', 'baggage'] as const

function parsePlanBookingChangedFields(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  if (!raw.every((field) => typeof field === 'string' && (PLAN_BOOKING_CHANGED_FIELDS as readonly string[]).includes(field))) return null
  if (new Set(raw).size !== raw.length) return null
  return raw as string[]
}

function parsePlanBookingCapabilities(raw: unknown): PlanBooking['capabilities'] | null {
  if (!isObj(raw)) return null
  const flags = [raw.canCreateOrders, raw.canRetryVerification, raw.canRequote]
  if (!flags.every((flag) => typeof flag === 'boolean')) return null
  return {
    canCreateOrders: raw.canCreateOrders === true,
    canRetryVerification: raw.canRetryVerification === true,
    canRequote: raw.canRequote === true,
  }
}

function parsePlanBookingTicketGroup(raw: unknown, fallbackOption: number): PlanBookingTicketGroup | null {
  if (!isObj(raw)) return null
  if (typeof raw.ticketGroupId !== 'string' || !raw.ticketGroupId.trim()) return null
  // `option` is the Skill's session-mapping address（order-create --option n）。The MCP
  // route's envelope has no session, hence no option — the two-phase confirmationId is the
  // address there. Absent → synthesize the ordinal so the shared type stays satisfied.
  const option = raw.option === undefined ? fallbackOption : raw.option
  if (typeof option !== 'number' || !Number.isInteger(option) || option < 1) return null
  if (typeof raw.passengerGroupId !== 'string' || !raw.passengerGroupId.trim()) return null
  if (!Array.isArray(raw.journeyIndexes) || raw.journeyIndexes.length === 0) return null
  if (!raw.journeyIndexes.every((index) => typeof index === 'number' && Number.isInteger(index) && index >= 0)) return null
  if (new Set(raw.journeyIndexes).size !== raw.journeyIndexes.length) return null
  const fareSource = raw.fareSource
  if (fareSource !== 'oneway' && fareSource !== 'roundtrip' && fareSource !== 'joint') return null
  const passengers = parseRecommendationPassengerCount(raw.exactPassengerCount)
  if (!passengers) return null
  const verifiedPrice = parsePositivePrice(raw.verifiedPrice)
  const previousPrice = parsePositivePrice(raw.previousPrice)
  if (!verifiedPrice || !previousPrice) return null
  const changedFields = parsePlanBookingChangedFields(raw.changedFields)
  if (!changedFields) return null
  if (typeof raw.verifiedAt !== 'string' || !raw.verifiedAt.trim()) return null
  if (!isObj(raw.validity) || raw.validity.status !== 'verified') return null
  if (typeof raw.validity.validUntil !== 'string' || !raw.validity.validUntil.trim()) return null
  if (raw.bookable !== true) return null
  const requiredPassengerInfos = parseRequiredPassengerInfos(raw.requiredPassengerInfos)
  if (requiredPassengerInfos === null) return null
  const transitNotice = isObj(raw.transitAdvisory) ? str(raw.transitAdvisory.notice).trim() : ''
  return {
    ticketGroupId: raw.ticketGroupId,
    option,
    passengerGroupId: raw.passengerGroupId,
    journeyIndexes: raw.journeyIndexes as number[],
    fareSource,
    ...(str(raw.source) ? { source: str(raw.source) } : {}),
    ...(str(raw.cabin) ? { cabin: str(raw.cabin) } : {}),
    ...(str(raw.baggage) ? { baggage: str(raw.baggage) } : {}),
    exactPassengerCount: passengers,
    verifiedPrice,
    previousPrice,
    changedFields,
    verifiedAt: raw.verifiedAt,
    validity: { status: 'verified', validUntil: raw.validity.validUntil },
    ...(transitNotice ? { transitNotice } : {}),
    ...(requiredPassengerInfos.length ? { requiredPassengerInfos } : {}),
    bookable: true,
  }
}

/** The one shape every failed PlanBooking shares — parsed failures and the fail-closed
 *  substitutes differ only in these four fields. */
function failedPlanBooking(
  planId: string,
  errorType: string,
  message: string,
  capabilities: PlanBooking['capabilities'],
  invalidatesRecommendationPage = false,
): PlanBooking {
  return {
    schemaVersion: PLAN_BOOKING_SCHEMA_VERSION,
    resultType: PLAN_BOOKING_RESULT_TYPE,
    ok: false,
    status: 'failed',
    planId,
    bookable: false,
    changed: false,
    changedFields: [],
    orderCount: 0,
    splitOrder: false,
    ticketGroups: [],
    errorType,
    message,
    invalidatesRecommendationPage,
    capabilities,
  }
}

/** Fail-closed decode of the recommend-book envelope. A failed envelope (ok:false) is a VALID
 *  parse — it is the authoritative "this plan is no longer sellable" signal; only contract
 *  violations return null. */
function parsePlanBooking(raw: Record<string, unknown>): PlanBooking | null {
  if (raw.schemaVersion !== PLAN_BOOKING_SCHEMA_VERSION || raw.resultType !== PLAN_BOOKING_RESULT_TYPE) return null
  const status = raw.status
  if (status !== 'ready' && status !== 'changed' && status !== 'failed') return null
  // Equality against the derived value also rejects non-booleans — no typeof needed.
  if (raw.ok !== (status !== 'failed')) return null
  if (typeof raw.planId !== 'string' || !raw.planId.trim()) return null
  const capabilities = parsePlanBookingCapabilities(raw.capabilities)
  if (!capabilities) return null
  if (capabilities.canCreateOrders !== raw.ok) return null

  if (status === 'failed') {
    const message = str(raw.message).trim()
    const errorType = str(raw.errorType).trim()
    if (!message || !errorType) return null
    if (raw.bookable !== false) return null
    return failedPlanBooking(raw.planId, errorType, message, capabilities, raw.invalidatesRecommendationPage === true)
  }

  if (raw.bookable !== true) return null
  if ((status === 'changed') !== raw.changed) return null
  const changedFields = parsePlanBookingChangedFields(raw.changedFields)
  if (!changedFields) return null
  if ((changedFields.length > 0) !== raw.changed) return null
  if (!Array.isArray(raw.ticketGroups) || raw.ticketGroups.length === 0) return null
  const groups: PlanBookingTicketGroup[] = []
  for (const [groupIndex, rawGroup] of raw.ticketGroups.entries()) {
    const group = parsePlanBookingTicketGroup(rawGroup, groupIndex + 1)
    if (!group) return null
    groups.push(group)
  }
  if (new Set(groups.map((group) => group.ticketGroupId)).size !== groups.length) return null
  if (new Set(groups.map((group) => group.option)).size !== groups.length) return null
  // The envelope's diff must be exactly the union of the per-group diffs.
  const unionChanged = new Set(groups.flatMap((group) => group.changedFields))
  if (unionChanged.size !== changedFields.length || !changedFields.every((field) => unionChanged.has(field))) return null
  if (raw.orderCount !== groups.length) return null
  if (raw.splitOrder !== (groups.length > 1)) return null
  const verifiedFareTotal = parsePositivePrice(raw.verifiedFareTotal)
  const previousFareTotal = parsePositivePrice(raw.previousFareTotal)
  if (!verifiedFareTotal || !previousFareTotal) return null
  const currencies = new Set([
    verifiedFareTotal.currency,
    previousFareTotal.currency,
    ...groups.flatMap((group) => [group.verifiedPrice.currency, group.previousPrice.currency]),
  ])
  if (currencies.size !== 1) return null
  const groupSum = groups.reduce((sum, group) => sum + group.verifiedPrice.amount, 0)
  if (Math.abs(groupSum - verifiedFareTotal.amount) > 0.001) return null
  if (typeof raw.verifiedAt !== 'string' || !raw.verifiedAt.trim()) return null
  if (!isObj(raw.validity) || raw.validity.status !== 'verified') return null
  if (typeof raw.validity.validUntil !== 'string' || !raw.validity.validUntil.trim()) return null
  const latestVerifiedAt = groups.map((group) => group.verifiedAt).sort().at(-1)
  const earliestValidUntil = groups.map((group) => group.validity.validUntil).sort().at(0)
  if (raw.verifiedAt !== latestVerifiedAt || raw.validity.validUntil !== earliestValidUntil) return null

  return {
    schemaVersion: PLAN_BOOKING_SCHEMA_VERSION,
    resultType: PLAN_BOOKING_RESULT_TYPE,
    ok: true,
    status,
    planId: raw.planId,
    bookable: true,
    changed: status === 'changed',
    changedFields,
    verifiedAt: raw.verifiedAt,
    validity: { status: 'verified', validUntil: raw.validity.validUntil },
    verifiedFareTotal,
    previousFareTotal,
    orderCount: groups.length,
    splitOrder: groups.length > 1,
    ticketGroups: groups,
    capabilities,
  }
}

/** Fail-closed substitute when a recommend-book envelope is present but violates the
 *  contract — surfaced as a failed booking with no retry affordances. */
function invalidPlanBooking(planId: string, message = '下单前验价结果版本或必备字段不受支持，请重新发起预订。'): PlanBooking {
  return failedPlanBooking(planId, 'invalid_plan_booking_contract', message, {
    canCreateOrders: false,
    canRetryVerification: false,
    canRequote: false,
  })
}

/** Resolve a plan by id across every recommendation table in the chat, newest first —
 *  booking is planId-addressed and re-verified, so older pages' plans stay resolvable. */
export function findRecommendationPlan(chat: ChatBubble[], planId: string): RecommendationPlan | null {
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    const plans = chat[index]?.recommendations?.plans
    if (!plans) continue
    for (const plan of plans) {
      if (plan.planId === planId) return plan
    }
  }
  return null
}

function containsMarkdownTable(text: string): boolean {
  const lines = text.split('\n')
  return lines.some((line, index) => /^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? ''))
}

function stripMarkdownTables(text: string): string {
  const lines = text.split('\n')
  const kept: string[] = []
  let inTable = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const tableStart = /^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? '')
    if (tableStart) {
      inTable = true
      continue
    }
    if (inTable && /^\s*\|.*\|\s*$/.test(line)) continue
    if (inTable) inTable = false
    kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function derive(prompts: PromptContent[]): DerivedView {
  const chat: ChatBubble[] = []
  let search: SearchResult | null = null
  let fare: FareVerification | null = null
  let recommendations: FlightRecommendations | null = null
  let planBooking: PlanBooking | null = null
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
    const operatorAction = recognizeOperatorAction(p.prompt)
    chat.push({
      key: `u-${p.id}`,
      role: 'user',
      text: p.prompt,
      ts: userTs,
      ...(operatorAction ? { action: operatorAction } : {}),
      ...(p.attachments?.length ? { attachments: p.attachments } : {}),
    })
    // Hold this prompt's latest search / verify; attach to the next assistant text (stripping its
    // redundant markdown table), else flush as a standalone card bubble at prompt end.
    let pendingSearches: SearchResult[] = []
    let hasVersionedSearch = false
    let pendingFare: FareVerification | null = null
    let pendingRecommendations: FlightRecommendations | null = null
    let pendingPlanBooking: PlanBooking | null = null
    const planBookingPlanIds = new Set<string>()
    const planBearingRecommendationSignatures = new Set<string>()
    let conflictingRecommendationResults = false
    let successfulVerifyCount = 0
    let lastAssistantTextBubble: ChatBubble | null = null
    const assistantTextBubbles: ChatBubble[] = []
    const activityRun = deriveAgentActivityRun(p)
    const toolNames = new Map<string, string>()
    const toolInputs = new Map<string, Record<string, unknown>>()
    for (const frame of p.frames) {
      if (!isObj(frame.data) || !isObj(frame.data.message)) continue
      const blocks = frame.data.message.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (
          isObj(block)
          && block.type === 'tool_use'
          && typeof block.id === 'string'
          && typeof block.name === 'string'
        ) {
          toolNames.set(block.id, block.name)
          toolInputs.set(block.id, isObj(block.input) ? block.input : {})
        }
      }
    }
    // Output files an execution result explicitly handed over to the agent (see
    // trustedOutputFile). Prompt-scoped: sub-session isolation needs frame.source,
    // which the SSE channel does not carry today — tightening that is its own change.
    const trustedOutputFiles = new Set<string>()
    let activityInserted = false
    // This turn's rebyte run id and the activity bubble it will be stamped onto. Kept as a
    // reference (not stamped at push time) because the __rebyte_run frame and the activity
    // frames can arrive in either seq order — the id is attached once, after the loop.
    let rebyteRunId: string | undefined
    let activityBubble: ChatBubble | undefined

    for (const f of [...p.frames].sort((a, b) => a.seq - b.seq)) {
      const data = f.data
      if (!isObj(data)) continue

      if (
        !activityInserted
        && activityRun
        && activityRun.firstSeq <= f.seq
      ) {
        activityBubble = {
          key: activityRun.id,
          role: 'assistant',
          text: '',
          activity: activityRun,
          ts: replyTs,
        }
        chat.push(activityBubble)
        activityInserted = true
      }

      if (data.__ask_user_question !== undefined) {
        const question = parseUserQuestionRequest(data.__ask_user_question)
        if (question) {
          chat.push({
            key: `q-${p.id}-${question.messageId}-${question.actionId}`,
            role: 'assistant',
            text: '',
            question,
            promptId: p.id,
            ts: replyTs,
          })
        }
        continue
      }

      if (isObj(data.__ask_user_answer)) {
        const actionId = String(data.__ask_user_answer.actionId ?? '')
        const messageId = String(data.__ask_user_answer.messageId ?? '')
        const answer = data.__ask_user_answer.answer
        if (actionId && messageId && isUserQuestionAnswer(answer)) {
          const questionBubble = [...chat].reverse().find(
            (bubble) =>
              bubble.question?.actionId === actionId
              && bubble.question.messageId === messageId,
          )
          if (questionBubble) questionBubble.questionAnswer = answer
        }
        continue
      }

      // This turn's rebyte run id (emitted by the DO when the relay task starts). Captured,
      // not rendered as its own bubble: it is stamped onto the activity summary below as a
      // copy affordance — the way back to the raw run when a turn needs debugging.
      if (typeof data.__rebyte_run === 'string') {
        rebyteRunId = data.__rebyte_run
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
          lastAssistantTextBubble = bubble
          assistantTextBubbles.push(bubble)
        }
      }

      // User turn carrying a simplifly-flyai-skill CLI result. Search remains
      // shape-routed; current verify results have an explicit version and result type.
      if (data.type === 'user' && isObj(data.message)) {
        const content = (data.message as Record<string, unknown>).content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (!isObj(block) || block.type !== 'tool_result') continue
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
          const sourceTool = toolUseId ? toolNames.get(toolUseId) : undefined
          // Read/Write/Edit/Skill results are documents or acknowledgements, not
          // domain-result channels. A tool-level failure is likewise local to its
          // event. The sole Read exception is an exact file that a successful
          // execution handed the payload over in: Claude Code stores oversized stdout
          // there, and the subsequent Read is still that same result transport.
          if (
            block.is_error === true
            || sourceTool === 'Write'
            || sourceTool === 'Edit'
            || sourceTool === 'Skill'
          ) continue
          const raw = textFromContent(block.content)
          if (sourceTool === 'TaskOutput' || sourceTool === 'Bash') {
            const outputFile = trustedOutputFile(raw, sourceTool)
            if (outputFile) trustedOutputFiles.add(outputFile)
          }
          let trustedOutputFileRead = false
          if (sourceTool === 'Read') {
            const filePath = str(toolInputs.get(toolUseId)?.file_path).trim()
            trustedOutputFileRead = !!filePath && trustedOutputFiles.has(filePath)
            if (!trustedOutputFileRead) continue
          }
          const payload = unwrapPollingTransport(parseBusinessPayload(raw, sourceTool, trustedOutputFileRead))
          const resultType = typeof payload?.resultType === 'string' ? payload.resultType : ''
          const schemaVersion = typeof payload?.schemaVersion === 'string' ? payload.schemaVersion : ''

          // The explicit recommendation contract is the sole primary result for
          // this turn. Route only a parsed TOP-LEVEL envelope: Skill docs, source
          // files and logs may mention the same strings and must remain tool events.
          if (
            payload
            && (
              resultType === RECOMMENDATIONS_RESULT_TYPE
              || schemaVersion.startsWith('flight-recommendations/')
            )
          ) {
            const parsed = parseRecommendations(payload)
            if (parsed?.plans.length) {
              planBearingRecommendationSignatures.add(parsed.plans.map((plan) => plan.planId).sort().join('|'))
              conflictingRecommendationResults = planBearingRecommendationSignatures.size > 1
            }
            pendingRecommendations = conflictingRecommendationResults
              ? invalidRecommendations('本次运行返回了多个独立的推荐结果，无法确定它们是否共同覆盖原始请求。请用一个完整行程请求重新生成推荐。')
              : parsed ?? invalidRecommendations()
            recommendations = pendingRecommendations
            fare = null
            pendingFare = null
            notice = null
            stage = 'recommendation'
            continue
          }

          // Pricing is intermediate evidence, never a search table. Older
          // payloads lacked this discriminator and remain handled by the legacy
          // shape adapter below for saved history only.
          if (resultType === 'flight.pricing') continue

          // Compact search: current envelopes use resultType; saved legacy results
          // are still accepted by their parsed top-level shape.
          if (payload && Array.isArray(payload.displayOptions) && isObj(payload.displayMapping)) {
            if (resultType && resultType !== 'flight.search') continue
            const parsed = parseCompactSearch(payload)
            if (parsed) {
              if (resultType === 'flight.search') hasVersionedSearch = true
              search = parsed
              if (!pendingRecommendations) {
                fare = null; recommendations = null; notice = null; stage = 'search'
              }
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

          // Every recognized verify attempt invalidates the prior actionable fare.
          // Only a valid result restores verify stage; failures fall back to search/idle.
          if (
            payload
            && (
              resultType === VERIFY_RESULT_TYPE
              || isObj(payload.verifiedOption) && isObj(payload.selectedOption)
            )
          ) {
            if (pendingRecommendations) continue
            fare = null
            recommendations = null
            pendingFare = null
            stage = search ? 'search' : 'idle'
            if (payload.ok !== true) {
              notice = verifyErrorNotice(payload)
            } else {
              const parsed = parseCompactVerify(payload)
              if (parsed) {
                successfulVerifyCount += 1
                fare = parsed; pendingFare = parsed; notice = null; stage = 'verify'
              } else {
                notice = '验价结果版本或必备字段不受支持，请重新验价。'
              }
            }
            continue
          }

          // Pre-order re-verification of one recommended plan (recommend-book). Booking is
          // orthogonal to the recommendation itself: the plan table stays authoritative and
          // visible; this result only drives the booking flow and its status record. A turn
          // that re-runs recommend-book for the SAME plan is a refresh (last wins); results
          // for two DIFFERENT plans in one turn violate the protocol and fail closed.
          if (
            payload
            && (
              resultType === PLAN_BOOKING_RESULT_TYPE
              || schemaVersion.startsWith('flight-plan-booking/')
            )
          ) {
            const parsed = parsePlanBooking(payload)
            if (parsed) planBookingPlanIds.add(parsed.planId)
            pendingPlanBooking = planBookingPlanIds.size > 1
              ? invalidPlanBooking(
                  parsed?.planId ?? '',
                  '本次运行对多个不同方案返回了下单前验价结果，无法确定要预订哪一个。请重新从推荐表发起预订。',
                )
              : parsed ?? invalidPlanBooking(str(payload.planId))
            planBooking = pendingPlanBooking
            continue
          }
          // order / payment stages parsed in a later milestone
        }
      }
    }

    if (activityRun) {
      if (pendingSearches.length) {
        activityRun.candidateCount = pendingSearches.reduce(
          (total, result) => total + (result.totalCount ?? result.options.length),
          0,
        )
      }
      const recommendationCount = pendingRecommendations?.plans.length ?? 0
      const verifiedCount = successfulVerifyCount || recommendationCount
      if (verifiedCount) activityRun.verifiedCount = verifiedCount
      // Once a search envelope has returned, the agent is no longer searching:
      // it is comparing the real candidates even if no new tool call has started.
      if (
        activityRun.state === 'active'
        && activityRun.phase === 'searching'
        && activityRun.candidateCount !== undefined
      ) {
        activityRun.phase = 'comparing'
      }
    }

    if (activityRun && !activityInserted) {
      activityBubble = {
        key: activityRun.id,
        role: 'assistant',
        text: '',
        activity: activityRun,
        ts: replyTs,
      }
      chat.push(activityBubble)
    }

    // Stamp the run id onto the activity summary once both are known (either seq order).
    if (activityBubble && rebyteRunId) activityBubble.runId = rebyteRunId

    // Domain cards render at the turn tail so a retry/ack text frame cannot consume them before the
    // real final answer arrives. Keep each compact search as its own table; merging multi-leg or
    // multi-request searches into one giant table makes unrelated trip segments indistinguishable.
    if (pendingRecommendations) {
      for (const bubble of assistantTextBubbles) bubble.text = stripMarkdownTables(bubble.text)
      fare = null
      pendingFare = null
      stage = 'recommendation'
      chat.push({
        key: `recommendations-${p.id}`,
        role: 'assistant',
        text: '',
        recommendations: pendingRecommendations,
        evidence: pendingSearches,
        ts: replyTs,
      })
    } else if (pendingSearches.length && (hasVersionedSearch || !(lastAssistantTextBubble && containsMarkdownTable(lastAssistantTextBubble.text)))) {
      if (hasVersionedSearch && lastAssistantTextBubble) {
        lastAssistantTextBubble.text = stripMarkdownTables(lastAssistantTextBubble.text)
      }
      pendingSearches.forEach((searchResult, index) => {
        chat.push({
          key: `cards-${p.id}-${index}`,
          role: 'assistant',
          text: '',
          cards: searchResult.options,
          totalCount: searchResult.totalCount,
          coverage: searchResult.coverage,
          ts: replyTs,
        })
      })
    }
    // A turn that verifies several options is an agent comparison, not a single actionable fare.
    // Rendering the last successful verify as "the" fare card surfaces arbitrary alternatives
    // (for example WN3888) after the agent already summarized the real choice in text.
    if (!pendingRecommendations && successfulVerifyCount > 1) {
      fare = null
      pendingFare = null
      stage = search ? 'search' : 'idle'
    }
    if (!pendingRecommendations && pendingFare && successfulVerifyCount === 1) {
      chat.push({ key: `fare-${p.id}`, role: 'assistant', text: '', fare: pendingFare, ts: replyTs })
    }
    if (pendingPlanBooking) {
      chat.push({ key: `plan-booking-${p.id}`, role: 'assistant', text: '', planBooking: pendingPlanBooking, ts: replyTs })
    }
  }

  // de-dupe consecutive identical assistant bubbles; never drop a payload-bearing one
  const deduped: ChatBubble[] = []
  for (const b of chat) {
    const prev = deduped[deduped.length - 1]
    if (prev && !carriesPayload(b) && !carriesPayload(prev) && prev.role === b.role && prev.text === b.text) continue
    deduped.push(b)
  }
  const pendingQuestion = [...deduped].reverse().find(
    (bubble) => bubble.question && !bubble.questionAnswer,
  ) ?? null
  return { chat: deduped, stage, search, fare, recommendations, planBooking, notice, pendingQuestion }
}

function parseToolJson(raw: string): Record<string, unknown> | null {
  const envelope = raw.trimStart()
  // Tool results are data only when stdout STARTS with the JSON envelope.
  // Never mine arbitrary prose, Skill docs, source code or logs for an object.
  if (!envelope.startsWith('{')) return null
  try {
    const json = JSON.parse(envelope)
    return isObj(json) ? json : null
  } catch {
    const extracted = firstJsonObject(envelope)
    if (!extracted) return null
    try {
      const json = JSON.parse(extracted)
      return isObj(json) ? json : null
    } catch {
      return null
    }
  }
}

/** Claude Code moves long-running Bash commands into the background and returns their
 * eventual stdout through TaskOutput. That transport wraps stdout in a small tagged
 * status envelope, so unwrap only a successful, completed TaskOutput before applying
 * the same top-level JSON boundary used for direct Bash results.
 *
 * When stdout is too large for either transport it lands in a file instead — see
 * trustedOutputFile; the Read of that exact path arrives here numbered and is unwrapped
 * with the same top-level boundary. */
/** The MCP tools (flight_recommendation_get) answer with a POLLING wrapper —
 *  { recommendationId, status, …, result: <the business envelope> } — where the
 *  skill CLI printed the envelope at top level. Descend exactly one level, and
 *  only when the wrapper itself carries no contract discriminator but its
 *  `result` does; every other payload passes through untouched. */
function unwrapPollingTransport(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) return null
  if (typeof payload.resultType === 'string' || typeof payload.schemaVersion === 'string') return payload
  const inner = payload.result
  if (
    isObj(inner) &&
    (typeof inner.resultType === 'string' || typeof inner.schemaVersion === 'string')
  ) {
    return inner
  }
  return payload
}

function parseBusinessPayload(
  raw: string,
  sourceTool?: string,
  trustedOutputFileRead = false,
): Record<string, unknown> | null {
  const direct = parseToolJson(raw)
  if (direct) return direct
  // The skill's fail-closed protocol prints a structured failure envelope and exits
  // non-zero; Claude Code prefixes that Bash result with "Exit code N", which hid
  // every FAILED envelope (the stale-page signal) from this parser. Strip exactly
  // that one prefix line — the remainder must still start at the JSON boundary.
  if (sourceTool === 'Bash') {
    const bashFailure = raw.match(/^Exit code -?\d+\r?\n([\s\S]*)$/)
    if (bashFailure) {
      const parsed = parseToolJson(bashFailure[1]!)
      if (parsed) return parsed
    }
  }
  if (sourceTool === 'Read' && trustedOutputFileRead) {
    const unnumbered = raw
      .split('\n')
      .map((line) => line.replace(/^\s*\d+\t/, ''))
      .join('\n')
    return parseToolJson(unnumbered)
  }
  if (sourceTool !== 'TaskOutput') return null

  const envelope = raw.trim()
  if (!envelope.startsWith('<retrieval_status>')) return null
  if (!/<retrieval_status>\s*success\s*<\/retrieval_status>/.test(envelope)) return null
  if (!/<status>\s*completed\s*<\/status>/.test(envelope)) return null
  // No exit-code gate: the skill's fail-closed protocol prints a structured failure
  // envelope and exits non-zero, and that envelope (the stale-page signal) must
  // survive this transport exactly like the direct-Bash "Exit code N" prefix does.
  // Contract validation downstream keeps arbitrary failed output from routing.

  const outputStartTag = '<output>'
  const outputEndTag = '</output>'
  const outputStart = envelope.indexOf(outputStartTag)
  const outputEnd = envelope.lastIndexOf(outputEndTag)
  if (outputStart < 0 || outputEnd <= outputStart) return null

  return parseToolJson(envelope.slice(outputStart + outputStartTag.length, outputEnd))
}

/** Oversized stdout never reaches us inline: the executor writes it to a file and names
 * that file in the tool result, expecting the agent to Read it next. Claude Code has TWO
 * such transports and both are execution results, not documents:
 *
 *   background task (TaskOutput)  <retrieval_status>success…<output>[Truncated. Full output: <path>]
 *   foreground Bash               <persisted-output>\nOutput too large (38KB). Full output saved to: <path>
 *
 * Return the announced path — and only from a top-level envelope of the tool that owns it,
 * so a document that merely quotes one cannot authorize a Read. The `<persisted-output>`
 * body also carries a "Preview (first 2KB)" of the same JSON: it is a TRUNCATED prefix and
 * must never be parsed, only the exact Read of <path> is the whole result. */
function trustedOutputFile(raw: string, sourceTool: string): string | null {
  const envelope = raw.trim()
  if (sourceTool === 'Bash') {
    // A tool-level failure already skipped this event, so a `<persisted-output>` envelope
    // here is stdout of a command the executor ran to completion.
    if (!envelope.startsWith('<persisted-output>')) return null
    return envelope.match(/Full output saved to:\s*([^\s\r\n]+)/)?.[1]?.trim() || null
  }
  if (!envelope.startsWith('<retrieval_status>')) return null
  if (!/<retrieval_status>\s*success\s*<\/retrieval_status>/.test(envelope)) return null
  if (!/<status>\s*completed\s*<\/status>/.test(envelope)) return null
  // Deliberately no exit-code gate — see unwrapTaskOutput above.
  const match = envelope.match(/\[Truncated\. Full output: ([^\]\r\n]+)\]/)
  return match?.[1]?.trim() || null
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

/** simplifly-flyai-skill search JSON → search view model. We read only the
 * public `displayOptions`; `displayMapping` stays private to the skill. */
function parseCompactSearch(json: Record<string, unknown>): SearchResult | null {
  if (!Array.isArray(json.displayOptions) || !isObj(json.displayMapping)) return null
  const options: CompactOption[] = []
  for (const raw of json.displayOptions) {
    const o = toCompactOption(raw)
    if (o) options.push(o)
  }
  // A shape-valid empty result is meaningful: all candidates may have failed
  // verification. Keep it so a fresh empty search clears any stale table.
  const summary = isObj(json.summary) ? json.summary : null
  const sr = Array.isArray(json.searchedRequests) && isObj(json.searchedRequests[0]) ? json.searchedRequests[0] : null
  const totalCount = summary && typeof summary.afterFilters === 'number'
    ? summary.afterFilters
    : sr && typeof sr.uniqueCandidateCount === 'number'
      ? sr.uniqueCandidateCount
      : undefined
  return { options, totalCount, coverage: parseSearchCoverage(json.searchCoverage) }
}

function parseSearchCoverage(raw: unknown): SearchCoverage | undefined {
  if (!isObj(raw) || (raw.status !== 'complete' && raw.status !== 'partial' && raw.status !== 'failed')) return undefined
  const fareSources = (value: unknown): FareSource[] => Array.isArray(value) ? value.filter(isFareSource) : []
  return {
    status: raw.status,
    required: fareSources(raw.required),
    attempted: fareSources(raw.attempted),
    completed: fareSources(raw.completed),
    missing: fareSources(raw.missing),
  }
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
      role: isJourneyRole(j.role) ? j.role : undefined,
      ticketGroupIndex: typeof j.ticketGroupIndex === 'number' && Number.isFinite(j.ticketGroupIndex)
        ? num(j.ticketGroupIndex)
        : undefined,
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
  const capabilities = parseCapabilities(raw.capabilities)
  // Verbatim from the skill — no recomputed labels, no defaulted currency, no
  // synthesized display strings. Missing data stays missing; the table shows "--".
  const blocks: NonNullable<CompactOption['blocks']> = []
  for (const b of Array.isArray(raw.blocks) ? raw.blocks : []) {
    if (!isObj(b)) continue
    blocks.push({ price: parseCompactPrice(b.price), source: str(b.source) || undefined })
  }
  const ticketGroups: NonNullable<CompactOption['ticketGroups']> = []
  for (const group of Array.isArray(raw.ticketGroups) ? raw.ticketGroups : []) {
    if (!isObj(group) || !isFareSource(group.fareSource)) continue
    const journeyIndexes = Array.isArray(group.journeyIndexes)
      ? group.journeyIndexes.filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0)
      : []
    ticketGroups.push({
      index: num(group.index),
      fareSource: group.fareSource,
      journeyIndexes,
      price: isObj(group.price) ? parseCompactPrice(group.price) : undefined,
      source: str(group.source) || undefined,
    })
  }
  return {
    optionNumber,
    solutionId: str(raw.solutionId) || undefined,
    section: str(raw.section) || undefined,
    tag: str(raw.tag) || null,
    verifiedAt: str(raw.verifiedAt) || undefined,
    priceBasis: raw.priceBasis === 'search' || raw.priceBasis === 'pricing' || raw.priceBasis === 'verified'
      ? raw.priceBasis
      : undefined,
    itineraryType: isItineraryType(raw.itineraryType) ? raw.itineraryType : undefined,
    fareSource: isOptionFareSource(raw.fareSource) ? raw.fareSource : undefined,
    ticketGroups: ticketGroups.length ? ticketGroups : undefined,
    journeyType: str(raw.journeyType),
    duration: str(raw.duration),
    durationMinutes: num(raw.durationMinutes),
    cabin: str(raw.cabin),
    baggage: str(raw.baggage) || undefined,
    hasCheckedBaggage: raw.hasCheckedBaggage === true,
    price,
    blocks: blocks.length > 1 ? blocks : undefined,
    source: str(raw.source) || undefined,
    capabilities: capabilities ?? undefined,
    journeys,
  }
}

const VERIFY_SCHEMA_VERSION = 'flight-verify/v1'
const VERIFY_RESULT_TYPE = 'flight.verify'

function isItineraryType(value: unknown): value is ItineraryType {
  return value === 'oneway' || value === 'roundtrip' || value === 'multi_city'
}

function isFareSource(value: unknown): value is FareSource {
  return value === 'oneway' || value === 'roundtrip' || value === 'joint'
}

function isOptionFareSource(value: unknown): value is OptionFareSource {
  return isFareSource(value) || value === 'mixed'
}

function isJourneyRole(value: unknown): value is JourneyRole {
  return value === 'oneway' || value === 'outbound' || value === 'inbound' || value === 'leg'
}

/** Versioned simplifly-flyai-skill verify result → UI fare model. A legacy
 * payload may still render, but missing business capabilities fail closed. */
function parseCompactVerify(json: Record<string, unknown>): FareVerification | null {
  const hasContractIdentity = json.schemaVersion !== undefined || json.resultType !== undefined
  const legacy = !hasContractIdentity
  if (!legacy && (json.schemaVersion !== VERIFY_SCHEMA_VERSION || json.resultType !== VERIFY_RESULT_TYPE)) return null

  const verified = isObj(json.verifiedOption) ? json.verifiedOption : null
  if (!verified) return null
  const explicitItineraryType = isItineraryType(verified.itineraryType) ? verified.itineraryType : undefined
  const capabilities = parseCapabilities(verified.capabilities)
  const verification = isObj(json.verification) ? json.verification : null
  const verifiedAt = verification ? str(verification.verifiedAt) : ''
  const validUntil = verification ? str(verification.validUntil) : ''
  const price = isObj(verified.price) ? verified.price : null
  const rawJourneys = Array.isArray(verified.journeys) ? verified.journeys : []
  if (!legacy && (
    !explicitItineraryType
    || !capabilities
    || capabilities.canCopy
    || verification?.status !== 'verified'
    || !verifiedAt
    || !Number.isFinite(Date.parse(verifiedAt))
    || !validUntil
    || !Number.isFinite(Date.parse(validUntil))
    || Date.parse(validUntil) <= Date.parse(verifiedAt)
    || !price
    || typeof price.amount !== 'number'
    || !Number.isFinite(price.amount)
    || !str(price.currency)
    || rawJourneys.length === 0
  )) return null

  const journeys: FareJourney[] = []
  for (const [journeyIndex, j] of rawJourneys.entries()) {
    if (!isObj(j)) {
      if (!legacy) return null
      continue
    }
    const transferCount = j.transferCount
    if (!legacy && (
      ![j.origin, j.destination, j.departureDate, j.departureTime, j.arrivalDate, j.arrivalTime, j.duration]
        .every((value) => Boolean(str(value)))
      || typeof transferCount !== 'number'
      || !Number.isInteger(transferCount)
      || transferCount < 0
    )) return null
    const legs: FareLeg[] = []
    for (const s of Array.isArray(j.segments) ? j.segments : []) {
      if (!isObj(s)) {
        if (!legacy) return null
        continue
      }
      if (!legacy && ![
        s.flightNo,
        s.departure,
        s.departureDate,
        s.departureTime,
        s.arrival,
        s.arrivalDate,
        s.arrivalTime,
      ].every((value) => Boolean(str(value)))) return null
      // compact `cabin` is already a display string ("经济舱 T舱"); carry it as cabinClass.
      legs.push({
        flightNo: str(s.flightNo),
        departure: str(s.departure),
        departureName: str(s.departureName) || undefined,
        departureTerminal: str(s.departureTerminal) || undefined,
        departureDate: str(s.departureDate) || undefined,
        departureTime: str(s.departureTime) || undefined,
        arrival: str(s.arrival),
        arrivalName: str(s.arrivalName) || undefined,
        arrivalTerminal: str(s.arrivalTerminal) || undefined,
        arrivalDate: str(s.arrivalDate) || undefined,
        arrivalTime: str(s.arrivalTime) || undefined,
        cabinClass: str(s.cabin),
        checkedBaggage: str(s.checkedBaggage) || undefined,
      })
    }
    if (!legs.length) continue
    const explicitRole = isJourneyRole(j.role) ? j.role : undefined
    const explicitTicketGroup = typeof j.ticketGroupIndex === 'number'
      && Number.isInteger(j.ticketGroupIndex)
      && j.ticketGroupIndex >= 0
      ? num(j.ticketGroupIndex)
      : undefined
    if (!legacy && (!explicitRole || explicitTicketGroup === undefined)) return null
    if (!legacy) {
      const expectedRole: JourneyRole = explicitItineraryType === 'oneway'
        ? 'oneway'
        : explicitItineraryType === 'roundtrip'
          ? (journeyIndex === 0 ? 'outbound' : 'inbound')
          : 'leg'
      const expectedJourneyCount = explicitItineraryType === 'oneway' ? 1 : explicitItineraryType === 'roundtrip' ? 2 : null
      if (explicitRole !== expectedRole || (expectedJourneyCount !== null && rawJourneys.length !== expectedJourneyCount)) return null
    }
    const role: JourneyRole = explicitRole
      ?? (Array.isArray(verified.journeys) && verified.journeys.length === 1 ? 'oneway' : 'leg')
    journeys.push({
      role,
      ticketGroupIndex: explicitTicketGroup ?? num(j.blockIndex),
      origin: str(j.origin),
      destination: str(j.destination),
      departureDate: str(j.departureDate) || undefined,
      departureTime: str(j.departureTime) || undefined,
      arrivalDate: str(j.arrivalDate) || undefined,
      arrivalTime: str(j.arrivalTime) || undefined,
      duration: str(j.duration),
      transferNum: num(transferCount),
      legs,
    })
  }
  if (!journeys.length) return null

  const parsedPrice = price ?? {}
  const total = num(parsedPrice.amount)
  const currency = str(parsedPrice.currency) || 'CNY'

  const passengers: FarePassengerLine[] = []
  const perType = isObj(parsedPrice.perType) ? parsedPrice.perType : null
  if (perType) {
    for (const [passengerType, rawLine] of Object.entries(perType)) {
      if (!isObj(rawLine) || num(rawLine.num) <= 0) continue
      passengers.push({
        passengerType,
        baseFare: num(rawLine.unitFare),
        tax: num(rawLine.unitTax),
        salePrice: num(rawLine.unitTotal),
        num: num(rawLine.num),
      })
    }
  }
  if (!passengers.length) {
    const reqCount = isObj(json.request) && isObj(json.request.passengerCount) ? json.request.passengerCount : null
    for (const t of ['adult', 'child', 'infant'] as const) {
      const n = reqCount ? num(reqCount[t]) : 0
      if (n > 0) passengers.push({ passengerType: t, baseFare: 0, tax: 0, salePrice: 0, num: n })
    }
  }
  if (!passengers.length) passengers.push({ passengerType: 'adult', baseFare: 0, tax: 0, salePrice: 0, num: 1 })

  // solution-level baggage string; only surfaced when the fare actually includes checked baggage.
  const baggage: BaggageInfo[] = []
  const bagStr = str(verified.baggage)
  if (verified.hasCheckedBaggage === true && bagStr) baggage.push({ passengerType: 'adult', checked: bagStr })

  return {
    schemaVersion: str(json.schemaVersion) || undefined,
    itineraryType: explicitItineraryType,
    verifiedAt: verifiedAt || undefined,
    bookableUntil: validUntil || undefined,
    currency,
    total,
    baseFare: num(parsedPrice.fareTotal),
    tax: num(parsedPrice.taxTotal),
    publishTotal: total,
    journeys,
    passengers,
    baggage,
    fareRules: json.fareRules ?? null,
    minAvailability: typeof verified.availability === 'number' && Number.isFinite(verified.availability)
      ? num(verified.availability)
      : null,
    source: str(verified.source) || undefined,
    canBook: !legacy && capabilities?.canBook === true,
    transitAdvisory: verified.transitAdvisory,
    priceBreakdownDisplay: str(verified.priceBreakdownDisplay) || undefined,
    changeNotice: buildChangeNotice(json.comparison),
  }
}

/** A successful verify whose re-priced solution differs from the user's pick → a short Chinese
 *  advisory the card shows before continuing. Undefined when nothing material changed. */
function buildChangeNotice(comparison: unknown): string | undefined {
  if (!isObj(comparison) || comparison.changed !== true) return undefined
  const fields = (Array.isArray(comparison.changedFields) ? comparison.changedFields : [])
    .map((f) => CHANGE_FIELD_LABELS[str(f)])
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
