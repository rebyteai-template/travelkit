/**
 * Multi-turn relay probe — reproduces the production bug where the 2nd/3rd chat
 * message "loads back only halfway" then sticks, even though the rebyte task
 * completes fine. It mirrors task-do.ts's streaming contract EXACTLY:
 *
 *   turn 1 → POST /tasks {prompt, workspaceId, executor, model}
 *   turn N → POST /tasks/:id/prompts {prompt}        (same relay task, kept context)
 *   each turn → drive bounded /events windows, dedup by a PER-TURN lastSeq=0,
 *               reconnect-replays-from-0, treat empty `done` as a replay race.
 *
 * It logs, per window, the seq range seen, how many events were NEW vs replayed,
 * and whether a `done` arrived (and whether our guards would call it terminal).
 * That exposes whether a follow-up turn finalizes prematurely.
 *
 * Run: node --env-file=.env.local --import tsx server/rebyte/multiturn.ts
 */
import { ensureDefaultAgentComputer } from './provision.ts'
import { seedTravelkit } from './seed.ts'
import { rebyteJSON, rebyteFetch } from './client.ts'
import { parseSSE, isObj } from './sse.ts'

const WINDOW_MS = 20_000
const TURN_TIMEOUT_MS = 240_000
const TERMINAL = new Set(['completed', 'succeeded', 'failed', 'canceled', 'cancelled'])

// Mirror of worker/task-do.ts MANAGER_ROUTE_HINT: ONE routing line on the first prompt that makes
// the front-line manager delegate flight work to the sandbox skill instead of web-searching. All
// domain rules live in /code/CLAUDE.md + the travelkit-pro skill, not here. Keep in sync with task-do.
const MANAGER_ROUTE_HINT =
  '【路由】本工作区是 TripDesk 机票预订场景：所有机票相关请求一律委派沙箱里的 travelkit-pro skill ' +
  '处理（用 sandbox / coding_agent 工具进沙箱执行），严禁用 web search 或凭记忆作答机票信息。'

interface WindowResult { terminal: boolean; status?: string; finalResult?: string }

/** Mirror of TaskDO.streamWindow. `state.lastSeq` is PER-TURN (starts at 0). */
async function streamWindow(
  relayTaskId: string,
  state: { lastSeq: number; sawText: boolean; text: string[]; tools: string[] },
  label: string,
): Promise<WindowResult> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), WINDOW_MS)
  let rawCount = 0
  let freshCount = 0
  let minSeq = Infinity
  let maxSeq = -Infinity
  try {
    const res = await rebyteFetch(`/tasks/${relayTaskId}/events`, {
      headers: { Accept: 'text/event-stream' }, signal: abort.signal,
    })
    if (!res.ok || !res.body) { console.log(`    [${label}] open failed ${res.status}`); return { terminal: false } }

    for await (const msg of parseSSE(res.body)) {
      if (msg.event === 'done') {
        const d = isObj(msg.data) ? msg.data : {}
        console.log(`    [${label}] DONE raw=${rawCount} fresh=${freshCount} seqRange=[${minSeq === Infinity ? '-' : minSeq}..${maxSeq === -Infinity ? '-' : maxSeq}] data=${JSON.stringify(d)}`)
        // task-do.ts guard: rawCount===0 → replay-race (ignore). Otherwise terminal.
        if (rawCount === 0) { await new Promise((r) => setTimeout(r, 800)); return { terminal: false } }
        return { terminal: true, status: String(d.status ?? ''), finalResult: typeof d.finalResult === 'string' ? d.finalResult : undefined }
      }
      if (!isObj(msg.data)) continue
      rawCount++
      const ev = msg.data as { seq?: number; eventType?: string; payload?: Record<string, unknown> }
      const seq = typeof ev.seq === 'number' ? ev.seq : state.lastSeq + 1
      minSeq = Math.min(minSeq, seq); maxSeq = Math.max(maxSeq, seq)
      if (seq <= state.lastSeq) continue
      state.lastSeq = seq
      freshCount++
      const p = isObj(ev.payload) ? ev.payload : {}
      const type = String(ev.eventType ?? '')
      if (type === 'text' || type === 'assistant' || type === 'message' || type === 'response') {
        const t = String(p.content ?? p.text ?? '')
        if (t.trim()) { state.sawText = true; state.text.push(t); console.log(`    [${label}] 💬 seq=${seq} ${t.slice(0, 80)}`) }
      } else if (type === 'tool_use') {
        const name = String(p.name ?? p.tool_name ?? '?')
        state.tools.push(name)
        console.log(`    [${label}] 🔧 seq=${seq} ${name}`)
      } else if (type === 'tool_result') {
        console.log(`    [${label}] 📦 seq=${seq} tool_result`)
      } else {
        console.log(`    [${label}] · seq=${seq} ${type}`)
      }
    }
    console.log(`    [${label}] stream closed (no done) raw=${rawCount} fresh=${freshCount} seqRange=[${minSeq === Infinity ? '-' : minSeq}..${maxSeq === -Infinity ? '-' : maxSeq}]`)
    return { terminal: false }
  } catch (e) {
    if (abort.signal.aborted) { console.log(`    [${label}] window timeout (20s) raw=${rawCount} fresh=${freshCount}`); return { terminal: false } }
    throw e
  } finally { clearTimeout(timer) }
}

const MAX_TERMINAL_DRAINS = 4

/** Drive one full turn to terminal, mirroring the FIXED TaskDO.alarm() loop: when
 *  GET /tasks reports terminal but we haven't drained the trailing text + `done`,
 *  drain a few more windows so the agent's final summary isn't dropped. */
