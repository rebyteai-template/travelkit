/**
 * One rebyte headless account per employee, and that account's flight-MCP connector.
 *
 * The MCP route reaches the flight tools as THAT person: the account's own `rbk_*` key
 * submits the task, and the connector registered under it names them in a header the relay
 * injects on every call.
 *
 * WHAT THE REGISTRATION CARRIES — and, more importantly, what it does not. The secret is a
 * shared SERVICE token (it only proves "our relay is calling"); the employee's identity is
 * a registered header. Their Simplifly credential is NOT here: the MCP server fetches it
 * from us per call, keyed on that header (PLAN §12.5).
 *
 * That is the whole point. A Simplifly credential has no `exp` and rotates on re-login, so
 * storing a copy in the relay makes every rotation a PUSH that somebody has to get right —
 * and a rotation mid-task leaves the connector holding a dead token and the employee stuck
 * at 401020. Fetching per call has no such window: there is only ever one copy, ours, and
 * it is always the current one.
 *
 * Two facts still drive the rest:
 *
 *   1. The relay returns an account's API key EXACTLY ONCE, at creation. Our row is its
 *      only copy, so provisioning is write-once: a concurrent second provision abandons
 *      its own account rather than overwrite the recorded one (store.saveEmployeeAccount).
 *   2. Registration probes the MCP server, so it must not run per task. The fingerprint
 *      stamp records what the connector was last given; identical → do nothing. Since that
 *      value is now the service token, a re-registration happens only when the SERVICE
 *      token is rotated — which is exactly when it should.
 *
 * Ordering is deliberate: the account is recorded BEFORE the connector is registered. The
 * reverse would risk a registration against an account whose key we then failed to store —
 * unreachable and unrecoverable. A recorded account with no connector self-heals on the
 * next turn.
 */
import { rebyteJSON, type RebyteConfig } from './client.ts'
import { credentialFingerprint } from '../tenant-credential.ts'
import type { EmployeeAccount, Store } from '../store.ts'

/** The header the MCP server reads the tenant off in passthrough mode. Registered into the
 *  connector (server-side, at registration) rather than passed per call, so it is not
 *  something a model or a prompt can influence. Must match the resource server's
 *  PASSTHROUGH_TENANT_HEADER byte for byte. */
const TENANT_HEADER = 'X-Tripdesk-Tenant'

export interface EmployeeMcpAccess {
  /** The account's relay key — submit this employee's tasks with it. */
  apiKey: string
  accountId: string
}

/** Relay's create-account response (POST /v1/accounts). */
interface CreatedAccount {
  id: string
  api_key: string
}

/**
 * Ensure this employee has an account whose flight connector names them, and return the
 * key their tasks should be submitted with.
 *
 * `serviceToken` is the SHARED secret the MCP server accepts (its MCP_TOKENS) — it proves
 * the caller is our relay and nothing more. The employee's own credential never travels
 * this path; the MCP server asks us for it per call.
 */
export async function ensureEmployeeMcpAccess(
  store: Store,
  config: RebyteConfig,
  input: { tenant: string; serviceToken: string; mcpUrl: string },
): Promise<EmployeeMcpAccess> {
  let account = await store.getEmployeeAccount(input.tenant)
  if (!account) {
    account = await provisionAccount(store, config, input.tenant)
  }

  // Fingerprint of what the connector was last given. Registration probes the MCP server,
  // so this is what keeps it off the per-task path; it also means rotating the service
  // token re-registers everyone automatically, on their next turn.
  const fingerprint = await credentialFingerprint(input.serviceToken)
  if (account.registeredCredentialFp !== fingerprint) {
    await registerFlightConnector(
      { apiUrl: config.apiUrl, apiKey: account.apiKey },
      { tenant: input.tenant, serviceToken: input.serviceToken, mcpUrl: input.mcpUrl },
    )
    await store.setRegisteredCredentialFingerprint(input.tenant, fingerprint)
    console.log(
      `[employee-account] connector registered tenant=${input.tenant} account=${account.accountId} svc=${fingerprint}`,
    )
  }

  return { apiKey: account.apiKey, accountId: account.accountId }
}

/**
 * Create the account with the PARTNER key, record it, and read it back.
 *
 * Reads back through the store rather than returning what we just created: on the losing
 * side of a concurrent provision the INSERT is ignored, and the caller must go on to use
 * the account that actually got recorded — not the orphan it created.
 */
async function provisionAccount(
  store: Store,
  config: RebyteConfig,
  tenant: string,
): Promise<EmployeeAccount> {
  const created = await rebyteJSON<CreatedAccount>('/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: `tripdesk:${tenant}` }),
    config,
  })
  if (!created?.id || !created?.api_key) {
    throw new Error('relay POST /v1/accounts returned no account')
  }
  await store.saveEmployeeAccount(tenant, created.id, created.api_key)
  const recorded = await store.getEmployeeAccount(tenant)
  if (!recorded) {
    // The row we just wrote is gone: the store is broken, and continuing would use a key
    // nothing has persisted — the account would be unreachable forever after this turn.
    throw new Error(`employee account for ${tenant} could not be recorded`)
  }
  if (recorded.accountId !== created.id) {
    console.log(
      `[employee-account] concurrent provision tenant=${tenant} kept=${recorded.accountId} abandoned=${created.id}`,
    )
  } else {
    console.log(`[employee-account] provisioned tenant=${tenant} account=${created.id}`)
  }
  return recorded
}

/**
 * Register (or re-register) the flight MCP connector under the EMPLOYEE's account, using
 * that account's own key. Idempotent on (account, url), so a rotation is the same call.
 *
 * The relay attaches it to the account's default Agent Profile, which is what every
 * task's fresh workspace inherits its connectors from — without that step the
 * registration succeeds and the agent still sees no tools.
 */
async function registerFlightConnector(
  accountConfig: RebyteConfig,
  input: { tenant: string; serviceToken: string; mcpUrl: string },
): Promise<void> {
  await rebyteJSON('/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({
      url: input.mcpUrl,
      // Proves the caller is our relay. Deliberately NOT the employee's credential: that
      // one would then live in the relay and go stale on every re-login.
      sharedSecret: input.serviceToken,
      // Who this is. Stored WITH the registration, so every tool call carries it without
      // anyone passing it along — and so no prompt or tool argument can influence it. The
      // MCP server keys both its tenant isolation and its credential lookup on this.
      customHeaders: [{ key: TENANT_HEADER, value: input.tenant }],
    }),
    config: accountConfig,
  })
}
