/**
 * HTTP API, mounted at /api/app. Multi-tenant: every request carries an authenticated
 * `userEmail` (from Cloudflare Access; injected by the composition root). All data is scoped
 * to that email, and cross-user access is rejected (403).
 *
 *   GET  /me                    → { email }
 *   GET  /tasks                 → the caller's sessions (conversations)
 *   POST /tasks                 → create session + first turn
 *   POST /tasks/:id/prompts     → follow-up turn (same session)
 *   GET  /tasks/:id/content     → prompts + their frames (for reload)
 *   GET  /prompts/:id/stream    → SSE of frames until the turn ends
 *   POST /prompts/:id/cancel    → cancel the running turn
 *
 * The store + turn runner come from Hono context vars (set by worker/index.ts), so these
 * handlers don't know whether the store is D1 or the runner is a Durable Object.
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Store, Task } from './store.ts'
import { framesHaveAssistantText, unrenderedResultTexts } from './frame-text.ts'

/** Single default project (no project picker in this build). */
export const DEFAULT_PROJECT_ID = 'default'

/** Injected per-request by the composition root. */
export interface RouteVars {
  userEmail: string
  store: Store
  runTurn: (taskId: string, projectId: string, promptId: string, prompt: string) => Promise<void>
  cancelTurn: (promptId: string) => Promise<boolean>
  /** Backfill a finalized-but-empty turn's answer from the backend into the store
   *  (the stream may have stopped before it persisted). Returns true if it recovered
   *  something. See GET /tasks/:id/content. */
  recoverPrompt: (taskId: string, promptId: string) => Promise<boolean>
  /** Debug action: provision a fresh sandbox for the caller and repoint their row at it
   *  (abandons the old VM). Returns the new sandbox id. See POST /debug/new-sandbox. */
  newSandbox: () => Promise<{ sandboxId?: string }>
}

export const app = new Hono<{ Variables: RouteVars }>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Load a task only if it belongs to the caller; else null (→ 404/403). */
async function ownedTask(store: Store, taskId: string, email: string): Promise<Task | null> {
  const task = await store.getTask(taskId)
  if (!task || task.user_email !== email) return null
  return task
}

app.get('/me', (c) => c.json({ email: c.var.userEmail }))

app.get('/tasks', async (c) => {
  return c.json({ tasks: await c.var.store.listTasksByUser(c.var.userEmail) })
})

app.post('/tasks', async (c) => {
  const { store, runTurn, userEmail } = c.var
  const { prompt } = await c.req.json<{ prompt?: string }>()
  if (!prompt?.trim()) return c.json({ error: 'prompt is required' }, 400)

  const taskId = crypto.randomUUID()
  const promptId = crypto.randomUUID()
  await store.createTask(taskId, DEFAULT_PROJECT_ID, userEmail)
  await store.createPrompt(promptId, taskId, prompt)
  await runTurn(taskId, DEFAULT_PROJECT_ID, promptId, prompt)

  return c.json({ taskId, promptId })
})

app.post('/tasks/:id/prompts', async (c) => {
  const { store, runTurn, userEmail } = c.var
  const taskId = c.req.param('id')
  const task = await ownedTask(store, taskId, userEmail)
  if (!task) return c.json({ error: 'task not found' }, 404)

  const { prompt } = await c.req.json<{ prompt?: string }>()
  if (!prompt?.trim()) return c.json({ error: 'prompt is required' }, 400)

  const promptId = crypto.randomUUID()
  await store.createPrompt(promptId, taskId, prompt)
  await store.setTaskStatus(taskId, 'running')
  await runTurn(taskId, task.project_id, promptId, prompt)

  return c.json({ promptId })
})

app.get('/tasks/:id/content', async (c) => {
  const { store, userEmail } = c.var
  const task = await ownedTask(store, c.req.param('id'), userEmail)
  if (!task) return c.json({ error: 'task not found' }, 404)

  const rows = await store.listPrompts(task.id)
  const prompts = await Promise.all(
    rows.map(async (p) => {
      let frames = await store.framesSince(p.id, 0)
      // Self-heal a terminal turn whose answer the UI can't show: either nothing landed
      // (truncation), or the answer is stored on the `result` channel but never rendered
      // as chat text. A browser refresh reads only the store, so it can't recover on its
      // own — ask the backend to backfill, then re-read. No-op for turns already whole.
      const needsHeal = p.status !== 'running' && (!framesHaveAssistantText(frames) || unrenderedResultTexts(frames).length > 0)
      if (needsHeal && (await c.var.recoverPrompt(task.id, p.id))) frames = await store.framesSince(p.id, 0)
      return { id: p.id, prompt: p.prompt, status: p.status, frames }
    }),
  )
  return c.json({ task: { id: task.id, status: task.status }, prompts })
})

app.get('/prompts/:id/stream', async (c) => {
  const { store, userEmail } = c.var
  const promptId = c.req.param('id')
  // Ownership: a prompt belongs to a task, which belongs to a user.
  const p = await store.getPrompt(promptId)
  if (!p || !(await ownedTask(store, p.task_id, userEmail))) return c.json({ error: 'not found' }, 404)

  const fromSeq = Number(c.req.query('fromSeq') ?? c.req.header('Last-Event-ID') ?? 0) || 0
  return streamSSE(c, async (stream) => {
    let aborted = false
    stream.onAbort(() => { aborted = true })

    let lastSeq = fromSeq
    while (!aborted) {
      const frames = await store.framesSince(promptId, lastSeq)
      for (const f of frames) {
        await stream.write(`id: ${f.seq}\ndata: ${JSON.stringify(f.data)}\n\n`)
        lastSeq = f.seq
      }
      const cur = await store.getPrompt(promptId)
      if (cur && cur.status !== 'running') {
        const tail = await store.framesSince(promptId, lastSeq)
        for (const f of tail) {
          await stream.write(`id: ${f.seq}\ndata: ${JSON.stringify(f.data)}\n\n`)
          lastSeq = f.seq
        }
        await stream.write(`event: done\ndata: ${JSON.stringify({ status: cur.status })}\n\n`)
        return
      }
      await sleep(150)
    }
  })
})

// Debug-only: spin a fresh VM for the caller (hidden behind a 10-click UI easter egg). Behind the
// same embed-key + tenant auth as everything else, and spends sandbox quota, so it's not exposed
// in the normal UI. The old VM is abandoned; the new one is used on the caller's next session.
app.post('/debug/new-sandbox', async (c) => {
  return c.json(await c.var.newSandbox())
})

app.post('/prompts/:id/cancel', async (c) => {
  const { store, userEmail, cancelTurn } = c.var
  const promptId = c.req.param('id')
  const p = await store.getPrompt(promptId)
  if (!p || !(await ownedTask(store, p.task_id, userEmail))) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: await cancelTurn(promptId) })
})
