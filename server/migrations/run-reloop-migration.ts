/**
 * Re-loop loop_state Migration Script
 *
 * Creates the loop_state table in Supabase for persisting re-loop chain state.
 *
 * Usage:  npx tsx server/migrations/run-reloop-migration.ts
 *
 * Requires: SUPABASE_DATABASE_URL environment variable
 */

import { config } from 'dotenv';
config();

const SEP = '='.repeat(60);

function fatal(msg: string): never {
  console.error(`\n${SEP}`);
  console.error(`[run-reloop-migration] FATAL: ${msg}`);
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
console.log('[run-reloop-migration] Re-loop loop_state Migration');
console.log(SEP);
console.log(`  Target: ${redactUrl(dbUrl)}`);
console.log(`  Host:   ${host}`);
console.log(`  Guard:  ${isSupabaseHost ? 'host contains "supabase"' : 'CONFIRM_SUPABASE_MIGRATE=true'}`);
console.log('');

const migrations: Array<{ name: string; sql: string }> = [
  {
    name: 'loop_state',
    sql: `
      CREATE TABLE IF NOT EXISTS loop_state (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chain_id UUID NOT NULL,
        run_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        loop_number INTEGER NOT NULL,
        executor_type TEXT NOT NULL,
        planner_decision JSONB NOT NULL DEFAULT '{}',
        executor_output_summary JSONB NOT NULL DEFAULT '{}',
        judge_verdict JSONB NOT NULL DEFAULT '{}',
        gate_decision JSONB NOT NULL DEFAULT '{}',
        entities_found_this_loop INTEGER NOT NULL DEFAULT 0,
        entities_accumulated_total INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_loop_state_chain_id ON loop_state(chain_id);
      CREATE INDEX IF NOT EXISTS idx_loop_state_run_id ON loop_state(run_id);
      CREATE INDEX IF NOT EXISTS idx_loop_state_user_id ON loop_state(user_id);
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
    console.log('[run-reloop-migration] All migrations applied successfully.');
    console.log(SEP);
  } catch (err: any) {
    console.error('');
    console.error(`[run-reloop-migration] Migration failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
