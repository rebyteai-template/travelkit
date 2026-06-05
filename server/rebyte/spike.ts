/**
 * Connectivity spike: prove the rebyte relay runs an agent that reaches
 * TravelKit, end-to-end, and learn the live-event contract.
 *
 *   ensureDefaultAgentComputer()  → provision/boot a sandbox VM
 *   seedTravelkit(ac)             → write .mcp.json + skill into /code
 *   POST /tasks {prompt,wsId,executor,model} → relay starts the agent
 *   GET  /tasks/:id/events (Accept: text/event-stream) → live relay events
 *
 * Relay event envelope: {seq,timestamp,promptId,eventType,payload}. Events are
 * ONLY on the live stream — /content?include=events is empty post-run — so the
 * real task-runner must mirror them into our own frames table as they arrive.
 *
 * Run: node --env-file=.env.local --import tsx server/rebyte/spike.ts ["prompt"]
 */
import { ensureDefaultAgentComputer } from './provision.ts'
import { seedTravelkit } from './seed.ts'
import { rebyteJSON, rebyteFetch } from './client.ts'
import { parseSSE, isObj } from './sse.ts'

const PROMPT = process.argv.slice(2).join(' ')
  || '请使用 travelkit 搜索 2026-06-05 北京到上海的机票，1 名成人，直飞，给我看几个选项。'

const seenTypes = new Set<string>()
const finalText: string[] = []
const flags = { sawSearch: false, sawDelegation: false }
const DELEGATION = ['run_claude_code', 'run_codex', 'run_coding_agent', 'coding_agent__']

function summarize(ev: Record<string, unknown>, toolNames: Map<string, string>): void {
  const type = String(ev.eventType ?? '?')
  seenTypes.add(type)
  const p = isObj(ev.payload) ? ev.payload : {}
  switch (type) {
    case 'init': console.log(`  · init model=${p.model} cwd=${p.cwd}`); return
    case 'thinking': console.log(`  🤔 ${String(p.content ?? p.thinking ?? '').slice(0, 100)}`); return
    case 'text': case 'assistant': case 'message': case 'response': {
      const t = String(p.content ?? p.text ?? '')
      if (t.trim()) { finalText.push(t); console.log(`  💬 ${t.slice(0, 160)}`) }
      return
    }
    case 'tool_use': {
      const name = String(p.name ?? p.tool_name ?? '?'); const id = String(p.id ?? p.tool_id ?? '')
      if (id) toolNames.set(id, name)
      console.log(`  🔧 tool_use ${name} ${JSON.stringify(p.input ?? p.params ?? {}).slice(0, 140)}`)
      // flight_search shows at the parent level only on legacy direct-call tasks; on
      // the agent-loop architecture it runs nested inside the delegated coding sub-
      // agent, so the parent stream only shows the coding_agent delegation. Either
      // counts as "reached travelkit".
      if (name.includes('flight_search') || name.includes('flight_verify')) flags.sawSearch = true
      if (DELEGATION.some((d) => name.includes(d))) flags.sawDelegation = true
      return
    }
    case 'tool_result': {
      const id = String(p.id ?? p.tool_id ?? ''); const name = toolNames.get(id) ?? '?'
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '')
      console.log(`  📦 tool_result ← ${name} (${out.length} chars)`)
      if (name.includes('flight_search')) console.log(`  ──── output head ────\n${out.slice(0, 500)}\n  ────`)
      return
    }
    case 'result': console.log(`  · result ${JSON.stringify(p).slice(0, 2500)}`); return
    default: console.log(`  · ${type} ${JSON.stringify(p).slice(0, 2000)}`); return
  }
}

