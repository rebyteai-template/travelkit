/**
 * The composition root (worker/app.ts) — the part `server/oauth.test.ts` cannot see.
 *
 * Everything here was previously covered ONLY by `pnpm smoke:oauth`, which needs a live
 * `wrangler dev` plus a migrated local D1 and is not part of `pnpm test`:
 *   · mount order — the AS answers /oauth/token, the SPA catch-all does not swallow it
 *   · the tenant key the embed middleware writes IS the `actor` the relay sends back
 *   · which requests may refresh a tenant's credential, and which may not
 *
 * Run: node --import tsx --test worker/app.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportJWK, generateKeyPair } from 'jose'
import { createApp } from './app.ts'
import { formatActor } from '../server/oauth.ts'
import type { Store } from '../server/store.ts'
import type { Env } from './env.ts'

const CLIENT_ID = 'rebyte-relay'
const CLIENT_SECRET = 'f0f0'.repeat(16)
const SERVICE_TOKEN = 'ba'.repeat(32)
const UID = 'EMP10086'
const ORG = 'ORG42'
const TENANT = formatActor(ORG, UID)

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const jwt = (id: number, createdAt: number): string =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ id, createdAt })}.c2ln`

const ALICE = jwt(10086, 1_750_000_000)
const ALICE_NEWER = jwt(10086, 1_760_000_000)
const MALLORY = jwt(66666, 1_770_000_000)

const SPA_BODY = '<!doctype html><title>TripDesk</title>'

const { privateKey } = await generateKeyPair('ES256', { extractable: true })
const SIGNING_KEY = JSON.stringify({ ...(await exportJWK(privateKey)), alg: 'ES256', use: 'sig', kid: 'app-test' })

function harness(env: Partial<Env> = {}) {
  const credentials = new Map<string, string>()
  const store = {
    async getTenantCredential(userEmail: string) {
      return credentials.get(userEmail)
    },
    async saveTenantCredential(userEmail: string, token: string) {
      credentials.set(userEmail, token)
    },
    async probeCredentialStore() {},
    async setConfig() {},
    async getConfig() {
      return { skillRef: '', systemPrompt: '', routeMode: '' }
    },
  } as unknown as Store
  const app = createApp(() => store)
  const bindings = {
    ASSETS: { fetch: async () => new Response(SPA_BODY, { headers: { 'Content-Type': 'text/html' } }) },
    OAUTH_SIGNING_KEY: SIGNING_KEY,
    OAUTH_ISSUER: 'https://tripdesk.example',
    RELAY_CLIENT_ID: CLIENT_ID,
    RELAY_CLIENT_SECRET: CLIENT_SECRET,
    TRIPDESK_SERVICE_TOKEN: SERVICE_TOKEN,
    ...env,
  } as unknown as Env

  const handoff = (token: string, extra: Record<string, string> = {}) => ({
    'X-Tenant-Uid': UID,
    'X-Tenant-Org': ORG,
    'X-Travelkit-Token': token,
    ...extra,
  })
  return {
    credentials,
    /** A request that CHANGES something, and needs no relay/VM: the debug-config write. */
    work: (token: string, extra: Record<string, string> = {}) =>
      app.fetch(
        new Request('https://tripdesk.example/api/app/debug/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...handoff(token, extra) },
          body: '{}',
        }),
        bindings,
      ),
    read: (token: string, path = '/api/app/me') =>
      app.fetch(new Request(`https://tripdesk.example${path}`, { headers: handoff(token) }), bindings),
    /** The SSE shape: EventSource cannot set headers, so identity rides in the query string. */
    stream: (token: string) =>
      app.fetch(
        new Request(`https://tripdesk.example/api/app/me?uid=${UID}&org=${ORG}&token=${encodeURIComponent(token)}`),
        bindings,
      ),
    /** Mutating, but with the handoff in the query string — the shape a leaked URL has. */
    workViaQuery: (token: string) =>
      app.fetch(
        new Request(
          `https://tripdesk.example/api/app/debug/config?uid=${UID}&org=${ORG}&token=${encodeURIComponent(token)}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        ),
        bindings,
      ),
    get: (path: string) => app.fetch(new Request(`https://tripdesk.example${path}`), bindings),
    token: (actor: string) =>
      app.fetch(
        new Request('https://tripdesk.example/oauth/token', {
          method: 'POST',
          headers: {
            Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ grant_type: 'client_credentials', actor }).toString(),
        }),
        bindings,
      ),
    credential: () =>
      app.fetch(
        new Request('https://tripdesk.example/internal/simplifly-credential', {
          method: 'POST',
          headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ org: ORG, uid: UID }),
        }),
        bindings,
      ),
  }
}

