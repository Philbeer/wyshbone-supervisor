/**
 * Test 2.1: Memory Storage Works (Direct PostgreSQL)
 *
 * Tests memory storage using direct PostgreSQL connection
 * since Supabase client is not configured
 */

import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not configured');
  process.exit(1);
}

// Configure neon
const neonConfig = await import('@neondatabase/serverless').then(m => m.neonConfig);
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: DATABASE_URL });

async function testMemoryStorage() {
  console.log('\n🧪 TEST 2.1: Memory Storage Works (Direct PostgreSQL)\n');

  const testResults = {
    tableExists: false,
    canInsert: false,
    canQuery: false,
    schemaCorrect: false
  };

  let client;

  try {
    client = await pool.connect();

    // 1. Check if agent_memory table exists
    console.log('1️⃣ Checking if agent_memory table exists...');
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'agent_memory'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      console.error('❌ agent_memory table does not exist');
      return testResults;
    }

    testResults.tableExists = true;
    console.log('✅ agent_memory table exists');

    // 2. Get table schema
    console.log('\n2️⃣ Verifying table schema...');
    const schemaQuery = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'agent_memory'
      ORDER BY ordinal_position;
    `);

    console.log(`📋 Found ${schemaQuery.rows.length} columns:`);
    schemaQuery.rows.forEach((col: any) => {
      console.log(`   - ${col.column_name} (${col.data_type})`);
    });

    // Check for required columns
    const columns = schemaQuery.rows.map((r: any) => r.column_name);
    const requiredColumns = [
      'id', 'user_id', 'memory_type', 'title', 'description',
      'tags', 'confidence_score', 'relevance_score', 'created_at'
    ];

    const missingColumns = requiredColumns.filter(col => !columns.includes(col));

    if (missingColumns.length > 0) {
      console.error('❌ Missing required columns:', missingColumns);
      return testResults;
    }

    testResults.schemaCorrect = true;
    console.log('✅ Schema structure is correct');

    // 3. Insert test memory
    console.log('\n3️⃣ Inserting test memory entry...');
    const testMemoryId = `test_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    await client.query(`
      INSERT INTO agent_memory (
        id, user_id, memory_type, title, description,
        tags, confidence_score, relevance_score, created_at, source, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      )
    `, [
      testMemoryId,
      'test-user-' + Date.now(),
      'preference',
      'Test Memory',
      'This is a test memory entry',
      ['test', 'verification'],
      0.95,
      0.90,
      Date.now(),
      'manual_entry',
      JSON.stringify({ test: true, timestamp: new Date().toISOString() })
    ]);

    testResults.canInsert = true;
    console.log('✅ Successfully inserted test memory');
    console.log('   Memory ID:', testMemoryId);

    // 4. Query the test memory back
    console.log('\n4️⃣ Querying test memory back...');
    const queryResult = await client.query(`
      SELECT * FROM agent_memory WHERE id = $1
    `, [testMemoryId]);

    if (queryResult.rows.length === 0) {
      console.error('❌ Failed to query test memory');
      return testResults;
    }

    testResults.canQuery = true;
    console.log('✅ Successfully queried test memory back');
    console.log('   Title:', queryResult.rows[0].title);
    console.log('   Type:', queryResult.rows[0].memory_type);
    console.log('   Confidence:', queryResult.rows[0].confidence_score);

    // 5. Cleanup test data
    console.log('\n5️⃣ Cleaning up test data...');
    await client.query(`DELETE FROM agent_memory WHERE id = $1`, [testMemoryId]);
    console.log('✅ Test data cleaned up');

    // 6. Count existing memories
    console.log('\n6️⃣ Checking existing memory entries...');
    const countResult = await client.query(`SELECT COUNT(*) FROM agent_memory`);
    const count = parseInt(countResult.rows[0].count);
    console.log(`📊 Total memories in database: ${count}`);

    // 7. Sample some existing memories by type
    console.log('\n7️⃣ Sampling existing memories by type...');
    const typeCountsResult = await client.query(`
      SELECT memory_type, COUNT(*) as count
      FROM agent_memory
      GROUP BY memory_type
      ORDER BY count DESC
    `);

    if (typeCountsResult.rows.length > 0) {
      console.log('   Memory types:');
      typeCountsResult.rows.forEach((row: any) => {
        console.log(`   - ${row.memory_type}: ${row.count}`);
      });
    } else {
      console.log('   No existing memories found');
    }

  } catch (error: any) {
    console.error('❌ Unexpected error:', error.message);
    return testResults;
  } finally {
    if (client) {
      client.release();
    }
  }

  return testResults;
}

// Run test
testMemoryStorage()
  .then(results => {
    console.log('\n' + '='.repeat(50));
    console.log('TEST 2.1 RESULTS:');
    console.log('='.repeat(50));
    console.log('Table Exists:', results.tableExists ? '✅ PASS' : '❌ FAIL');
    console.log('Schema Correct:', results.schemaCorrect ? '✅ PASS' : '❌ FAIL');
    console.log('Can Insert:', results.canInsert ? '✅ PASS' : '❌ FAIL');
    console.log('Can Query:', results.canQuery ? '✅ PASS' : '❌ FAIL');

    const allPassed = Object.values(results).every(r => r === true);
    console.log('\n' + (allPassed ? '✅ TEST 2.1: PASSED' : '❌ TEST 2.1: FAILED'));
    console.log('='.repeat(50) + '\n');

    process.exit(allPassed ? 0 : 1);
  })
  .catch(error => {
    console.error('❌ Test execution failed:', error);
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
