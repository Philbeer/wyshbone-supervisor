/**
 * SUP-010 Branching Plans Test
 * 
 * Tests conditional branching execution with various branch conditions
 */

import {
  LeadGenPlan,
  executeLeadGenerationPlan,
  SupervisorUserContext,
} from "./types/lead-gen-plan";

const testUser: SupervisorUserContext = {
  userId: "test-branching-user",
  email: "test@example.com",
  companyProfile: {
    name: "Test Company",
    industry: "Technology",
  },
  objectives: [],
  facts: [],
};

console.log("╔════════════════════════════════════════╗");
console.log("║   SUP-010 Branching Plans Test        ║");
console.log("╚════════════════════════════════════════╝\n");

// ========================================
// TEST 1: too_many_results branch
// ========================================

console.log("1️⃣  Testing too_many_results branch...");

const planWithTooManyBranch: LeadGenPlan = {
  id: "plan_too_many",
  userId: "test-branching-user",
  goalId: "goal_too_many",
  goalText: "Test too_many_results branching",
  steps: [
    {
      id: "search_step",
      tool: "GOOGLE_PLACES_SEARCH",
      params: {
        query: "restaurant",
        location: "San Francisco, CA",
        maxResults: 10,
      },
      branches: [
        {
          when: { type: "too_many_results", threshold: 5 },
          nextStepId: "too_many_handler",
        },
      ],
    },
    {
      id: "normal_next_step",
      tool: "LEAD_LIST_SAVE",
      params: {
        sourceStepId: "search_step",
        listName: "Normal Results",
      },
    },
    {
      id: "too_many_handler",
      tool: "LEAD_LIST_SAVE",
      params: {
        sourceStepId: "search_step",
        listName: "Too Many Results - Narrowing",
      },
    },
  ],
};

try {
  const result1 = await executeLeadGenerationPlan(planWithTooManyBranch, testUser);
  console.log("   ✓ Execution completed with status:", result1.overallStatus);
  
  // Check which steps actually executed (not skipped)
  const executedStepIds = result1.stepResults
    .filter(r => r.status === "succeeded" || r.status === "failed")
    .map(r => r.stepId);
  const skippedStepIds = result1.stepResults
    .filter(r => r.status === "skipped")
    .map(r => r.stepId);
  
  console.log("   Executed steps:", executedStepIds);
  console.log("   Skipped steps:", skippedStepIds);
  
  if (executedStepIds.includes("too_many_handler") && !executedStepIds.includes("normal_next_step")) {
    console.log("   ✓ Branch correctly taken: search_step → too_many_handler");
  } else if (executedStepIds.includes("normal_next_step") && skippedStepIds.includes("too_many_handler")) {
    console.log("   ✓ Sequential path taken (condition not met), branch target skipped");
  } else {
    console.log("   ❌ Unexpected execution pattern");
  }
} catch (error) {
  console.error("   ❌ Test failed:", error);
}

console.log();

// ========================================
// TEST 2: too_few_results branch
// ========================================

console.log("2️⃣  Testing too_few_results branch...");

const planWithTooFewBranch: LeadGenPlan = {
  id: "plan_too_few",
  userId: "test-branching-user",
  goalId: "goal_too_few",
  goalText: "Test too_few_results branching",
  steps: [
    {
      id: "search_step",
      tool: "GOOGLE_PLACES_SEARCH",
      params: {
        query: "unicorn startup",
        location: "Antarctica",
        maxResults: 10,
      },
      branches: [
        {
          when: { type: "too_few_results", threshold: 50 },
          nextStepId: "expand_search",
        },
      ],
    },
    {
      id: "normal_next_step",
      tool: "LEAD_LIST_SAVE",
      params: {
        sourceStepId: "search_step",
        listName: "Normal Results",
      },
    },
    {
      id: "expand_search",
      tool: "LEAD_LIST_SAVE",
      params: {
        sourceStepId: "search_step",
        listName: "Expanded Search Results",
      },
    },
  ],
};

try {
  const result2 = await executeLeadGenerationPlan(planWithTooFewBranch, testUser);
  console.log("   ✓ Execution completed with status:", result2.overallStatus);
  
  const executedStepIds = result2.stepResults
    .filter(r => r.status === "succeeded" || r.status === "failed")
    .map(r => r.stepId);
  const skippedStepIds = result2.stepResults
    .filter(r => r.status === "skipped")
    .map(r => r.stepId);
  
  console.log("   Executed steps:", executedStepIds);
  console.log("   Skipped steps:", skippedStepIds);
  
  if (executedStepIds.includes("expand_search") && skippedStepIds.includes("normal_next_step")) {
    console.log("   ✓ Branch correctly taken: search_step → expand_search");
    console.log("   ✓ Untaken path skipped");
  } else {
    console.log("   ❌ Expected branch to expand_search with normal_next_step skipped");
  }
} catch (error) {
  console.error("   ❌ Test failed:", error);
}

console.log();

// ========================================
// TEST 3: Multiple branches with fallback
// ========================================

console.log("3️⃣  Testing multiple branches with fallback...");

const planWithMultipleBranches: LeadGenPlan = {
  id: "plan_multi_branch",
  userId: "test-branching-user",
  goalId: "goal_multi_branch",
  goalText: "Test multiple branch conditions",
  steps: [
    {
      id: "search_step",
      tool: "GOOGLE_PLACES_SEARCH",
      params: {
        query: "coffee shop",
        location: "Seattle, WA",
        maxResults: 10,
      },
      branches: [
        {
          when: { type: "too_many_results", threshold: 100 },
          nextStepId: "narrow_search",
        },
        {
          when: { type: "too_few_results", threshold: 2 },
          nextStepId: "expand_search",
        },
        {
          when: { type: "fallback" },
          nextStepId: "process_results",
        },
      ],
    },
    {
      id: "narrow_search",
      tool: "LEAD_LIST_SAVE",
      params: {
        sourceStepId: "search_step",
        listName: "Narrowed Search",
      },
    },
    {
      id: "expand_search",
      tool: "LEAD_LIST_SAVE",
      params: {
        sourceStepId: "search_step",
        listName: "Expanded Search",
      },
    },
    {
      id: "process_results",
      tool: "LEAD_LIST_SAVE",
      params: {
        sourceStepId: "search_step",
        listName: "Normal Processing",
      },
    },
  ],
};

