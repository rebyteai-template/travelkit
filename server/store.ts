/**
 * Storage contract. The whole app talks to this async `Store` interface and never
 * to a concrete database — so the driver swaps freely (the template's "switch the
 * DB whenever" goal; mirrors adits). It is ASYNC because the production targets are
 * async: Cloudflare D1 (primary deploy + local dev via `wrangler dev`), Postgres
 * (AWS RDS), MySQL (GCP Cloud SQL). Add a `store-<driver>.ts` and call sites don't change.
 *
 * Three tables mirror adits' turn model:
 *   tasks   — one booking conversation (keyed to a rebyte relay task id)
 *   prompts — one agent turn within a task
 *   frames  — one stream-json line of agent output, ordered by seq
 */
export interface Task {
  id: string
  project_id: string
  status: string
  relay_task_id: string | null
  user_email: string | null
  created_at: string
  /** Route that created this session: '' = sandbox VM + skill, 'mcp' = MCP-direct.
   *  Stamped once at creation from the global config (which is "next new session"
   *  semantics) — this row is the per-session truth task-do and the UI gate read. */
  route_mode: string
}

/** Lightweight conversation row for the per-user session list (sidebar). */
export interface TaskSummary {
  id: string
  status: string
  created_at: string
  title: string
}

/** A user's pre-seeded sandbox (agent_computers row). */
export interface AgentComputerRow {
  id: string
  sandboxId: string | null
  /** sha256 of the travelkit token last written into this sandbox's .simplifly.env; null for rows
   *  created before token hot-refresh existed. Drives the "token rotated → rewrite" check. */
  tokenHash: string | null
  /** SEED_VERSION (content stamp) of the skill tree last pushed into this sandbox; null for rows
   *  created before seed-version tracking. Drives the "skill changed → re-seed" check. */
  seedVersion: string | null
}

export interface Prompt {
  id: string
  task_id: string
  prompt: string
  status: string
  created_at: string
  completed_at: string | null
}
export interface Frame {
  seq: number
  data: unknown
  /** Present only for frames replayed from a delegated subprompt. */
  source?: { subPromptId: string; eventIndex: number }
}

/** A prompt's display attachment (metadata only; the WebP rendition BLOBs are fetched
 *  separately by the authed serve route, keyed by fileId). */
export interface AttachmentMeta {
  fileId: string
  filename: string
  contentType: string
}

/** How a plan's Ctrip comparison figure got here. `manual` = OP typed it after looking;
 *  `ctrip-extension` = the browser extension read it off the page OP opened. Kept apart
 *  because they fail differently — a typo versus a stale selector — and the UI has to be
 *  able to say which one produced the number on screen. */
export type ReferencePriceSource = 'manual' | 'ctrip-extension'

/** One plan's recorded Ctrip comparison (see migrations/0014). Never part of the
 *  flight-recommendations contract: this is a number off someone else's page, not a
 *  verified fare, and downstream code must never confuse the two. */
export interface ReferencePrice {
  planId: string
  amount: number
  currency: string
  source: ReferencePriceSource
  sourceUrl: string | null
  capturedAt: string
  updatedAt: string
}

/** routeMode 的唯一归一化：除 'mcp' 外一律折叠为 ''（VM 路径）。写入（debug config）
 *  与读取打戳（POST /tasks）共用，存储值不可能漂移出这两种。 */
export function normalizeRouteMode(raw: string | undefined): '' | 'mcp' {
  return raw === 'mcp' ? 'mcp' : ''
}

export interface Store {
  createTask(id: string, projectId: string, userEmail: string, routeMode: string): Promise<void>
  getTask(id: string): Promise<Task | undefined>
  listTasksByUser(userEmail: string): Promise<TaskSummary[]>
  setTaskStatus(id: string, status: string): Promise<void>
  /** Record the session's relay task — follow-ups append their prompts to it. */
  setTaskRelayId(id: string, relayTaskId: string): Promise<void>

