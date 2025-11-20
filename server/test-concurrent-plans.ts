/**
 * Test concurrent plan executions to verify event handler isolation
 * 
 * Validates that multiple plans can execute simultaneously without
 * interfering with each other's progress tracking.
 */

import { planLeadGenerationWithHistory, executeLeadGenerationPlan, registerPlanEventHandler, unregisterPlanEventHandler, type LeadGenGoal, type LeadGenContext, type SupervisorUserContext } from "./types/lead-gen-plan";
import { startPlanProgress, updateStepStatus, completePlan, failPlan, getProgress } from "./plan-progress";

async function executePlanWithTracking(
  goal: LeadGenGoal,
  userId: string,
  accountId: string
): Promise<{ planId: string; events: string[]; finalStatus: string }> {
  const sessionId = userId;
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
  console.log(`[${userId}] Created plan ${plan.id}`);

  // Initialize progress
  startPlanProgress(plan.id, sessionId, plan.steps);

  // Register event handler for this plan
  registerPlanEventHandler(plan.id, (eventType, payload) => {
    events.push(`${eventType}:${payload.stepId || 'plan'}`);
    
    if (eventType === "STEP_STARTED") {
      updateStepStatus(sessionId, payload.stepId, "running");
    } else if (eventType === "STEP_SUCCEEDED") {
      updateStepStatus(sessionId, payload.stepId, "completed", undefined, payload.attempts);
    } else if (eventType === "STEP_FAILED") {
      updateStepStatus(sessionId, payload.stepId, "failed", payload.error, payload.attempts);
    }
  });

  try {
    // Execute plan
    const userContext: SupervisorUserContext = { userId, accountId };
    const result = await executeLeadGenerationPlan(plan, userContext);

    if (result.overallStatus === "succeeded") {
      completePlan(sessionId);
    } else {
      failPlan(sessionId, "Plan failed");
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

async function testConcurrentExecutions() {
  console.log('\n========================================');
  console.log('TEST: Concurrent Plan Executions');
  console.log('========================================\n');

  // Define two different goals for two different users
  const goal1: LeadGenGoal = {
    rawGoal: "Find 5 coffee shops in Manchester",
    targetRegion: "Manchester",
    targetPersona: "coffee shop owners",
    volume: 5,
    timing: "asap",
    preferredChannels: [],
    includeMonitoring: false
  };

  const goal2: LeadGenGoal = {
    rawGoal: "Find 8 restaurants in London",
    targetRegion: "London",
    targetPersona: "restaurant owners",
    volume: 8,
    timing: "asap",
    preferredChannels: [],
    includeMonitoring: false
  };

  console.log('1️⃣  Starting two plans concurrently...\n');

  // Execute both plans concurrently
  const [result1, result2] = await Promise.all([
    executePlanWithTracking(goal1, "user1", "account1"),
    executePlanWithTracking(goal2, "user2", "account2")
  ]);

  console.log('\n2️⃣  Verifying results...\n');

  // Verify plan 1
  console.log(`Plan 1 (${result1.planId}):`);
  console.log(`  Final status: ${result1.finalStatus}`);
  console.log(`  Events captured: ${result1.events.length}`);
  console.log(`  Event types: ${[...new Set(result1.events.map(e => e.split(':')[0]))].join(', ')}`);

  // Verify plan 2
  console.log(`\nPlan 2 (${result2.planId}):`);
  console.log(`  Final status: ${result2.finalStatus}`);
  console.log(`  Events captured: ${result2.events.length}`);
  console.log(`  Event types: ${[...new Set(result2.events.map(e => e.split(':')[0]))].join(', ')}`);

  // Verification checks
  console.log('\n3️⃣  Verification checks...\n');

  const checks = {
    plan1HasEvents: result1.events.length > 0,
    plan2HasEvents: result2.events.length > 0,
    plan1Succeeded: result1.finalStatus === "succeeded",
    plan2Succeeded: result2.finalStatus === "succeeded",
    eventsNotMixed: !result1.events.some(e => e.includes(result2.planId)) && 
                    !result2.events.some(e => e.includes(result1.planId)),
    bothHaveStepEvents: result1.events.some(e => e.startsWith('STEP_')) && 
                        result2.events.some(e => e.startsWith('STEP_'))
  };

  Object.entries(checks).forEach(([check, passed]) => {
    const icon = passed ? '✅' : '❌';
    console.log(`  ${icon} ${check}: ${passed}`);
  });

  // Final result
  const allChecksPassed = Object.values(checks).every(v => v);
  
  console.log('\n4️⃣  Final result...\n');
  
  if (allChecksPassed) {
    console.log('✅ TEST PASSED: Concurrent executions work correctly!');
    console.log('   - Both plans executed successfully');
    console.log('   - Events properly isolated per plan');
    console.log('   - No cross-contamination detected');
  } else {
    console.log('❌ TEST FAILED: Concurrent execution issues detected');
    console.log(`   Failed checks: ${Object.entries(checks).filter(([_, v]) => !v).map(([k]) => k).join(', ')}`);
  }

  return allChecksPassed;
}

// Run the test
testConcurrentExecutions()
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
