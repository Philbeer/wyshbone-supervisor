-- Learning Layer v1 tables
-- telemetry_events, policy_versions, policy_applications

CREATE TABLE IF NOT EXISTS telemetry_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_run_id ON telemetry_events(run_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_event_type ON telemetry_events(event_type);

CREATE TABLE IF NOT EXISTS policy_versions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  scope_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  policy_data JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'outcome_feedback',
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_policy_versions_scope_key ON policy_versions(scope_key);
CREATE INDEX IF NOT EXISTS idx_policy_versions_scope_version ON policy_versions(scope_key, version);

CREATE TABLE IF NOT EXISTS policy_applications (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  policy_version_id TEXT,
  applied_policies JSONB NOT NULL,
  input_snapshot JSONB NOT NULL,
  output_constraints JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_policy_applications_run_id ON policy_applications(run_id);
CREATE INDEX IF NOT EXISTS idx_policy_applications_scope_key ON policy_applications(scope_key);