  // ── the tenant's current Simplifly credential (see migrations/0007 + 0008) ────────
  /** Overwrite this tenant's current travelkit/Simplifly token. Called on EVERY request carrying
   *  one — the token rides on each one, it IS the caller's credential — so a re-login refreshes it
   *  without anything scheduled. Writing the same value again is not a no-op: it bumps
   *  `last_seen_at` (liveness) while leaving `updated_at` (last rotation) alone.
   *  Go through persistTenantCredential (server/tenant-credential.ts) rather than calling this
   *  directly: it carries the audit line. Nothing may gate this write on the value being written —
   *  that module explains why a single refused write strands the employee permanently. */
  saveTenantCredential(userEmail: string, token: string): Promise<void>
  /** The last token received for this tenant, or undefined if we have never seen one. There is
   *  no validity check to make: the token carries no `exp`. Read by the delegated-credential
   *  endpoints (server/oauth.ts) and by nothing else. */
  getTenantCredential(userEmail: string): Promise<string | undefined>
  /** Prove the credential store can still be WRITTEN, by writing. Rejects if it cannot.
   *
   *  This exists because `getTenantCredential` returning nothing is ambiguous, and the two
   *  meanings need opposite answers: "we have never seen this tenant" is a legitimate,
   *  non-retryable `400 invalid_grant` ("reopen FlyAI"), while "the write plane is down" (an
   *  unapplied migration, a quota event) must be a RETRYABLE 5xx. Answering 400 in the second
   *  case tells every employee to reopen the iframe, and reopening re-runs the same failing
   *  write — a permanent loop with no alarm and no 5xx. Called only on the miss path. */
  probeCredentialStore(): Promise<void>

  // ── dynamically registered OAuth clients (RFC 7591; see migrations/0010) ─────────
  /** Persist a client minted by POST /oauth/register. Only the SHA-256 hex of the secret is
   *  stored — the plaintext exists once, in the registration response, and never again. */
  createOAuthClient(clientId: string, clientSecretHash: string, clientName: string): Promise<void>
  /** The stored secret hash for a client id, or undefined for an unknown client. The token
   *  endpoint folds "unknown id" and "wrong secret" into the same invalid_client. */
  getOAuthClientSecretHash(clientId: string): Promise<string | undefined>

  getAgentComputer(userEmail: string): Promise<AgentComputerRow | undefined>
  /** Reverse lookup for /internal's ac_id-keyed credential resolution: the tenant whose row
   *  currently names this agent computer, or null. A replaced/abandoned ac_id (see
   *  replaceAgentComputer) has no row and MUST miss to null — never resolve to another tenant. */
  getAgentComputerUserByAcId(acId: string): Promise<string | null>
  /** Idempotent (INSERT OR IGNORE): first writer per email wins, losers no-op. */
  saveAgentComputer(userEmail: string, acId: string, sandboxId: string | null, tokenHash: string, seedVersion: string): Promise<void>
  /** Update the recorded token hash after rewriting the sandbox's credential in place. */
  setAgentComputerTokenHash(userEmail: string, tokenHash: string): Promise<void>
  /** Update token hash + seed version together after re-seeding a stale sandbox in place. */
  setAgentComputerSeed(userEmail: string, tokenHash: string, seedVersion: string): Promise<void>
  /** Force-REPLACE the row (upsert on user_email) to point at a freshly provisioned VM — unlike
   *  saveAgentComputer's INSERT-OR-IGNORE, this overwrites an existing row. Used by the debug
   *  "new VM" action: the old VM is abandoned and this row now names the new one. */
  replaceAgentComputer(userEmail: string, acId: string, sandboxId: string | null, tokenHash: string, seedVersion: string): Promise<void>

