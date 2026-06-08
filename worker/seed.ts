/**
 * Per-user sandbox provisioning + seeding — pure fetch, Workers-native (no rebyte-sandbox
 * SDK; it drags in tar/fs and can't run on Workers).
 *
 *   provisionComputer() → POST /v1/agent-computers (rebyte relay API)
 *   seedSandbox()       → POST https://49983-<sandboxId>.<domain>/files (envd file API)
 *
 * The envd file API takes a multipart `file` field, auth via the sandbox's own X-API-KEY,
 * and auto-creates parent dirs — all verified against a live sandbox.
 */
import { SEED_FILES, SEED_VERSION } from './seed-assets.generated.ts'
import { rebyteJSON, type RebyteConfig } from '../server/rebyte/client.ts'

export { SEED_VERSION }

export interface ProvisionedComputer {
  id: string
  sandboxId: string
  sandboxBaseUrl: string
  sandboxApiKey: string
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Simplifly Flight OpenAPI gateway root — gateway root ONLY, no endpoint path. Not a secret
 *  (just the base URL), so it's hardcoded here per deployment. ap-east-1 region. */
const SIMPLIFLY_BASE_URL = 'https://api-ap-east-1.simplifly.tech'

/** The per-user Simplifly credential, written to `.claude/settings.json` `env`. NOTE: the rebyte
 *  sandbox does NOT export this `env` into the agent's shell (a live VM showed `env | grep SIMPLIFLY`
 *  empty — a known rebyte gap, see REBYTE-NEEDS.md), so this is a secondary mirror; the agent gets
 *  the credential by sourcing `.simplifly.env` (credentialsEnv). Keep both in sync — this +
 *  credentialsEnv + applyCredential are the single chokepoint for "where the token lives". */
function settingsJson(token: string): string {
  return JSON.stringify(
    { env: { SIMPLIFLY_BASE_URL, SIMPLIFLY_AUTH_TOKEN: token } },
    null,
    2,
  )
}

/** Sourceable shell file (`/code/.simplifly.env`) with the per-user credential — the working
 *  mechanism, since `.claude/settings.json` `env` isn't exported into the sandbox shell. SKILL.md
 *  tells the agent to `source` this before API calls. TEMPORARY stopgap until rebyte injects env
 *  natively (REBYTE-NEEDS.md). Single-quoted; the token is a JWT, so it never contains a quote. */
function credentialsEnv(token: string): string {
  return (
    `# Simplifly credentials for the travelkit skill (per-user, written at sandbox seed time).\n` +
    `# Load before each Simplifly API bash call:  set -a; source /code/.simplifly.env; set +a\n` +
    `export SIMPLIFLY_BASE_URL='${SIMPLIFLY_BASE_URL}'\n` +
    `export SIMPLIFLY_AUTH_TOKEN='${token}'\n`
  )
}

/** Provision a fresh agent-computer and wait until sandboxId is populated (the VM is
 *  addressable). Polls ~80s. */
export async function provisionComputer(config: RebyteConfig, name: string): Promise<ProvisionedComputer> {
  const created = await rebyteJSON<ProvisionedComputer>('/agent-computers', {
    method: 'POST',
    body: JSON.stringify({ name }),
    config,
  })
  if (created.sandboxId) return created
  for (let i = 0; i < 40; i++) {
    await sleep(2000)
    const fresh = await rebyteJSON<ProvisionedComputer>(`/agent-computers/${created.id}`, { config })
    if (fresh.sandboxId) return { ...created, ...fresh }
  }
  throw new Error(`agent-computer ${created.id} 80s 内未就绪`)
}

/** Write one file into the sandbox /code via the envd file API (multipart POST; nested paths
 *  auto-create dirs). */
async function writeFile(ac: ProvisionedComputer, rel: string, content: string): Promise<void> {
  const host = `https://49983-${ac.sandboxId}.${new URL(ac.sandboxBaseUrl).host}` // e.g. prod.rebyte.app
  const fd = new FormData()
  fd.append('file', new Blob([content]), rel.split('/').pop() ?? 'file')
  const res = await fetch(`${host}/files?path=${encodeURIComponent('/code/' + rel)}&username=user`, {
    method: 'POST',
    headers: { 'X-API-KEY': ac.sandboxApiKey },
    body: fd,
  })
  if (!res.ok) throw new Error(`write ${rel} failed: HTTP ${res.status}`)
}

/** Write the travelkit skill + per-user Simplifly credential into the sandbox /code. The token
 *  is NOT baked into SEED_FILES (build artifact stays secret-free) — it comes per-user from the
 *  iframe handoff and is written into .claude/settings.json here via applyCredential. */
export async function seedSandbox(ac: ProvisionedComputer, travelkitToken: string): Promise<void> {
  await pushSeedFiles(ac)
  await applyCredential(ac, travelkitToken)
}

/** Re-push ONLY the skill tree (SEED_FILES), not the credential — used to refresh an existing
 *  sandbox after the skill changed (seed_version bump) when no token is at hand. Idempotent
 *  overwrites via the envd file API; no reprovision. */
export async function pushSeedFiles(ac: ProvisionedComputer): Promise<void> {
  for (const [rel, content] of Object.entries(SEED_FILES)) await writeFile(ac, rel, content)
}

/** Files an earlier seed version created that the current design no longer wants. The envd file
 *  API has no DELETE (returns 405), so on re-seed we can't remove them — instead we overwrite
 *  them with inert content. `.mcp.json`: neutralize the legacy travelkit MCP wiring (the new
 *  skill talks direct HTTP, not MCP) so Claude Code can't load a dead server. Removed reference
 *  `.md` files are passive (the fresh SKILL.md no longer links them) and left as-is. */
const STALE_NEUTRALIZE: Record<string, string> = {
  '.mcp.json': JSON.stringify({ mcpServers: {} }, null, 2) + '\n',
}

/** Overwrite stale artifacts with inert content. Only meaningful on re-seed of a sandbox built by
 *  an older seed version; harmless (idempotent no-op writes) otherwise. */
export async function neutralizeStaleArtifacts(ac: ProvisionedComputer): Promise<void> {
  for (const [rel, content] of Object.entries(STALE_NEUTRALIZE)) await writeFile(ac, rel, content)
}

/** Write the per-user Simplifly credential into an already-provisioned sandbox — used at seed time
 *  and when the user's token rotates (re-login), refreshing in place instead of rebuilding the VM.
 *  Writes both sinks: `.simplifly.env` (the file the skill sources) and `.claude/settings.json`
 *  `env` (mirror). Single chokepoint for "where the token lives"; see credentialsEnv()/settingsJson(). */
export async function applyCredential(ac: ProvisionedComputer, travelkitToken: string): Promise<void> {
  await writeFile(ac, '.simplifly.env', credentialsEnv(travelkitToken))
  await writeFile(ac, '.claude/settings.json', settingsJson(travelkitToken))
}
