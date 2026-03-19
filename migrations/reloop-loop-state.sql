CREATE TABLE IF NOT EXISTS loop_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id UUID NOT NULL,
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  loop_number INTEGER NOT NULL,
  executor_type TEXT NOT NULL,
  planner_decision JSONB NOT NULL DEFAULT '{}',
  executor_output_summary JSONB NOT NULL DEFAULT '{}',
  judge_verdict JSONB NOT NULL DEFAULT '{}',
  gate_decision JSONB NOT NULL DEFAULT '{}',
  entities_found_this_loop INTEGER NOT NULL DEFAULT 0,
  entities_accumulated_total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_loop_state_chain_id ON loop_state(chain_id);
CREATE INDEX IF NOT EXISTS idx_loop_state_run_id ON loop_state(run_id);
CREATE INDEX IF NOT EXISTS idx_loop_state_user_id ON loop_state(user_id);
