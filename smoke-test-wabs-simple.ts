import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

async function smokeTest() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   WABS SMOKE TEST (Simplified)        ║');
  console.log('╚════════════════════════════════════════╝\n');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const results: any = {
    dbConnection: false,
    schemaCheck: false,
    scorerImport: false,
    scorerWorks: false
  };

  try {
    console.log('🔌 [TEST 1] Database Connection...');
    await pool.query('SELECT 1');
    results.dbConnection = true;
    console.log('✅ Connected to database\n');

    console.log('🗄️  [TEST 2] Database Schema Check...');

    const tableCheck = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = 'task_executions'
    `);

    if (tableCheck.rows.length === 0) {
      console.log('❌ task_executions table does NOT exist - CREATING IT...');
      await pool.query(`
        CREATE TABLE task_executions (
          id SERIAL PRIMARY KEY,
          task_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          wabs_score INTEGER,
          wabs_signals JSONB,
          result JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log('✅ Created task_executions table');
    } else {
      console.log('✅ task_executions table exists');

      const columnsCheck = await pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'task_executions'
        AND column_name IN ('wabs_score', 'wabs_signals')
      `);

      const hasScore = columnsCheck.rows.some(r => r.column_name === 'wabs_score');
      const hasSignals = columnsCheck.rows.some(r => r.column_name === 'wabs_signals');

      if (!hasScore) {
        console.log('❌ Missing wabs_score column - ADDING IT...');
        await pool.query('ALTER TABLE task_executions ADD COLUMN wabs_score INTEGER');
        console.log('✅ Added wabs_score column');
      }

      if (!hasSignals) {
        console.log('❌ Missing wabs_signals column - ADDING IT...');
        await pool.query('ALTER TABLE task_executions ADD COLUMN wabs_signals JSONB');
        console.log('✅ Added wabs_signals column');
      }

      if (hasScore && hasSignals) {
        console.log('✅ WABS columns exist (wabs_score, wabs_signals)');
      }

      results.schemaCheck = true;
      console.log();
    }

    console.log('📦 [TEST 3] WABS Scorer Import...');
    try {
      const { calculateWABSScore } = await import('./server/services/wabs-scorer.js');
      results.scorerImport = true;
      console.log('✅ WABS scorer imported successfully\n');

      console.log('🧮 [TEST 4] WABS Scorer Calculation...');
      const testResult = {
        success: true,
        output: 'Customer John Smith has 2 overdue invoices totaling £450',
        plan_steps_completed: 3,
        execution_time_ms: 1500
      };

      const testTask = {
        description: 'Check customer overdue invoices',
        context: { customer: 'John Smith' }
      };

      const score = await calculateWABSScore(testResult, testTask, 'test-user');

      console.log(`✅ Score calculated: ${score.wabs_score}/100`);
      console.log(`   Signals: R=${score.signals.relevance} N=${score.signals.novelty} A=${score.signals.actionability} U=${score.signals.urgency}`);
      results.scorerWorks = true;
      console.log();

    } catch (err: any) {
      console.log(`❌ WABS scorer failed: ${err.message}`);
      console.log('Stack:', err.stack);
      console.log();
    }

  } catch (error: any) {
    console.error(`\n❌ Test crashed: ${error.message}\n`);
  } finally {
    await pool.end();
  }

  console.log('╔════════════════════════════════════════╗');
  console.log('║           TEST RESULTS                 ║');
  console.log('╚════════════════════════════════════════╝\n');

  console.log(`${results.dbConnection ? '✅' : '❌'} Database Connection`);
  console.log(`${results.schemaCheck ? '✅' : '❌'} Database Schema`);
  console.log(`${results.scorerImport ? '✅' : '❌'} WABS Scorer Import`);
  console.log(`${results.scorerWorks ? '✅' : '❌'} WABS Scorer Execution`);

  const allPass = Object.values(results).every(v => v === true);

  console.log('\n' + '='.repeat(40));
  if (allPass) {
    console.log('🎉 ALL TESTS PASSED - WABS backend is working!\n');
    console.log('⚠️  MANUAL CHECK REQUIRED:');
    console.log('1. Trigger a task via UI');
    console.log('2. Check if WABS score appears in the UI');
    console.log('3. If UI shows score → Fully working ✅');
    console.log('4. If DB has score but UI doesnt → Auth/API issue ⚠️');
  } else {
    console.log('⚠️  SOME TESTS FAILED\n');
  }
  console.log('='.repeat(40) + '\n');
}

smokeTest().catch(console.error);
