CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id uuid PRIMARY KEY,
  summary text NOT NULL,
  last_summarized_message_count integer NOT NULL DEFAULT 0,
  last_summarized_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_summaries_updated
  ON conversation_summaries (last_summarized_at DESC);
