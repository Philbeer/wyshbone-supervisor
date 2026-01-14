/**
 * Test DAG Mutation Engine
 *
 * Comprehensive test suite for DAG mutation operations:
 * - Add nodes
 * - Remove nodes
 * - Modify dependencies
 * - Validate constraints
 * - Track mutation history
 */

import {
  validateDAG,
  addStep,
  removeStep,
  modifyStepDependencies,
  replaceStep,
  getMutationHistory,
  clearMutationHistory
} from '../dag-mutator';
import type { LeadGenPlan, LeadGenPlanStep } from '../types/lead-gen-plan';
import { storage } from '../storage';

// ========================================
// TEST HELPERS
// ========================================

function createTestPlan(): LeadGenPlan {
  return {
    id: 'test_plan_' + Date.now(),
    userId: 'test-user',
    goal: {
      rawGoal: 'Test plan for DAG mutations',
      targetRegion: 'UK',
      targetPersona: 'test personas'
    },
    steps: [
      {
        id: 'step_1',
        label: 'Step 1',
        tool: 'GOOGLE_PLACES_SEARCH',
        params: { query: 'test' }
      },
      {
        id: 'step_2',
        label: 'Step 2',
        tool: 'HUNTER_DOMAIN_LOOKUP',
        params: {},
        dependsOn: ['step_1']
      },
      {
        id: 'step_3',
        label: 'Step 3',
        tool: 'LEAD_LIST_SAVE',
        params: {},
        dependsOn: ['step_2']
      }
    ],
    createdAt: Date.now(),
    estimatedCost: 0
  };
}

function createTestStep(id: string, dependsOn?: string[]): LeadGenPlanStep {
  return {
    id,
    label: `Test Step ${id}`,
    tool: 'LEAD_LIST_SAVE',
    params: {},
    dependsOn
  };
}

async function savePlanToStorage(plan: LeadGenPlan): Promise<string> {
  await storage.savePlan({
    userId: plan.userId,
    planData: plan as any,
    status: 'pending',
    createdAt: plan.createdAt
  });
  return plan.id;
}

// ========================================
// TESTS
// ========================================

async function testDAGValidation() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 1: DAG Validation');
  console.log('='.repeat(60) + '\n');

  // Test 1a: Valid DAG
  const validPlan = createTestPlan();
  const validation1 = validateDAG(validPlan);
  console.log('✓ Valid DAG:', validation1.valid ? 'PASS' : 'FAIL');
  if (!validation1.valid) {
    console.error('  Errors:', validation1.errors);
  }

  // Test 1b: Cycle detection
  const cyclicPlan = createTestPlan();
  cyclicPlan.steps[0].dependsOn = ['step_3']; // Creates cycle
  const validation2 = validateDAG(cyclicPlan);
  console.log('✓ Cycle detection:', !validation2.valid ? 'PASS' : 'FAIL');
  if (!validation2.valid) {
    console.log('  Detected:', validation2.errors[0]);
  }

  // Test 1c: Missing dependency
  const invalidPlan = createTestPlan();
  invalidPlan.steps[1].dependsOn = ['nonexistent_step'];
  const validation3 = validateDAG(invalidPlan);
  console.log('✓ Missing dependency:', !validation3.valid ? 'PASS' : 'FAIL');

  // Test 1d: Duplicate step IDs
  const dupPlan = createTestPlan();
  dupPlan.steps.push({ ...dupPlan.steps[0] });
  const validation4 = validateDAG(dupPlan);
  console.log('✓ Duplicate IDs:', !validation4.valid ? 'PASS' : 'FAIL');

  console.log('');
  return validation1.valid && !validation2.valid && !validation3.valid && !validation4.valid;
}

async function testAddStep() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 2: Add Step to Running DAG');
  console.log('='.repeat(60) + '\n');

  const plan = createTestPlan();
  const planId = await savePlanToStorage(plan);

  // Test 2a: Add step at end
  const newStep1 = createTestStep('step_4', ['step_3']);
  const result1 = await addStep(planId, newStep1, {
    reason: 'Testing add step'
  });
  console.log('✓ Add step at end:', result1.success ? 'PASS' : 'FAIL');
  if (!result1.success) {
    console.error('  Error:', result1.error);
  }

  // Test 2b: Insert after specific step
  const newStep2 = createTestStep('step_2b', ['step_2']);
  const result2 = await addStep(planId, newStep2, {
    insertAfter: 'step_2',
    reason: 'Testing insert after'
  });
  console.log('✓ Insert after step:', result2.success ? 'PASS' : 'FAIL');

  // Test 2c: Duplicate step ID (should fail)
  const dupStep = createTestStep('step_1');
  const result3 = await addStep(planId, dupStep);
  console.log('✓ Reject duplicate ID:', !result3.success ? 'PASS' : 'FAIL');

  // Test 2d: Invalid dependency (should fail)
  const badStep = createTestStep('step_bad', ['nonexistent']);
  const result4 = await addStep(planId, badStep);
  console.log('✓ Reject bad dependency:', !result4.success ? 'PASS' : 'FAIL');

  console.log('');
  return result1.success && result2.success && !result3.success && !result4.success;
}

