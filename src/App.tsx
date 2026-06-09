import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createTask,
  followup,
  loadContent,
  streamPrompt,
  getMe,
  listSessions,
  newSandbox,
  type PromptContent,
  type SessionSummary,
} from './api.ts'
import { derive } from './frames.ts'
import { passengersFromFare, buildOrderPrompt, type PassengerDraft } from './booking.ts'
import { ChatPanel } from './components/ChatPanel.tsx'
import { Composer, type ComposerHandle } from './components/Composer.tsx'
import { Bench, type BenchMode } from './components/Bench.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Unauthorized } from './components/Unauthorized.tsx'

/** Current session lives in the URL (?t=…) so refresh/deep-link restores it. Identity
 *  comes from Cloudflare Access, so a session belongs to a user, not a browser tab. */
function urlTaskId(): string | null {
  return new URLSearchParams(location.search).get('t')
}
function setUrlTaskId(id: string | null): void {
  const u = new URL(location.href)
  if (id) u.searchParams.set('t', id)
  else u.searchParams.delete('t')
  history.replaceState(null, '', u)
}

export function App() {
  const [email, setEmail] = useState('')
  // Auth gate: null = checking, true = valid embed handoff, false = show Unauthorized.
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [taskId, setTaskId] = useState<string | null>(() => urlTaskId())
  const [prompts, setPrompts] = useState<PromptContent[]>([])
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<BenchMode>('auto')
  const [orderDraft, setOrderDraft] = useState<PassengerDraft[]>([])
  const composerRef = useRef<ComposerHandle>(null)
  const [navOpen, setNavOpen] = useState(false) // mobile session drawer
  const [pane, setPane] = useState<'chat' | 'bench'>('chat') // mobile: which pane is visible
  // Hidden debug: tap the brand 10× to reveal a "new VM" button (test escape hatch — if a sandbox
  // gets wedged, provision a fresh one). vmState drives the button label / disabled state.
  const [debugOn, setDebugOn] = useState(false)
  const brandTaps = useRef(0)
  const [vmState, setVmState] = useState<'idle' | 'working' | string>('idle')
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (typeof localStorage !== 'undefined' && localStorage.getItem('tripdesk-theme') === 'dark' ? 'dark' : 'light'),
  )

  // Bootstrap: validate the embed handoff (getMe 401 → Unauthorized), then load sessions and
  // restore the one named in the URL. Skip all data calls if the gate rejects us.
  useEffect(() => {
    getMe()
      .then((m) => {
        setEmail(m.email)
        setAuthed(true)
        void refreshSessions()
        const t = urlTaskId()
        if (t) void openSession(t)
      })
      .catch(() => setAuthed(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Theme: reflect light/dark on <html> and remember the choice.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try { localStorage.setItem('tripdesk-theme', theme) } catch { /* ignore */ }
  }, [theme])

  async function refreshSessions() {
    try { setSessions(await listSessions()) } catch { /* unauthenticated; leave empty */ }
  }

  async function openSession(id: string) {
    setTaskId(id)
    setUrlTaskId(id)
    setMode('auto')
    setOrderDraft([])
    setNavOpen(false) // close the mobile drawer after picking a session
    try { const c = await loadContent(id); setPrompts(c?.prompts ?? []) }
    catch { setPrompts([]) }
  }

  function newSession() {
    setTaskId(null)
    setUrlTaskId(null)
    setPrompts([])
    setOrderDraft([])
    setMode('auto')
    setNavOpen(false) // close the mobile drawer after starting a new session
  }

  // Hidden easter egg: 10 taps on the brand reveals the debug "new VM" control.
  function tapBrand() {
    if (debugOn) return
    if (++brandTaps.current >= 10) setDebugOn(true)
  }

  // Debug "new VM": provision a fresh sandbox, then drop into a new session so the next message
  // runs on it (the current session stays pinned to the old VM). Slow — the VM has to boot.
  async function makeNewVm() {
    if (vmState === 'working') return
    setVmState('working')
    try {
      const { sandboxId } = await newSandbox()
      newSession()
      void refreshSessions()
      setVmState(`✅ ${sandboxId ? sandboxId.slice(0, 8) : '已就绪'}`)
    } catch (e) {
      console.error(e)
      setVmState('❌ 失败')
    }
  }

  const view = useMemo(() => derive(prompts), [prompts])

  function appendFrame(promptId: string, seq: number, data: unknown) {
    setPrompts((prev) =>
      prev.map((p) => (p.id === promptId ? { ...p, frames: [...p.frames, { seq, data }] } : p)),
    )
  }

  async function send(text: string) {
    if (busy) return
    setBusy(true)
    setMode('auto') // any new turn returns the bench to following the agent's frames
    try {
      let pid: string
      if (!taskId) {
        const r = await createTask(text)
        setTaskId(r.taskId)
        setUrlTaskId(r.taskId)
        pid = r.promptId
        void refreshSessions()
      } else {
        const r = await followup(taskId, text)
        pid = r.promptId
      }
      setPrompts((prev) => [...prev, { id: pid, prompt: text, frames: [] }])
      streamPrompt(
        pid,
        (seq, data) => appendFrame(pid, seq, data),
        () => { setBusy(false); void refreshSessions() },
      )
    } catch (e) {
      console.error(e)
      setBusy(false)
    }
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

  if (authed === false) return <Unauthorized />
  if (authed === null) return <div className="app-booting" aria-busy="true" />

  return (
    <div className="app">
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
          email={email}
          sessions={sessions}
          currentId={taskId}
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
              onClick={makeNewVm}
              disabled={vmState === 'working'}
              title="调试：为当前用户新建一个沙箱 VM（旧的弃用）"
            >
              {vmState === 'working' ? '🔧 新建中…' : vmState !== 'idle' ? `🔧 ${vmState}` : '🔧 新 VM'}
            </button>
          )}
        </Sidebar>
        <div className={`split pane-${pane}`}>
          <section className="left">
            <ChatPanel chat={view.chat} busy={busy} onPick={pickSuggestion} />
            <Composer onSend={send} busy={busy} ref={composerRef} />
          </section>
          <section className="right">
            <Bench
              view={view}
              mode={mode}
              orderDraft={orderDraft}
              onBook={(label) => send(`预订选项 ${label}，先帮我验价`)}
              onContinue={continueToPassengers}
              onSubmitPassengers={(passengers) => { setOrderDraft(passengers); setMode('confirm') }}
              onBackFromForm={() => setMode('auto')}
              onConfirmOrder={() => { if (view.fare) send(buildOrderPrompt(orderDraft, view.fare)) }}
              onCancelConfirm={() => setMode('passengers')}
              busy={busy}
            />
          </section>
        </div>
      </div>
    </div>
  )
}
