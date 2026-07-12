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
import { MAX_UPLOAD_BYTES, attachmentPromptSuffix } from './attachments.ts'
import type { FileRef } from './rebyte/client.ts'
import { framesHaveAnswerText, unrenderedResultTexts } from './frame-text.ts'
// Built-in defaults surfaced to the debug panel (placeholder / "填入默认") and used as the fallback
// when the global config field is empty. Single source of truth stays in these two modules.
import { SKILL_REF as DEFAULT_SKILL_REF } from '../worker/skill-ref.ts'
import { AGENT_INSTRUCTIONS as DEFAULT_SYSTEM_PROMPT } from './rebyte/agent-config.ts'

/** Single default project (no project picker in this build). */
export const DEFAULT_PROJECT_ID = 'default'

/** Injected per-request by the composition root. */
export interface RouteVars {
  userEmail: string
  store: Store
  runTurn: (taskId: string, projectId: string, promptId: string, prompt: string, opts?: { files?: FileRef[] }) => Promise<void>
  cancelTurn: (promptId: string) => Promise<boolean>
  /** Upload one file to the relay (mint signed URL + stream the Blob); returns its FileRef. The ref
   *  rides on a turn and is staged into the workspace VM at /code/<filename>. See POST /files. */
  uploadFile: (file: File) => Promise<FileRef>
  /** Backfill a finalized-but-empty turn's answer from the backend into the store
   *  (the stream may have stopped before it persisted). Returns true if it recovered
   *  something. See GET /tasks/:id/content. */
  recoverPrompt: (taskId: string, promptId: string) => Promise<boolean>
  /** Debug action: provision a fresh sandbox for the caller and repoint their row at it
   *  (abandons the old VM). Returns the new sandbox id. See POST /debug/new-sandbox. */
  newSandbox: () => Promise<{ sandboxId?: string }>
  /** The org's total available rebyte credit (org-wide, behind the Worker's relay key), or
   *  null if the relay couldn't be reached. See GET /credit. */
  getCredit: () => Promise<number | null>
  /** Is this caller allowed to WRITE the global debug config? (uid ∈ ADMIN_UIDS.) Everyone can read
   *  it; only admins can save, since it applies to ALL users. See POST /debug/config. */
  isAdmin: boolean
}

/** Below this, the UI nags the org to top up. Credits run in the thousands (a turn burns a
 *  handful), so 100 is a comfortable "nearly empty" floor. Org-level secret → the warning is
 *  shared by all tenants of this deployment. */
const CREDIT_LOW_THRESHOLD = 100

export const app = new Hono<{ Variables: RouteVars }>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Load a task only if it belongs to the caller; else null (→ 404/403). */
async function ownedTask(store: Store, taskId: string, email: string): Promise<Task | null> {
  const task = await store.getTask(taskId)
  if (!task || task.user_email !== email) return null
  return task
}

/** Validate + derive a turn's prompts from the request body, or null when neither text nor a file
 *  is present (→ 400). `text` is the stored UI text (empty for an image-only send); `wirePrompt` is
 *  what the relay sees — the text plus the one-line attachment directive — and is ALWAYS non-empty
 *  for a valid turn (so an image-only send clears the relay's empty-prompt check). Shared by both
 *  POST handlers so the load-bearing stored-text↔wire-prompt split lives in exactly one place. */
function turnPrompts(body: { prompt?: string; files?: FileRef[] }): { text: string; wirePrompt: string; files: FileRef[] } | null {
  const text = body.prompt?.trim() ? body.prompt : ''
  const files = body.files ?? []
  if (!text && !files.length) return null
  return { text, wirePrompt: text + attachmentPromptSuffix(files), files }
}

app.get('/me', (c) => c.json({ email: c.var.userEmail }))

/** Org credit for the low-balance banner. `low` drives the UI; when the relay is unreachable
 *  (totalAvailable null) we report `low:false` so a transient outage never falsely warns. */