async function testRemoveStep() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 3: Remove Step from DAG');
  console.log('='.repeat(60) + '\n');

  const plan = createTestPlan();
  const planId = await savePlanToStorage(plan);

  // Test 3a: Remove leaf step (no dependents)
  const result1 = await removeStep(planId, 'step_3', {
    reason: 'Testing remove leaf'
  });
  console.log('✓ Remove leaf step:', result1.success ? 'PASS' : 'FAIL');

  // Test 3b: Try to remove step with dependents (should fail without updateDependencies)
  const plan2 = createTestPlan();
  const planId2 = await savePlanToStorage(plan2);
  const result2 = await removeStep(planId2, 'step_2', {
    updateDependencies: false
  });
  console.log('✓ Reject remove with dependents:', !result2.success ? 'PASS' : 'FAIL');

  // Test 3c: Remove step with updateDependencies (should succeed)
  const plan3 = createTestPlan();
  const planId3 = await savePlanToStorage(plan3);
  const result3 = await removeStep(planId3, 'step_2', {
    updateDependencies: true,
    reason: 'Testing remove with dependency update'
  });
  console.log('✓ Remove with dependency update:', result3.success ? 'PASS' : 'FAIL');

  console.log('');
  return result1.success && !result2.success && result3.success;
}

async function testModifyDependencies() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 4: Modify Step Dependencies');
  console.log('='.repeat(60) + '\n');

  const plan = createTestPlan();
  const planId = await savePlanToStorage(plan);

  // Test 4a: Change dependencies
  const result1 = await modifyStepDependencies(planId, 'step_3', ['step_1'], {
    reason: 'Testing modify dependencies'
  });
  console.log('✓ Modify dependencies:', result1.success ? 'PASS' : 'FAIL');

  // Test 4b: Create cycle (should fail)
  const result2 = await modifyStepDependencies(planId, 'step_1', ['step_3'], {
    reason: 'Testing cycle creation'
  });
  console.log('✓ Reject cycle creation:', !result2.success ? 'PASS' : 'FAIL');

  // Test 4c: Invalid dependency (should fail)
  const plan3 = createTestPlan();
  const planId3 = await savePlanToStorage(plan3);
  const result3 = await modifyStepDependencies(planId3, 'step_2', ['nonexistent']);
  console.log('✓ Reject invalid dependency:', !result3.success ? 'PASS' : 'FAIL');

  // Test 4d: Remove all dependencies
  const plan4 = createTestPlan();
  const planId4 = await savePlanToStorage(plan4);
  const result4 = await modifyStepDependencies(planId4, 'step_2', []);
  console.log('✓ Remove all dependencies:', result4.success ? 'PASS' : 'FAIL');

  console.log('');
  return result1.success && !result2.success && !result3.success && result4.success;
}

async function testReplaceStep() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 5: Replace Step');
  console.log('='.repeat(60) + '\n');

  const plan = createTestPlan();
  const planId = await savePlanToStorage(plan);

  // Test 5a: Replace step with new implementation
  const newStep = createTestStep('step_2', ['step_1']);
  newStep.label = 'Replaced Step 2';
  newStep.tool = 'HUNTER_ENRICH';
  const result1 = await replaceStep(planId, 'step_2', newStep, {
    reason: 'Testing replace step'
  });
  console.log('✓ Replace step:', result1.success ? 'PASS' : 'FAIL');

  // Test 5b: Replace with wrong ID (should fail)
  const plan2 = createTestPlan();
  const planId2 = await savePlanToStorage(plan2);
  const badStep = createTestStep('different_id');
  const result2 = await replaceStep(planId2, 'step_2', badStep);
  console.log('✓ Reject wrong ID:', !result2.success ? 'PASS' : 'FAIL');

  console.log('');
  return result1.success && !result2.success;
}

