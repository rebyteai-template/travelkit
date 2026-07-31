/**
 * TravelKit as the Authorization Server for the delegated per-user credential flow
 * (mcp/docs/PLAN-delegated-credentials.md §4/§5). Mounted at the Worker root, OUTSIDE the
 * /api/app/* embed middleware — these callers are machines, not iframes.
 *
 *   POST /oauth/token                    ← the rebyte relay (Basic client credentials)
 *   POST /internal/simplifly-credential  ← our MCP resource server (service token)
 *   GET  /.well-known/jwks.json          ← public (the resource server verifies signatures)
 *   GET  /.well-known/oauth-authorization-server  ← public (RFC 8414 discovery)
 *
 * Two hops, and they must NOT be merged:
 *   ① relay → /oauth/token, presenting an opaque `actor`, gets back an IDENTITY ASSERTION:
 *     a short-lived JWT whose `aud` is our MCP's canonical resource URI. The relay can read
 *     it; it is worthless anywhere else.
 *   ② our MCP → /internal/simplifly-credential, presenting its service token, gets back that
 *     employee's Simplifly credential. The relay never sees this, ever.
 * The Simplifly credential has no `exp`, cannot be revoked and is full-privilege, so it must
 * never ride on ① — the relay would persist it into an immutable Temporal history.
 *
 * ── the signing key ────────────────────────────────────────────────────────────────────
 * The private key lives in exactly one place: the `OAUTH_SIGNING_KEY` Worker secret, holding a
 * JSON private JWK (or an ARRAY of them, see rotation). Generate and install:
 *
 *     node scripts/gen-oauth-key.mjs | npx wrangler secret put OAUTH_SIGNING_KEY
 *
 * It is never logged and never returned: /.well-known/jwks.json publishes only the public half,
 * derived here by copying an allowlist of public members (so `d` cannot leak by accident).
 *
 * Rotation, with no downtime and nothing to coordinate with the resource server (it discovers
 * keys by `kid` from the JWKS):
 *   1. `node scripts/gen-oauth-key.mjs > new.key`   (`*.key` is gitignored; keep it out of the tree anyway)
 *   2. set the secret to a JSON array `[<new key>, <current key>]`. The FIRST entry signs; all
 *      entries are published, so tokens already minted under the old `kid` still verify.
 *   3. after TOKEN_TTL_S has passed (no token can predate it), set the secret to just `[<new>]`.
 * Worker secrets are write-only, so keep the current JWK somewhere you can read it back (a
 * password manager) — otherwise step 2 is impossible. Lost key = hard swap: install a fresh one
 * and live with up to TOKEN_TTL_S of 401s while cached assertions age out.
 *
 * ── what this module deliberately does NOT do ──────────────────────────────────────────
 * No refresh tokens: re-fetching costs exactly what refreshing would, and a refresh token is one
 * more long-lived secret to store. No proactive Simplifly-token refresh either: the host
 * re-renders the iframe with a new token on re-login and that overwrites our row for free.
 */
import { Hono } from 'hono'
import { SignJWT, importJWK, calculateJwkThumbprint, type JWK } from 'jose'
import type { Store } from './store.ts'
import { credentialFingerprint } from './tenant-credential.ts'
import { callerKey, createFailureLimiter } from './rate-limit.ts'

