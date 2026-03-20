CREATE TABLE IF NOT EXISTS run_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id text NOT NULL,
  timestamp timestamptz DEFAULT now(),
  query_text text,
  stage text NOT NULL,
  level text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_run_logs_timestamp ON run_logs(timestamp DESC);
