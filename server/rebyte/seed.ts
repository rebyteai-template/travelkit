/**
 * Seed the TravelKit per-user config into a sandbox VM's /code (CLI-probe path; mirrors
 * worker/seed.ts seedSandbox). Writes ONLY:
 *   /code/.simplifly.env   — dotenv with the per-user Simplifly credential
 *                            (SIMPLIFLY_BASE_URL / SIMPLIFLY_CODE / SIMPLIFLY_API_KEY)
 *   /code/CLAUDE.md        — the VM system prompt (forces flight work through the skill)
 *
 * The SKILL itself is NOT seeded here anymore: the relay installs `simplifly-flyai-skill` from GitHub
 * (cctools skills v3) when a task is created with `skills: [toSkillRef(SKILL_REF)]` — the probes pass it on their
 * POST /tasks. The simplifly-flyai-skill skill reads .simplifly.env directly (not shell env vars). Keep the
 * credential format in sync with worker/seed.ts credentialsEnv().
 */
import { env } from '../env.ts'
import type { AgentComputer } from './provision.ts'
import { writeFile } from './sandbox.ts'
import { removeStaleArtifacts, writeClaudeMd } from '../../worker/seed.ts'

const CODE = '/code'

/** Write the .simplifly.env credential + the VM system prompt into the VM, and purge any retired
 *  vendored skill tree from a reused probe VM. Returns the list of seeded paths (for logging).
 *  Idempotent — overwrites. The skill install itself rides on the probe's POST /tasks `skills`. */
export async function seedTravelkit(ac: AgentComputer): Promise<string[]> {
  const written: string[] = []

  // Per-user Simplifly credential as a dotenv file the simplifly-flyai-skill skill reads directly (it
  // searches CWD upward for the nearest .simplifly.env; it does NOT use shell env vars). Plain
  // KEY=value (no `export`), matching worker/seed.ts credentialsEnv(). Locally these come from
  // .env.local (server/env.ts); the deployed Worker injects them per-user (worker/seed.ts).
  const dotenv =
    `# Simplifly credentials for the simplifly-flyai-skill skill (probe seed).\n` +
    `SIMPLIFLY_BASE_URL=${env.SIMPLIFLY_BASE_URL}\n` +
    `SIMPLIFLY_CODE=${env.SIMPLIFLY_CODE}\n` +
    `SIMPLIFLY_API_KEY=${env.SIMPLIFLY_API_KEY}\n` +
    `SIMPLIFLY_AUTH_TOKEN=${env.SIMPLIFLY_AUTH_TOKEN}\n`
  await writeFile(ac, `${CODE}/.simplifly.env`, dotenv)
  written.push('.simplifly.env')

  // CLAUDE.md VM system prompt (forces flight work through the skill; replaces cctools' default).
  await writeClaudeMd(ac)
  written.push('CLAUDE.md')

  // Same cleanup as the Worker re-seed path: really delete the retired vendored skill dirs
  // (travelkit / travelkit-pro) + legacy credential files, else a probe VM seeded across versions
  // shows the old skill alongside the skills-v3-installed simplifly-flyai-skill.
  await removeStaleArtifacts(ac)
  written.push('(removed stale: retired skill dirs + legacy creds)')
  return written
}
