/**
 * WABS End-to-End Integration Test
 * Tests the full flow: executeTask → WABS scoring → database storage
 */

import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

async function testWABSEndToEnd() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   WABS END-TO-END INTEGRATION TEST    ║');
  console.log('╚════════════════════════════════════════╝\n');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const testUserId = 'test-e2e-user';
  const testTaskId = `e2e_test_${Date.now()}`;

  try {
    console.log('🔍 [TEST] Import task-executor...');
    const { executeTask } = await import('./server/services/task-executor.js');
    console.log('✅ Imported successfully\n');

    console.log('🔍 [TEST] Create test task...');
    const testTask = {
      title: 'Find overdue invoices',
      description: 'Check for customers with overdue invoices over £100',
      tool: 'search',
      parameters: {
        query: 'overdue invoices',
        filters: { amount_min: 100 }
      },
      priority: 'high',
      estimatedDuration: 30
    };
    console.log(`   Task: ${testTask.title}\n`);

    console.log('🔍 [TEST] Execute task with WABS scoring...');
    console.log('   (This will attempt to call unified-tool endpoint)');
    console.log('   (May fail if wyshbone-ui not running - that\'s OK for this test)\n');

    try {
      const result = await executeTask(testTask, testUserId, testTaskId);

      console.log('📊 [RESULT] Task Execution:');
      console.log(`   Status: ${result.status}`);
      console.log(`   Interesting: ${result.interesting}`);
      console.log(`   WABS Score: ${result.wabsScore ?? 'N/A'}/100`);
      if (result.wabsSignals) {
        console.log(`   Signals: R=${result.wabsSignals.relevance} N=${result.wabsSignals.novelty} A=${result.wabsSignals.actionability} U=${result.wabsSignals.urgency}`);
      }
      console.log();

    } catch (execError: any) {
      console.log(`⚠️  Task execution failed (expected if wyshbone-ui not running):`);
      console.log(`   ${execError.message}\n`);
    }

    console.log('🔍 [TEST] Check database for stored WABS score...');

    const dbResult = await pool.query(`
      SELECT task_id, user_id, wabs_score, wabs_signals, created_at
      FROM task_executions
      WHERE task_id = $1
    `, [testTaskId]);

    if (dbResult.rows.length === 0) {
      console.log('⚠️  No record found in database');
      console.log('   This means either:');
      console.log('   1. Task execution failed before WABS scoring');
      console.log('   2. WABS score was not calculated');
      console.log('   3. storeTaskExecution() was not called\n');

      // Check if there are ANY WABS scores in the database
      const anyScores = await pool.query(`
        SELECT COUNT(*) as count
        FROM task_executions
        WHERE wabs_score IS NOT NULL
      `);

      console.log(`   Total WABS scores in database: ${anyScores.rows[0].count}\n`);

      return false;
    }

    const row = dbResult.rows[0];
    console.log('✅ Found stored WABS score:');
    console.log(`   task_id: ${row.task_id}`);
    console.log(`   user_id: ${row.user_id}`);
    console.log(`   wabs_score: ${row.wabs_score}/100`);
    console.log(`   wabs_signals: ${JSON.stringify(row.wabs_signals)}`);
    console.log(`   created_at: ${row.created_at}\n`);

    console.log('🧹 [TEST] Cleanup test data...');
    await pool.query('DELETE FROM task_executions WHERE user_id = $1', [testUserId]);
    console.log('✅ Cleaned up\n');

    console.log('╔════════════════════════════════════════╗');
    console.log('║           TEST RESULTS                 ║');
    console.log('╚════════════════════════════════════════╝\n');
    console.log('✅ Task Executor Import');
    console.log('✅ WABS Scoring');
    console.log('✅ Database Storage');
    console.log('✅ Data Retrieval\n');
    console.log('🎉 WABS END-TO-END TEST PASSED!\n');
    console.log('The full flow works:');
    console.log('  executeTask() → WABS scoring → database storage ✅\n');

    return true;

  } catch (error: any) {
    console.error(`\n❌ Test failed: ${error.message}`);
    console.error('Stack:', error.stack);
    return false;
  } finally {
    await pool.end();
  }
}

testWABSEndToEnd().catch(console.error);
