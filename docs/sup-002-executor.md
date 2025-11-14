# SUP-002: Lead Generation Plan Executor

## Overview

The Lead Generation Plan Executor implements the execution engine for plans created by SUP-001. It takes a `LeadGenPlan` and actually runs each step, managing dependencies, retries, failures, and logging.

## Key Concepts

### Execution vs. Planning
- **SUP-001 (Planner)**: Pure function that generates plans (no side effects)
- **SUP-002 (Executor)**: Runs plans and executes tools (has side effects)

### Execution Flow
1. **Plan Reception**: Receives a `LeadGenPlan` from SUP-001
2. **Dependency Resolution**: Executes steps in order, respecting `dependsOn`
3. **Tool Routing**: Routes each step to the appropriate tool implementation
4. **Retry Logic**: Retries failed steps with exponential backoff
5. **Result Collection**: Aggregates all step results into final execution result

## Implementation

**Location**: `server/types/lead-gen-plan.ts` (same file as SUP-001)

### Core Types

```typescript
// User context for execution
interface SupervisorUserContext {
  userId: string;
  accountId?: string;
  email?: string;
}

// Step execution status
type LeadGenStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

// Result of executing a single step
interface LeadGenStepResult {
  stepId: string;
  status: LeadGenStepStatus;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  errorMessage?: string;
  data?: unknown;
}

// Overall execution result
interface LeadGenExecutionResult {
  planId: string;
  overallStatus: "succeeded" | "partial" | "failed";
  startedAt: string;
  finishedAt: string;
  stepResults: LeadGenStepResult[];
}
```

### Main Executor Function

```typescript
async function executeLeadGenerationPlan(
  plan: LeadGenPlan,
  user: SupervisorUserContext
): Promise<LeadGenExecutionResult>
```

**Algorithm:**
1. Initialize bookkeeping (step results, overall status)
2. Emit PLAN_STARTED event
3. For each step in plan.steps:
   - Check if any dependencies failed → skip if yes
   - Execute step with retries (max 2 retries, exponential backoff)
   - Store result and update overall status
4. Determine final status (succeeded/partial/failed)
5. Emit PLAN_COMPLETED event
6. Return comprehensive results

**Status Determination:**
- **succeeded**: All steps succeeded
- **partial**: Some steps succeeded, some skipped (due to dependency failures)
- **failed**: One or more steps failed

### Tool Execution Layer

```typescript
async function runLeadTool(
  tool: LeadToolIdentifier,
  params: LeadToolParams,
  env: LeadToolExecutionEnv
): Promise<LeadToolExecutionResult>
```

**Single routing point for all tools:**
- GOOGLE_PLACES_SEARCH → `executeGooglePlacesSearch()`
- HUNTER_DOMAIN_LOOKUP → `executeHunterDomainLookup()`
- HUNTER_ENRICH → `executeHunterEnrich()`
- LEAD_LIST_SAVE → `executeLeadListSave()`
- EMAIL_SEQUENCE_SETUP → `executeEmailSequenceSetup()`
- MONITOR_SETUP → `executeMonitorSetup()`

**Adding new tools:** Just add a new case to the switch statement.

### Retry Logic

```typescript
async function executeStepWithRetries(
  step: LeadGenPlanStep,
  plan: LeadGenPlan,
  user: SupervisorUserContext,
  stepResults: Record<string, LeadGenStepResult>,
  maxRetries: number,
  baseDelayMs: number
): Promise<LeadGenStepResult>
```

**Retry behavior:**
- Max retries: 2 (total of 3 attempts)
- Base delay: 1000ms
- Backoff: `delayMs = baseDelayMs * attempt` (exponential)
- Delays: 1s, 2s, 3s (for retries)

**Retry events:**
- Attempt 1: STEP_STARTED
- Attempt 2+: STEP_RETRYING
- Success: STEP_SUCCEEDED
- Final failure: STEP_FAILED

### Structured Logging

```typescript
function emitPlanEvent(
  type: LeadPlanEventType,
  payload: LeadPlanEventPayload
): void
```

