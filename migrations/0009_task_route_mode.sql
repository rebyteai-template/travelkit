-- Which route created this session: '' = sandbox VM + skill (default), 'mcp' = manager
-- calls the flight MCP tools directly (no VM). Stamped ONCE at task creation from the
-- global debug config — the config is "next new session" semantics, so per-session truth
-- must live on the task row, not be re-read from config (which may have flipped since).
-- Read by task-do's first-turn branch and by the UI booking gate (mcp sessions cannot
-- book until the batch-2 transaction tools land).
ALTER TABLE tasks ADD COLUMN route_mode TEXT NOT NULL DEFAULT '';
