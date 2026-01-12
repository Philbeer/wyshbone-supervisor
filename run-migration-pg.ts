/**
 * Run database migration using standard pg library
 */

import pg from 'pg';
const { Client } = pg;
import { readFile } from 'fs/promises';
import dotenv from 'dotenv';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not configured');
  process.exit(1);
}

async function runMigration() {
  console.log('\n📊 Running Migration: 0002_create_agent_memory.sql\n');

  const client = new Client({ connectionString: DATABASE_URL });

  try {
    console.log('1️⃣ Connecting to database...');
    await client.connect();
    console.log('✅ Connected');

    // Read migration file
    console.log('\n2️⃣ Reading migration file...');
    const migrationPath = 'C:/Users/Phil Waite/Documents/GitHub/wyshbone-ui/migrations/0002_create_agent_memory.sql';
    const sql = await readFile(migrationPath, 'utf-8');
    console.log('✅ Migration file read successfully');
    console.log(`   Size: ${sql.length} characters`);

    // Run migration
    console.log('\n3️⃣ Executing SQL...');
    await client.query(sql);
    console.log('✅ SQL executed successfully');

    // Verify table was created
    console.log('\n4️⃣ Verifying table creation...');
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'agent_memory'
      );
    `);

    if (tableCheck.rows[0].exists) {
      console.log('✅ agent_memory table created successfully');
    } else {
      console.error('❌ Table was not created');
      process.exit(1);
    }

    // Count indexes
    console.log('\n5️⃣ Checking indexes...');
    const indexCheck = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'agent_memory';
    `);

    console.log(`✅ Found ${indexCheck.rows.length} indexes:`);
    indexCheck.rows.forEach((row: any) => {
      console.log(`   - ${row.indexname}`);
    });

    console.log('\n✅ Migration completed successfully!\n');

  } catch (error: any) {
    console.error('\n❌ Migration failed:', error.message);
    if (error.code) {
      console.error('Error code:', error.code);
    }
    if (error.detail) {
      console.error('Detail:', error.detail);
    }
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
