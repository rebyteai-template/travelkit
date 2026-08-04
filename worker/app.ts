/**
 * The Worker's request pipeline — everything the entry module (worker/index.ts) does except
 * re-exporting the Durable Object class.
 *
 *   /api/app/*  → the shared Hono API (server/routes.ts), with the D1 store and a
 *                 Durable-Object-backed turn runner injected per request.
 *   /oauth/*, /internal/*, /.well-known/*
 *               → the delegated-credential Authorization Server (server/oauth.ts). Machine
 *                 callers (the rebyte relay, our MCP), so NOT behind the embed middleware.
 *   everything  → the static SPA (vite build/) via the ASSETS binding (SPA fallback
 *                 is configured in wrangler.jsonc → not_found_handling).
 *
 * It lives apart from worker/index.ts for one reason: index.ts must import the DO class, which
 * pulls in `cloudflare:workers` and cannot be loaded by the node test runner. Mount ORDER (the AS
 * before the SPA catch-all) and the credential intake are exactly the things that need a test, so
 * they are here, and worker/app.test.ts covers them.
 *
 * `createApp` takes the store factory so tests need no D1; production uses the default.
 */
import { Hono } from 'hono'
import { createD1Store } from '../server/db.ts'
import { app as api, type RouteVars } from '../server/routes.ts'
import { authorizationServer, formatActor } from '../server/oauth.ts'
import { isWellFormedCredential, persistTenantCredential } from '../server/tenant-credential.ts'
import type { Store } from '../server/store.ts'
import { fetchCredit } from '../server/rebyte/credit.ts'
import { uploadFileToRelay, type RebyteConfig } from '../server/rebyte/client.ts'
import type { Env } from './env.ts'

/** Relay config from env (endpoint default + org key) — used by every relay call the Worker makes
 *  directly (file upload, credit). The key never leaves the Worker. */
const rebyteConfig = (env: Env): RebyteConfig => ({
  apiUrl: env.REBYTE_API_URL ?? 'https://api.rebyte.ai/v1',
  apiKey: env.REBYTE_API_KEY,
})

export function createApp(storeFor: (env: Env) => Store = (env) => createD1Store(env.DB)) {
  const app = new Hono<{ Bindings: Env; Variables: RouteVars }>()

  // Embed identity (iframe handoff): the host passes `uid` (stable tenant key) + the caller's
  // travelkit `token` in the iframe URL fragment; the SPA forwards them as request headers
  // (uid also as a query param on the SSE stream, since EventSource can't set headers).
  // BARE-PASS for the test phase: whoever can construct the URL is authorized — no signature
  // yet (locked down before external integration). Falls back to DEV_EMAIL for local dev.
  // The token is consumed by the DO to seed that user's sandbox .simplifly.env on first turn.
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
    // The one structural bound, and it is NOT a judgement about the credential: a control
    // character cannot occur in a working token, and it does not stop at this request — the same
    // string is written into the sandbox's `.simplifly.env` as `SIMPLIFLY_AUTH_TOKEN=<token>\n`
    // (worker/seed.ts), where a newline injects further env lines. (Header values cannot carry
    // one at all; the query-string handoff can.) Everything that gets past here is stored as-is.
    if (!isWellFormedCredential(token)) return c.json({ error: 'unauthorized' }, 401)
    // Tenant key ≡ the `actor` the relay hands back on /oauth/token, so the two can never drift.
    const tenant = formatActor(org, uid)
    const store = storeFor(env)

    // Remember this tenant's CURRENT token so the delegated-credential endpoint can hand it to our
    // MCP later (PLAN §4.3). EVERY request overwrites it, unconditionally: the token rides on each
    // one because it IS the caller's credential, so a re-login (same uid+org, new token, iframe
    // re-rendered by the host) refreshes it for free and there is nothing to schedule. No rule
    // decides which token wins — see server/tenant-credential.ts for why any such rule strands the
    // employee permanently.
    //
    // TRUST BOUNDARY: the handoff is unsigned (INTEGRATION.md:44), so this row is exactly as
    // trustworthy as three request headers — anyone who can reach the Worker can overwrite anyone's
    // credential. The HMAC handshake (PLAN §7.1) is the fix and is tracked separately; nothing here
    // substitutes for it. What we do have is the audit line on every overwrite.
    // Awaited, not waitUntil: it is one read + one write, it must land BEFORE the turn this
    // request may start reaches for an MCP tool, and a failure has to be visible here.
    await persistTenantCredential(store, tenant, token)

    c.set('userEmail', tenant)
    c.set('store', store)
    // Who may WRITE the global config (skill ref + manager prompt affect ALL users). TESTING PHASE: if
    // no ADMIN_UIDS allowlist is set, anyone who can reveal the debug panel (10× brand tap) may save —
    // the tap is the only gate. Set ADMIN_UIDS later to restrict writes to those uids (local dev's
    // DEV_EMAIL still counts). Either way the panel is behind the same embed-key + tenant auth.
    const adminUids = (env.ADMIN_UIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    c.set('isAdmin', adminUids.length === 0 || adminUids.includes(uid) || (!!env.DEV_EMAIL && uid === env.DEV_EMAIL))
    c.set('runTurn', async (taskId, _projectId, promptId, prompt, opts) => {
      await env.TASK_DO.getByName(taskId).runTurn(taskId, promptId, prompt, tenant, token, opts?.files)
    })
    c.set('answerQuestion', async (promptId, answer) => {
      const p = await store.getPrompt(promptId)
      if (!p) return { ok: false, reason: 'not_waiting' }
      return env.TASK_DO.getByName(p.task_id).answerQuestion(promptId, answer)
    })
    // Upload one attachment via the relay's public file API (mint signed URL + stream the Blob). The
    // returned FileRef rides on a later turn (createTask/addPrompt) and stages the file into the
    // sandbox at /code/<filename>.
    c.set('uploadFile', (file) => uploadFileToRelay(rebyteConfig(env), file))
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
    // Org credit (read-only) for the low-balance banner. Same relay key the DO runs on, so the
    // balance is org-wide; the key never leaves the Worker.
    c.set('getCredit', () => fetchCredit(rebyteConfig(env)))
    await next()
  })

  app.route('/api/app', api)

  // The delegated-credential Authorization Server. Mounted before the SPA catch-all (which would
  // otherwise answer /oauth/token with index.html) and outside the embed middleware: these callers
  // authenticate with client credentials / a service token, not with an iframe handoff.
  app.route('/', authorizationServer<Env>(storeFor))

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

  return app
}

export default createApp()
