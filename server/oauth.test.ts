/**
 * The Authorization Server's self-certification (server/oauth.ts). travelkit can prove its half
 * of the delegated-credential contract without the relay or the MCP existing: the token it mints
 * is verified HERE with the exact options mcp/src/mcp/auth.ts uses, against the JWKS this server
 * actually publishes. If these pass, the resource server accepts our tokens.
 *
 * Run: node --import tsx --test server/oauth.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLocalJWKSet, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify } from 'jose'
import { authorizationServer, formatActor, parseActor, type OAuthEnv } from './oauth.ts'
import type { Store } from './store.ts'

const ISSUER = 'https://tripdesk.example'
const RESOURCE = 'https://simplifly-mcp.impo.ai/mcp'
const CLIENT_ID = 'rebyte-relay'
const CLIENT_SECRET = 'c0ffee'.repeat(8)
const SERVICE_TOKEN = 'service-' + 'ab'.repeat(16)
const ACTOR = formatActor('ORG42', 'EMP10086')
const TOKEN = 'TK_the_employees_simplifly_token'

const { privateKey } = await generateKeyPair('ES256', { extractable: true })
const SIGNING_KEY = JSON.stringify({ ...(await exportJWK(privateKey)), alg: 'ES256', use: 'sig', kid: 'test-key' })

/** Only the three credential methods matter to the AS; the rest of the Store contract is
 *  unreachable from these routes. `broken` simulates a storage plane that is up for reads and
 *  down for writes (an unapplied migration, a quota event) — the case the endpoint has to tell
 *  apart from "we have never seen this tenant". */
type StoreFault = 'read' | 'write' | 'probe'
function credentialStore(seed: Record<string, string> = {}, broken: StoreFault[] = []): Store {
  const rows = new Map(Object.entries(seed))
  const boom = (which: StoreFault) => {
    if (broken.includes(which)) throw new Error('D1_ERROR: no such table: tenant_credentials')
  }
  return {
    async saveTenantCredential(userEmail: string, token: string) {
      boom('write')
      rows.set(userEmail, token)
    },
    async getTenantCredential(userEmail: string) {
      boom('read')
      return rows.get(userEmail)
    },
    async probeCredentialStore() {
      boom('probe')
    },
  } as unknown as Store
}

/** Capture the module's log lines for the tests that assert on observability. */
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

