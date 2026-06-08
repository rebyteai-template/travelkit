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
import { SEED_FILES } from './seed-assets.generated.ts'
import { rebyteJSON, type RebyteConfig } from '../server/rebyte/client.ts'

export interface ProvisionedComputer {
  id: string
  sandboxId: string
  sandboxBaseUrl: string
  sandboxApiKey: string
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The per-user travelkit credential, materialized into the sandbox. Today the token lives
 *  in .mcp.json's Authorization header; when travelkit ships as a script-in-skill the token
 *  moves there — change ONLY this function (the iframe handoff / tenant logic stay put). */
function mcpJson(token: string): string {
  return JSON.stringify(
    { mcpServers: { travelkit: { type: 'http', url: 'https://mcp.travelkit.ai/mcp', headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
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

/** Write travelkit (.mcp.json + settings + skill) into the sandbox /code. The travelkit token
 *  is NOT baked into SEED_FILES (build artifact stays secret-free) — it comes per-user from the
 *  iframe handoff and is written into .mcp.json here via applyCredential. */
export async function seedSandbox(ac: ProvisionedComputer, travelkitToken: string): Promise<void> {
  for (const [rel, content] of Object.entries(SEED_FILES)) await writeFile(ac, rel, content)
  await applyCredential(ac, travelkitToken)
}

/** Overwrite ONLY the travelkit credential (.mcp.json) in an already-provisioned sandbox —
 *  used when the user's token rotates (re-login) so we refresh in place instead of rebuilding
 *  the VM. This is the single chokepoint for "where the token lives"; the future script-in-skill
 *  migration changes only this + mcpJson(). */
export async function applyCredential(ac: ProvisionedComputer, travelkitToken: string): Promise<void> {
  await writeFile(ac, '.mcp.json', mcpJson(travelkitToken))
}
