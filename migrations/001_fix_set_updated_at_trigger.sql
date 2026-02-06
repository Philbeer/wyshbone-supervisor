-- Migration: Fix set_updated_at() trigger for agent_runs table
-- Date: 2026-02-06
-- Problem: The trigger used now() which returns a timestamp, but updated_at is bigint (epoch ms)
-- This caused "invalid input syntax for type bigint" on every UPDATE to agent_runs

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
begin
  new.updated_at = (extract(epoch from now()) * 1000)::bigint;
  return new;
end;
$$ LANGUAGE plpgsql;
