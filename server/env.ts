/**
 * Process-wide env for the CLI rebyte scripts (server/rebyte/*: smoke, multiturn,
 * provision, seed). The deployed Worker uses worker/env.ts (typed bindings), not this.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const env = {
  /** Root for per-session project working dirs (holds the travelkit-pro skill the
   *  seed scripts upload to a sandbox). */
  DATA_DIR: process.env.TRIPDESK_DATA_DIR || join(homedir(), '.tripdesk'),

  /** Repo root — source of the travelkit-pro skill the seed scripts read. */
  REPO_ROOT: process.cwd(),

  /** Rebyte relay base. The relay runs tasks + streams stream-json events. */
  REBYTE_API_URL: process.env.REBYTE_API_URL ?? 'https://api.rebyte.ai/v1',

  /** Org/partner API key, sent as the `API_KEY` header. Put it in .env.local
   *  (gitignored); never log it. */
  REBYTE_API_KEY: process.env.REBYTE_API_KEY ?? '',

  /** Simplifly Flight OpenAPI gateway root (gateway root only — no endpoint path) + the
   *  per-user auth token, for the local CLI seed path. Put both in .env.local; never log the
   *  token. The deployed Worker hardcodes the URL + injects the token per-user (worker/seed.ts). */
  SIMPLIFLY_BASE_URL: process.env.SIMPLIFLY_BASE_URL ?? 'https://api-ap-east-1.simplifly.tech',
  SIMPLIFLY_AUTH_TOKEN: process.env.SIMPLIFLY_AUTH_TOKEN ?? '',
}

export type Env = typeof env
