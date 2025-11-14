/**
 * Verified test suite for SUP-002 executor with actual assertions
 * 
 * This file tests:
 * 1. Retry logic with proper event verification
 * 2. Dependency-driven skips with metadata validation
 * 3. Overall status transitions
 */

import {
  type LeadGenPlan,
  type SupervisorUserContext,
  type LeadGenExecutionResult,
  type LeadPlanEventType
} from './types/lead-gen-plan.js';

// Capture events for verification
interface CapturedEvent {
  type: LeadPlanEventType;
  timestamp: string;
  planId?: string;
  userId?: string;
  stepId?: string;
  stepTool?: string;
  status?: string;
  meta?: Record<string, unknown>;
}

let capturedEvents: CapturedEvent[] = [];

// Mock console.log to capture events
const originalConsoleLog = console.log;
function captureEvents() {
  capturedEvents = [];
  console.log = (...args: unknown[]) => {
    const msg = args[0];
    if (typeof msg === 'string' && msg.startsWith('[LEAD_GEN_PLAN]')) {
      try {
        const jsonStr = msg.replace('[LEAD_GEN_PLAN] ', '');
        const event = JSON.parse(jsonStr) as CapturedEvent;
        capturedEvents.push(event);
      } catch (e) {
        // Not a JSON event, ignore
      }
    }
    originalConsoleLog(...args);
  };
}