async function testMutationHistory() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 6: Mutation History Tracking');
  console.log('='.repeat(60) + '\n');

  const plan = createTestPlan();
  const planId = await savePlanToStorage(plan);

  // Clear any previous history
  clearMutationHistory(planId);

  // Perform several mutations
  await addStep(planId, createTestStep('step_4'), { reason: 'Add step 4' });
  await modifyStepDependencies(planId, 'step_2', ['step_1'], { reason: 'Change deps' });
  await removeStep(planId, 'step_4', { reason: 'Remove step 4' });

  // Get history
  const history = getMutationHistory(planId);
  console.log('✓ History tracked:', history.length === 3 ? 'PASS' : 'FAIL');
  console.log('  Mutations recorded:', history.length);

  // Check mutation types
  const types = history.map(m => m.type);
  const hasAdd = types.includes('ADD_STEP');
  const hasModify = types.includes('MODIFY_DEPENDENCIES');
  const hasRemove = types.includes('REMOVE_STEP');
  console.log('✓ All types recorded:', hasAdd && hasModify && hasRemove ? 'PASS' : 'FAIL');

  // Check timestamps are sequential
  const timestamps = history.map(m => m.timestamp);
  const sequential = timestamps.every((t, i) => i === 0 || t >= timestamps[i - 1]);
  console.log('✓ Sequential timestamps:', sequential ? 'PASS' : 'FAIL');

  // Check reasons are stored
  const hasReasons = history.every(m => m.reason !== undefined);
  console.log('✓ Reasons stored:', hasReasons ? 'PASS' : 'FAIL');

  console.log('');
  return history.length === 3 && hasAdd && hasModify && hasRemove && sequential && hasReasons;
}

async function testConstraintValidation() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 7: Constraint Validation');
  console.log('='.repeat(60) + '\n');

  // Test 7a: Maintain acyclic property
  const plan1 = createTestPlan();
  const planId1 = await savePlanToStorage(plan1);
  const result1 = await modifyStepDependencies(planId1, 'step_1', ['step_3']);
  console.log('✓ Prevent cycles:', !result1.success ? 'PASS' : 'FAIL');

  // Test 7b: Ensure dependencies exist
  const plan2 = createTestPlan();
  const planId2 = await savePlanToStorage(plan2);
  const badStep = createTestStep('new_step', ['fake_step']);
  const result2 = await addStep(planId2, badStep);
  console.log('✓ Validate dependencies exist:', !result2.success ? 'PASS' : 'FAIL');

  // Test 7c: No duplicate IDs
  const plan3 = createTestPlan();
  const planId3 = await savePlanToStorage(plan3);
  const dupStep = createTestStep('step_1');
  const result3 = await addStep(planId3, dupStep);
  console.log('✓ Prevent duplicate IDs:', !result3.success ? 'PASS' : 'FAIL');

  // Test 7d: Valid DAG after mutation
  const plan4 = createTestPlan();
  const planId4 = await savePlanToStorage(plan4);
  const newStep = createTestStep('step_4', ['step_2']);
  await addStep(planId4, newStep);
  const dbPlan = await storage.getPlan(planId4);
  const validation = validateDAG(dbPlan!.planData as LeadGenPlan);
  console.log('✓ Valid DAG after mutation:', validation.valid ? 'PASS' : 'FAIL');

  console.log('');
  return !result1.success && !result2.success && !result3.success && validation.valid;
}

// ========================================
// MAIN TEST RUNNER
// ========================================

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('  DAG MUTATION ENGINE TEST SUITE');
  console.log('  (Phase 3 Task 5)');
  console.log('='.repeat(70));

  const results: { [key: string]: boolean } = {};

  try {
    results['DAG Validation'] = await testDAGValidation();
    results['Add Step'] = await testAddStep();
    results['Remove Step'] = await testRemoveStep();
    results['Modify Dependencies'] = await testModifyDependencies();
    results['Replace Step'] = await testReplaceStep();
    results['Mutation History'] = await testMutationHistory();
    results['Constraint Validation'] = await testConstraintValidation();

    console.log('\n' + '='.repeat(70));
    console.log('TEST RESULTS');
    console.log('='.repeat(70) + '\n');

    let passed = 0;
    let failed = 0;

    for (const [test, result] of Object.entries(results)) {
      const status = result ? '✅ PASS' : '❌ FAIL';
      console.log(`${status} - ${test}`);
      if (result) passed++;
      else failed++;
    }

    console.log('');
    console.log('='.repeat(70));
    console.log(`SUMMARY: ${passed}/${passed + failed} tests passed`);
    console.log('='.repeat(70) + '\n');

    if (failed === 0) {
      console.log('🎉 All tests passed!');
      process.exit(0);
    } else {
      console.log('⚠️  Some tests failed');
      process.exit(1);
    }

  } catch (error: any) {
    console.error('\n❌ TEST SUITE FAILED:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
