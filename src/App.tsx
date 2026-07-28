import { useEffect, useMemo, useRef } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useQueryClient } from '@tanstack/react-query'
import { passengersFromFare, buildOrderPrompt, isBookableFare } from './booking.ts'
import {
  buildPlanOrderConfirmPrompt,
  buildRecommendBookPrompt,
  buildRecommendBookRetryPrompt,
  buildRecommendationRetryPrompt,
} from './operator-actions.ts'
import { findRecommendationPlan, type PlanBooking, type RecommendationPlan } from './frames.ts'
import { ChatPanel } from './components/ChatPanel.tsx'
import { Composer, type ComposerHandle } from './components/Composer.tsx'
import { WriteFlow } from './components/WriteFlow.tsx'
import { PlanBookingFlow } from './components/PlanBookingFlow.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Unauthorized } from './components/Unauthorized.tsx'
import { CreditBanner } from './components/CreditBanner.tsx'
import { useMe } from './hooks/useMe.ts'
import { useCredit } from './hooks/useCredit.ts'
import { useSessions } from './hooks/useSessions.ts'
import { useConversation } from './hooks/useConversation.ts'
import { useSendMessage } from './hooks/useSendMessage.ts'
import { DebugConfigPanel } from './components/DebugConfigPanel.tsx'
import { answerQuestion } from './api.ts'
import type { UserQuestionAnswer } from './user-question.ts'
import { restartStream } from './lib/stream.ts'
import { busyTasksAtom } from './store/conversation.ts'
import {
  taskIdAtom,
  flowModeAtom,
  orderDraftAtom,
  planBookingPlanIdAtom,
  navOpenAtom,
  themeAtom,
  debugAtom,
  openSessionAtom,
  newSessionAtom,
} from './store/ui.ts'

/** App is the wiring layer: server state comes from React Query hooks, UI +
 *  streaming state from jotai atoms. The presentational components below keep
 *  their existing prop signatures — App just sources the props differently. */
