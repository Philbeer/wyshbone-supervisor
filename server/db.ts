/**
 * Database Connection Module — Supabase-only
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  SOURCE OF TRUTH: Supabase PostgreSQL (SUPABASE_DATABASE_URL)  │
 * │                                                                │
 * │  The Replit-provisioned DATABASE_URL is a local dev database   │
 * │  used only by drizzle-kit for diffing.  It must NEVER receive  │
 * │  production schema, data, or migrations.  All persistent       │
 * │  tables (artefacts, agent_runs, tower_judgements, etc.) live    │
 * │  exclusively in Supabase.                                      │
 * │                                                                │
 * │  To apply migrations: npm run db:migrate:supabase              │
 * │  NEVER use: drizzle-kit push for real schema changes           │
 * └─────────────────────────────────────────────────────────────────┘
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

// ── Runtime host logging ─────────────────────────────────────────────
const hostMatch = dbUrl.match(/@([^:/]+)/);
const dbHost = hostMatch?.[1] ?? 'unknown';
console.log(`[DB] Using PostgreSQL (Neon) — Supabase-only mode`);
console.log(`[DB] Active host: ${dbHost}`);

if (!dbHost.toLowerCase().includes('supabase')) {
  console.warn('[DB] WARNING: DB host does not contain "supabase". Verify SUPABASE_DATABASE_URL is correct.');
}

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
