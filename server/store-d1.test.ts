/**
 * The credential SQL in server/store-d1.ts, run against a REAL SQLite (D1 is SQLite, and the
 * migrations in migrations/ are read off disk here rather than restated) — the one layer the
 * other suites stub out.
 *
 * It exists because of a claim that was argued but never exercised: that
 * `probeCredentialStore()` catches a broken write plane which "a plain SELECT would not have
 * caught". That claim is only true if the probe's SQL and the read's SQL genuinely fail apart,
 * which is a property of the statements themselves — a hand-written double can be made to say
 * anything. The half-applied-migration case below is the real thing: 0007 without 0008.
 *
 * `node:sqlite` is experimental in node 22 (it prints a warning); nothing here depends on more
 * than prepare/exec, and the alternative is not testing the SQL at all.
 *
 * Run: node --import tsx --test server/store-d1.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { exportJWK, generateKeyPair } from 'jose'
import { createD1Store, CREDENTIAL_PROBE_KEY } from './store-d1.ts'
import { authorizationServer, formatActor } from './oauth.ts'
import { persistTenantCredential } from './tenant-credential.ts'
import type { Store } from './store.ts'
import type { OAuthEnv } from './oauth.ts'

const migration = (file: string): string => readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8')
const CREATE_TABLE = migration('0007_tenant_credential.sql')
const ADD_LAST_SEEN = migration('0008_credential_observability.sql')
const INIT_TABLES = migration('0001_init.sql')
const MULTITENANT = migration('0002_multitenant.sql')
const ROUTE_MODE = migration('0009_task_route_mode.sql')
const OAUTH_CLIENTS = migration('0010_oauth_clients.sql')
const EMPLOYEE_ACCOUNTS = migration('0011_employee_accounts.sql')

const TENANT = formatActor('ORG42', 'EMP10086')
const ALICE = 'TK_alice'

const { privateKey } = await generateKeyPair('ES256', { extractable: true })
const SIGNING_KEY = JSON.stringify({ ...(await exportJWK(privateKey)), alg: 'ES256', use: 'sig', kid: 'store-test' })

/** The slice of the D1Database surface store-d1.ts actually uses, over node:sqlite. Deliberately
 *  thin: the point is that the SQL STRINGS are the real ones and SQLite is the real thing. */
function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql)
      const bound: unknown[] = []
      const self = {
        bind(...args: unknown[]) {
          bound.push(...args)
          return self
        },
        async run() {
          const { changes } = statement.run(...(bound as never[]))
          return { meta: { changes: Number(changes) } }
        },
        async first<T>() {
          return (statement.get(...(bound as never[])) as T | undefined) ?? null
        },
        async all<T>() {
          return { results: statement.all(...(bound as never[])) as T[] }
        },
      }
      return self
    },
  } as unknown as D1Database
}

interface Fixture {
  store: Store
  db: DatabaseSync
  row: () => { token: string; updated_at: string; last_seen_at: string | null } | undefined
}

function fixture(migrations: string[]): Fixture {
  const db = new DatabaseSync(':memory:')
  for (const sql of migrations) db.exec(sql)
  return {
    db,
    store: createD1Store(d1(db)),
    row: () =>
      db.prepare(`SELECT * FROM tenant_credentials WHERE user_email = ?`).get(TENANT) as
        | { token: string; updated_at: string; last_seen_at: string | null }
        | undefined,
  }
}

test('THE PROBE IS REAL: a half-applied migration passes the SELECT and fails the WRITE', async () => {
  // 0007 applied, 0008 not — a deploy where code reached the edge before `d1 migrations apply`,
  // or an apply that stopped halfway. This is the state the probe was written for.
  const { store } = fixture([CREATE_TABLE])

  // The read succeeds and reports "no credential for this tenant". Nothing about it is wrong; it
  // is simply answering a different question, which is exactly why it cannot stand in for a probe.
  assert.equal(await store.getTenantCredential(TENANT), undefined)

  // The write plane is down: `last_seen_at` does not exist yet.
  await assert.rejects(store.probeCredentialStore(), /last_seen_at/)
  await assert.rejects(store.saveTenantCredential(TENANT, ALICE), /last_seen_at/)
})

