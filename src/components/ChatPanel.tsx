import { useEffect, useRef } from 'react'
import type { ChatBubble } from '../frames.ts'
import { Markdown } from './Markdown.tsx'

export function ChatPanel({ chat, busy }: { chat: ChatBubble[]; busy: boolean }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chat.length, busy])

  return (
    <div className="chat">
      {chat.length === 0 ? (
        <div className="chat-welcome">
          <h1>TripDesk</h1>
          <p className="muted">订票工作台 · 沙箱模式</p>
          <p>试试：<em>查明天北京飞上海的机票，1 人，直飞</em></p>
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
