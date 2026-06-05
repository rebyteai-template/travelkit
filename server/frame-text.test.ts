/**
 * Unit test for the self-heal detector — decides whether a turn's chat answer
 * actually landed in the store (else the content route backfills from the relay).
 *
 * Run: node --import tsx --test server/frame-text.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAssistantTextFrame, framesHaveAssistantText, resultFrameText, unrenderedResultTexts } from './frame-text.ts'

const assistantText = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const resultFrame = (text: string) => ({ __relay: 'result', payload: { result: text } })
const toolUse = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'flight_search', input: {} }] } }
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '...' }] } }

test('detects a real assistant text frame', () => {
  assert.equal(isAssistantTextFrame(assistantText('验价通过，含税 ¥530')), true)
})

test('tool_use / tool_result / meta frames are NOT chat text', () => {
  assert.equal(isAssistantTextFrame(toolUse), false)
  assert.equal(isAssistantTextFrame(toolResult), false)
  assert.equal(isAssistantTextFrame({ __rebyte_run: 'abc' }), false)
  assert.equal(isAssistantTextFrame({ __error: 'boom' }), false)
})

test('empty / whitespace-only text does not count as an answer', () => {
  assert.equal(isAssistantTextFrame(assistantText('')), false)
  assert.equal(isAssistantTextFrame(assistantText('   \n ')), false)
})

test('malformed frames never throw, just return false', () => {
  for (const bad of [null, undefined, 42, 'str', {}, { type: 'assistant' }, { type: 'assistant', message: {} }, { type: 'assistant', message: { content: 'nope' } }]) {
    assert.equal(isAssistantTextFrame(bad), false)
  }
})

test('THE TRUNCATION CASE: a finalized turn with only delegation frames reads as empty → triggers self-heal', () => {
  // What the store held for the stuck "2nd message": delegation + tool_result, no text.
  const truncated = [{ seq: 1, data: { __rebyte_run: 'r' } }, { seq: 2, data: toolUse }, { seq: 3, data: toolResult }]
  assert.equal(framesHaveAssistantText(truncated), false)
  // After backfill, the recovered text frame makes it whole.
  assert.equal(framesHaveAssistantText([...truncated, { seq: 4, data: assistantText('以下是验价结果…') }]), true)
})

test('resultFrameText extracts the agent text from a __relay:result frame', () => {
  assert.equal(resultFrameText(resultFrame('验价通过！')), '验价通过！')
  assert.equal(resultFrameText(assistantText('hi')), null)
  assert.equal(resultFrameText({ __relay: 'result', payload: { result: '   ' } }), null)
  assert.equal(resultFrameText({ __relay: 'thinking', payload: { result: 'x' } }), null)
})

test('THE CZ8882 CASE: answer present on result channel but unrendered → self-heal renders it', () => {
  // Exactly the stuck verify turn: early ack as text, then the real answer arrives only
  // on the result channel (echoed ack ×2, then the verify table) — never as a text frame.
  const ack = '好的，您选择了 CZ8882…我来为您实时验价，请稍候...'
  const table = '验价通过！价格与搜索时完全一致……（表格）'
  const frames = [
    { seq: 1, data: { __rebyte_run: 'r' } },
    { seq: 2, data: assistantText(ack) },
    { seq: 3, data: toolUse },
    { seq: 4, data: resultFrame(ack) }, // echo of the ack
    { seq: 5, data: resultFrame(ack) }, // echo again
    { seq: 6, data: resultFrame(table) }, // the real answer — unrendered
  ]
  // It HAS assistant text (the ack), so the old guard skipped it — but the answer is missing.
  assert.equal(framesHaveAssistantText(frames), true)
  // The detector finds exactly the table (ack echoes deduped against the rendered ack).
  assert.deepEqual(unrenderedResultTexts(frames), [table])
  // After backfilling it, nothing is left pending (idempotent on the next load).
  const healed = [...frames, { seq: 7, data: assistantText(table) }]
  assert.deepEqual(unrenderedResultTexts(healed), [])
})

test('a complete turn (answer already rendered as text) has no pending result texts', () => {
  const ans = '以下是航班选项……'
  const frames = [
    { seq: 1, data: assistantText(ans) },
    { seq: 2, data: resultFrame(ans) }, // result echoes the same answer → already rendered
  ]
  assert.deepEqual(unrenderedResultTexts(frames), [])
})
