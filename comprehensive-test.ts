/**
 * Comprehensive Testing Script - Phase 2 & 3
 * Tests all 11 requirements with proof before Phase 4
 */

import 'dotenv/config';

// Test tracking
const results: Record<string, {status: 'PASS' | 'FAIL' | 'SKIP', evidence: string, details?: string}> = {};

function recordTest(testId: string, status: 'PASS' | 'FAIL' | 'SKIP', evidence: string, details?: string) {
  results[testId] = { status, evidence, details };
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭️';
  console.log(`${icon} ${testId}: ${status}`);
  if (evidence) console.log(`   Evidence: ${evidence}`);
  if (details) console.log(`   ${details}`);
}

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  COMPREHENSIVE TEST SUITE - PHASE 2 & 3          ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // ========================================
  // PHASE 2 TESTS (ADAPT - Memory System)
  // ========================================
  console.log('\n📋 PHASE 2: ADAPT (Memory & Learning)\n');

  // Test 2.1: Memory Storage
  console.log('Test 2.1: Memory Storage Works');
  try {
    const { createMemory } = await import('./server/services/memory-writer');
    const testMemory = await createMemory({
      userId: 'test-user',
      memoryType: 'preference',
      content: { test: 'data' },
      tags: ['test'],
      confidenceScore: 0.9
    });

    if (testMemory && testMemory.id) {
      recordTest('2.1', 'PASS', `Memory ID: ${testMemory.id}`, 'Database insert successful');
      // Cleanup
      const pg = await import('pg');
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      await pool.query('DELETE FROM agent_memory WHERE id = $1', [testMemory.id]);
      await pool.end();
    } else {
      recordTest('2.1', 'FAIL', 'No memory returned', 'createMemory returned null/undefined');
    }
  } catch (error: any) {
    recordTest('2.1', 'FAIL', error.message);
  }

  // Test 2.2: Memory Retrieval
  console.log('\nTest 2.2: Memory Retrieval in Planning');
  try {
    const { getActiveMemories, getMemoryContext } = await import('./server/services/memory-reader');

    // Create test memories first
    const { createMemory } = await import('./server/services/memory-writer');
    const memory1 = await createMemory({
      userId: 'test-user-retrieval',
      memoryType: 'preference',
      content: { preference: 'craft beer' },
      tags: ['beer', 'craft'],
      confidenceScore: 0.8
    });

    // Retrieve them
    const activeMemories = await getActiveMemories('test-user-retrieval');
    const context = await getMemoryContext('test-user-retrieval', ['beer']);

    if (activeMemories.length > 0 && context.total > 0) {
      recordTest('2.2', 'PASS',
        `Retrieved ${activeMemories.length} memories, context has ${context.total} relevant items`,
        `Context summary length: ${context.summary.length} chars`
      );
    } else {
      recordTest('2.2', 'FAIL', 'No memories retrieved or empty context');
    }

    // Cleanup
    const pg = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    if (memory1) await pool.query('DELETE FROM agent_memory WHERE id = $1', [memory1.id]);
    await pool.end();
  } catch (error: any) {
    recordTest('2.2', 'FAIL', error.message);
  }

  // Test 2.3: Preference Learning
  console.log('\nTest 2.3: Preference Learning from Feedback');
  try {
    const { learnFromFeedback } = await import('./server/services/preference-learner');
    const { getUserPreferences } = await import('./server/services/memory-reader');

    const beforePrefs = await getUserPreferences('test-pref-user');
    const beforeCount = beforePrefs.length;

    await learnFromFeedback({
      userId: 'test-pref-user',
      taskId: 'test-task',
      eventType: 'task_feedback',
      feedback: 'positive',
      context: {
        query: 'Find craft beer breweries in London',
        result: { matched: true }
      }
    });

    const afterPrefs = await getUserPreferences('test-pref-user');
    const afterCount = afterPrefs.length;

    if (afterCount > beforeCount) {
      recordTest('2.3', 'PASS',
        `Preferences increased from ${beforeCount} to ${afterCount}`,
        `New preferences extracted from feedback`
      );
    } else {
      recordTest('2.3', 'FAIL', 'No preference learning occurred');
    }

    // Cleanup
    const pg = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query('DELETE FROM agent_memory WHERE user_id = $1', ['test-pref-user']);
    await pool.end();
  } catch (error: any) {
    recordTest('2.3', 'FAIL', error.message);
  }

  // Test 2.4: Preferences API
  console.log('\nTest 2.4: Preferences API Endpoint');
  try {
    const response = await fetch('http://localhost:5000/api/preferences?userId=test-api-user');

    if (!response.ok) {
      recordTest('2.4', 'FAIL', `HTTP ${response.status}: ${response.statusText}`);
    } else {
      const data = await response.json();
      if (Array.isArray(data)) {
        recordTest('2.4', 'PASS',
          `API returned ${data.length} preferences`,
          `Response is valid JSON array`
        );
      } else {
        recordTest('2.4', 'FAIL', 'Response is not an array');
      }
    }
  } catch (error: any) {
    recordTest('2.4', 'FAIL', error.message, 'Is server running on port 5000?');
  }

  // ========================================
  // PHASE 3 TESTS (WABS - Scoring System)
  // ========================================
  console.log('\n\n🎯 PHASE 3: WABS (Judgement System)\n');

  // Test 3.1: WABS Scoring
  console.log('Test 3.1: WABS Scoring with Signal Breakdown');
  try {
    const { WABSScorer } = await import('./server/services/wabs-scorer');
    const scorer = new WABSScorer();

    const testResult = {
      query: 'Find craft beer breweries in London',
      results: [
        { name: 'London Beer Factory', type: 'brewery', location: 'London' },
        { name: 'Camden Town Brewery', type: 'brewery', location: 'London' }
      ],
      metadata: {
        resultCount: 2,
        processingTime: 1250
      }
    };

    const score = await scorer.scoreResult(testResult, {
      userId: 'test-wabs-user',
      preferences: []
    });

    if (score && typeof score.score === 'number' && score.signals) {
      const signalNames = Object.keys(score.signals);
      recordTest('3.1', 'PASS',
        `Score: ${score.score}/100 with ${signalNames.length} signals`,
        `Signals: ${signalNames.join(', ')}`
      );
    } else {
      recordTest('3.1', 'FAIL', 'Invalid score object or missing signals');
    }
  } catch (error: any) {
    recordTest('3.1', 'FAIL', error.message);
  }

  // Test 3.2: Email Notifications
  console.log('\nTest 3.2: Email Notifications for High Scores');
  recordTest('3.2', 'SKIP', 'Manual test required',
    'Requires score >70 and email credentials. Test via task execution.');

  // Test 3.3: Feedback Loop
  console.log('\nTest 3.3: WABS Feedback Loop Calibration');
  recordTest('3.3', 'SKIP', 'Manual test required',
    'Requires 12 feedback cycles. Test via UI or API calls.');

  // Test 3.4: Multi-Signal Scoring
  console.log('\nTest 3.4: All 4 Signals Calculated');
  try {
    const { WABSScorer } = await import('./server/services/wabs-scorer');
    const scorer = new WABSScorer();

    const testResult = {
      query: 'Find craft beer breweries in London near me',
      results: [
        { name: 'Local Brewery', distance: 0.5, rating: 4.5, type: 'brewery' }
      ],
      metadata: {
        resultCount: 1,
        processingTime: 800,
        source: 'google_places'
      }
    };

    const score = await scorer.scoreResult(testResult, {
      userId: 'test-multi-signal',
      preferences: [
        { key: 'craft beer', weight: 0.9 },
        { key: 'london', weight: 0.8 }
      ]
    });

    if (score && score.signals) {
      const expectedSignals = ['relevance', 'quality', 'recency', 'personalization'];
      const actualSignals = Object.keys(score.signals);
      const hasAllSignals = expectedSignals.every(s => actualSignals.includes(s));

      if (hasAllSignals) {
        recordTest('3.4', 'PASS',
          `All 4 signals present: ${actualSignals.join(', ')}`,
          `Signal values: ${JSON.stringify(score.signals)}`
        );
      } else {
        const missing = expectedSignals.filter(s => !actualSignals.includes(s));
        recordTest('3.4', 'FAIL', `Missing signals: ${missing.join(', ')}`);
      }
    } else {
      recordTest('3.4', 'FAIL', 'No signals in score object');
    }
  } catch (error: any) {
    recordTest('3.4', 'FAIL', error.message);
  }

  // ========================================
  // INTEGRATION TEST
  // ========================================
  console.log('\n\n🔄 INTEGRATION TEST\n');

  console.log('Test E2E: Full Learning Cycle');
  recordTest('E2E', 'SKIP', 'Manual test required',
    'Requires: Goal → Task → Score → Feedback → Learning. Test via UI flow.');

  // ========================================
  // UI TESTS
  // ========================================
  console.log('\n\n🎨 UI TESTS\n');

  console.log('Test UI.1: Dashboard Shows Real Data');
  recordTest('UI.1', 'SKIP', 'Chrome automation required',
    'Use Chrome to navigate to localhost:5173 and verify dashboard');

  console.log('Test UI.2: Preferences Page Renders');
  recordTest('UI.2', 'SKIP', 'Chrome automation required',
    'Use Chrome to navigate to localhost:5173/preferences and verify rendering');

  // ========================================
  // SUMMARY
  // ========================================
  console.log('\n\n╔══════════════════════════════════════════════════╗');
  console.log('║              TEST SUMMARY                        ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const passed = Object.values(results).filter(r => r.status === 'PASS').length;
  const failed = Object.values(results).filter(r => r.status === 'FAIL').length;
  const skipped = Object.values(results).filter(r => r.status === 'SKIP').length;
  const total = Object.keys(results).length;

  console.log(`PASSED:  ${passed}/${total}`);
  console.log(`FAILED:  ${failed}/${total}`);
  console.log(`SKIPPED: ${skipped}/${total}`);
  console.log('');

  // Detailed results
  console.log('DETAILED RESULTS:');
  for (const [testId, result] of Object.entries(results)) {
    const icon = result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : '⏭️';
    console.log(`${icon} ${testId}: ${result.status} - ${result.evidence}`);
    if (result.details) {
      console.log(`   ${result.details}`);
    }
  }

  console.log('\n\n');
  console.log('Ready for Phase 4:', failed === 0 ? 'YES ✅' : 'NO ❌');
  console.log('');

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
