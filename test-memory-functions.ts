/**
 * Test 2.2: Memory Retrieval Works
 *
 * Verifies that memory-reader.ts functions can retrieve memories
 */

import dotenv from 'dotenv';
dotenv.config(); // Load .env BEFORE importing services

import { supabase } from './server/supabase';
import { getMemoryContext, getActiveMemories } from './server/services/memory-reader';
import { createMemory } from './server/services/memory-writer';

async function testMemoryFunctions() {
  console.log('\n🧪 TEST 2.2: Memory Functions Work\n');

  const testResults = {
    supabaseConfigured: false,
    canCreateMemory: false,
    canRetrieveMemories: false,
    canGetContext: false
  };

  try {
    // 1. Check if Supabase is configured
    console.log('1️⃣ Checking Supabase configuration...');
    if (supabase) {
      testResults.supabaseConfigured = true;
      console.log('✅ Supabase client is configured');
    } else {
      console.error('❌ Supabase client is NOT configured');
      console.error('   This means ALL memory functions will fail!');
      console.error('   SUPABASE_URL and SUPABASE_SERVICE_ROLE need to be set in .env');
      return testResults;
    }

    // 2. Create a test memory
    console.log('\n2️⃣ Creating test memory...');
    const testUserId = 'test-user-' + Date.now();

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

    // 3. Retrieve recent memories
    console.log('\n3️⃣ Retrieving recent memories...');
    const recentMemories = await getActiveMemories({ userId: testUserId, limit: 10 });

    if (recentMemories && recentMemories.length > 0) {
      testResults.canRetrieveMemories = true;
      console.log(`✅ Retrieved ${recentMemories.length} recent memories`);
      console.log('   First memory:', recentMemories[0].title);
    } else {
      console.error('❌ Failed to retrieve memories or no memories found');
      return testResults;
    }

    // 4. Get memory context (for autonomous agent)
    console.log('\n4️⃣ Getting memory context...');
    const context = await getMemoryContext(testUserId);

    if (context) {
      testResults.canGetContext = true;
      console.log('✅ Retrieved memory context');
      console.log(`   - ${context.preferences.length} preferences`);
      console.log(`   - ${context.successPatterns.length} success patterns`);
      console.log(`   - ${context.failurePatterns.length} failure patterns`);
    } else {
      console.error('❌ Failed to get memory context');
      return testResults;
    }

    // 5. Cleanup test data
    console.log('\n5️⃣ Cleaning up test data...');
    if (supabase) {
      await supabase
        .from('agent_memory')
        .delete()
        .eq('user_id', testUserId);
      console.log('✅ Test data cleaned up');
    }

  } catch (error: any) {
    console.error('❌ Unexpected error:', error.message);
    return testResults;
  }

  return testResults;
}

// Run test
testMemoryFunctions().then(results => {
  console.log('\n' + '='.repeat(50));
  console.log('TEST 2.2 RESULTS:');
  console.log('='.repeat(50));
  console.log('Supabase Configured:', results.supabaseConfigured ? '✅ PASS' : '❌ FAIL');
  console.log('Can Create Memory:', results.canCreateMemory ? '✅ PASS' : '❌ FAIL');
  console.log('Can Retrieve Memories:', results.canRetrieveMemories ? '✅ PASS' : '❌ FAIL');
  console.log('Can Get Context:', results.canGetContext ? '✅ PASS' : '❌ FAIL');

  const allPassed = Object.values(results).every(r => r === true);
  console.log('\n' + (allPassed ? '✅ TEST 2.2: PASSED' : '❌ TEST 2.2: FAILED'));

  if (!results.supabaseConfigured) {
    console.log('\n⚠️  CRITICAL ISSUE: Supabase client not configured!');
    console.log('   All Phase 2 (ADAPT) features are non-functional.');
    console.log('   Need to either:');
    console.log('   1. Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE, OR');
    console.log('   2. Refactor memory services to use db connection instead');
  }

  console.log('='.repeat(50) + '\n');

  process.exit(allPassed ? 0 : 1);
}).catch(error => {
  console.error('❌ Test execution failed:', error);
  process.exit(1);
});
