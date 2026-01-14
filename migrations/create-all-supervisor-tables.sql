-- Create all wyshbone-supervisor tables
-- Run this in Supabase SQL Editor or via migration script

-- user_signals table
CREATE TABLE IF NOT EXISTS user_signals (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id VARCHAR NOT NULL,
  type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- suggested_leads table
CREATE TABLE IF NOT EXISTS suggested_leads (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id VARCHAR NOT NULL,
  account_id VARCHAR,
  rationale TEXT NOT NULL,
  source TEXT NOT NULL,
  score REAL NOT NULL,
  lead JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  last_contacted_at TIMESTAMP,
  pipeline_stage TEXT,
  pipeline_stage_changed_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- processed_signals table
CREATE TABLE IF NOT EXISTS processed_signals (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  signal_id TEXT NOT NULL UNIQUE,
  signal_source TEXT NOT NULL,
  signal_created_at TIMESTAMP NOT NULL,
  processed_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- plans table
CREATE TABLE IF NOT EXISTS plans (
  id VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  account_id VARCHAR,
  status TEXT NOT NULL,
  plan_data JSONB NOT NULL,
  goal_text TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- plan_executions table
CREATE TABLE IF NOT EXISTS plan_executions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  plan_id TEXT NOT NULL,
  user_id VARCHAR NOT NULL,
  account_id VARCHAR,
  goal_id TEXT,
  goal_text TEXT,
  overall_status TEXT NOT NULL,
  started_at TIMESTAMP NOT NULL,
  finished_at TIMESTAMP NOT NULL,
  step_results JSONB NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- subconscious_nudges table
CREATE TABLE IF NOT EXISTS subconscious_nudges (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT,
  nudge_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  importance INTEGER NOT NULL,
  lead_id TEXT,
  context JSONB,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  resolved_at TIMESTAMP,
  dismissed_at TIMESTAMP
);

-- Create index for subconscious_nudges
CREATE INDEX IF NOT EXISTS subconscious_nudges_account_id_idx ON subconscious_nudges(account_id);
