/**
 * Test WABS Scorer - Verify all 4 signals work
 */

import 'dotenv/config';
import { scoreResult } from './server/services/wabs-scorer';

async function testWABSScorer() {
  console.log('🧪 Testing WABS Scorer\n');

  // Test Case 1: High-scoring result (should be interesting)
  console.log('Test 1: High-Quality Brewery Result');
  const highQualityResult = {
    name: 'Camden Town Brewery',
    description: 'New craft brewery hiring brewers - urgent opening',
    email: 'jobs@camden.com',
    phone: '+44 20 1234 5678',
    website: 'https://camdentownbrewery.com',
    address: '55-59 Wilkin Street Mews, London',
    city: 'London',
    hours: 'Mon-Sun 12pm-11pm',
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    booking_url: 'https://camdentownbrewery.com/book',
    deadline: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() // 2 days from now
  };

  const score1 = await scoreResult({
    result: highQualityResult,
    query: 'find craft breweries in London hiring brewers',
    userId: 'test-user-1',
    userPreferences: [
      { key: 'craft beer', weight: 0.9 },
      { key: 'london', weight: 0.8 }
    ]
  });

  console.log(`Score: ${score1.score}/100`);
  console.log(`Signals:`, score1.signals);
  console.log(`Interesting: ${score1.isInteresting ? 'YES ✅' : 'NO ❌'}`);
  console.log(`Explanation: ${score1.explanation}`);
  console.log('');

  // Test Case 2: Low-scoring result (should NOT be interesting)
  console.log('Test 2: Low-Quality Generic Result');
  const lowQualityResult = {
    name: 'Generic Place',
    text: 'Some text here'
    // Missing: contact info, location, recency, urgency
  };

  const score2 = await scoreResult({
    result: lowQualityResult,
    query: 'find craft breweries in London',
    userId: 'test-user-2'
  });

  console.log(`Score: ${score2.score}/100`);
  console.log(`Signals:`, score2.signals);
  console.log(`Interesting: ${score2.isInteresting ? 'YES ✅' : 'NO ❌'}`);
  console.log(`Explanation: ${score2.explanation}`);
  console.log('');

  // Test Case 3: Medium-scoring result
  console.log('Test 3: Medium-Quality Result');
  const mediumResult = {
    name: 'Local Pub',
    description: 'Traditional pub with craft beers',
    address: '123 High Street, London',
    phone: '+44 20 9999 8888',
    updated_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days ago
  };

  const score3 = await scoreResult({
    result: mediumResult,
    query: 'find craft beer pubs in London',
    userId: 'test-user-3'
  });

  console.log(`Score: ${score3.score}/100`);
  console.log(`Signals:`, score3.signals);
  console.log(`Interesting: ${score3.isInteresting ? 'YES ✅' : 'NO ❌'}`);
  console.log(`Explanation: ${score3.explanation}`);
  console.log('');

  // Verification
  console.log('═══════════════════════════════════════');
  console.log('VERIFICATION CHECKLIST:');
  console.log('═══════════════════════════════════════');
  console.log(`✓ Scorer returns score 0-100: ${score1.score >= 0 && score1.score <= 100 ? 'PASS' : 'FAIL'}`);
  console.log(`✓ All 4 signals present: ${Object.keys(score1.signals).length === 4 ? 'PASS' : 'FAIL'}`);
  console.log(`✓ High-quality result scored >= 70: ${score1.score >= 70 ? 'PASS' : 'FAIL'}`);
  console.log(`✓ Low-quality result scored < 70: ${score2.score < 70 ? 'PASS' : 'FAIL'}`);
  console.log(`✓ isInteresting flag works: ${(score1.isInteresting && !score2.isInteresting) ? 'PASS' : 'FAIL'}`);
  console.log(`✓ Explanation generated: ${score1.explanation.length > 0 ? 'PASS' : 'FAIL'}`);
  console.log(`✓ Weights included: ${score1.weights ? 'PASS' : 'FAIL'}`);

  const allPassed = score1.score >= 0 && score1.score <= 100 &&
                    Object.keys(score1.signals).length === 4 &&
                    score1.score >= 70 &&
                    score2.score < 70 &&
                    score1.isInteresting &&
                    !score2.isInteresting;

  console.log('');
  console.log(`OVERALL: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);

  process.exit(allPassed ? 0 : 1);
}

testWABSScorer().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