test('…and that difference is what decides "reopen FlyAI" vs "retry": 503, not 400', async () => {
  // §5.2 makes `400 invalid_grant` non-retryable USER guidance. Answering it here would send every
  // employee to reopen the iframe, and reopening runs the same failing write — a permanent loop
  // with no 5xx and no alarm anywhere. The endpoint must be able to tell the two misses apart.
  const half = fixture([CREATE_TABLE])
  const whole = fixture([CREATE_TABLE, ADD_LAST_SEEN])
  const grant = new URLSearchParams({ grant_type: 'client_credentials', actor: TENANT }).toString()
  const ask = (store: Store) => {
    const bindings = {
      OAUTH_SIGNING_KEY: SIGNING_KEY,
      OAUTH_ISSUER: 'https://tripdesk.example',
      RELAY_CLIENT_ID: 'relay',
      RELAY_CLIENT_SECRET: 'secret',
    } as unknown as OAuthEnv
    return authorizationServer(() => store).fetch(
      new Request('https://tripdesk.example/oauth/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa('relay:secret')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: grant,
      }),
      bindings,
    )
  }

  const broken = await ask(half.store)
  assert.equal(broken.status, 503, 'a store that cannot be written is OURS to fix, and retryable')
  assert.equal(((await broken.json()) as { error: string }).error, 'server_error')

  // With the migration applied the probe stops blunting the real signal: a genuine miss is 400.
  const genuine = await ask(whole.store)
  assert.equal(genuine.status, 400)
  assert.equal(((await genuine.json()) as { error: string }).error, 'invalid_grant')
})

test('the probe writes, and writes somewhere no tenant can ever be', async () => {
  const { store, db } = fixture([CREATE_TABLE, ADD_LAST_SEEN])
  const probeRow = () => db.prepare(`SELECT * FROM tenant_credentials WHERE user_email = ?`).get(CREDENTIAL_PROBE_KEY)
  assert.equal(probeRow(), undefined)
  await assert.doesNotReject(store.probeCredentialStore())
  // A SELECT would pass against a read replica while writes are refused, so only a write proves
  // the write plane — and this is the assertion that says the probe really is one.
  assert.notEqual(probeRow(), undefined)
  await assert.doesNotReject(store.probeCredentialStore(), 'idempotent: it may run on every miss')

  // Its row is unreachable from any tenant lookup: every tenant key is `<org>:<uid>`
  // (formatActor), and the probe key has no colon — so it can never be read back as a credential.
  assert.equal(CREDENTIAL_PROBE_KEY.includes(':'), false)
  assert.equal(formatActor('', '').includes(':'), true)
  assert.equal(await store.getTenantCredential(CREDENTIAL_PROBE_KEY), '', 'and it holds no credential')
})

test('the real upsert: the incoming token always wins; the two timestamps answer two questions', async () => {
  const { store, db, row } = fixture([CREATE_TABLE, ADD_LAST_SEEN])
  assert.equal(await persistTenantCredential(store, TENANT, ALICE), 'created')
  assert.equal(row()?.token, ALICE)

  // `datetime('now')` has one-second resolution, so backdate the row to make the next write's
  // effect on each column unambiguous.
  const LONG_AGO = '2020-01-01 00:00:00'
  db.prepare(`UPDATE tenant_credentials SET updated_at = ?, last_seen_at = ?`).run(LONG_AGO, LONG_AGO)

  // Same value again: still a write. That is the whole point of last_seen_at — without it an
  // abandoned tenant row is indistinguishable from a live one (migrations/0008).
  assert.equal(await persistTenantCredential(store, TENANT, ALICE), 'unchanged')
  assert.equal(row()?.updated_at, LONG_AGO, 'updated_at answers "when did this employee re-login"')
  assert.notEqual(row()?.last_seen_at, LONG_AGO, 'last_seen_at answers "is this tenant alive"')

  // A different value — including one an intake policy would once have refused — overwrites, and
  // now both columns move. /internal serves whatever is here, so this is the whole contract.
  db.prepare(`UPDATE tenant_credentials SET updated_at = ?, last_seen_at = ?`).run(LONG_AGO, LONG_AGO)
  assert.equal(await persistTenantCredential(store, TENANT, 'junk'), 'rotated')
  assert.equal(row()?.token, 'junk')
  assert.notEqual(row()?.updated_at, LONG_AGO)
  assert.equal(await store.getTenantCredential(TENANT), 'junk')
})

