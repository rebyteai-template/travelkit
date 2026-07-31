-- The tenant's CURRENT Simplifly/travelkit credential, so the delegated-credential flow can
-- hand it to our MCP resource server (POST /internal/simplifly-credential). See
-- mcp/docs/PLAN-delegated-credentials.md §4.3.
--
-- Why the RAW token and not another hash: agent_computers.token_hash answers "did the token
-- rotate, do I have to rewrite this sandbox" — a hash is enough for that and deliberately keeps
-- the credential out of the DB. This table answers a different question, "what is this
-- employee's token RIGHT NOW", which only the value itself can answer.
--
-- Separate table, not a column on agent_computers, because the lifecycles differ: an
-- agent_computers row appears only once a sandbox has been provisioned, while the token arrives
-- on the very first request (it IS the caller's credential) and must be answerable before any VM
-- exists.
--
-- The token has NO exp and we never judge its validity — the row is overwritten on every
-- request, and a read always returns the last value received. When the employee re-logs in the
-- host re-renders the iframe with the same uid+org and a new token (INTEGRATION.md), which
-- overwrites this row on its own; there is no refresh to schedule.

CREATE TABLE IF NOT EXISTS tenant_credentials (
  user_email TEXT PRIMARY KEY,          -- tenant key `<org>:<uid>`, same as everywhere else
  token      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
