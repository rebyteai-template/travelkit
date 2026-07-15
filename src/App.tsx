import { useEffect, useRef } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { passengersFromFare, buildOrderPrompt, isBookableFare } from './booking.ts'
import { ChatPanel } from './components/ChatPanel.tsx'
import { Composer, type ComposerHandle } from './components/Composer.tsx'
import { WriteFlow } from './components/WriteFlow.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Unauthorized } from './components/Unauthorized.tsx'
import { CreditBanner } from './components/CreditBanner.tsx'
import { useMe } from './hooks/useMe.ts'
import { useCredit } from './hooks/useCredit.ts'
import { useSessions } from './hooks/useSessions.ts'
import { useConversation } from './hooks/useConversation.ts'
import { useSendMessage } from './hooks/useSendMessage.ts'
import { DebugConfigPanel } from './components/DebugConfigPanel.tsx'
import { busyTasksAtom } from './store/conversation.ts'
import {
  taskIdAtom,
  flowModeAtom,
  orderDraftAtom,
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

  // Single-column chat stream: search cards, verify card, and the write-flow (passenger form /
  // confirm gate) all render inline. The verify card's entry CTA is offered only while no write-flow
  // step is open (mode === 'auto'); ChatPanel further limits it to the latest fare card.
  const selectOption = (prompt: string) => send(prompt)

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
            onContinue={mode === 'auto' ? continueToPassengers : undefined}
            notice={view.notice}
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
