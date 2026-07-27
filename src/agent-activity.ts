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

export interface AgentActivityEvent {
  id: string
  seq: number
  kind: AgentActivityKind
  state: AgentActivityState
  phase?: AgentActivityPhase
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

function flightPhase(command: unknown): AgentActivityPhase | undefined {
  if (typeof command !== 'string') return undefined
  const phase = command.match(/flight\.(?:ts|js)["']?\s+(search|pricing|verify|recommend)\b/i)?.[1]
  if (phase === 'search') return 'searching'
  if (phase === 'pricing') return 'comparing'
  if (phase === 'verify') return 'verifying'
  if (phase === 'recommend') return 'recommending'
  return undefined
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

function activityPhase(call: ToolCall): AgentActivityPhase | undefined {
  if (call.name.startsWith('coding_agent__')) return 'understanding'
  if (call.name === 'Skill') return 'connecting'
  if (call.name === 'Bash') return flightPhase(call.input.command)
  return undefined
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
    .map((call) => ({
      id: `activity-${prompt.id}-${call.id}`,
      seq: call.seq,
      kind: activityKind(call.name),
      state: callState(prompt, call),
      ...(activityPhase(call) ? { phase: activityPhase(call) } : {}),
    }))
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
  return {
    id: `activity-run-${prompt.id}`,
    firstSeq: events[0]!.seq,
    state,
    phase: [...events].reverse().find((event) => event.phase)?.phase ?? 'understanding',
    startedAt: prompt.created_at,
    completedAt: prompt.completed_at,
  }
}