**Event Types:**
- PLAN_STARTED - Plan execution begins
- PLAN_COMPLETED - Plan execution finishes
- STEP_STARTED - Step begins first attempt
- STEP_SUCCEEDED - Step completes successfully
- STEP_FAILED - Step fails after all retries
- STEP_SKIPPED - Step skipped due to dependency failure
- STEP_RETRYING - Step retrying after failure

**Log Format:**
```json
{
  "timestamp": "2025-11-14T01:22:18.501Z",
  "type": "STEP_STARTED",
  "planId": "lead_plan_1763083338499",
  "userId": "test-user-1",
  "stepId": "google_places_1",
  "stepTool": "GOOGLE_PLACES_SEARCH",
  "status": "running"
}
```

## Tool Implementations

Each tool implementation follows this pattern:
1. Extract parameters from `params` (type-cast through `unknown`)
2. Validate dependencies (check `env.priorResults` if needed)
3. Execute tool logic (currently stubbed)
4. Return `{ success: true, data }` or `{ success: false, errorMessage }`

### Example: Google Places Search

```typescript
async function executeGooglePlacesSearch(
  params: LeadToolParams,
  env: LeadToolExecutionEnv
): Promise<LeadToolExecutionResult> {
  const { query, region, country, maxResults = 20 } = 
    params as unknown as GooglePlacesSearchParams;
  
  console.log(`🔍 GOOGLE_PLACES_SEARCH: "${query}" in ${region}, ${country}`);
  
  // TODO: Integrate with existing searchGooglePlaces method
  const businesses = [...]; // Stub data for now
  
  return {
    success: true,
    data: { businesses, count: businesses.length }
  };
}
```

### Data Flow Between Steps

Steps reference prior results via `sourceStepId`:

```typescript
// Step 2: HUNTER_DOMAIN_LOOKUP references Step 1
const sourceResult = env.priorResults[sourceStepId];
if (!sourceResult || sourceResult.status !== "succeeded") {
  return { success: false, errorMessage: "Source step failed" };
}

const sourceData = sourceResult.data as { businesses?: Array<...> };
const businesses = sourceData?.businesses || [];

// Process businesses to extract domains...
```

This creates a **data pipeline** where each step transforms the output of previous steps.

## Usage Examples

### Basic Execution

```typescript
import {
  planLeadGeneration,
  executeLeadGenerationPlan
} from './types/lead-gen-plan.js';

// Create plan (SUP-001)
const plan = planLeadGeneration(
  {
    rawGoal: "Find 20 coffee shops in Manchester",
    targetRegion: "Manchester",
    targetPersona: "coffee shop owners",
    volume: 20,
    timing: "asap",
    preferredChannels: [],
    includeMonitoring: false
  },
  {
    userId: "user-123",
    defaultRegion: "UK",
    defaultCountry: "GB"
  }
);

// Execute plan (SUP-002)
const user = {
  userId: "user-123",
  email: "user@example.com"
};

const result = await executeLeadGenerationPlan(plan, user);

console.log(`Status: ${result.overallStatus}`);
console.log(`Steps: ${result.stepResults.length}`);
result.stepResults.forEach(step => {
  console.log(`  ${step.stepId}: ${step.status}`);
});
```

### Handling Results

```typescript
const result = await executeLeadGenerationPlan(plan, user);

switch (result.overallStatus) {
  case "succeeded":
    console.log("✅ All steps completed successfully");
    break;
  
  case "partial":
    console.log("⚠️  Some steps were skipped");
    const failed = result.stepResults.filter(s => s.status === "failed");
    console.log(`Failed steps: ${failed.map(s => s.stepId).join(', ')}`);
    break;
  
  case "failed":
    console.log("❌ Plan execution failed");
    const errors = result.stepResults
      .filter(s => s.errorMessage)
      .map(s => `${s.stepId}: ${s.errorMessage}`);
    console.error(errors.join('\n'));
    break;
}
```

## Testing

**Test File**: `server/test-executor.ts`

Run tests:
```bash
tsx server/test-executor.ts
```

**Test Coverage:**
1. ✅ Successful plan execution (4 steps)
2. ✅ Full plan with email + monitoring (6 steps)
3. ✅ Dependency chain verification
4. ✅ Structured event logging
5. ✅ Tool routing to all 6 tool types
6. ✅ Data propagation between steps

