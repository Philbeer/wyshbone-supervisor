-- Migration: Add idempotency_key column to tower_judgements
-- Goal 4: Deduplicate Tower judgement persistence by idempotency_key

ALTER TABLE tower_judgements
ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE INDEX IF NOT EXISTS tower_judgements_idempotency_key_idx
ON tower_judgements (idempotency_key);