  // ── global debug config (ONE shared config for ALL users; edited via the admin debug panel) ──
  /** The single global config (skill-ref + manager-prompt overrides) shared by every user's
   *  sessions — NOT per-user. Read on each first turn; written only by the admin panel. Empty
   *  string = use the built-in default (worker/skill-ref.ts SKILL_REF / agent-config.ts
   *  AGENT_INSTRUCTIONS). Stored in the `kv` table.
   *  `routeMode`：存储值只有 '' 与 'mcp' 两种（normalizeRouteMode 是唯一归一化点）：
   *  '' = 沙箱 VM + skill（现状路径）；'mcp' = 同一个人的 agent computer 作 workspace，
   *  manager 直接调 flight MCP 工具（task-do.ts 的 mcp 分支）。 */
  getConfig(): Promise<{ skillRef: string; systemPrompt: string; routeMode: string }>
  /** Upsert the global config — only the provided fields are written. Admin-gated at the route. */
  setConfig(patch: { skillRef?: string; systemPrompt?: string; routeMode?: string }): Promise<void>

  createPrompt(id: string, taskId: string, prompt: string): Promise<void>
  getPrompt(id: string): Promise<Prompt | undefined>
  listPrompts(taskId: string): Promise<Prompt[]>
  finishPrompt(id: string, status: string): Promise<void>
  /** Unconditional status write (unlike finishPrompt's running-only guard) — used to flip a
   *  prematurely-failed prompt back to 'completed' when its answer is recovered late. */
  setPromptStatus(id: string, status: string): Promise<void>

  /** Append one display frame. Delegated frames carry their stable source
   *  identity so replay retries are idempotent across DO restarts and reloads. */
  appendFrame(
    promptId: string,
    seq: number,
    data: unknown,
    source?: { subPromptId: string; eventIndex: number },
  ): Promise<boolean>
  framesSince(promptId: string, fromSeq: number): Promise<Frame[]>
  /** Durable cursor for one delegated prompt's normalized event list. */
  getSubPromptCursor(promptId: string, subPromptId: string): Promise<number>
  setSubPromptCursor(promptId: string, subPromptId: string, nextEventIndex: number): Promise<void>
  listSubPromptIds(promptId: string): Promise<string[]>

  // ── image/file attachments (display channel; see migrations/0005) ──────────
  /** Persist a file's display renditions (WebP BLOBs), keyed by the relay file id. Idempotent
   *  (INSERT OR REPLACE). Non-image files pass null blobs (chip-only). user_email = embed tenant. */
  saveAttachment(
    fileId: string,
    userEmail: string,
    filename: string,
    contentType: string,
    thumb: ArrayBuffer | null,
    large: ArrayBuffer | null,
  ): Promise<void>
  /** One rendition's bytes + owner tenant, for the authed serve route (undefined if absent). */
  getAttachment(fileId: string, size: 'thumb' | 'large'): Promise<{ userEmail: string; bytes: ArrayBuffer } | undefined>
  /** Associate an ordered list of uploaded file ids with a prompt (for bubble display). */
  linkPromptFiles(promptId: string, fileIds: string[]): Promise<void>
  /** A prompt's attachments (metadata only), ordered as sent. */
  listPromptAttachments(promptId: string): Promise<AttachmentMeta[]>

  // ── Ctrip comparison figures (see migrations/0014) ────────────────────────
  /** Record what Ctrip is asking for one plan. Overwrites any earlier figure for the
   *  same (tenant, task, plan) — OTA prices move, and only the latest look informs the
   *  decision OP is about to make. `raw` is the extension's full extraction payload,
   *  kept as evidence for why a number appeared; nothing reads it back for display. */
  saveReferencePrice(
    userEmail: string,
    taskId: string,
    planId: string,
    price: { amount: number; currency: string; source: ReferencePriceSource; sourceUrl: string | null; capturedAt: string },
    raw: string | null,
  ): Promise<void>
  /** Every recorded comparison for one task, to hydrate the recommendation table on load. */
  listReferencePrices(userEmail: string, taskId: string): Promise<ReferencePrice[]>
}
