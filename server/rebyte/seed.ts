/**
 * Seed the TravelKit config into a sandbox VM's /code (CLI-probe path; mirrors worker/seed.ts):
 *   /code/.simplifly.env                 — dotenv with the per-user Simplifly credential
 *                                          (SIMPLIFLY_BASE_URL / SIMPLIFLY_AUTH_TOKEN)
 *   /code/.claude/skills/travelkit-pro/  — the search→pay policy skill (direct Simplifly OpenAPI HTTP)
 *
 * The relay runs `claude` in /code, so the project-level .claude/skills is auto-discovered; the
 * travelkit-pro skill reads .simplifly.env directly (not shell env vars). Keep in sync with
 * worker/seed.ts credentialsEnv().
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../env.ts'
import type { AgentComputer } from './provision.ts'
import { writeFile } from './sandbox.ts'
import { removeStaleArtifacts, writeClaudeMd } from '../../worker/seed.ts'

const CODE = '/code'

function walk(root: string, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(root, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel))
    else out.push(rel)
  }
  return out
}

/** Write the .simplifly.env credential + the full travelkit-pro skill tree into the VM. Returns
 *  the list of seeded paths (for logging). Idempotent — overwrites. */
export async function seedTravelkit(ac: AgentComputer): Promise<string[]> {
  const written: string[] = []

  // Per-user Simplifly credential as a dotenv file the travelkit-pro skill reads directly (it
  // searches CWD upward for the nearest .simplifly.env; it does NOT use shell env vars). Plain
  // KEY=value (no `export`), matching worker/seed.ts credentialsEnv(). Locally these come from
  // .env.local (server/env.ts); the deployed Worker injects them per-user (worker/seed.ts).
  const dotenv =
    `# Simplifly credentials for the travelkit-pro skill (probe seed).\n` +
    `SIMPLIFLY_BASE_URL=${env.SIMPLIFLY_BASE_URL}\n` +
    `SIMPLIFLY_AUTH_TOKEN=${env.SIMPLIFLY_AUTH_TOKEN}\n`
  await writeFile(ac, `${CODE}/.simplifly.env`, dotenv)
  written.push('.simplifly.env')

  const skillRoot = join(env.REPO_ROOT, '.claude', 'skills', 'travelkit-pro')
  for (const rel of walk(skillRoot)) {
    await writeFile(ac, `${CODE}/.claude/skills/travelkit-pro/${rel}`, readFileSync(join(skillRoot, rel), 'utf8'))
    written.push(`.claude/skills/travelkit-pro/${rel}`)
  }

  // CLAUDE.md VM system prompt (forces flight work through the skill; replaces cctools' default).
  await writeClaudeMd(ac)
  written.push('CLAUDE.md')

  // Same cleanup as the Worker re-seed path: really delete the old `travelkit` skill dir + legacy
  // credential files, else a probe VM seeded across versions shows two travelkit skills.
  await removeStaleArtifacts(ac)
  written.push('(removed stale: old skill dir + legacy creds)')
  return written
}
