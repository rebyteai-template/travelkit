-- Observability for the delegated-credential flow (mcp/docs/PLAN-delegated-credentials.md §6,
-- gate 归因可观测). 0007 gave `updated_at`, but the write is a guarded upsert: the column only
-- moves when the token VALUE changes, so it answers "when did this employee last re-login",
-- never "is this tenant still alive". Those are different questions and an abandoned row was
-- indistinguishable from a live one.
--
-- `last_seen_at` is bumped on EVERY accepted intake (rotation or not), so:
--   updated_at   = last rotation   (token value changed)
--   last_seen_at = last handoff    (this tenant is still using TripDesk)
--
-- SQLite cannot ADD COLUMN with a non-constant default (`datetime('now')`), hence the nullable
-- column + backfill. Existing rows inherit updated_at, which is the best evidence we have.
ALTER TABLE tenant_credentials ADD COLUMN last_seen_at TEXT;
UPDATE tenant_credentials SET last_seen_at = updated_at WHERE last_seen_at IS NULL;