app.get('/credit', async (c) => {
  const totalAvailable = await c.var.getCredit()
  return c.json({
    totalAvailable,
    threshold: CREDIT_LOW_THRESHOLD,
    low: totalAvailable !== null && totalAvailable < CREDIT_LOW_THRESHOLD,
  })
})

app.get('/tasks', async (c) => {
  return c.json({ tasks: await c.var.store.listTasksByUser(c.var.userEmail) })
})

app.post('/tasks', async (c) => {
  const { store, runTurn, userEmail } = c.var
  // The skill ref + manager prompt are NOT taken from the request — they're the GLOBAL config the
  // worker reads server-side (so every OP gets the same, not just whoever edited it). See task-do.ts.
  const turn = turnPrompts(await c.req.json<{ prompt?: string; files?: FileRef[] }>())
  if (!turn) return c.json({ error: 'prompt is required' }, 400)

  const taskId = crypto.randomUUID()
  const promptId = crypto.randomUUID()
  await store.createTask(taskId, DEFAULT_PROJECT_ID, userEmail)
  await store.createPrompt(promptId, taskId, turn.text) // stored UI text — empty for image-only (bubble = thumbnail)
  await store.linkPromptFiles(promptId, turn.files.map((f) => f.id)) // bubble attachments (display)
  await runTurn(taskId, DEFAULT_PROJECT_ID, promptId, turn.wirePrompt, { files: turn.files })

  return c.json({ taskId, promptId })
})

app.post('/tasks/:id/prompts', async (c) => {
  const { store, runTurn, userEmail } = c.var
  const taskId = c.req.param('id')
  const task = await ownedTask(store, taskId, userEmail)
  if (!task) return c.json({ error: 'task not found' }, 404)

  const turn = turnPrompts(await c.req.json<{ prompt?: string; files?: FileRef[] }>())
  if (!turn) return c.json({ error: 'prompt is required' }, 400)

  const promptId = crypto.randomUUID()
  await store.createPrompt(promptId, taskId, turn.text) // stored UI text — empty for image-only
  await store.linkPromptFiles(promptId, turn.files.map((f) => f.id)) // bubble attachments (display)
  await store.setTaskStatus(taskId, 'running')
  await runTurn(taskId, task.project_id, promptId, turn.wirePrompt, { files: turn.files })

  return c.json({ promptId })
})

app.post('/files', async (c) => {
  // Eager upload of ONE attachment (multipart): `file` (the original → relay → staged into the
  // sandbox at /code/<filename>) plus optional `thumb`/`large` WebP renditions, persisted keyed by
  // the returned file id for the chat bubble + lightbox. Returns the FileRef the next turn rides on.
  const { uploadFile, store, userEmail } = c.var
  const form = await c.req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return c.json({ error: 'no file' }, 400)
  // Server-side cap (defense in depth — the Composer already gates, but a bypassed client can't get
  // past this). Checked on file.size, before reading the body into Worker memory.
  if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large' }, 413)
  const thumb = form.get('thumb')
  const large = form.get('large')
  // Decode the WebP renditions concurrently (D1 bind needs ArrayBuffers). The original is NOT copied
  // into a second buffer — uploadFile streams the File straight to the relay PUT.
  const [thumbBytes, largeBytes] = await Promise.all([
    thumb instanceof File ? thumb.arrayBuffer() : Promise.resolve(null),
    large instanceof File ? large.arrayBuffer() : Promise.resolve(null),
  ])
  const ref = await uploadFile(file)
  await store.saveAttachment(ref.id, userEmail, file.name, file.type, thumbBytes, largeBytes)
  return c.json({ id: ref.id, filename: ref.filename })
})

