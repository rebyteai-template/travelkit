-- One rebyte headless account per employee (relay POST /v1/accounts), so the MCP route
-- reaches the flight tools as THAT person: the account's own `rbk_*` key both submits the
-- task and registers the connector, and the connector carries that employee's current
-- Simplifly credential. Replaces the delegated-credential exchange (PLAN §12).
--
-- `api_key` is the account's relay key. It is a live credential and this row is its only
-- copy — the relay returns it exactly once, at creation. Losing the row means the account
-- is stranded (unreachable, un-deletable from here), which is why nothing ever overwrites
-- it in place: a re-provision writes a NEW row for a NEW account.
--
-- `registered_credential_fp` is the FINGERPRINT (never the value) of the Simplifly
-- credential last pushed into the connector registration. Comparing it against the current
-- credential's fingerprint is what makes rotation a no-op in the common case and exactly
-- one re-registration after a re-login — without it we would either re-register on every
-- single task (a needless probe of the MCP server each time) or never (stale token, and the
-- employee stuck at 401020 with no way out).
CREATE TABLE IF NOT EXISTS employee_accounts (
  user_email               TEXT PRIMARY KEY,
  account_id               TEXT NOT NULL,
  api_key                  TEXT NOT NULL,
  registered_credential_fp TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
