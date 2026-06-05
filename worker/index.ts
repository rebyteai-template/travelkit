/**
 * Cloudflare Worker entry — the composition root for the Workers-native build.
 *
 *   /api/app/*  → the shared Hono API (server/routes.ts), with the D1 store and a
 *                 Durable-Object-backed turn runner injected per request.
 *   everything  → the static SPA (vite build/) via the ASSETS binding (SPA fallback
 *                 is configured in wrangler.jsonc → not_found_handling).
 *
 * The DO class is re-exported here because wrangler binds Durable Objects to the
 * classes exported from the Worker's main module.
 */
import { Hono } from 'hono'
import { createD1Store } from '../server/db.ts'
import { app as api, type RouteVars } from '../server/routes.ts'
import { authedEmail } from './auth.ts'
import type { Env } from './env.ts'

export { TaskDO } from './task-do.ts'

const app = new Hono<{ Bindings: Env; Variables: RouteVars }>()

// Authenticate (Cloudflare Access → email) and inject the runtime deps the routes expect:
// the D1 store + a turn runner that forwards to the per-task Durable Object (carrying the
// user's email so the DO uses that tenant's sandbox). Applied to the API surface only.
app.use('/api/app/*', async (c, next) => {
  const env = c.env
  const email = await authedEmail(c.req.raw, env)
  if (!email) return c.json({ error: 'unauthorized' }, 401)
  const store = createD1Store(env.DB)
  c.set('userEmail', email)
  c.set('store', store)
  c.set('runTurn', async (taskId, _projectId, promptId, prompt) => {
    await env.TASK_DO.getByName(taskId).runTurn(taskId, promptId, prompt, email)
  })
  c.set('cancelTurn', async (promptId) => {
    const p = await store.getPrompt(promptId)
    if (!p) return false
    return env.TASK_DO.getByName(p.task_id).cancel(promptId)
  })
  c.set('recoverPrompt', async (taskId, promptId) => {
    return env.TASK_DO.getByName(taskId).recoverPrompt(promptId)
  })
  await next()
})

app.route('/api/app', api)

// Everything else is the SPA. not_found_handling=single-page-application makes the
// assets service serve index.html for client-side routes.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
