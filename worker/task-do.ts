/**
 * TaskDO — the per-task agent runner, as an ALARM-DRIVEN Durable Object (one per taskId).
 *
 * Why alarms: a turn streams the rebyte relay for up to minutes, but `ctx.waitUntil`
 * does NOT keep a DO alive after the triggering request returns — the work gets evicted
 * mid-turn and the task orphans at 'running'. The runtime DOES guarantee `alarm()` runs
 * (and keeps the DO alive while it executes), so the turn lives in alarm() and advances in
 * short, safe windows. Progress (relayTaskId, lastRelaySeq) is persisted in DO storage, so a
 * retried/resumed alarm continues idempotently rather than re-POSTing the relay task.
 *
 *   runTurn() → persist intent + setAlarm(now)
 *   alarm()   → ensure relay task → stream a bounded /events window → translate → frames(D1)
 *             → finalize when the relay task is terminal (or on timeout)
 *
 * Pure fetch: never imports the rebyte-sandbox SDK. Per-user sandbox is looked up by email
 * (agent_computers table), falling back to the legacy single kv.agent_computer. Frame fidelity
 * matches src/frames.ts (assistant tool_use/text, user tool_result).
 *
 * Sub-session replay (REBYTE-ISSUE.md): the agent-loop delegates domain MCP calls to a sandbox
 * sub-session and the parent stream carries only the manager's text summary — the structured
 * flight_search/verify JSON (with solutionId) stays in the sub-session. We recover it via the
 * relay's per-prompt events endpoint: each delegation result is tagged with `subPromptId`, and
 * replaySubPrompt() pulls that sub-session's real travelkit tool_use/tool_result into this
 * prompt's frames so the bench cards populate. See replaySubPrompt() + REBYTE-ISSUE.md §3.
 */
import { DurableObject } from 'cloudflare:workers'
import { createD1Store } from '../server/db.ts'
import type { Store } from '../server/store.ts'
import { isObj, parseSSE } from '../server/rebyte/sse.ts'
import { rebyteJSON, rebyteFetch, type RebyteConfig } from '../server/rebyte/client.ts'
import { provisionComputer, seedSandbox, pushSeedFiles, removeStaleArtifacts, applyCredential, SEED_VERSION, type ProvisionedComputer } from './seed.ts'
import { shouldDrainTerminal } from './turn-finalize.ts'
import { framesHaveAssistantText, unrenderedResultTexts, normText } from '../server/frame-text.ts'
import type { Env } from './env.ts'

// No model/executor here on purpose: POST /v1/tasks IGNORES both (cctools relay
// `void input.model; void input.executor`). The agent-loop model is resolved org-wide
// from org_settings.agent_loop_model — switch it in the rebyte admin, not in code.
const TURN_TIMEOUT_MS = 240_000 // hard ceiling for a whole turn
const WINDOW_MS = 20_000 // per-alarm streaming window — short enough to never risk eviction
const DEFAULT_API_URL = 'https://api.rebyte.ai/v1'
const TERMINAL = new Set(['completed', 'succeeded', 'failed', 'canceled', 'cancelled'])

/** Relay event envelope (live /events + /content?include=events): {seq,eventType,payload}. */
interface RelayEvent {
  seq?: number
  eventType?: string
  payload?: Record<string, unknown>
}

/** The in-flight turn, persisted in DO storage so alarm() resumes idempotently. The
 *  session's relay task id lives separately (DO storage key 'relayTaskId') so it
 *  survives across turns — follow-ups continue that SAME relay task. */
interface TurnState {
  taskId: string
  promptId: string
  prompt: string
  userEmail: string
  /** The caller's travelkit token (from the iframe handoff), seeded into their sandbox on
   *  first turn. Only consumed at provision time; harmless on follow-ups. */
  travelkitToken: string
  relayTaskId?: string
  /** Did this turn already submit its prompt to the relay (create or /prompts)?
   *  Guards a retried alarm from double-submitting after a window/eviction. */
  submitted: boolean
  lastRelaySeq: number
  sawText: boolean
  /** Whitespace-stripped concat of all assistant text emitted this turn, so the
   *  `result` event + final `finalResult` (which echo the same answer on another
   *  channel) are emitted once, not duplicated. */
  emittedText: string
  /** Consecutive windows where GET /tasks reported terminal but we hadn't yet
   *  drained the relay's trailing text + `done` (which carries the final summary).
   *  The status flips a beat before finalResult populates, so we drain a few more
   *  windows to catch the tail before finalizing. */
  terminalDrains: number
  /** Sub-session prompt ids whose delegated domain-tool events we've already
   *  pulled + replayed into this prompt's frames (so we fetch each once). */
  fetchedSubPrompts: string[]
  deadline: number
}

