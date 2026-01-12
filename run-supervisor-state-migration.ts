/**
 * Create supervisor_state table in Supabase
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
  console.log('\n📊 Creating supervisor_state table\n');

  const client = new Client({ connectionString: DATABASE_URL });

  try {
    console.log('1️⃣ Connecting to database...');
    await client.connect();
    console.log('✅ Connected');

    console.log('\n2️⃣ Reading migration file...');
    const sql = await readFile('migrations/create-supervisor-state.sql', 'utf-8');
    console.log('✅ Migration file read');

    console.log('\n3️⃣ Executing SQL...');
    await client.query(sql);
    console.log('✅ SQL executed');

    console.log('\n4️⃣ Verifying table...');
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'supervisor_state'
      );
    `);

    if (tableCheck.rows[0].exists) {
      console.log('✅ supervisor_state table created successfully');
    } else {
      console.error('❌ Table was not created');
      process.exit(1);
    }

    console.log('\n✅ Migration completed!\n');

  } catch (error: any) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
