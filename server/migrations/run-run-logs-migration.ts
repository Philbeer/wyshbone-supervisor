/**
 * Migration: create run_logs table in Supabase.
 * Run with: npx tsx server/migrations/run-run-logs-migration.ts
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const statements = [
  `CREATE TABLE IF NOT EXISTS run_logs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    run_id text NOT NULL,
    timestamp timestamptz DEFAULT now(),
    query_text text,
    stage text NOT NULL,
    level text NOT NULL DEFAULT 'info',
    message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb
  )`,
  `CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_run_logs_timestamp ON run_logs(timestamp DESC)`,
];

async function run() {
  console.log('Running run_logs migration...');
  for (const sql of statements) {
    try {
      const { error } = await supabase.rpc('exec_sql', { sql: sql + ';' });
      if (error) {
        console.warn(`  RPC error (table may already exist): ${error.message}`);
      } else {
        console.log(`  OK: ${sql.substring(0, 60).replace(/\s+/g, ' ')}...`);
      }
    } catch (err: any) {
      console.warn(`  Exception: ${err.message}`);
    }
  }
  console.log('Done. If errors above, run migrations/run-logs.sql manually in the Supabase SQL editor.');
}

run().catch(console.error);