/** Prepended to the relay prompt so the hosted agent uses the travelkit skill (direct Simplifly
 *  OpenAPI HTTP, no MCP) instead of web search / fabrication, and follows the booking red-lines.
 *  The UI shows only the user's original prompt (stored separately by routes). */
const REBYTE_INSTRUCTION = [
  '你是 TripDesk 的机票预订助手。对所有机票相关请求，必须使用沙箱 /code 里的 travelkit skill，',
  '按 skill 文档直连 Simplifly Flight OpenAPI 的 HTTP 接口完成（搜索/验价/下单/支付/退改等）；',
  '严禁用网页搜索或凭记忆编造航班、价格、时刻——只认 Simplifly OpenAPI 返回的真实数据。',
  '红线：先搜索→实时验价→验价通过后再收乘客证件；下单/支付/退改等写操作必须经用户明确确认；',
  '绝不向用户暴露 solutionId / orderKey / PNR / 票号等内部字段。默认用简体中文回复。',
  '沙箱/演示模式：可搜索、验价、下单、发起支付（发起支付会返回第三方支付链接给用户自行完成）；',
  '绝不替用户在第三方平台完成付款，也绝不谎称已支付。',
].join('')

/** Hex sha256 — lets us detect a rotated travelkit token without storing the raw token. */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface CachedAgentComputer {
  id: string
  sandboxId?: string
}

export class TaskDO extends DurableObject<Env> {
  private store: Store = createD1Store(this.env.DB)
  /** D1-derived frame seq for the current window (set at window start, never in-memory across ticks). */
  private frameSeq = 0

  private rebyteConfig(): RebyteConfig {
    return { apiUrl: this.env.REBYTE_API_URL ?? DEFAULT_API_URL, apiKey: this.env.REBYTE_API_KEY }
  }

