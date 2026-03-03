CREATE TABLE IF NOT EXISTS learning_store (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  query_shape_key TEXT NOT NULL UNIQUE,
  default_result_count INTEGER NOT NULL DEFAULT 20,
  verification_level TEXT NOT NULL DEFAULT 'standard',
  search_budget_pages INTEGER NOT NULL DEFAULT 3,
  radius_escalation TEXT NOT NULL DEFAULT 'allowed',
  stop_if_underfilled INTEGER NOT NULL DEFAULT 0,
  field_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learning_store_query_shape_key ON learning_store(query_shape_key);