function server(
  env: Partial<OAuthEnv> = {},
  seed: Record<string, string> = { [ACTOR]: TOKEN },
  broken: StoreFault[] = [],
) {
  const store = credentialStore(seed, broken)
  const app = authorizationServer(() => store)
  const bindings = {
    OAUTH_SIGNING_KEY: SIGNING_KEY,
    OAUTH_ISSUER: ISSUER,
    RELAY_CLIENT_ID: CLIENT_ID,
    RELAY_CLIENT_SECRET: CLIENT_SECRET,
    TRIPDESK_SERVICE_TOKEN: SERVICE_TOKEN,
    ...env,
  } as unknown as OAuthEnv
  return {
    token: (body: string, auth = `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`) =>
      app.fetch(
        new Request(`${ISSUER}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(auth ? { Authorization: auth } : {}) },
          body,
        }),
        bindings,
      ),
    grant: (actor = ACTOR, resource: string | null = RESOURCE) =>
      new URLSearchParams({ grant_type: 'client_credentials', actor, ...(resource ? { resource } : {}) }).toString(),
    credential: (body: unknown, auth = `Bearer ${SERVICE_TOKEN}`) =>
      app.fetch(
        new Request(`${ISSUER}/internal/simplifly-credential`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
          body: JSON.stringify(body),
        }),
        bindings,
      ),
    get: (path: string) => app.fetch(new Request(`${ISSUER}${path}`), bindings),
    method: (path: string, method: string) => app.fetch(new Request(`${ISSUER}${path}`, { method }), bindings),
  }
}

/** Every non-2xx the token endpoint can produce, and the band PLAN §5.2 puts it in. `400` is
 *  RESERVED for invalid_grant: it is the only answer the relay turns into "reopen FlyAI", and the
 *  only non-retryable one. Anything else there strands every employee on a permanent dead end. */
function assertBand(status: number, error: string): void {
  if (status === 400) {
    assert.equal(error, 'invalid_grant', `400 is reserved for invalid_grant, got ${error}`)
    return
  }
  assert.ok(status === 401 || status === 429 || status >= 500, `${error} must not sit in a client-error band (${status})`)
}

/** Verify exactly the way mcp/src/mcp/auth.ts does, against the published JWKS. */
async function verifyLikeResourceServer(as: ReturnType<typeof server>, accessToken: string) {
  const jwks = (await (await as.get('/.well-known/jwks.json')).json()) as { keys: unknown[] }
  return jwtVerify(accessToken, await createLocalJWKSet(jwks as never), {
    issuer: ISSUER,
    audience: RESOURCE,
    algorithms: ['ES256', 'ES384', 'RS256', 'RS384', 'PS256'],
    clockTolerance: 30,
    requiredClaims: ['exp'],
  })
}

test('THE CONTRACT: a minted token passes the resource server verifier, claim for claim', async () => {
  const as = server()
  const res = await as.token(as.grant())
  assert.equal(res.status, 200)
  const body = (await res.json()) as { access_token: string; token_type: string; expires_in: number }
  assert.equal(body.token_type, 'Bearer')
  assert.ok(body.expires_in > 0)
  // Credentials must never sit in a shared cache.
  assert.equal(res.headers.get('cache-control'), 'no-store')

  const { payload } = await verifyLikeResourceServer(as, body.access_token)
  assert.equal(payload.aud, RESOURCE, 'aud must be the canonical resource URI, character for character')
  assert.equal(payload.iss, ISSUER)
  assert.equal(payload.org, 'ORG42')
  assert.equal(payload.uid, 'EMP10086')
  assert.equal(payload.sub, ACTOR, 'sub carries the opaque actor verbatim, for audit')
  assert.ok(typeof payload.exp === 'number', 'exp is a requiredClaim — without it the token never expires')

  // Asymmetric + a kid the resource server can look up. HS* would be accepted by nobody.
  const header = decodeProtectedHeader(body.access_token)
  assert.equal(header.alg, 'ES256')
  assert.equal(header.kid, 'test-key')
})

test('the actor TravelKit puts on /v1/tasks resolves back to that tenant', () => {
  // worker/index.ts builds the tenant key with formatActor and task-do.ts sends it as `actor`;
  // the relay only echoes bytes, so this round-trip is the whole identity chain.
  assert.deepEqual(parseActor(formatActor('ORG42', 'EMP10086')), { org: 'ORG42', uid: 'EMP10086' })
  // uid may contain colons (split at the FIRST one)
  assert.deepEqual(parseActor(formatActor('ORG42', 'a:b')), { org: 'ORG42', uid: 'a:b' })
  // and an org WITH a colon still rebuilds the same storage key, so the credential resolves
  const odd = formatActor('ORG:42', 'EMP1')
  const split = parseActor(odd)
  assert.ok(split)
  assert.equal(formatActor(split.org, split.uid), odd)
  // not a tenant at all
  assert.equal(parseActor('no-colon'), null)
  assert.equal(parseActor(':uid'), null)
  assert.equal(parseActor('org:'), null)
})

test('unknown actor → 400 invalid_grant (NOT retryable: the relay must say "reopen the iframe")', async () => {
  const as = server()
  const res = await as.token(as.grant(formatActor('ORG42', 'someone-else')))
  assert.equal(res.status, 400)
  assert.equal(((await res.json()) as { error: string }).error, 'invalid_grant')
})

test('a malformed actor is indistinguishable from an unknown one', async () => {
  const as = server()
  const res = await as.token(as.grant('not-a-tenant'))
  assert.equal(res.status, 400)
  assert.equal(((await res.json()) as { error: string }).error, 'invalid_grant')
})

test('bad client credentials → 401 invalid_client (an OPS error, never disguised as a user problem)', async () => {
  const as = server()
  for (const [name, auth] of [
    ['wrong secret', `Basic ${btoa(`${CLIENT_ID}:nope`)}`],
    ['wrong id', `Basic ${btoa(`someone-else:${CLIENT_SECRET}`)}`],
    ['no colon in the credentials', `Basic ${btoa('rebyte-relay')}`],
    ['bearer instead of basic', `Bearer ${CLIENT_SECRET}`],
    ['no authorization at all', ''],
  ] as const) {
    const res = await as.token(as.grant(), auth)
    assert.equal(res.status, 401, name)
    assert.equal(((await res.json()) as { error: string }).error, 'invalid_client', name)
    assert.match(res.headers.get('www-authenticate') ?? '', /^Basic /, name)
  }
})

test('client authentication runs BEFORE the actor lookup — a stranger learns nothing about employees', async () => {
  const as = server()
  const known = await as.token(as.grant(ACTOR), `Basic ${btoa(`${CLIENT_ID}:nope`)}`)
  const unknown = await as.token(as.grant(formatActor('ORG42', 'ghost')), `Basic ${btoa(`${CLIENT_ID}:nope`)}`)
  assert.equal(known.status, 401)
  assert.equal(unknown.status, 401)
  assert.deepEqual(await known.json(), await unknown.json())
})

test('only client_credentials; no authorization-code or refresh grant sneaks in', async () => {
  const as = server()
  for (const grant of ['refresh_token', 'authorization_code', 'urn:ietf:params:oauth:grant-type:token-exchange', '']) {
    const res = await as.token(new URLSearchParams({ grant_type: grant, actor: ACTOR }).toString())
    const error = ((await res.json()) as { error: string }).error
    assert.equal(error, 'unsupported_grant_type', grant)
    // OUR integration is wrong, not the employee's session: it must never land on 400.
    assert.equal(res.status, 500, grant)
    assertBand(res.status, error)
  }
})

test('resource: omitted → our MCP; someone else\'s → invalid_target, in the OPS band', async () => {
  const as = server()
  const defaulted = await as.token(as.grant(ACTOR, null))
  assert.equal(defaulted.status, 200)
  const { payload } = await verifyLikeResourceServer(as, ((await defaulted.json()) as { access_token: string }).access_token)
  assert.equal(payload.aud, RESOURCE, 'a client that omits `resource` still gets the canonical audience')

  const foreign = await as.token(as.grant(ACTOR, 'https://someone-else.example.com/mcp'))
  const error = ((await foreign.json()) as { error: string }).error
  assert.equal(error, 'invalid_target')
  // THE POINT: a resource mismatch is OUR configuration bug. As a 400 it would tell every
  // employee to reopen FlyAI, forever, and reopening would never help.
  assert.equal(foreign.status, 500)
  assertBand(foreign.status, error)
})

test('a trailing slash (or a bare origin) in the requested resource does not strand every employee', async () => {
  const as = server()
  for (const requested of [`${RESOURCE}/`, 'https://simplifly-mcp.impo.ai']) {
    const res = await as.token(as.grant(ACTOR, requested))
    assert.equal(res.status, 200, requested)
    const { payload } = await verifyLikeResourceServer(as, ((await res.json()) as { access_token: string }).access_token)
    // Tolerated on the way in, CANONICAL on the way out — the resource server compares `aud`
    // literally, so minting the string that was asked for would 401 just as permanently.
    assert.equal(payload.aud, RESOURCE, requested)
  }
})

test('the tolerance never guesses: an ambiguous origin still refuses to mint', async () => {
  const as = server({ OAUTH_RESOURCES: `${RESOURCE},https://simplifly-mcp.impo.ai/other` })
  const res = await as.token(as.grant(ACTOR, 'https://simplifly-mcp.impo.ai'))
  assert.equal(((await res.json()) as { error: string }).error, 'invalid_target')
  assert.equal(res.status, 500, 'still the ops band — but it must not pick an audience by coin flip')
})

test('missing actor → invalid_request, in the OPS band (a client bug, not a missing employee)', async () => {
  const as = server()
  const res = await as.token(new URLSearchParams({ grant_type: 'client_credentials' }).toString())
  const error = ((await res.json()) as { error: string }).error
  assert.equal(error, 'invalid_request')
  assert.equal(res.status, 500)
  assertBand(res.status, error)
})

test('THE DEAD END: a broken credential store is a retryable 5xx, never "reopen FlyAI"', async () => {
  // §5.2 makes 400 invalid_grant non-retryable user guidance, so answering it when the STORE is
  // broken is a permanent loop: the employee reopens the iframe, the same write fails again, and
  // nothing 5xxes or alarms. The endpoint must be able to tell the two misses apart.
  const readBroken = server({}, {}, ['read'])
  const onRead = await readBroken.token(readBroken.grant())
  assert.equal(onRead.status, 503, 'a failed lookup is ours, not the employee\'s')
  assertBand(onRead.status, ((await onRead.json()) as { error: string }).error)

  // The nastier one: reads work, writes do not (unapplied migration on a fresh column, quota).
  // The row is missing BECAUSE the write plane is down, and that must not read as "no credential".
  const writeBroken = server({}, {}, ['write', 'probe'])
  const onWrite = await writeBroken.token(writeBroken.grant())
  assert.equal(onWrite.status, 503)
  assert.equal(((await onWrite.json()) as { error: string }).error, 'server_error')

  // And with a healthy store, a genuine miss is still the legitimate 400 — the whole point of
  // the probe is that it does not blunt the real signal.
  const healthy = server({}, {})
  const genuine = await healthy.token(healthy.grant())
  assert.equal(genuine.status, 400)
  assert.equal(((await genuine.json()) as { error: string }).error, 'invalid_grant')
})

test('/internal: a broken store is 503 (retryable), not 404 (which becomes user guidance)', async () => {
  const as = server({}, { [ACTOR]: TOKEN }, ['read'])
  const res = await as.credential({ org: 'ORG42', uid: 'EMP10086' })
  assert.equal(res.status, 503, '404 means "this employee has no credential" to tripdesk-client.ts')
})

test('RFC 6749 §2.3.1: form-encoded Basic halves authenticate, and so do raw ones', async () => {
  // A conformant OAuth client x-www-form-urlencodes both halves before base64. Comparing them raw
  // makes any secret containing `+` or `%` fail forever, while the relay classifies invalid_client
  // as a RETRYABLE ops error — an infinite retry against a byte-correct credential.
  const PLUS = 'se+cret/with%chars'
  const as = server({ RELAY_CLIENT_SECRET: PLUS })
  const encoded = `Basic ${btoa(`${CLIENT_ID}:${encodeURIComponent(PLUS)}`)}`
  assert.equal((await as.token(as.grant(), encoded)).status, 200, 'the spec-conformant encoding')
  const raw = `Basic ${btoa(`${CLIENT_ID}:${PLUS}`)}`
  assert.equal((await as.token(as.grant(), raw)).status, 200, 'and a client that sends it verbatim')
  // Still no free pass: a wrong secret is wrong in either encoding.
  assert.equal((await as.token(as.grant(), `Basic ${btoa(`${CLIENT_ID}:${encodeURIComponent('nope')}`)}`)).status, 401)
  // The hex secret the README/PLAN mandate is unaffected by encoding — that is why it is hex.
  const hex = server()
  assert.equal((await hex.token(hex.grant(), `Basic ${btoa(`${CLIENT_ID}:${encodeURIComponent(CLIENT_SECRET)}`)}`)).status, 200)
})

test('failed client authentications are bounded and logged, not silent and unlimited', async () => {
  const as = server()
  const wrong = `Basic ${btoa(`${CLIENT_ID}:nope`)}`
  const { lines } = await captureLogs(async () => {
    for (let i = 0; i < 10; i += 1) assert.equal((await as.token(as.grant(), wrong)).status, 401)
  })
  assert.equal(lines.filter((l) => l.includes('client authentication FAILED')).length, 10, 'every attempt is logged')
  assert.equal(lines.some((l) => l.includes(CLIENT_SECRET)), false, 'and no secret material is in the log')

  const locked = await as.token(as.grant(), wrong)
  assert.equal(locked.status, 429)
  assert.ok(Number(locked.headers.get('retry-after')) > 0)
  // A locked-out caller gets no oracle: even the CORRECT credential is refused for the window,
  // so guessing cannot be confirmed by the response.
  assert.equal((await as.token(as.grant())).status, 429)
})

test('the credential endpoint locks out a guesser and logs every attempt', async () => {
  const as = server()
  const { lines } = await captureLogs(async () => {
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await as.credential({ org: 'ORG42', uid: 'EMP10086' }, 'Bearer nope')).status, 401)
    }
  })
  assert.equal(lines.filter((l) => l.includes('service authentication FAILED')).length, 10)
  const locked = await as.credential({ org: 'ORG42', uid: 'EMP10086' }, 'Bearer nope')
  assert.equal(locked.status, 429, 'this endpoint returns a full-privilege, non-revocable credential')
  assert.ok(Number(locked.headers.get('retry-after')) > 0)
  // 429 is retryable to tripdesk-client.ts (it is not 401/403/404/410), so a legitimate caller
  // caught by the window backs off instead of telling the employee to reopen FlyAI.
})

