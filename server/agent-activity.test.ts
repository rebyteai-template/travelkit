import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  deriveAgentActivityRun,
  deriveAgentActivities,
  type AgentActivityRun,
} from '../src/agent-activity.ts'
import type { PromptContent } from '../src/api.ts'
import { AgentStatus } from '../src/components/AgentStatus.tsx'
import { derive } from '../src/frames.ts'

function prompt(
  frames: PromptContent['frames'],
  status = 'running',
): PromptContent {
  return {
    id: 'prompt-1',
    prompt: '查航班',
    status,
    created_at: '2026-07-27 10:00:00',
    completed_at: status === 'completed' ? '2026-07-27 10:01:00' : null,
    attachments: [],
    frames,
  }
}

function toolUse(seq: number, id: string, name: string, input: Record<string, unknown>) {
  return {
    seq,
    data: {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id, name, input }],
      },
    },
  }
}

function toolResult(seq: number, id: string, content = '完成', isError = false) {
  return {
    seq,
    data: {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
      },
    },
  }
}

test('derives one chronological event per tool call and updates it from its result', () => {
  const activities = deriveAgentActivities(prompt([
    { seq: 1, data: { __rebyte_run: 'run-123' } },
    toolUse(2, 'delegate-1', 'coding_agent__run_claude_code_in_sandbox', {}),
    toolUse(3, 'skill-1', 'Skill', { skill: 'simplifly-flyai-skill' }),
    toolResult(4, 'skill-1'),
    toolUse(5, 'read-1', 'Read', { file_path: '/home/user/recommend.md' }),
    toolResult(6, 'read-1', '第一行\n第二行\n第三行'),
    toolUse(7, 'bash-1', 'Bash', { command: 'node /code/flight.ts recommend --input /code/query.json' }),
  ]))

  assert.deepEqual(
    activities.map((activity) => [activity.kind, activity.phase, activity.state]),
    [
      ['delegate', 'understanding', 'active'],
      ['skill', 'connecting', 'success'],
      ['read', undefined, 'success'],
      ['bash', 'recommending', 'active'],
    ],
  )
})

test('deduplicates replayed tool_use ids and marks only the failed call as error', () => {
  const activities = deriveAgentActivities(prompt([
    toolUse(1, 'bash-1', 'Bash', { command: 'node flight.ts search' }),
    toolUse(2, 'bash-1', 'Bash', { command: 'node flight.ts search' }),
    toolResult(3, 'bash-1', 'query failed\nExit Code: 2', true),
  ], 'completed'))

  assert.equal(activities.length, 1)
  assert.equal(activities[0]?.state, 'error')
  assert.equal(activities[0]?.phase, 'searching')
})

test('shows unknown tools safely but does not duplicate ask_user_question', () => {
  const activities = deriveAgentActivities(prompt([
    toolUse(1, 'unknown-1', 'custom_internal_tool', { token: 'SECRET_TOKEN' }),
    toolResult(2, 'unknown-1', 'ok'),
    toolUse(3, 'ask-1', 'ask_user_question__ask_user_question', { question: 'where?' }),
  ]))

  assert.equal(activities.length, 1)
  assert.equal(activities[0]?.kind, 'tool')
  assert.equal(activities[0]?.phase, undefined)
})