export function App() {
  const qc = useQueryClient()
  const me = useMe()
  const { data: sessions = [] } = useSessions(!me.isError)
  const { data: credit } = useCredit(!me.isError)
  const { view, busy, loadingExistingTask } = useConversation()
  const send = useSendMessage()

  const taskId = useAtomValue(taskIdAtom)
  const busyTasks = useAtomValue(busyTasksAtom)
  const openSession = useSetAtom(openSessionAtom)
  const newSession = useSetAtom(newSessionAtom)
  const [mode, setMode] = useAtom(flowModeAtom)
  const [orderDraft, setOrderDraft] = useAtom(orderDraftAtom)
  const [bookingPlanId, setBookingPlanId] = useAtom(planBookingPlanIdAtom)
  const [navOpen, setNavOpen] = useAtom(navOpenAtom)
  const [theme, setTheme] = useAtom(themeAtom)
  const [debugOn, setDebugOn] = useAtom(debugAtom)

  const composerRef = useRef<ComposerHandle>(null)
  const brandTaps = useRef(0) // 10 taps reveal the debug "new VM" control

  // Theme: reflect light/dark on <html>. Persistence is handled by themeAtom.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  // Any fare identity/capability change invalidates a half-finished passenger
  // or confirmation flow. Clicking Continue does not change these dependencies.
  useEffect(() => {
    setMode('auto')
  }, [view.stage, view.fare?.canBook, view.fare?.verifiedAt, setMode])

  // Booking is planId-addressed and re-verified, so the flow's plan may live in ANY
  // recommendation table of the task — an older page's plans stay bookable. Memoized:
  // this runs on every streamed frame while a booking is open.
  const bookingPlan = useMemo(
    () => (bookingPlanId ? findRecommendationPlan(view.chat, bookingPlanId) : null),
    [view.chat, bookingPlanId],
  )
  useEffect(() => {
    if (bookingPlanId && !bookingPlan) setBookingPlanId(null)
  }, [bookingPlanId, bookingPlan, setBookingPlanId])

  // The skill's explicit verdict that a booking failure killed the whole page (shared
  // verification window); ChatPanel applies it to the bubble whose table holds the plan.
  const bookingStale = view.planBooking?.invalidatesRecommendationPage
    ? {
        planId: view.planBooking.planId,
        notice: '该方案已不可售：同批推荐共享同一验价窗口，本页报价已过期，需要重新给客户报价。',
      }
    : undefined

  function tapBrand() {
    if (debugOn) return
    if (++brandTaps.current >= 10) setDebugOn(true)
  }

  // Suggestion chip → drop the text into the composer (editable, not sent).
  function pickSuggestion(text: string) {
    composerRef.current?.fill(text)
  }

  // fare card → passenger form (pure UI transition; nothing sent yet)
  function continueToPassengers() {
    if (!isBookableFare(view.fare)) return
    const need = passengersFromFare(view.fare)
    setOrderDraft((prev) => (prev.length === need.length ? prev : need))
    setMode('passengers')
  }

  // ── recommended-plan booking (conversational collection, then recommend-book) ──
  // 预订 button → one intent turn. The agent collects passengers over conversation
  // (WeChat text / spreadsheet pastes), re-verifies, and the confirm gate renders from
  // the structured result. The flow marker survives the collection turns.
  function startBooking(plan: RecommendationPlan) {
    send(buildRecommendBookPrompt(plan))
    setBookingPlanId(plan.planId)
  }
  function retryBookingVerify() {
    if (!bookingPlanId) return
    send(buildRecommendBookRetryPrompt(bookingPlanId))
  }
  // Confirm gate cleared → the one write handoff. No PII rides this turn; passengers
  // stay where they were collected, in the conversation.
  function confirmBookingOrders(booking: PlanBooking) {
    send(buildPlanOrderConfirmPrompt(booking))
    setBookingPlanId(null)
  }
  // Stale page → a fresh quote for the customer (full recommend re-run).
  function requoteBooking() {
    send(buildRecommendationRetryPrompt())
    setBookingPlanId(null)
  }

  // Single-column chat stream: search cards, verify card, and the write-flow (passenger form /
  // confirm gate) all render inline. The verify card's entry CTA is offered only while no write-flow
  // step is open (mode === 'auto'); ChatPanel further limits it to the latest fare card.
  const selectOption = (prompt: string) => send(prompt)
  const answerAgentQuestion = async (promptId: string, answer: UserQuestionAnswer) => {
    const answeredTaskId = taskId
    if (!answeredTaskId) throw new Error('question has no active task')
    await answerQuestion(promptId, answer)
    restartStream(qc, answeredTaskId, promptId)
  }

  if (me.isError) return <Unauthorized />
  if (me.isPending) return <div className="app-booting" aria-busy="true" />

  return (
    <div className="app">
      {/* Org-wide low-credit heads-up (spans the app, above the workspace). */}
      <CreditBanner low={credit?.low ?? false} />
      {/* Desktop has no header — controls live in the sidebar. This slim bar only
          shows on mobile, where the sidebar collapses into a drawer. */}
      <div className="mobilebar">
        <button className="hamburger" onClick={() => setNavOpen(true)} aria-label="会话列表">☰</button>
        <span className="brand">Kitty</span>
      </div>
      <div className="workspace">
        <Sidebar
          email={me.data?.email ?? ''}
          sessions={sessions}
          currentId={taskId}
          busyIds={busyTasks}
          onSelect={openSession}
          onNew={newSession}
          open={navOpen}
          onClose={() => setNavOpen(false)}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          onTapBrand={tapBrand}
        />
        <main className="main">
          <ChatPanel
            sessionKey={taskId}
            chat={view.chat}
            busy={busy}
            loading={loadingExistingTask}
            onPick={pickSuggestion}
            onBook={selectOption}
            fareLatest={view.fare}
            recommendationsLatest={view.recommendations}
            onContinue={mode === 'auto' ? continueToPassengers : undefined}
            onStartBooking={bookingPlanId ? undefined : startBooking}
            bookingStale={bookingStale}
            notice={view.notice}
            waitingForAnswer={!!view.pendingQuestion}
            onAnswerQuestion={answerAgentQuestion}
          >
            <WriteFlow
              mode={mode}
              fare={view.fare}
              orderDraft={orderDraft}
              onSubmitPassengers={(passengers) => { setOrderDraft(passengers); setMode('confirm') }}
              onBackFromForm={() => setMode('auto')}
              onConfirmOrder={() => { if (isBookableFare(view.fare)) send(buildOrderPrompt(orderDraft, view.fare)) }}
              onCancelConfirm={() => setMode('passengers')}
              busy={busy}
            />
            <PlanBookingFlow
              plan={bookingPlan}
              booking={view.planBooking}
              busy={busy}
              onConfirmOrders={confirmBookingOrders}
              onRetryVerify={retryBookingVerify}
              onRequote={requoteBooking}
              onClose={() => setBookingPlanId(null)}
            />
          </ChatPanel>
          <Composer onSend={send} busy={busy} ref={composerRef} />
        </main>
        {/* Right-side debug config panel (revealed by the 10× brand tap): skill-URL override +
            "new VM" for the current account. Hidden for end users. */}
        {debugOn && <DebugConfigPanel />}
      </div>
    </div>
  )
}
