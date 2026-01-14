import pg from 'pg';
const { Client } = pg;
import dotenv from 'dotenv';

dotenv.config();

async function checkTables() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    const requiredTables = [
      'users',
      'user_signals',
      'suggested_leads',
      'processed_signals',
      'supervisor_state',
      'plans',
      'plan_executions',
      'subconscious_nudges',
      'agent_memory'
    ];

    console.log('Checking required tables...\n');

    for (const table of requiredTables) {
      const result = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = $1
        );
      `, [table]);

      const exists = result.rows[0].exists;
      console.log(`${exists ? '✓' : '✗'} ${table}`);
    }

  } catch (error: any) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

checkTables();
