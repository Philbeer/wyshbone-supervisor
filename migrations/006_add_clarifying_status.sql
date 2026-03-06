-- Add 'clarifying' to the agent_runs status check constraint
-- This allows runs to be in a non-terminal "awaiting user input" state

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('starting', 'planning', 'executing', 'finalizing', 'completed', 'failed', 'stopped', 'clarifying'));