async function main() {
  console.log('[spike] 1/4 ensure agent-computer (VM)…')
  const ac = await ensureDefaultAgentComputer()
  console.log(`[spike]     VM id=${ac.id} sandboxId=${ac.sandboxId}`)

  console.log('[spike] 2/4 seeding travelkit config into /code…')
  const files = await seedTravelkit(ac)
  console.log(`[spike]     seeded ${files.length} files`)

  console.log(`[spike] 3/4 POST /tasks (model resolved org-wide)…`)
  const task = await rebyteJSON<{ id: string; status?: string; url?: string }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({ prompt: PROMPT, workspaceId: ac.id }), // model/executor ignored by /v1/tasks
  })
  console.log(`[spike]     task=${task.id}  ${task.url ?? ''}`)

  console.log('[spike] 4/4 streaming /events (reconnect on empty-done race)…')
  const toolNames = new Map<string, string>()
  let n = 0
  let doneStatus = '?'
  let finalResult = ''
  const timer = setTimeout(() => { console.error('[spike] timeout'); process.exit(2) }, 240_000)

  // The relay returns an immediate done (lastSeq:-1) if we connect before it has
  // emitted anything; once the agent starts, /events replays from seq 0. So
  // reconnect on empty-done until we get events or the task is truly terminal.
  for (let attempt = 0; attempt < 90; attempt++) {
    const res = await rebyteFetch(`/tasks/${task.id}/events`, { headers: { Accept: 'text/event-stream' } })
    if (!res.ok || !res.body) { console.error('open failed', res.status, await res.text()); process.exit(1) }
    let got = 0
    for await (const ev of parseSSE(res.body)) {
      if (ev.event === 'done') {
        if (got > 0) {
          console.log(`[spike] event:done ${JSON.stringify(ev.data)}`)
          if (isObj(ev.data)) {
            doneStatus = String(ev.data.status ?? '?')
            if (typeof ev.data.finalResult === 'string') finalResult = ev.data.finalResult
          }
        }
        break
      }
      got++; n++
      if (isObj(ev.data)) summarize(ev.data, toolNames)
    }
    if (got > 0) break // got the (replayed-from-0) stream; done
    const st = await rebyteJSON<{ status?: string }>(`/tasks/${task.id}`).catch(() => ({ status: '?' }))
    if (['completed', 'failed', 'canceled'].includes(st.status ?? '') && attempt >= 3) {
      console.log(`[spike] task ${st.status} with no streamed events (attempt ${attempt})`); break
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  clearTimeout(timer)
  if (!finalResult && finalText.length) finalResult = finalText.join('')
  console.log(`\n[spike] stream ended. events=${n} types=${JSON.stringify([...seenTypes])} done=${doneStatus} delegated=${flags.sawDelegation} flightSearchSeen=${flags.sawSearch}`)
  if (finalResult) console.log(`[spike] final agent text:\n${finalResult.slice(0, 800)}`)

  // PASS on the agent-loop architecture = task succeeded with a real answer AND
  // travelkit was reached — either flight_search at the parent level (legacy direct
  // call) OR a coding_agent delegation (flight_search runs nested in the sub-agent,
  // not surfaced in the parent stream).
  const reachedTravelkit = flags.sawSearch || flags.sawDelegation
  const ok = doneStatus === 'succeeded' && finalResult.trim().length > 0 && reachedTravelkit
  if (ok) {
    const via = flags.sawSearch ? 'flight_search（父级直调）' : 'coding_agent 委派（flight_search 在子 agent 内）'
    console.log(`\n✅ SPIKE PASS: done=succeeded，经 ${via} 拿到真实结果。`)
    if (!flags.sawSearch) console.log('   注：委派路下 flight_search 在子 agent，父事件流不透出；要铁证可 peek 子 prompt 事件。')
  } else {
    console.log(`\n⚠️ SPIKE 未通：done=${doneStatus}, finalResult=${finalResult ? 'yes' : 'no'}, reachedTravelkit=${reachedTravelkit}（见上方事件）。`)
  }
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error('[spike] ERROR:', e?.stack || e?.message || e); process.exit(1) })
