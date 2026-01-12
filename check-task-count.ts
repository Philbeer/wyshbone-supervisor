import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

async function checkTaskCount() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const count = await pool.query('SELECT COUNT(*) FROM task_executions');
    console.log(`Current task count: ${count.rows[0].count}`);

    const latest = await pool.query('SELECT task_id, wabs_score, created_at FROM task_executions ORDER BY created_at DESC LIMIT 1');

    if (latest.rows.length > 0) {
      const row = latest.rows[0];
      console.log(`Latest task: ${row.task_id} (score: ${row.wabs_score ?? 'NULL'}, created: ${row.created_at})`);
    } else {
      console.log('No tasks in database yet');
    }
  } finally {
    await pool.end();
  }
}

checkTaskCount().catch(console.error);
