import { sha256Hex } from './digest.ts'
/**
 * Intake for the tenant's CURRENT Simplifly credential — the value
 * POST /internal/simplifly-credential later hands to our MCP resource server (PLAN §4.3).
 *
 * ── the policy is that there is no policy ───────────────────────────────────────────────────
 * Every request carrying a tenant token OVERWRITES the row. Unconditionally. The stored value is
 * read only so the audit line can say what was replaced; it has no vote. `/internal` therefore
 * always returns the last token received, and we never judge whether that token is any good: a
 * Simplifly token has no `exp` and we do not hold their signing key, so "is this one still valid"
 * is a question we cannot answer — and any rule that answers it by guessing can refuse the one
 * value that would have worked.
 *
 * This WAS tried the other way (a transition policy: junk may not replace a real token, another
 * account's token is refused, an older token may not roll back a newer one) and it is reverted,
 * because `persistTenantCredential` is the ONLY writer of this row in the repo — no delete, no
 * override, no TTL. One refused transition is therefore PERMANENT: `/internal` keeps serving the
 * token we already hold, Simplifly answers 401020, the employee is told to reopen FlyAI, and
 * reopening cannot help, because the fresh token is precisely what is being refused. It fires on
 * an upstream account re-provision, and on ANY change to Simplifly's token format it fires for
 * every tenant at once, with no recovery but a hand-edited database. A stale row is worth
 * strictly more than a stuck one.
 *
 * ── the residual risk that leaves, stated plainly ──────────────────────────────────────────
 * The iframe handoff is unsigned (INTEGRATION.md:44 — "拿到完整链接者可改 uid 越权"): `uid`, `org`
 * and `token` are three request headers, so anyone who can reach the Worker can overwrite anyone's
 * credential and hold that employee at 401020 for as long as they keep doing it. Nothing here
 * closes that, and nothing here can: the value we are handed is not something we can verify. The
 * fix is the HMAC handshake (PLAN §7.1, separately scheduled) — that is what makes `uid` mean
 * anything at all. Until it lands, this row is exactly as trustworthy as the handoff, and the
 * observability below is what makes an abuse visible after the fact.
 *
 * ── observability ──────────────────────────────────────────────────────────────────────────
 * Every create and every overwrite is logged with a FINGERPRINT (never the credential): a
 * truncated SHA-256, which is enough to prove end-to-end that the token an MCP call used is this
 * employee's current one (PLAN §6, 归因可观测) and useless to anyone who reads the log. The write
 * happens even when the value is unchanged — that is what moves `last_seen_at` (migrations/0008).
 */

/** Characters that could never be part of a working credential, and are not merely ugly: this same
 *  string is written into the sandbox's `.simplifly.env` as `SIMPLIFLY_AUTH_TOKEN=<token>\n`
 *  (worker/seed.ts), where a newline injects further env lines.
 *
 *  A sanity bound on the REQUEST (worker/app.ts), deliberately NOT an intake policy: it has no
 *  opinion about the value, it rejects only what cannot have worked in the first place, and it is
 *  not what decides whether a credential is stored — whatever reaches the store is stored. */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/

export function isWellFormedCredential(token: string): boolean {
  return token.length > 0 && !CONTROL_CHARACTERS.test(token)
}

/** What happened to the row. Only `store_unavailable` is a failure — the other three are the write
 *  landing, described for the audit line. */
export type IntakeOutcome = 'created' | 'rotated' | 'unchanged' | 'store_unavailable'

/** Truncated SHA-256 (shared digest, first 6 bytes). Correlates a credential
 *  across log lines and hops; reveals nothing. */
export async function credentialFingerprint(token: string): Promise<string> {
  return (await sha256Hex(token)).slice(0, 12)
}

/** The two Store methods this module needs — so tests (and any future driver) need no D1. */
export interface CredentialStore {
  getTenantCredential(userEmail: string): Promise<string | undefined>
  saveTenantCredential(userEmail: string, token: string): Promise<void>
}

/**
 * Overwrite this tenant's credential, with an audit line on everything except the boring case.
 *
 * Never throws: a storage failure is reported as `store_unavailable` (and logged loudly) rather
 * than failing the employee's request. The token endpoint is where that has to be visible, and it
 * probes the store itself before answering "this actor has no credential" — see server/oauth.ts.
 */
export async function persistTenantCredential(
  store: CredentialStore,
  tenant: string,
  incoming: string,
): Promise<IntakeOutcome> {
  // Read first — ONLY to describe the write (created vs overwrote what), and to keep the
  // unchanged case quiet. Nothing about this value can prevent the write below.
  let stored: string | undefined
  try {
    stored = await store.getTenantCredential(tenant)
  } catch (e) {
    console.log(`[credential] STORE UNAVAILABLE (read) tenant=${tenant} error=${(e as Error).message}`)
    return 'store_unavailable'
  }

  try {
    // Written even when unchanged: that is what moves `last_seen_at` (migrations/0008) and turns
    // an abandoned tenant row into a distinguishable one.
    await store.saveTenantCredential(tenant, incoming)
  } catch (e) {
    console.log(`[credential] STORE UNAVAILABLE (write) tenant=${tenant} error=${(e as Error).message}`)
    return 'store_unavailable'
  }

  const outcome: IntakeOutcome = stored === undefined ? 'created' : stored === incoming ? 'unchanged' : 'rotated'
  if (outcome !== 'unchanged') {
    const [incomingFp, storedFp] = await Promise.all([
      credentialFingerprint(incoming),
      stored === undefined ? Promise.resolve('none') : credentialFingerprint(stored),
    ])
    // Nothing refuses an overwrite, so this line is the entire trace of one: it is what makes a
    // legitimate re-login and an unsigned-handoff poisoning tell apart after the fact.
    console.log(`[credential] ${outcome} tenant=${tenant} cred=${incomingFp} previous=${storedFp}`)
  }
  return outcome
}
