/**
 * Agent-computer (sandbox VM) provisioning for the rebyte backend.
 *
 * Ported from adits' rebyteFileStore.createProject, de-multi-tenant'd: TripDesk
 * has one default project, so we persist the provisioned VM config to a JSON
 * file under DATA_DIR instead of a Postgres `projects` row. The agent runs in
 * this VM's /code; seed.ts writes the per-user Simplifly credential (.simplifly.env) + skill there.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../env.ts'
import { rebyteJSON } from './client.ts'

/** Shape returned by POST /agent-computers (and the GET poll). */
export interface AgentComputer {
  id: string
  status: string
  sandboxId: string
  sandboxBaseUrl: string
  sandboxApiKey: string
}

function configPath(): string {
  return join(env.DATA_DIR, 'rebyte-project.json')
}

function loadCached(): AgentComputer | null {
  const p = configPath()
  if (!existsSync(p)) return null
  try {
    const ac = JSON.parse(readFileSync(p, 'utf8')) as Partial<AgentComputer>
    return ac.sandboxId ? (ac as AgentComputer) : null
  } catch {
    return null
  }
}

function persist(ac: AgentComputer): void {
  mkdirSync(env.DATA_DIR, { recursive: true })
  writeFileSync(configPath(), JSON.stringify(ac, null, 2))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Provision a fresh agent-computer and wait until its sandboxId is populated
 *  (the signal the VM is addressable). Polls every 2s for ~60s. */
export async function provisionAgentComputer(name: string): Promise<AgentComputer> {
  const created = await rebyteJSON<AgentComputer>('/agent-computers', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  if (created.sandboxId) return created
  for (let i = 0; i < 30; i++) {
    await sleep(2000)
    const fresh = await rebyteJSON<AgentComputer>(`/agent-computers/${created.id}`)
    if (fresh.sandboxId) return { ...created, ...fresh }
  }
  throw new Error(`agent-computer ${created.id} 60s 内未就绪`)
}

/** Return the default project's VM, provisioning + persisting it on first call.
 *  Idempotent across boots via the DATA_DIR config file. */
export async function ensureDefaultAgentComputer(name = 'tripdesk-default'): Promise<AgentComputer> {
  const cached = loadCached()
  if (cached) return cached
  const ac = await provisionAgentComputer(name)
  persist(ac)
  return ac
}

export { loadCached as loadCachedAgentComputer }
