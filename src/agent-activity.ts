import type { PromptContent } from './api.ts'

export type AgentActivityState = 'active' | 'success' | 'error'
export type AgentActivityKind = 'delegate' | 'skill' | 'read' | 'write' | 'edit' | 'bash' | 'tool'
export type AgentRunState = 'active' | 'waiting' | 'success' | 'error'
export type AgentActivityPhase =
  | 'understanding'
  | 'connecting'
  | 'searching'
  | 'comparing'
  | 'verifying'
  | 'recommending'
  | 'book-verifying'

export interface AgentActivityEvent {
  id: string
  seq: number
  kind: AgentActivityKind
  state: AgentActivityState
  phase?: AgentActivityPhase
  /** Live counters read off an MCP progress envelope this call returned (see progressSignal). */
  candidateCount?: number
  verifiedCount?: number
  /** The running recommendation's job id, when a progress envelope named one — the handle the
   *  UI's progress side channel polls with. */
  recommendationId?: string
}

export interface AgentActivityRun {
  id: string
  firstSeq: number
  state: AgentRunState
  phase: AgentActivityPhase
  startedAt?: string
  completedAt?: string | null
  candidateCount?: number
  verifiedCount?: number
  /** See AgentActivityEvent.recommendationId — carried up so the panel can poll the side channel. */
  recommendationId?: string
}

interface ToolResult {
  content: string
  isError: boolean
}

interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  seq: number
  result?: ToolResult
}

function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function messageBlocks(data: Record<string, unknown>): unknown[] {
  if (!isObj(data.message)) return []
  return Array.isArray(data.message.content) ? data.message.content : []
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((item) => {
    if (typeof item === 'string') return item
    if (!isObj(item)) return ''
    if (typeof item.text === 'string') return item.text
    if (typeof item.content === 'string') return item.content
    return ''
  }).filter(Boolean).join('\n')
}

function exitCode(content: string): number | undefined {
  const match = content.match(/(?:Exit Code|exit code|退出码)\s*[:=]\s*(-?\d+)/i)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isInteger(value) ? value : undefined
}

function callState(prompt: PromptContent, call: ToolCall): AgentActivityState {
  if (call.result) {
    const code = exitCode(call.result.content)
    return call.result.isError || code !== undefined && code !== 0 ? 'error' : 'success'
  }
  if (prompt.status === 'failed' || prompt.status === 'canceled') return 'error'
  if (prompt.status && prompt.status !== 'running' && prompt.status !== 'waiting_for_answer') return 'error'
  return 'active'
}

// Longest alternatives first: `recommend\b` also matches `recommend-book` /
// `recommend-next` (the boundary holds before `-`), which mislabeled a booking
// re-verification turn as "整理推荐方案".
const FLIGHT_COMMAND_PHASES: Record<string, AgentActivityPhase> = {
  search: 'searching',
  pricing: 'comparing',
  verify: 'verifying',
  recommend: 'recommending',
  'recommend-next': 'recommending',
  'recommend-book': 'book-verifying',
}

function flightPhase(command: unknown): AgentActivityPhase | undefined {
  if (typeof command !== 'string') return undefined
  const phase = command
    .match(/flight\.(?:ts|js)["']?\s+(recommend-book|recommend-next|recommend|search|pricing|verify)\b/i)?.[1]
    ?.toLowerCase()
  return phase ? FLIGHT_COMMAND_PHASES[phase] : undefined
}

function activityKind(name: string): AgentActivityKind {
  if (name.startsWith('coding_agent__')) return 'delegate'
  if (name === 'Skill') return 'skill'
  if (name === 'Read') return 'read'
  if (name === 'Write') return 'write'
  if (name === 'Edit') return 'edit'
  if (name === 'Bash') return 'bash'
  return 'tool'
}

// MCP 路线：flight_* 是 relay 挂载的远程工具（可能带前缀），不再经过 Bash 命令行，
// 所以 flightPhase 的命令匹配在这条路线上永远打不中——没有这张表时状态会一直停在
// 「正在确认行程条件…」。名字给一个基线 phase，进度 envelope（progressSignal）再细化。
const MCP_FLIGHT_PHASES: Array<[RegExp, AgentActivityPhase]> = [
  [/flight_recommendation_get$|flight_recommend$/, 'recommending'],
  [/flight_reverify$/, 'book-verifying'],
]

function activityPhase(call: ToolCall): AgentActivityPhase | undefined {
  if (call.name.startsWith('coding_agent__')) return 'understanding'
  if (call.name === 'Skill') return 'connecting'
  if (call.name === 'Bash') return flightPhase(call.input.command)
  return MCP_FLIGHT_PHASES.find(([pattern]) => pattern.test(call.name))?.[1]
}

/** 推荐生成中的实时信号：MCP 非终态轮询 envelope（flight-recommendation-progress/v1，
 *  由 flight_recommend / flight_recommendation_get 返回）里的阶段与计数。只读明确声明
 *  版本的 envelope；计数字段缺失就不显示，不推断。 */
const PROGRESS_STAGE_PHASES: Record<string, AgentActivityPhase> = {
  queued: 'connecting',
  recall: 'searching',
  compose: 'comparing',
  verify: 'verifying',
  publish: 'recommending',
}

export interface RecommendationProgressSignal {
  phase: AgentActivityPhase
  candidateCount?: number
  verifiedCount?: number
}

/** stage + counters → display signal. Shared by the tool-channel envelope (progressSignal)
 *  and the side-channel snapshot the panel polls (`/tasks/:id/recommendation-progress`),
 *  so the two sources can never disagree on what a stage means. */
export function signalFromProgress(progress: unknown): RecommendationProgressSignal {
  const record = isObj(progress) ? progress : {}
  const stage = typeof record.stage === 'string' ? record.stage : 'queued'
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  return {
    phase: PROGRESS_STAGE_PHASES[stage] ?? 'recommending',
    candidateCount: count(record.feasiblePlans),
    verifiedCount: count(record.verifiedPlans),
  }
}

function progressSignal(content: string): (RecommendationProgressSignal & { recommendationId?: string }) | undefined {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('{')) return undefined
  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isObj(json) || json.schemaVersion !== 'flight-recommendation-progress/v1') return undefined
  return {
    ...signalFromProgress(json.progress),
    ...(typeof json.recommendationId === 'string' && json.recommendationId
      ? { recommendationId: json.recommendationId }
      : {}),
  }
}

