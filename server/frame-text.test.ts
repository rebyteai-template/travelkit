/**
 * Unit test for the self-heal detector — decides whether a turn's chat answer
 * actually landed in the store (else the content route backfills from the relay).
 *
 * Run: node --import tsx --test server/frame-text.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAssistantTextFrame, framesHaveAssistantText } from './frame-text.ts'

const assistantText = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
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
