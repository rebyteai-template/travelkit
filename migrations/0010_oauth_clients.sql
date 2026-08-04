-- Dynamically registered OAuth clients (RFC 7591), for the delegated-credential AS
-- (server/oauth.ts). Registration is CONTROLLED — the endpoint requires the
-- OAUTH_REGISTRATION_TOKEN initial access token — because in the client_credentials+actor
-- grant a client credential is the impersonation boundary: whoever holds one can request
-- an assertion for any actor. Complements (does not replace) the static integrator client
-- in Worker secrets (RELAY_CLIENT_ID / RELAY_CLIENT_SECRET).
--
-- Only a SHA-256 hex of the secret is stored; the plaintext exists exactly once, in the
-- registration response. A leaked table therefore authenticates nobody.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id          TEXT PRIMARY KEY,
  client_secret_hash TEXT NOT NULL,
  client_name        TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
