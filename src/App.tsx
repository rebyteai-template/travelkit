import { useEffect, useRef } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { passengersFromFare, buildOrderPrompt } from './booking.ts'
import { ChatPanel } from './components/ChatPanel.tsx'
import { Composer, type ComposerHandle } from './components/Composer.tsx'
import { Bench } from './components/Bench.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Unauthorized } from './components/Unauthorized.tsx'
import { CreditBanner } from './components/CreditBanner.tsx'
import { useMe } from './hooks/useMe.ts'
import { useCredit } from './hooks/useCredit.ts'
import { useSessions } from './hooks/useSessions.ts'
import { useConversation } from './hooks/useConversation.ts'
import { useSendMessage } from './hooks/useSendMessage.ts'
import { useNewSandbox } from './hooks/useNewSandbox.ts'
import { busyTasksAtom } from './store/conversation.ts'
import {
  taskIdAtom,
  benchModeAtom,
  orderDraftAtom,
  navOpenAtom,
  paneAtom,
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
  const { view, busy } = useConversation()
  const send = useSendMessage()
  const newVm = useNewSandbox()

  const taskId = useAtomValue(taskIdAtom)
  const busyTasks = useAtomValue(busyTasksAtom)
  const openSession = useSetAtom(openSessionAtom)
  const newSession = useSetAtom(newSessionAtom)
  const [mode, setMode] = useAtom(benchModeAtom)
  const [orderDraft, setOrderDraft] = useAtom(orderDraftAtom)
  const [navOpen, setNavOpen] = useAtom(navOpenAtom)
  const [pane, setPane] = useAtom(paneAtom)
  const [theme, setTheme] = useAtom(themeAtom)
  const [debugOn, setDebugOn] = useAtom(debugAtom)

  const composerRef = useRef<ComposerHandle>(null)
  const brandTaps = useRef(0) // 10 taps reveal the debug "new VM" control

  // Theme: reflect light/dark on <html>. Persistence is handled by themeAtom.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

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
    if (!view.fare) return
    const need = passengersFromFare(view.fare)
    setOrderDraft((prev) => (prev.length === need.length ? prev : need))
    setMode('passengers')
  }

  const vmLabel = newVm.isPending
    ? '🔧 新建中…'
    : newVm.isError
      ? '🔧 ❌ 失败'
      : newVm.isSuccess
        ? `🔧 ✅ ${newVm.data?.sandboxId ? newVm.data.sandboxId.slice(0, 8) : '已就绪'}`
        : '🔧 新 VM'

  // Chat-stream: search 方案 render inline in chat. The right bench only appears for the
  // booking write-flow (passenger form / confirm gate); otherwise chat spans full width.
  const showBench = mode === 'passengers' || mode === 'confirm'
  const selectOption = (label: string) => send(`我选序号 ${label}，请帮我验价`)

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
        <div className="pane-toggle">
          <button className={pane === 'chat' ? 'active' : ''} onClick={() => setPane('chat')}>对话</button>
          <button className={pane === 'bench' ? 'active' : ''} onClick={() => setPane('bench')}>看板</button>
        </div>
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
        >
          {/* Hidden debug control (revealed by 10× brand tap) — kept in App so the
              sandbox-VM plumbing stays out of the presentational sidebar. */}
          {debugOn && (
            <button
              className="sidebar-vm"
              onClick={() => newVm.mutate()}
              disabled={newVm.isPending}
              title="调试：为当前用户新建一个沙箱 VM（旧的弃用）"
            >
              {vmLabel}
            </button>
          )}
        </Sidebar>
        <div className={`split pane-${pane}${showBench ? '' : ' no-bench'}`}>
          <section className="left">
            <ChatPanel chat={view.chat} busy={busy} onPick={pickSuggestion} onBook={selectOption} />
            <Composer onSend={send} busy={busy} ref={composerRef} />
          </section>
          {showBench ? (
            <section className="right">
              <Bench
                view={view}
                mode={mode}
                orderDraft={orderDraft}
                onBook={selectOption}
                onContinue={continueToPassengers}
                onSubmitPassengers={(passengers) => { setOrderDraft(passengers); setMode('confirm') }}
                onBackFromForm={() => setMode('auto')}
                onConfirmOrder={() => { if (view.fare) send(buildOrderPrompt(orderDraft, view.fare)) }}
                onCancelConfirm={() => setMode('passengers')}
                busy={busy}
              />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