test('attribution is provable from the logs, and the logs carry nothing reversible', async () => {
  // PLAN §6's gate: "能确认用的是该员工的 token，不是静默回落 org 级". The same credential
  // fingerprint on both hops is what proves it.
  const as = server()
  const { lines } = await captureLogs(async () => {
    await as.token(as.grant())
    await as.credential({ org: 'ORG42', uid: 'EMP10086' })
  })
  const issued = lines.find((l) => l.includes('token issued'))
  const served = lines.find((l) => l.includes('credential served'))
  assert.ok(issued, 'the success path must log something — it logged nothing at all before')
  assert.ok(served)
  assert.match(issued, new RegExp(`actor=${ACTOR}`))
  assert.match(issued, /resource="https:\/\/simplifly-mcp\.impo\.ai\/mcp"/, 'the resource is logged VERBATIM')
  const fingerprint = /cred=([0-9a-f]{12})/.exec(issued)?.[1]
  assert.ok(fingerprint)
  assert.match(served, new RegExp(`cred=${fingerprint}`), 'same token on both hops')
  for (const line of lines) {
    assert.equal(line.includes(TOKEN), false, `credential leaked into a log line: ${line}`)
    assert.equal(line.includes(CLIENT_SECRET), false)
    assert.equal(line.includes(SERVICE_TOKEN), false)
  }
})