test('never exposes tool inputs, outputs, credentials, or sandbox paths to the UI', () => {
  const activities = deriveAgentActivities(prompt([
    toolUse(1, 'write-1', 'Write', {
      file_path: '/home/user/query.json',
      content: 'Authorization: Bearer SECRET_VALUE\ntoken=SECRET_TOKEN\n/code/private/query.json',
    }),
    toolResult(2, 'write-1', 'saved /home/user/query.json'),
    toolUse(3, 'bash-1', 'Bash', {
      command: 'FLYAI_API_TOKEN=SECRET_TOKEN node /code/flight.ts recommend',
    }),
    toolResult(4, 'bash-1', 'access_token=SECRET_ACCESS'),
  ], 'completed'))

  const serialized = JSON.stringify(activities)
  assert.doesNotMatch(serialized, /SECRET_VALUE|SECRET_TOKEN|SECRET_ACCESS|\/home\/user|\/code\//)
})

test('completed activity renders one factual, non-expandable receipt', () => {
  const run: AgentActivityRun = {
    id: 'activity-run-1',
    firstSeq: 1,
    state: 'success',
    phase: 'recommending',
    startedAt: '2026-07-27 10:00:00',
    completedAt: '2026-07-27 10:01:00',
    candidateCount: 42,
    verifiedCount: 2,
  }
  const html = renderToStaticMarkup(createElement(AgentStatus, { run }))

  assert.match(html, /已比较 42 个航班 · 核验 2 个方案 · 用时 1m/)
  assert.doesNotMatch(html, /button|aria-expanded|读取文件|View|Tool Call|Response/)
})

test('active activity shows one semantic business status instead of tool labels', () => {
  const run = deriveAgentActivityRun(prompt([
    toolUse(1, 'skill-1', 'Skill', { skill: 'simplifly-flyai-skill' }),
    toolResult(2, 'skill-1'),
    toolUse(3, 'bash-1', 'Bash', { command: 'SECRET=hidden node /code/flight.ts search' }),
  ]))
  assert.ok(run)

  const html = renderToStaticMarkup(createElement(AgentStatus, { run }))
  assert.match(html, /正在搜索符合条件的航班/)
  assert.doesNotMatch(html, /Skill|Bash|读取|SECRET|\/code|flight\.ts/)
})

test('waiting activity yields completely to the question UI', () => {
  const run = deriveAgentActivityRun(prompt([
    toolUse(1, 'skill-1', 'Skill', { skill: 'simplifly-flyai-skill' }),
    toolResult(2, 'skill-1'),
  ], 'waiting_for_answer'))
  assert.ok(run)

  const html = renderToStaticMarkup(createElement(AgentStatus, { run }))
  assert.equal(html, '')
})

test('a real search envelope advances live status with its factual candidate count', () => {
  const searchResult = {
    resultType: 'flight.search',
    schemaVersion: 'flight-search/v1',
    displayOptions: [{
      optionNumber: 1,
      journeyType: '直飞',
      duration: '2h20m',
      durationMinutes: 140,
      cabin: '经济舱',
      hasCheckedBaggage: true,
      price: { amount: 1000, currency: 'CNY' },
      journeys: [{
        role: 'oneway',
        origin: 'PEK',
        destination: 'SHA',
        departureDate: '2026-08-05',
        departureTime: '07:45',
        arrivalDate: '2026-08-05',
        arrivalTime: '10:05',
        duration: '2h20m',
        transferCount: 0,
        segments: [{
          flightNo: 'CA100',
          departure: 'PEK',
          departureDate: '2026-08-05',
          departureTime: '07:45',
          arrival: 'SHA',
          arrivalDate: '2026-08-05',
          arrivalTime: '10:05',
          cabin: '经济舱',
        }],
      }],
    }],
    displayMapping: { 1: {} },
    summary: { afterFilters: 42 },
  }
  const view = derive([
    prompt([
      toolUse(1, 'bash-1', 'Bash', { command: 'node flight.ts search' }),
      toolResult(2, 'bash-1', JSON.stringify(searchResult)),
    ]),
  ])
  const run = view.chat.find((bubble) => bubble.activity)?.activity
  assert.ok(run)
  assert.equal(run.phase, 'comparing')
  assert.equal(run.candidateCount, 42)

  const html = renderToStaticMarkup(createElement(AgentStatus, { run }))
  assert.match(html, /已找到 42 个候选，正在比较价格和时间/)
})

test('Skill documentation that mentions result schemas never becomes a business result', () => {
  const docs = [
    '# FlyAI Skill',
    'Return an object with "resultType": "flight.recommendations".',
    '{"schemaVersion":"flight-recommendations/v1","resultType":"flight.recommendations"}',
    'The search response also includes "displayOptions" and "displayMapping".',
  ].join('\n')
  const view = derive([
    prompt([
      toolUse(1, 'read-1', 'Read', { file_path: '/home/user/recommend.md' }),
      toolResult(2, 'read-1', docs),
    ], 'completed'),
  ])

  assert.equal(view.recommendations, null)
  assert.equal(view.search, null)
  assert.equal(view.stage, 'idle')
  assert.equal(view.chat.filter((bubble) => bubble.activity).length, 1)
})

test('Read and failed tool results cannot publish a business envelope', () => {
  const recommendation = JSON.stringify({
    resultType: 'flight.recommendations',
    schemaVersion: 'flight-recommendations/v1',
    status: 'fatal_error',
    coverageStatus: 'failed',
    budgetStatus: 'within_budget',
    plans: [],
    capabilities: { canRetry: true, canReverify: false, canCopy: false },
  })
  const view = derive([
    prompt([
      toolUse(1, 'read-json', 'Read', { file_path: '/code/example.json' }),
      toolUse(2, 'failed-bash', 'Bash', { command: 'node flight.ts recommend' }),
      toolResult(3, 'read-json', recommendation),
      {
        seq: 4,
        data: {
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'failed-bash',
              is_error: true,
              content: recommendation,
            }],
          },
        },
      },
    ], 'completed'),
  ])

  assert.equal(view.recommendations, null)
  assert.equal(view.chat.filter((bubble) => bubble.activity).length, 1)
})

test('a real leading recommendation envelope still renders after a Skill doc event', () => {
  const result = {
    schemaVersion: 'flight-recommendations/v1',
    resultType: 'flight.recommendations',
    status: 'empty',
    coverageStatus: 'complete',
    budgetStatus: 'within_budget',
    message: '没有召回可用报价。',
    plans: [],
    diagnostics: {},
    capabilities: { canRetry: true, canReverify: false, canCopy: false },
  }
  const view = derive([
    prompt([
      toolUse(1, 'read-1', 'Read', { file_path: '/home/user/recommend.md' }),
      toolResult(2, 'read-1', '# docs mention flight.recommendations'),
      toolUse(3, 'bash-1', 'Bash', { command: 'node flight.ts recommend' }),
      toolResult(4, 'bash-1', `${JSON.stringify(result)}\nShell cwd was reset`),
    ], 'completed'),
  ])

  assert.equal(view.recommendations?.status, 'empty')
  assert.equal(view.recommendations?.message, '没有召回可用报价。')
  assert.equal(view.chat.filter((bubble) => bubble.activity).length, 1)
  assert.equal(view.chat.filter((bubble) => bubble.recommendations).length, 1)
})
