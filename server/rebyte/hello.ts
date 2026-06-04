/** Dead-simple rebyte round-trip: POST /v1/tasks {prompt} with the org key,
 *  stream /events, print what comes back. No agent-computer, no seed, no
 *  workspaceId. Just prove the key reaches rebyte and the agent replies.
 *  Run: node --env-file=.env.local --import tsx server/rebyte/hello.ts ["prompt"]
 */
import { rebyteJSON, rebyteFetch } from './client.ts'
import { parseSSE, isObj } from './sse.ts'

const PROMPT = process.argv.slice(2).join(' ') || '请用一句话介绍你自己。'

async function main() {
  console.log(`POST /v1/tasks  prompt="${PROMPT}"`)
  const task = await rebyteJSON<{ id: string; url?: string; status?: string }>('/tasks', {
    method: 'POST', body: JSON.stringify({ prompt: PROMPT }),
  })
  console.log(`→ task ${task.id}  status=${task.status}  ${task.url ?? ''}`)

  console.log('streaming /events …')
  for (let attempt = 0; attempt < 90; attempt++) {
    const res = await rebyteFetch(`/tasks/${task.id}/events`, { headers: { Accept: 'text/event-stream' } })
    if (!res.ok || !res.body) { console.error('open failed', res.status, await res.text()); process.exit(1) }
    let got = 0
    for await (const ev of parseSSE(res.body)) {
      if (ev.event === 'done') { if (got) { console.log(`\nDONE ${JSON.stringify(ev.data)}`) } break }
      got++
      if (isObj(ev.data)) {
        const t = ev.data.eventType; const p = isObj(ev.data.payload) ? ev.data.payload : {}
        console.log(`  [${t}] ${JSON.stringify(p).slice(0, 400)}`)
      }
    }
    if (got > 0) { console.log('\n✅ rebyte 通了：agent 有产出（见上）。'); process.exit(0) }
    const st = await rebyteJSON<{ status?: string }>(`/tasks/${task.id}`).catch(() => ({ status: '?' }))
    if (['completed', 'failed', 'canceled'].includes(st.status ?? '') && attempt >= 3) {
      console.log(`task ${st.status}, still 0 events after ${attempt} retries`); break
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log('\n⚠️ 没拿到事件 — 见上面状态。')
  process.exit(0)
}
main().catch((e) => { console.error('ERROR', e?.stack || e?.message || e); process.exit(1) })
