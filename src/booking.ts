/**
 * Passenger-collection domain helpers shared by the form, the confirm gate, and
 * App's prompt builder. The form data never leaves the browser except as the
 * natural-language prompt we hand the agent — the agent owns all the internal
 * order/passenger IDs (DESIGN §4.3, §5).
 */
import type { CompactPrice, FareVerification, FareJourney, RecommendationPlan } from './frames.ts'
import { flightMoney } from './lib/flight-display.ts'

export type DocType = 'idcard' | 'passport' | 'mtp' | 'ttp'
export type PaxType = 'adult' | 'child' | 'infant'
export type Gender = 'M' | 'F'

export function isBookableFare(fare: FareVerification | null): fare is FareVerification {
  if (fare?.canBook !== true || !fare.bookableUntil) return false
  const validUntilMs = Date.parse(fare.bookableUntil)
  return Number.isFinite(validUntilMs) && Date.now() <= validUntilMs
}

export const PAX_LABELS: Record<PaxType, string> = { adult: '成人', child: '儿童', infant: '婴儿' }
export const GENDER_LABELS: Record<Gender, string> = { M: '男', F: '女' }

/** usesPassport=true → English surname/given-names + passport expiry; otherwise a
 *  single Chinese document name (skill: do not split idcard/permit names). */
export const DOC_TYPES: { value: DocType; label: string; usesPassport: boolean }[] = [
  { value: 'idcard', label: '身份证', usesPassport: false },
  { value: 'passport', label: '护照', usesPassport: true },
  { value: 'mtp', label: '港澳通行证', usesPassport: false },
  { value: 'ttp', label: '台湾通行证', usesPassport: false },
]

export function usesPassport(docType: DocType): boolean {
  return DOC_TYPES.find((d) => d.value === docType)?.usesPassport ?? false
}
export function docLabel(docType: DocType): string {
  return DOC_TYPES.find((d) => d.value === docType)?.label ?? docType
}

export interface PassengerDraft {
  paxType: PaxType
  docType: DocType
  nameCn: string
  surnameEn: string
  givenNamesEn: string
  birthday: string
  gender: Gender
  nationality: string
  docNo: string
  passportExpiry: string
  phone: string
  email: string
}

export function emptyPassenger(paxType: PaxType): PassengerDraft {
  return {
    paxType,
    docType: 'idcard',
    nameCn: '',
    surnameEn: '',
    givenNamesEn: '',
    birthday: '',
    gender: 'M',
    nationality: '中国',
    docNo: '',
    passportExpiry: '',
    phone: '',
    email: '',
  }
}

/** Seed one row per priced seat so the passenger count matches the verified
 *  solution (changing counts requires a re-verify, so the count is fixed here). */
export function passengersFromFare(fare: FareVerification): PassengerDraft[] {
  const rows: PassengerDraft[] = []
  for (const line of fare.passengers) {
    for (let i = 0; i < (line.num || 1); i++) rows.push(emptyPassenger(line.passengerType as PaxType))
  }
  return rows.length ? rows : [emptyPassenger('adult')]
}

export function passengerValid(p: PassengerDraft): boolean {
  const base = !!(p.birthday && p.docNo && p.phone)
  if (!base) return false
  if (usesPassport(p.docType)) return !!(p.surnameEn && p.givenNamesEn && p.passportExpiry)
  return !!p.nameCn
}

export function passengerName(p: PassengerDraft): string {
  return usesPassport(p.docType) ? `${p.surnameEn}/${p.givenNamesEn}`.trim() : p.nameCn
}

// ── flight display formatters (shared by the search / fare / confirm cards) ──
export const CABIN_LABELS: Record<string, string> = {
  economy: '经济舱',
  premium_economy: '超级经济舱',
  business: '商务舱',
  premium_business: '超级商务舱',
  first: '头等舱',
  premium_first: '超级头等舱',
}
/** Fall back to the raw code when a passenger/cabin type isn't in the label map. */
export const paxLabel = (t: string): string => PAX_LABELS[t as PaxType] ?? t
export const cabinLabel = (cabinClass: string, code?: string): string =>
  (CABIN_LABELS[cabinClass] ?? cabinClass) + (code ? ` / ${code}` : '')

/** "2h35m" → "2小时35分"; passes anything that doesn't match straight through. */
export function fmtDuration(d: string): string {
  const m = /(\d+)h(\d+)m/.exec(d)
  if (!m) return d
  return `${Number(m[1])}小时${Number(m[2]).toString().padStart(2, '0')}分`
}
export const stopsLabel = (transferNum: number): string => (transferNum === 0 ? '直飞' : `中转${transferNum}次`)

/** Route / flight numbers / stops derived from a verified journey's legs. */
export function journeyFacts(j: FareJourney): { route: string; flights: string; stops: string } {
  const first = j.legs[0]
  const last = j.legs[j.legs.length - 1]
  const route = first && last ? `${first.departure} → ${last.arrival}` : `${j.origin} → ${j.destination}`
  const flights = j.legs.map((l) => l.flightNo).filter(Boolean).join(' / ')
  return { route, flights, stops: stopsLabel(j.transferNum) }
}

