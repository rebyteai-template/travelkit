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
  /** sha256 of the travelkit token last written into this sandbox's .mcp.json; null for rows
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

  createPrompt(id: string, taskId: string, prompt: string): Promise<void>
  getPrompt(id: string): Promise<Prompt | undefined>
  listPrompts(taskId: string): Promise<Prompt[]>
  finishPrompt(id: string, status: string): Promise<void>

  appendFrame(promptId: string, seq: number, data: unknown): Promise<void>
  framesSince(promptId: string, fromSeq: number): Promise<Frame[]>
}
