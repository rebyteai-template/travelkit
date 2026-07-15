import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatBubble, FareVerification } from '../frames.ts'
import { parseTs, shortStamp, fullStamp } from '../lib/time.ts'
import { Markdown } from './Markdown.tsx'
import { FlightResultsTable } from './FlightResultsTable.tsx'
import { FareDetailTable } from './FareDetailTable.tsx'
import { FileCard } from './FileCard.tsx'
import { Lightbox } from './Lightbox.tsx'

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
  onContinue,
  notice,
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
  /** Entry CTA for the verify card. Undefined while a write-flow step is open (mode != 'auto') so
   *  the CTA hides; when defined it shows only on the latest fare card. */
  onContinue?: () => void
  notice: string | null
  /** The active write-flow step (passenger form / confirm gate), rendered at the chat tail. */
  children?: ReactNode
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<string | null>(sessionKey)
  const needsInstantScrollRef = useRef(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (sessionRef.current !== sessionKey) {
      sessionRef.current = sessionKey
      needsInstantScrollRef.current = !!sessionKey
    }
    if (loading || (!chat.length && !busy && !children)) return
    const behavior = needsInstantScrollRef.current ? 'auto' : 'smooth'
    needsInstantScrollRef.current = false
    endRef.current?.scrollIntoView({ behavior, block: 'end' })
  }, [sessionKey, chat.length, busy, !!children, loading])

  return (
    <div className="chat">
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
          if (b.runUrl) {
            return (
              <a key={b.key} className="run-link" href={b.runUrl} target="_blank" rel="noreferrer">
                ↗ 在 rebyte 查看本次运行
              </a>
            )
          }
          // Inline card turn: the (table-stripped) assistant prose, then the search cards or the
          // verify fare card. The fare card shows its CTA only on the latest fare and only while no
          // write-flow step is open (onContinue is undefined otherwise → the form is showing below).
          if (b.cards || b.fare) {
            return (
              <div key={b.key} className="msg full">
                <div className="chat-cards">
                  {b.text.trim() ? <div className="bubble assistant"><Markdown text={b.text} /></div> : null}
                  {b.cards
                    ? <FlightResultsTable options={b.cards} totalCount={b.totalCount} coverage={b.coverage} onBook={onBook} busy={busy} />
                    : <FareDetailTable fare={b.fare!} busy={busy} onContinue={b.fare === fareLatest ? onContinue : undefined} />}
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
      {busy ? <div className="bubble assistant typing">正在处理…</div> : null}
      <div ref={endRef} />
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
