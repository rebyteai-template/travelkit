/**
 * Per-user sandbox provisioning + seeding — pure fetch, Workers-native (no rebyte-sandbox SDK; it
 * pulls node fs/tar into the bundle, AND its gRPC transport sends gateway headers that 401 against
 * rebyte's envd — both verified, see removeFile).
 *
 * The SKILL is no longer seeded here: cctools skills v3 installs `simplifly-flyai-skill` from GitHub into the
 * VM (worker/task-do.ts `SKILL_REF` → POST /v1/tasks `skills`). This file now only writes the two
 * genuinely per-deployment/per-user things — the VM system prompt (/code/CLAUDE.md) and the per-user
 * `.simplifly.env` credential — plus one-time cleanup of the retired skill tree on reused sandboxes.
 *
 *   provisionComputer() → POST /v1/agent-computers (rebyte relay API)
 *   writeFile()         → POST https://49983-<sandboxId>.<domain>/files          (envd REST)
 *   removeFile()        → POST https://49983-<sandboxId>.<domain>/filesystem.Filesystem/Remove
 *                         (envd gRPC-Web — REST /files has no DELETE, returns 405)
 *
 * The envd file API takes a multipart `file` field, auth via the sandbox's own X-API-KEY, and
 * auto-creates parent dirs — all verified against a live sandbox.
 */
import { SEED_CLAUDE_MD, SEED_VERSION } from './vm-system-prompt.ts'
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

/** The per-user Simplifly credential as a standard dotenv file (`/code/.simplifly.env`). The
 *  simplifly-flyai-skill skill reads this file DIRECTLY — it searches from CWD upward for the nearest
 *  `.simplifly.env` and parses it as dotenv (see the skill's api-map.md); it does NOT rely on shell
 *  env vars. So this is the single source of the credential — no `.claude/settings.json` mirror, no
 *  `source` step. Plain `KEY=value` (no `export ` prefix — not every dotenv parser strips it). The
 *  token is a JWT (no quotes/newlines), so values need no quoting. This + applyCredential are the
 *  single chokepoint for "where the token lives". */
