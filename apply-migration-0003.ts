import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import dotenv from 'dotenv';

// Load .env file
dotenv.config();

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function applyMigration() {
  const DATABASE_URL = process.env.DATABASE_URL;
  
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL not found in environment variables');
  }
  
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    console.log('[MIGRATION] Connecting to Supabase...');
    
    // Read migration file
    const migrationPath = resolve(__dirname, '../wyshbone-ui/migrations/0003_add_wabs_feedback_memory_type.sql');
    const sql = readFileSync(migrationPath, 'utf-8');
    
    console.log('[MIGRATION] Applying 0003_add_wabs_feedback_memory_type.sql...');
    
    await pool.query(sql);
    
    console.log('[MIGRATION] ✅ Migration applied successfully!');
  } catch (error) {
    console.error('[MIGRATION] ❌ Error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

applyMigration().catch(console.error);
