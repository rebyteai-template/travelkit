/**
 * Did a turn's chat answer actually land — and render — in storage? The UI reads
 * frames from the store (GET /content) and only renders assistant *text* frames.
 * A turn can finalize with its answer missing (never persisted) OR present-but-
 * unrendered (persisted on the relay `result` channel as a `__relay:"result"`
 * frame, which the UI ignores). These pure helpers detect both so the content
 * route can self-heal. Assistant text shape mirrors TaskDO.emitText:
 *   { type:'assistant', message:{ content:[{ type:'text', text }] } }
 */
import type { Frame } from './store.ts'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
/** Whitespace-stripped, for order/format-insensitive containment dedup. */
export const normText = (s: string): string => s.replace(/\s+/g, '')

/** The text of an assistant text frame (non-empty), else null. */
export function assistantFrameText(data: unknown): string | null {
  if (!isObj(data) || data.type !== 'assistant') return null
  const content = isObj(data.message) ? (data.message as { content?: unknown }).content : undefined
  if (!Array.isArray(content)) return null
  const parts = content
    .filter((c): c is { type: string; text: string } => isObj(c) && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .filter((t) => t.trim() !== '')
  return parts.length ? parts.join('') : null
}

export function isAssistantTextFrame(data: unknown): boolean {
  return assistantFrameText(data) !== null
}

/** True if any frame is a non-empty assistant text frame. */
export function framesHaveAssistantText(frames: Frame[]): boolean {
  return frames.some((f) => isAssistantTextFrame(f.data))
}

/** The agent's text carried by a relay `result` event (stored as `__relay:"result"`).
 *  The final answer arrives on this channel as well as / instead of a `text` event. */
export function resultFrameText(data: unknown): string | null {
  if (!isObj(data) || data.__relay !== 'result') return null
  const p = isObj(data.payload) ? data.payload : {}
  const t = p.result ?? p.content ?? p.text
  return typeof t === 'string' && t.trim() ? t : null
}

/** Final-answer texts stored on the `result` channel but never rendered as an
 *  assistant text frame — i.e. "the answer is in the store but invisible in the UI".
 *  Deduped by whitespace-insensitive containment against what's already rendered. */
export function unrenderedResultTexts(frames: Frame[]): string[] {
  let seen = ''
  for (const f of frames) {
    const t = assistantFrameText(f.data)
    if (t) seen += normText(t)
  }
  const out: string[] = []
  for (const f of frames) {
    const t = resultFrameText(f.data)
    if (t && !seen.includes(normText(t))) {
      out.push(t)
      seen += normText(t)
    }
  }
  return out
}