/** The bindings this module reads. worker/env.ts's `Env` extends it. */
export interface OAuthEnv {
  DB: D1Database
  /** Private signing key: a JSON JWK, or a JSON array of them (first signs, all are published).
   *  `wrangler secret put OAUTH_SIGNING_KEY`. Unset → the token endpoint is 503. */
  OAUTH_SIGNING_KEY?: string
  /** Our issuer, e.g. `https://tripdesk.impo.ai` — declared in wrangler.jsonc `vars`, not secret.
   *  MUST match the resource server's `OAUTH_ISSUER` character for character. Unset → the token
   *  endpoint is 503 (it will not guess an issuer) and discovery logs loudly. */
  OAUTH_ISSUER?: string
  /** Comma-separated resource URIs we are willing to mint tokens for (RFC 8707). The first is
   *  the default when the client omits `resource`. Unset → DEFAULT_RESOURCE. */
  OAUTH_RESOURCES?: string
  /** The one integrator's client credentials (`wrangler secret put RELAY_CLIENT_ID` /
   *  `RELAY_CLIENT_SECRET`). One client → two secrets, not a clients table. */
  RELAY_CLIENT_ID?: string
  RELAY_CLIENT_SECRET?: string
  /** Service-to-service auth for /internal/simplifly-credential — NOT a user token. Must equal
   *  the resource server's `TRIPDESK_SERVICE_TOKEN`. */
  TRIPDESK_SERVICE_TOKEN?: string
  /** Optional Simplifly gateway override handed to the resource server alongside the credential
   *  (multi-environment tenants). Omitted from the response when unset. */
  SIMPLIFLY_BASE_URL?: string
}

/** Assertion lifetime. The relay caches it until `exp`, so this is also how long a just-revoked
 *  employee can still reach the MCP, and the worst-case blast radius of an emergency key swap. */
const TOKEN_TTL_S = 3600

/** Our MCP's canonical resource URI (RFC 8707). The resource server compares `aud` to this
 *  LITERALLY — one character off and every request 401s, indistinguishably from a forgery. */
const DEFAULT_RESOURCE = 'https://simplifly-mcp.impo.ai/mcp'

/** Mirrors the resource server's allowlist: asymmetric only, so a leaked public key can never be
 *  replayed as an HMAC secret. */
const ALLOWED_ALGS = new Set(['ES256', 'ES384', 'RS256', 'RS384', 'PS256'])

/** The only JWK members that may be published. Copying an allowlist (rather than deleting `d`)
 *  means a future key type can't leak private material by having a member we forgot about. */
const PUBLIC_JWK_MEMBERS = ['kty', 'crv', 'x', 'y', 'n', 'e'] as const

// ── actor ───────────────────────────────────────────────────────────────────────────────
/**
 * `actor` is opaque to the relay — it forwards the bytes TravelKit put on POST /v1/tasks and
 * never interprets them — so the format is ours, with one hard requirement: it must round-trip
 * back into a tenant here.
 *
 * Format: `<org>:<uid>`, byte-for-byte the tenant key TravelKit already uses (tasks.user_email,
 * agent_computers.user_email, the DO names). The actor therefore IS the storage key: no mapping
 * table exists to drift.
 *
 * Split at the FIRST colon, so a `uid` containing colons is fine. An `org` containing one would
 * split in the wrong place — and even then the credential still resolves, because the lookup
 * rebuilds `<org>:<uid>` and gets the original string back; only the org/uid claims (attribution
 * only) would be cut oddly.
 */
export function formatActor(org: string, uid: string): string {
  return `${org}:${uid}`
}

export function parseActor(actor: string): { org: string; uid: string } | null {
  const at = actor.indexOf(':')
  if (at <= 0 || at === actor.length - 1) return null
  return { org: actor.slice(0, at), uid: actor.slice(at + 1) }
}

// ── credential comparison ───────────────────────────────────────────────────────────────
/** Constant-time equality. Comparing SHA-256 digests (not the strings) so neither the value nor
 *  its LENGTH is observable through timing. Same idiom as the resource server's token check. */
async function secretMatches(presented: string, expected: string): Promise<boolean> {
  const digest = async (text: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  const a = await digest(presented)
  const b = await digest(expected)
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

/**
 * RFC 6749 §2.3.1 requires a client to `application/x-www-form-urlencoded`-encode BOTH halves
 * before base64-ing them, so `a+b` arrives as `a%2Bb` and a space as `+`. Undo that.
 *
 * Belt and braces, because getting this wrong is invisible and permanent: the README/PLAN mandate
 * a `openssl rand -hex 32` secret (hex is unchanged by form-encoding, so the question never
 * arises), AND we decode here so a conformant client with a non-hex secret still authenticates.
 * The failure this prevents is nasty: a `+` in the secret makes the comparison fail forever, the
 * relay classifies `invalid_client` as a RETRYABLE ops error (PLAN §5.2) and retries against a
 * credential that can never match, while the operator is told their id/secret is wrong — about a
 * value they installed byte for byte.
 *
 * A non-conformant client that sends the raw value still works: both readings are compared.
 */
function formDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    // A stray `%` is not a valid encoding; the raw reading is then the only candidate.
    return value
  }
}

