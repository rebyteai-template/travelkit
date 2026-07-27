// Export one real prompt's frames from the local dev D1 into a regression fixture:
//   node scripts/export-frame-fixture.mjs <promptId> <name> [expectedPlans]
//
// Executor transport shapes are discovered, not designed — a hand-written envelope can
// only re-confirm what we already handled. A `<persisted-output>` regression passed 33/33
// authored tests while losing the table in 8 real sessions, so positive fixtures come
// from here, verbatim. Negative ones may mutate a captured envelope, never invent one.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const D1_DIR = join(ROOT, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
const [promptId, name, expectedPlans = '0'] = process.argv.slice(2)
if (!promptId || !name) throw new Error('usage: export-frame-fixture.mjs <promptId> <name> [expectedPlans]')

const dbFile = readdirSync(D1_DIR).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
// immutable=1: miniflare keeps the file in WAL mode, which a read-only handle can't attach
// to. Export between turns — a snapshot of a database being written is not consistent.
const query = (sql) => JSON.parse(execFileSync('sqlite3', [`file:${join(D1_DIR, dbFile)}?immutable=1`, '-json', sql], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
}) || '[]')

const [prompt] = query(`SELECT id, prompt, status, created_at, completed_at FROM prompts WHERE id = '${promptId}'`)
if (!prompt) throw new Error(`prompt ${promptId} not found in the local D1`)
const rows = query(`SELECT seq, data FROM frames WHERE prompt_id = '${promptId}' ORDER BY seq`)

const out = join(ROOT, 'server/fixtures/domain-results', `${name}.json`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify({
  source: `local dev D1, prompt ${promptId}`,
  // The invariant every valid trace must hold, whatever the transport was.
  expect: { plans: Number(expectedPlans), recommendationBubbles: 1, markdownTables: 0 },
  prompt: { ...prompt, attachments: [], frames: rows.map((r) => ({ seq: r.seq, data: JSON.parse(r.data) })) },
}, null, 2)}\n`)
console.log(`wrote ${out} (${rows.length} frames)`)
