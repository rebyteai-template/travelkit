/**
 * Process-wide env for the CLI rebyte scripts (server/rebyte/*: smoke, multiturn,
 * provision, seed). The deployed Worker uses worker/env.ts (typed bindings), not this.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const env = {
  /** Cache dir for the CLI probes' provisioned agent-computer rows (rebyte-project.json /
   *  agent-computers/), so re-runs reuse a VM instead of provisioning a fresh one. */
  DATA_DIR: process.env.TRIPDESK_DATA_DIR || join(homedir(), '.tripdesk'),

  /** Rebyte relay base. The relay runs tasks + streams stream-json events. */
  REBYTE_API_URL: process.env.REBYTE_API_URL ?? 'https://api.rebyte.ai/v1',

  /** Org/partner API key, sent as the `API_KEY` header. Put it in .env.local
   *  (gitignored); never log it. */
  REBYTE_API_KEY: process.env.REBYTE_API_KEY ?? '',

  /** Simplifly Flight OpenAPI gateway root (gateway root only — no endpoint path) + credentials
   *  for the local CLI seed path. New skill auth uses code + api key; AUTH_TOKEN is retained only
   *  for older probe VMs/skills during rollout. Put these in .env.local; never log them. */
  SIMPLIFLY_BASE_URL: process.env.SIMPLIFLY_BASE_URL ?? 'https://api-ap-east-1.simplifly.tech',
  SIMPLIFLY_CODE: process.env.SIMPLIFLY_CODE ?? process.env.SIMPLIFLY_AGENCY_CODE ?? '',
  SIMPLIFLY_API_KEY: process.env.SIMPLIFLY_API_KEY ?? process.env.SIMPLIFLY_AUTH_TOKEN ?? '',
  SIMPLIFLY_AUTH_TOKEN: process.env.SIMPLIFLY_AUTH_TOKEN ?? '',
}

export type Env = typeof env
