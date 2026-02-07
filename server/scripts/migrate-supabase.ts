/**
 * Supabase Database Migration Script
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  SOURCE OF TRUTH: Supabase PostgreSQL (SUPABASE_DATABASE_URL)  │
 * │                                                                │
 * │  This script is the ONLY sanctioned way to apply schema        │
 * │  changes to the production database.  The Replit-provisioned   │
 * │  DATABASE_URL is a local dev database used by drizzle-kit for  │
 * │  diffing and must NEVER receive production schema.             │
 * │                                                                │
 * │  Usage:  npm run db:migrate:supabase                           │
 * │  NEVER:  drizzle-kit push for real schema changes              │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Runs migrations against the SUPABASE_DATABASE_URL database.
 * This is intentionally separate from the local dev DB flow.
 *
 * Safety guards:
 *   - Requires SUPABASE_DATABASE_URL to be set
 *   - DB host must contain "supabase" OR CONFIRM_SUPABASE_MIGRATE=true must be set
 *   - Prints connection info (redacted) before proceeding
 */

import { config } from 'dotenv';
config();

const SEP = '='.repeat(60);

function fatal(msg: string): never {
  console.error(`\n${SEP}`);
  console.error(`[migrate:supabase] FATAL: ${msg}`);
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
    `  This guard prevents accidentally running prod migrations against the wrong database.`
  );
}

console.log(`\n${SEP}`);
console.log('[migrate:supabase] Supabase Database Migration');
console.log(SEP);
console.log(`  Target: ${redactUrl(dbUrl)}`);
console.log(`  Host:   ${host}`);
console.log(`  Guard:  ${isSupabaseHost ? 'host contains "supabase"' : 'CONFIRM_SUPABASE_MIGRATE=true'}`);
console.log('');

const migrations: Array<{ name: string; sql: string }> = [
  {
    name: 'artefacts',
    sql: `
      CREATE TABLE IF NOT EXISTS artefacts (
        id         VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id     VARCHAR NOT NULL,
        type       TEXT    NOT NULL,
        title      TEXT    NOT NULL,
        summary    TEXT,
        payload_json JSONB,
        created_at TIMESTAMP DEFAULT now() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artefacts_run_id_idx ON artefacts(run_id);
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
    console.log('[migrate:supabase] All migrations applied successfully.');
    console.log(SEP);
  } catch (err: any) {
    console.error('');
    console.error(`[migrate:supabase] Migration failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
