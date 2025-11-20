/**
 * Test script for Plan Execution Pipeline
 * 
 * Tests the full flow:
 * 1. Create a plan
 * 2. Approve the plan
 * 3. Execute with progress tracking
 * 4. Verify progress updates
 */

import { planLeadGenerationWithHistory, executeLeadGenerationPlan, onPlanEvent, type LeadGenGoal, type LeadGenContext, type SupervisorUserContext } from "./types/lead-gen-plan";
import { startPlanProgress, updateStepStatus, completePlan, failPlan, getProgress } from "./plan-progress";

async function testPlanExecutionPipeline() {
  console.log('\n========================================');
  console.log('TEST: Plan Execution Pipeline');
  console.log('========================================\n');

  // Test user context
  const userId = "test-user-pipeline";
  const sessionId = userId; // Using userId as session ID

  // Step 1: Create a plan
  console.log('1️⃣  Creating plan...');
  
  const goal: LeadGenGoal = {
    rawGoal: "Find 10 coffee shops in Manchester",
    targetRegion: "Manchester",
    targetPersona: "coffee shop owners",
    volume: 10,
    timing: "asap",
    preferredChannels: [],
    includeMonitoring: false
  };

  const context: LeadGenContext = {
    userId,
    accountId: "test-account",
    defaultRegion: "UK",
    defaultCountry: "GB",
    defaultFromIdentityId: "default-identity"
  };

  const plan = await planLeadGenerationWithHistory(goal, context);
  console.log(`✓ Created plan: ${plan.id}`);
  console.log(`  Steps: ${plan.steps.length}`);
  plan.steps.forEach((step, i) => {
    console.log(`    ${i + 1}. ${step.label || step.tool}`);
  });

  // Step 2: Initialize progress tracking
  console.log('\n2️⃣  Initializing progress tracking...');
  startPlanProgress(plan.id, sessionId, plan.steps);
  console.log('✓ Progress tracking initialized');

  let progress = getProgress(sessionId);
  console.log(`  Status: ${progress?.overallStatus}`);
  console.log(`  Steps pending: ${progress?.steps.filter(s => s.status === 'pending').length}`);

  // Step 3: Register event handler
  console.log('\n3️⃣  Registering progress event handler...');
  
  const eventLog: Array<{ type: string; stepId?: string; status?: string }> = [];
  
  onPlanEvent((eventType, payload) => {
    eventLog.push({ type: eventType, stepId: payload.stepId, status: payload.status });
    
    if (eventType === "STEP_STARTED") {
      updateStepStatus(sessionId, payload.stepId, "running");
      console.log(`  📍 Step started: ${payload.stepId}`);
    } else if (eventType === "STEP_SUCCEEDED") {
      updateStepStatus(sessionId, payload.stepId, "completed", undefined, payload.attempts);
      console.log(`  ✅ Step completed: ${payload.stepId} (${payload.attempts} attempts)`);
    } else if (eventType === "STEP_FAILED") {
      updateStepStatus(sessionId, payload.stepId, "failed", payload.error, payload.attempts);
      console.log(`  ❌ Step failed: ${payload.stepId} - ${payload.error}`);
    } else if (eventType === "STEP_SKIPPED") {
      console.log(`  ⏭️  Step skipped: ${payload.stepId}`);
    }
  });

  console.log('✓ Event handler registered');

  // Step 4: Execute the plan
  console.log('\n4️⃣  Executing plan...');
  
  const userContext: SupervisorUserContext = {
    userId,
    accountId: "test-account"
  };

  const result = await executeLeadGenerationPlan(plan, userContext);

  // Unregister handler
  onPlanEvent(null);

  // Step 5: Update final status
  console.log('\n5️⃣  Finalizing...');
  if (result.overallStatus === "succeeded") {
    completePlan(sessionId);
    console.log('✓ Plan completed successfully');
  } else {
    failPlan(sessionId, "Plan execution failed");
    console.log('✗ Plan failed');
  }

  // Step 6: Verify progress
  console.log('\n6️⃣  Verifying progress tracking...');
  progress = getProgress(sessionId);
  
  if (!progress) {
    console.log('✗ ERROR: No progress found!');
    return;
  }

  console.log(`✓ Final status: ${progress.overallStatus}`);
  console.log(`  Total events captured: ${eventLog.length}`);
  console.log('\n  Step Summary:');
  progress.steps.forEach((step, i) => {
    const icon = step.status === 'completed' ? '✅' : 
                 step.status === 'failed' ? '❌' : 
                 step.status === 'running' ? '🔄' :
                 step.status === 'pending' ? '⏸️' : '⏭️';
    console.log(`    ${icon} ${i + 1}. ${step.title} (${step.status})`);
  });

  console.log('\n  Event Log:');
  const eventSummary = eventLog.reduce((acc, evt) => {
    acc[evt.type] = (acc[evt.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  Object.entries(eventSummary).forEach(([type, count]) => {
    console.log(`    ${type}: ${count}`);
  });

  // Verification
  console.log('\n7️⃣  Verification...');
  const hasStartEvent = eventLog.some(e => e.type === 'PLAN_STARTED');
  const hasStepEvents = eventLog.some(e => e.type.startsWith('STEP_'));
  const hasEndEvent = eventLog.some(e => e.type === 'PLAN_COMPLETED' || e.type === 'PLAN_FAILED');
  
  console.log(`  ✓ Has PLAN_STARTED event: ${hasStartEvent}`);
  console.log(`  ✓ Has STEP events: ${hasStepEvents}`);
  console.log(`  ✓ Has end event: ${hasEndEvent}`);
  
  if (hasStartEvent && hasStepEvents && hasEndEvent) {
    console.log('\n✅ TEST PASSED: Full pipeline working correctly!');
  } else {
    console.log('\n❌ TEST FAILED: Missing expected events');
  }
}

// Run the test
testPlanExecutionPipeline()
  .then(() => {
    console.log('\n========================================');
    console.log('Test completed');
    console.log('========================================\n');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Test failed with error:', err);
    process.exit(1);
  });
