/**
 * Test same user launching multiple plans sequentially
 * 
 * Validates that progress tracking correctly handles multiple plans
 * for the same user without overwriting each other.
 */

import { planLeadGenerationWithHistory, executeLeadGenerationPlan, registerPlanEventHandler, unregisterPlanEventHandler, type LeadGenGoal, type LeadGenContext, type SupervisorUserContext } from "./types/lead-gen-plan";
import { startPlanProgress, updateStepStatus, completePlan, failPlan, getProgress, getUserProgress } from "./plan-progress";

async function executePlanWithTracking(
  goal: LeadGenGoal,
  userId: string,
  accountId: string,
  planLabel: string
): Promise<{ planId: string; events: string[]; finalStatus: string }> {
  const events: string[] = [];

  // Create plan
  const context: LeadGenContext = {
    userId,
    accountId,
    defaultRegion: "UK",
    defaultCountry: "GB",
    defaultFromIdentityId: "default-identity"
  };

  const plan = await planLeadGenerationWithHistory(goal, context);
  console.log(`[${planLabel}] Created plan ${plan.id}`);

  // Initialize progress
  startPlanProgress(plan.id, userId, plan.steps);

  // Register event handler for this plan
  registerPlanEventHandler(plan.id, (eventType, payload) => {
    events.push(`${eventType}:${payload.stepId || 'plan'}`);
    
    if (eventType === "STEP_STARTED") {
      updateStepStatus(plan.id, payload.stepId, "running");
    } else if (eventType === "STEP_SUCCEEDED") {
      updateStepStatus(plan.id, payload.stepId, "completed", undefined, payload.attempts);
    } else if (eventType === "STEP_FAILED") {
      updateStepStatus(plan.id, payload.stepId, "failed", payload.error, payload.attempts);
    }
  });

  try {
    // Execute plan
    const userContext: SupervisorUserContext = { userId, accountId };
    const result = await executeLeadGenerationPlan(plan, userContext);

    if (result.overallStatus === "succeeded") {
      completePlan(plan.id);
    } else {
      failPlan(plan.id, "Plan failed");
    }

    return {
      planId: plan.id,
      events,
      finalStatus: result.overallStatus
    };
  } finally {
    unregisterPlanEventHandler(plan.id);
  }
}

async function testSameUserMultiplePlans() {
  console.log('\n========================================');
  console.log('TEST: Same User Multiple Plans');
  console.log('========================================\n');

  const userId = "test-user-same";
  const accountId = "test-account";

  // Define two different goals for the same user
  const goal1: LeadGenGoal = {
    rawGoal: "Find 3 gyms in Bristol",
    targetRegion: "Bristol",
    targetPersona: "gym owners",
    volume: 3,
    timing: "asap",
    preferredChannels: [],
    includeMonitoring: false
  };

  const goal2: LeadGenGoal = {
    rawGoal: "Find 5 cafes in Leeds",
    targetRegion: "Leeds",
    targetPersona: "cafe owners",
    volume: 5,
    timing: "asap",
    preferredChannels: [],
    includeMonitoring: false
  };

  console.log('1️⃣  Executing first plan...\n');
  const result1 = await executePlanWithTracking(goal1, userId, accountId, "Plan 1");

  console.log('\n2️⃣  Executing second plan (same user)...\n');
  const result2 = await executePlanWithTracking(goal2, userId, accountId, "Plan 2");

  console.log('\n3️⃣  Verifying both plans tracked separately...\n');

  // Verify each plan can be accessed by planId
  const progress1 = getProgress(result1.planId);
  const progress2 = getProgress(result2.planId);

  console.log(`Plan 1 (${result1.planId}):`);
  console.log(`  Final status: ${result1.finalStatus}`);
  console.log(`  Progress status: ${progress1?.overallStatus}`);
  console.log(`  Events captured: ${result1.events.length}`);

  console.log(`\nPlan 2 (${result2.planId}):`);
  console.log(`  Final status: ${result2.finalStatus}`);
  console.log(`  Progress status: ${progress2?.overallStatus}`);
  console.log(`  Events captured: ${result2.events.length}`);

  // Verify getUserProgress returns the most recent plan
  const userRecentProgress = getUserProgress(userId);
  console.log(`\nUser's most recent plan: ${userRecentProgress?.planId}`);
  console.log(`  Expected: ${result2.planId}`);
  console.log(`  Match: ${userRecentProgress?.planId === result2.planId ? '✅' : '❌'}`);

  // Verification checks
  console.log('\n4️⃣  Verification checks...\n');

  const checks = {
    plan1Exists: progress1 !== null,
    plan2Exists: progress2 !== null,
    plan1Completed: progress1?.overallStatus === "completed",
    plan2Completed: progress2?.overallStatus === "completed",
    differentPlanIds: result1.planId !== result2.planId,
    plan1HasEvents: result1.events.length > 0,
    plan2HasEvents: result2.events.length > 0,
    userRecentIsCorrect: userRecentProgress?.planId === result2.planId
  };

  Object.entries(checks).forEach(([check, passed]) => {
    const icon = passed ? '✅' : '❌';
    console.log(`  ${icon} ${check}: ${passed}`);
  });

  // Final result
  const allChecksPassed = Object.values(checks).every(v => v);
  
  console.log('\n5️⃣  Final result...\n');
  
  if (allChecksPassed) {
    console.log('✅ TEST PASSED: Same user can execute multiple plans!');
    console.log('   - Both plans executed successfully');
    console.log('   - Progress tracked independently per plan');
    console.log('   - getUserProgress returns most recent plan');
  } else {
    console.log('❌ TEST FAILED: Issues with same-user multiple plans');
    console.log(`   Failed checks: ${Object.entries(checks).filter(([_, v]) => !v).map(([k]) => k).join(', ')}`);
  }

  return allChecksPassed;
}

// Run the test
testSameUserMultiplePlans()
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
