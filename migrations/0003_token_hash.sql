-- Token hot-refresh: remember a hash of the travelkit token last written into each user's
-- sandbox. On re-login the token rotates; when the incoming token's hash differs we rewrite
-- the sandbox's .mcp.json in place (same VM) instead of reprovisioning. Storing the HASH (not
-- the token) keeps the credential out of the DB at rest.

ALTER TABLE agent_computers ADD COLUMN token_hash TEXT;