test('route_mode: stamped at create and read back; pre-stamp rows read as the VM route', async () => {
  const { store, db } = fixture([INIT_TABLES, MULTITENANT, ROUTE_MODE])

  await store.createTask('t-mcp', 'proj', TENANT, 'mcp')
  assert.equal((await store.getTask('t-mcp'))?.route_mode, 'mcp')

  await store.createTask('t-vm', 'proj', TENANT, '')
  assert.equal((await store.getTask('t-vm'))?.route_mode, '')

  // A row created before the stamp existed (raw INSERT without the column) must read as
  // '' = VM route — the booking gate only fires for an explicit 'mcp' stamp.
  db.prepare(`INSERT INTO tasks (id, project_id, user_email) VALUES (?, ?, ?)`).run('t-legacy', 'proj', TENANT)
  assert.equal((await store.getTask('t-legacy'))?.route_mode, '')
})

test('employee_accounts: first writer wins — a second provision can never strand the recorded key', async () => {
  const { store } = fixture([EMPLOYEE_ACCOUNTS])

  await store.saveEmployeeAccount(TENANT, 'acct_winner', 'rbk_winner')
  const stored = await store.getEmployeeAccount(TENANT)
  assert.equal(stored?.accountId, 'acct_winner')
  assert.equal(stored?.apiKey, 'rbk_winner')
  assert.equal(stored?.registeredCredentialFp, null)

  // INSERT OR IGNORE, asserted against real SQLite: the relay hands an account key back
  // exactly once, so this row is its only copy. Overwriting would make `acct_winner`
  // unreachable forever — the loser's own account is the one that must be abandoned.
  await store.saveEmployeeAccount(TENANT, 'acct_loser', 'rbk_loser')
  assert.equal((await store.getEmployeeAccount(TENANT))?.accountId, 'acct_winner')

  await store.setRegisteredCredentialFingerprint(TENANT, 'fp-abc123')
  assert.equal((await store.getEmployeeAccount(TENANT))?.registeredCredentialFp, 'fp-abc123')

  assert.equal(await store.getEmployeeAccount('51049:nobody'), undefined)
})

test('oauth_clients: the REAL SQL round-trips a hash, misses cleanly, and refuses a duplicate id', async () => {
  const { store, db } = fixture([OAUTH_CLIENTS])

  await store.createOAuthClient('tkc_abc', 'hash-of-secret', 'rebyte relay')
  assert.equal(await store.getOAuthClientSecretHash('tkc_abc'), 'hash-of-secret')
  assert.equal(await store.getOAuthClientSecretHash('tkc_missing'), undefined)

  // client_id is the PRIMARY KEY: a re-register mints a NEW id (oauth.ts), never overwrites —
  // silently replacing a hash would let a second registration hijack an existing client id.
  await assert.rejects(() => store.createOAuthClient('tkc_abc', 'other-hash', ''), /UNIQUE|PRIMARY/i)
  assert.equal(await store.getOAuthClientSecretHash('tkc_abc'), 'hash-of-secret')

  // Only the hash is at rest — the plaintext secret never reaches this table.
  const row = db.prepare(`SELECT * FROM oauth_clients WHERE client_id = ?`).get('tkc_abc') as Record<string, unknown>
  assert.equal(row.client_secret_hash, 'hash-of-secret')
  assert.ok(row.created_at, 'created_at defaults in SQLite')
})
