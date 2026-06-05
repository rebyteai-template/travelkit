/**
 * Card data-layer probe: run ONE real travelkit search through the rebyte
 * agent-loop, capture every raw relay event, translate them to stream-json
 * frames (mirroring worker/task-do.ts), then feed those frames through the REAL
 * src/frames.ts `derive()` and report whether the bench cards actually populate.
 *
 * Answers, at the interface + data layer (not the UI):
 *   1. what messages does the parent task's /events actually deliver?
 *   2. after our frame mapping, does derive() get search/fare → do cards render?
 *
 * Dumps raw events + frames + derived view to /tmp/cardprobe.json for inspection.
 * Run: node --env-file=.env.local --import tsx server/rebyte/cardprobe.ts ["prompt"]
 */
import { writeFileSync } from 'node:fs'
import { ensureDefaultAgentComputer } from './provision.ts'
import { seedTravelkit } from './seed.ts'
import { rebyteJSON, rebyteFetch } from './client.ts'
import { parseSSE, isObj } from './sse.ts'
import { derive } from '../../src/frames.ts'

const PROMPT = process.argv.slice(2).join(' ')
  || '请使用 travelkit 搜索 2026-06-20 北京到上海的直飞机票，1 名成人，给我看几个选项。'

// ── frame translation, faithfully mirroring worker/task-do.ts translate()/emit() ──
type Frame = { seq: number; data: unknown }
const frames: Frame[] = []
let seq = 0
const emit = (data: unknown) => { frames.push({ seq: ++seq, data }) }

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

const rawEvents: Array<Record<string, unknown>> = []
const typeCounts: Record<string, number> = {}
const toolUseNames: string[] = []

