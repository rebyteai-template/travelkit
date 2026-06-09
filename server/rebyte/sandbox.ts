/**
 * Sandbox file ops for the CLI probe harness — pure fetch against the envd file API, mirroring
 * worker/seed.ts (the production path). We do NOT use the rebyte-sandbox SDK: its Filesystem.write
 * throws "Expected to receive information about written file" against rebyte's envd (response shape
 * mismatch — see REBYTE-NEEDS.md), and its gRPC transport adds gateway headers that 401. Raw fetch
 * with the sandbox's own X-API-KEY is the reliable path.
 *
 * The envd file API takes a multipart `file` field, auths via X-API-KEY, and auto-creates parent
 * dirs. Paths here are absolute sandbox paths (e.g. `/code/.simplifly.env`).
 */
import type { AgentComputer } from './provision.ts'

/** envd host for a sandbox: port 49983 on the sandbox subdomain (e.g. prod.rebyte.app). */
function envdHost(ac: AgentComputer): string {
  return `https://49983-${ac.sandboxId}.${new URL(ac.sandboxBaseUrl).host}`
}

/** Write a text file at an absolute sandbox path (parent dirs auto-created). */
export async function writeFile(ac: AgentComputer, path: string, content: string): Promise<void> {
  const fd = new FormData()
  fd.append('file', new Blob([content]), path.split('/').pop() ?? 'file')
  const res = await fetch(`${envdHost(ac)}/files?path=${encodeURIComponent(path)}&username=user`, {
    method: 'POST',
    headers: { 'X-API-KEY': ac.sandboxApiKey },
    body: fd,
  })
  if (!res.ok) throw new Error(`write ${path} failed: HTTP ${res.status}`)
}

/** Read a text file at an absolute sandbox path. */
export async function readFile(ac: AgentComputer, path: string): Promise<string> {
  const res = await fetch(`${envdHost(ac)}/files?path=${encodeURIComponent(path)}&username=user`, {
    headers: { 'X-API-KEY': ac.sandboxApiKey },
  })
  if (!res.ok) throw new Error(`read ${path} failed: HTTP ${res.status}`)
  return res.text()
}
