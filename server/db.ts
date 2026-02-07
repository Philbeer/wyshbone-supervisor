/**
 * Database Connection Module — Supabase-only
 *
 * GUARD: This application MUST connect to the Supabase-hosted PostgreSQL
 * database via SUPABASE_DATABASE_URL.  No fallback to DATABASE_URL, no
 * mock mode, no SQLite.  If the variable is missing the process crashes
 * immediately so misconfigurations are caught at deploy time, not at
 * runtime when a query silently returns nothing.
 */

import { config } from 'dotenv';

config();

// ── Supabase-only guard ──────────────────────────────────────────────
// Do NOT add a DATABASE_URL fallback here.  Every environment (dev,
// staging, production) must set SUPABASE_DATABASE_URL to the Supabase
// connection string.  This keeps agent_runs, agent_activities and all
// other tables in one canonical store.
const dbUrl = process.env.SUPABASE_DATABASE_URL;

if (!dbUrl) {
  console.error('');
  console.error('='.repeat(60));
  console.error('[DB] FATAL: SUPABASE_DATABASE_URL is not set.');
  console.error('[DB] This application requires a Supabase PostgreSQL');
  console.error('[DB] connection.  No fallback (DATABASE_URL, SQLite,');
  console.error('[DB] or mock mode) is permitted.');
  console.error('[DB] Set SUPABASE_DATABASE_URL in your environment or');
  console.error('[DB] Replit Secrets and restart.');
  console.error('='.repeat(60));
  console.error('');
  process.exit(1);
}

// ── PostgreSQL via Neon serverless driver ─────────────────────────────
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from '@shared/schema';

neonConfig.webSocketConstructor = ws;

console.log('[DB] Using PostgreSQL (Neon) — Supabase-only mode');

const pool = new Pool({ connectionString: dbUrl });
const db = drizzle({ client: pool, schema });

console.log('[DB] Connected to PostgreSQL');

export { db, pool };

export function isMockDb(): boolean {
  return false;
}

export type {
  User,
  InsertUser,
  SuggestedLead,
  InsertSuggestedLead,
  UserSignal,
  InsertUserSignal,
  PlanExecution,
  InsertPlanExecution,
  Plan,
  InsertPlan,
  SubconsciousNudge,
  InsertSubconsciousNudge,
} from '@shared/schema';