test('JWKS fails LOUDLY: an unusable signing key is 503, the same as /oauth/token', async () => {
  // `200 {"keys":[]}` keeps every uptime monitor green while the resource server can verify
  // nothing, and it contradicts /oauth/token, which is 503 in exactly this state.
  for (const key of [undefined, 'not json', '[]', JSON.stringify({ kty: 'EC', alg: 'HS256' })]) {
    const as = server({ OAUTH_SIGNING_KEY: key })
    const jwks = await as.get('/.well-known/jwks.json')
    assert.equal(jwks.status, 503, JSON.stringify(key))
    assert.equal(jwks.headers.get('cache-control'), 'no-store', 'a broken JWKS must not be cached')
    assert.equal((await as.token(as.grant())).status, 503, 'and the two endpoints agree')
  }
})

test('the AS answers 405 on its own paths — a GET probe must not read as a healthy SPA 200', async () => {
  const as = server()
  for (const [path, method, allow] of [
    ['/oauth/token', 'GET', 'POST'],
    ['/oauth/token', 'PUT', 'POST'],
    ['/internal/simplifly-credential', 'GET', 'POST'],
    ['/.well-known/jwks.json', 'POST', 'GET, HEAD'],
    ['/.well-known/oauth-authorization-server', 'POST', 'GET, HEAD'],
  ] as const) {
    const res = await as.method(path, method)
    assert.equal(res.status, 405, `${method} ${path}`)
    assert.equal(res.headers.get('allow'), allow, `${method} ${path}`)
  }
  // …but a HEAD probe of a discovery endpoint is legitimate monitoring, not a 405.
  for (const path of ['/.well-known/jwks.json', '/.well-known/oauth-authorization-server']) {
    assert.equal((await as.method(path, 'HEAD')).status, 200, `HEAD ${path}`)
  }
})

