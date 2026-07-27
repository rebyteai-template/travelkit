-- Durable delegated-subprompt replay.
--
-- Parent agent-loop events carry a stable subPromptId, while the structured
-- flight tool results live in that delegated prompt. Persist both the replay
-- cursor and each source event's identity so live polling and historical
-- recovery converge without duplicating frames after retries or reloads.

ALTER TABLE frames ADD COLUMN source_sub_prompt_id TEXT;
ALTER TABLE frames ADD COLUMN source_event_index INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_frames_subprompt_source
  ON frames(prompt_id, source_sub_prompt_id, source_event_index)
  WHERE source_sub_prompt_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS prompt_subprompts (
  prompt_id        TEXT    NOT NULL,
  sub_prompt_id    TEXT    NOT NULL,
  next_event_index INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (prompt_id, sub_prompt_id)
);
CREATE INDEX IF NOT EXISTS idx_prompt_subprompts_prompt
  ON prompt_subprompts(prompt_id);
