-- Agent Activities Table Migration
-- Run this in your Supabase SQL Editor

-- Create agent_activities table for tracking autonomous agent decisions and actions
CREATE TABLE IF NOT EXISTS agent_activities (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id VARCHAR NOT NULL,
  agent_type VARCHAR NOT NULL DEFAULT 'goal_generator',
  activity_type VARCHAR NOT NULL,
  input_data JSONB DEFAULT '{}',
  output_data JSONB DEFAULT '{}',
  status VARCHAR DEFAULT 'pending',
  metadata JSONB DEFAULT '{}',
  created_at BIGINT NOT NULL,
  completed_at BIGINT,
  error TEXT,
  CONSTRAINT valid_activity_status CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'partial')),
  CONSTRAINT valid_agent_type CHECK (agent_type IN ('goal_generator', 'task_executor', 'monitor', 'planner')),
  CONSTRAINT valid_activity_type CHECK (activity_type IN ('generate_tasks', 'execute_task', 'generate_and_execute', 'daily_cron', 'monitor_goals', 'plan_day', 'send_notification'))
);

-- Add indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_agent_activities_user ON agent_activities(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activities_status ON agent_activities(status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_activities_type ON agent_activities(agent_type, activity_type);
CREATE INDEX IF NOT EXISTS idx_agent_activities_user_type ON agent_activities(user_id, agent_type, created_at DESC);

-- Add comments for documentation
COMMENT ON TABLE agent_activities IS 'Tracks autonomous agent activities, decisions, and generated tasks';
COMMENT ON COLUMN agent_activities.agent_type IS 'Type of agent: goal_generator, task_executor, monitor, planner';
COMMENT ON COLUMN agent_activities.activity_type IS 'Type of activity: generate_tasks, execute_task, monitor_goals, plan_day, send_notification';
COMMENT ON COLUMN agent_activities.input_data IS 'Input data used by agent (e.g., user goals, context)';
COMMENT ON COLUMN agent_activities.output_data IS 'Agent output (e.g., generated tasks, results)';
COMMENT ON COLUMN agent_activities.metadata IS 'Additional context: model_used, token_count, duration_ms, etc.';

-- Create view for daily task summaries
CREATE OR REPLACE VIEW agent_daily_tasks AS
SELECT
  user_id,
  DATE(TO_TIMESTAMP(created_at / 1000)) as task_date,
  COUNT(*) as total_tasks,
  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_tasks,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_tasks,
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'id', id,
      'type', activity_type,
      'status', status,
      'created_at', created_at
    ) ORDER BY created_at DESC
  ) as tasks
FROM agent_activities
WHERE agent_type = 'goal_generator'
  AND activity_type = 'generate_tasks'
GROUP BY user_id, DATE(TO_TIMESTAMP(created_at / 1000));

COMMENT ON VIEW agent_daily_tasks IS 'Daily summary of agent-generated tasks per user';