  // ── frame emission (durable seq from D1 so resumed ticks never collide) ──
  private emit(promptId: string, data: unknown): Promise<void> {
    return this.store.appendFrame(promptId, ++this.frameSeq, data)
  }
  private async maxFrameSeq(promptId: string): Promise<number> {
    const row = await this.env.DB.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM frames WHERE prompt_id = ?`)
      .bind(promptId)
      .first<{ m: number }>()
    return row?.m ?? 0
  }
  private async emitText(promptId: string, text: string): Promise<void> {
    if (!text.trim()) return
    await this.emit(promptId, { type: 'assistant', message: { content: [{ type: 'text', text }] } })
  }
  /** Emit assistant text and record it in t.emittedText. When `dedupe`, skip text the
   *  turn has already shown — the relay echoes the final answer on both the `text` and
   *  `result`/`finalResult` channels, so without this the verify/order summary doubles
   *  (or, pre-fix, was DROPPED because we only emitted finalResult when no text existed). */
  private async emitTurnText(t: TurnState, text: string, dedupe: boolean): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    if (dedupe && t.emittedText.includes(normText(trimmed))) return
    await this.emitText(t.promptId, trimmed)
    t.emittedText += normText(trimmed)
    t.sawText = true
  }
  private async emitToolUse(promptId: string, id: string, name: string, input: unknown): Promise<void> {
    await this.emit(promptId, { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: input ?? {} }] } })
  }
  private async emitToolResult(promptId: string, toolUseId: string, output: unknown): Promise<void> {
    const content = typeof output === 'string' ? output : JSON.stringify(output ?? '')
    await this.emit(promptId, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } })
  }

  /** Translate one relay event into stream-json frame(s), updating turn bookkeeping. */
  private async translate(t: TurnState, ev: RelayEvent): Promise<void> {
    const type = String(ev.eventType ?? '')
    const p = isObj(ev.payload) ? ev.payload : {}
    switch (type) {
      case 'text': case 'assistant': case 'message': case 'response': {
        await this.emitTurnText(t, String(p.content ?? p.text ?? ''), false)
        return
      }
      case 'result': {
        // The agent-loop delivers the final summary on the `result` channel too — and
        // SOMETIMES ONLY there (no preceding `text` event), e.g. a verify/order turn that
        // opened with an "正在验价请稍候" ack. Render it as chat text, deduped so it doesn't
        // double the answer when a `text` event already carried it.
        await this.emitTurnText(t, String(p.result ?? p.content ?? p.text ?? ''), true)
        return
      }
      case 'tool_use': {
        const name = String(p.name ?? p.tool_name ?? '')
        const id = String(p.id ?? p.tool_id ?? '') || crypto.randomUUID()
        await this.emitToolUse(t.promptId, id, name, p.input ?? p.params ?? {})
        return
      }
      case 'tool_result': {
        await this.emitToolResult(t.promptId, String(p.id ?? p.tool_id ?? ''), p.output)
        // Agent-loop delegates domain MCP calls (flight_search / verify) to a sandbox
        // sub-session whose STRUCTURED tool_results never ride the parent stream — only
        // this delegation's text summary does (REBYTE-ISSUE.md). The relay tags the
        // delegation result with `subPromptId`; resolve it into the sub-session's real
        // travelkit tool_use/tool_result and replay those into THIS prompt's frames so
        // the bench cards populate. frames.ts already routes by tool name — no change there.
        const subPromptId = typeof p.subPromptId === 'string' ? p.subPromptId : ''
        if (subPromptId && !t.fetchedSubPrompts.includes(subPromptId)) {
          t.fetchedSubPrompts.push(subPromptId)
          await this.replaySubPrompt(t, subPromptId)
        }
        return
      }
      default:
        await this.emit(t.promptId, { __relay: type || 'unknown', payload: p })
        return
    }
  }

  /** Pull a delegated sandbox sub-session's normalized events and replay its domain
   *  tool_use/tool_result into the current prompt's frames. This is what makes the
   *  search/verify cards render: the structured flight_search JSON the manager
   *  collapsed to prose lives in the sub-session, reachable via the relay's per-prompt
   *  events endpoint. Best-effort — a failure just leaves the chat summary as-is. The
   *  delegation's tool_result has already arrived, so the sub-session is terminal and
   *  its GCS events are flushed. Only tool frames matter to the bench; text/thinking
   *  from the sub-agent stay internal (the manager's own summary is the chat answer). */
  private async replaySubPrompt(t: TurnState, subPromptId: string): Promise<void> {
    if (!t.relayTaskId) return
    const data = await rebyteJSON<{ events?: RelayEvent[] }>(
      `/tasks/${t.relayTaskId}/prompts/${subPromptId}/events`,
      { config: this.rebyteConfig() },
    ).catch(() => null)
    if (!data?.events?.length) return
    for (const ev of data.events) {
      const type = String(ev.eventType ?? '')
      if (type !== 'tool_use' && type !== 'tool_result') continue
      await this.translate(t, ev)
    }
  }

  private mapStatus(relayStatus: string): string {
    if (relayStatus === 'succeeded' || relayStatus === 'completed') return 'completed'
    if (relayStatus === 'canceled' || relayStatus === 'cancelled') return 'canceled'
    return 'failed'
  }

  private async finalize(t: TurnState, status: string): Promise<void> {
    await this.store.finishPrompt(t.promptId, status) // no-op if already non-running
    await this.store.setTaskStatus(t.taskId, status)
    await this.ctx.storage.delete('turn')
    await this.ctx.storage.deleteAlarm()
  }

  /** Per-user sandbox, provisioned lazily on first use. Returns the user's cached
   *  agent_computers row; if none, provisions a fresh sandbox via the rebyte API, seeds
   *  travelkit into it (both pure fetch), persists it, and returns it. Concurrent first
   *  turns race on INSERT OR IGNORE — the loser's VM is orphaned (minor), both then use the
   *  winner's row. */
  private async agentComputerFor(email: string, travelkitToken: string): Promise<CachedAgentComputer> {
    const tokenHash = travelkitToken ? await sha256Hex(travelkitToken) : ''
    const existing = await this.store.getAgentComputer(email)
    if (existing?.id) {
      // Hot-refresh of a reused sandbox (same VM, no reprovision), best-effort — a write failure
      // just leaves the old state, surfacing as an auth/skill error:
      //  · seed stale — a deploy changed the skill tree (SEED_VERSION bump); re-push SEED_FILES so
      //    the user stops running the old skill. Also refreshes the credential when we have a token.
      //  · token rotated — the user re-logged-in with a new token; rewrite just the credential.
      const seedStale = existing.seedVersion !== SEED_VERSION
      const tokenChanged = !!travelkitToken && tokenHash !== existing.tokenHash
      if (seedStale || tokenChanged) {
        try {
          const ac = await rebyteJSON<ProvisionedComputer>(`/agent-computers/${existing.id}`, { config: this.rebyteConfig() })
          if (ac.sandboxId && ac.sandboxBaseUrl && ac.sandboxApiKey) {
            if (seedStale) {
              if (travelkitToken) await seedSandbox(ac, travelkitToken)
              else await pushSeedFiles(ac) // no token at hand → refresh files only, keep credential
              await removeStaleArtifacts(ac) // really delete legacy files (old skill tree, .mcp.json, settings.json) via envd gRPC Remove
              await this.store.setAgentComputerSeed(email, travelkitToken ? tokenHash : (existing.tokenHash ?? ''), SEED_VERSION)
            } else {
              await applyCredential(ac, travelkitToken)
              await this.store.setAgentComputerTokenHash(email, tokenHash)
            }
          }
        } catch { /* keep old state; user sees an auth/skill error if it's stale */ }
      }
      return { id: existing.id, sandboxId: existing.sandboxId ?? undefined }
    }

    const ac = await provisionComputer(this.rebyteConfig(), `tripdesk:${email || 'anon'}`)
    await seedSandbox(ac, travelkitToken)
    await this.store.saveAgentComputer(email, ac.id, ac.sandboxId ?? null, tokenHash, SEED_VERSION)
    // Re-read so concurrent provisioners converge on the same (winning) row.
    const canonical = await this.store.getAgentComputer(email)
    return canonical?.id ? { id: canonical.id, sandboxId: canonical.sandboxId ?? undefined } : { id: ac.id, sandboxId: ac.sandboxId }
  }

  // ── RPC surface (called from the Worker via env.TASK_DO.getByName(taskId)) ──
  /** Persist the turn intent and fire the alarm. Returns immediately; the alarm drives it. */
  async runTurn(taskId: string, promptId: string, prompt: string, userEmail = '', travelkitToken = ''): Promise<void> {
    const t: TurnState = {
      taskId,
      promptId,
      prompt,
      userEmail,
      travelkitToken,
      submitted: false,
      lastRelaySeq: 0,
      sawText: false,
      emittedText: '',
      terminalDrains: 0,
      fetchedSubPrompts: [],
      deadline: Date.now() + TURN_TIMEOUT_MS,
    }
    await this.ctx.storage.put('turn', t)
    await this.ctx.storage.setAlarm(Date.now())
  }

  /** Debug "new VM": provision + seed a FRESH sandbox for this user and repoint their
   *  agent_computers row at it (upsert), abandoning the old VM (left running, never referenced
   *  again). Reached via a per-tenant DO so concurrent clicks for one user serialize here.
   *  The new VM is bound on the user's NEXT session (agentComputerFor reads the replaced row);
   *  the current session keeps its old workspace until they start a new chat. */
  async reprovisionSandbox(email: string, travelkitToken: string): Promise<{ sandboxId?: string }> {
    const ac = await provisionComputer(this.rebyteConfig(), `tripdesk:${email || 'anon'}`)
    await seedSandbox(ac, travelkitToken)
    const tokenHash = travelkitToken ? await sha256Hex(travelkitToken) : ''
    await this.store.replaceAgentComputer(email, ac.id, ac.sandboxId ?? null, tokenHash, SEED_VERSION)
    return { sandboxId: ac.sandboxId ?? undefined }
  }

  /** Append assistant text frames to a terminal prompt, computing seq locally rather
   *  than via the shared `frameSeq` (which belongs to the in-flight prompt). Targets
   *  only terminal prompts, so it never races the running turn's frame writer. */
  private async backfillText(promptId: string, texts: string[]): Promise<void> {
    let seq = await this.maxFrameSeq(promptId)
    for (const text of texts) {
      await this.store.appendFrame(promptId, ++seq, { type: 'assistant', message: { content: [{ type: 'text', text }] } })
    }
  }

  /** Self-heal a finalized turn whose answer is missing OR present-but-unrendered, so a
   *  browser refresh (which reads only the store) shows the complete message. Two cases:
   *    1. Answer is in the store on the `result` channel but never rendered as chat text
   *       (the agent-loop delivers the final summary there) → render it locally, no relay.
   *    2. Answer never reached the store at all → backfill the relay's retained per-prompt
   *       response. Returns true iff it wrote a recovered frame. Idempotent: re-running
   *       finds the text already rendered and no-ops, so repeated loads don't duplicate. */
  async recoverPrompt(promptId: string): Promise<boolean> {
    const p = await this.store.getPrompt(promptId)
    if (!p || p.status === 'running') return false // the live turn owns its own frames
    const frames = await this.store.framesSince(promptId, 0)

    // Case 1 (local, no relay call): final text sits on the result channel, unrendered.
    const pending = unrenderedResultTexts(frames)
    if (pending.length) {
      await this.backfillText(promptId, pending)
      return true
    }
    // Case 2: nothing rendered at all → recover from the relay's retained response.
    if (framesHaveAssistantText(frames)) return false

    let relayTaskId = await this.ctx.storage.get<string>('relayTaskId')
    if (!relayTaskId) relayTaskId = (await this.store.getTask(p.task_id))?.relay_task_id ?? undefined
    if (!relayTaskId) return false

    const ordered = await this.store.listPrompts(p.task_id)
    const idx = ordered.findIndex((row) => row.id === promptId)
    if (idx < 0) return false

    // The relay keeps each prompt's final response in /content. Only trust positional
    // indexing when the prompt counts match (else bail rather than backfill wrong text).
    const content = await rebyteJSON<{ prompts?: Array<{ response?: string }> }>(
      `/tasks/${relayTaskId}/content?include=events`,
      { config: this.rebyteConfig() },
    ).catch(() => null)
    const relayPrompts = content?.prompts
    if (!Array.isArray(relayPrompts) || relayPrompts.length !== ordered.length) return false
    const text = relayPrompts[idx]?.response?.trim()
    if (!text) return false

    await this.backfillText(promptId, [text])
    return true
  }

  /** Cancel the in-flight turn. The running alarm sees 'turn' gone and stops. */
  async cancel(promptId: string): Promise<boolean> {
    const t = await this.ctx.storage.get<TurnState>('turn')
    if (!t || t.promptId !== promptId) return false
    await this.finalize(t, 'canceled')
    return true
  }

  /** Drive one bounded window of the turn, then either finalize or re-arm the alarm. */
  async alarm(): Promise<void> {
    const t = await this.ctx.storage.get<TurnState>('turn')
    if (!t) return // canceled / already finalized
    const config = this.rebyteConfig()

    try {
      if (!t.submitted) {
        // One relay task per SESSION (not per turn): the first turn creates it; every
        // follow-up appends its prompt to that same task so the hosted agent keeps the
        // conversation context (prior search/verify). Without this each turn span a fresh
        // relay task with zero memory — "验价第①个" couldn't continue the earlier search.
        let relayTaskId = await this.ctx.storage.get<string>('relayTaskId')
        // Recover from a reset DO: the session's relay task is also mirrored on the D1 row.
        if (!relayTaskId) relayTaskId = (await this.store.getTask(t.taskId))?.relay_task_id ?? undefined

        if (!relayTaskId) {
          // First turn: provision the per-user sandbox and create the relay task.
          const ac = await this.agentComputerFor(t.userEmail, t.travelkitToken)
          const relayPrompt = `${REBYTE_INSTRUCTION}\n\n用户需求：\n${t.prompt}`
          const task = await rebyteJSON<{ id: string }>('/tasks', {
            method: 'POST',
            body: JSON.stringify({ prompt: relayPrompt, workspaceId: ac.id }),
            config,
          })
          relayTaskId = task.id
          await this.ctx.storage.put('relayTaskId', relayTaskId)
          await this.store.setTaskRelayId(t.taskId, relayTaskId)
        } else {
          // Follow-up turn: append this prompt to the existing relay task. The red-line
          // instruction was already delivered on turn 1 and persists in the agent's context,
          // so we send the user's prompt alone. /events then streams this latest prompt.
          await rebyteJSON(`/tasks/${relayTaskId}/prompts`, {
            method: 'POST',
            body: JSON.stringify({ prompt: t.prompt }),
            config,
          })
        }
        t.relayTaskId = relayTaskId
        t.submitted = true
        await this.ctx.storage.put('turn', t)
        // Surface this turn's rebyte run so the UI can link to app.rebyte.ai/run/<id>.
        this.frameSeq = await this.maxFrameSeq(t.promptId)
        await this.emit(t.promptId, { __rebyte_run: relayTaskId })
      }

      const done = await this.streamWindow(t, config)
      if (done.terminal) {
        if (done.finalResult) await this.emitTurnText(t, done.finalResult, true)
        return this.finalize(t, this.mapStatus(done.status ?? 'completed'))
      }

      // Window ended without a stream `done`. Ask the relay directly.
      const st = await rebyteJSON<{ status?: string; finalResult?: string }>(`/tasks/${t.relayTaskId}`, { config }).catch(
        () => ({}) as { status?: string; finalResult?: string },
      )
      if (st.status && TERMINAL.has(st.status)) {
        // The relay is terminal — but on delegated turns its events arrive in a tail-burst
        // (delegation tool_use → long gap → tool_result → manager text → `done{finalResult}`),
        // and the status flips a beat BEFORE that text + done reach /events (and before
        // st.finalResult is populated). Finalizing on the bare status here drops the agent's
        // answer — the "second message loads back only halfway then sticks" bug. So once we
        // have neither the streamed text nor a finalResult, drain a few more windows: the
        // reconnect replays this prompt's tail and delivers the `done` (handled above). Bound
        // the drains so a genuinely silent terminal turn still finalizes.
        if (shouldDrainTerminal({ sawText: t.sawText, finalResult: st.finalResult, terminalDrains: t.terminalDrains, now: Date.now(), deadline: t.deadline })) {
          t.terminalDrains++
          await this.ctx.storage.put('turn', t)
          await this.ctx.storage.setAlarm(Date.now() + 100)
          return
        }
        if (st.finalResult) await this.emitTurnText(t, st.finalResult, true)
        return this.finalize(t, this.mapStatus(st.status))
      }

      if (Date.now() >= t.deadline) {
        await this.emit(t.promptId, { __error: `relay 超时（${TURN_TIMEOUT_MS / 1000}s 未结束）` })
        return this.finalize(t, 'failed')
      }

      await this.ctx.storage.put('turn', t) // persist lastRelaySeq / sawText / terminalDrains
      await this.ctx.storage.setAlarm(Date.now() + 100) // continue promptly
    } catch (e: unknown) {
      await this.emit(t.promptId, { __error: e instanceof Error ? e.message : String(e) })
      await this.finalize(t, 'failed')
    }
  }

  /** Stream the relay /events for up to WINDOW_MS, translating new events into frames.
   *  Reconnecting replays from seq 0, so we dedupe by t.lastRelaySeq. Returns terminal info
   *  if a `done` arrived; otherwise {terminal:false} when the window/connection ends. */
  private async streamWindow(
    t: TurnState,
    config: RebyteConfig,
  ): Promise<{ terminal: boolean; status?: string; finalResult?: string }> {
    this.frameSeq = await this.maxFrameSeq(t.promptId)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), WINDOW_MS)
    try {
      const res = await rebyteFetch(`/tasks/${t.relayTaskId}/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: abort.signal,
        config,
      })
      if (res.status === 401 || res.status === 403) {
        await this.emit(t.promptId, { __error: `rebyte 鉴权失败 (${res.status})；检查 REBYTE_API_KEY / 模型授权。` })
        return { terminal: true, status: 'failed' }
      }
      if (!res.ok || !res.body) return { terminal: false }

      // The relay replays from seq 0 on each connect, then sends `done` at the end. But if
      // we connect BEFORE the agent has emitted anything, it sends an immediate empty `done`
      // (lastSeq:-1) — a replay race, NOT the turn ending. Only a `done` preceded by real
      // events on THIS connection is terminal; an empty one means "retry next window".
      // (smoke.ts/multiturn.ts guard the same way.) Without this the first window connects right
      // after POST, takes the empty done as terminal, and finalizes the turn as failed before
      // the agent answers — the UI shows the opening line then stops.
      let rawCount = 0
      for await (const msg of parseSSE(res.body)) {
        if (msg.event === 'done') {
          // Empty replay-race done: back off briefly so the retry loop doesn't hammer the relay
          // while the agent spins up, then let alarm() re-arm and reconnect.
          if (rawCount === 0) { await new Promise((r) => setTimeout(r, 800)); return { terminal: false } }
          const d = isObj(msg.data) ? msg.data : {}
          return {
            terminal: true,
            status: String(d.status ?? ''),
            finalResult: typeof d.finalResult === 'string' ? d.finalResult : undefined,
          }
        }
        if (!isObj(msg.data)) continue
        rawCount++
        const ev = msg.data as RelayEvent
        const seq = typeof ev.seq === 'number' ? ev.seq : t.lastRelaySeq + 1
        if (seq <= t.lastRelaySeq) continue
        t.lastRelaySeq = seq
        await this.translate(t, ev)
      }
      return { terminal: false } // stream closed without done (window timeout or relay close)
    } catch (e) {
      if (abort.signal.aborted) return { terminal: false } // window timer fired — not terminal
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}
