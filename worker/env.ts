/**
 * Worker runtime bindings (wrangler.jsonc). Shared by the Worker entry and the
 * Durable Object. The travelkit MCP token is NOT here — it only lives inside the
 * sandbox VM's seeded .mcp.json (written by the bootstrap), so the Worker/DO never
 * sees it; they only need the rebyte relay key.
 */
export interface Env {
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
}