test('unconfigured server fails closed with 5xx — never 400 (which would blame the employee)', async () => {
  // OAUTH_ISSUER belongs in this list: it is not a secret, it lives in wrangler.jsonc `vars`, and
  // it is exactly as load-bearing as the signing key. Left unset the endpoint used to fall back to
  // the request's own origin — so *.workers.dev, a preview URL and the custom domain became three
  // different issuers, every minted token failed the resource server's literal `iss` check, and
  // the only symptom anywhere was an undifferentiated 401. Refuse to mint instead of guessing.
  for (const missing of ['RELAY_CLIENT_SECRET', 'OAUTH_SIGNING_KEY', 'OAUTH_ISSUER'] as const) {
    const as = server({ [missing]: undefined })
    const res = await as.token(as.grant())
    assert.equal(res.status, 503, missing)
  }
})

test('and when the issuer is only missing from DISCOVERY, the fallback is loud', async () => {
  // Discovery still has to answer (it is how the mismatch gets diagnosed at all), but it must not
  // do it silently: this log line is the only place both values are ever visible.
  const as = server({ OAUTH_ISSUER: undefined })
  const { result, lines } = await captureLogs(async () => as.get('/.well-known/oauth-authorization-server'))
  assert.equal(result.status, 200)
  assert.equal(((await result.json()) as { issuer: string }).issuer, ISSUER, 'the request origin, guessed')
  assert.ok(
    lines.some((l) => l.includes('OPS misconfiguration') && l.includes('OAUTH_ISSUER')),
    `the guess must be logged, got: ${lines.join(' | ')}`,
  )
})

