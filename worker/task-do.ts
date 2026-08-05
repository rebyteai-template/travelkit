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
 *             → pause without a deadline when the manager asks the user
 *             → finalize when the relay task is terminal (or on timeout)
 *   answerQuestion() → resume the same blocked relay action → re-arm alarm()
 *
 * Pure fetch: never imports the rebyte-sandbox SDK. Per-user sandbox is looked up by email
 * (agent_computers table), falling back to the legacy single kv.agent_computer. Frame fidelity
 * matches src/frames.ts (assistant tool_use/text, user tool_result).
 *
 * Sub-session replay (REBYTE-ISSUE.md): the agent-loop delegates domain tool calls to a sandbox
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
import { rebyteJSON, rebyteFetch, RebyteError, type RebyteConfig, type FileRef } from '../server/rebyte/client.ts'
import { provisionComputer, seedSandbox, writeClaudeMd, removeStaleArtifacts, applyCredential, SEED_VERSION, type ProvisionedComputer } from './seed.ts'
import { SKILL_REF, toSkillRef } from './skill-ref.ts'
import { ensureAgentConfig, MCP_AGENT_INSTRUCTIONS } from '../server/rebyte/agent-config.ts'
import { shouldDrainTerminal, shouldRetryWindowError, turnExpired, TERMINAL_STATUSES } from './turn-finalize.ts'
import { framesHaveAnswerText, unrenderedResultTexts, normText } from '../server/frame-text.ts'
import { sha256Hex } from '../server/digest.ts'
import {
  isUserQuestionAnswer,
  parseUserQuestionRequest,
  type UserQuestionAnswer,
  type UserQuestionRequest,
} from '../src/user-question.ts'
import type { Env } from './env.ts'

// No model/executor here on purpose: POST /v1/tasks IGNORES both (cctools relay
// `void input.model; void input.executor`). The agent-loop model is resolved org-wide
// from org_settings.agent_loop_model — switch it in the rebyte admin, not in code.
const TURN_TIMEOUT_MS = 240_000 // soft ceiling: past this, only a relay that REPORTS itself alive keeps the turn going
const TURN_HARD_CAP_MS = 900_000 // absolute ceiling, even with the relay alive — a hung task can't pin 'running' forever
const WINDOW_MS = 20_000 // per-alarm streaming window — short enough to never risk eviction
const DEFAULT_API_URL = 'https://api.rebyte.ai/v1'
const TERMINAL = TERMINAL_STATUSES

/** Relay event envelope (live /events + /content?include=events): {seq,eventType,payload}.
 *  `eventKey` is the event's stable identity across relay re-synthesis; when present it —
 *  not seq — is the dedupe key (the relay renumbers seq when a late-visible row inserts
 *  mid-timeline, so a numeric watermark drops renumbered events). */
interface RelayEvent {
  seq?: number
  eventKey?: string
  eventType?: string
  payload?: Record<string, unknown>
}

interface FrameSource {
  subPromptId: string
  eventIndex: number
}

/** The subset of turn state needed while translating relay events. A terminal
 *  prompt can reconstruct this from D1 + relay content to recover delegated
 *  frames after the live TurnState has been deleted. */
interface TranslationState {
  promptId: string
  relayTaskId?: string
  /** Prompt-local frame sequence. Each live/recovery translation owns its allocator,
   *  so concurrent recoverPrompt RPCs for different prompts cannot overwrite it. */
  frameSeq: number
  sawText: boolean
  emittedText: string
  subPromptCursors: Record<string, number>
  waitingForAnswer?: UserQuestionRequest
}

/** The in-flight turn, persisted in DO storage so alarm() resumes idempotently. The
 *  session's relay task id lives separately (DO storage key 'relayTaskId') so it
 *  survives across turns — follow-ups continue that SAME relay task. */
interface TurnState extends TranslationState {
  taskId: string
  prompt: string
  userEmail: string
  /** The caller's travelkit token (from the iframe handoff), seeded into their sandbox on
   *  first turn. Only consumed at provision time; harmless on follow-ups. */
  travelkitToken: string
  /** Relay file refs uploaded this turn — staged into the sandbox at /code/<filename> by the
   *  relay's `files` mechanism (create on first turn, /prompts on follow-ups). */
  files?: FileRef[]
  relayTaskId?: string
  /** Did this turn already submit its prompt to the relay (create or /prompts)?
   *  Guards a retried alarm from double-submitting after a window/eviction. */
  submitted: boolean
  lastRelaySeq: number
  /** Relay eventKeys already translated this turn (persisted with the turn, so a
   *  reconnect replay — which renumbers seq — can never re-emit or drop one).
   *  Absent on turns started before this field existed → seq-gate fallback. */
  seenEventKeys?: Record<string, 1>
  /** Assistant text streamed since the LAST tool_use — i.e. "the answer has arrived".
   *  Reset when a tool_use streams: an opening ack before the delegation must not
   *  count, or the terminal-drain guard is skipped and the turn's whole tail (the
   *  delegated tool_result + final summary) is lost to the finalize race. */
  /** Whitespace-stripped concat of all assistant text emitted this turn, so the
   *  `result` event + final `finalResult` (which echo the same answer on another
   *  channel) are emitted once, not duplicated. */
  /** Consecutive windows where GET /tasks reported terminal but we hadn't yet
   *  drained the relay's trailing text + `done` (which carries the final summary).
   *  The status flips a beat before finalResult populates, so we drain a few more
   *  windows to catch the tail before finalizing. */
  terminalDrains: number
  /** Per delegated sub-session prompt id → how many of its events we've already
   *  replayed into this prompt's frames. We re-fetch each window and replay only
   *  the NEW events: the relay can persist a sub-session's search-result compact a
   *  beat AFTER the delegation result signals done, so a one-shot replay (the old
   *  behavior) raced and dropped the flight card in prod. Cursor = idempotent catch-up. */
  deadline: number
  /** Absolute cap — even an alive relay can't run the turn past this. */
  hardDeadline: number
  /** Consecutive alarm-window failures (reset on any successful window). */
  errors: number
  /** A top-level manager question parks the relay turn until /answer resumes the
   *  SAME action. While present, alarm polling is intentionally suspended and
   *  the human wait does not consume the execution deadline. */
}

