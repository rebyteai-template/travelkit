/**
 * Unit test for the self-heal detector — decides whether a turn's chat answer
 * actually landed in the store (else the content route backfills from the relay).
 *
 * Run: node --import tsx --test server/frame-text.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAssistantTextFrame, framesHaveAnswerText, resultFrameText, unrenderedResultTexts } from './frame-text.ts'

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
  assert.equal(framesHaveAnswerText(truncated), false)
  // After backfill, the recovered text frame makes it whole.
  assert.equal(framesHaveAnswerText([...truncated, { seq: 4, data: assistantText('以下是验价结果…') }]), true)
})

test('THE ACK CASE (task 77904658): opening ack then delegation, tail lost → reads as no answer', () => {
  // The finalize race dropped everything after the tool_use. The old any-text-anywhere
  // check saw the ack and called the turn whole — refresh could never recover it.
  const lost = [
    { seq: 1, data: { __rebyte_run: 'r' } },
    { seq: 2, data: assistantText('好的，这是机票搜索请求，我马上委派沙箱里的 Claude Code 来处理。') },
    { seq: 3, data: toolUse },
  ]
  assert.equal(framesHaveAnswerText(lost), false)
  // Backfilled answer after the tool_use → whole (and future loads no-op).
  assert.equal(framesHaveAnswerText([...lost, { seq: 4, data: assistantText('以下是3人出行的汇总……') }]), true)
})

test('a trailing tool_result after the answer does not un-answer the turn (late sub-session replay)', () => {
  const frames = [
    { seq: 1, data: toolUse },
    { seq: 2, data: toolResult },
    { seq: 3, data: assistantText('汇总如下……') },
    { seq: 4, data: toolResult }, // catchUpSubPrompts can append after the manager text
  ]
  assert.equal(framesHaveAnswerText(frames), true)
})

test('a turn with no tool calls just needs any text', () => {
  assert.equal(framesHaveAnswerText([{ seq: 1, data: assistantText('您好！请提供出行日期…') }]), true)
  assert.equal(framesHaveAnswerText([{ seq: 1, data: { __rebyte_run: 'r' } }]), false)
  assert.equal(framesHaveAnswerText([]), false)
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
  // Only the ack landed before the tool_use → correctly reads as answer-missing now
  // (the old any-text-anywhere guard said true here and relied on case 1 alone).
  assert.equal(framesHaveAnswerText(frames), false)
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
