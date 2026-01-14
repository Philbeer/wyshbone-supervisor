/**
 * Database Migration Script (Development)
 * 
 * Creates SQLite tables for local development.
 * Run with: npm run db:migrate
 * 
 * Note: This requires better-sqlite3 which needs native compilation.
 * If this fails on Windows, you can skip the database and run in mock mode.
 */

import { config } from 'dotenv';
config();

console.log('='.repeat(60));
console.log('[Migrate] SQLite Dev Database Migration');
console.log('='.repeat(60));

const dbUrl = process.env.DATABASE_URL || 'file:./dev.db';
const dbPath = dbUrl.replace('file:', '') || './dev.db';

console.log(`[Migrate] Database path: ${dbPath}`);
console.log('');

try {
  // Try to load better-sqlite3
  const Database = (await import('better-sqlite3')).default;
  
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Create tables
  const migrations = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL
    )`,
    
    `CREATE TABLE IF NOT EXISTS user_signals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    )`,
    
    `CREATE TABLE IF NOT EXISTS suggested_leads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT,
      rationale TEXT NOT NULL,
      source TEXT NOT NULL,
      score REAL NOT NULL,
      lead TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_contacted_at TEXT,
      pipeline_stage TEXT,
      pipeline_stage_changed_at TEXT,
      updated_at TEXT
    )`,
    
    `CREATE TABLE IF NOT EXISTS processed_signals (
      id TEXT PRIMARY KEY,
      signal_id TEXT NOT NULL UNIQUE,
      signal_source TEXT NOT NULL,
      signal_created_at TEXT NOT NULL,
      processed_at TEXT NOT NULL
    )`,
    
    `CREATE TABLE IF NOT EXISTS supervisor_state (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL UNIQUE,
      last_processed_timestamp TEXT,
      last_processed_id TEXT,
      updated_at TEXT NOT NULL
    )`,
    
    `CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT,
      status TEXT NOT NULL,
      plan_data TEXT NOT NULL,
      goal_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    
    `CREATE TABLE IF NOT EXISTS plan_executions (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      account_id TEXT,
      goal_id TEXT,
      goal_text TEXT,
      overall_status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      step_results TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL
    )`,
    
    `CREATE TABLE IF NOT EXISTS subconscious_nudges (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      user_id TEXT,
      nudge_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      importance INTEGER NOT NULL,
      lead_id TEXT,
      context TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      dismissed_at TEXT
    )`,
    
    `CREATE INDEX IF NOT EXISTS subconscious_nudges_account_id_idx ON subconscious_nudges(account_id)`,
  ];

  console.log('[Migrate] Running migrations...');

  for (const migration of migrations) {
    try {
      sqlite.exec(migration);
      const match = migration.match(/(?:TABLE|INDEX)\s+(?:IF NOT EXISTS\s+)?(\w+)/i);
      const name = match ? match[1] : 'unknown';
      console.log(`  ✓ Created/verified: ${name}`);
    } catch (error) {
      console.error(`  ✗ Failed:`, error);
      process.exit(1);
    }
  }

  sqlite.close();

  console.log('');
  console.log('[Migrate] ✅ Migration complete!');
  console.log('');
  console.log('Next steps:');
  console.log('  npm run db:seed   # (optional) Add sample data');
  console.log('  npm run dev       # Start the dev server');
  console.log('='.repeat(60));

} catch (error: any) {
  console.log('');
  console.log('='.repeat(60));
  console.log('[Migrate] ⚠️  Could not load better-sqlite3');
  console.log('');
  console.log('This is normal on Windows without build tools.');
  console.log('');
  console.log('Options:');
  console.log('  1. Run without database (mock mode):');
  console.log('     npm run dev');
  console.log('     (Data won\'t persist, but UI will work)');
  console.log('');
  console.log('  2. Install build tools and retry:');
  console.log('     - Install Visual Studio Build Tools');
  console.log('     - npm install');
  console.log('     - npm run db:migrate');
  console.log('');
  console.log('  3. Use PostgreSQL instead:');
  console.log('     - Set DATABASE_URL to a PostgreSQL URL in .env');
  console.log('     - npm run db:push');
  console.log('='.repeat(60));
  
  // Exit with 0 so it doesn't block the setup
  process.exit(0);
}
