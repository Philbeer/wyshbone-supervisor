/**
 * Test WABS Database Storage
 * Verifies that WABS scores are persisted to task_executions table
 */

import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

async function testWABSStorage() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   WABS DATABASE STORAGE TEST          ║');
  console.log('╚════════════════════════════════════════╝\n');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log('🔍 [TEST 1] Manual WABS Score Storage...');

    // Insert a test WABS score
    const testTaskId = `test_wabs_${Date.now()}`;
    const testUserId = 'test-user-storage';
    const testScore = 85;
    const testSignals = {
      relevance: 80,
      novelty: 90,
      actionability: 85,
      urgency: 85
    };

    await pool.query(`
      INSERT INTO task_executions (task_id, user_id, wabs_score, wabs_signals, result, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [
      testTaskId,
      testUserId,
      testScore,
      JSON.stringify(testSignals),
      JSON.stringify({ test: 'data' })
    ]);

    console.log(`✅ Inserted test record (task_id: ${testTaskId})\n`);

    console.log('🔍 [TEST 2] Verify Storage...');

    const result = await pool.query(`
      SELECT task_id, user_id, wabs_score, wabs_signals, created_at
      FROM task_executions
      WHERE task_id = $1
    `, [testTaskId]);

    if (result.rows.length === 0) {
      console.log('❌ FAIL: Record not found in database\n');
      return false;
    }

    const row = result.rows[0];
    console.log(`✅ Found record:`);
    console.log(`   task_id: ${row.task_id}`);
    console.log(`   user_id: ${row.user_id}`);
    console.log(`   wabs_score: ${row.wabs_score}/100`);
    console.log(`   wabs_signals: ${JSON.stringify(row.wabs_signals)}`);
    console.log(`   created_at: ${row.created_at}\n`);

    console.log('🔍 [TEST 3] Query All WABS Scores...');

    const allScores = await pool.query(`
      SELECT task_id, user_id, wabs_score, created_at
      FROM task_executions
      WHERE wabs_score IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 10
    `);

    console.log(`✅ Found ${allScores.rows.length} task(s) with WABS scores:`);
    allScores.rows.forEach(r => {
      console.log(`   ${r.task_id}: ${r.wabs_score}/100 (${r.created_at})`);
    });
    console.log();

    console.log('🧹 [TEST 4] Cleanup...');
    await pool.query('DELETE FROM task_executions WHERE user_id = $1', [testUserId]);
    console.log('✅ Cleaned up test data\n');

    console.log('╔════════════════════════════════════════╗');
    console.log('║           TEST RESULTS                 ║');
    console.log('╚════════════════════════════════════════╝\n');
    console.log('✅ Database Connection');
    console.log('✅ WABS Score Storage');
    console.log('✅ WABS Score Retrieval');
    console.log('✅ Data Cleanup\n');
    console.log('🎉 ALL TESTS PASSED\n');
    console.log('⚠️  NEXT STEP: Run a real task via executeTask() and verify storage\n');

    return true;

  } catch (error: any) {
    console.error(`\n❌ Test failed: ${error.message}\n`);
    return false;
  } finally {
    await pool.end();
  }
}

testWABSStorage().catch(console.error);
