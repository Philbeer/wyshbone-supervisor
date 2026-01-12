/**
 * Test memory services after refactor
 */
import dotenv from 'dotenv';
dotenv.config();

import { learnFromFeedback, getUserPreferences } from './server/services/preference-learner';
import { createMemory } from './server/services/memory-writer';
import { getActiveMemories, getMemoryContext } from './server/services/memory-reader';
import pg from 'pg';

async function test() {
  console.log('Testing memory services after refactor...\n');

  const testUserId = 'test-refactor-' + Date.now();
  const results: Record<string, boolean> = {};

  try {
    // Test 1: Create memory
    console.log('1. Testing createMemory...');
    const memId = await createMemory({
      userId: testUserId,
      memoryType: 'preference',
      title: 'Test Memory',
      description: 'Testing after refactor',
      tags: ['test'],
      source: 'manual_entry',
      confidenceScore: 0.8,
      relevanceScore: 0.9
    });
    results['createMemory'] = !!memId;
    console.log('   Result:', memId ? 'PASS' : 'FAIL');

    // Test 2: Get memories
    console.log('2. Testing getActiveMemories...');
    const memories = await getActiveMemories({ userId: testUserId });
    results['getActiveMemories'] = memories.length > 0;
    console.log('   Result:', memories.length > 0 ? 'PASS' : 'FAIL');

    // Test 3: Get context
    console.log('3. Testing getMemoryContext...');
    const ctx = await getMemoryContext(testUserId);
    results['getMemoryContext'] = ctx.preferences.length > 0;
    console.log('   Result:', ctx.preferences.length > 0 ? 'PASS' : 'FAIL');

    // Test 4: Get user preferences
    console.log('4. Testing getUserPreferences...');
    const prefs = await getUserPreferences(testUserId);
    results['getUserPreferences'] = !!prefs;
    console.log('   Result:', prefs ? 'PASS' : 'FAIL');

    // Test 5: Learn from feedback
    console.log('5. Testing learnFromFeedback...');
    try {
      await learnFromFeedback({
        userId: testUserId,
        interesting: true,
        result: {
          industry: 'craft beer',
          location: 'London',
          type: 'brewery'
        }
      });
      results['learnFromFeedback'] = true;
      console.log('   Result: PASS');
    } catch (e: any) {
      results['learnFromFeedback'] = false;
      console.log('   Result: FAIL -', e.message);
    }

  } finally {
    // Cleanup
    console.log('\n6. Cleaning up test data...');
    try {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      await pool.query('DELETE FROM agent_memory WHERE user_id LIKE $1', [testUserId + '%']);
      await pool.end();
      console.log('   Cleanup complete');
    } catch (e: any) {
      console.log('   Cleanup failed:', e.message);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('MEMORY REFACTOR TEST RESULTS');
  console.log('='.repeat(50));

  const passed = Object.values(results).filter(v => v).length;
  const total = Object.keys(results).length;

  for (const [name, result] of Object.entries(results)) {
    console.log(`${result ? 'PASS' : 'FAIL'}: ${name}`);
  }

  console.log('\n' + `${passed}/${total} tests passed`);
  console.log('='.repeat(50));

  process.exit(passed === total ? 0 : 1);
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