test('MOUNT ORDER: the AS owns its paths; the SPA catch-all owns everything else', async () => {
  const as = harness()
  // The catch-all is registered last, so a mis-ordered mount would answer these with 200 + HTML.
  const meta = await as.get('/.well-known/oauth-authorization-server')
  assert.equal(meta.status, 200)
  assert.equal(meta.headers.get('content-type'), 'application/json')
  const probe = await as.get('/oauth/token')
  assert.equal(probe.status, 405, 'a GET probe used to get 200 + the SPA, which reads as healthy')
  assert.equal(probe.headers.get('allow'), 'POST')
  // And the reverse: mounting the AS at '/' must not swallow the SPA.
  const spa = await as.get('/')
  assert.equal(spa.status, 200)
  assert.equal(await spa.text(), SPA_BODY)
  assert.equal(spa.headers.get('content-security-policy'), 'frame-ancestors *', 'the iframe host still gets to embed us')
})

test('THE IDENTITY CHAIN: the key the middleware writes is the `actor` the relay hands back', async () => {
  const as = harness()
  assert.equal((await as.work(ALICE)).status, 200)
  assert.equal(as.credentials.get(TENANT), ALICE, 'stored under <org>:<uid>')

  // Same app, machine half: the relay presents the actor task-do.ts sent, and the MCP then asks
  // for the credential behind it. If the two key formats ever drifted, this is where it shows.
  const granted = await as.token(TENANT)
  assert.equal(granted.status, 200)
  const served = await as.credential()
  assert.equal(served.status, 200)
  assert.deepEqual(await served.json(), { authToken: ALICE })
})

test('EVERY request overwrites the row — no method, no header, no value decides otherwise', async () => {
  // PLAN §4.3: the token rides on every request because it IS the caller's credential, so a
  // re-login refreshes it for free. Nothing judges the value; /internal always serves the last
  // one received. The alternative — a policy that can refuse a write — strands the employee
  // permanently, because this is the only writer there is (see tenant-credential.test.ts).
  const as = harness()
  await as.work(ALICE)
  assert.equal(as.credentials.get(TENANT), ALICE)
  await as.work(ALICE_NEWER)
  assert.equal(as.credentials.get(TENANT), ALICE_NEWER, 're-login rotates the row')
  // Another account's token, outright junk, and a token older than the one we hold: all land.
  for (const token of [MALLORY, 'junk', ALICE]) {
    await as.work(token)
    assert.equal(as.credentials.get(TENANT), token)
  }
  // Reads too, and the SSE shape where identity rides in the query string.
  assert.equal((await as.read(MALLORY)).status, 200)
  assert.equal(as.credentials.get(TENANT), MALLORY)
  assert.equal((await as.stream(ALICE)).status, 200)
  assert.equal(as.credentials.get(TENANT), ALICE)
  assert.equal((await as.workViaQuery(ALICE_NEWER)).status, 200)
  assert.equal(as.credentials.get(TENANT), ALICE_NEWER)
})

test('the one structural bound: a control character cannot reach the sandbox env file', async () => {
  const as = harness()
  // A header value cannot carry a newline (the runtime rejects it), but the QUERY-string handoff
  // can — and the token does not stop at this row: it is written into the sandbox's
  // .simplifly.env as `SIMPLIFLY_AUTH_TOKEN=<token>\n` (worker/seed.ts), where a newline injects
  // further env lines. So the whole request is refused, before any turn or seed can use it.
  const injected = await as.stream('TK_good\nSIMPLIFLY_BASE_URL=https://evil.example')
  assert.equal(injected.status, 401)
  assert.equal(as.credentials.size, 0)
  // And that is ALL it stops. It is a bound on the request, not a judgement about the credential:
  // an odd-looking token is still a token, and refusing one would be exactly the dead end above.
  for (const odd of ['x'.repeat(5000), 'has space', '{"weird":true}']) {
    assert.equal((await as.work(odd)).status, 200, odd.slice(0, 20))
    assert.equal(as.credentials.get(TENANT), odd)
  }
})