export const currencySymbol = (fare: FareVerification): string => (fare.currency === 'CNY' ? '¥' : `${fare.currency} `)

/** Skill output-rule warning when seats are scarce; null when availability is fine/unknown. */
export function lowStockWarning(fare: FareVerification): string | null {
  return fare.minAvailability !== null && fare.minAvailability <= 3
    ? `当前余票不多，仅剩 ${fare.minAvailability} 张，请尽快完成预订和支付；未支付前票价和余票可能变化。`
    : null
}

/** Amount line per output-rules: total = fare + tax; mark splits 未返回 if absent. */
export function amountLine(fare: FareVerification): string {
  const c = currencySymbol(fare)
  if (fare.priceBreakdownDisplay) return `金额：${c}${fare.total}（${fare.priceBreakdownDisplay}）`
  if (fare.baseFare > 0 && fare.tax > 0) {
    return `金额：${c}${fare.total}（票面价 ${c}${fare.baseFare} + 税价 ${c}${fare.tax}）`
  }
  return `金额：${c}${fare.total}（票面价 未返回 + 税价 未返回）`
}

// ── recommended-plan booking helpers (conversational collection, then recommend-book) ──
// Operators receive passenger details as WeChat text or spreadsheets, so collection is
// the AGENT's conversation (paste-friendly, field-level fix loops from the skill), not a
// form. Prompt builders + their chip recognizers live together in operator-actions.ts;
// this file keeps the plan/passenger display vocabulary they share with components.

/** Operator-facing labels for changed verification fields (superset shared with the
 *  legacy verify comparison — see buildChangeNotice in frames.ts). */
export const CHANGE_FIELD_LABELS: Record<string, string> = {
  flights: '航班',
  price: '价格',
  cabin: '舱位',
  baggage: '行李额',
  hasCheckedBaggage: '是否含托运',
}

export function planBookingChangeLabels(changedFields: string[]): string {
  return changedFields.map((field) => CHANGE_FIELD_LABELS[field] ?? field).join('、')
}

/** "N 成人、N 儿童、N 婴儿" from a bare count — the one summary both the plan table
 *  and the booking gate render. */
export function paxSummary(count: { adult: number; child: number; infant: number }): string {
  return [
    count.adult ? `${count.adult} ${PAX_LABELS.adult}` : '',
    count.child ? `${count.child} ${PAX_LABELS.child}` : '',
    count.infant ? `${count.infant} ${PAX_LABELS.infant}` : '',
  ].filter(Boolean).join('、')
}

/** The total the customer sees for a plan — quote total when the skill priced one. */
export function planTotal(plan: RecommendationPlan): CompactPrice {
  return plan.customerQuoteTotal ?? plan.verifiedFareTotal
}

/** "SHA→SIN、SIN→SHA" for any journey list (a plan's, or a ticket group's subset). */
export function journeyRoute(journeys: Array<{ origin: string; destination: string }>): string {
  return journeys.map((journey) => `${journey.origin}→${journey.destination}`).join('、')
}

/** Human-readable identity of a plan for prompts and chips: route/flights/total. */
export function planDisplayFacts(plan: RecommendationPlan): string {
  const total = planTotal(plan)
  const flights = plan.journeys
    .flatMap((journey) => journey.segments.map((segment) => segment.flightNo))
    .join('/')
  return `${journeyRoute(plan.journeys)} ${flights}，总价 ${flightMoney(total.amount, total.currency)}`
}

/** Shared with the legacy prompt's chip recognizer in operator-actions.ts. */
export const ORDER_PROMPT_HEADER = '请根据以下乘机人信息创建订单（我已确认，创建后请勿自动支付）：'

/** The single prompt sent after the user clears the confirm gate: passenger
 *  details + explicit creation confirmation, so the agent can create directly. */
export function buildOrderPrompt(passengers: PassengerDraft[], fare: FareVerification): string {
  const lines: string[] = [ORDER_PROMPT_HEADER, '']

  passengers.forEach((p, i) => {
    lines.push(`【乘机人 ${i + 1} · ${PAX_LABELS[p.paxType]}】`)
    lines.push(`- 证件类型：${docLabel(p.docType)}`)
    if (usesPassport(p.docType)) {
      lines.push(`- 护照英文姓：${p.surnameEn}`)
      lines.push(`- 护照英文名：${p.givenNamesEn}`)
    } else {
      lines.push(`- 中文姓名：${p.nameCn}`)
    }
    lines.push(`- 出生日期：${p.birthday}`)
    lines.push(`- 性别：${GENDER_LABELS[p.gender]}`)
    lines.push(`- 国籍：${p.nationality}`)
    lines.push(`- 证件号码：${p.docNo}`)
    if (usesPassport(p.docType)) lines.push(`- 护照有效期：${p.passportExpiry}`)
    lines.push(`- 手机号：${p.phone}`)
    if (p.email.trim()) lines.push(`- 邮箱：${p.email}`)
    lines.push('')
  })

  lines.push('联系人默认使用第一位乘机人的姓名和手机号。')
  lines.push('')
  lines.push(`确认创建订单：${amountLine(fare)}。请直接创建订单，创建后不要自动支付。`)
  return lines.join('\n')
}
