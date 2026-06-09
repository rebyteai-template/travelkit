import { forwardRef, useImperativeHandle, useRef, useState } from 'react'

/** Imperative handle App holds so suggestion chips (in ChatPanel) can drop text in. */
export interface ComposerHandle {
  /** Fill the textarea with `text`, focus it, and park the caret at the end. */
  fill: (text: string) => void
}

/** Draft lives here (not lifted to App) so typing only re-renders the composer — not the
 *  chat/bench subtrees. App pokes text in via the `fill` handle for suggestion chips. */
export const Composer = forwardRef<ComposerHandle, { onSend: (text: string) => void; busy: boolean }>(
  function Composer({ onSend, busy }, ref) {
    const [text, setText] = useState('')
    const taRef = useRef<HTMLTextAreaElement>(null)

    useImperativeHandle(ref, () => ({
      fill(t) {
        setText(t)
        // rAF: let the textarea reflect the new value before we focus + drop the caret at end.
        requestAnimationFrame(() => {
          const el = taRef.current
          if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
        })
      },
    }), [])

    function submit() {
      const t = text.trim()
      if (!t || busy) return
      onSend(t)
      setText('')
    }

    return (
      <div className="composer">
        <textarea
          ref={taRef}
          value={text}
          placeholder="描述你的订票需求，或回复选项号…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button onClick={submit} disabled={busy || !text.trim()}>
          {busy ? '…' : '发送'}
        </button>
      </div>
    )
  },
)