async function driveTurn(relayTaskId: string, turnNo: number): Promise<{ status: string; text: string; tools: string[] }> {
  const state = { lastSeq: 0, sawText: false, text: [] as string[], tools: [] as string[] }
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let win = 0
  let terminalDrains = 0
  for (;;) {
    win++
    const done = await streamWindow(relayTaskId, state, `t${turnNo}.w${win}`)
    if (done.terminal) {
      const status = done.status || 'completed'
      console.log(`  → turn ${turnNo} TERMINAL via stream done: ${status} (drains=${terminalDrains})`)
      return { status, text: done.finalResult || state.text.join(''), tools: state.tools }
    }
    const st = await rebyteJSON<{ status?: string; finalResult?: string }>(`/tasks/${relayTaskId}`).catch(() => ({} as { status?: string; finalResult?: string }))
    if (st.status && TERMINAL.has(st.status)) {
      const haveAnswer = state.sawText || !!st.finalResult?.trim()
      if (!haveAnswer && terminalDrains < MAX_TERMINAL_DRAINS && Date.now() < deadline) {
        terminalDrains++
        console.log(`  · turn ${turnNo} status=${st.status} but no text yet — draining (#${terminalDrains})`)
        await new Promise((r) => setTimeout(r, 100))
        continue
      }
      console.log(`  → turn ${turnNo} TERMINAL via GET /tasks status=${st.status} (drains=${terminalDrains})`)
      return { status: st.status, text: st.finalResult || state.text.join(''), tools: state.tools }
    }
    if (Date.now() >= deadline) { console.log(`  → turn ${turnNo} TIMEOUT`); return { status: 'timeout', text: state.text.join(''), tools: state.tools } }
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function main() {
  console.log('[multiturn] 1/3 ensure VM…')
  const ac = await ensureDefaultAgentComputer()
  console.log(`[multiturn]     VM=${ac.id}`)
  console.log('[multiturn] 2/3 seed travelkit…')
  await seedTravelkit(ac).then((f) => console.log(`[multiturn]     seeded ${f.length} files`))

  // search → verify → collect passenger/confirm gate → confirm-create-order + pay link.
  const turns = [
    '请搜索 2026-06-20 北京到上海的机票，1 名成人，直飞，给我看几个选项。',
    '我选第 1 个，帮我实时验价。',
    '验价没问题的话，乘客张三，身份证 110101199001011237，手机 13800138000，帮我下单（先别真支付）。',
    '确认下单。下单后请发起支付，把第三方支付链接发给我自行完成（不要替我付款）。',
  ]
  // Each turn must stream a non-empty answer (the bug dropped it). A loose keyword
  // probe per turn catches "finalized but empty / wrong stage" regressions too.
  const expect = ['', '验价', '确认', '支付']

  // No model/executor: POST /v1/tasks ignores both; the relay resolves the model
  // org-wide (org_settings.agent_loop_model). So this tests whatever the org is set to.
  console.log('[multiturn] 3/3 turn 1: POST /tasks (model resolved org-wide by relay)')
  const task = await rebyteJSON<{ id: string; status?: string }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({ prompt: `${MANAGER_ROUTE_HINT}\n\n${turns[0]}`, workspaceId: ac.id }),
  })
  console.log(`[multiturn]     relayTask=${task.id}`)

  const failures: string[] = []
  for (let i = 0; i < turns.length; i++) {
    const prompt = turns[i] ?? ''
    const want = expect[i] ?? ''
    if (i > 0) {
      console.log(`\n[multiturn] turn ${i + 1}: POST /tasks/${task.id}/prompts → "${prompt.slice(0, 30)}…"`)
      await rebyteJSON(`/tasks/${task.id}/prompts`, { method: 'POST', body: JSON.stringify({ prompt }) })
    }
    const r = await driveTurn(task.id, i + 1)
    console.log(`\n=== TURN ${i + 1} RESULT status=${r.status} textLen=${r.text.length} tools=[${r.tools.join(', ')}] ===`)
    console.log(r.text.slice(0, 600))
    console.log('==========================================')

    // Assertions — this is the regression guard for the "loads back only halfway" bug.
    if (r.status === 'timeout' || r.status === 'failed') failures.push(`turn ${i + 1}: status=${r.status}`)
    else if (!r.text.trim()) failures.push(`turn ${i + 1}: 空回复（finalize 早于 text+done）`)
    else if (want && !r.text.includes(want)) failures.push(`turn ${i + 1}: 回复未含 "${want}"（阶段可能不对）`)
    // Skill-routing guard: the manager MUST delegate flight work to the sandbox, never web-search /
    // fabricate. A web_search tool on any turn means the routing hint failed (REBYTE-NEEDS.md §3).
    if (r.tools.some((t) => /web_search|websearch|browse/i.test(t))) {
      failures.push(`turn ${i + 1}: 用了 web search（${r.tools.join(',')}）——没走 travelkit-pro skill`)
    }
    console.log(failures.find((f) => f.startsWith(`turn ${i + 1}:`)) ? `❌ turn ${i + 1} FAIL` : `✅ turn ${i + 1} OK`)
  }

  console.log('\n──────────────────────────────────────────')
  if (failures.length) {
    console.log(`❌ 多轮测试失败：\n  - ${failures.join('\n  - ')}`)
    process.exit(1)
  }
  console.log('✅ 多轮全过：search→verify→order→pay 四轮都完整流式返回，无半截截断。')
  process.exit(0)
}
main().catch((e) => { console.error('ERROR', e?.stack || e?.message || e); process.exit(1) })