test('JWKS publishes the public half ONLY — no private scalar, and enough to pick the key', async () => {
  const as = server()
  const res = await as.get('/.well-known/jwks.json')
  assert.equal(res.status, 200)
  const body = (await res.json()) as { keys: Array<Record<string, unknown>> }
  assert.equal(body.keys.length, 1)
  const [key] = body.keys
  assert.ok(key)
  assert.equal(key.kid, 'test-key')
  assert.equal(key.alg, 'ES256')
  assert.equal(key.use, 'sig')
  assert.equal(key.kty, 'EC')
  assert.equal(key.d, undefined, 'the private scalar must never leave the Worker')
  assert.equal(JSON.stringify(body).includes('"d"'), false)
})

test('rotation: an array of keys signs with the FIRST and keeps publishing the rest', async () => {
  const { privateKey: next } = await generateKeyPair('ES256', { extractable: true })
  const rotated = JSON.stringify([
    { ...(await exportJWK(next)), alg: 'ES256', use: 'sig', kid: 'next-key' },
    JSON.parse(SIGNING_KEY),
  ])
  const as = server({ OAUTH_SIGNING_KEY: rotated })
  const jwks = (await (await as.get('/.well-known/jwks.json')).json()) as { keys: Array<{ kid: string }> }
  assert.deepEqual(jwks.keys.map((k) => k.kid), ['next-key', 'test-key'], 'old key stays published until its tokens expire')

  const body = (await (await as.token(as.grant())).json()) as { access_token: string }
  assert.equal(decodeProtectedHeader(body.access_token).kid, 'next-key')
  // Still verifiable through the published set — that is what makes the rotation seamless.
  await verifyLikeResourceServer(as, body.access_token)
})