test('BYTE-IDENTICAL: the embed gate rejects exactly what it rejected before, plus nothing', async () => {
  // The delegated-credential work must not add a reject path to today's (non-delegated) traffic.
  // `beforeThisWork` is the gate as it stood in worker/index.ts before any of it: an embed key
  // when configured, then uid AND org AND token. The app must agree with it on every shape below.
  const beforeThisWork = (uid: string, org: string, token: string, embedKey?: { expected: string; sent: string }) =>
    (embedKey && embedKey.sent !== embedKey.expected) || !uid || !org || !token ? 401 : 200

  for (const token of [
    ALICE, // a real handoff JWT
    'TK_opaque_dev_token', // the local-dev / smoke shape
    'x'.repeat(5000), // absurd, but it authenticated yesterday
    'has space',
    'ünïcödé',
    '', // the pre-existing 401
  ]) {
    const as = harness()
    assert.equal((await as.work(token)).status, beforeThisWork(UID, ORG, token), `header ${token.slice(0, 24)}`)
    assert.equal((await as.stream(token)).status, beforeThisWork(UID, ORG, token), `query ${token.slice(0, 24)}`)
  }
  // …and the embed-key gate is untouched, including its precedence over the tenant checks.
  const keyed = harness({ EMBED_KEY: 'the-key' })
  assert.equal((await keyed.work(ALICE)).status, beforeThisWork(UID, ORG, ALICE, { expected: 'the-key', sent: '' }))
  assert.equal(
    (await keyed.work('', { 'X-Embed-Key': 'the-key' })).status,
    beforeThisWork(UID, ORG, '', { expected: 'the-key', sent: 'the-key' }),
  )
  // The ONLY divergence, stated as a test rather than left implicit: a control character, which
  // could not have been a working credential and which injects lines into the sandbox env file.
  const control = harness()
  assert.equal(beforeThisWork(UID, ORG, 'TK\nX=1'), 200, 'it used to be accepted')
  assert.equal((await control.stream('TK\nX=1')).status, 401, 'and is now the one new rejection')
})

test('the handoff gates still hold: all four parameters, or nothing', async () => {
  const as = harness({ EMBED_KEY: 'the-key' })
  assert.equal((await as.work(ALICE)).status, 401, 'no embed key → 401 before any tenant work')
  assert.equal((await as.work(ALICE, { 'X-Embed-Key': 'wrong' })).status, 401)
  assert.equal((await as.work(ALICE, { 'X-Embed-Key': 'the-key' })).status, 200)
  assert.equal(as.credentials.get(TENANT), ALICE)

  const open = harness()
  assert.equal((await open.work('')).status, 401, 'no token → 401')
  assert.equal(open.credentials.size, 0)
})

test('a credential-store outage does not fail the employee\'s request', async () => {
  // The app has to keep working; it is the TOKEN endpoint's job to answer 5xx (retryable) rather
  // than "reopen FlyAI" while the store is down — see server/oauth.test.ts.
  const app = createApp(
    () =>
      ({
        async getTenantCredential() {
          throw new Error('D1_ERROR: no such table: tenant_credentials')
        },
        async saveTenantCredential() {},
        async probeCredentialStore() {},
        async setConfig() {},
      }) as unknown as Store,
  )
  const res = await app.fetch(
    new Request('https://tripdesk.example/api/app/debug/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Uid': UID,
        'X-Tenant-Org': ORG,
        'X-Travelkit-Token': ALICE,
      },
      body: '{}',
    }),
    { ASSETS: { fetch: async () => new Response(SPA_BODY) } } as unknown as Env,
  )
  assert.equal(res.status, 200)
})