/** Convert durable tool frames into customer-safe execution signals. Tool names,
 * inputs, output, file paths, commands and run links never cross this boundary. */
export function deriveAgentActivities(prompt: PromptContent): AgentActivityEvent[] {
  const ordered = [...prompt.frames].sort((a, b) => a.seq - b.seq)
  const results = new Map<string, ToolResult>()
  const calls = new Map<string, ToolCall>()

  for (const frame of ordered) {
    if (!isObj(frame.data)) continue
    for (const block of messageBlocks(frame.data)) {
      if (!isObj(block) || block.type !== 'tool_result') continue
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
      if (!id) continue
      results.set(id, {
        content: contentText(block.content),
        isError: block.is_error === true,
      })
    }
  }

  for (const frame of ordered) {
    if (!isObj(frame.data)) continue
    for (const block of messageBlocks(frame.data)) {
      if (!isObj(block) || block.type !== 'tool_use') continue
      const id = typeof block.id === 'string' ? block.id : ''
      const name = typeof block.name === 'string' ? block.name : ''
      if (!id || !name || calls.has(id) || name.startsWith('ask_user_question')) continue
      calls.set(id, {
        id,
        name,
        input: isObj(block.input) ? block.input : {},
        seq: frame.seq,
        result: results.get(id),
      })
    }
  }

  return [...calls.values()]
    .map((call) => {
      const signal = call.result && !call.result.isError ? progressSignal(call.result.content) : undefined
      return {
        id: `activity-${prompt.id}-${call.id}`,
        seq: call.seq,
        kind: activityKind(call.name),
        state: callState(prompt, call),
        // A progress envelope names the engine's ACTUAL stage; the tool-name phase is only
        // the fallback for calls that returned nothing recognizable (or nothing yet).
        ...(signal?.phase ?? activityPhase(call) ? { phase: signal?.phase ?? activityPhase(call) } : {}),
        ...(signal?.candidateCount !== undefined ? { candidateCount: signal.candidateCount } : {}),
        ...(signal?.verifiedCount !== undefined ? { verifiedCount: signal.verifiedCount } : {}),
        ...(signal?.recommendationId ? { recommendationId: signal.recommendationId } : {}),
      }
    })
    .sort((a, b) => a.seq - b.seq)
}

export function deriveAgentActivityRun(prompt: PromptContent): AgentActivityRun | null {
  const events = deriveAgentActivities(prompt)
  if (!events.length) return null
  const state: AgentRunState =
    prompt.status === 'running' || !prompt.status
      ? 'active'
      : prompt.status === 'waiting_for_answer'
        ? 'waiting'
        : prompt.status === 'failed' || prompt.status === 'canceled'
          ? 'error'
          : 'success'
  const reversed = [...events].reverse()
  const counted = reversed.find((event) => event.candidateCount !== undefined || event.verifiedCount !== undefined)
  const withJob = reversed.find((event) => event.recommendationId)
  return {
    id: `activity-run-${prompt.id}`,
    firstSeq: events[0]!.seq,
    state,
    phase: reversed.find((event) => event.phase)?.phase ?? 'understanding',
    startedAt: prompt.created_at,
    completedAt: prompt.completed_at,
    ...(counted?.candidateCount !== undefined ? { candidateCount: counted.candidateCount } : {}),
    ...(counted?.verifiedCount !== undefined ? { verifiedCount: counted.verifiedCount } : {}),
    ...(withJob?.recommendationId ? { recommendationId: withJob.recommendationId } : {}),
  }
}
