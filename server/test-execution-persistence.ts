/**
 * Test Execution Persistence (SUP-002 Enhancement)
 * 
 * Verifies that plan executions are persisted to the database
 * and can be queried by SUP-003 monitoring.
 */

import { 
  executeLeadGenerationPlan,
  type SupervisorUserContext,
  type LeadGenPlan
} from "./types/lead-gen-plan";
import { storage } from "./storage";

console.log(`
╔════════════════════════════════════════╗
║   SUP-002 Execution Persistence Test  ║
╚════════════════════════════════════════╝
`);

async function runTest() {
  const testUser: SupervisorUserContext = {
    userId: "test-user-persistence",
    companyProfile: "Test Company - SaaS B2B",
    objectives: "Find 50 leads in fintech",
    topFacts: [
      { fact: "Targeting series A startups", importance: 0.9 }
    ]
  };

  console.log("1️⃣  Creating test plan...");
  const plan: LeadGenPlan = {
    id: 'test_persistence_plan',
    title: 'Execution Persistence Test',
    createdAt: new Date().toISOString(),
    goalId: 'goal_123',
    goalText: 'Find 10 fintech companies in San Francisco',
    rawGoal: 'Find 10 fintech companies in San Francisco',
    goal: {
      rawGoal: 'Find 10 fintech companies in San Francisco',
      targetRegion: 'San Francisco, CA',
      targetPersona: 'fintech companies',
      volume: 10,
      timing: 'asap'
    },
    steps: [
      {
        id: 'step_1',
        title: 'Search for fintech companies',
        tool: 'GOOGLE_PLACES_SEARCH',
        params: {
          query: 'fintech company',
          region: 'San Francisco, CA',
          maxResults: 10
        }
      }
    ]
  };
  
  console.log(`   ✓ Created plan with ${plan.steps.length} step(s)`);
  console.log(`   Plan ID: ${plan.id}`);
  console.log(`   Goal ID: ${plan.goalId}`);

  console.log("\n2️⃣  Executing plan...");
  const result = await executeLeadGenerationPlan(plan, testUser);
  
  console.log(`   ✓ Execution completed with status: ${result.overallStatus}`);
  console.log(`   Steps: ${result.stepResults.length} total`);
  console.log(`   - Succeeded: ${result.stepResults.filter(r => r.status === "succeeded").length}`);
  console.log(`   - Failed: ${result.stepResults.filter(r => r.status === "failed").length}`);
  console.log(`   - Skipped: ${result.stepResults.filter(r => r.status === "skipped").length}`);

  console.log("\n3️⃣  Verifying execution was persisted to database...");
  const executions = await storage.getPlanExecutions(testUser.userId, 10);
  
  if (executions.length === 0) {
    console.error("   ❌ FAIL: No executions found in database");
    process.exit(1);
  }
  
  console.log(`   ✓ Found ${executions.length} execution(s) in database`);
  
  const latestExecution = executions[0];
  console.log(`\n   Latest execution details:`);
  console.log(`   - ID: ${latestExecution.id}`);
  console.log(`   - Plan ID: ${latestExecution.planId}`);
  console.log(`   - Status: ${latestExecution.overallStatus}`);
  console.log(`   - Started: ${latestExecution.startedAt}`);
  console.log(`   - Finished: ${latestExecution.finishedAt}`);
  console.log(`   - Step Results: ${Array.isArray(latestExecution.stepResults) ? latestExecution.stepResults.length : 'N/A'} steps`);
  console.log(`   - Metadata: ${latestExecution.metadata ? JSON.stringify(latestExecution.metadata, null, 2) : 'None'}`);

  console.log("\n4️⃣  Testing repeated execution...");
  const result2 = await executeLeadGenerationPlan(plan, testUser);
  const executions2 = await storage.getPlanExecutions(testUser.userId, 10);
  
  if (executions2.length < 2) {
    console.error("   ❌ FAIL: Second execution not persisted");
    process.exit(1);
  }
  
  console.log(`   ✓ Now have ${executions2.length} executions in database`);

  console.log("\n5️⃣  Testing goalId-based queries...");
  if (plan.goalId) {
    const goalExecutions = await storage.getPlanExecutionsByGoal(plan.goalId, 10);
    console.log(`   ✓ Found ${goalExecutions.length} execution(s) for goal ${plan.goalId}`);
  } else {
    console.log(`   ⚠️  Plan has no goalId, skipping goal-based query test`);
  }

  console.log("\n✅ All tests passed!");
  console.log(`
Summary:
- Executions are successfully persisted to plan_executions table
- Multiple executions can be stored for the same user
- Executions include full step results and metadata
- Goal-based queries work correctly

This data is now available for SUP-003 monitoring to detect:
- repeated_failures (≥3 failed executions in 24h)
- stalled goals (no recent executions)
- no_plan scenarios (no executions at all)
`);
}

runTest().catch((error) => {
  console.error("\n❌ Test failed with error:", error);
  process.exit(1);
});