async function main() {
  console.log('[cardprobe] 1/4 ensure VM…')
  const ac = await ensureDefaultAgentComputer()
  console.log(`[cardprobe]     VM id=${ac.id} sandboxId=${ac.sandboxId}`)

  console.log('[cardprobe] 2/4 seed travelkit…')
  const seeded = await seedTravelkit(ac)
  console.log(`[cardprobe]     seeded ${seeded.length} files`)

  console.log('[cardprobe] 3/4 POST /tasks…')
  const task = await rebyteJSON<{ id: string; url?: string }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({ prompt: PROMPT, workspaceId: ac.id }), // model/executor ignored by /v1/tasks (org-wide)
  })
  console.log(`[cardprobe]     task=${task.id} ${task.url ?? ''}`)

  console.log('[cardprobe] 4/4 stream /events (reconnect on empty-done race)…')
  let doneStatus = '?'
  let finalResult = ''
  const timer = setTimeout(() => { console.error('[cardprobe] timeout'); process.exit(2) }, 240_000)
  for (let attempt = 0; attempt < 90; attempt++) {
    const res = await rebyteFetch(`/tasks/${task.id}/events`, { headers: { Accept: 'text/event-stream' } })
    if (!res.ok || !res.body) { console.error('open failed', res.status, await res.text()); process.exit(1) }
    let got = 0
    for await (const msg of parseSSE(res.body)) {
      if (msg.event === 'done') {
        if (got > 0 && isObj(msg.data)) {
          doneStatus = String(msg.data.status ?? '?')
          if (typeof msg.data.finalResult === 'string') finalResult = msg.data.finalResult
        }
        if (got > 0) break
        else break
      }
      if (!isObj(msg.data)) continue
      got++
      const ev = msg.data as { seq?: number; eventType?: string; payload?: Record<string, unknown> }
      const t = String(ev.eventType ?? '?')
      typeCounts[t] = (typeCounts[t] ?? 0) + 1
      rawEvents.push(msg.data as Record<string, unknown>)
      if (t === 'tool_use') {
        const p = isObj(ev.payload) ? ev.payload : {}
        toolUseNames.push(String(p.name ?? p.tool_name ?? '?'))
      }
      translate(ev)
    }
    if (got > 0) break
    const st = await rebyteJSON<{ status?: string }>(`/tasks/${task.id}`).catch(() => ({ status: '?' }))
    if (['completed', 'failed', 'canceled'].includes(st.status ?? '') && attempt >= 3) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  clearTimeout(timer)

  // ── map frames → DerivedView via the REAL production derive() ──
  const view = derive([{ id: 'p1', prompt: PROMPT, frames }])

  console.log('\n══════════ 接口层：父任务 /events 真实返回 ══════════')
  console.log(`事件总数: ${rawEvents.length}   done=${doneStatus}`)
  console.log(`eventType 分布: ${JSON.stringify(typeCounts)}`)
  console.log(`tool_use 工具名: ${JSON.stringify(toolUseNames)}`)
  console.log(`finalResult(前160): ${finalResult.slice(0, 160)}`)

  console.log('\n══════════ 数据层：translate() 产出的 frames ══════════')
  console.log(`frame 总数: ${frames.length}`)
  const frameKinds: Record<string, number> = {}
  for (const f of frames) {
    const d = f.data as Record<string, unknown>
    let kind = 'other'
    if (d.__relay) kind = `__relay:${d.__relay}`
    else if (d.type === 'assistant') {
      const c = (d.message as { content?: Array<{ type?: string }> })?.content?.[0]
      kind = `assistant:${c?.type ?? '?'}`
    } else if (d.type === 'user') kind = 'user:tool_result'
    frameKinds[kind] = (frameKinds[kind] ?? 0) + 1
  }
  console.log(`frame 种类分布: ${JSON.stringify(frameKinds)}`)

  console.log('\n══════════ 卡片层：derive() → bench 能渲染什么 ══════════')
  console.log(`stage:   ${view.stage}`)
  console.log(`chat:    ${view.chat.length} 条气泡`)
  console.log(`search:  ${view.search ? `✅ ${view.search.options.length} 个航班选项 (totalCount=${view.search.totalCount})` : '❌ null → 搜索卡渲染不出'}`)
  console.log(`fare:    ${view.fare ? `✅ total=${view.fare.total} journeys=${view.fare.journeys.length}` : '❌ null → 验价卡渲染不出'}`)
  console.log(`notice:  ${view.notice ?? '(无)'}`)

  console.log('\n══════════ 诊断 ══════════')
  const sawDomainToolResult = frames.some((f) => {
    const d = f.data as Record<string, unknown>
    return d.type === 'user'
  })
  if (!view.search && !view.fare) {
    console.log('❌ 卡片渲染不出。原因（按数据层排查）：')
    if (!toolUseNames.some((n) => n.includes('flight_'))) {
      console.log('   · 父 /events 里没有任何 flight_* 的 tool_use —— 领域工具调用被委派进子 agent，父任务看不到。')
    }
    if (!sawDomainToolResult) {
      console.log('   · 没有任何 tool_result frame —— derive() 靠 user/tool_result 解析卡片，没有就一定是 null。')
    }
    console.log('   → 即「结构化结果困在子 agent，父任务只拿到散文总结」(REBYTE-ISSUE.md §2)。')
    console.log('   → 这是接口层缺数据，不是前端渲染 bug：frames.ts 的 parseSearchResult/parseVerify 没东西可吃。')
  } else {
    console.log('✅ 卡片能拿到数据 —— 结构化 tool_result 透到了父任务，frames.ts 映射成功。')
  }

  const dump = { prompt: PROMPT, doneStatus, typeCounts, toolUseNames, finalResult, rawEvents, frames, view }
  writeFileSync('/tmp/cardprobe.json', JSON.stringify(dump, null, 2))
  console.log('\n📄 原始 events + frames + derived view 已写入 /tmp/cardprobe.json')
  process.exit(0)
}
main().catch((e) => { console.error('[cardprobe] ERROR:', e?.stack || e?.message || e); process.exit(1) })
