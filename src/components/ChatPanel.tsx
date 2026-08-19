import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatBubble, FareVerification, FlightRecommendations, RecommendationPlan } from '../frames.ts'
import { planBookingChangeLabels } from '../booking.ts'
import { flightMoney } from '../lib/flight-display.ts'
import { parseTs, shortStamp, fullStamp } from '../lib/time.ts'
import { Markdown } from './Markdown.tsx'
import { FlightResultsTable } from './FlightResultsTable.tsx'
import { FlightRecommendationsView } from './FlightRecommendations.tsx'
import { FareDetailTable } from './FareDetailTable.tsx'
import { FileCard } from './FileCard.tsx'
import { Lightbox } from './Lightbox.tsx'
import { UserQuestion } from './UserQuestion.tsx'
import { AgentStatus } from './AgentStatus.tsx'
import type { UserQuestionAnswer } from '../user-question.ts'
import { useReferencePrices, useSaveReferencePrice } from '../hooks/useReferencePrices.ts'
import { useCtripBridge } from '../hooks/useCtripBridge.ts'
import { quoteTargetFor } from '../lib/ctrip-target.ts'
import { CTRIP_CURRENCY } from '@travelkit/contract'

/** Local-timezone send time shown under a bubble (HH:MM today, M月D日 HH:MM otherwise); the full
 *  date + timezone is on hover. Renders nothing when the bubble carries no timestamp. */
function MsgTime({ ts }: { ts?: string }) {
  const d = parseTs(ts)
  if (!d) return null
  return (
    <time className="msg-time" dateTime={d.toISOString()} title={fullStamp(d)}>
      {shortStamp(d)}
    </time>
  )
}

// Cold-start quick actions. The simplifly-flyai-skill skill's only sensible entry point is
// flight search (order/refund/PNR all need prior context), so each is a one-tap search
// hitting a different facet: direct one-way, round-trip + multi-pax, time-window filter.
// Clicking drops the text into the composer (editable) — App.pickSuggestion, not send.
const SUGGESTIONS = [
  '查明天北京飞上海的机票，1 人，直飞',
  '下周五上海飞成都、周日返程，2 位成人',
  '查后天杭州飞北京、下午出发的航班，2 人',
]