interface BasicCredentials {
  /** As it arrived on the wire. */
  id: string
  secret: string
  /** After undoing `application/x-www-form-urlencoded`. Equal to the above for hex secrets. */
  decodedId: string
  decodedSecret: string
}

function parseBasic(header: string | undefined): BasicCredentials | null {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? '')
  if (!match?.[1]) return null
  let decoded: string
  try {
    decoded = atob(match[1])
  } catch {
    return null
  }
  const at = decoded.indexOf(':')
  if (at < 0) return null
  const id = decoded.slice(0, at)
  const secret = decoded.slice(at + 1)
  return { id, secret, decodedId: formDecode(id), decodedSecret: formDecode(secret) }
}

/** True when EITHER reading of the presented value matches. Both comparisons always run, so the
 *  timing carries no information about which (if either) was close. */
async function basicHalfMatches(raw: string, formDecoded: string, expected: string): Promise<boolean> {
  const [rawOk, decodedOk] = await Promise.all([secretMatches(raw, expected), secretMatches(formDecoded, expected)])
  return rawOk || decodedOk
}

function parseBearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '')
  return match?.[1]?.trim() || null
}

// ── keys ────────────────────────────────────────────────────────────────────────────────
type SigningKey = Awaited<ReturnType<typeof importJWK>>

interface KeySet {
  /** Signs new tokens: the first configured key. */
  signer: { key: SigningKey; kid: string; alg: string }
  /** Every public half we still publish — the signer plus predecessors kept during rotation. */
  published: JWK[]
}

/** Per-isolate cache, keyed by the raw secret so a rotated secret invalidates it by itself. */
let keySetCache: { raw: string; keySet: Promise<KeySet> } | undefined

/** Public half of a JWK, plus the `kid`/`alg`/`use` the resource server needs to pick it. A key
 *  without an explicit `kid` gets its RFC 7638 thumbprint, so the id is stable either way. */
async function publicHalf(jwk: JWK): Promise<JWK> {
  const pub: JWK = {}
  for (const member of PUBLIC_JWK_MEMBERS) {
    const value = jwk[member]
    if (typeof value === 'string') pub[member] = value
  }
  pub.kid = jwk.kid ?? (await calculateJwkThumbprint(pub))
  pub.alg = jwk.alg ?? 'ES256'
  pub.use = 'sig'
  return pub
}

async function buildKeySet(raw: string): Promise<KeySet> {
  const parsed: unknown = JSON.parse(raw)
  const jwks = (Array.isArray(parsed) ? parsed : [parsed]) as JWK[]
  const first = jwks[0]
  if (!first) throw new Error('OAUTH_SIGNING_KEY contains no key')
  const alg = first.alg ?? 'ES256'
  if (!ALLOWED_ALGS.has(alg)) throw new Error(`signing alg ${alg} is not accepted by the resource server`)
  const published: JWK[] = []
  for (const jwk of jwks) published.push(await publicHalf(jwk))
  const kid = published[0]?.kid
  if (typeof kid !== 'string') throw new Error('OAUTH_SIGNING_KEY key has no usable kid')
  return { signer: { key: await importJWK(first, alg), kid, alg }, published }
}

function loadKeySet(raw: string): Promise<KeySet> {
  const hit = keySetCache
  if (hit?.raw === raw) return hit.keySet
  const keySet = buildKeySet(raw)
  keySetCache = { raw, keySet }
  // A rejected promise must not be cached forever — a fixed secret has to take effect at once.
  keySet.catch(() => {
    if (keySetCache?.keySet === keySet) keySetCache = undefined
  })
  return keySet
}

// ── responses ───────────────────────────────────────────────────────────────────────────
/** Plain Responses rather than c.json(): these handlers are mounted into a generically-typed
 *  app, and a Response passes through Hono untouched. */
