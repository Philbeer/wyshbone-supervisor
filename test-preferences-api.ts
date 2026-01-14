/**
 * Test 2.4: Preferences API Works
 *
 * Verifies that GET /api/preferences endpoint retrieves learned preferences
 */

import dotenv from 'dotenv';
dotenv.config();

import { learnFromFeedback, getUserPreferences } from './server/services/preference-learner';

async function testPreferencesAPI() {
  console.log('\n🧪 TEST 2.4: Preferences API Works\n');

  const testResults = {
    canCreatePreferences: false,
    canRetrieveViaService: false,
    apiReturnsPreferences: false,
    dataStructureCorrect: false
  };

  const testUserId = 'test-api-user-' + Date.now();

  try {
    // 1. Create test preferences via service
    console.log('1️⃣ Creating test preferences via service...');
    await learnFromFeedback({
      userId: testUserId,
      taskId: 'api-test-task',
      result: {
        brewery: {
          name: 'Stone Brewing',
          location: 'San Diego, CA',
          type: 'craft brewery'
        }
      },
      interesting: true
    });

    const prefs = await getUserPreferences(testUserId);
    if (prefs.keywords.length > 0 || prefs.regions.length > 0) {
      testResults.canCreatePreferences = true;
      console.log('✅ Created preferences via service');
      console.log(`   - ${prefs.keywords.length} keywords, ${prefs.regions.length} regions`);
    } else {
      console.error('❌ No preferences created');
      return testResults;
    }

    // 2. Retrieve preferences directly via service
    console.log('\n2️⃣ Retrieving preferences via service...');
    const servicePrefs = await getUserPreferences(testUserId);

    if (servicePrefs && servicePrefs.keywords.length > 0) {
      testResults.canRetrieveViaService = true;
      console.log('✅ Retrieved preferences via service');
      console.log(`   - industries: ${servicePrefs.industries.length}`);
      console.log(`   - regions: ${servicePrefs.regions.length}`);
      console.log(`   - contactTypes: ${servicePrefs.contactTypes.length}`);
      console.log(`   - keywords: ${servicePrefs.keywords.length}`);
    } else {
      console.error('❌ Failed to retrieve preferences via service');
      return testResults;
    }

    // 3. Test API endpoint (assumes server is running on port 5000)
    console.log('\n3️⃣ Testing GET /api/preferences endpoint...');

    const serverUrl = process.env.SERVER_URL || 'http://localhost:5000';
    const apiUrl = `${serverUrl}/api/preferences?user_id=${testUserId}`;

    console.log(`   Making GET request to: ${apiUrl}`);

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      console.error(`❌ API request failed with status ${response.status}`);
      const errorText = await response.text();
      console.error(`   Error: ${errorText}`);
      return testResults;
    }

    const apiData = await response.json();

    if (apiData.success && apiData.preferences) {
      testResults.apiReturnsPreferences = true;
      console.log('✅ API returned preferences');
      console.log(`   - success: ${apiData.success}`);
      console.log(`   - updatedAt: ${apiData.updatedAt}`);
    } else {
      console.error('❌ API response missing success or preferences');
      console.error(`   Response:`, JSON.stringify(apiData, null, 2));
      return testResults;
    }

    // 4. Verify data structure
    console.log('\n4️⃣ Verifying data structure...');
    const { preferences } = apiData;

    const hasCorrectStructure =
      Array.isArray(preferences.industries) &&
      Array.isArray(preferences.regions) &&
      Array.isArray(preferences.contactTypes) &&
      Array.isArray(preferences.keywords);

    if (hasCorrectStructure) {
      testResults.dataStructureCorrect = true;
      console.log('✅ Data structure is correct');

      // Show sample preference item if available
      if (preferences.keywords.length > 0) {
        const sample = preferences.keywords[0];
        console.log(`   Sample keyword preference:`, {
          value: sample.value,
          weight: sample.weight,
          engagementCount: sample.engagementCount
        });
      }
    } else {
      console.error('❌ Data structure is incorrect');
      console.error(`   Expected arrays for industries, regions, contactTypes, keywords`);
    }

  } catch (error: any) {
    console.error('❌ Unexpected error:', error.message);
    console.error('Stack:', error.stack);
    return testResults;
  } finally {
    // Cleanup
    console.log('\n5️⃣ Cleaning up test data...');
    try {
      const pg = await import('pg');
      const { Pool } = pg;
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      await pool.query('DELETE FROM agent_memory WHERE user_id = $1', [testUserId]);
      await pool.end();
      console.log('✅ Test data cleaned up');
    } catch (cleanupError: any) {
      console.error('⚠️  Cleanup failed:', cleanupError.message);
    }
  }

  return testResults;
}

// Run test
testPreferencesAPI().then(results => {
  console.log('\n' + '='.repeat(50));
  console.log('TEST 2.4 RESULTS:');
  console.log('='.repeat(50));
  console.log('Can Create Preferences:', results.canCreatePreferences ? '✅ PASS' : '❌ FAIL');
  console.log('Can Retrieve Via Service:', results.canRetrieveViaService ? '✅ PASS' : '❌ FAIL');
  console.log('API Returns Preferences:', results.apiReturnsPreferences ? '✅ PASS' : '❌ FAIL');
  console.log('Data Structure Correct:', results.dataStructureCorrect ? '✅ PASS' : '❌ FAIL');

  const allPassed = Object.values(results).every(r => r === true);
  console.log('\n' + (allPassed ? '✅ TEST 2.4: PASSED' : '❌ TEST 2.4: FAILED'));
  console.log('='.repeat(50) + '\n');

  process.exit(allPassed ? 0 : 1);
}).catch(error => {
  console.error('❌ Test execution failed:', error);
  console.error('Stack:', error.stack);
  process.exit(1);
});
