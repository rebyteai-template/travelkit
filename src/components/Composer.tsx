import { forwardRef, useImperativeHandle, useRef, useState, type DragEvent } from 'react'
import { uploadFile, type AttachmentMeta, type FileRef } from '../api.ts'
import { makeRenditions } from '../lib/thumbnail.ts'
import { MAX_UPLOAD_BYTES } from '../../server/attachments.ts'
import { FileCard } from './FileCard.tsx'

const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))

/** Imperative handle App holds so suggestion chips (in ChatPanel) can drop text in. */
export interface ComposerHandle {
  /** Fill the textarea with `text`, focus it, and park the caret at the end. */
  fill: (text: string) => void
}

/** One attachment in the composer: an instant blob preview, uploaded eagerly; its `ref` rides on send. */
interface Attach {
  id: string
  file: File
  previewUrl: string
  status: 'uploading' | 'ready' | 'error'
  ref?: FileRef
  /** Why it failed (e.g. over the size cap) — shown as the error badge's tooltip. */
  reason?: string
}

const PaperclipIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
)
const SendIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
)

/** Composer: one rounded shell holding a borderless auto-growing textarea, a quiet attach button,
 *  and a send button. Enter sends, Shift+Enter newlines. Image/file attachments via 📎, paste, or
 *  drag-drop upload IMMEDIATELY (preview + loading; send is gated until uploads finish) and ride on
 *  the next turn (staged into /code + shown as a bubble thumbnail). Draft state lives here (not in
 *  App) so typing only re-renders the composer; App pokes text in via the `fill` handle for chips. */
export const Composer = forwardRef<ComposerHandle, { onSend: (text: string, atts?: AttachmentMeta[]) => void; busy: boolean }>(
  function Composer({ onSend, busy }, ref) {
    const [text, setText] = useState('')
    const [atts, setAtts] = useState<Attach[]>([])
    const [dragging, setDragging] = useState(false)
    const fileInput = useRef<HTMLInputElement>(null)
    const taRef = useRef<HTMLTextAreaElement>(null)

    const uploading = atts.some((a) => a.status === 'uploading')
    const canSend = !busy && !uploading && (text.trim().length > 0 || atts.some((a) => a.status === 'ready'))

    // Grow the textarea with its content up to a cap, then it scrolls.
    const grow = () => {
      const el = taRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`
    }

    useImperativeHandle(ref, () => ({
      fill(t) {
        setText(t)
        // rAF: let the textarea reflect the new value before we focus + drop the caret at end + grow.
        requestAnimationFrame(() => {
          const el = taRef.current
          if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); grow() }
        })
      },
    }), [])

    function addFiles(list: FileList | File[] | null) {
      for (const file of list ? Array.from(list) : []) {
        const id = crypto.randomUUID()
        // Only images get a blob preview URL; non-image files render as a FileCard (no preview).
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : ''
        // Reject oversize before touching the wire — the server enforces the same cap (413), so this
        // is just the fast, friendly half. The chip lands in 'error' with the reason and never uploads.
        if (file.size > MAX_UPLOAD_BYTES) {
          setAtts((prev) => [...prev, { id, file, previewUrl, status: 'error', reason: `文件超过 ${MAX_UPLOAD_MB}MB 上限` }])
          continue
        }
        setAtts((prev) => [...prev, { id, file, previewUrl, status: 'uploading' }])
        // Eager upload: build WebP renditions (images only) then upload; the ref rides on send.
        void (async () => {
          try {
            const fref = await uploadFile(file, await makeRenditions(file))
            setAtts((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'ready', ref: fref } : a)))
          } catch (e) {
            console.error('attachment upload failed', e)
            setAtts((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'error' } : a)))
          }
        })()
      }
    }
    function removeAtt(id: string) {
      setAtts((prev) => {
        const a = prev.find((x) => x.id === id)
        if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl)
        return prev.filter((x) => x.id !== id)
      })
    }
    function submit() {
      if (!canSend) return
      const ready = atts.filter((a) => a.status === 'ready' && a.ref)
      onSend(
        text.trim(),
        ready.length ? ready.map((a) => ({ fileId: a.ref!.id, filename: a.ref!.filename, contentType: a.file.type })) : undefined,
      )
      atts.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl))
      setText('')
      setAtts([])
      if (taRef.current) taRef.current.style.height = 'auto'
    }

    // Drag-drop attachments onto the composer. preventDefault on dragover is REQUIRED to make this a
    // valid drop target — without it the browser navigates away to open the dropped file. Files only.
    const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files')
    function onDragOver(e: DragEvent<HTMLDivElement>) {
      if (busy || !isFileDrag(e)) return
      e.preventDefault()
      if (!dragging) setDragging(true)
    }
    function onDragLeave(e: DragEvent<HTMLDivElement>) {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return // ignore child-crossing
      setDragging(false)
    }
    function onDrop(e: DragEvent<HTMLDivElement>) {
      if (busy || !isFileDrag(e)) return
      e.preventDefault()
      setDragging(false)
      addFiles(e.dataTransfer.files)
    }

    return (
      <div
        className={dragging ? 'composer dragging' : 'composer'}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="composer-shell">
          {atts.length > 0 && (
            <div className="composer-attachments">
              {atts.map((a) =>
                a.file.type.startsWith('image/') ? (
                  <span key={a.id} className={`attachment-card ${a.status}`} title={a.file.name}>
                    <img className="attachment-preview" src={a.previewUrl} alt={a.file.name} />
                    {a.status === 'uploading' && <span className="attachment-spinner" aria-label="上传中…" />}
                    {a.status === 'error' && <span className="attachment-badge" title={a.reason ?? '上传失败'}>!</span>}
                    <button className="attachment-remove" onClick={() => removeAtt(a.id)} aria-label="移除附件">×</button>
                  </span>
                ) : (
                  <span key={a.id} className="attachment-card">
                    <FileCard
                      filename={a.file.name}
                      contentType={a.file.type}
                      status={a.status === 'ready' ? undefined : a.status}
                      reason={a.reason}
                    />
                    <button className="attachment-remove" onClick={() => removeAtt(a.id)} aria-label="移除附件">×</button>
                  </span>
                ),
              )}
            </div>
          )}
          <div className="composer-row">
            <button
              className="icon-btn attach-btn"
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              title="添加图片/文件"
              aria-label="添加附件"
            >
              <PaperclipIcon />
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = '' // allow re-selecting the same file
              }}
            />
            <textarea
              ref={taRef}
              value={text}
              rows={1}
              placeholder="描述你的订票需求，或回复选项号…"
              onChange={(e) => {
                setText(e.target.value)
                grow()
              }}
              onPaste={(e) => {
                const pasted = Array.from(e.clipboardData.files)
                if (pasted.length) {
                  e.preventDefault()
                  addFiles(pasted)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  // An IME Enter confirms the composition (pinyin candidate), not the message.
                  // Chrome/Firefox fire it with isComposing=true; Safari fires it AFTER
                  // compositionend (isComposing already false) but still with keyCode 229.
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <button className="icon-btn send-btn" type="button" onClick={submit} disabled={!canSend} title="发送" aria-label="发送">
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    )
  },
)
