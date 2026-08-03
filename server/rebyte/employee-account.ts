/**
 * One rebyte headless account per employee, and that account's flight-MCP connector.
 *
 * The MCP route reaches the flight tools as THAT person: the account's own `rbk_*` key
 * submits the task, and the connector registered under it carries that employee's current
 * Simplifly credential. Nothing is exchanged at call time (PLAN §12) — the MCP server runs
 * in `passthrough` mode and uses the Bearer it is handed.
 *
 * Two facts drive everything here:
 *
 *   1. The relay returns an account's API key EXACTLY ONCE, at creation. Our row is its
 *      only copy, so provisioning is write-once: a concurrent second provision abandons
 *      its own account rather than overwrite the recorded one (store.saveEmployeeAccount).
 *   2. A Simplifly credential has no `exp` and rotates on re-login. The registration is a
 *      PUSH, so a rotation we fail to push leaves the connector holding a dead token and
 *      the employee stuck at 401020. Hence the fingerprint stamp: re-register exactly when
 *      the credential differs from what the connector was last given, and never otherwise
 *      (each registration probes the MCP server, so doing it per task would be a real cost).
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
 * Ensure this employee has an account whose flight connector carries their CURRENT
 * credential, and return the key their tasks should be submitted with.
 *
 * `credential` is the employee's current Simplifly token (the same value
 * /internal/simplifly-credential would serve). It is sent to the relay as the connector's
 * shared secret and stored there encrypted; it is never written to our own tables and
 * never logged — only its fingerprint is.
 */
export async function ensureEmployeeMcpAccess(
  store: Store,
  config: RebyteConfig,
  input: { tenant: string; credential: string; mcpUrl: string },
): Promise<EmployeeMcpAccess> {
  let account = await store.getEmployeeAccount(input.tenant)
  if (!account) {
    account = await provisionAccount(store, config, input.tenant)
  }

  const fingerprint = await credentialFingerprint(input.credential)
  if (account.registeredCredentialFp !== fingerprint) {
    await registerFlightConnector(
      { apiUrl: config.apiUrl, apiKey: account.apiKey },
      { tenant: input.tenant, credential: input.credential, mcpUrl: input.mcpUrl },
    )
    await store.setRegisteredCredentialFingerprint(input.tenant, fingerprint)
    console.log(
      `[employee-account] connector registered tenant=${input.tenant} account=${account.accountId} cred=${fingerprint}`,
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
  input: { tenant: string; credential: string; mcpUrl: string },
): Promise<void> {
  await rebyteJSON('/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({
      url: input.mcpUrl,
      // The employee's own credential. The MCP server presents it to Simplifly verbatim.
      sharedSecret: input.credential,
      // Who this is, for the resource server's tenant isolation. Stored with the
      // registration, so every tool call carries it without anyone passing it along.
      customHeaders: [{ key: TENANT_HEADER, value: input.tenant }],
    }),
    config: accountConfig,
  })
}
