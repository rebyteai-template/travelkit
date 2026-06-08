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
import { Composer } from './components/Composer.tsx'
import { Bench, type BenchMode } from './components/Bench.tsx'
import { SessionList } from './components/SessionList.tsx'
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
      <header className="topbar">
        <button className="hamburger" onClick={() => setNavOpen(true)} aria-label="会话列表">☰</button>
        <span className="brand" onClick={tapBrand}>TripDesk</span>
        <span className="tag">沙箱模式</span>
        {debugOn && (
          <button
            className="ghost debug-vm"
            onClick={makeNewVm}
            disabled={vmState === 'working'}
            title="调试：为当前用户新建一个沙箱 VM（旧的弃用）"
          >
            {vmState === 'working' ? '🔧 新建中…' : vmState !== 'idle' ? `🔧 ${vmState}` : '🔧 新 VM'}
          </button>
        )}
        <div className="pane-toggle">
          <button className={pane === 'chat' ? 'active' : ''} onClick={() => setPane('chat')}>对话</button>
          <button className={pane === 'bench' ? 'active' : ''} onClick={() => setPane('bench')}>看板</button>
        </div>
        <button
          className="ghost theme-toggle"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          title={theme === 'dark' ? '浅色' : '深色'}
        >
          {theme === 'dark' ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
          )}
        </button>
        <button className="ghost" onClick={newSession}>新会话</button>
      </header>
      <div className="workspace">
        <SessionList
          email={email}
          sessions={sessions}
          currentId={taskId}
          onSelect={openSession}
          open={navOpen}
          onClose={() => setNavOpen(false)}
        />
        <div className={`split pane-${pane}`}>
          <section className="left">
            <ChatPanel chat={view.chat} busy={busy} />
            <Composer onSend={send} busy={busy} />
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
