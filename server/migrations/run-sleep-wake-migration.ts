/**
 * Sleep/Wake Goals Migration Script
 *
 * Enhances the scheduled_monitors table with columns needed for sleep/wake
 * scheduling, delta detection, and nudge message routing.
 *
 * Usage:  npx tsx server/migrations/run-sleep-wake-migration.ts
 *
 * Requires: SUPABASE_DATABASE_URL environment variable
 */

import { config } from 'dotenv';
config();

const SEP = '='.repeat(60);

function fatal(msg: string): never {
  console.error(`\n${SEP}`);
  console.error(`[run-sleep-wake-migration] FATAL: ${msg}`);
  console.error(SEP);
  process.exit(1);
}

function redactUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

const dbUrl = process.env.SUPABASE_DATABASE_URL;
if (!dbUrl) {
  fatal('SUPABASE_DATABASE_URL is not set. Cannot proceed.');
}

const hostMatch = dbUrl.match(/@([^:/]+)/);
const host = hostMatch?.[1] ?? '';
const isSupabaseHost = host.toLowerCase().includes('supabase');
const confirmOverride = process.env.CONFIRM_SUPABASE_MIGRATE === 'true';

if (!isSupabaseHost && !confirmOverride) {
  fatal(
    `DB host "${host}" does not contain "supabase".\n` +
    `  If you are sure this is correct, set CONFIRM_SUPABASE_MIGRATE=true.\n` +
    `  This guard prevents accidentally running prod migrations against the wrong database.`,
  );
}

console.log(`\n${SEP}`);
console.log('[run-sleep-wake-migration] Sleep/Wake Goals Migration');
console.log(SEP);
console.log(`  Target: ${redactUrl(dbUrl)}`);
console.log(`  Host:   ${host}`);
console.log(`  Guard:  ${isSupabaseHost ? 'host contains "supabase"' : 'CONFIRM_SUPABASE_MIGRATE=true'}`);
console.log('');

const migrations: Array<{ name: string; sql: string }> = [
  {
    name: 'scheduled_monitors_sleep_wake_columns',
    sql: `
      ALTER TABLE scheduled_monitors
        ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS next_wake_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_run_id TEXT,
        ADD COLUMN IF NOT EXISTS baseline_entity_names JSONB DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS consecutive_empty_wakes INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS conversation_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_scheduled_monitors_next_wake ON scheduled_monitors(next_wake_at) WHERE is_active = true;

      -- Backfill next_wake_at for existing monitors
      UPDATE scheduled_monitors
      SET next_wake_at = CASE
        WHEN schedule_type = 'daily' THEN created_at + INTERVAL '24 hours'
        WHEN schedule_type = 'weekly' THEN created_at + INTERVAL '7 days'
        WHEN schedule_type = 'hourly' THEN created_at + INTERVAL '1 hour'
        ELSE created_at + INTERVAL '24 hours'
      END
      WHERE next_wake_at IS NULL AND is_active = true;
    `,
  },
];

async function run() {
  const { Pool } = await import('@neondatabase/serverless');
  const ws = (await import('ws')).default;
  const { neonConfig } = await import('@neondatabase/serverless');

  neonConfig.webSocketConstructor = ws;

  const pool = new Pool({ connectionString: dbUrl });

  try {
    for (const m of migrations) {
      console.log(`  Running: ${m.name} ...`);
      await pool.query(m.sql);
      console.log(`  Done:    ${m.name}`);
    }

    console.log('');
    console.log('[run-sleep-wake-migration] All migrations applied successfully.');
    console.log(SEP);
  } catch (err: any) {
    console.error('');
    console.error(`[run-sleep-wake-migration] Migration failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
