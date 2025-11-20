/**
 * Test progress cleanup after plan completion
 * 
 * Validates that clearProgress() correctly removes plan entries
 * from the progress store to prevent memory leaks.
 */

import { planLeadGenerationWithHistory, type LeadGenGoal, type LeadGenContext } from "./types/lead-gen-plan";
import { startPlanProgress, completePlan, getProgress, clearProgress, getAllActivePlans } from "./plan-progress";

async function testProgressCleanup() {
  console.log('\n========================================');
  console.log('TEST: Progress Cleanup');
  console.log('========================================\n');

  const userId = "test-cleanup-user";
  const accountId = "test-cleanup-account";

  // Create a simple plan
  const goal: LeadGenGoal = {
    rawGoal: "Find 2 bookstores in Oxford",
    targetRegion: "Oxford",
    targetPersona: "bookstore owners",
    volume: 2,
    timing: "asap",
    preferredChannels: [],
    includeMonitoring: false
  };

  const context: LeadGenContext = {
    userId,
    accountId,
    defaultRegion: "UK",
    defaultCountry: "GB",
    defaultFromIdentityId: "default-identity"
  };

  console.log('1️⃣  Creating plan...');
  const plan = await planLeadGenerationWithHistory(goal, context);
  console.log(`   ✓ Created plan: ${plan.id}`);

  console.log('\n2️⃣  Starting progress tracking...');
  startPlanProgress(plan.id, userId, plan.steps);
  
  let activePlans = getAllActivePlans();
  console.log(`   ✓ Active plans: ${activePlans.length}`);
  console.log(`   ✓ Includes our plan: ${activePlans.includes(plan.id)}`);

  console.log('\n3️⃣  Completing plan...');
  completePlan(plan.id);
  
  let progress = getProgress(plan.id);
  console.log(`   ✓ Progress status: ${progress?.overallStatus}`);
  console.log(`   ✓ Progress exists: ${progress !== null}`);

  console.log('\n4️⃣  Clearing progress...');
  clearProgress(plan.id);
  
  progress = getProgress(plan.id);
  activePlans = getAllActivePlans();
  
  console.log(`   ✓ Progress after clear: ${progress === null ? 'null (cleared)' : 'still exists'}`);
  console.log(`   ✓ Active plans count: ${activePlans.length}`);
  console.log(`   ✓ Plan removed from store: ${!activePlans.includes(plan.id)}`);

  // Verification
  console.log('\n5️⃣  Verification...\n');
  
  const checks = {
    progressCleared: progress === null,
    planRemovedFromStore: !activePlans.includes(plan.id),
  };

  Object.entries(checks).forEach(([check, passed]) => {
    const icon = passed ? '✅' : '❌';
    console.log(`  ${icon} ${check}: ${passed}`);
  });

  const allChecksPassed = Object.values(checks).every(v => v);
  
  console.log('\n6️⃣  Final result...\n');
  
  if (allChecksPassed) {
    console.log('✅ TEST PASSED: Progress cleanup works correctly!');
    console.log('   - Completed plans can be cleared');
    console.log('   - No memory leaks');
  } else {
    console.log('❌ TEST FAILED: Cleanup issues detected');
  }

  return allChecksPassed;
}

// Run the test
testProgressCleanup()
  .then((passed) => {
    console.log('\n========================================');
    console.log('Test completed');
    console.log('========================================\n');
    process.exit(passed ? 0 : 1);
  })
  .catch(err => {
    console.error('\n❌ Test failed with error:', err);
    process.exit(1);
  });
