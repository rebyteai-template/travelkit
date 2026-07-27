/**
 * Real captured prompts → exactly one structured recommendation table.
 *
 * Fixtures here are verbatim D1 exports (scripts/export-frame-fixture.mjs), because the
 * executor's transport shapes are discovered rather than designed: a hand-written envelope
 * can only re-confirm a shape we already handle. Every fixture is replayed the way the app
 * actually receives it — all at once, frame by frame, duplicated, reordered by recovery,
 * and interleaved with unrelated tool traffic — since the invariant must not depend on
 * arrival order.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { derive } from '../src/frames.ts'
import type { PromptContent } from '../src/api.ts'

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/domain-results')

interface Fixture {
  source: string
  expect: { plans: number; recommendationBubbles: number; markdownTables: number }
  prompt: PromptContent
}

/** The agent's own table — the fallback that must never stand in for the real result. */
function hasMarkdownTable(text: string): boolean {
  const lines = text.split('\n')
  return lines.some((line, i) => /^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? ''))
}

function assertRendered(label: string, prompt: PromptContent, expect: Fixture['expect']): void {
  const view = derive([prompt])
  const bubbles = view.chat.filter((b) => b.recommendations)
  assert.equal(bubbles.length, expect.recommendationBubbles, `${label}: recommendation bubbles`)
  assert.equal(bubbles[0]?.recommendations?.plans.length, expect.plans, `${label}: plans`)
  assert.equal(view.chat.filter((b) => hasMarkdownTable(b.text)).length, expect.markdownTables, `${label}: markdown tables`)
}

const isTextFrame = (data: unknown): boolean => {
  const content = (data as { message?: { content?: unknown } })?.message?.content
  if (!Array.isArray(content)) return false
  return content.some((b) => (b as { type?: string })?.type === 'text')
}

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const { source, expect, prompt } = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Fixture
  const frames = prompt.frames
  const tail = Math.max(...frames.map((f) => f.seq))
  const reseq = (list: typeof frames, from: number) => list.map((f, i) => ({ ...f, seq: from + i }))

  test(`${file}: one structured table, no markdown fallback (${source})`, () => {
    assertRendered('full load', prompt, expect)

    // Live SSE: the table may appear late, but once it exists no later frame may drop it,
    // and no prefix may ever render two.
    let seen = false
    for (let n = 1; n <= frames.length; n++) {
      const view = derive([{ ...prompt, status: n === frames.length ? prompt.status : 'running', frames: frames.slice(0, n) }])
      const bubbles = view.chat.filter((b) => b.recommendations)
      assert.ok(bubbles.length <= 1, `prefix ${n}: ${bubbles.length} recommendation bubbles`)
      if (bubbles.length) seen = true
      else assert.equal(seen, false, `prefix ${n}: structured table disappeared`)
    }
    assert.equal(seen, true, 'streaming never produced the table')

    // replaySubPrompt is cursor-driven and best-effort, so the same delegated events can
    // land twice; identical results de-duplicate rather than read as a second answer.
    assertRendered('duplicated replay', { ...prompt, frames: [...frames, ...reseq(frames, tail + 1)] }, expect)

    // GET /content runs recoverPrompt(), which appends recovered delegated frames AFTER
    // the manager's final text — the reload ordering, not the live one.
    assertRendered('tools recovered after final text', {
      ...prompt,
      frames: [...frames.filter((f) => isTextFrame(f.data)), ...reseq(frames.filter((f) => !isTextFrame(f.data)), tail + 1)],
    }, expect)

    // Unrelated tool traffic between every original frame must not shift the result.
    assertRendered('unrelated frames interleaved', {
      ...prompt,
      frames: frames.flatMap((f, i) => [f, {
        seq: tail + 1 + i,
        data: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `noise-${i}`, content: 'ok' }] } },
      }]),
    }, expect)
  })
}