**Example Output:**
```
╔════════════════════════════════════════╗
║  Lead Gen Plan Executor Test Suite    ║
║  (SUP-002)                             ║
╚════════════════════════════════════════╝

========================================
TEST 1: Successful Plan Execution
========================================

📋 Created plan: Find 20 coffee shops in Manchester
   Steps: 4

[LEAD_GEN_PLAN] {"timestamp":"...","type":"PLAN_STARTED",...}
🔍 GOOGLE_PLACES_SEARCH: "coffee shop owners" in Manchester, GB (max: 40)
[LEAD_GEN_PLAN] {"timestamp":"...","type":"STEP_SUCCEEDED",...}
🌐 HUNTER_DOMAIN_LOOKUP: Looking up domains from step google_places_1
...

📊 Execution Results:
   Overall Status: succeeded
   Duration: 5ms
   Steps:
     ✅ google_places_1: succeeded (1 attempts)
     ✅ hunter_domain_lookup_2: succeeded (1 attempts)
     ✅ hunter_enrich_3: succeeded (1 attempts)
     ✅ lead_list_save_4: succeeded (1 attempts)
```

## Current Status

**Implementation Status:**
- ✅ All types defined
- ✅ Tool routing layer complete (6 tools)
- ✅ Retry logic with exponential backoff
- ✅ Dependency handling
- ✅ Structured event logging
- ✅ Comprehensive test coverage

**Tool Integration:**
- ⚠️  Tools currently use stub implementations
- ⚠️  TODO: Connect to actual Supervisor methods:
  - `executeGooglePlacesSearch` → `supervisor.searchGooglePlaces()`
  - `executeHunterEnrich` → `supervisor.findEmails()`
  - `executeLeadListSave` → `storage.createSuggestedLead()`

## Integration Points

### With Supervisor

The executor can be integrated into Supervisor's chat task processing:

```typescript
// In supervisor.ts
import { planLeadGeneration, executeLeadGenerationPlan } from './types/lead-gen-plan.js';

async function processChatTask(task: SupervisorTask) {
  // 1. Extract goal from task
  const goal = extractGoalFromTask(task);
  
  // 2. Build context from user profile
  const context = await buildPlanContext(task.user_id);
  
  // 3. Generate plan (SUP-001)
  const plan = planLeadGeneration(goal, context);
  
  // 4. Execute plan (SUP-002)
  const user = { userId: task.user_id };
  const result = await executeLeadGenerationPlan(plan, user);
  
  // 5. Format results for chat response
  return formatExecutionResultsForChat(result);
}
```

### With UI

The execution results can be streamed to UI:

```typescript
// Store plan execution in database
await storage.savePlanExecution(result);

// Post results to chat
await supabase.from('messages').insert({
  conversation_id: task.conversation_id,
  role: 'assistant',
  content: formatResults(result),
  source: 'supervisor',
  metadata: {
    plan_id: result.planId,
    overall_status: result.overallStatus,
    lead_count: countLeadsGenerated(result)
  }
});
```

## Future Enhancements

### Near-term
- Connect tool stubs to real implementations
- Add plan execution persistence
- Stream real-time progress updates to UI
- Add cancellation support

### Medium-term
- Parallel step execution (for independent steps)
- Smarter retry strategies (per-tool configuration)
- Resource limits and quotas
- Execution history and analytics

### Long-term
- Plan resumption after failures
- Dynamic replanning based on intermediate results
- Cost estimation and budget tracking
- A/B testing different execution strategies

## Files

- **Implementation**: `server/types/lead-gen-plan.ts` (988 lines total)
- **Tests**: `server/test-executor.ts` (242 lines)
- **Documentation**: `docs/sup-002-executor.md`
- **Export API**: `server/utils/exporter.ts` (flag already enabled)

## Summary

SUP-002 provides a robust execution engine for lead generation plans:
- ✅ Executes plans step-by-step with proper dependency handling
- ✅ Routes to 6 different tool types through single integration point
- ✅ Retries failures with exponential backoff
- ✅ Emits structured events for monitoring/debugging
- ✅ Returns comprehensive execution results
- ✅ Easy to extend with new tools

The executor is production-ready in structure, with tool implementations currently stubbed. Integration with actual Supervisor methods is the next step.
