import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

async function checkDatabase() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('\n🗄️  WABS Database Status Check\n');

  try {
    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('task_executions', 'agent_memory')
      ORDER BY table_name
    `);

    console.log('📊 Tables:');
    tables.rows.forEach(r => console.log(`   ✅ ${r.table_name}`));

    if (tables.rows.some(r => r.table_name === 'task_executions')) {
      console.log('\n📋 task_executions columns:');
      const columns = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'task_executions'
        ORDER BY ordinal_position
      `);

      columns.rows.forEach(c => {
        const marker = ['wabs_score', 'wabs_signals'].includes(c.column_name) ? '🎯' : '  ';
        console.log(`   ${marker} ${c.column_name} (${c.data_type})`);
      });

      console.log('\n📈 Recent task executions:');
      const recent = await pool.query(`
        SELECT task_id, wabs_score, created_at
        FROM task_executions
        ORDER BY created_at DESC
        LIMIT 5
      `);

      if (recent.rows.length === 0) {
        console.log('   (No tasks executed yet)');
      } else {
        recent.rows.forEach(r => {
          const score = r.wabs_score !== null ? `${r.wabs_score}/100` : 'NULL';
          console.log(`   ${r.task_id}: ${score} (${r.created_at})`);
        });
      }
    }

    if (tables.rows.some(r => r.table_name === 'agent_memory')) {
      console.log('\n🧠 agent_memory WABS feedback:');
      const feedback = await pool.query(`
        SELECT COUNT(*) as count
        FROM agent_memory
        WHERE memory_type = 'wabs_feedback'
      `);
      console.log(`   ${feedback.rows[0].count} feedback entries`);
    }

    console.log('\n✅ Database check complete\n');

  } catch (err: any) {
    console.error(`\n❌ Error: ${err.message}\n`);
  } finally {
    await pool.end();
  }
}

checkDatabase().catch(console.error);