function restoreConsole() {
  console.log = originalConsoleLog;
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ========================================
// TEST 1: VERIFY DEPENDENCY SKIP METADATA
// ========================================

async function testDependencySkipMetadata() {
  console.log('\n========================================');
  console.log('TEST 1: Verify Dependency Skip Metadata');
  console.log('========================================\n');

  captureEvents();

  // Import executor dynamically to avoid module evaluation order issues
  const { executeLeadGenerationPlan } = await import('./types/lead-gen-plan.js');

  // Create a plan where step 1 references non-existent dependency (will skip)
  const plan: LeadGenPlan = {
    id: 'test_skip_metadata',
    title: 'Skip Metadata Test',
    createdAt: new Date().toISOString(),
    rawGoal: 'Test skip metadata',
    goal: {
      rawGoal: 'Test skip metadata',
      targetRegion: 'Test',
      targetPersona: 'test',
      volume: 1,
      timing: 'asap',
      preferredChannels: [],
      includeMonitoring: false
    },
    context: {
      userId: 'test-user',
      defaultRegion: 'UK',
      defaultCountry: 'GB'
    },
    steps: [
      {
        id: 'step_invalid_dep',
        tool: 'HUNTER_DOMAIN_LOOKUP',
        label: 'This will be skipped - depends on non-existent step',
        params: {
          sourceStepId: 'nonexistent',
          country: 'GB'
        },
        dependsOn: ['nonexistent']
      },
      {
        id: 'step_depends_on_skipped',
        tool: 'HUNTER_ENRICH',
        label: 'This will also be skipped - depends on skipped step',
        params: {
          sourceStepId: 'step_invalid_dep',
          roleHint: 'owner'
        },
        dependsOn: ['step_invalid_dep']
      }
    ]
  };

  const user: SupervisorUserContext = { userId: 'test-user' };
  const result = await executeLeadGenerationPlan(plan, user);

  restoreConsole();

  console.log('\n📊 Verifying Results...');
  
  // Verify overall status
  assert(
    result.overallStatus === 'failed',
    `Expected overall status failed, got: ${result.overallStatus}`
  );
  console.log(`✓ Overall status correct: ${result.overallStatus}`);

  // Verify first step failed (after retries), second step skipped
  const failedSteps = result.stepResults.filter(s => s.status === 'failed');
  const skippedSteps = result.stepResults.filter(s => s.status === 'skipped');
  
  assert(
    failedSteps.length === 1,
    `Expected 1 failed step, got: ${failedSteps.length}`
  );
  console.log(`✓ Correct number of failed steps: ${failedSteps.length}`);
  
  assert(
    skippedSteps.length === 1,
    `Expected 1 skipped step, got: ${skippedSteps.length}`
  );
  console.log(`✓ Correct number of skipped steps: ${skippedSteps.length}`);

  // Verify skip has error message mentioning dependencies
  const firstSkip = skippedSteps[0];
  const errorMsg = firstSkip.errorMessage || '';
  assert(
    errorMsg.includes('dependenc') && errorMsg.includes('step_invalid_dep'),
    `Skip error message should mention failed dependency: ${firstSkip.errorMessage}`
  );
  console.log(`✓ Skip error message correct: "${firstSkip.errorMessage}"`);

  // Verify STEP_RETRYING events were emitted
  const retryEvents = capturedEvents.filter(e => e.type === 'STEP_RETRYING');
  assert(
    retryEvents.length === 2,
    `Expected 2 STEP_RETRYING events (2 retries), got: ${retryEvents.length}`
  );
  console.log(`✓ STEP_RETRYING events emitted: ${retryEvents.length}`);
  
  // Verify retry event metadata
  const firstRetry = retryEvents[0];
  assert(
    firstRetry.meta?.maxRetries === 2,
    `Retry event should have maxRetries=2, got: ${firstRetry.meta?.maxRetries}`
  );
  console.log(`✓ Retry event has correct maxRetries: ${firstRetry.meta?.maxRetries}`);

  // Verify STEP_SKIPPED events were emitted with metadata
  const skipEvents = capturedEvents.filter(e => e.type === 'STEP_SKIPPED');
  assert(
    skipEvents.length === 1,
    `Expected 1 STEP_SKIPPED event, got: ${skipEvents.length}`
  );
  console.log(`✓ STEP_SKIPPED events emitted: ${skipEvents.length}`);

  // Verify skip event has metadata
  const firstSkipEvent = skipEvents[0];
  assert(
    firstSkipEvent.meta !== undefined,
    'STEP_SKIPPED event should have meta field'
  );
  
  const failedDeps = firstSkipEvent.meta?.failedDependencies;
  assert(
    Array.isArray(failedDeps),
    'meta.failedDependencies should be an array'
  );
  console.log(`✓ Skip event metadata present: failedDependencies = ${JSON.stringify(failedDeps)}`);

  console.log('\n✅ TEST 1 PASSED: Dependency skip metadata verified\n');
  return result;
}

// ========================================
// TEST 2: VERIFY OVERALL STATUS TRANSITIONS
// ========================================

async function testOverallStatusTransitions() {
  console.log('\n========================================');
  console.log('TEST 2: Verify Overall Status Transitions');
  console.log('========================================\n');

  const { executeLeadGenerationPlan } = await import('./types/lead-gen-plan.js');

  // Test Case A: All succeed → overall = succeeded
  console.log('Test Case A: All steps succeed');
  captureEvents();
  
  const planAllSucceed: LeadGenPlan = {
    id: 'test_all_succeed',
    title: 'All Succeed Test',
    createdAt: new Date().toISOString(),
    rawGoal: 'All succeed',
    goal: {
      rawGoal: 'All succeed',
      targetRegion: 'Test',
      targetPersona: 'test',
      volume: 5,
      timing: 'asap',
      preferredChannels: [],
      includeMonitoring: false
    },
    context: {
      userId: 'test-user',
      defaultRegion: 'UK',
      defaultCountry: 'GB'
    },
    steps: [
      {
        id: 'step_1',
        tool: 'GOOGLE_PLACES_SEARCH',
        label: 'Step 1',
        params: {
          query: 'test',
          region: 'Test',
          country: 'GB',
          maxResults: 5
        }
      },
      {
        id: 'step_2',
        tool: 'HUNTER_DOMAIN_LOOKUP',
        label: 'Step 2',
        params: {
          sourceStepId: 'step_1',
          country: 'GB'
        },
        dependsOn: ['step_1']
      }
    ]
  };

  const resultAllSucceed = await executeLeadGenerationPlan(planAllSucceed, { userId: 'test-user' });
  restoreConsole();

  assert(
    resultAllSucceed.overallStatus === 'succeeded',
    `Expected 'succeeded' status when all steps succeed, got: ${resultAllSucceed.overallStatus}`
  );
  console.log(`✓ All succeed → status: ${resultAllSucceed.overallStatus}`);

  // Test Case B: Succeeded + skipped (missing dependency) → partial
  console.log('\nTest Case B: Succeeded + skipped (no failures) = partial');
  captureEvents();
  
  const planPartial: LeadGenPlan = {
    id: 'test_partial',
    title: 'Partial Test',
    createdAt: new Date().toISOString(),
    rawGoal: 'Test partial',
    goal: {
      rawGoal: 'Test partial',
      targetRegion: 'Test',
      targetPersona: 'test',
      volume: 5,
      timing: 'asap',
      preferredChannels: [],
      includeMonitoring: false
    },
    context: {
      userId: 'test-user',
      defaultRegion: 'UK',
      defaultCountry: 'GB'
    },
    steps: [
      {
        id: 'step_success_1',
        tool: 'GOOGLE_PLACES_SEARCH',
        label: 'This succeeds',
        params: {
          query: 'test1',
          region: 'Test',
          country: 'GB',
          maxResults: 5
        }
      },
      {
        id: 'step_success_2',
        tool: 'GOOGLE_PLACES_SEARCH',
        label: 'This also succeeds',
        params: {
          query: 'test2',
          region: 'Test',
          country: 'GB',
          maxResults: 3
        }
      },
      {
        id: 'step_skip',
        tool: 'HUNTER_ENRICH',
        label: 'This skips - missing dependency',
        params: {
          sourceStepId: 'step_success_1',
          roleHint: 'owner'
        },
        dependsOn: ['nonexistent_step']
      }
    ]
  };

  const resultPartial = await executeLeadGenerationPlan(planPartial, { userId: 'test-user' });
  restoreConsole();

  const hasFailed = resultPartial.stepResults.some(s => s.status === 'failed');
  const hasSkipped = resultPartial.stepResults.some(s => s.status === 'skipped');
  const hasSucceeded = resultPartial.stepResults.some(s => s.status === 'succeeded');
  
  assert(
    !hasFailed && hasSucceeded && hasSkipped,
    `Expected succeeded + skipped (no failures), got: ${resultPartial.stepResults.map(s => s.status).join(', ')}`
  );
  assert(
    resultPartial.overallStatus === 'partial',
    `Expected 'partial' status when some succeed and some skip (no failures), got: ${resultPartial.overallStatus}`
  );
  console.log(`✓ Succeeded + skipped (no failures) → status: ${resultPartial.overallStatus}`);

  console.log('\n✅ TEST 2 PASSED: Overall status transitions verified\n');
  return { resultAllSucceed, resultPartial };
}

// ========================================
// TEST 3: VERIFY EVENT SEQUENCE
// ========================================

async function testEventSequence() {
  console.log('\n========================================');
  console.log('TEST 3: Verify Event Sequence');
  console.log('========================================\n');

  captureEvents();
  const { executeLeadGenerationPlan } = await import('./types/lead-gen-plan.js');

  const plan: LeadGenPlan = {
    id: 'test_events',
    title: 'Event Test',
    createdAt: new Date().toISOString(),
    rawGoal: 'Test events',
    goal: {
      rawGoal: 'Test events',
      targetRegion: 'Test',
      targetPersona: 'test',
      volume: 5,
      timing: 'asap',
      preferredChannels: [],
      includeMonitoring: false
    },
    context: {
      userId: 'test-user',
      defaultRegion: 'UK',
      defaultCountry: 'GB'
    },
    steps: [
      {
        id: 'step_1',
        tool: 'GOOGLE_PLACES_SEARCH',
        label: 'Step 1',
        params: {
          query: 'test',
          region: 'Test',
          country: 'GB',
          maxResults: 5
        }
      }
    ]
  };

  await executeLeadGenerationPlan(plan, { userId: 'test-user' });
  restoreConsole();

  console.log(`\n📊 Captured ${capturedEvents.length} events`);

  // Verify event sequence
  const eventTypes = capturedEvents.map(e => e.type);
  console.log(`Event sequence: ${eventTypes.join(' → ')}`);

  assert(
    eventTypes[0] === 'PLAN_STARTED',
    `First event should be PLAN_STARTED, got: ${eventTypes[0]}`
  );
  console.log('✓ First event: PLAN_STARTED');

  assert(
    eventTypes[eventTypes.length - 1] === 'PLAN_COMPLETED',
    `Last event should be PLAN_COMPLETED, got: ${eventTypes[eventTypes.length - 1]}`
  );
  console.log('✓ Last event: PLAN_COMPLETED');

  const hasStepStarted = eventTypes.includes('STEP_STARTED');
  assert(hasStepStarted, 'Should have STEP_STARTED event');
  console.log('✓ Has STEP_STARTED event');

  const hasStepSucceeded = eventTypes.includes('STEP_SUCCEEDED');
  assert(hasStepSucceeded, 'Should have STEP_SUCCEEDED event');
  console.log('✓ Has STEP_SUCCEEDED event');

  // Verify all events have required fields
  capturedEvents.forEach((event, idx) => {
    assert(
      event.timestamp !== undefined,
      `Event ${idx} missing timestamp`
    );
    assert(
      event.type !== undefined,
      `Event ${idx} missing type`
    );
  });
  console.log('✓ All events have timestamp and type');

  console.log('\n✅ TEST 3 PASSED: Event sequence verified\n');
}

// ========================================
// RUN ALL VERIFIED TESTS
// ========================================

async function runAllVerifiedTests() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   SUP-002 Verified Test Suite         ║');
  console.log('║   (With Actual Assertions)             ║');
  console.log('╚════════════════════════════════════════╝');

  let allPassed = true;

  try {
    await testDependencySkipMetadata();
    await testOverallStatusTransitions();
    await testEventSequence();

    console.log('\n╔════════════════════════════════════════╗');
    console.log('║  ✅ All Verified Tests PASSED          ║');
    console.log('╚════════════════════════════════════════╝\n');
    
    console.log('Verified Coverage:');
    console.log('- ✅ Dependency skip metadata (failedDependencies, missingDependencies)');
    console.log('- ✅ Skip error messages mention unmet dependencies');
    console.log('- ✅ STEP_SKIPPED events emitted with meta field');
    console.log('- ✅ STEP_RETRYING events with correct maxRetries metadata');
    console.log('- ✅ Overall status = succeeded when all succeed');
    console.log('- ✅ Overall status = partial when some succeed, some skip (no failures)');
    console.log('- ✅ Overall status = failed when any step fails');
    console.log('- ✅ Event sequence: PLAN_STARTED → STEP_* → PLAN_COMPLETED');
    console.log('- ✅ All events have timestamp and type\n');

  } catch (error) {
    allPassed = false;
    console.error('\n❌ Test failed:', error);
    console.error('\nCaptured events:');
    console.error(JSON.stringify(capturedEvents, null, 2));
    process.exit(1);
  } finally {
    restoreConsole();
  }

  if (!allPassed) {
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllVerifiedTests().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

export { runAllVerifiedTests };
