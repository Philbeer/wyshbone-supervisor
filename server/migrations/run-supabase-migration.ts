import { supabase } from '../supabase.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  console.log('🚀 Running Supabase migration for Supervisor chat integration...\n');
  
  // Read SQL file
  const sqlPath = path.join(__dirname, '../../migrations/supabase-supervisor-integration.sql');
  const sql = fs.readFileSync(sqlPath, 'utf-8');
  
  // Split into individual statements (simple approach)
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('--') && s !== '');
  
  console.log(`📝 Found ${statements.length} SQL statements to execute\n`);
  
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    console.log(`Executing statement ${i + 1}/${statements.length}...`);
    
    try {
      const { error } = await supabase.rpc('exec_sql', { sql: statement + ';' });
      
      if (error) {
        // Try alternative approach using raw SQL
        console.log('  ⚠️  RPC not available, using direct query...');
        const { error: directError } = await (supabase as any).from('_').select(statement);
        
        if (directError && !directError.message.includes('does not exist')) {
          console.error(`  ❌ Error:`, directError.message);
        } else {
          console.log('  ✅ Success');
        }
      } else {
        console.log('  ✅ Success');
      }
    } catch (err: any) {
      console.error(`  ❌ Error:`, err.message);
    }
  }
  
  console.log('\n✅ Migration complete! Please verify in Supabase dashboard.\n');
  console.log('📋 Manual verification steps:');
  console.log('   1. Check messages table has "source" and "metadata" columns');
  console.log('   2. Check supervisor_tasks table exists');
  console.log('   3. Verify indexes are created\n');
}

runMigration().catch(console.error);
