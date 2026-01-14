-- Create supervisor_state table for wyshbone-supervisor
-- This table tracks the supervisor's processing checkpoints

CREATE TABLE IF NOT EXISTS supervisor_state (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source TEXT NOT NULL UNIQUE,
  last_processed_timestamp TIMESTAMP,
  last_processed_id TEXT,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Add comment for documentation
COMMENT ON TABLE supervisor_state IS 'Tracks supervisor processing checkpoints for different signal sources';
COMMENT ON COLUMN supervisor_state.source IS 'Signal source name (e.g., supabase, postgres)';
COMMENT ON COLUMN supervisor_state.last_processed_timestamp IS 'Timestamp of last processed signal';
COMMENT ON COLUMN supervisor_state.last_processed_id IS 'ID of last processed signal';