function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/**
 * RFC 6749 §5.2. The relay branches on the `error` CODE, not the status (PLAN §5.2) — but the
 * status must not contradict it, because a status-only reading is the mistake that turns an ops
 * bug into "every employee, forever: reopen FlyAI". Hence, on this side:
 *
 *   400 is RESERVED for `invalid_grant` — the one condition the employee can actually act on
 *       ("this actor has no current credential"), and the only NON-retryable answer.
 *   401 invalid_client                  → OUR client credentials are wrong: retryable ops error.
 *   5xx everything else, `invalid_target` / `invalid_request` / `unsupported_grant_type`
 *       included → they are all OUR misconfiguration, and they are retryable ops errors. A
 *       trailing slash in a registered URL must never read as "the employee's session expired".
 *   429                                 → too many failed authentications from this caller.
 *
 * Descriptions stay generic: nothing here may hint at whether an actor exists.
 */
function oauthError(error: string, description: string, status: number, headers: Record<string, string> = {}): Response {
  return json({ error, error_description: description }, status, { 'Cache-Control': 'no-store', ...headers })
}

/**
 * The ops band. Same OAuth code the spec would use, but a 5xx status so that anything reading the
 * status alone (a proxy, a dashboard, a relay that has not implemented PLAN §5.2 yet) still lands
 * on "retryable, our problem" instead of "blame the employee". Every one of these is a
 * configuration mismatch between us, the relay and the resource server, so it is also LOGGED —
 * a bare 400 in a relay log is undiagnosable.
 */
