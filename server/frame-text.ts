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

/** A stored assistant tool_use frame ({type:'assistant', content:[{type:'tool_use'}]}). */
function isToolUseFrame(data: unknown): boolean {
  if (!isObj(data) || data.type !== 'assistant') return false
  const content = isObj(data.message) ? (data.message as { content?: unknown }).content : undefined
  if (!Array.isArray(content)) return false
  return content.some((c) => isObj(c) && c.type === 'tool_use')
}

/** Did the turn's ANSWER land — assistant text streamed AFTER its last tool_use?
 *  Any-text-anywhere is not enough: a delegated turn opens with an ack ("好的，我马上
 *  委派…"), then the finalize race can drop everything after the tool_use. That ack
 *  made the old check read the turn as whole, so the self-heal never engaged and a
 *  refresh couldn't recover the lost answer (prod 2026-07-12, task 77904658). A
 *  tool_RESULT after the answer does not un-answer it (late sub-session replays
 *  append trailing tool_results) — only a new tool_use does. */
export function framesHaveAnswerText(frames: Frame[]): boolean {
  let sawAnswer = false
  for (const f of frames) {
    if (isToolUseFrame(f.data)) sawAnswer = false
    else if (isAssistantTextFrame(f.data)) sawAnswer = true
  }
  return sawAnswer
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
