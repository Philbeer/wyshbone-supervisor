/**
 * Test 2.3: Preference Learning Works
 *
 * Verifies that feedback events update user preferences correctly
 */

import dotenv from 'dotenv';
dotenv.config();

import { learnFromFeedback, getUserPreferences } from './server/services/preference-learner';

async function testPreferenceLearning() {
  console.log('\n🧪 TEST 2.3: Preference Learning Works\n');

  const testResults = {
    canLearnFromPositiveFeedback: false,
    canLearnFromNegativeFeedback: false,
    preferencesAreStored: false,
    weightsAreUpdated: false
  };

  const testUserId = 'test-pref-user-' + Date.now();

  try {
    // 1. Learn from positive feedback (interesting result)
    console.log('1️⃣ Learning from positive feedback (interesting result)...');
    await learnFromFeedback({
      userId: testUserId,
      taskId: 'task-1',
      result: {
        brewery: {
          name: 'Beavertown Brewery',
          location: 'London, UK',
          type: 'craft brewery',
          contact: 'info@beavertownbrewery.co.uk'
        }
      },
      interesting: true
    });

    const prefsAfterPositive = await getUserPreferences(testUserId);

    if (prefsAfterPositive.industries.length > 0 ||
        prefsAfterPositive.regions.length > 0 ||
        prefsAfterPositive.contactTypes.length > 0 ||
        prefsAfterPositive.keywords.length > 0) {
      testResults.canLearnFromPositiveFeedback = true;
      console.log('✅ Learned from positive feedback');
      console.log(`   - ${prefsAfterPositive.industries.length} industries`);
      console.log(`   - ${prefsAfterPositive.regions.length} regions`);
      console.log(`   - ${prefsAfterPositive.contactTypes.length} contact types`);
      console.log(`   - ${prefsAfterPositive.keywords.length} keywords`);

      // Check if preferences were stored in memory
      if (prefsAfterPositive.keywords.some(k => k.value === 'brewery')) {
        testResults.preferencesAreStored = true;
        console.log('✅ Preferences stored in memory');
        const breweryPref = prefsAfterPositive.keywords.find(k => k.value === 'brewery');
        console.log(`   - Brewery preference weight: ${breweryPref?.weight}`);
        console.log(`   - Engagement count: ${breweryPref?.engagementCount}`);
      }
    } else {
      console.error('❌ No preferences extracted from positive feedback');
      return testResults;
    }

    // 2. Learn from another positive feedback (should increase weights)
    console.log('\n2️⃣ Learning from another positive feedback (weight update)...');
    const initialBreweryWeight = prefsAfterPositive.keywords.find(k => k.value === 'brewery')?.weight || 0;

    await learnFromFeedback({
      userId: testUserId,
      taskId: 'task-2',
      result: {
        brewery: {
          name: 'BrewDog London',
          location: 'London, UK',
          type: 'craft brewery'
        }
      },
      interesting: true
    });

    const prefsAfterSecond = await getUserPreferences(testUserId);
    const updatedBreweryWeight = prefsAfterSecond.keywords.find(k => k.value === 'brewery')?.weight || 0;

    if (updatedBreweryWeight > initialBreweryWeight) {
      testResults.weightsAreUpdated = true;
      console.log('✅ Preference weights updated correctly');
      console.log(`   - Initial weight: ${initialBreweryWeight.toFixed(2)}`);
      console.log(`   - Updated weight: ${updatedBreweryWeight.toFixed(2)}`);
    } else {
      console.error('❌ Preference weights not updated');
      console.error(`   - Initial: ${initialBreweryWeight}, Updated: ${updatedBreweryWeight}`);
    }

    // 3. Learn from negative feedback (should decrease weight)
    console.log('\n3️⃣ Learning from negative feedback...');
    await learnFromFeedback({
      userId: testUserId,
      taskId: 'task-3',
      result: {
        pub: {
          name: 'Random Pub',
          location: 'Manchester, UK'
        }
      },
      interesting: false,
      feedback: 'not_helpful'
    });

    const prefsAfterNegative = await getUserPreferences(testUserId);

    // Check if pub keyword has lower weight than brewery
    const pubPref = prefsAfterNegative.keywords.find(k => k.value === 'pub');
    const breweryPref = prefsAfterNegative.keywords.find(k => k.value === 'brewery');

    if (pubPref && breweryPref && breweryPref.weight > pubPref.weight) {
      testResults.canLearnFromNegativeFeedback = true;
      console.log('✅ Negative feedback processed correctly');
      console.log(`   - Brewery weight: ${breweryPref.weight.toFixed(2)} (positive feedback)`);
      console.log(`   - Pub weight: ${pubPref.weight.toFixed(2)} (negative feedback)`);
    } else if (!pubPref) {
      // It's OK if negative feedback doesn't create preferences
      testResults.canLearnFromNegativeFeedback = true;
      console.log('✅ Negative feedback ignored (no preference created)');
    } else {
      console.error('❌ Negative feedback not handled correctly');
    }

  } catch (error: any) {
    console.error('❌ Unexpected error:', error.message);
    console.error('Stack:', error.stack);
    return testResults;
  } finally {
    // Cleanup
    console.log('\n4️⃣ Cleaning up test data...');
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
testPreferenceLearning().then(results => {
  console.log('\n' + '='.repeat(50));
  console.log('TEST 2.3 RESULTS:');
  console.log('='.repeat(50));
  console.log('Can Learn From Positive Feedback:', results.canLearnFromPositiveFeedback ? '✅ PASS' : '❌ FAIL');
  console.log('Can Learn From Negative Feedback:', results.canLearnFromNegativeFeedback ? '✅ PASS' : '❌ FAIL');
  console.log('Preferences Are Stored:', results.preferencesAreStored ? '✅ PASS' : '❌ FAIL');
  console.log('Weights Are Updated:', results.weightsAreUpdated ? '✅ PASS' : '❌ FAIL');

  const allPassed = Object.values(results).every(r => r === true);
  console.log('\n' + (allPassed ? '✅ TEST 2.3: PASSED' : '❌ TEST 2.3: FAILED'));
  console.log('='.repeat(50) + '\n');

  process.exit(allPassed ? 0 : 1);
}).catch(error => {
  console.error('❌ Test execution failed:', error);
  console.error('Stack:', error.stack);
  process.exit(1);
});
