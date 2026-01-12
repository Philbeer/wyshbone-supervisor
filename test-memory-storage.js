/**
 * Test 2.1: Memory Storage Works
 *
 * Verifies:
 * - agent_memory table exists in Supabase
 * - Can insert memory entries
 * - Can query memories back
 * - Schema matches expected structure
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL or SUPABASE_SERVICE_ROLE not configured');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function testMemoryStorage() {
  console.log('\n🧪 TEST 2.1: Memory Storage Works\n');

  const testResults = {
    schemaExists: false,
    canInsert: false,
    canQuery: false,
    schemaCorrect: false
  };

  try {
    // 1. Verify table exists by querying it
    console.log('1️⃣ Checking if agent_memory table exists...');
    const { data: existingData, error: queryError } = await supabase
      .from('agent_memory')
      .select('*')
      .limit(1);

    if (queryError) {
      console.error('❌ Table does not exist or is inaccessible:', queryError.message);
      return testResults;
    }

    testResults.schemaExists = true;
    console.log('✅ agent_memory table exists');

    // 2. Insert a test memory entry
    console.log('\n2️⃣ Inserting test memory entry...');
    const testMemory = {
      user_id: 'test-user-' + Date.now(),
      memory_type: 'preference',
      tool_used: 'test-tool',
      context_summary: 'Test memory storage',
      outcome_data: {
        test: true,
        timestamp: new Date().toISOString()
      },
      key_insights: ['Test insight 1', 'Test insight 2'],
      confidence_score: 0.95,
      learned_at: new Date().toISOString(),
      tags: ['test', 'verification']
    };

    const { data: insertedData, error: insertError } = await supabase
      .from('agent_memory')
      .insert([testMemory])
      .select();

    if (insertError) {
      console.error('❌ Failed to insert test memory:', insertError.message);
      return testResults;
    }

    testResults.canInsert = true;
    console.log('✅ Successfully inserted test memory');
    console.log('   Memory ID:', insertedData[0].id);

    // 3. Query the test memory back
    console.log('\n3️⃣ Querying test memory back...');
    const { data: queriedData, error: fetchError } = await supabase
      .from('agent_memory')
      .select('*')
      .eq('id', insertedData[0].id)
      .single();

    if (fetchError) {
      console.error('❌ Failed to query test memory:', fetchError.message);
      return testResults;
    }

    testResults.canQuery = true;
    console.log('✅ Successfully queried test memory back');

    // 4. Verify schema structure
    console.log('\n4️⃣ Verifying schema structure...');
    const expectedFields = [
      'id', 'user_id', 'memory_type', 'tool_used', 'context_summary',
      'outcome_data', 'key_insights', 'confidence_score', 'learned_at',
      'user_feedback', 'tags', 'embedding_vector', 'source_session_id',
      'created_at', 'updated_at'
    ];

    const missingFields = expectedFields.filter(field => !(field in queriedData));

    if (missingFields.length > 0) {
      console.error('❌ Missing fields in schema:', missingFields);
      return testResults;
    }

    testResults.schemaCorrect = true;
    console.log('✅ Schema structure is correct');
    console.log('   All 15 expected fields present');

    // 5. Cleanup - delete test memory
    console.log('\n5️⃣ Cleaning up test data...');
    const { error: deleteError } = await supabase
      .from('agent_memory')
      .delete()
      .eq('id', insertedData[0].id);

    if (deleteError) {
      console.warn('⚠️  Failed to delete test memory:', deleteError.message);
    } else {
      console.log('✅ Test data cleaned up');
    }

    // 6. Count existing memories
    console.log('\n6️⃣ Checking existing memory entries...');
    const { count, error: countError } = await supabase
      .from('agent_memory')
      .select('*', { count: 'exact', head: true });

    if (countError) {
      console.warn('⚠️  Failed to count memories:', countError.message);
    } else {
      console.log(`📊 Total memories in database: ${count}`);
    }

  } catch (error) {
    console.error('❌ Unexpected error:', error);
    return testResults;
  }

  return testResults;
}

// Run test
testMemoryStorage().then(results => {
  console.log('\n' + '='.repeat(50));
  console.log('TEST 2.1 RESULTS:');
  console.log('='.repeat(50));
  console.log('Schema Exists:', results.schemaExists ? '✅ PASS' : '❌ FAIL');
  console.log('Can Insert:', results.canInsert ? '✅ PASS' : '❌ FAIL');
  console.log('Can Query:', results.canQuery ? '✅ PASS' : '❌ FAIL');
  console.log('Schema Correct:', results.schemaCorrect ? '✅ PASS' : '❌ FAIL');

  const allPassed = Object.values(results).every(r => r === true);
  console.log('\n' + (allPassed ? '✅ TEST 2.1: PASSED' : '❌ TEST 2.1: FAILED'));
  console.log('='.repeat(50) + '\n');

  process.exit(allPassed ? 0 : 1);
}).catch(error => {
  console.error('❌ Test execution failed:', error);
  process.exit(1);
});
