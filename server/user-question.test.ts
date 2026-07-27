import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { derive } from '../src/frames.ts'
import { UserQuestion } from '../src/components/UserQuestion.tsx'
import {
  answerSummary,
  isUserQuestionAnswer,
  parseUserQuestionRequest,
} from '../src/user-question.ts'
import type { PromptContent } from '../src/api.ts'

const relayQuestion = {
  actionId: '21026',
  messageId: 'am_1',
  question: '你指的是哪个圣地亚哥？',
  options: [
    { label: '智利圣地亚哥 (SCL)', description: '南美洲智利首都' },
    { label: '美国圣地亚哥 (SAN)', description: '美国加州圣地亚哥' },
  ],
  multiSelect: false,
}

test('normalizes a public ask event and keeps its resume ids', () => {
  const parsed = parseUserQuestionRequest(relayQuestion)
  assert.ok(parsed)
  assert.equal(parsed.actionId, '21026')
  assert.equal(parsed.messageId, 'am_1')
  assert.equal(parsed.questions.length, 1)
  assert.equal(parsed.questions[0]?.options[0]?.label, '智利圣地亚哥 (SCL)')
})

test('supports batched questions and rejects malformed parking events', () => {
  const parsed = parseUserQuestionRequest({
    ...relayQuestion,
    question: '出发前需要确认',
    questions: [
      relayQuestion,
      { question: '舱位？', options: [{ label: '经济舱' }, { label: '商务舱' }] },
    ],
  })
  assert.equal(parsed?.questions.length, 2)
  assert.equal(parseUserQuestionRequest({ ...relayQuestion, messageId: '' }), null)
})

test('validates and summarizes the answer shape sent to relay /answer', () => {
  const parsed = parseUserQuestionRequest(relayQuestion)
  assert.ok(parsed)
  const answer = { selectedOptions: [0], customResponse: '' }
  assert.equal(isUserQuestionAnswer(answer), true)
  assert.deepEqual(answerSummary(parsed, answer), ['智利圣地亚哥 (SCL)'])
  assert.equal(isUserQuestionAnswer({ selectedOptions: ['0'] }), false)
})

test('derive renders one pending question and marks the same item answered in-place', () => {
  const prompt: PromptContent = {
    id: 'prompt_1',
    prompt: '后天北京到圣地亚哥的航班',
    status: 'running',
    created_at: '2026-07-22T07:16:56.000Z',
    frames: [
      { seq: 1, data: { __ask_user_question: relayQuestion } },
    ],
  }

  const waiting = derive([prompt])
  assert.equal(waiting.pendingQuestion?.promptId, 'prompt_1')
  assert.equal(waiting.pendingQuestion?.question?.messageId, 'am_1')
  assert.equal(waiting.pendingQuestion?.questionAnswer, undefined)

  prompt.frames.push({
    seq: 2,
    data: {
      __ask_user_answer: {
        actionId: '21026',
        messageId: 'am_1',
        answer: { selectedOptions: [0] },
      },
    },
  })
  const resumed = derive([prompt])
  assert.equal(resumed.pendingQuestion, null)
  assert.deepEqual(resumed.chat.find((bubble) => bubble.question)?.questionAnswer, {
    selectedOptions: [0],
  })
})

test('question UI exposes the choices and turns an accepted answer into a compact receipt', () => {
  const request = parseUserQuestionRequest(relayQuestion)
  assert.ok(request)
  const waitingHtml = renderToStaticMarkup(
    createElement(UserQuestion, {
      promptId: 'prompt_1',
      request,
      onAnswer: async () => undefined,
    }),
  )
  assert.match(waitingHtml, /你指的是哪个圣地亚哥？/)
  assert.match(waitingHtml, /智利圣地亚哥 \(SCL\)/)
  assert.match(waitingHtml, /type="radio"/)
  assert.match(waitingHtml, /提交回答/)

  const answeredHtml = renderToStaticMarkup(
    createElement(UserQuestion, {
      promptId: 'prompt_1',
      request,
      answered: { selectedOptions: [0] },
      onAnswer: async () => undefined,
    }),
  )
  assert.match(answeredHtml, /已回答/)
  assert.match(answeredHtml, /智利圣地亚哥 \(SCL\)/)
  assert.doesNotMatch(answeredHtml, /提交回答/)
})
