-- The Ctrip price OP compared a recommended plan against, so the workbench can show it
-- next to our own total instead of making OP hold it in their head after tabbing out.
--
-- Deliberately NOT part of the flight-recommendations contract. That contract carries
-- prices we VERIFIED with the supplier; this is a number read off someone else's web
-- page. Mixing the two would destroy the one distinction downstream code relies on —
-- which figure is safe to book against. So it lives in its own table, joined in at the
-- view layer only, and the skill/MCP payload is untouched.
--
-- Keyed by (user_email, task_id, plan_id): one current comparison per plan per tenant.
-- Re-comparing overwrites — the last look is the only one that matters for the decision,
-- and OTA prices move, so keeping history would just accumulate stale numbers nobody
-- may act on. `source` records whether OP typed it or the browser extension captured it,
-- because those two have different trust and different failure modes.
--
-- `raw_json` keeps the extension's full extraction payload (strategy, per-flight rows,
-- blocked/degraded flags). It is evidence for "why did this number appear", not data the
-- UI reads — when the extractor degrades we must be able to tell after the fact.

CREATE TABLE IF NOT EXISTS reference_prices (
  user_email  TEXT NOT NULL,             -- tenant key `<org>:<uid>`, same as everywhere else
  task_id     TEXT NOT NULL,
  plan_id     TEXT NOT NULL,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL,
  source      TEXT NOT NULL,             -- 'manual' | 'ctrip-extension'
  source_url  TEXT,
  captured_at TEXT NOT NULL,
  raw_json    TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_email, task_id, plan_id)
);

-- The only read is "every comparison for this task", to hydrate the table on load.
CREATE INDEX IF NOT EXISTS idx_reference_prices_task ON reference_prices(user_email, task_id);
