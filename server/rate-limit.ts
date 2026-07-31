/**
 * A small in-isolate failed-attempt limiter, for the two endpoints whose only gate is a static
 * shared secret: POST /oauth/token (client credentials) and POST /internal/simplifly-credential
 * (service token — it returns a full-privilege, `exp`-less, NON-REVOCABLE Simplifly credential).
 *
 * What it is for: a wrong secret is never legitimate traffic, so failures should be BOUNDED and
 * LOUD. Without this an attacker can guess at line rate against a publicly routable hostname and
 * leave nothing behind but a 401 count nobody keeps.
 *
 * What it is NOT: a distributed rate limiter. Workers isolates are per-colo and ephemeral, so a
 * determined attacker who spreads across colos gets `limit` attempts per isolate rather than
 * `limit` globally. That is still a hard cap on how fast any single connection can probe, and
 * every attempt is logged. For a durable, account-wide cap, add Cloudflare's rate-limiting
 * binding (see README) — the endpoints consult it through the same decision shape when present.
 *
 * Deliberately allocation-light and dependency-free: one Map, a fixed window, and a hard cap on
 * distinct keys so a rotating-IP attacker cannot grow it without bound.
 */

export interface LimiterDecision {
  /** Locked out: answer 429 and do NOT run the comparison (a locked-out caller gets no oracle). */
  blocked: boolean
  /** Failures recorded in the current window for this key. */
  hits: number
  /** Seconds until the window resets — goes straight into `Retry-After`. */
  retryAfterS: number
}

export interface FailureLimiter {
  /** Is this key already locked out? Call BEFORE the expensive/oracle work. */
  check(key: string): LimiterDecision
  /** Record one failed attempt and return the post-increment decision. */
  record(key: string): LimiterDecision
  /** Clear a key after a SUCCESSFUL authentication, so a legitimate caller who fat-fingered a
   *  rollout is not held hostage by its own earlier failures. */
  clear(key: string): void
}

export interface FailureLimiterOptions {
  /** Failures allowed per window before the key is locked out. */
  limit?: number
  /** Window length in ms. */
  windowMs?: number
  /** Hard cap on tracked keys; past it the table is pruned, then dropped. Bounds memory against
   *  an attacker who rotates source IPs. */
  maxKeys?: number
  /** Injectable clock (tests). */
  now?: () => number
}

interface Bucket {
  hits: number
  resetAt: number
}

export function createFailureLimiter(options: FailureLimiterOptions = {}): FailureLimiter {
  const limit = options.limit ?? 10
  const windowMs = options.windowMs ?? 60_000
  const maxKeys = options.maxKeys ?? 4096
  const now = options.now ?? (() => Date.now())
  const buckets = new Map<string, Bucket>()

  const decide = (bucket: Bucket, at: number): LimiterDecision => ({
    blocked: bucket.hits >= limit,
    hits: bucket.hits,
    retryAfterS: Math.max(1, Math.ceil((bucket.resetAt - at) / 1000)),
  })

  const live = (key: string, at: number): Bucket => {
    const found = buckets.get(key)
    if (found && found.resetAt > at) return found
    const fresh: Bucket = { hits: 0, resetAt: at + windowMs }
    buckets.set(key, fresh)
    return fresh
  }

  const prune = (at: number): void => {
    if (buckets.size <= maxKeys) return
    for (const [key, bucket] of buckets) if (bucket.resetAt <= at) buckets.delete(key)
    // Still over the cap → every bucket is live, i.e. we are being flooded with distinct keys.
    // Dropping the table fails OPEN rather than growing without bound: the per-request logging
    // is what catches that case, not this map.
    if (buckets.size > maxKeys) buckets.clear()
  }

  return {
    check(key) {
      const at = now()
      return decide(live(key, at), at)
    },
    record(key) {
      const at = now()
      const bucket = live(key, at)
      bucket.hits += 1
      prune(at)
      return decide(bucket, at)
    },
    clear(key) {
      buckets.delete(key)
    },
  }
}

/** Bucket key for the limiter. Never trusted for authorization — but a bucket key that the CALLER
 *  chooses is worse than none: `X-Forwarded-For` is request data, so an attacker rotating it gets
 *  an unbounded number of fresh budgets AND can spend the legitimate relay's budget by forging its
 *  address. Only `CF-Connecting-IP` is written by the edge and cannot be set by a client.
 *
 *  Absent (a request that did not come through the Cloudflare edge — `wrangler dev`, a direct
 *  origin hit) → ONE shared bucket, which fails closed: those callers share a single cap instead
 *  of minting one each. */
export function callerKey(headers: Headers): string {
  return headers.get('CF-Connecting-IP')?.trim() || 'unattributed'
}
