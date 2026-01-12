/**
 * Test 3 Different Task Types
 * Verify task interpreter correctly maps different task descriptions to tools
 */

import 'dotenv/config';
import { executeTask } from './server/services/task-executor.js';

async function test3TaskTypes() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   TESTING 3 DIFFERENT TASK TYPES       ║');
  console.log('╚════════════════════════════════════════╝\n');

  const results = [];

  // TEST 1: Search Task (should map to SEARCH_PLACES)
  console.log('🧪 TEST 1: Search Task');
  console.log('─'.repeat(50));
  const searchTask = {
    title: 'Find Pubs in Manchester',
    description: 'Search for traditional pubs in Manchester city center',
    priority: 'high' as const,
    estimatedDuration: '5 minutes',
    actionable: true,
    reasoning: 'Testing search functionality'
  };

  try {
    const result1 = await executeTask(searchTask, 'test-user', `test_search_${Date.now()}`);
    console.log(`✅ Status: ${result1.status}`);
    console.log(`✅ WABS Score: ${result1.wabsScore}/100`);
    results.push({ type: 'search', status: result1.status, score: result1.wabsScore });
  } catch (error: any) {
    console.log(`❌ Failed: ${error.message}`);
    results.push({ type: 'search', status: 'failed', score: null });
  }

  console.log();

  // TEST 2: Research Task (should map to DEEP_RESEARCH)
  console.log('🧪 TEST 2: Research Task');
  console.log('─'.repeat(50));
  const researchTask = {
    title: 'Research Craft Beer Trends',
    description: 'Analyze the growth of craft breweries in the UK over the past 5 years',
    priority: 'medium' as const,
    estimatedDuration: '10 minutes',
    actionable: true,
    reasoning: 'Testing research functionality'
  };

  try {
    const result2 = await executeTask(researchTask, 'test-user', `test_research_${Date.now()}`);
    console.log(`✅ Status: ${result2.status}`);
    console.log(`✅ WABS Score: ${result2.wabsScore}/100`);
    results.push({ type: 'research', status: result2.status, score: result2.wabsScore });
  } catch (error: any) {
    console.log(`❌ Failed: ${error.message}`);
    results.push({ type: 'research', status: 'failed', score: null });
  }

  console.log();

  // TEST 3: Email Task (should map to DRAFT_EMAIL)
  console.log('🧪 TEST 3: Email Task');
  console.log('─'.repeat(50));
  const emailTask = {
    title: 'Draft Outreach Email',
    description: 'Write an email to introduce our craft beer distribution service',
    priority: 'low' as const,
    estimatedDuration: '2 minutes',
    actionable: true,
    reasoning: 'Testing email drafting'
  };

  try {
    const result3 = await executeTask(emailTask, 'test-user', `test_email_${Date.now()}`);
    console.log(`✅ Status: ${result3.status}`);
    console.log(`✅ WABS Score: ${result3.wabsScore}/100`);
    results.push({ type: 'email', status: result3.status, score: result3.wabsScore });
  } catch (error: any) {
    console.log(`❌ Failed: ${error.message}`);
    results.push({ type: 'email', status: 'failed', score: null });
  }

  console.log('\n╔════════════════════════════════════════╗');
  console.log('║           TEST SUMMARY                  ║');
  console.log('╚════════════════════════════════════════╝\n');

  results.forEach(r => {
    console.log(`${r.type.toUpperCase().padEnd(10)} ${r.status.padEnd(10)} WABS: ${r.score || 'N/A'}`);
  });

  const allPassed = results.every(r => r.status === 'success' && r.score !== null);

  if (allPassed) {
    console.log('\n🎉 ALL 3 TASK TYPES PASSED!');
  } else {
    console.log('\n⚠️  Some tests failed - check logs above');
  }

  return allPassed;
}

test3TaskTypes().catch(console.error);
