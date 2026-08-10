/**
 * Cloudflare D1 storage driver — the production (and, via `wrangler dev`, the local)
 * store. Implements the async `Store` contract (server/store.ts) over a D1Database
 * binding, so call sites never see the driver.
 *
 * The SQL is the same plain-SQLite shape the project always used (`?` placeholders,
 * `datetime('now')`) — D1 IS SQLite, so it runs verbatim. Schema lives in
 * migrations/0001_init.sql (applied via `wrangler d1 migrations apply`), so unlike
 * the old better-sqlite3 driver this file does no CREATE TABLE / PRAGMA at runtime.
 */
import type { Store, Task, Prompt, TaskSummary, AgentComputerRow, AttachmentMeta, ReferencePrice } from './store.ts'

/** Reserved `tenant_credentials` key for the write-plane probe. Deliberately colon-free: a tenant
 *  key is always `<org>:<uid>`, so this row is unreachable through any tenant lookup. */
export const CREDENTIAL_PROBE_KEY = '__write_probe__'

export function createD1Store(db: D1Database): Store {
  return {
    async createTask(id, projectId, userEmail, routeMode) {
      await db
        .prepare(`INSERT INTO tasks (id, project_id, user_email, route_mode) VALUES (?, ?, ?, ?)`)
        .bind(id, projectId, userEmail, routeMode)
        .run()
    },
    async getTask(id) {
      return (await db.prepare(`SELECT * FROM tasks WHERE id = ?`).bind(id).first<Task>()) ?? undefined
    },
    async listTasksByUser(userEmail) {
      const { results } = await db
        .prepare(
          `SELECT t.id, t.status, t.created_at,
                  COALESCE((SELECT substr(p.prompt, 1, 80) FROM prompts p
                            WHERE p.task_id = t.id ORDER BY p.created_at LIMIT 1), '') AS title
             FROM tasks t WHERE t.user_email = ? ORDER BY t.created_at DESC`,
        )
        .bind(userEmail)
        .all<TaskSummary>()
      return results
    },
    async saveTenantCredential(userEmail, token) {
      // Two timestamps, two questions (migrations/0008):
      //   updated_at   moves only when the VALUE changes → "when did this employee last re-login"
      //   last_seen_at moves on every accepted intake    → "is this tenant still alive"
      // The old guarded upsert wrote zero rows in the common case, which made an abandoned row
      // indistinguishable from a live one — the observability gate in PLAN §6 needs both.
      await db
        .prepare(
          `INSERT INTO tenant_credentials (user_email, token, updated_at, last_seen_at)
             VALUES (?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(user_email) DO UPDATE SET
             token = excluded.token,
             updated_at = CASE WHEN tenant_credentials.token <> excluded.token
                               THEN excluded.updated_at ELSE tenant_credentials.updated_at END,
             last_seen_at = excluded.last_seen_at`,
        )
        .bind(userEmail, token)
        .run()
    },
    async probeCredentialStore() {
      // A real WRITE, because that is the plane whose failure we have to detect — a SELECT would
      // still succeed against a read replica while writes are refused, and it would not notice a
      // missing column. Touches one reserved row: PROBE_KEY has no `:`, and every tenant key is
      // `<org>:<uid>` (formatActor), so it can never collide with, or be read back as, a tenant.
      await db
        .prepare(
          `INSERT INTO tenant_credentials (user_email, token, updated_at, last_seen_at)
             VALUES (?, '', datetime('now'), datetime('now'))
           ON CONFLICT(user_email) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        )
        .bind(CREDENTIAL_PROBE_KEY)
        .run()
    },
    async getTenantCredential(userEmail) {
      const row = await db
        .prepare(`SELECT token FROM tenant_credentials WHERE user_email = ?`)
        .bind(userEmail)
        .first<{ token: string }>()
      return row?.token ?? undefined
    },
    async createOAuthClient(clientId, clientSecretHash, clientName) {
      await db
        .prepare(`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name) VALUES (?, ?, ?)`)
        .bind(clientId, clientSecretHash, clientName)
        .run()
    },
    async getOAuthClientSecretHash(clientId) {
      const row = await db
        .prepare(`SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?`)
        .bind(clientId)
        .first<{ client_secret_hash: string }>()
      return row?.client_secret_hash ?? undefined
    },
    async getAgentComputer(userEmail) {
      const row = await db
        .prepare(`SELECT ac_id AS id, sandbox_id AS sandboxId, token_hash AS tokenHash, seed_version AS seedVersion FROM agent_computers WHERE user_email = ?`)
        .bind(userEmail)
        .first<AgentComputerRow>()
      return row ?? undefined
    },
    async getAgentComputerUserByAcId(acId) {
      const row = await db
        .prepare(`SELECT user_email FROM agent_computers WHERE ac_id = ?`)
        .bind(acId)
        .first<{ user_email: string }>()
      return row?.user_email ?? null
    },
    async saveAgentComputer(userEmail, acId, sandboxId, tokenHash, seedVersion) {
      await db
        .prepare(`INSERT OR IGNORE INTO agent_computers (user_email, ac_id, sandbox_id, token_hash, seed_version) VALUES (?, ?, ?, ?, ?)`)
        .bind(userEmail, acId, sandboxId, tokenHash, seedVersion)
        .run()
    },
    async setAgentComputerTokenHash(userEmail, tokenHash) {
      await db
        .prepare(`UPDATE agent_computers SET token_hash = ? WHERE user_email = ?`)
        .bind(tokenHash, userEmail)
        .run()
    },
    async setAgentComputerSeed(userEmail, tokenHash, seedVersion) {
      await db
        .prepare(`UPDATE agent_computers SET token_hash = ?, seed_version = ? WHERE user_email = ?`)
        .bind(tokenHash, seedVersion, userEmail)
        .run()
    },
    async replaceAgentComputer(userEmail, acId, sandboxId, tokenHash, seedVersion) {
      // Upsert: claim the row if absent, else overwrite it to name the new VM (user_email is PK).
      await db
        .prepare(
          `INSERT INTO agent_computers (user_email, ac_id, sandbox_id, token_hash, seed_version)
             VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_email) DO UPDATE SET
             ac_id = excluded.ac_id, sandbox_id = excluded.sandbox_id,
             token_hash = excluded.token_hash, seed_version = excluded.seed_version`,
        )
        .bind(userEmail, acId, sandboxId, tokenHash, seedVersion)
        .run()
    },
    // ── global debug config (single shared row set; keys in the kv table) ──
    async getConfig() {
      const { results } = await db
        .prepare(`SELECT k, v FROM kv WHERE k IN ('cfg_skill_ref', 'cfg_system_prompt', 'cfg_route_mode')`)
        .all<{ k: string; v: string }>()
      const m = new Map(results.map((r) => [r.k, r.v]))
      return {
        skillRef: m.get('cfg_skill_ref') ?? '',
        systemPrompt: m.get('cfg_system_prompt') ?? '',
        routeMode: m.get('cfg_route_mode') ?? '',
      }
    },
    async setConfig(patch) {
      // Upsert only the provided keys (k is PK). Empty string is a valid stored value = "use default".
      const rows: Array<[string, string]> = []
      if (patch.skillRef !== undefined) rows.push(['cfg_skill_ref', patch.skillRef])
      if (patch.systemPrompt !== undefined) rows.push(['cfg_system_prompt', patch.systemPrompt])
      if (patch.routeMode !== undefined) rows.push(['cfg_route_mode', patch.routeMode])
      if (!rows.length) return
      // One atomic batched round-trip (both keys commit together or neither) instead of N sequential.
      const stmt = db.prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
      await db.batch(rows.map(([k, v]) => stmt.bind(k, v)))
    },
    async setTaskStatus(id, status) {
      await db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).bind(status, id).run()
    },
    async setTaskRelayId(id, relayTaskId) {
      await db
        .prepare(`UPDATE tasks SET relay_task_id = ? WHERE id = ?`)
        .bind(relayTaskId, id)
        .run()
    },

    async createPrompt(id, taskId, prompt) {
      await db.prepare(`INSERT INTO prompts (id, task_id, prompt) VALUES (?, ?, ?)`).bind(id, taskId, prompt).run()
    },
    async getPrompt(id) {
      return (await db.prepare(`SELECT * FROM prompts WHERE id = ?`).bind(id).first<Prompt>()) ?? undefined
    },
    async listPrompts(taskId) {
      const { results } = await db
        .prepare(`SELECT * FROM prompts WHERE task_id = ? ORDER BY created_at`)
        .bind(taskId)
        .all<Prompt>()
      return results
    },
    async finishPrompt(id, status) {
      await db
        .prepare(
          `UPDATE prompts
             SET status = ?, completed_at = datetime('now')
           WHERE id = ? AND status IN ('running', 'waiting_for_answer')`,
        )
        .bind(status, id)
        .run()
    },
    async setPromptStatus(id, status) {
      await db.prepare(`UPDATE prompts SET status = ? WHERE id = ?`).bind(status, id).run()
    },

    async appendFrame(promptId, seq, data, source) {
      const result = source
        ? await db
            .prepare(
              `INSERT OR IGNORE INTO frames
                 (prompt_id, seq, data, source_sub_prompt_id, source_event_index)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(promptId, seq, JSON.stringify(data), source.subPromptId, source.eventIndex)
            .run()
        : await db
            .prepare(`INSERT INTO frames (prompt_id, seq, data) VALUES (?, ?, ?)`)
            .bind(promptId, seq, JSON.stringify(data))
            .run()
      return result.meta.changes > 0
    },
    async framesSince(promptId, fromSeq) {
      const { results } = await db
        .prepare(
          `SELECT seq, data,
                  source_sub_prompt_id AS sourceSubPromptId,
                  source_event_index AS sourceEventIndex
             FROM frames
            WHERE prompt_id = ? AND seq > ?
            ORDER BY seq`,
        )
        .bind(promptId, fromSeq)
        .all<{
          seq: number
          data: string
          sourceSubPromptId: string | null
          sourceEventIndex: number | null
        }>()
      return results.map((r) => ({
        seq: r.seq,
        data: JSON.parse(r.data) as unknown,
        ...(r.sourceSubPromptId !== null && r.sourceEventIndex !== null
          ? { source: { subPromptId: r.sourceSubPromptId, eventIndex: r.sourceEventIndex } }
          : {}),
      }))
    },
    async getSubPromptCursor(promptId, subPromptId) {
      const row = await db
        .prepare(`SELECT next_event_index AS nextEventIndex FROM prompt_subprompts WHERE prompt_id = ? AND sub_prompt_id = ?`)
        .bind(promptId, subPromptId)
        .first<{ nextEventIndex: number }>()
      return row?.nextEventIndex ?? 0
    },
    async setSubPromptCursor(promptId, subPromptId, nextEventIndex) {
      await db
        .prepare(
          `INSERT INTO prompt_subprompts (prompt_id, sub_prompt_id, next_event_index)
             VALUES (?, ?, ?)
           ON CONFLICT(prompt_id, sub_prompt_id) DO UPDATE SET
             next_event_index = MAX(prompt_subprompts.next_event_index, excluded.next_event_index)`,
        )
        .bind(promptId, subPromptId, nextEventIndex)
        .run()
    },
    async listSubPromptIds(promptId) {
      const { results } = await db
        .prepare(`SELECT sub_prompt_id AS subPromptId FROM prompt_subprompts WHERE prompt_id = ? ORDER BY sub_prompt_id`)
        .bind(promptId)
        .all<{ subPromptId: string }>()
      return results.map((row) => row.subPromptId)
    },

    async saveAttachment(fileId, userEmail, filename, contentType, thumb, large) {
      await db
        .prepare(`INSERT OR REPLACE INTO attachments (file_id, user_email, filename, content_type, thumb, large) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(fileId, userEmail, filename, contentType, thumb, large)
        .run()
    },
    async getAttachment(fileId, size) {
      const col = size === 'large' ? 'large' : 'thumb' // closed set → safe to inline
      const row = await db
        .prepare(`SELECT user_email AS userEmail, ${col} AS bytes FROM attachments WHERE file_id = ?`)
        .bind(fileId)
        .first<{ userEmail: string; bytes: ArrayBuffer | ArrayBufferView | number[] | null }>()
      if (!row || row.bytes == null) return undefined
      // D1 returns a BLOB as ArrayBuffer (prod Workers) or number[] (local miniflare). Copy into a
      // fresh ArrayBuffer — else c.body() stringifies a number[] into a corrupt CSV of byte values.
      const b = row.bytes
      const src = b instanceof ArrayBuffer
        ? new Uint8Array(b)
        : ArrayBuffer.isView(b)
          ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
          : Uint8Array.from(b)
      const bytes = new ArrayBuffer(src.byteLength)
      new Uint8Array(bytes).set(src)
      return { userEmail: row.userEmail, bytes }
    },
    async linkPromptFiles(promptId, fileIds) {
      if (!fileIds.length) return
      // One batched round-trip instead of N sequential INSERTs.
      const stmt = db.prepare(`INSERT OR IGNORE INTO prompt_files (prompt_id, idx, file_id) VALUES (?, ?, ?)`)
      await db.batch(fileIds.map((id, i) => stmt.bind(promptId, i, id)))
    },
    async saveReferencePrice(userEmail, taskId, planId, price, raw) {
      await db
        .prepare(
          `INSERT INTO reference_prices
             (user_email, task_id, plan_id, amount, currency, source, source_url, captured_at, raw_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(user_email, task_id, plan_id) DO UPDATE SET
             amount      = excluded.amount,
             currency    = excluded.currency,
             source      = excluded.source,
             source_url  = excluded.source_url,
             captured_at = excluded.captured_at,
             raw_json    = excluded.raw_json,
             updated_at  = excluded.updated_at`,
        )
        .bind(userEmail, taskId, planId, price.amount, price.currency, price.source, price.sourceUrl, price.capturedAt, raw)
        .run()
    },
    async listReferencePrices(userEmail, taskId) {
      const { results } = await db
        .prepare(
          `SELECT plan_id AS planId, amount, currency, source,
                  source_url AS sourceUrl, captured_at AS capturedAt, updated_at AS updatedAt
             FROM reference_prices WHERE user_email = ? AND task_id = ?`,
        )
        .bind(userEmail, taskId)
        .all<ReferencePrice>()
      return results
    },
    async listPromptAttachments(promptId) {
      const { results } = await db
        .prepare(
          `SELECT a.file_id AS fileId, a.filename AS filename, a.content_type AS contentType
             FROM prompt_files pf JOIN attachments a ON a.file_id = pf.file_id
            WHERE pf.prompt_id = ? ORDER BY pf.idx`,
        )
        .bind(promptId)
        .all<AttachmentMeta>()
      return results
    },
  }
}
