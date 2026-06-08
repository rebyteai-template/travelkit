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
import type { Store, Task, Prompt, TaskSummary, AgentComputerRow } from './store.ts'

export function createD1Store(db: D1Database): Store {
  return {
    async createTask(id, projectId, userEmail) {
      await db
        .prepare(`INSERT INTO tasks (id, project_id, user_email) VALUES (?, ?, ?)`)
        .bind(id, projectId, userEmail)
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
    async getAgentComputer(userEmail) {
      const row = await db
        .prepare(`SELECT ac_id AS id, sandbox_id AS sandboxId, token_hash AS tokenHash, seed_version AS seedVersion FROM agent_computers WHERE user_email = ?`)
        .bind(userEmail)
        .first<AgentComputerRow>()
      return row ?? undefined
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
    async setTaskStatus(id, status) {
      await db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).bind(status, id).run()
    },
    async setTaskRelayId(id, relayTaskId) {
      await db.prepare(`UPDATE tasks SET relay_task_id = ? WHERE id = ?`).bind(relayTaskId, id).run()
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
        .prepare(`UPDATE prompts SET status = ?, completed_at = datetime('now') WHERE id = ? AND status = 'running'`)
        .bind(status, id)
        .run()
    },

    async appendFrame(promptId, seq, data) {
      await db
        .prepare(`INSERT INTO frames (prompt_id, seq, data) VALUES (?, ?, ?)`)
        .bind(promptId, seq, JSON.stringify(data))
        .run()
    },
    async framesSince(promptId, fromSeq) {
      const { results } = await db
        .prepare(`SELECT seq, data FROM frames WHERE prompt_id = ? AND seq > ? ORDER BY seq`)
        .bind(promptId, fromSeq)
        .all<{ seq: number; data: string }>()
      return results.map((r) => ({ seq: r.seq, data: JSON.parse(r.data) as unknown }))
    },
  }
}
