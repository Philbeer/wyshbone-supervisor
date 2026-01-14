/**
 * Database Connection Module
 * 
 * Supports three modes:
 * - Production: PostgreSQL (Neon serverless) - requires DATABASE_URL
 * - Development with DB: PostgreSQL/SQLite if DATABASE_URL is set
 * - Development without DB: In-memory mock (limited functionality)
 * 
 * For Windows development without database:
 * - The app will start and work for UI testing
 * - Data won't persist between restarts
 * - Some features (leads, plans) will use mock data
 */

import { config } from 'dotenv';

// Always try to load .env file
config();

// Treat as development unless explicitly set to production
const isProduction = process.env.NODE_ENV === 'production';
// Use SUPABASE_DATABASE_URL (preferred) or fall back to DATABASE_URL
const dbUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;
const hasDbUrl = !!dbUrl;

let db: any;
let pool: any = null;

if (!hasDbUrl && !isProduction) {
  // Development mode without database - use mock
  console.log('');
  console.log('='.repeat(60));
  console.log('[DB] ⚠️  No DATABASE_URL set - running in MOCK mode');
  console.log('[DB] Data will NOT persist between restarts');
  console.log('[DB] To use a real database, set DATABASE_URL in .env');
  console.log('='.repeat(60));
  console.log('');
  
  // Create a mock db object that won't crash
  // This mock supports common query patterns used in the codebase
  const createQueryChain = (): any => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      offset: () => chain,
      leftJoin: () => chain,
      innerJoin: () => chain,
      groupBy: () => chain,
      having: () => chain,
      // Terminal methods that return promises
      then: (resolve: any) => resolve([]),
      catch: () => Promise.resolve([]),
    };
    // Make it thenable so it works with await
    return chain;
  };
  
  db = {
    _isMock: true,
    select: () => createQueryChain(),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    delete: () => ({ where: () => Promise.resolve([]) }),
    query: {},
  };
  
  console.log('[DB] Mock database initialized');
} else if (hasDbUrl) {
  // Real database mode - use SUPABASE_DATABASE_URL or DATABASE_URL
  
  if (dbUrl.startsWith('file:') || dbUrl.endsWith('.db')) {
    // SQLite mode - but only if better-sqlite3 is available
    try {
      console.log('[DB] Attempting SQLite connection...');
      const Database = (await import('better-sqlite3')).default;
      const { drizzle } = await import('drizzle-orm/better-sqlite3');
      const schema = await import('@shared/schema-sqlite');
      
      const dbPath = dbUrl.replace('file:', '');
      const sqlite = new Database(dbPath);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('foreign_keys = ON');
      
      db = drizzle(sqlite, { schema });
      console.log(`[DB] Connected to SQLite: ${dbPath}`);
    } catch (err: any) {
      if (!isProduction) {
        console.log('');
        console.log('='.repeat(60));
        console.log('[DB] ⚠️  SQLite not available (better-sqlite3 needs native build)');
        console.log('[DB] Running in MOCK mode instead');
        console.log('[DB] To fix: Install Visual Studio Build Tools, or use PostgreSQL');
        console.log('='.repeat(60));
        console.log('');
        
        // Fall back to mock - use same pattern as above
        const createQueryChain = (): any => {
          const chain: any = {
            from: () => chain,
            where: () => chain,
            orderBy: () => chain,
            limit: () => chain,
            offset: () => chain,
            leftJoin: () => chain,
            innerJoin: () => chain,
            groupBy: () => chain,
            having: () => chain,
            then: (resolve: any) => resolve([]),
            catch: () => Promise.resolve([]),
          };
          return chain;
        };
        
        db = {
          _isMock: true,
          select: () => createQueryChain(),
          insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
          update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
          delete: () => ({ where: () => Promise.resolve([]) }),
          query: {},
        };
      } else {
        throw err;
      }
    }
  } else {
    // PostgreSQL mode
    console.log('[DB] Using PostgreSQL (Neon)');
    
    const { Pool, neonConfig } = await import('@neondatabase/serverless');
    const { drizzle } = await import('drizzle-orm/neon-serverless');
    const ws = (await import('ws')).default;
    const schema = await import('@shared/schema');
    
    neonConfig.webSocketConstructor = ws;
    
    pool = new Pool({ connectionString: dbUrl });
    db = drizzle({ client: pool, schema });
    
    console.log('[DB] Connected to PostgreSQL');
  }
} else {
  // Production without DATABASE_URL - error
  throw new Error(
    "DATABASE_URL must be set in production. Did you forget to provision a database?"
  );
}

export { db, pool };

// Helper to check if we're using mock DB
export function isMockDb(): boolean {
  return db?._isMock === true;
}

// Re-export schema types
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
