-- Multi-tenancy fix: add user_id to conversation_summaries.
-- Existing rows (pre-fix) get backfilled from the parent conversation.
-- Anything that can't be backfilled is orphaned test data and is deleted.

ALTER TABLE conversation_summaries
  ADD COLUMN IF NOT EXISTS user_id text;

-- Backfill from the parent conversation row.
UPDATE conversation_summaries cs
SET user_id = (
  SELECT c.user_id
  FROM conversations c
  WHERE c.id = cs.conversation_id::text
  LIMIT 1
)
WHERE cs.user_id IS NULL;

-- Anything still null is orphaned (no parent conversation) — delete.
DELETE FROM conversation_summaries
WHERE user_id IS NULL;

-- Lock it down so future inserts must include user_id.
ALTER TABLE conversation_summaries
  ALTER COLUMN user_id SET NOT NULL;

-- Index for the new filter we'll add to reads.
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_user
  ON conversation_summaries (user_id);
