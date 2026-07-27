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

export interface Store {
  createTask(id: string, projectId: string, userEmail: string): Promise<void>
  getTask(id: string): Promise<Task | undefined>
  listTasksByUser(userEmail: string): Promise<TaskSummary[]>
  setTaskStatus(id: string, status: string): Promise<void>
  setTaskRelayId(id: string, relayTaskId: string): Promise<void>

  getAgentComputer(userEmail: string): Promise<AgentComputerRow | undefined>
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
   *  AGENT_INSTRUCTIONS). Stored in the `kv` table. */
  getConfig(): Promise<{ skillRef: string; systemPrompt: string }>
  /** Upsert the global config — only the provided fields are written. Admin-gated at the route. */
  setConfig(patch: { skillRef?: string; systemPrompt?: string }): Promise<void>

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
}
