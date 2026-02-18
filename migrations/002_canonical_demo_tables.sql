-- Migration 002: Canonical Demo Tables
-- belief_store, goal_ledger, feedback_events + agent_runs.goal_id
-- Date: 2026-02-18
-- NOTE: Uses TEXT for user_id/run_id/goal_id to match existing Drizzle schema conventions

-- ============================================================
-- 1. goal_ledger
-- ============================================================
CREATE TABLE IF NOT EXISTS goal_ledger (
  goal_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL,
  goal_text TEXT NOT NULL,
  success_criteria JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'PARTIAL', 'STOPPED', 'COMPLETE')),
  linked_run_ids TEXT[] NOT NULL DEFAULT '{}',
  stop_reason JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goal_ledger_user_id ON goal_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_goal_ledger_status ON goal_ledger(status);

-- ============================================================
-- 2. belief_store
-- ============================================================
CREATE TABLE IF NOT EXISTS belief_store (
  belief_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL,
  goal_id TEXT NULL,
  claim TEXT NOT NULL,
  confidence NUMERIC(3,2) NOT NULL DEFAULT 1.00
    CHECK (confidence >= 0 AND confidence <= 1),
  evidence_run_ids TEXT[] NOT NULL DEFAULT '{}',
  evidence JSONB NOT NULL DEFAULT '{}',
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_belief_store_run_id ON belief_store(run_id);
CREATE INDEX IF NOT EXISTS idx_belief_store_goal_id ON belief_store(goal_id);

-- ============================================================
-- 3. feedback_events
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback_events (
  event_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('accept_result', 'retry_goal', 'abandon_goal', 'export_data')),
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_events_goal_id ON feedback_events(goal_id);
CREATE INDEX IF NOT EXISTS idx_feedback_events_run_id ON feedback_events(run_id);

-- ============================================================
-- 4. Add goal_id column to agent_runs (if not already present)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_runs' AND column_name = 'goal_id'
  ) THEN
    ALTER TABLE agent_runs ADD COLUMN goal_id TEXT NULL;
    CREATE INDEX idx_agent_runs_goal_id ON agent_runs(goal_id);
  END IF;
END $$;
