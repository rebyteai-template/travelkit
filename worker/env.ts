/**
 * Worker runtime bindings (wrangler.jsonc). Shared by the Worker entry and the
 * Durable Object. The per-user Simplifly/travelkit token is NOT a binding here — it arrives
 * at runtime from the iframe handoff and is written into each sandbox VM's seeded
 * .claude/settings.json `env` (by the bootstrap); the bindings only need the rebyte relay key.
 *
 * The delegated-credential secrets (signing key, relay client credentials, service token) are
 * declared on `OAuthEnv` in server/oauth.ts, next to the endpoints that read them.
 */
import type { OAuthEnv } from '../server/oauth.ts'

export interface Env extends OAuthEnv {
  /** D1 database (tasks/prompts/frames + kv). */
  DB: D1Database
  /** Durable Object namespace for the per-task runner. */
  TASK_DO: DurableObjectNamespace<import('./task-do.ts').TaskDO>
  /** Static SPA assets (the vite build/). */
  ASSETS: Fetcher
  /** rebyte relay org key (secret: `wrangler secret put REBYTE_API_KEY`). */
  REBYTE_API_KEY: string
  /** rebyte relay base; defaults to https://api.rebyte.ai/v1 when unset. */
  REBYTE_API_URL?: string
  /** The flight MCP server's URL, registered as each employee's own connector on the MCP
   *  route (PLAN §12). Setting it turns per-employee accounts ON; unset keeps every task
   *  on the org key exactly as before, which is the deploy-free way back out.
   *  Must match the resource server's canonical URL byte for byte. */
  FLIGHT_MCP_URL?: string
  /** Shared embed gate key (secret: `wrangler secret put EMBED_KEY`). When set, every
   *  /api/app/* call must present it (X-Embed-Key header or ?k= query) or gets 401 — stops
   *  strangers who only know the domain from spinning sandboxes. Unset → gate disabled. */
  EMBED_KEY?: string

  // ── Cloudflare Access (Google login + email allowlist) ──────────────────
  /** Access team domain, e.g. `myteam.cloudflareaccess.com` (the JWT issuer). */
  CF_ACCESS_TEAM_DOMAIN?: string
  /** The Access application's AUD tag — the JWT audience to require. */
  CF_ACCESS_AUD?: string
  /** Local-dev only (.dev.vars): bypass Access and act as this email. Never set in prod. */
  DEV_EMAIL?: string
  /** Comma-separated uids allowed to WRITE the global debug config (skill ref + manager prompt),
   *  which affects ALL users. TESTING PHASE: UNSET → OPEN — anyone who reveals the debug panel (10×
   *  brand tap) can save. Set it (secret: `wrangler secret put ADMIN_UIDS`, or a `.dev.vars` line) to
   *  your own handoff `uid`(s) to lock writes down to just those. */
  ADMIN_UIDS?: string
}