interface CachedAgentComputer {
  id: string
  sandboxId?: string
}

export class TaskDO extends DurableObject<Env> {
  private store: Store = createD1Store(this.env.DB)

  private rebyteConfig(): RebyteConfig {
    return { apiUrl: this.env.REBYTE_API_URL ?? DEFAULT_API_URL, apiKey: this.env.REBYTE_API_KEY }
  }

  // ── frame emission (durable seq from D1 so resumed ticks never collide) ──
  private emit(t: TranslationState, data: unknown, source?: FrameSource): Promise<boolean> {
    return this.store.appendFrame(t.promptId, ++t.frameSeq, data, source)
  }
  private async maxFrameSeq(promptId: string): Promise<number> {
    const row = await this.env.DB.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM frames WHERE prompt_id = ?`)
      .bind(promptId)
      .first<{ m: number }>()
    return row?.m ?? 0
  }
  private async emitText(t: TranslationState, text: string): Promise<void> {
    if (!text.trim()) return
    await this.emit(t, { type: 'assistant', message: { content: [{ type: 'text', text }] } })
  }
  /** Emit assistant text and record it in t.emittedText. When `dedupe`, skip text the
   *  turn has already shown — the relay echoes the final answer on both the `text` and
   *  `result`/`finalResult` channels, so without this the verify/order summary doubles
   *  (or, pre-fix, was DROPPED because we only emitted finalResult when no text existed). */
  private async emitTurnText(t: TurnState, text: string, dedupe: boolean): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    if (dedupe && t.emittedText.includes(normText(trimmed))) return
    await this.emitText(t, trimmed)
    t.emittedText += normText(trimmed)
    t.sawText = true
  }
  private async emitToolUse(
    t: TranslationState,
    id: string,
    name: string,
    input: unknown,
    source?: FrameSource,
  ): Promise<void> {
    await this.emit(
      t,
      { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: input ?? {} }] } },
      source,
    )
  }
  private async emitToolResult(
    t: TranslationState,
    toolUseId: string,
    output: unknown,
    source?: FrameSource,
  ): Promise<void> {
    const content = typeof output === 'string' ? output : JSON.stringify(output ?? '')
    await this.emit(
      t,
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } },
      source,
    )
  }

  private async translateToolUse(
    t: TranslationState,
    p: Record<string, unknown>,
    source?: FrameSource,
  ): Promise<void> {
    const name = String(p.name ?? p.tool_name ?? '')
    const id = String(p.id ?? p.tool_id ?? '') || crypto.randomUUID()
    await this.emitToolUse(t, id, name, p.input ?? p.params ?? {}, source)
    // PublicView exposes a delegated action's subPromptId on tool_use as soon
    // as the action starts. Register it here instead of waiting for the
    // synthesized tool_result: a late status change can insert tool_result at
    // a seq already occupied by final text, so seq de-duplication may never
    // deliver that event. catchUpSubPrompts() will keep pulling until the
    // delegated prompt has flushed its structured domain results.
    const subPromptId = typeof p.subPromptId === 'string' ? p.subPromptId : ''
    if (subPromptId) {
      if (!(subPromptId in t.subPromptCursors)) t.subPromptCursors[subPromptId] = 0
      await this.replaySubPrompt(t, subPromptId)
    }
    // A tool call after any prior text means that text was an ack, not the answer —
    // the answer is whatever the manager says AFTER this tool resolves.
    t.sawText = false
  }

  private async translateToolResult(
    t: TranslationState,
    p: Record<string, unknown>,
    source?: FrameSource,
  ): Promise<void> {
    await this.emitToolResult(
      t,
      String(p.id ?? p.tool_id ?? ''),
      p.output ?? p.content,
      source,
    )
    const subPromptId = typeof p.subPromptId === 'string' ? p.subPromptId : ''
    if (subPromptId) {
      if (!(subPromptId in t.subPromptCursors)) t.subPromptCursors[subPromptId] = 0
      await this.replaySubPrompt(t, subPromptId)
    }
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
      case 'ask_user_question': {
        const question = parseUserQuestionRequest(p)
        if (!question) throw new Error('rebyte ask_user_question event is malformed')
        t.waitingForAnswer = question
        t.sawText = false
        // Persist the resume ids before exposing the frame to the browser. A
        // very fast click can then never race ahead of the durable waiting state.
        await this.ctx.storage.put('turn', t)
        try {
          await this.emit(t, { __ask_user_question: question })
        } catch (error) {
          delete t.waitingForAnswer
          await this.ctx.storage.put('turn', t)
          throw error
        }
        // State and frame are durable now. If this status write fails, keep the
        // waiting state: the retried alarm below converges the D1 status instead
        // of forgetting an action that is still blocked in Relay.
        await this.store.setPromptStatus(t.promptId, 'waiting_for_answer')
        return
      }
      case 'tool_use': {
        await this.translateToolUse(t, p)
        return
      }
      case 'tool_result': {
        await this.translateToolResult(t, p)
        return
      }
      default:
        await this.emit(t, { __relay: type || 'unknown', payload: p })
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
  /** Replay a delegated sub-session's tool_use/tool_result into this prompt's frames,
   *  resuming from the cursor so re-calls each window only emit NEW events (the search
   *  compact often persists after the delegation result, so we must re-fetch). */
  private async replaySubPrompt(t: TranslationState, subPromptId: string): Promise<void> {
    if (!t.relayTaskId) return
    const data = await rebyteJSON<{ events?: RelayEvent[] }>(
      `/tasks/${t.relayTaskId}/prompts/${subPromptId}/events`,
      { config: this.rebyteConfig() },
    ).catch(() => null)
    if (!data?.events) return
    const durableStart = await this.store.getSubPromptCursor(t.promptId, subPromptId)
    const start = Math.max(t.subPromptCursors[subPromptId] ?? 0, durableStart)
    if (data.events.length <= start) return
    for (let eventIndex = start; eventIndex < data.events.length; eventIndex++) {
      const ev = data.events[eventIndex]
      if (!ev) continue
      const type = String(ev.eventType ?? '')
      if (type === 'tool_use' || type === 'tool_result') {
        const payload = isObj(ev.payload) ? ev.payload : {}
        const source = { subPromptId, eventIndex }
        if (type === 'tool_use') await this.translateToolUse(t, payload, source)
        else await this.translateToolResult(t, payload, source)
      }
    }
    t.subPromptCursors[subPromptId] = data.events.length
    await this.store.setSubPromptCursor(t.promptId, subPromptId, data.events.length)
  }

  /** Re-pull every known delegated sub-session so late-persisted events (esp. the
   *  flight search compact) reach the frames. Idempotent via the per-sub cursor. */
  private async catchUpSubPrompts(t: TranslationState): Promise<void> {
    for (const subPromptId of Object.keys(t.subPromptCursors)) {
      await this.replaySubPrompt(t, subPromptId)
    }
  }

  private mapStatus(relayStatus: string): string {
    if (relayStatus === 'succeeded' || relayStatus === 'completed') return 'completed'
    if (relayStatus === 'canceled' || relayStatus === 'cancelled') return 'canceled'
    return 'failed'
  }

  /** Is `t` still the turn this DO is driving? False after a cancel() (deleted 'turn') or a
   *  newer runTurn() (replaced it) landed during one of our awaits — the in-flight alarm's
   *  in-memory copy is then stale and must NOT write itself back (that "resurrects" a
   *  canceled turn, or clobbers the newer turn's state). */
  private async isCurrentTurn(t: TurnState): Promise<boolean> {
    const cur = await this.ctx.storage.get<TurnState>('turn')
    return !!cur && cur.promptId === t.promptId
  }

  /** Persist `t` only while it still owns the DO (see isCurrentTurn). Returns false —
   *  caller must stop driving this turn — when a cancel/newer turn won the race. */
  private async persistTurnIfCurrent(t: TurnState): Promise<boolean> {
    if (!(await this.isCurrentTurn(t))) return false
    await this.ctx.storage.put('turn', t)
    return true
  }

  private async finalize(t: TurnState, status: string): Promise<void> {
    await this.store.finishPrompt(t.promptId, status) // no-op if already non-running
    // Only the CURRENT turn may close out the task. A stale copy (its turn was canceled or
    // replaced during an await) still records its own prompt's terminal status above, but
    // must not overwrite the task status (canceled → completed was a real bug: the post-
    // cancel drain finalized 'completed' over the user's stop) or touch the newer turn's
    // state/alarm.
    if (!(await this.isCurrentTurn(t))) return
    await this.store.setTaskStatus(t.taskId, status)
    await this.ctx.storage.delete('turn')
    await this.ctx.storage.deleteAlarm()
  }

  /** A terminal signal arrived (stream `done` or GET /tasks status). The relay flips
   *  terminal a beat before the tail events (delegated tool_result + manager summary)
   *  are readable from /events — finalizing right away loses them. If the answer
   *  hasn't streamed yet, re-arm the alarm to drain another window (the reconnect
   *  replays the now-complete tail); else finalize, rendering finalResult if the
   *  text never arrived on the stream. BOTH terminal paths must go through this —
   *  the stream `done` used to finalize unconditionally and dropped tails too. */
  private async drainOrFinalize(t: TurnState, status: string, finalResult?: string): Promise<void> {
    if (shouldDrainTerminal({ sawText: t.sawText, terminalDrains: t.terminalDrains, now: Date.now(), hardDeadline: t.hardDeadline ?? t.deadline })) {
      t.terminalDrains++
      if (!(await this.persistTurnIfCurrent(t))) return
      await this.ctx.storage.setAlarm(Date.now() + 100)
      return
    }
    if (finalResult) await this.emitTurnText(t, finalResult, true)
    return this.finalize(t, this.mapStatus(status))
  }

  /** Per-user sandbox, provisioned lazily on first use. Returns the user's cached
   *  agent_computers row; if none, provisions a fresh sandbox via the rebyte API, seeds
   *  travelkit into it (both pure fetch), persists it, and returns it. Concurrent first
   *  turns race on INSERT OR IGNORE — the loser's VM is orphaned (minor), both then use the
   *  winner's row. */
  private async agentComputerFor(email: string, travelkitToken: string, systemPrompt?: string): Promise<CachedAgentComputer> {
    const tokenHash = travelkitToken ? await sha256Hex(travelkitToken) : ''
    const existing = await this.store.getAgentComputer(email)
    let result: CachedAgentComputer
    if (existing?.id) {
      // Hot-refresh of a reused sandbox (same VM, no reprovision), best-effort — a write failure
      // just leaves the old state, surfacing as an auth/skill error:
      //  · seed stale — a deploy bumped SEED_VERSION (VM system prompt / credential format / stale
      //    cleanup changed); re-write /code/CLAUDE.md + purge the retired skill tree. The skill itself
      //    is refreshed by the relay (skills v3 re-clone), not here. Also refreshes the credential
      //    when we have a token.
      //  · token rotated — the user re-logged-in with a new token; rewrite just the credential.
      const seedStale = existing.seedVersion !== SEED_VERSION
      const tokenChanged = !!travelkitToken && tokenHash !== existing.tokenHash
      if (seedStale || tokenChanged) {
        try {
          const ac = await rebyteJSON<ProvisionedComputer>(`/agent-computers/${existing.id}`, { config: this.rebyteConfig() })
          if (ac.sandboxId && ac.sandboxBaseUrl && ac.sandboxApiKey) {
            if (seedStale) {
              if (travelkitToken) await seedSandbox(ac, travelkitToken)
              else await writeClaudeMd(ac) // no token at hand → refresh the VM system prompt only, keep credential
              await removeStaleArtifacts(ac) // really delete legacy files (retired skill tree, .mcp.json, settings.json) via envd gRPC Remove
              await this.store.setAgentComputerSeed(email, travelkitToken ? tokenHash : (existing.tokenHash ?? ''), SEED_VERSION)
            } else {
              await applyCredential(ac, travelkitToken)
              await this.store.setAgentComputerTokenHash(email, tokenHash)
            }
          }
        } catch { /* keep old state; user sees an auth/skill error if it's stale */ }
      }
      result = { id: existing.id, sandboxId: existing.sandboxId ?? undefined }
    } else {
      const ac = await provisionComputer(this.rebyteConfig(), `tripdesk:${email || 'anon'}`)
      await seedSandbox(ac, travelkitToken)
      await this.store.saveAgentComputer(email, ac.id, ac.sandboxId ?? null, tokenHash, SEED_VERSION)
      // Re-read so concurrent provisioners converge on the same (winning) row.
      const canonical = await this.store.getAgentComputer(email)
      result = canonical?.id ? { id: canonical.id, sandboxId: canonical.sandboxId ?? undefined } : { id: ac.id, sandboxId: ac.sandboxId }
    }

    // Configure the workspace's front-line MANAGER (agent-loop): Kitty domain system prompt
    // (cctools appends it after the base prompt) + web_search tool DISABLED, so it delegates flight
    // work to the sandbox skill instead of web-searching/fabricating. Replaces the old per-prompt
    // MANAGER_ROUTE_HINT (REBYTE-NEEDS.md §3 — the /v1 per-workspace config hook went live 2026-06-16).
    // Runs once per session (first turn only; follow-ups reuse relayTaskId). Idempotent (GET→PATCH
    // drift) and best-effort: on failure the manager falls back to its generic base prompt (soft
    // degradation), so we log and continue rather than failing the turn.
    try {
      const changed = await ensureAgentConfig(result.id, this.rebyteConfig(), systemPrompt)
      if (changed.length) console.log(`[task-do] manager config → ${result.id}: ${changed.join(', ')}`)
    } catch (e) { console.log(`[task-do] ensureAgentConfig failed (non-fatal): ${(e as Error).message}`) }
    return result
  }

  // ── RPC surface (called from the Worker via env.TASK_DO.getByName(taskId)) ──
  /** Persist the turn intent and fire the alarm. Returns immediately; the alarm drives it. */
  async runTurn(taskId: string, promptId: string, prompt: string, userEmail = '', travelkitToken = '', files?: FileRef[]): Promise<void> {
    const t: TurnState = {
      taskId,
      promptId,
      prompt,
      userEmail,
      travelkitToken,
      files,
      submitted: false,
      lastRelaySeq: 0,
      frameSeq: 0,
      sawText: false,
      emittedText: '',
      terminalDrains: 0,
      subPromptCursors: {},
      deadline: Date.now() + TURN_TIMEOUT_MS,
      hardDeadline: Date.now() + TURN_HARD_CAP_MS,
      errors: 0,
    }
    await this.ctx.storage.put('turn', t)
    await this.ctx.storage.setAlarm(Date.now())
  }

  /** Resume the exact relay action that parked this turn. The browser supplies
   *  only the answer; relay ids come from the DO's durable waiting state so a
   *  caller cannot redirect an answer to another message/action. */
  async answerQuestion(promptId: string, answer: unknown): Promise<{ ok: boolean; reason?: string }> {
    const t = await this.ctx.storage.get<TurnState>('turn')
    if (!t || t.promptId !== promptId || !t.relayTaskId || !t.waitingForAnswer) {
      return { ok: false, reason: 'not_waiting' }
    }
    if (!isUserQuestionAnswer(answer)) return { ok: false, reason: 'invalid_answer' }

    const question = t.waitingForAnswer
    const actionId = Number(question.actionId)
    if (!Number.isSafeInteger(actionId) || actionId < 0) {
      throw new Error('rebyte ask_user_question actionId is invalid')
    }

    try {
      await rebyteJSON(`/tasks/${t.relayTaskId}/answer`, {
        method: 'POST',
        body: JSON.stringify({
          messageId: question.messageId,
          actionId,
          answer: answer as UserQuestionAnswer,
        }),
        config: this.rebyteConfig(),
      })
    } catch (error) {
      // If the relay accepted the answer but its response was lost, a retry sees
      // no blocked action. Continue polling: the same action is already resumed.
      if (!(error instanceof RebyteError) || error.status !== 409) throw error
    }

    t.frameSeq = await this.maxFrameSeq(t.promptId)
    try {
      await this.emit(t, {
        __ask_user_answer: {
          actionId: question.actionId,
          messageId: question.messageId,
          answer: answer as UserQuestionAnswer,
        },
      })
    } catch (error) {
      // The relay is already resumed; a display-frame failure must not strand it.
      console.warn('[task-do] failed to persist ask_user_answer frame:', error)
    }

    // Ownership re-check before resuming: the /answer + frame writes above are await
    // points — a cancel() may have finalized this turn meanwhile, and flipping the
    // prompt back to 'running' + re-persisting the turn would resurrect it.
    if (!(await this.isCurrentTurn(t))) return { ok: false, reason: 'not_waiting' }
    await this.store.setPromptStatus(t.promptId, 'running')
    delete t.waitingForAnswer
    t.deadline = Date.now() + TURN_TIMEOUT_MS
    t.hardDeadline = Date.now() + TURN_HARD_CAP_MS
    t.errors = 0
    await this.ctx.storage.put('turn', t)
    await this.ctx.storage.setAlarm(Date.now())
    return { ok: true }
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

  /** Append assistant text frames to a terminal prompt with a prompt-local sequence.
   *  Targets only terminal prompts, so it never races the running turn's frame writer. */
  private async backfillText(promptId: string, texts: string[]): Promise<void> {
    let seq = await this.maxFrameSeq(promptId)
    for (const text of texts) {
      await this.store.appendFrame(promptId, ++seq, { type: 'assistant', message: { content: [{ type: 'text', text }] } })
    }
  }

  /** Make a terminal prompt converge to the same frames the live stream should have
   *  produced. Text can be recovered from the result/final response; delegated
   *  structure is recovered by discovering stable subPromptIds in the retained parent
   *  events and replaying those prompts with durable source cursors. */
  async recoverPrompt(promptId: string): Promise<boolean> {
    const p = await this.store.getPrompt(promptId)
    if (!p || p.status === 'running' || p.status === 'waiting_for_answer') {
      return false // the live turn owns its own frames
    }
    const frames = await this.store.framesSince(promptId, 0)
    let changed = false

    // Final text may already be local on the result channel but not represented as a
    // chat frame. Fix that without a relay request.
    const pending = unrenderedResultTexts(frames)
    if (pending.length) {
      await this.backfillText(promptId, pending)
      changed = true
    }

    const hasAnswerText = framesHaveAnswerText(frames) || pending.length > 0
    const hasDelegationToolUse = frames.some((frame) => {
      if (!isObj(frame.data) || !isObj(frame.data.message)) return false
      const content = frame.data.message.content
      if (!Array.isArray(content)) return false
      return content.some(
        (block) =>
          isObj(block)
          && block.type === 'tool_use'
          && typeof block.name === 'string'
          && block.name.startsWith('coding_agent__'),
      )
    })
    let subPromptIds = await this.store.listSubPromptIds(promptId)
    const needsSubPromptDiscovery = hasDelegationToolUse && subPromptIds.length === 0
    const needsRelayResponse = !hasAnswerText
    if (!subPromptIds.length && !needsSubPromptDiscovery && !needsRelayResponse) {
      if (changed) await this.unfailRecovered(p)
      return changed
    }

    let relayTaskId = await this.ctx.storage.get<string>('relayTaskId')
    if (!relayTaskId) relayTaskId = (await this.store.getTask(p.task_id))?.relay_task_id ?? undefined
    if (!relayTaskId) {
      if (changed) await this.unfailRecovered(p)
      return changed
    }

    const ordered = await this.store.listPrompts(p.task_id)
    const idx = ordered.findIndex((row) => row.id === promptId)
    if (idx < 0) {
      if (changed) await this.unfailRecovered(p)
      return changed
    }

    let relayPrompt: { response?: string; events?: RelayEvent[] } | undefined
    if (needsSubPromptDiscovery || needsRelayResponse) {
      // Only trust positional matching when prompt counts agree. The local prompt id
      // and relay prompt id are intentionally different namespaces.
      const content = await rebyteJSON<{
        prompts?: Array<{ response?: string; events?: RelayEvent[] }>
      }>(`/tasks/${relayTaskId}/content?include=events`, {
        config: this.rebyteConfig(),
      }).catch(() => null)
      const relayPrompts = content?.prompts
      if (Array.isArray(relayPrompts) && relayPrompts.length === ordered.length) {
        relayPrompt = relayPrompts[idx]
      }
    }

    if (needsSubPromptDiscovery && relayPrompt?.events) {
      subPromptIds = [
        ...new Set(
          relayPrompt.events.flatMap((event) => {
            const id = event.payload?.subPromptId
            return typeof id === 'string' && id ? [id] : []
          }),
        ),
      ]
    }

    if (subPromptIds.length) {
      const before = await this.maxFrameSeq(promptId)
      const replayState: TranslationState = {
        promptId,
        relayTaskId,
        frameSeq: before,
        sawText: false,
        emittedText: '',
        subPromptCursors: {},
      }
      for (const subPromptId of subPromptIds) {
        await this.replaySubPrompt(replayState, subPromptId)
      }
      if ((await this.maxFrameSeq(promptId)) > before) changed = true
    }

    if (needsRelayResponse) {
      const text = relayPrompt?.response?.trim()
      if (text) {
        await this.backfillText(promptId, [text])
        changed = true
      }
    }

    if (changed) await this.unfailRecovered(p)
    return changed
  }

  /** A 'failed' verdict was premature if the answer later proved recoverable (seen in prod:
   *  the 240s timeout finalized the turn, then the relay's result still landed). Flip the
   *  prompt back to 'completed'; the task too, but only when this is its LATEST turn — a
   *  newer turn's status must keep owning the sidebar. Canceled prompts stay canceled. */
  private async unfailRecovered(p: { id: string; task_id: string; status: string }): Promise<void> {
    if (p.status !== 'failed') return
    await this.store.setPromptStatus(p.id, 'completed')
    const all = await this.store.listPrompts(p.task_id)
    if (all[all.length - 1]?.id === p.id) await this.store.setTaskStatus(p.task_id, 'completed')
  }

  /** Cancel the in-flight turn. The running alarm sees 'turn' gone and stops. */
  async cancel(promptId: string): Promise<boolean> {
    const t = await this.ctx.storage.get<TurnState>('turn')
    if (!t || t.promptId !== promptId) return false
    // Stop the relay-side run too — v1 POST /tasks/:id/cancel kills the agent loop AND any
    // delegated sandbox prompt, and the task accepts new /prompts afterwards (so the session
    // continues). Without this the relay kept running the "canceled" turn: its answer landed
    // in the frames anyway and the next follow-up raced it. Best-effort with a short timeout:
    // an unreachable relay must not block the local cancel — worst case that run leaks and
    // burns tokens, but this session stops tracking it either way.
    if (t.submitted && t.relayTaskId) {
      await rebyteJSON(`/tasks/${t.relayTaskId}/cancel`, {
        method: 'POST',
        config: this.rebyteConfig(),
        signal: AbortSignal.timeout(5000),
      }).catch((e) => console.log(`[task-do] relay cancel failed (non-fatal): ${(e as Error).message}`))
    }
    await this.finalize(t, 'canceled')
    return true
  }

  /** Drive one bounded window of the turn, then either finalize or re-arm the alarm. */
  async alarm(): Promise<void> {
    const t = await this.ctx.storage.get<TurnState>('turn')
    if (!t) return // canceled / already finalized
    if (t.waitingForAnswer) {
      // A failed first status write must converge on alarm retry. Once D1 says
      // waiting, the browser SSE exits and produces no reads until answerQuestion().
      await this.store.setPromptStatus(t.promptId, 'waiting_for_answer')
      return
    }
    const config = this.rebyteConfig()

    try {
      t.frameSeq = await this.maxFrameSeq(t.promptId)
      if (!t.submitted) {
        // One relay task per SESSION (not per turn): the first turn creates it; every
        // follow-up appends its prompt to that same task so the hosted agent keeps the
        // conversation context (prior search/verify). Without this each turn span a fresh
        // relay task with zero memory — "验价第①个" couldn't continue the earlier search.
        let relayTaskId = await this.ctx.storage.get<string>('relayTaskId')
        // Recover from a reset DO: the session's relay task is also mirrored on the D1 row.
        if (!relayTaskId) relayTaskId = (await this.store.getTask(t.taskId))?.relay_task_id ?? undefined

        if (!relayTaskId) {
          // First turn: provision + configure the per-user sandbox, then create the relay task.
          // agentComputerFor() sets the workspace's manager config (Kitty system prompt + web_search
          // OFF) so the front-line agent-loop delegates flight work to the sandbox instead of
          // web-searching/fabricating — no per-prompt routing line needed (REBYTE-NEEDS.md §3). The
          // booking red-lines, credential handling and skill workflow live in the VM system prompt
          // (/code/CLAUDE.md, seeded by seed.ts) + the simplifly-flyai-skill skill, which the delegated
          // sandbox agent reads. So we POST the user's prompt verbatim.
          //
          // The GLOBAL debug config (one shared skill-ref + manager prompt, edited by the admin,
          // applied to EVERY user) is read server-side here — NOT taken from the request — so all OPs
          // get the same. Empty field → the built-in default (SKILL_REF / AGENT_INSTRUCTIONS).
          //   · manager prompt → agentComputerFor → ensureAgentConfig (PATCH agent_instructions).
          //   · skill ref → `skills:[…]` on this first-turn create: the relay (skills v3) git-clones it
          //     into the workspace VM (ac.id = the SAME VM we seeded). Follow-ups omit skills → one
          //     clone per session; a new session re-clones latest.
          const cfg = await this.store.getConfig()
          // Route comes from the task row's stamp (set once at POST /tasks), NOT from
          // cfg.routeMode: the config is "next new session" semantics and may have
          // flipped between intake and this first alarm — the stamp cannot lie, and it
          // is the same value /content reports to the client.
          const routeMode = (await this.store.getTask(t.taskId))?.route_mode ?? ''
          let task: { id: string }
          if (routeMode === 'mcp') {
            // MCP-direct mode (task route_mode='mcp'): the SAME per-user agent computer as the
            // VM route — one provisioning path (seeding .simplifly.env into the VM is harmless
            // here). `workspaceId: ac.id` is the identity anchor: the relay stamps it onto every
            // remote MCP call as X-Rebyte-Workspace-Id, and the flight MCP keys its per-employee
            // credential lookup on it (travelkit /internal resolves ac_id → tenant). No `skills`
            // on this route — the flight tools come from the org profile's connector set. The
            // workspace carries route-specific manager instructions: MCP sessions get the minimal
            // MCP_AGENT_INSTRUCTIONS (tool procedure lives in the tools' own descriptions), not
            // the VM route's delegate-to-sandbox text; the prompt itself rides bare.
            const ac = await this.agentComputerFor(t.userEmail, t.travelkitToken, cfg.systemPrompt.trim() ? cfg.systemPrompt : MCP_AGENT_INSTRUCTIONS)
            task = await rebyteJSON<{ id: string }>('/tasks', {
              method: 'POST',
              body: JSON.stringify({ prompt: t.prompt, workspaceId: ac.id, actor: t.userEmail, ...(t.files?.length ? { files: t.files } : {}) }),
              config,
            })
          } else {
            const ac = await this.agentComputerFor(t.userEmail, t.travelkitToken, cfg.systemPrompt)
            task = await rebyteJSON<{ id: string }>('/tasks', {
              method: 'POST',
              // `files` (if any) ride here so the relay stages them into the sandbox /code/<filename>
              // before the first turn runs; the wire prompt's attachment suffix points the manager at them.
              // `actor` names the END USER behind this task (t.userEmail IS `<org>:<uid>`). The relay
              // treats it as an opaque identifier and hands it back to our /oauth/token when the agent
              // reaches for an MCP tool — that is how the tool call gets THIS employee's credential
              // instead of an org-wide one. Relay keys are org-scoped, so nothing else carries a person.
              body: JSON.stringify({ prompt: t.prompt, workspaceId: ac.id, actor: t.userEmail, skills: [toSkillRef(cfg.skillRef.trim() || SKILL_REF)], ...(t.files?.length ? { files: t.files } : {}) }),
              config,
            })
          }
          relayTaskId = task.id
          await this.ctx.storage.put('relayTaskId', relayTaskId)
          await this.store.setTaskRelayId(t.taskId, relayTaskId)
        } else {
          // Follow-up turn: append this prompt to the existing relay task. We send the
          // user's prompt alone. /events then streams this latest prompt.
          await rebyteJSON(`/tasks/${relayTaskId}/prompts`, {
            method: 'POST',
            // Follow-up files stage into the SAME sandbox before this prompt runs. `actor` rides on
            // every turn, not just the first: a session outlives any one credential exchange, so the
            // follow-up that actually calls a tool has to carry the identity too.
            body: JSON.stringify({ prompt: t.prompt, actor: t.userEmail, ...(t.files?.length ? { files: t.files } : {}) }),
            config,
          })
        }
        t.relayTaskId = relayTaskId
        t.submitted = true
        // The submit RPCs above are await points — a cancel() may have finalized this turn
        // meanwhile. It skipped the relay-side cancel (we weren't marked submitted yet), so
        // the prompt that just reached the relay is orphaned: stop it there before bowing
        // out. (A NEWER turn owning the DO shares this relayTaskId — a task-level cancel
        // would kill its run too, so only compensate when the turn is gone, not replaced.)
        const cur = await this.ctx.storage.get<TurnState>('turn')
        if (!cur) {
          await rebyteJSON(`/tasks/${relayTaskId}/cancel`, { method: 'POST', config }).catch(() => {})
          return
        }
        if (cur.promptId !== t.promptId) return
        await this.ctx.storage.put('turn', t)
        // Surface this turn's rebyte run so the UI can link to app.rebyte.ai/run/<id>.
        await this.emit(t, { __rebyte_run: relayTaskId })
      }

      const done = await this.streamWindow(t, config)
      t.errors = 0 // the window ran — whatever failed before, the relay is reachable again
      if (done.awaitingUser) {
        await this.persistTurnIfCurrent(t)
        return
      }
      // Re-pull delegated sub-sessions every window before we might finalize: their search
      // compact can land after the delegation result, and a one-shot replay dropped it (no card).
      await this.catchUpSubPrompts(t)
      // Either terminal signal — the stream's `done` or a terminal GET /tasks status —
      // can arrive before the tail events are readable, so both go through the same
      // drain-then-finalize gate. (The stream `done` used to finalize unconditionally:
      // that's how an ack-opening delegated turn lost its tool_result/cards even when
      // the answer text was rescued via finalResult.)
      if (done.terminal) {
        return this.drainOrFinalize(t, done.status ?? 'completed', done.finalResult)
      }

      // Window ended without a stream `done`. Ask the relay directly.
      const st = await rebyteJSON<{ status?: string; finalResult?: string }>(`/tasks/${t.relayTaskId}`, { config }).catch(
        () => ({}) as { status?: string; finalResult?: string },
      )
      if (st.status && TERMINAL.has(st.status)) {
        return this.drainOrFinalize(t, st.status, st.finalResult)
      }

      // Two-tier expiry: past the soft deadline a relay that POSITIVELY reports the task
      // alive keeps the turn going (delegated turns routinely run past 4 min); the hard
      // cap bounds everything. An unreachable relay gets no extension.
      if (turnExpired({ now: Date.now(), deadline: t.deadline, hardDeadline: t.hardDeadline ?? t.deadline, relayStatus: st.status })) {
        await this.emit(t, { __error: '处理超时，已停止等待。结果可能稍后就绪——刷新页面可找回。' })
        return this.finalize(t, 'failed')
      }

      // persist lastRelaySeq / sawText / terminalDrains — unless a cancel/newer turn took
      // the DO during this window; then this alarm chain simply ends here.
      if (!(await this.persistTurnIfCurrent(t))) return
      await this.ctx.storage.setAlarm(Date.now() + 100) // continue promptly
    } catch (e: unknown) {
      // A transient hiccup (relay fetch, D1 write) must not kill a turn whose agent is
      // still running — finalizing 'failed' here tells the browser `done`, the loading
      // bubble vanishes, and the late answer has no push channel (only a manual refresh
      // recovers it via /content's self-heal). Retry with backoff; give up only after
      // MAX_WINDOW_ERRORS consecutive failures or past the hard deadline.
      const errors = (t.errors ?? 0) + 1
      if (shouldRetryWindowError({ errors, now: Date.now(), hardDeadline: t.hardDeadline ?? t.deadline })) {
        t.errors = errors
        if (!(await this.persistTurnIfCurrent(t))) return
        await this.ctx.storage.setAlarm(Date.now() + 1500 * errors)
        return
      }
      // A relay 5xx / gateway outage is transient and not the user's fault — show a calm retry
      // message, not a raw `HTTP 503` (or, pre-fix, the gateway's HTML page).
      const friendly = e instanceof RebyteError && e.status >= 500
        ? `上游服务暂时不可用（${e.status}），请稍后重试。`
        : e instanceof Error ? e.message : String(e)
      await this.emit(t, { __error: friendly })
      await this.finalize(t, 'failed')
    }
  }

  /** Stream the relay /events for up to WINDOW_MS, translating new events into frames.
   *  Reconnecting replays from seq 0, so we dedupe by t.lastRelaySeq. Returns terminal info
   *  if a `done` arrived; otherwise {terminal:false} when the window/connection ends. */
  private async streamWindow(
    t: TurnState,
    config: RebyteConfig,
  ): Promise<{ terminal: boolean; awaitingUser?: boolean; status?: string; finalResult?: string }> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), WINDOW_MS)
    try {
      const res = await rebyteFetch(`/tasks/${t.relayTaskId}/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: abort.signal,
        config,
      })
      if (res.status === 401 || res.status === 403) {
        await this.emit(t, { __error: `rebyte 鉴权失败 (${res.status})；检查 REBYTE_API_KEY / 模型授权。` })
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
        if (typeof ev.eventKey === 'string' && ev.eventKey) {
          // Identity dedupe: survives reconnect replays AND relay-side seq
          // renumbering (late-visible rows insert mid-timeline upstream).
          if (t.seenEventKeys?.[ev.eventKey]) continue
          ;(t.seenEventKeys ??= {})[ev.eventKey] = 1
        } else {
          // Legacy relay without eventKey: the old high-water gate.
          const seq = typeof ev.seq === 'number' ? ev.seq : t.lastRelaySeq + 1
          if (seq <= t.lastRelaySeq) continue
          t.lastRelaySeq = seq
        }
        await this.translate(t, ev)
        if (t.waitingForAnswer) return { terminal: false, awaitingUser: true }
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
