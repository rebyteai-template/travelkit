import { useEffect, useRef } from 'react'
import type { ChatBubble } from '../frames.ts'
import { Markdown } from './Markdown.tsx'

// Cold-start quick actions. The travelkit-pro skill's only sensible entry point is
// flight search (order/refund/PNR all need prior context), so each is a one-tap search
// hitting a different facet: direct one-way, round-trip + multi-pax, time-window filter.
// Clicking drops the text into the composer (editable) — App.pickSuggestion, not send.
const SUGGESTIONS = [
  '查明天北京飞上海的机票，1 人，直飞',
  '下周五上海飞成都、周日返程，2 位成人',
  '查后天杭州飞北京、下午出发的航班，2 人',
]

export function ChatPanel({ chat, busy, onPick }: { chat: ChatBubble[]; busy: boolean; onPick: (text: string) => void }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chat.length, busy])

  return (
    <div className="chat">
      {chat.length === 0 ? (
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
        chat.map((b) =>
          b.runUrl ? (
            <a key={b.key} className="run-link" href={b.runUrl} target="_blank" rel="noreferrer">
              ↗ 在 rebyte 查看本次运行
            </a>
          ) : (
            <div key={b.key} className={`bubble ${b.role}`}>
              {b.role === 'assistant' ? <Markdown text={b.text} /> : b.text}
            </div>
          ),
        )
      )}
      {busy ? <div className="bubble assistant typing">正在处理…</div> : null}
      <div ref={endRef} />
    </div>
  )
}