function opsError(error: string, description: string, detail: string): Response {
  // `OPS` is the alarm string: in a correctly configured system none of these ever fire.
  console.log(`[oauth] OPS misconfiguration: ${error} — ${detail}`)
  return oauthError(error, description, 500)
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const

/** These paths belong to the AS, whatever the method. Answering 405 rather than falling through
 *  to the SPA is what stops a probe from reading `200 text/html` as a healthy endpoint. */
function methodNotAllowed(allow: string): Response {
  return json({ error: 'method_not_allowed' }, 405, { Allow: allow, ...NO_STORE })
}

function resourcesOf(env: OAuthEnv): string[] {
  return (env.OAUTH_RESOURCES ?? DEFAULT_RESOURCE)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

/**
 * Pick the audience for a requested RFC 8707 `resource`.
 *
 * Exact match first — that is the contract, and PLAN §5.2.1 forbids the relay from normalizing
 * what it sends. But when the two disagree by a trailing slash, or the relay sends the server's
 * ORIGIN instead of its full URL (a common reading of RFC 8707), the strict answer is
 * `invalid_target` for EVERY employee forever over a one-character mismatch on our side. So two
 * narrow tolerances, both of which can only ever resolve to a resource we already allow, and both
 * of which mint the CANONICAL string (the resource server compares `aud` literally):
 *
 *   1. equal after trailing slashes are stripped
 *   2. the request is exactly the origin of exactly one allowlisted resource (ambiguity → no match)
 *
 * Neither widens the audience: an authenticated client can already ask for any allowlisted
 * resource, or omit `resource` and get the default. Both log, because the configuration is still
 * wrong and somebody has to be able to find it.
 */
function selectAudience(allowed: string[], requested: string): { audience: string; tolerated?: string } | null {
  const exact = allowed.find((value) => value === requested)
  if (exact) return { audience: exact }

  const bare = (value: string): string => value.replace(/\/+$/, '')
  const slashInsensitive = allowed.filter((value) => bare(value) === bare(requested))
  if (slashInsensitive.length === 1 && slashInsensitive[0]) {
    return { audience: slashInsensitive[0], tolerated: 'trailing-slash' }
  }

  const originOf = (value: string): string | null => {
    try {
      return new URL(value).origin
    } catch {
      return null
    }
  }
  const requestedOrigin = originOf(requested)
  if (requestedOrigin && bare(requested) === bare(requestedOrigin)) {
    const sameOrigin = allowed.filter((value) => originOf(value) === requestedOrigin)
    if (sameOrigin.length === 1 && sameOrigin[0]) return { audience: sameOrigin[0], tolerated: 'origin-only' }
  }
  return null
}

/**
 * Our `iss`, and the base of every URL in the discovery document.
 *
 * Falling back to the request's own origin is a TRAP, which is why the fallback is loud here and
 * FATAL on the token endpoint (which refuses to mint rather than guess): the origin makes
 * `*.workers.dev`, a preview deployment and the custom domain three different issuers, and the
 * resource server compares `iss` literally. Every token then 401s — indistinguishably from a
 * forgery, on a hop where nobody can see both values. It is declared in wrangler.jsonc `vars`.
 */
function issuerOf(env: OAuthEnv, requestUrl: string): string {
  if (env.OAUTH_ISSUER) return env.OAUTH_ISSUER.replace(/\/$/, '')
  const origin = new URL(requestUrl).origin
  console.log(
    `[oauth] OPS misconfiguration: OAUTH_ISSUER is not set — falling back to this request's origin ${JSON.stringify(origin)}, which must match the resource server's OAUTH_ISSUER character for character or every token 401s`,
  )
  return origin.replace(/\/$/, '')
}

/**
 * The Authorization Server, as a mountable Hono app.
 *
 * The store arrives as a factory (rather than a context var) because these routes sit outside
 * the embed middleware that injects one — and because it keeps the driver swappable and the
 * tests free of D1.
 */
export function authorizationServer<E extends OAuthEnv = OAuthEnv>(storeFor: (env: E) => Store) {
  const as = new Hono<{ Bindings: E }>()

  // Failed-authentication limiters, one per endpoint (a locked-out attacker on /internal must not
  // affect the relay, and vice versa). Per isolate — see server/rate-limit.ts on what that buys.
  const clientAuthLimiter = createFailureLimiter()
  const serviceAuthLimiter = createFailureLimiter()

  /** 429 for a caller that has spent its failure budget. Retryable everywhere downstream. */
  const tooManyFailures = (endpoint: string, caller: string, retryAfterS: number, error: string): Response => {
    console.log(`[oauth] LOCKED OUT ${endpoint} caller=${caller} retry_after=${retryAfterS}s`)
    return oauthError(error, 'too many failed authentication attempts', 429, { 'Retry-After': String(retryAfterS) })
  }

  // ── ① identity assertion ──────────────────────────────────────────────────────────────
  as.post('/oauth/token', async (c) => {
    const env = c.env
    // OAUTH_ISSUER is as load-bearing as the signing key: minting under a GUESSED issuer produces
    // tokens the resource server rejects as forgeries, so refuse to mint rather than guess.
    if (!env.RELAY_CLIENT_ID || !env.RELAY_CLIENT_SECRET || !env.OAUTH_SIGNING_KEY || !env.OAUTH_ISSUER) {
      const missing = (['RELAY_CLIENT_ID', 'RELAY_CLIENT_SECRET', 'OAUTH_SIGNING_KEY', 'OAUTH_ISSUER'] as const)
        .filter((name) => !env[name])
        .join(', ')
      console.log(`[oauth] token endpoint is not configured: ${missing} unset`)
      return oauthError('server_error', 'authorization server is not configured', 503)
    }

    // Client authentication first: an unauthenticated caller learns nothing about any actor.
    const caller = callerKey(c.req.raw.headers)
    const locked = clientAuthLimiter.check(caller)
    if (locked.blocked) return tooManyFailures('/oauth/token', caller, locked.retryAfterS, 'invalid_client')

    const basic = parseBasic(c.req.header('Authorization'))
    const invalidClient = (why: string) => {
      // Every failed client authentication is logged. A wrong secret is never legitimate traffic,
      // so silence here is how a slow guessing run stays invisible.
      const after = clientAuthLimiter.record(caller)
      console.log(`[oauth] client authentication FAILED endpoint=/oauth/token caller=${caller} reason=${why} attempts=${after.hits}`)
      return oauthError('invalid_client', 'client authentication failed', 401, { 'WWW-Authenticate': 'Basic realm="tripdesk"' })
    }
    if (!basic) return invalidClient('no basic credentials')
    // Both comparisons run before the verdict — `&&` on already-awaited booleans, so a wrong id
    // and a wrong secret cost the same.
    const idOk = await basicHalfMatches(basic.id, basic.decodedId, env.RELAY_CLIENT_ID)
    const secretOk = await basicHalfMatches(basic.secret, basic.decodedSecret, env.RELAY_CLIENT_SECRET)
    if (!(idOk && secretOk)) return invalidClient('credentials do not match')
    clientAuthLimiter.clear(caller)

    const params = new URLSearchParams(await c.req.text())
    const grantType = params.get('grant_type') ?? ''
    if (grantType !== 'client_credentials') {
      // OUR integration is wrong, not the employee's session — ops band (see opsError).
      return opsError('unsupported_grant_type', 'only client_credentials is supported', `grant_type=${grantType || '<absent>'}`)
    }
    const actor = (params.get('actor') ?? '').trim()
    if (!actor) return opsError('invalid_request', 'actor is required', 'the client sent no actor')

    // RFC 8707: honour the requested resource, but only from our allowlist — minting a token for
    // an arbitrary audience would turn this endpoint into a confused deputy.
    const allowed = resourcesOf(env)
    const requested = params.get('resource')?.trim()
    const selected = requested ? selectAudience(allowed, requested) : allowed[0] ? { audience: allowed[0] } : null
    if (!selected) {
      // Logged VERBATIM (PLAN §5.2.1): when `aud` does not match, the resource server can only
      // answer an undifferentiated 401, so this line is the only place the mismatch is visible.
      return opsError(
        'invalid_target',
        'unknown resource',
        `requested=${JSON.stringify(requested)} allowed=${JSON.stringify(allowed)}`,
      )
    }
    if (selected.tolerated) {
      console.log(
        `[oauth] OPS misconfiguration: resource ${selected.tolerated} mismatch — requested=${JSON.stringify(requested)} minted aud=${JSON.stringify(selected.audience)}; fix the registered server URL`,
      )
    }
    const audience = selected.audience

    const tenant = parseActor(actor)
    // A malformed actor is indistinguishable, to the caller, from an unknown one: same 400.
    if (!tenant) return oauthError('invalid_grant', 'no current credential for this actor', 400)

    // Gate on the credential existing HERE, not four hops later inside a tool call: the relay
    // needs the non-retryable answer while it can still turn it into "reopen the iframe".
    const store = storeFor(env)
    let credential: string | undefined
    try {
      credential = await store.getTenantCredential(actor)
    } catch (e) {
      // A storage failure is OURS. Returning 400 here would tell the employee to reopen FlyAI,
      // and reopening would re-run the same failing lookup — forever.
      console.log(`[oauth] credential lookup FAILED actor=${actor} error=${(e as Error).message}`)
      return oauthError('server_error', 'credential store unavailable', 503)
    }
    if (!credential) {
      // The miss is ambiguous and the two readings need OPPOSITE answers, so ask the store which
      // one it is: if it cannot even be written to (unapplied migration, quota, outage), the
      // honest answer is a retryable 5xx, not "this employee has no credential".
      try {
        await store.probeCredentialStore()
      } catch (e) {
        console.log(`[oauth] credential store UNWRITABLE (actor=${actor}) error=${(e as Error).message}`)
        return oauthError('server_error', 'credential store unavailable', 503)
      }
      console.log(`[oauth] no credential for actor=${actor} (store healthy) → invalid_grant`)
      return oauthError('invalid_grant', 'no current credential for this actor', 400)
    }

    let keySet: KeySet
    try {
      keySet = await loadKeySet(env.OAUTH_SIGNING_KEY)
    } catch (e) {
      console.log(`[oauth] signing key unusable: ${(e as Error).message}`)
      return oauthError('server_error', 'authorization server is not configured', 503)
    }

    const now = Math.floor(Date.now() / 1000)
    // Every claim here is load-bearing for mcp/src/mcp/auth.ts: `aud` literally equal to the
    // resource URI, `iss` matching its OAUTH_ISSUER, `exp` present (it is a requiredClaim — a
    // token without one would never expire), and non-empty org/uid or it cannot attribute.
    const accessToken = await new SignJWT({ org: tenant.org, uid: tenant.uid })
      .setProtectedHeader({ alg: keySet.signer.alg, kid: keySet.signer.kid })
      .setIssuer(issuerOf(env, c.req.url))
      .setAudience(audience)
      .setSubject(actor)
      .setIssuedAt(now)
      .setExpirationTime(now + TOKEN_TTL_S)
      .sign(keySet.signer.key)

    // The attribution line (PLAN §6, 归因可观测). `cred` is a truncated SHA-256 of the credential
    // this assertion will resolve to — it appears again when /internal serves that credential, so
    // "the tool call used THIS employee's token, not an org-wide fallback" is provable from logs
    // and nothing reversible is written down. `resource` is the client's request VERBATIM.
    console.log(
      `[oauth] token issued actor=${actor} org=${tenant.org} resource=${JSON.stringify(requested ?? '<default>')} aud=${JSON.stringify(audience)} kid=${keySet.signer.kid} exp=${now + TOKEN_TTL_S} cred=${await credentialFingerprint(credential)}`,
    )
    return json({ access_token: accessToken, token_type: 'Bearer', expires_in: TOKEN_TTL_S }, 200, NO_STORE)
  })

  // Anything but POST on the token endpoint is a probe or a bug. Without this it falls through to
  // the SPA catch-all in the composition root and answers `200 text/html` — a synthetic monitor
  // would call that healthy.
  as.all('/oauth/token', () => methodNotAllowed('POST'))

  // ── ② the actual credential ───────────────────────────────────────────────────────────
  // Service-authed, never user-authed: the caller is our MCP resource server, which has already
  // verified the assertion from ① and is now asking for the token behind it. The status codes are
  // the contract (mcp/src/infrastructure/tripdesk-client.ts): 403/404/410 = "this tenant has no
  // credential", non-retryable, becomes user guidance; 401 = our service token is wrong, a
  // retryable ops error; 5xx = we are broken.
  as.post('/internal/simplifly-credential', async (c) => {
    const env = c.env
    if (!env.TRIPDESK_SERVICE_TOKEN) {
      // Fail closed. Deliberately NOT 404 — an unconfigured server must not tell the caller the
      // employee has no credential.
      console.log('[oauth] /internal/simplifly-credential is not configured (TRIPDESK_SERVICE_TOKEN missing)')
      return json({ error: 'server_error' }, 503, NO_STORE)
    }

    // This endpoint returns a full-privilege, `exp`-less, non-revocable Simplifly credential, and
    // its only gate is one static bearer on a publicly routable hostname. So: bounded failures and
    // a log line per attempt. 429 lands in the client's retryable band (tripdesk-client.ts).
    const caller = callerKey(c.req.raw.headers)
    const locked = serviceAuthLimiter.check(caller)
    if (locked.blocked) {
      console.log(`[oauth] LOCKED OUT /internal/simplifly-credential caller=${caller} retry_after=${locked.retryAfterS}s`)
      return json({ error: 'rate_limited' }, 429, { ...NO_STORE, 'Retry-After': String(locked.retryAfterS) })
    }

    const presented = parseBearer(c.req.header('Authorization'))
    if (!presented || !(await secretMatches(presented, env.TRIPDESK_SERVICE_TOKEN))) {
      const after = serviceAuthLimiter.record(caller)
      console.log(
        `[oauth] service authentication FAILED endpoint=/internal/simplifly-credential caller=${caller} reason=${presented ? 'token does not match' : 'no bearer token'} attempts=${after.hits}`,
      )
      return json({ error: 'unauthorized' }, 401, NO_STORE)
    }
    serviceAuthLimiter.clear(caller)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return json({ error: 'invalid_request' }, 400, NO_STORE)
    }
    const input = (body ?? {}) as Record<string, unknown>
    const org = typeof input.org === 'string' ? input.org : ''
    const uid = typeof input.uid === 'string' ? input.uid : ''
    if (!org || !uid) return json({ error: 'invalid_request' }, 400, NO_STORE)

    // Always the last token received, never a judgement about it: it carries no `exp`, so
    // "still valid?" is a question we cannot answer and must not guess at. A genuinely dead
    // token surfaces upstream as Simplifly 401020, which the MCP already turns into
    // "reopen FlyAI from the company portal".
    const tenant = formatActor(org, uid)
    let token: string | undefined
    try {
      token = await storeFor(env).getTenantCredential(tenant)
    } catch (e) {
      // Same rule as the token endpoint: a storage failure is a retryable 5xx, never the
      // non-retryable "this employee has no credential" (404) the client turns into user guidance.
      console.log(`[oauth] credential lookup FAILED tenant=${tenant} error=${(e as Error).message}`)
      return json({ error: 'server_error' }, 503, NO_STORE)
    }
    if (!token) return json({ error: 'credential_unavailable' }, 404, NO_STORE)

    // Attribution: the same fingerprint the token endpoint logged for this actor. Matching pairs
    // are the evidence PLAN §6 asks for; a mismatch is a silent fallback to somebody else's token.
    console.log(`[oauth] credential served tenant=${tenant} cred=${await credentialFingerprint(token)}`)

    // The ONLY response in this repo that carries the raw credential.
    return json(
      { authToken: token, ...(env.SIMPLIFLY_BASE_URL ? { baseUrl: env.SIMPLIFLY_BASE_URL } : {}) },
      200,
      NO_STORE,
    )
  })

  as.all('/internal/simplifly-credential', () => methodNotAllowed('POST'))

  // ── discovery ─────────────────────────────────────────────────────────────────────────
  // A missing or unusable signing key is an OUTAGE, and it must LOOK like one. `200 {"keys":[]}`
  // is the worst possible answer: every uptime monitor reports green while the resource server
  // finds no key and 401s every assertion we already minted — indistinguishably from a forgery.
  // 503 also makes this endpoint agree with /oauth/token, which is 503 in exactly this state;
  // two endpoints telling monitoring opposite stories is how a rotation mistake stays unnoticed.
  // GET and HEAD: uptime monitors probe with HEAD, and a 405 there would be a false alarm.
  as.on(['GET', 'HEAD'], '/.well-known/jwks.json', async (c) => {
    const raw = c.env.OAUTH_SIGNING_KEY
    if (!raw) {
      console.log('[oauth] JWKS unavailable: OAUTH_SIGNING_KEY is not set')
      return json({ error: 'server_error', error_description: 'no signing key configured' }, 503, NO_STORE)
    }
    try {
      const keySet = await loadKeySet(raw)
      // Short max-age: the resource server re-fetches on an unknown `kid` anyway, so this only
      // has to be shorter than a rotation window.
      return json({ keys: keySet.published }, 200, { 'Cache-Control': 'public, max-age=300' })
    } catch (e) {
      console.log(`[oauth] JWKS unavailable: signing key unusable: ${(e as Error).message}`)
      return json({ error: 'server_error', error_description: 'signing key unusable' }, 503, NO_STORE)
    }
  })

  as.all('/.well-known/jwks.json', () => methodNotAllowed('GET, HEAD'))

  as.on(['GET', 'HEAD'], '/.well-known/oauth-authorization-server', (c) => {
    const issuer = issuerOf(c.env, c.req.url)
    return json(
      {
        issuer,
        token_endpoint: `${issuer}/oauth/token`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        // client_credentials only. NO refresh_token on purpose: re-fetching an assertion costs
        // exactly what refreshing one would, so a refresh token would be a second long-lived
        // secret bought for nothing. And no authorization_endpoint — nobody here is a browser,
        // which is why response_types_supported is empty.
        grant_types_supported: ['client_credentials'],
        response_types_supported: [],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      },
      200,
      { 'Cache-Control': 'public, max-age=300' },
    )
  })

  as.all('/.well-known/oauth-authorization-server', () => methodNotAllowed('GET, HEAD'))

  return as
}