test('AS metadata declares what we support and, deliberately, no refresh grant', async () => {
  const as = server()
  const res = await as.get('/.well-known/oauth-authorization-server')
  assert.equal(res.status, 200)
  const meta = (await res.json()) as Record<string, unknown>
  assert.equal(meta.issuer, ISSUER)
  assert.equal(meta.token_endpoint, `${ISSUER}/oauth/token`)
  assert.equal(meta.jwks_uri, `${ISSUER}/.well-known/jwks.json`)
  assert.deepEqual(meta.grant_types_supported, ['client_credentials'])
  assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['client_secret_basic'])
  assert.equal(JSON.stringify(meta).includes('refresh_token'), false, 're-fetching costs what refreshing would')
})

test('/internal/simplifly-credential: the service token gets the tenant\'s CURRENT token', async () => {
  const as = server()
  const res = await as.credential({ org: 'ORG42', uid: 'EMP10086' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { authToken: TOKEN })
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

test('/internal/simplifly-credential: baseUrl rides along only when configured', async () => {
  const as = server({ SIMPLIFLY_BASE_URL: 'https://api-ap-east-1.simplifly.tech' })
  const res = await as.credential({ org: 'ORG42', uid: 'EMP10086' })
  assert.deepEqual(await res.json(), { authToken: TOKEN, baseUrl: 'https://api-ap-east-1.simplifly.tech' })
})

test('/internal/simplifly-credential is SERVICE-authed: a user token is not a service token', async () => {
  const as = server()
  for (const [name, auth] of [
    ['the employee\'s own travelkit token', `Bearer ${TOKEN}`],
    ['a wrong service token', 'Bearer nope'],
    ['no authorization', ''],
  ] as const) {
    const res = await as.credential({ org: 'ORG42', uid: 'EMP10086' }, auth)
    assert.equal(res.status, 401, name)
    assert.equal(JSON.stringify(await res.json()).includes(TOKEN), false, name)
  }
})

test('/internal/simplifly-credential: no credential → 404 (the MCP turns it into user guidance)', async () => {
  const as = server()
  const res = await as.credential({ org: 'ORG42', uid: 'ghost' })
  // 403/404/410 are the client's non-retryable band; 401 would mean "our service token is wrong"
  // and 5xx "retry", so a missing credential MUST land here.
  assert.equal(res.status, 404)
})

test('/internal/simplifly-credential without a service token configured fails closed, not 404', async () => {
  const as = server({ TRIPDESK_SERVICE_TOKEN: undefined })
  const res = await as.credential({ org: 'ORG42', uid: 'EMP10086' })
  assert.equal(res.status, 503, 'an unconfigured server must not claim the employee has no credential')
})

test('/internal/simplifly-credential rejects a body without a tenant', async () => {
  const as = server()
  for (const body of [{}, { org: 'ORG42' }, { uid: 'EMP10086' }, { org: '', uid: '' }, { org: 1, uid: 2 }]) {
    assert.equal((await as.credential(body)).status, 400, JSON.stringify(body))
  }
})

test('SECURITY: the raw credential appears in exactly one response and nowhere else', async () => {
  const as = server()
  const bodies = await Promise.all(
    [
      as.token(as.grant()),
      as.token(as.grant('unknown:actor')),
      as.token(as.grant(), `Basic ${btoa(`${CLIENT_ID}:nope`)}`),
      as.get('/.well-known/jwks.json'),
      as.get('/.well-known/oauth-authorization-server'),
      as.credential({ org: 'ORG42', uid: 'EMP10086' }, 'Bearer nope'),
    ].map(async (p) => (await p).text()),
  )
  for (const body of bodies) {
    assert.equal(body.includes(TOKEN), false, `leaked the Simplifly credential: ${body.slice(0, 120)}`)
    assert.equal(body.includes(CLIENT_SECRET), false)
    assert.equal(body.includes(SERVICE_TOKEN), false)
  }
  // The assertion is an identity claim, not a credential: it must not carry the token either.
  const granted = JSON.parse(bodies[0] ?? '{}') as { access_token: string }
  const [, claims] = granted.access_token.split('.')
  assert.equal(Buffer.from(claims ?? '', 'base64url').toString().includes(TOKEN), false)
})
