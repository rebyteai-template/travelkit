/**
 * Sub-session probe: tests the NEW retrieval path end-to-end against prod.
 *
 * Runs one real travelkit search through the agent-loop, captures the parent
 * /events stream, extracts the `subPromptId` the manager's delegation is tagged
 * with, then calls the NEW relay endpoint
 *   GET /v1/tasks/:id/prompts/:subPromptId/events
 * replays that sub-session's travelkit tool_use/tool_result into frames, and
 * feeds parent+sub frames through the REAL src/frames.ts derive().
 *
 * Answers "现在能拿到了么":
 *   - is `subPromptId` present in the parent stream?           (precondition)
 *   - does the new endpoint return the sub-session events?      (needs relay deploy)
 *   - after replay, do the bench cards (search/fare) populate?  (the payoff)
 *
 * Run: node --env-file=.env.local --import tsx server/rebyte/subprobe.ts ["prompt"]
 */
import { writeFileSync } from 'node:fs'
import { ensureDefaultAgentComputer } from './provision.ts'
import { seedTravelkit } from './seed.ts'
import { SKILL_REF, toSkillRef } from '../../worker/skill-ref.ts'
import { rebyteJSON, rebyteFetch } from './client.ts'
import { parseSSE, isObj } from './sse.ts'
import { derive } from '../../src/frames.ts'

const PROMPT = process.argv.slice(2).join(' ')
  || '请使用 travelkit 搜索 2026-06-20 北京到上海的直飞机票，1 名成人，给我看几个选项。'

type Frame = { seq: number; data: unknown }
const frames: Frame[] = []
let seq = 0
const emit = (data: unknown) => { frames.push({ seq: ++seq, data }) }

/** Faithful mirror of worker/task-do.ts translate() for the frame kinds we care about. */
function translate(ev: { eventType?: string; payload?: Record<string, unknown> }): void {
  const type = String(ev.eventType ?? '')
  const p = isObj(ev.payload) ? ev.payload : {}
  switch (type) {
    case 'text': case 'assistant': case 'message': case 'response': {
      const t = String(p.content ?? p.text ?? '')
      if (t.trim()) emit({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })
      return
    }
    case 'tool_use': {
      const name = String(p.name ?? p.tool_name ?? '')
      const id = String(p.id ?? p.tool_id ?? '') || `gen-${seq}`
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: p.input ?? p.params ?? {} }] } })
      return
    }
    case 'tool_result': {
      const id = String(p.id ?? p.tool_id ?? '')
      const content = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '')
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })
      return
    }
    default:
      emit({ __relay: type || 'unknown', payload: p })
  }
}

const subPromptIds = new Set<string>()
const parentToolUseNames: string[] = []