app.get('/files/:fileId', async (c) => {
  // Authed image serve: stream a stored WebP rendition (thumb|large) for the bubble/lightbox.
  // Scoped to the uploader's tenant (org:uid) — the Worker holds ONE relay org key, so this check
  // is the real per-tenant gate. `<img>` can't set headers, so the tenant identity rides in the
  // query (withAuthQuery client-side, query fallback in worker/index.ts) — same as the SSE stream.
  const { store, userEmail } = c.var
  const size = c.req.query('size') === 'large' ? 'large' : 'thumb'
  const att = await store.getAttachment(c.req.param('fileId'), size)
  if (!att || att.userEmail !== userEmail) return c.json({ error: 'not found' }, 404)
  return c.body(att.bytes, 200, {
    'Content-Type': 'image/webp',
    'Cache-Control': 'private, max-age=31536000, immutable',
  })
})

app.get('/tasks/:id/content', async (c) => {
  const { store, userEmail } = c.var
  const task = await ownedTask(store, c.req.param('id'), userEmail)
  if (!task) return c.json({ error: 'task not found' }, 404)

  const rows = await store.listPrompts(task.id)
  const prompts = await Promise.all(
    rows.map(async (p) => {
      let frames = await store.framesSince(p.id, 0)
      // Self-heal a terminal turn whose answer the UI can't show: nothing landed after
      // the last tool_use (truncation — an opening ack alone doesn't count as whole),
      // or the answer is stored on the `result` channel but never rendered as chat
      // text. A browser refresh reads only the store, so it can't recover on its
      // own — ask the backend to backfill, then re-read. No-op for turns already whole.
      const needsHeal = p.status !== 'running' && (!framesHaveAnswerText(frames) || unrenderedResultTexts(frames).length > 0)
      if (needsHeal && (await c.var.recoverPrompt(task.id, p.id))) frames = await store.framesSince(p.id, 0)
      // Metadata only — the client derives the rendition URLs (single source: api.toAttachment), so
      // the reloaded bubble matches the optimistic one (streaming-experience-contract I0).
      const attachments = await store.listPromptAttachments(p.id)
      // created_at / completed_at drive the per-bubble timestamps (UTC; the client converts to
      // local tz — see src/lib/time.ts). completed_at is null while the turn is still running.
      return { id: p.id, prompt: p.prompt, status: p.status, created_at: p.created_at, completed_at: p.completed_at, frames, attachments }
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

// ── global debug config: ONE shared skill-ref + manager-prompt, edited by the admin, applied to
//    EVERY user's sessions (the worker reads it server-side at task creation — see task-do.ts). ──
app.get('/debug/config', async (c) => {
  const cfg = await c.var.store.getConfig()
  return c.json({
    skillRef: cfg.skillRef,
    systemPrompt: cfg.systemPrompt,
    // Built-in defaults, for the panel's placeholder / "填入默认" (empty field → these apply).
    defaults: { skillRef: DEFAULT_SKILL_REF, systemPrompt: DEFAULT_SYSTEM_PROMPT },
    isAdmin: c.var.isAdmin, // panel disables saving for non-admins
  })
})

// Write the GLOBAL config — admin only (it affects every user). Empty string = revert that field to
// the built-in default. Both fields are optional; only provided ones are written.
app.post('/debug/config', async (c) => {
  if (!c.var.isAdmin) return c.json({ error: 'forbidden — not an admin uid (ADMIN_UIDS)' }, 403)
  const body = await c.req.json<{ skillRef?: string; systemPrompt?: string }>()
  await c.var.store.setConfig({ skillRef: body.skillRef, systemPrompt: body.systemPrompt })
  // No read-back: the client re-fetches via invalidateQueries (useSaveDebugConfig) and ignores this body.
  return c.json({ ok: true })
})

app.post('/prompts/:id/cancel', async (c) => {
  const { store, userEmail, cancelTurn } = c.var
  const promptId = c.req.param('id')
  const p = await store.getPrompt(promptId)
  if (!p || !(await ownedTask(store, p.task_id, userEmail))) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: await cancelTurn(promptId) })
})
