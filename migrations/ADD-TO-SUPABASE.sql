-- ⚠️ IMPORTANT: Run this SQL in your Supabase SQL Editor
-- Dashboard → SQL Editor → New Query → Paste this → Run

-- Add source and metadata columns to messages table
ALTER TABLE messages 
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'ui',
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Add index for efficient filtering by source
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);

-- Verify the changes
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'messages' 
  AND column_name IN ('source', 'metadata');
