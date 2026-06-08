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
import type { Env } from './env.ts'

export { TaskDO } from './task-do.ts'

const app = new Hono<{ Bindings: Env; Variables: RouteVars }>()

// Embed identity (iframe handoff): the host passes `uid` (stable tenant key) + the caller's
// travelkit `token` in the iframe URL fragment; the SPA forwards them as request headers
// (uid also as a query param on the SSE stream, since EventSource can't set headers).
// BARE-PASS for the test phase: whoever can construct the URL is authorized — no signature
// yet (locked down before external integration). Falls back to DEV_EMAIL for local dev.
// The token is consumed by the DO to seed that user's sandbox .mcp.json on first turn.
app.use('/api/app/*', async (c, next) => {
  const env = c.env
  // Gate 0: the shared embed key, checked before any tenant/VM work. Stops strangers who only
  // know the domain (a stray sandbox provision costs quota). Unset EMBED_KEY → gate disabled.
  if (env.EMBED_KEY) {
    const key = c.req.header('X-Embed-Key') || c.req.query('k') || ''
    if (key !== env.EMBED_KEY) return c.json({ error: 'forbidden' }, 401)
  }
  const uid = c.req.header('X-Tenant-Uid') || c.req.query('uid') || env.DEV_EMAIL || ''
  const org = c.req.header('X-Tenant-Org') || c.req.query('org') || ''
  // EventSource can't set headers, so the SSE stream passes token as a query param too.
  const token = c.req.header('X-Travelkit-Token') || c.req.query('token') || ''
  // All of the handoff must be present — uid, org AND token (k checked above). Missing any →
  // 401, which the SPA turns into the Unauthorized page. Tenant = (org, uid): a user can be in
  // multiple orgs, each its own tenant (own sandbox + history).
  if (!uid || !org || !token) return c.json({ error: 'unauthorized' }, 401)
  const tenant = `${org}:${uid}`
  const store = createD1Store(env.DB)
  c.set('userEmail', tenant)
  c.set('store', store)
  c.set('runTurn', async (taskId, _projectId, promptId, prompt) => {
    await env.TASK_DO.getByName(taskId).runTurn(taskId, promptId, prompt, tenant, token)
  })
  c.set('cancelTurn', async (promptId) => {
    const p = await store.getPrompt(promptId)
    if (!p) return false
    return env.TASK_DO.getByName(p.task_id).cancel(promptId)
  })
  c.set('recoverPrompt', async (taskId, promptId) => {
    return env.TASK_DO.getByName(taskId).recoverPrompt(promptId)
  })
  // Debug "new VM": route through a per-tenant DO (not a per-task one) so concurrent clicks for
  // the same user serialize; it provisions + seeds a fresh sandbox and repoints the user's row.
  c.set('newSandbox', async () => {
    return env.TASK_DO.getByName(`vm:${tenant}`).reprovisionSandbox(tenant, token)
  })
  await next()
})

app.route('/api/app', api)

// Everything else is the SPA. not_found_handling=single-page-application makes the
// assets service serve index.html for client-side routes. Allow embedding in the host's
// iframe (test phase: any origin; lock `frame-ancestors` to the host domain at integration).
app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  const out = new Response(res.body, res)
  out.headers.set('Content-Security-Policy', 'frame-ancestors *')
  out.headers.delete('X-Frame-Options')
  return out
})

export default app