export function ChatPanel({
  sessionKey,
  chat,
  busy,
  loading,
  onPick,
  onBook,
  fareLatest,
  recommendationsLatest,
  onContinue,
  onStartBooking,
  bookingStale,
  notice,
  waitingForAnswer,
  onAnswerQuestion,
  children,
}: {
  sessionKey: string | null
  chat: ChatBubble[]
  busy: boolean
  loading: boolean
  onPick: (text: string) => void
  onBook: (label: string) => void
  /** The current verified fare (DerivedView.fare). The inline verify card whose `b.fare` is this
   *  exact object is the latest/actionable one; older verify cards render read-only. */
  fareLatest: FareVerification | null
  /** DerivedView.recommendations — the task's newest recommendation set. Only that bubble
   *  may offer "load more"; older pages hold a token the skill already consumed. */
  recommendationsLatest: FlightRecommendations | null
  /** Entry CTA for the verify card. Undefined while a write-flow step is open (mode != 'auto') so
   *  the CTA hides; when defined it shows only on the latest fare card. */
  onContinue?: () => void
  /** Per-plan 预订 entry. Offered on EVERY recommendation table of the task — booking is
   *  planId-addressed and re-verified, so an older page's plans stay bookable (unlike the
   *  continuation token, which really does die with its page). Undefined while a booking
   *  flow is already open. */
  onStartBooking?: (plan: RecommendationPlan) => void
  /** A failed, non-retryable pre-order re-verification invalidates the PAGE holding that
   *  plan (its plans shared one verification window) — applied to the bubble whose table
   *  contains the planId, where it banners and withdraws the booking entries. */
  bookingStale?: { planId: string; notice: string }
  notice: string | null
  waitingForAnswer: boolean
  onAnswerQuestion: (promptId: string, answer: UserQuestionAnswer) => Promise<void>
  /** The active write-flow step (passenger form / confirm gate), rendered at the chat tail. */
  children?: ReactNode
}) {
  const chatRef = useRef<HTMLDivElement>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  // The Ctrip comparison figures for this session. taskId is captured here rather than
  // threaded down through the table — the recommendation components stay task-agnostic and
  // take a plain callback, the same shape as onStartBooking.
  const { byPlan: referencePrices } = useReferencePrices(sessionKey)
  const saveReferencePrice = useSaveReferencePrice(sessionKey)
  const bridge = useCtripBridge()
  // Only offered once an extension has actually answered. Without one the cell says so and the
  // plan's own 携程比价 link is what remains — every figure stored here is read from Ctrip's
  // payload, never typed, so there is no hand-entry path to fall back to.
  //
  // Asks about THIS PLAN'S FLIGHT, not for the page. The extension filters Ctrip's own search
  // JSON down to the matching itinerary and returns that one node — which is why the figure
  // stored here is the fare for the flight being quoted, and not, as it was, whatever the page
  // happened to be cheapest on (routinely a different, often connecting, itinerary).
  //
  // With manual entry gone every quiet exit here would leave a button that flashes and does
  // nothing, so each one states its reason. `captureIssue` covers the domain outcomes decided
  // HERE; transport failures (blocked, timed out) already surface through bridge.lastError.
  const [captureIssue, setCaptureIssue] = useState<string | null>(null)
  const onCaptureReferencePrice = sessionKey && bridge.installed
    ? async (plan: RecommendationPlan) => {
        setCaptureIssue(null)
        const quotable = quoteTargetFor(plan)
        // Normally unreachable — the cell hides the button behind the same ladder — but stated
        // rather than swallowed, in case the two ever render from different plan snapshots.
        if ('reason' in quotable) {
          setCaptureIssue(quotable.reason)
          return
        }
        const quote = await bridge.quote(quotable.url, quotable.target)
        if (!quote) return
        // Ctrip prices ONE ADULT and excludes tax. Storing the economy figure keeps the stored
        // number on a single, stated basis; a null one means the flight sold no unrestricted
        // economy fare, and writing a business-cabin or restricted price instead would be a
        // silent basis change on a number the operator quotes against.
        const amount = quote.extract?.economyLowestAdult
        if (!amount) {
          setCaptureIssue(`已在携程定位 ${quote.flightNo}，但它未售可比的经济舱票价`)
          return
        }
        saveReferencePrice.mutate({
          planId: plan.planId,
          amount,
          currency: CTRIP_CURRENCY,
          source: 'ctrip-extension',
          sourceUrl: quote.url,
          capturedAt: quote.capturedAt,
          // Evidence for "why this number": which flight matched, out of how many, and every
          // fare band read. The node's raw text never reaches production quotes at all (it is a
          // debug-target field), and the row has a 64KB cap regardless.
          raw: {
            flightNo: quote.flightNo,
            matchedBy: quote.matchedBy,
            flightNos: quote.flightNos,
            payloadFlightCount: quote.payloadFlightCount,
            extract: quote.extract,
          },
        })
      }
    : undefined
  // The whole Ctrip-comparison capability as ONE prop: granted by session presence, it rides the
  // component chain under a single name, so a shape change here is not a four-signature ripple.
  const ctripCompare = sessionKey
    ? {
        prices: referencePrices,
        onCapture: onCaptureReferencePrice,
        installed: bridge.installed,
        error: captureIssue ?? bridge.lastError,
        version: bridge.version,
      }
    : undefined
  const latestActivity = [...chat].reverse().find((bubble) => bubble.activity)?.activity
  const hasLiveActivity = latestActivity?.state === 'active'
  useLayoutEffect(() => {
    if (loading || (!chat.length && !busy && !children)) return
    const el = chatRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sessionKey, chat.length, busy, !!children, loading])

  return (
    <div className="chat" ref={chatRef}>
      {loading ? (
        <div className="chat-loading" aria-busy="true">正在加载会话…</div>
      ) : chat.length === 0 ? (
        <div className="chat-welcome">
          <h1>Kitty</h1>
          <p className="muted">订票工作台</p>
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggestion" onClick={() => onPick(s)} disabled={busy}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg>
                <span>{s}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        chat.map((b) => {
          if (b.activity) {
            if (b.activity.state === 'waiting') return null
            return (
              <div key={b.key} className="msg full agent-progress-message">
                <AgentStatus run={b.activity} runId={b.runId} />
              </div>
            )
          }
          if (b.question && b.promptId) {
            return (
              <div key={b.key} className="msg full">
                <UserQuestion
                  promptId={b.promptId}
                  request={b.question}
                  answered={b.questionAnswer}
                  onAnswer={onAnswerQuestion}
                />
                <MsgTime ts={b.ts} />
              </div>
            )
          }
          // Durable status record of a pre-order re-verification (recommend-book). The
          // INTERACTIVE confirm surface renders in the booking flow at the chat tail; this
          // stays in history so a reloaded conversation still shows what the check said.
          if (b.planBooking) {
            const pb = b.planBooking
            const summary = pb.ok
              ? pb.changed
                ? `${planBookingChangeLabels(pb.changedFields)}有变化 · 新总额 ${flightMoney(pb.verifiedFareTotal!.amount, pb.verifiedFareTotal!.currency)}（原 ${flightMoney(pb.previousFareTotal!.amount, pb.previousFareTotal!.currency)}）`
                : `通过 · 总额 ${flightMoney(pb.verifiedFareTotal!.amount, pb.verifiedFareTotal!.currency)} · 共 ${pb.orderCount} 张订单`
              : pb.message || '失败'
            return (
              <div key={b.key} className="msg full">
                <div className={`plan-booking-record ${pb.ok ? (pb.changed ? 'is-changed' : 'is-ready') : 'is-failed'}`}>
                  <strong>下单前验价</strong>
                  <span>{summary}</span>
                </div>
                <MsgTime ts={b.ts} />
              </div>
            )
          }
          // Inline card turn: the (table-stripped) assistant prose, then the search cards or the
          // verify fare card. The fare card shows its CTA only on the latest fare and only while no
          // write-flow step is open (onContinue is undefined otherwise → the form is showing below).
          if (b.cards || b.fare || b.recommendations) {
            const staleNotice = bookingStale
              && b.recommendations?.plans.some((plan) => plan.planId === bookingStale.planId)
              ? bookingStale.notice
              : undefined
            return (
              <div key={b.key} className="msg full">
                <div className="chat-cards">
                  {b.text.trim() ? <div className="bubble assistant"><Markdown text={b.text} /></div> : null}
                  {b.recommendations
                    ? (
                      <FlightRecommendationsView
                        result={b.recommendations}
                        evidence={b.evidence}
                        busy={busy}
                        onAction={onBook}
                        isLatest={b.recommendations === recommendationsLatest}
                        onStartBooking={onStartBooking}
                        staleNotice={staleNotice}
                        ctripCompare={ctripCompare}
                      />
                    )
                    : b.cards
                      ? <FlightResultsTable options={b.cards} totalCount={b.totalCount} coverage={b.coverage} onBook={onBook} busy={busy} />
                      : <FareDetailTable fare={b.fare!} busy={busy} onContinue={b.fare === fareLatest ? onContinue : undefined} />}
                </div>
                <MsgTime ts={b.ts} />
              </div>
            )
          }
          // A workbench action turn: the operator clicked a button, they did not type the
          // protocol prompt. Show an honest action chip; the wire prompt stays in the data.
          if (b.role === 'user' && b.action) {
            return (
              <div key={b.key} className="msg user">
                <div className="action-chip" title="工作台操作">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
                  <span>{b.action}</span>
                </div>
                <MsgTime ts={b.ts} />
              </div>
            )
          }
          // User attachments render STANDALONE (not inside the accent bubble), right-aligned with
          // the sender; the text bubble (if any) follows below — ChatGPT-style. Images are clickable
          // thumbnails (→ lightbox); non-images render the shared FileCard.
          if (b.attachments?.length) {
            return (
              <div key={b.key} className={`msg ${b.role}`}>
                <div className={`msg-attachments ${b.role}`}>
                  {b.attachments.map((a) =>
                    a.contentType.startsWith('image/') ? (
                      <img
                        key={a.fileId}
                        className="msg-thumb"
                        src={a.thumbUrl}
                        alt={a.filename}
                        loading="lazy"
                        onClick={() => setLightbox(a.largeUrl)}
                      />
                    ) : (
                      <FileCard key={a.fileId} filename={a.filename} contentType={a.contentType} />
                    ),
                  )}
                </div>
                {b.text ? <div className={`bubble ${b.role}`}>{b.text}</div> : null}
                <MsgTime ts={b.ts} />
              </div>
            )
          }
          return (
            <div key={b.key} className={`msg ${b.role}`}>
              <div className={`bubble ${b.role}${b.error ? ' error' : ''}`}>
                {b.role === 'assistant' && !b.error ? <Markdown text={b.text} /> : b.text}
              </div>
              <MsgTime ts={b.ts} />
            </div>
          )
        })
      )}
      {notice ? <div className="chat-notice">{notice}</div> : null}
      {children}
      {busy && !waitingForAnswer && !hasLiveActivity ? (
        <div className="agent-status is-active" role="status" aria-live="polite">
          <span className="agent-status-spinner" aria-hidden="true" />
          <span>正在确认行程条件…</span>
        </div>
      ) : null}
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