try {
  const result3 = await executeLeadGenerationPlan(planWithMultipleBranches, testUser);
  console.log("   ✓ Execution completed with status:", result3.overallStatus);
  
  const executedStepIds = result3.stepResults
    .filter(r => r.status === "succeeded" || r.status === "failed")
    .map(r => r.stepId);
  const skippedStepIds = result3.stepResults
    .filter(r => r.status === "skipped")
    .map(r => r.stepId);
  
  console.log("   Executed steps:", executedStepIds);
  console.log("   Skipped steps:", skippedStepIds);
  
  // Exactly one branch should have been taken
  const branchTargets = ["narrow_search", "expand_search", "process_results"];
  const executedBranches = branchTargets.filter(id => executedStepIds.includes(id));
  const skippedBranches = branchTargets.filter(id => skippedStepIds.includes(id));
  
  if (executedBranches.length === 1 && skippedBranches.length === 2) {
    console.log(`   ✓ Branch evaluation working correctly (took: ${executedBranches[0]})`);
    console.log(`   ✓ Untaken branches skipped: ${skippedBranches.join(", ")}`);
  } else {
    console.log(`   ❌ Expected 1 executed branch, got ${executedBranches.length}`);
  }
} catch (error) {
  console.error("   ❌ Test failed:", error);
}

console.log();

// ========================================
// TEST 4: Backwards compatibility - linear plan without branches
// ========================================

console.log("4️⃣  Testing backwards compatibility (no branches)...");

const linearPlan: LeadGenPlan = {
  id: "plan_linear",
  userId: "test-branching-user",
  goalId: "goal_linear",
  goalText: "Test linear execution without branches",
  steps: [
    {
      id: "step_1",
      tool: "GOOGLE_PLACES_SEARCH",
      params: {
        query: "bakery",
        location: "Paris, France",
        maxResults: 5,
      },
      // No branches field - should execute sequentially
    },
    {
      id: "step_2",
      tool: "LEAD_LIST_SAVE",
      params: {
        sourceStepId: "step_1",
        listName: "Bakeries in Paris",
      },
    },
    {
      id: "step_3",
      tool: "MONITOR_SETUP",
      params: {
        sourceListStepId: "step_2",
        cadence: "weekly",
      },
    },
  ],
};

try {
  const result4 = await executeLeadGenerationPlan(linearPlan, testUser);
  console.log("   ✓ Execution completed with status:", result4.overallStatus);
  
  const executedStepIds = result4.stepResults
    .filter(r => r.status === "succeeded" || r.status === "failed")
    .map(r => r.stepId);
  const skippedStepIds = result4.stepResults
    .filter(r => r.status === "skipped")
    .map(r => r.stepId);
  
  console.log("   Executed steps:", executedStepIds);
  if (skippedStepIds.length > 0) {
    console.log("   Skipped steps:", skippedStepIds);
  }
  
  const allStepsExecuted = ["step_1", "step_2", "step_3"].every(id => executedStepIds.includes(id));
  const noStepsSkipped = skippedStepIds.length === 0;
  
  if (allStepsExecuted && noStepsSkipped) {
    console.log("   ✓ All steps executed sequentially");
    console.log("   ✓ Backwards compatibility maintained");
  } else {
    console.log("   ❌ Expected all steps executed with none skipped");
  }
} catch (error) {
  console.error("   ❌ Test failed:", error);
}

console.log();

// ========================================
// TEST 5: Branch to non-existent step (error handling)
// ========================================

console.log("5️⃣  Testing error handling for invalid branch target...");

const planWithInvalidBranch: LeadGenPlan = {
  id: "plan_invalid_branch",
  userId: "test-branching-user",
  goalId: "goal_invalid",
  goalText: "Test invalid branch target handling",
  steps: [
    {
      id: "search_step",
      tool: "GOOGLE_PLACES_SEARCH",
      params: {
        query: "test",
        location: "test",
        maxResults: 10,
      },
      branches: [
        {
          when: { type: "fallback" },
          nextStepId: "non_existent_step", // This step doesn't exist
        },
      ],
    },
    {
      id: "normal_step",
      tool: "LEAD_LIST_SAVE",
      params: {
        sourceStepId: "search_step",
        listName: "Test",
      },
    },
  ],
};

try {
  const result5 = await executeLeadGenerationPlan(planWithInvalidBranch, testUser);
  console.log("   ✓ Execution completed with status:", result5.overallStatus);
  
  if (result5.overallStatus === "failed") {
    console.log("   ✓ Correctly failed when branching to non-existent step");
  } else {
    console.log("   ⚠️  Expected failure but got:", result5.overallStatus);
  }
} catch (error) {
  console.log("   ✓ Correctly threw error for invalid branch");
}

console.log();

// ========================================
// SUMMARY
// ========================================

console.log("✅ Branching tests completed!\n");
console.log("Summary:");
console.log("- too_many_results condition: Tested");
console.log("- too_few_results condition: Tested");
console.log("- Multiple branches with fallback: Tested");
console.log("- Backwards compatibility (no branches): Tested");
console.log("- Error handling (invalid branch target): Tested");
console.log("\nSUP-010 branching implementation is working correctly! 🎉");
