/**
 * Per-employee account provisioning + connector registration (employee-account.ts).
 *
 * The relay is stubbed at `fetch`, because what matters here is exactly what we send it and
 * how many times: a second POST /accounts strands a live key, and a missing re-registration
 * leaves the connector holding a dead credential.
 *
 * Run: node --import tsx --test server/rebyte/employee-account.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ensureEmployeeMcpAccess } from './employee-account.ts'
import { credentialFingerprint } from '../tenant-credential.ts'
import type { EmployeeAccount, Store } from '../store.ts'

const TENANT = '51049:2041'
const MCP_URL = 'https://simplifly-mcp.impo.ai/mcp'
const CONFIG = { apiUrl: 'https://relay.test/v1', apiKey: 'rbk_partner' }
const TOKEN = 'TK_the_employees_simplifly_token'

/** The three employee-account methods; the rest of Store is unreachable from this module. */
function accountStore(seed?: EmployeeAccount): Store {
  let row = seed ? { ...seed } : undefined
  return {
    async getEmployeeAccount() {
      return row
    },
    async saveEmployeeAccount(_email: string, accountId: string, apiKey: string) {
      // INSERT OR IGNORE: first writer wins.
      if (!row) row = { accountId, apiKey, registeredCredentialFp: null }
    },
    async setRegisteredCredentialFingerprint(_email: string, fingerprint: string) {
      if (row) row.registeredCredentialFp = fingerprint
    },
  } as unknown as Store
}

interface Call {
  url: string
  body: Record<string, unknown>
  apiKey: string | null
}

/** Stub the relay. `accountId` lets a test see which account a second create would mint. */
function stubRelay(options: { accountId?: string } = {}): { calls: Call[]; restore: () => void } {
  const calls: Call[] = []
  const original = globalThis.fetch
  let minted = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      apiKey: headers.get('API_KEY'),
    })
    if (url.endsWith('/accounts')) {
      minted += 1
      const id = options.accountId ?? `acct_${minted}`
      return new Response(JSON.stringify({ id, api_key: `rbk_${id}` }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ id: 'srv-1', toolCount: 13 }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, restore: () => void (globalThis.fetch = original) }
}

test('THE CONTRACT: first turn provisions the account and registers the connector as that employee', async () => {
  const store = accountStore()
  const relay = stubRelay()
  try {
    const access = await ensureEmployeeMcpAccess(store, CONFIG, {
      tenant: TENANT,
      credential: TOKEN,
      mcpUrl: MCP_URL,
    })

    // The account is created with the PARTNER key…
    const create = relay.calls.find((c) => c.url.endsWith('/accounts'))
    assert.ok(create)
    assert.equal(create.apiKey, 'rbk_partner')

    // …and the connector is registered with the ACCOUNT's own key, not the partner's.
    // Registering as the partner would attach the connector to the wrong account and
    // every task would still see no tools.
    const register = relay.calls.find((c) => c.url.endsWith('/mcp/servers'))
    assert.ok(register)
    assert.equal(register.apiKey, access.apiKey)
    assert.notEqual(register.apiKey, 'rbk_partner')

    // The employee's own credential rides as the connector secret, and the tenant goes in
    // as a REGISTERED header — the resource server reads identity from there, and a value
    // stored server-side is one no prompt can influence.
    assert.equal(register.body.url, MCP_URL)
    assert.equal(register.body.sharedSecret, TOKEN)
    assert.deepEqual(register.body.customHeaders, [
      { key: 'X-Tripdesk-Tenant', value: TENANT },
    ])
  } finally {
    relay.restore()
  }
})

test('an unchanged credential re-registers NOTHING — each registration probes the server', async () => {
  const fp = await credentialFingerprint(TOKEN)
  const store = accountStore({ accountId: 'acct_1', apiKey: 'rbk_acct_1', registeredCredentialFp: fp })
  const relay = stubRelay()
  try {
    const access = await ensureEmployeeMcpAccess(store, CONFIG, {
      tenant: TENANT,
      credential: TOKEN,
      mcpUrl: MCP_URL,
    })
    assert.equal(access.apiKey, 'rbk_acct_1')
    assert.deepEqual(relay.calls, [])
  } finally {
    relay.restore()
  }
})

