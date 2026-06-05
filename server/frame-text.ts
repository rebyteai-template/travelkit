/**
 * Did a turn's chat answer actually land in storage? The UI reads frames from the
 * store (GET /content); a turn that finalized before its trailing text reached the
 * store shows as completed-but-empty. These pure predicates detect that case so the
 * content route can self-heal it. Shape mirrors TaskDO.emitText:
 *   { type:'assistant', message:{ content:[{ type:'text', text }] } }
 */
import type { Frame } from './store.ts'

/** True if `data` is an assistant frame carrying non-empty text. */
export function isAssistantTextFrame(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const message = (data as { type?: unknown; message?: unknown }).type === 'assistant'
    ? (data as { message?: unknown }).message
    : undefined
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return false
  return content.some(
    (c) =>
      !!c && typeof c === 'object' &&
      (c as { type?: unknown }).type === 'text' &&
      typeof (c as { text?: unknown }).text === 'string' &&
      (c as { text: string }).text.trim() !== '',
  )
}

/** True if any frame in the turn is a non-empty assistant text frame. */
export function framesHaveAssistantText(frames: Frame[]): boolean {
  return frames.some((f) => isAssistantTextFrame(f.data))
}
