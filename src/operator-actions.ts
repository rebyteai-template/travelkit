/**
 * Workbench operator actions — the single home for every button-built prompt AND its
 * chat recognizer. A button's wire template and the pattern that later renders it as
 * an action chip live in ONE entry, so they cannot drift apart across files (which
 * happened on day one when live templates got mislabeled as legacy elsewhere).
 *
 * frames.ts consumes only `recognizeOperatorAction`; App and components import the
 * builders. This module imports display/domain helpers from booking.ts one-way — it
 * must never be imported BY booking.ts.
 */
import type { PlanBooking, RecommendationPlan } from './frames.ts'
import { flightMoney } from './lib/flight-display.ts'
import {
  ORDER_PROMPT_HEADER,
  planBookingChangeLabels,
  planDisplayFacts,
} from './booking.ts'

/** 预订 button: names the plan in human terms (the chip renders from this), carries the
 *  planId for the skill, and sets the order of operations — collect passengers over
 *  conversation FIRST (paste-friendly, minimum ask), only then re-verify, and never
 *  order unconfirmed. Passengers-before-verify keeps the 5-minute window covering just
 *  the confirmation. */
export function buildRecommendBookPrompt(plan: RecommendationPlan): string {
  const dynamicFields = [...new Set(plan.ticketGroups.flatMap((group) => group.requiredPassengerInfos ?? []))]
  return [
    `我要预订${plan.label || '推荐方案'}（${planDisplayFacts(plan)}）。planId: ${plan.planId}。`,
    '请用一两行提示我提供最少信息（国内航线：每位乘机人 姓名+身份证号，联系人 手机号+邮箱；国际航线按护照另提示），不要表格、不要长清单；我会以任意格式发来（微信文案/表格粘贴/截图均可）。',
    dynamicFields.length ? `该票价另要求提供：${dynamicFields.join('、')}。` : '',
    '收到信息后用 order-prepare 判定是否齐全：缺什么按 missing 一次性追问；齐了不要停下等我确认，直接执行下单前重新验价（recommend-book）并返回结构化结果，同一轮把推导出的字段（生日/性别等）与验价结果一起给我核对。唯一需要等我确认的是最后的下单确认；未经我明确确认不要创建订单。',
  ].filter(Boolean).join('')
}

/** Retry after a failed / expired pre-order re-verification: passengers are already in
 *  the conversation, only the verification re-runs. */
export function buildRecommendBookRetryPrompt(planId: string): string {
  return `请重新执行下单前重新验价（recommend-book，planId: ${planId}），返回结构化结果；未经我明确确认不要创建订单。`
}

/** The confirm-gate prompt: explicit confirmation of the verified facts (including the
 *  split-order and price-change acknowledgements). Passenger details stay where they
 *  were collected — in the conversation — so no PII rides this turn. */
export function buildPlanOrderConfirmPrompt(booking: PlanBooking): string {
  const total = booking.verifiedFareTotal!
  return [
    `我已确认创建订单：planId: ${booking.planId}，总额 ${flightMoney(total.amount, total.currency)}，共 ${booking.orderCount} 张订单。`,
    booking.splitOrder ? '分票组拆单出票我已知悉。' : '',
    booking.changed ? `验价后${planBookingChangeLabels(booking.changedFields)}的变化我已确认。` : '',
    '请用对话中已收集的乘机人信息，按 recommend-book 结果逐票组执行 order-create（需 --confirm）；',
    '创建后不要自动支付；任何一单失败都要逐单如实报告。',
  ].filter(Boolean).join('')
}

export function buildRecommendationRetryPrompt(planId?: string): string {
  return planId
    ? `请重新验证推荐方案 planId: ${planId}，并返回新的 flight.recommendations 结构化结果。`
    : '请重新运行航班推荐，并返回新的 flight.recommendations 结构化结果。'
}

/** Sent as the customer's own chat turn — page size, mode and snapshot reuse stay the
 *  skill's rules. Reads like human text, so it deliberately has no recognizer. */
export function buildRecommendationContinuationPrompt(): string {
  return '再来一些方案。'
}

// One entry per action: the pattern matches exactly what the builder above emits.
// Anything unrecognized renders verbatim as a normal user bubble.
const OPERATOR_ACTION_RECOGNIZERS: Array<{ pattern: RegExp; label: (match: RegExpMatchArray) => string }> = [
  {
    // buildRecommendBookPrompt: 我要预订推荐方案 8（PEK→PVG CA1883，总价 ¥648）。planId: …
    pattern: /^我要预订(.+?)（.*?总价 ([^）\s，]+)）。planId: \S+。/,
    label: (match) => `预订${match[1]} · ${match[2]} · 先收集乘机人再验价`,
  },
  {
    pattern: /^请重新执行下单前重新验价（recommend-book，planId: \S+）/,
    label: () => '重试下单前验价',
  },
  {
    // buildPlanOrderConfirmPrompt: 我已确认创建订单：planId: …，总额 ¥648，共 2 张订单。…
    pattern: /^我已确认创建订单：planId: \S+，总额 ([^，]+)，共 (\d+) 张订单。/,
    label: (match) => `确认创建订单 · 总额 ${match[1]}${Number(match[2]) > 1 ? ` · 分 ${match[2]} 单` : ''}`,
  },
  {
    // booking.ts buildOrderPrompt (legacy fare flow) — recognized via its shared header.
    pattern: new RegExp(`^${ORDER_PROMPT_HEADER}`),
    label: () => '确认创建订单',
  },
  {
    pattern: /^请重新验证推荐方案 planId: \S+，并返回新的 flight\.recommendations 结构化结果。$/,
    label: () => '重新验价该方案',
  },
  {
    pattern: /^请重新运行航班推荐，并返回新的 flight\.recommendations 结构化结果。$/,
    label: () => '重试推荐',
  },
]

export function recognizeOperatorAction(prompt: string): string | undefined {
  for (const { pattern, label } of OPERATOR_ACTION_RECOGNIZERS) {
    const match = prompt.match(pattern)
    if (match) return label(match)
  }
  return undefined
}