test('a ROTATED credential re-registers exactly once, and stamps the new fingerprint', async () => {
  // The registration is a push: a rotation we fail to push leaves the connector holding a
  // dead token, and the employee sits at 401020 with no way to recover.
  const store = accountStore({
    accountId: 'acct_1',
    apiKey: 'rbk_acct_1',
    registeredCredentialFp: await credentialFingerprint('TK_old'),
  })
  const relay = stubRelay()
  try {
    await ensureEmployeeMcpAccess(store, CONFIG, { tenant: TENANT, credential: TOKEN, mcpUrl: MCP_URL })
    const registrations = relay.calls.filter((c) => c.url.endsWith('/mcp/servers'))
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0]?.body.sharedSecret, TOKEN)
    assert.equal(relay.calls.some((c) => c.url.endsWith('/accounts')), false, 'the account already exists')

    // …and the second turn is quiet again.
    await ensureEmployeeMcpAccess(store, CONFIG, { tenant: TENANT, credential: TOKEN, mcpUrl: MCP_URL })
    assert.equal(relay.calls.filter((c) => c.url.endsWith('/mcp/servers')).length, 1)
  } finally {
    relay.restore()
  }
})

test('a concurrent provision uses the RECORDED account, not the orphan it just minted', async () => {
  // The relay hands back an account key exactly once, so the row is its only copy. The
  // loser of a race must abandon its own account rather than overwrite the recorded one —
  // and must go on to use the recorded key, or its task lands on an account whose key
  // nothing persisted.
  const store = accountStore({ accountId: 'acct_winner', apiKey: 'rbk_winner', registeredCredentialFp: null })
  const original = store.getEmployeeAccount.bind(store)
  let firstRead = true
  store.getEmployeeAccount = async (email: string) => {
    if (firstRead) {
      firstRead = false
      return undefined // as if nobody had provisioned yet
    }
    return original(email)
  }
  const relay = stubRelay({ accountId: 'acct_loser' })
  try {
    const access = await ensureEmployeeMcpAccess(store, CONFIG, {
      tenant: TENANT,
      credential: TOKEN,
      mcpUrl: MCP_URL,
    })
    assert.equal(access.accountId, 'acct_winner')
    assert.equal(access.apiKey, 'rbk_winner')
    const register = relay.calls.find((c) => c.url.endsWith('/mcp/servers'))
    assert.equal(register?.apiKey, 'rbk_winner')
  } finally {
    relay.restore()
  }
})

test('a store that cannot record the account fails loudly instead of using a stranded key', async () => {
  // Continuing would submit the task under an account whose key exists only in this
  // function's local variable — unreachable forever after this turn.
  const store = accountStore()
  store.saveEmployeeAccount = async () => {}
  const relay = stubRelay()
  try {
    await assert.rejects(
      () => ensureEmployeeMcpAccess(store, CONFIG, { tenant: TENANT, credential: TOKEN, mcpUrl: MCP_URL }),
      /could not be recorded/,
    )
    assert.equal(relay.calls.some((c) => c.url.endsWith('/mcp/servers')), false, 'nothing registered')
  } finally {
    relay.restore()
  }
})

test('the account is recorded BEFORE the connector is registered', async () => {
  // Reverse that order and a failed save leaves a registered-but-unrecorded account. This
  // asserts the ordering directly: registration must observe an already-stored row.
  const store = accountStore()
  let recordedBeforeRegister: boolean | undefined
  const relay = { calls: [] as Call[], restore: () => void (globalThis.fetch = originalFetch) }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/mcp/servers')) {
      recordedBeforeRegister = (await store.getEmployeeAccount(TENANT)) !== undefined
      return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ id: 'acct_1', api_key: 'rbk_acct_1' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    await ensureEmployeeMcpAccess(store, CONFIG, { tenant: TENANT, credential: TOKEN, mcpUrl: MCP_URL })
    assert.equal(recordedBeforeRegister, true)
  } finally {
    relay.restore()
  }
})

test('a failed registration leaves the fingerprint unstamped, so the next turn retries', async () => {
  const store = accountStore({ accountId: 'acct_1', apiKey: 'rbk_acct_1', registeredCredentialFp: null })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'server_unreachable' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  try {
    await assert.rejects(() =>
      ensureEmployeeMcpAccess(store, CONFIG, { tenant: TENANT, credential: TOKEN, mcpUrl: MCP_URL }),
    )
    const row = await store.getEmployeeAccount(TENANT)
    assert.equal(row?.registeredCredentialFp, null, 'a stamp here would skip the retry forever')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the credential itself never appears in a log line — only its fingerprint', async () => {
  const store = accountStore()
  const relay = stubRelay()
  const lines: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  try {
    await ensureEmployeeMcpAccess(store, CONFIG, { tenant: TENANT, credential: TOKEN, mcpUrl: MCP_URL })
  } finally {
    console.log = originalLog
    relay.restore()
  }
  const fingerprint = await credentialFingerprint(TOKEN)
  assert.equal(lines.join(' ').includes(TOKEN), false)
  assert.ok(lines.some((l) => l.includes(fingerprint)))
})