async function main() {
  console.log('[subprobe] 1/5 ensure VM…')
  const ac = await ensureDefaultAgentComputer()
  console.log(`[subprobe]     VM id=${ac.id} sandboxId=${ac.sandboxId}`)

  console.log('[subprobe] 2/5 seed travelkit…')
  const seeded = await seedTravelkit(ac)
  console.log(`[subprobe]     seeded ${seeded.length} files`)

  console.log('[subprobe] 3/5 POST /tasks…')
  const task = await rebyteJSON<{ id: string; url?: string }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({ prompt: PROMPT, workspaceId: ac.id, skills: [toSkillRef(SKILL_REF)] }), // skills → relay installs simplifly-flyai-skill from GitHub
  })
  console.log(`[subprobe]     task=${task.id} ${task.url ?? ''}`)

  console.log('[subprobe] 4/5 stream parent /events, capture subPromptId…')
  let doneStatus = '?'
  const timer = setTimeout(() => { console.error('[subprobe] timeout'); process.exit(2) }, 240_000)
  for (let attempt = 0; attempt < 90; attempt++) {
    const res = await rebyteFetch(`/tasks/${task.id}/events`, { headers: { Accept: 'text/event-stream' } })
    if (!res.ok || !res.body) { console.error('open failed', res.status, await res.text()); process.exit(1) }
    let got = 0
    for await (const msg of parseSSE(res.body)) {
      if (msg.event === 'done') {
        if (got > 0 && isObj(msg.data)) doneStatus = String(msg.data.status ?? '?')
        break
      }
      if (!isObj(msg.data)) continue
      got++
      const ev = msg.data as { seq?: number; eventType?: string; payload?: Record<string, unknown> }
      const t = String(ev.eventType ?? '?')
      const p = isObj(ev.payload) ? ev.payload : {}
      if (typeof p.subPromptId === 'string' && p.subPromptId) subPromptIds.add(p.subPromptId)
      if (t === 'tool_use') parentToolUseNames.push(String(p.name ?? p.tool_name ?? '?'))
      translate(ev)
    }
    if (got > 0) break
    const st = await rebyteJSON<{ status?: string }>(`/tasks/${task.id}`).catch(() => ({ status: '?' }))
    if (['completed', 'failed', 'canceled'].includes(st.status ?? '') && attempt >= 3) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  clearTimeout(timer)

  console.log('\n══════════ 第①步：父任务暴露了 subPromptId 句柄吗？ ══════════')
  console.log(`父 tool_use 工具名: ${JSON.stringify(parentToolUseNames)}`)
  console.log(`捕获到的 subPromptId: ${subPromptIds.size ? [...subPromptIds].join(', ') : '❌ 无（父流里没带 subPromptId）'}`)

  console.log('\n══════════ 第②步：调新端点拉子会话事件 ══════════')
  const subFetch: Array<{ subPromptId: string; httpStatus: number; eventCount: number; toolNames: string[] }> = []
  for (const sid of subPromptIds) {
    const res = await rebyteFetch(`/tasks/${task.id}/prompts/${sid}/events`)
    const httpStatus = res.status
    let eventCount = 0
    const toolNames: string[] = []
    if (res.ok) {
      const body = await res.json().catch(() => null) as { events?: Array<{ eventType?: string; payload?: Record<string, unknown> }> } | null
      const events = body?.events ?? []
      for (const ev of events) {
        const type = String(ev.eventType ?? '')
        if (type !== 'tool_use' && type !== 'tool_result') continue
        eventCount++
        if (type === 'tool_use') {
          const p = isObj(ev.payload) ? ev.payload : {}
          toolNames.push(String(p.name ?? p.tool_name ?? '?'))
        }
        translate(ev) // replay into the SAME frames array
      }
    } else {
      console.log(`   subPromptId=${sid} → HTTP ${httpStatus}（端点未部署或不可达）`)
    }
    subFetch.push({ subPromptId: sid, httpStatus, eventCount, toolNames })
    if (res.ok) console.log(`   subPromptId=${sid} → HTTP 200, ${eventCount} 个 tool 事件, tools=${JSON.stringify(toolNames)}`)
  }

  console.log('\n══════════ 第③步：derive() → bench 能渲染什么 ══════════')
  const view = derive([{ id: 'p1', prompt: PROMPT, frames }])
  console.log(`stage:   ${view.stage}`)
  console.log(`search:  ${view.search ? `✅ ${view.search.options.length} 个航班选项 (totalCount=${view.search.totalCount})` : '❌ null'}`)
  console.log(`fare:    ${view.fare ? `✅ total=${view.fare.total} journeys=${view.fare.journeys.length}` : '❌ null'}`)

  console.log('\n══════════ 结论 ══════════')
  if (!subPromptIds.size) {
    console.log('❌ 父流里没有 subPromptId —— 前置条件不成立，需查 relay 的 synthesizeEvents 是否已上线。')
  } else if (subFetch.every((s) => s.httpStatus !== 200)) {
    console.log('🟡 subPromptId 句柄已就位 ✅，但新端点还没上线（HTTP ≠ 200）——')
    console.log('   现在还拿不到结构化数据；PR #120 合并 + relay 部署后，这个脚本就会变绿。')
  } else if (view.search || view.fare) {
    console.log('✅ 现在能拿到了 —— 子会话结构化 tool_result 经新端点回流，frames.ts 成功渲染卡片。')
  } else {
    console.log('🟠 端点通了（HTTP 200）但 derive() 仍为空 —— 检查子会话事件里 flight_* tool_result 的字段。')
  }

  writeFileSync('/tmp/subprobe.json', JSON.stringify({ prompt: PROMPT, taskId: task.id, doneStatus, parentToolUseNames, subPromptIds: [...subPromptIds], subFetch, frames, view }, null, 2))
  console.log('\n📄 详情写入 /tmp/subprobe.json')
  process.exit(0)
}
main().catch((e) => { console.error('[subprobe] ERROR:', e?.stack || e?.message || e); process.exit(1) })
