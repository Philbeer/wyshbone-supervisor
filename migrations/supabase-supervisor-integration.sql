-- Supervisor Chat Integration Migration
-- Run this in your Supabase SQL Editor

-- 1. Extend messages table to support Supervisor messages
ALTER TABLE messages 
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'ui',
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Add index for filtering by source
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);

-- 2. Create supervisor_tasks queue table
CREATE TABLE IF NOT EXISTS supervisor_tasks (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  conversation_id VARCHAR NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id VARCHAR NOT NULL,
  task_type VARCHAR NOT NULL,
  request_data JSONB NOT NULL DEFAULT '{}',
  status VARCHAR DEFAULT 'pending',
  result JSONB,
  error TEXT,
  created_at BIGINT NOT NULL,
  processed_at BIGINT,
  CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

-- Add indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_supervisor_tasks_status ON supervisor_tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_supervisor_tasks_conversation ON supervisor_tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_supervisor_tasks_user ON supervisor_tasks(user_id);

-- Add comment for documentation
COMMENT ON TABLE supervisor_tasks IS 'Queue for UI to request Supervisor processing on conversations';
COMMENT ON COLUMN messages.source IS 'Origin of message: ui (default), supervisor, or system';
COMMENT ON COLUMN messages.metadata IS 'Additional context: capabilities, lead_ids, task references';
