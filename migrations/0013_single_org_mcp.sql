-- Single-org MCP routing: per-employee headless accounts retire.
-- employee_accounts rows hold the only copies of per-employee rbk_ keys;
-- ops exports the table before applying in dev (prod never had rows).
DROP TABLE IF EXISTS employee_accounts;
ALTER TABLE tasks DROP COLUMN relay_auth;
-- /internal now resolves credentials by ac_id.
CREATE INDEX IF NOT EXISTS idx_agent_computers_ac ON agent_computers(ac_id);
