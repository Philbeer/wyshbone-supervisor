import pg from 'pg';
const { Client } = pg;
import { readFile } from 'fs/promises';
import dotenv from 'dotenv';

dotenv.config();

async function runMigration() {
  console.log('\n📊 Creating all supervisor tables\n');

  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();
    console.log('✅ Connected to database');

    const sql = await readFile('migrations/create-all-supervisor-tables.sql', 'utf-8');
    console.log('✅ Migration file read');

    console.log('\n📝 Executing SQL...');
    await client.query(sql);
    console.log('✅ All tables created');

    console.log('\n✅ Migration completed!\n');

  } catch (error: any) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
