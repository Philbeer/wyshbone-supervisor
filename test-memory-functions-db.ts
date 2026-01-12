/**
 * Test 2.2: Memory Retrieval Works (Database Version)
 *
 * Verifies that refactored memory functions using direct database work
 */

import dotenv from 'dotenv';
dotenv.config(); // Load .env BEFORE importing services

import { getMemoryContext, getActiveMemories } from './server/services/memory-reader';
import { createMemory } from './server/services/memory-writer';

async function testMemoryFunctions() {
  console.log('\n🧪 TEST 2.2: Memory Functions Work (Database Version)\n');

  const testResults = {
    canCreateMemory: false,
    canRetrieveMemories: false,
    canGetContext: false,
    dataIsCorrect: false
  };

  let testUserId: string | null = null;

  try {
    // 1. Create a test memory
    console.log('1️⃣ Creating test memory...');
    testUserId = 'test-user-' + Date.now();

    const memoryId = await createMemory({
      userId: testUserId,
      memoryType: 'preference',
      title: 'Test Preference',
      description: 'User prefers craft breweries in London',
      tags: ['brewery', 'london', 'craft'],
      confidenceScore: 0.85,
      relevanceScore: 0.90,
      source: 'manual_entry',
      metadata: { test: true }
    });

    if (memoryId) {
      testResults.canCreateMemory = true;
      console.log('✅ Memory created successfully');
      console.log('   Memory ID:', memoryId);
    } else {
      console.error('❌ Failed to create memory');
      return testResults;
    }

    // 2. Retrieve recent memories
    console.log('\n2️⃣ Retrieving recent memories...');
    const recentMemories = await getActiveMemories({ userId: testUserId, limit: 10 });

    if (recentMemories && recentMemories.length > 0) {
      testResults.canRetrieveMemories = true;
      console.log(`✅ Retrieved ${recentMemories.length} recent memories`);
      console.log('   First memory:', recentMemories[0].title);

      // Verify data integrity
      const firstMemory = recentMemories[0];
      if (firstMemory.title === 'Test Preference' &&
          firstMemory.description === 'User prefers craft breweries in London' &&
          firstMemory.tags.includes('brewery') &&
          firstMemory.tags.includes('london') &&
          firstMemory.confidenceScore === 0.85) {
        testResults.dataIsCorrect = true;
        console.log('✅ Data integrity verified');
      } else {
        console.error('❌ Data corruption detected');
        console.error('   Expected tags: [brewery, london, craft]');
        console.error('   Actual tags:', firstMemory.tags);
      }
    } else {
      console.error('❌ Failed to retrieve memories or no memories found');
      return testResults;
    }

    // 3. Get memory context (for autonomous agent)
    console.log('\n3️⃣ Getting memory context...');
    const context = await getMemoryContext(testUserId);

    if (context) {
      testResults.canGetContext = true;
      console.log('✅ Retrieved memory context');
      console.log(`   - ${context.preferences.length} preferences`);
      console.log(`   - ${context.successPatterns.length} success patterns`);
      console.log(`   - ${context.failurePatterns.length} failure patterns`);
      console.log(`   - ${context.insights.length} insights`);
      console.log(`   - ${context.contextual.length} contextual`);

      if (context.preferences.length !== 1) {
        console.warn('⚠️  Expected 1 preference, got', context.preferences.length);
      }
    } else {
      console.error('❌ Failed to get memory context');
      return testResults;
    }

  } catch (error: any) {
    console.error('❌ Unexpected error:', error.message);
    console.error('Stack:', error.stack);
    return testResults;
  } finally {
    // Cleanup test data
    if (testUserId) {
      console.log('\n4️⃣ Cleaning up test data...');
      try {
        const pg = await import('pg');
        const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
        await pool.query('DELETE FROM agent_memory WHERE user_id = $1', [testUserId]);
        await pool.end();
        console.log('✅ Test data cleaned up');
      } catch (cleanupError: any) {
        console.error('⚠️  Cleanup failed:', cleanupError.message);
      }
    }
  }

  return testResults;
}

// Run test
testMemoryFunctions().then(results => {
  console.log('\n' + '='.repeat(50));
  console.log('TEST 2.2 RESULTS:');
  console.log('='.repeat(50));
  console.log('Can Create Memory:', results.canCreateMemory ? '✅ PASS' : '❌ FAIL');
  console.log('Can Retrieve Memories:', results.canRetrieveMemories ? '✅ PASS' : '❌ FAIL');
  console.log('Can Get Context:', results.canGetContext ? '✅ PASS' : '❌ FAIL');
  console.log('Data Is Correct:', results.dataIsCorrect ? '✅ PASS' : '❌ FAIL');

  const allPassed = Object.values(results).every(r => r === true);
  console.log('\n' + (allPassed ? '✅ TEST 2.2: PASSED' : '❌ TEST 2.2: FAILED'));
  console.log('='.repeat(50) + '\n');

  process.exit(allPassed ? 0 : 1);
}).catch(error => {
  console.error('❌ Test execution failed:', error);
  console.error('Stack:', error.stack);
  process.exit(1);
});
