/** Tiered rebyte connectivity smoke test — "is the service OK", UI-independent.
 *  Fail-fast L0→L2, clear PASS/FAIL per tier, non-zero exit on the first failure.
 *    L0 存活   GET /health           (root, no auth)        — relay process up?
 *    L1 鉴权   GET /v1/tasks?limit=1  (org key, no task)     — key valid + tasks:read?
 *    L2 往返   POST /v1/tasks → /events → reply+done         — agent-loop 回复路通?
 *  Bonus: probes /content?include=events to record whether the event history is
 *  now retrievable post-run (decides SSE-vs-poll for the task-runner).
 *  L3 (full delegated VM + travelkit) lives in spike.ts → `pnpm test:rebyte:full`.
 *  Run: pnpm test:rebyte
 */
import { env } from '../env.ts'
import { rebyteFetch, rebyteJSON } from './client.ts'
import { parseSSE, isObj } from './sse.ts'

const PROMPT = '请用一句话介绍你自己。'

function pass(tier: string, msg: string) { console.log(`✅ ${tier}  ${msg}`) }
function fail(tier: string, msg: string): never {
  console.log(`❌ ${tier}  ${msg}`)
  console.log(`\n冒烟失败于 ${tier} —— rebyte 服务有问题，见上。`)
  process.exit(1)
}

async function L0_liveness() {
  const url = `${new URL(env.REBYTE_API_URL).origin}/health`
  let res: Response
  try { res = await fetch(url) }
  catch (e) { return fail('L0 存活', `连不上 ${url}: ${(e as Error).message}`) }
  if (!res.ok) return fail('L0 存活', `${url} → HTTP ${res.status}`)
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  pass('L0 存活', `GET /health → ${res.status} (${String(body.status ?? 'ok')})`)
}

async function L1_auth() {
  if (!env.REBYTE_API_KEY) return fail('L1 鉴权', 'REBYTE_API_KEY 未设置（在 .env.local 配置）')
  const res = await rebyteFetch('/tasks?limit=1')
  if (res.status === 401) return fail('L1 鉴权', '401 — org key 无效或缺失')
  if (res.status === 403) return fail('L1 鉴权', '403 — key 缺 tasks:read scope')
  if (!res.ok) return fail('L1 鉴权', `GET /v1/tasks → HTTP ${res.status} ${(await res.text()).slice(0, 160)}`)
  pass('L1 鉴权', 'GET /v1/tasks?limit=1 → 200（org key 有效 + tasks:read）')
}

async function L2_roundtrip() {
  const task = await rebyteJSON<{ id: string; status?: string }>('/tasks', {
    method: 'POST', body: JSON.stringify({ prompt: PROMPT }),
  })
  console.log(`   · POST /v1/tasks → ${task.id} (status=${task.status})`)

  let finalResult = ''
  let events = 0
  // Reconnect on the empty-done race: the relay replays from seq 0 once the agent
  // starts, so a 0-event done just means "too early" — retry a few times.
  for (let attempt = 0; attempt < 90; attempt++) {
    const res = await rebyteFetch(`/tasks/${task.id}/events`, { headers: { Accept: 'text/event-stream' } })
    if (!res.ok || !res.body) return fail('L2 往返', `打开 /events 失败 HTTP ${res.status}`)
    let got = 0
    for await (const ev of parseSSE(res.body)) {
      if (ev.event === 'done') {
        if (isObj(ev.data) && typeof ev.data.finalResult === 'string') finalResult ||= ev.data.finalResult
        break
      }
      got++; events++
      if (isObj(ev.data) && isObj(ev.data.payload)) {
        const p = ev.data.payload
        const txt = typeof p.content === 'string' ? p.content : typeof p.result === 'string' ? p.result : ''
        if (txt) finalResult ||= txt
      }
    }
    if (got > 0) break
    const st = await rebyteJSON<{ status?: string }>(`/tasks/${task.id}`).catch(() => ({ status: '?' }))
    if (['completed', 'failed', 'canceled'].includes(st.status ?? '') && attempt >= 3) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!finalResult) return fail('L2 往返', `没拿到回复（events=${events}）—— agent-loop 回复路可能又断了`)
  pass('L2 往返', `/events 收到 ${events} 事件，finalResult="${finalResult.slice(0, 50)}…"`)

  // Bonus probe: is the event history retrievable via /content?include=events now?
  // (Pre-4aee368 this was empty post-run; AgentLoopPublicView now populates it.)
  const content = await rebyteJSON<{ prompts?: Array<{ response?: string; events?: unknown[] }> }>(
    `/tasks/${task.id}/content?include=events`,
  ).catch(() => null)
  const p0 = content?.prompts?.[0]
  const nEv = Array.isArray(p0?.events) ? p0.events.length : null
  const hasResp = p0?.response ? 'yes' : 'no'
  console.log(
    nEv === null
      ? `   ℹ️  /content?include=events: 无 events 字段（response=${hasResp}）`
      : `   ℹ️  /content?include=events: events=${nEv}, response=${hasResp} → ${nEv > 0 ? '历史可查，轮询架构可行' : '事件不落 /content，需走 SSE'}`,
  )
}

async function main() {
  console.log(`rebyte 冒烟 @ ${env.REBYTE_API_URL}\n`)
  await L0_liveness()
  await L1_auth()
  await L2_roundtrip()
  console.log('\n✅ 冒烟全过：rebyte 服务 OK。')
  process.exit(0)
}
main().catch((e) => { console.error('ERROR', e?.stack || e?.message || e); process.exit(1) })
