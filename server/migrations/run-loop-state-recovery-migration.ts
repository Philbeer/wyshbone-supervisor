/**
 * Loop State Recovery Migration Script
 *
 * Adds crash-recovery columns to the loop_state table:
 *   - executor_completed: whether the executor finished before a crash
 *   - accumulated_entities: full entity map at each loop boundary (for in-memory recovery)
 *   - executor_output_full: complete ExecutorOutput so the judge can re-run without re-running the executor
 *
 * Usage:  npx tsx server/migrations/run-loop-state-recovery-migration.ts
 *
 * Requires: SUPABASE_DATABASE_URL environment variable
 */

import { config } from 'dotenv';
config();

const SEP = '='.repeat(60);

function fatal(msg: string): never {
  console.error(`\n${SEP}`);
  console.error(`[run-loop-state-recovery-migration] FATAL: ${msg}`);
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
console.log('[run-loop-state-recovery-migration] Loop State Recovery Migration');
console.log(SEP);
console.log(`  Target: ${redactUrl(dbUrl)}`);
console.log(`  Host:   ${host}`);
console.log(`  Guard:  ${isSupabaseHost ? 'host contains "supabase"' : 'CONFIRM_SUPABASE_MIGRATE=true'}`);
console.log('');

const migrations: Array<{ name: string; sql: string }> = [
  {
    name: 'loop_state_recovery_columns',
    sql: `
      ALTER TABLE loop_state ADD COLUMN IF NOT EXISTS executor_completed BOOLEAN DEFAULT FALSE;
      ALTER TABLE loop_state ADD COLUMN IF NOT EXISTS accumulated_entities JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE loop_state ADD COLUMN IF NOT EXISTS executor_output_full JSONB DEFAULT '{}'::jsonb;
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
    console.log('[run-loop-state-recovery-migration] All migrations applied successfully.');
    console.log(SEP);
  } catch (err: any) {
    console.error('');
    console.error(`[run-loop-state-recovery-migration] Migration failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