function credentialsEnv(token: string): string {
  return (
    `# Simplifly credentials for the simplifly-flyai-skill skill (per-user, written at sandbox seed time).\n` +
    `SIMPLIFLY_BASE_URL=${SIMPLIFLY_BASE_URL}\n` +
    `SIMPLIFLY_AUTH_TOKEN=${token}\n`
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

/** Seed the two per-deployment/per-user files into the sandbox /code — the VM system prompt
 *  (/code/CLAUDE.md, via writeClaudeMd) and the per-user Simplifly credential (/code/.simplifly.env,
 *  via applyCredential). The SKILL itself is NOT written here: the relay installs `simplifly-flyai-skill`
 *  from GitHub (skills v3). The token is NOT part of any build artifact — it comes per-user from the
 *  iframe handoff. */
export async function seedSandbox(ac: ProvisionedComputer, travelkitToken: string): Promise<void> {
  // Disjoint files (/code/CLAUDE.md vs /code/.simplifly.env), independent envd calls → write in parallel.
  await Promise.all([writeClaudeMd(ac), applyCredential(ac, travelkitToken)])
}

/** Write /code/CLAUDE.md — the VM system prompt (Claude Code's native project memory) that forces
 *  flight work through the simplifly-flyai-skill skill and defers safety/business red-lines to the skill's
 *  Core Boundaries. This REPLACES cctools' default system_prompt.md, whose generic guidance steers
 *  the agent to web search instead of our skill.
 *
 *  CRITICAL ordering bug we MUST defeat: the relay seeds /code/CLAUDE.md as a SYMLINK
 *  → /home/user/system_prompt.md during VM creation (cctools `seedClaudeMdSymlink`, called inside
 *  `provisionVM` → `createNew`). That runs BEFORE we ever write — `sandbox_id` only surfaces to our
 *  poll AFTER the relay's create transaction (which contains the symlink seeding) commits. So by the
 *  time we have a sandbox to write to, /code/CLAUDE.md is ALREADY that symlink, and BOTH envd file
 *  ops FOLLOW it: a plain write lands in system_prompt.md (which the relay's `writeSystemPrompt`
 *  re-clobbers with its generic meta.md on EVERY prompt → our VM system prompt is silently lost and
 *  the agent web-searches), and a single gRPC Remove deletes the symlink's TARGET, leaving a
 *  DANGLING symlink at /code/CLAUDE.md (verified against a live sandbox: after one Remove both
 *  CLAUDE.md and system_prompt.md 404). A subsequent write would then re-follow the dangling link
 *  and recreate system_prompt.md — same trap.
 *
 *  So we Remove TWICE: the 1st follows the link and deletes the target (link goes dangling); the 2nd
 *  finds a dangling link with no target to follow and deletes the LINK ITSELF. Only then is the path
 *  clear for a REAL regular file that envd can't follow anywhere. The relay only seeds the symlink in
 *  `createNew` (never on reconnect) and `writeSystemPrompt` only ever touches system_prompt.md, so a
 *  real file here can no longer be clobbered. removeFile treats absent (grpc-status 5) as a no-op, so
 *  the 2nd Remove is harmless when the 1st already cleared everything, making this safe on fresh,
 *  re-seed, and reused sandboxes alike. */
export async function writeClaudeMd(ac: ProvisionedComputer): Promise<void> {
  await removeFile(ac, 'CLAUDE.md') // 1st: follows the relay's symlink, deletes its target → link dangles
  await removeFile(ac, 'CLAUDE.md') // 2nd: dangling link has no target to follow → deletes the link itself
  await writeFile(ac, 'CLAUDE.md', SEED_CLAUDE_MD) // path is clear → lands as a real file
}

/** Paths (relative to /code) an earlier seed version created that the current design no longer
 *  wants — really deleted from reused sandboxes at re-seed (removeStaleArtifacts). Deleting an
 *  absent file is a no-op (grpc-status 5), so listing a path that was never written is harmless.
 *   · `.mcp.json` — legacy travelkit MCP wiring (the skill talks direct HTTP, not MCP); a dead
 *     server Claude Code would otherwise try to load.
 *   · `.claude/settings.json` — legacy per-user credential mirror; no longer written (the skill
 *     reads `.simplifly.env` directly), so the old copy must be purged to not leave a stale token.
 *   · `.claude/skills/travelkit` + `.claude/skills/travelkit-pro` — retired vendored skill DIRs. The
 *     skill is now `simplifly-flyai-skill`, installed by the relay (skills v3) into
 *     `~/.claude/skills/simplifly-flyai-skill` — a DIFFERENT path, so without deletion the old vendored
 *     tree(s) under /code coexist and the agent loads two flight skills. Listed as directories (not
 *     files): envd `Remove` is recursive (verified — one call nukes the subtree + the dir), robust to
 *     whatever files an older seed version left under them, and leaves no empty dir behind. */
const STALE_FILES: string[] = [
  '.mcp.json',
  '.claude/settings.json',
  '.claude/skills/travelkit', // recursive: whole old (gen-1) skill subtree
  '.claude/skills/travelkit-pro', // recursive: retired vendored skill (now simplifly-flyai-skill via skills v3)
]

/** Wrap a protobuf message in a gRPC-Web data frame: 1 flag byte (0) + 4-byte big-endian length.
 *  Backed by a concrete ArrayBuffer so the result is a valid BlobPart under the Workers fetch types. */
function grpcWebFrame(msg: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(5 + msg.length)
  const out = new Uint8Array(buf)
  new DataView(buf).setUint32(1, msg.length) // out[0] flag = 0 (uncompressed data)
  out.set(msg, 5)
  return out
}

/** Encode a uint as a protobuf varint (path lengths can exceed 127 bytes for deep skill paths). */
function varint(n: number): number[] {
  const b: number[] = []
  while (n > 0x7f) { b.push((n & 0x7f) | 0x80); n >>>= 7 }
  b.push(n)
  return b
}

/** Delete a file OR directory (path relative to /code) via the envd Filesystem gRPC-Web service.
 *  Directory removal is RECURSIVE — one call deletes the whole subtree and the dir itself (verified
 *  against a live sandbox). The REST /files endpoint has no DELETE (405, allow: GET,HEAD,POST), but
 *  `filesystem.Filesystem/Remove` does — and takes the SAME auth as our writes (X-API-KEY + Basic
 *  `user:`), no JWT/team_id. Hand-rolled (pure fetch, no SDK: the SDK's transport adds gateway
 *  headers that 401 here, and drags node fs into the Worker bundle). RemoveRequest is
 *  `{ string path = 1 }`. gRPC-Web always returns HTTP 200; the real status is in a trailer frame —
 *  0 = ok, 5 = NotFound (treated as success: idempotent). */
export async function removeFile(ac: ProvisionedComputer, rel: string): Promise<void> {
  const host = `https://49983-${ac.sandboxId}.${new URL(ac.sandboxBaseUrl).host}`
  const pathBytes = new TextEncoder().encode('/code/' + rel)
  // protobuf RemoveRequest: field 1 (path), wire type 2 (length-delimited) → tag 0x0a, len, bytes
  const msg = Uint8Array.from([0x0a, ...varint(pathBytes.length), ...pathBytes])
  const res = await fetch(`${host}/filesystem.Filesystem/Remove`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/grpc-web+proto',
      'X-API-KEY': ac.sandboxApiKey,
      Authorization: 'Basic ' + btoa('user:'),
    },
    body: new Blob([grpcWebFrame(msg)]),
    redirect: 'follow', // connect/envoy gateways may 30x; Workers reject the default redirect:'error'
  })
  if (!res.ok) throw new Error(`remove ${rel} failed: HTTP ${res.status}`)
  // grpc-status surfaces either as a response header (trailers-only) or in the body trailer frame.
  const headerStatus = res.headers.get('grpc-status')
  const raw = headerStatus ?? new TextDecoder().decode(await res.arrayBuffer())
  const m = /grpc-status:?\s*(\d+)/.exec(raw)
  const status = m ? Number(m[1]) : 0 // no trailer found on a 200 → treat as ok
  if (status !== 0 && status !== 5) throw new Error(`remove ${rel}: grpc-status ${status}`)
}

/** Really delete stale artifacts (files or whole dirs — see STALE_FILES). Only meaningful on re-seed
 *  of a sandbox built by an older seed version; on a clean sandbox the paths are absent (grpc-status
 *  5) and removeFile no-ops. Best-effort per entry so one failure doesn't block the rest. */
export async function removeStaleArtifacts(ac: ProvisionedComputer): Promise<void> {
  for (const rel of STALE_FILES) {
    try {
      await removeFile(ac, rel)
    } catch (e) {
      console.warn(`[seed] removeStaleArtifacts ${rel}:`, (e as Error).message)
    }
  }
}

/** Write the per-user Simplifly credential into an already-provisioned sandbox — used at seed time
 *  and when the user's token rotates (re-login), refreshing in place instead of rebuilding the VM.
 *  Writes the single sink `.simplifly.env` (the dotenv file the simplifly-flyai-skill skill reads directly).
 *  Single chokepoint for "where the token lives"; see credentialsEnv(). */
export async function applyCredential(ac: ProvisionedComputer, travelkitToken: string): Promise<void> {
  await writeFile(ac, '.simplifly.env', credentialsEnv(travelkitToken))
}
