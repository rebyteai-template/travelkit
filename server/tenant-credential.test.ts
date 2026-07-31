/**
 * Credential intake (server/tenant-credential.ts). The whole contract is one sentence — every
 * request that carries a tenant token overwrites the row, unconditionally (PLAN §4.3) — so most
 * of what is pinned here is the ABSENCE of a policy: the cases a transition policy would refuse
 * must land, because this module is the only writer and a refused write is permanent.
 *
 * Run: node --import tsx --test server/tenant-credential.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  credentialFingerprint,
  isWellFormedCredential,
  persistTenantCredential,
  type CredentialStore,
} from './tenant-credential.ts'

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Simplifly's real shape: `{ id, createdAt }`, no `exp` — which is why nothing here judges
 *  validity. The signature is opaque to us (we do not hold their key), so it is filler. */
const jwt = (id: number, createdAt: number): string =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ id, createdAt })}.c2ln`

const ALICE = jwt(10086, 1_750_000_000)
const ALICE_NEWER = jwt(10086, 1_760_000_000)
const BOB = jwt(20250, 1_760_000_000)
const TENANT = 'ORG42:EMP10086'

function memoryStore(seed: Record<string, string> = {}, fault?: 'read' | 'write'): CredentialStore & { rows: Map<string, string> } {
  const rows = new Map(Object.entries(seed))
  return {
    rows,
    async getTenantCredential(userEmail) {
      if (fault === 'read') throw new Error('D1_ERROR: no such table: tenant_credentials')
      return rows.get(userEmail)
    },
    async saveTenantCredential(userEmail, token) {
      if (fault === 'write') throw new Error('D1_ERROR: no such table: tenant_credentials')
      rows.set(userEmail, token)
    },
  }
}

async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  try {
    return { result: await run(), lines }
  } finally {
    console.log = original
  }
}

test('THE CONTRACT: the last token received wins, whatever it is and whatever it replaces', async () => {
  // Each of these three was, for one round, refused by an intake policy. Each refusal was
  // PERMANENT — this module is the only writer (no delete, no override, no TTL), so a refused
  // row keeps being served to /internal, Simplifly answers 401020, the employee is told to reopen
  // FlyAI, and reopening hands us the very token being refused. A stale row beats a stuck one.
  for (const [name, incoming] of [
    ['an opaque blob where a JWS used to be (an upstream token-format change)', 'TK_opaque_not_a_jws'],
    ['a token naming a different upstream account (an account re-provision)', BOB],
    ['a token minted before the one we hold (clock skew, or a re-issue)', jwt(10086, 1_700_000_000)],
  ] as const) {
    const store = memoryStore({ [TENANT]: ALICE_NEWER })
    assert.equal(await persistTenantCredential(store, TENANT, incoming), 'rotated', name)
    assert.equal(store.rows.get(TENANT), incoming, name)
  }
})

test('a tenant can never be stranded: whatever the history, one good handoff repairs the row', async () => {
  const store = memoryStore()
  for (const token of ['TK_dev', ALICE, 'junk', BOB, ALICE_NEWER]) {
    await persistTenantCredential(store, TENANT, token)
  }
  assert.equal(store.rows.get(TENANT), ALICE_NEWER, 'the most recent handoff is what /internal serves')
})

test('the three landings are named for the audit line, and only one of them is quiet', async () => {
  const store = memoryStore()
  assert.equal(await persistTenantCredential(store, TENANT, ALICE), 'created')
  assert.equal(await persistTenantCredential(store, TENANT, ALICE), 'unchanged')
  assert.equal(await persistTenantCredential(store, TENANT, ALICE_NEWER), 'rotated')
})

test('unchanged still writes — that is what makes last_seen_at mean "alive"', async () => {
  const store = memoryStore({ [TENANT]: ALICE })
  let writes = 0
  const counting: CredentialStore = {
    getTenantCredential: (email) => store.getTenantCredential(email),
    saveTenantCredential: async (email, token) => {
      writes += 1
      await store.saveTenantCredential(email, token)
    },
  }
  assert.equal(await persistTenantCredential(counting, TENANT, ALICE), 'unchanged')
  assert.equal(writes, 1)
})

test('every overwrite is logged with fingerprints, and no line carries the credential', async () => {
  // Nothing refuses an overwrite any more, so this line is the ENTIRE trace of one: it is how a
  // legitimate re-login and an unsigned-handoff poisoning are told apart after the fact.
  const store = memoryStore()
  const { lines } = await captureLogs(async () => {
    await persistTenantCredential(store, TENANT, ALICE)
    await persistTenantCredential(store, TENANT, ALICE) // quiet
    await persistTenantCredential(store, TENANT, BOB)
  })
  assert.equal(lines.length, 2, 'created + rotated; the unchanged write says nothing')
  assert.match(lines[0] ?? '', new RegExp(`^\\[credential\\] created tenant=${TENANT} cred=[0-9a-f]{12} previous=none$`))
  const alice = await credentialFingerprint(ALICE)
  const bob = await credentialFingerprint(BOB)
  assert.equal(lines[1], `[credential] rotated tenant=${TENANT} cred=${bob} previous=${alice}`)
  for (const line of lines) {
    assert.equal(line.includes(ALICE), false, `credential leaked into a log line: ${line}`)
    assert.equal(line.includes(BOB), false)
  }
})

test('a storage failure is reported, never swallowed and never mistaken for success', async () => {
  for (const fault of ['read', 'write'] as const) {
    const store = memoryStore({}, fault)
    assert.equal(await persistTenantCredential(store, TENANT, ALICE), 'store_unavailable', fault)
  }
})

test('the sanity bound rejects only what could never have worked', () => {
  // Not an opinion about the value — the only thing it stops is a string that would corrupt the
  // sandbox's `.simplifly.env` (worker/seed.ts writes `SIMPLIFLY_AUTH_TOKEN=<token>\n`), where a
  // newline injects further env lines.
  assert.equal(isWellFormedCredential('TK_good\nSIMPLIFLY_BASE_URL=https://evil.example'), false)
  assert.equal(isWellFormedCredential('has\ttab'), false)
  assert.equal(isWellFormedCredential('nul\0byte'), false)
  assert.equal(isWellFormedCredential(''), false)
  // Everything else passes, including every shape that works today and several that merely look
  // odd: this bound must never be the reason a real credential is turned away.
  for (const token of [ALICE, 'TK_opaque_dev_token', 'x'.repeat(20_000), 'has space', 'ünïcödé', '{"not":"a token"}']) {
    assert.equal(isWellFormedCredential(token), true, token.slice(0, 40))
  }
})

test('fingerprints correlate a credential across hops and reveal nothing', async () => {
  const a = await credentialFingerprint(ALICE)
  assert.match(a, /^[0-9a-f]{12}$/)
  assert.equal(a, await credentialFingerprint(ALICE), 'stable')
  assert.notEqual(a, await credentialFingerprint(BOB))
  assert.equal(ALICE.includes(a), false, 'not a substring of the credential')
})
