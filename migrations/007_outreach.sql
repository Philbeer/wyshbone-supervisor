-- 007_outreach.sql
-- Outreach executor tables: user config + message tracking

CREATE TABLE IF NOT EXISTS outreach_config (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  handle TEXT NOT NULL UNIQUE,
  sending_domain TEXT NOT NULL DEFAULT 'outreach.wyshbone.com',
  custom_domain TEXT,
  custom_domain_verified BOOLEAN NOT NULL DEFAULT false,
  reply_to_domain TEXT NOT NULL DEFAULT 'inbound.wyshbone.com',
  signature_text TEXT,
  user_real_email TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_config_user_id ON outreach_config(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_config_handle ON outreach_config(handle);

CREATE TABLE IF NOT EXISTS outreach_messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  lead_name TEXT NOT NULL,
  lead_place_id TEXT,
  recipient_email TEXT,
  recipient_name TEXT,
  recipient_role TEXT,
  from_address TEXT NOT NULL,
  reply_to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  resend_message_id TEXT,
  resend_status TEXT,
  reply_received_at TIMESTAMPTZ,
  reply_from TEXT,
  reply_subject TEXT,
  reply_body_text TEXT,
  reply_body_html TEXT,
  draft_model TEXT DEFAULT 'gpt-4o-mini',
  draft_context JSONB,
  approval_notes TEXT,
  drafted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  bounced_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_messages_run_id ON outreach_messages(run_id);
CREATE INDEX IF NOT EXISTS idx_outreach_messages_user_id ON outreach_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_outreach_messages_status ON outreach_messages(status);
CREATE INDEX IF NOT EXISTS idx_outreach_messages_reply_to ON outreach_messages(reply_to_address);
CREATE INDEX IF NOT EXISTS idx_outreach_messages_resend_id ON outreach_messages(resend_message_id);
