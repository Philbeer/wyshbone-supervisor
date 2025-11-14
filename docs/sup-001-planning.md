# SUP-001: Lead Generation Planning Module

## Overview

The Lead Generation Planning module provides a **pure, deterministic planning function** that generates execution plans for lead generation workflows. The planner constructs a DAG (Directed Acyclic Graph) of tool execution steps without actually running any tools or making external API calls.

## Key Concepts

### Pure Planning
- **No side effects**: The planner doesn't execute tools, make API calls, or modify state
- **Deterministic**: Same inputs always produce the same plan
- **Separation of concerns**: Planning is separate from execution

### Plan Structure
A `LeadGenPlan` consists of:
- **Goal**: What the user wants to achieve
- **Context**: User environment and preferences
- **Steps**: Ordered list of tool executions with dependencies

## Implementation

**Location**: `server/types/lead-gen-plan.ts`

### Core Types

```typescript
// Tool identifiers used in lead generation
type LeadToolIdentifier =
  | "GOOGLE_PLACES_SEARCH"    // Find businesses via Google Places API
  | "HUNTER_DOMAIN_LOOKUP"    // Discover company domains
  | "HUNTER_ENRICH"           // Find contact emails at domains
  | "EMAIL_SEQUENCE_SETUP"    // Configure email outreach sequence
  | "LEAD_LIST_SAVE"          // Persist enriched leads
  | "MONITOR_SETUP";          // Set up ongoing monitoring

// Each plan step
interface LeadGenPlanStep {
  id: string;                  // Unique step identifier
  label?: string;              // Human-readable description
  tool: LeadToolIdentifier;    // Which tool to execute
  params: Record<string, unknown>; // Tool parameters
  dependsOn?: string[];        // Step IDs that must complete first
  note?: string;               // Optional explanation
}

// Complete plan
interface LeadGenPlan {
  id: string;                  // Plan identifier
  title: string;               // Plan title/description
  goal: LeadGenGoal;          // Structured goal
  context: LeadGenContext;    // Execution context
  steps: LeadGenPlanStep[];   // Ordered execution steps
  createdAt: string;          // ISO timestamp
  priority?: "low" | "normal" | "high";
}
```

### Planning Function

```typescript
function planLeadGeneration(
  goal: LeadGenGoal,
  context: LeadGenContext
): LeadGenPlan
```

**Inputs:**
- `goal.rawGoal`: Free-text user goal (e.g., "Find 50 pubs in the North West")
- `goal.targetRegion`: Geographic region to target
- `goal.targetPersona`: Type of business/person to target
- `goal.volume`: Number of leads desired
- `goal.timing`: When to execute (e.g., "this week", "asap")
- `goal.preferredChannels`: Communication channels (e.g., ["email"])
- `goal.includeMonitoring`: Whether to set up ongoing monitoring

**Context:**
- `context.userId`: User identifier
- `context.defaultRegion`: Fallback region if not specified in goal
- `context.defaultCountry`: Fallback country code
- `context.defaultFromIdentityId`: Email sender identity for sequences

**Output:**
A `LeadGenPlan` with 4-6 steps depending on goal requirements.

## Example Plans

### Full Plan (with email + monitoring)

**Goal**: "Find 50 pubs in the North West and email the landlords this week"

**Generated Steps:**
1. **GOOGLE_PLACES_SEARCH**: Find 100 pub candidates in North West, UK
2. **HUNTER_DOMAIN_LOOKUP**: Discover domains for found businesses
3. **HUNTER_ENRICH**: Find contact emails for "pub landlords" at those domains
4. **LEAD_LIST_SAVE**: Store enriched leads in a named list
5. **EMAIL_SEQUENCE_SETUP**: Create email campaign targeting the saved leads
6. **MONITOR_SETUP**: Set up weekly monitoring for profile changes

### Minimal Plan (no email)

**Goal**: "Find 20 coffee shops in London"

**Generated Steps:**
1. **GOOGLE_PLACES_SEARCH**: Find 40 coffee shop candidates in London
2. **HUNTER_DOMAIN_LOOKUP**: Discover domains
3. **HUNTER_ENRICH**: Find contacts at those domains
4. **LEAD_LIST_SAVE**: Store leads

## Dependency Graph

The planner creates a proper DAG where each step declares its dependencies:

```
google_places_1 (no deps)
    ↓
hunter_domain_lookup_2 (depends on: google_places_1)
    ↓
hunter_enrich_3 (depends on: hunter_domain_lookup_2)
    ↓
lead_list_save_4 (depends on: hunter_enrich_3)
    ↙         ↘
email_sequence_5   monitor_6
(depends on: 4)    (depends on: 4)
```

This ensures:
- Steps execute in the correct order
- Parallel execution is possible where no dependencies exist
- Executor can validate and optimize execution

## Usage

### Basic Usage

```typescript
import { planLeadGeneration } from './types/lead-gen-plan.js';

const plan = planLeadGeneration(
  {
    rawGoal: "Find breweries in Manchester",
    targetRegion: "Manchester",
    targetPersona: "craft breweries",
    volume: 25,
    timing: "asap",
    preferredChannels: ["email"],
    includeMonitoring: false
  },
  {
    userId: "user-123",
    defaultRegion: "UK",
    defaultCountry: "GB",
    defaultFromIdentityId: "identity-456"
  }
);

console.log(`Generated plan with ${plan.steps.length} steps`);
plan.steps.forEach(step => {
  console.log(`- ${step.label} (${step.tool})`);
});
```

### Testing

Run the test file to verify planning:

```bash
tsx server/test-plan.ts
```

This demonstrates:
- Full plan with all features (email + monitoring)
- Minimal plan (no email, no monitoring)
- Dependency chain validation

## Integration with Supervisor

The planning module is designed to integrate with the Supervisor's execution system:

1. **Goal Capture**: UI/chat captures user goals
2. **Planning**: `planLeadGeneration()` creates execution plan
3. **Execution**: Supervisor executor runs each step in dependency order
4. **Monitoring**: Track plan execution status and results

## Future Enhancements

### Near-term
- Plan storage (persist plans to database)
- Plan modification/editing
- Plan templates for common patterns
- Cost estimation before execution

### Medium-term
- Multi-stage plans with conditional branching
- Plan optimization (combine steps, remove redundancy)
- A/B testing different plan strategies
- Plan analytics and success metrics

### Long-term
- ML-based plan optimization
- Auto-generated plans from conversation analysis
- Dynamic replanning based on execution results

## Testing

All tests pass with zero LSP errors:

```bash
✅ Pure planning (no external calls)
✅ Correct dependency chains
✅ Conditional logic (email, monitoring)
✅ Parameter normalization
✅ TypeScript type safety
```

## Control Tower Integration

The export API now reports:
```json
{
  "sup001_plannerEnabled": true
}
```

Control Tower can automatically mark SUP-001 as complete.

## Files

- **Implementation**: `server/types/lead-gen-plan.ts` (415 lines)
- **Tests**: `server/test-plan.ts`
- **Documentation**: `docs/sup-001-planning.md`
- **Export API**: `server/utils/exporter.ts` (flag enabled)

## Summary

SUP-001 provides a solid foundation for structured lead generation planning. The pure planning approach enables:
- Clear separation of concerns
- Easier testing and debugging
- Plan optimization and analysis
- Flexible execution strategies

The next step (SUP-002) will implement the executor that reads these plans and actually runs the tools.
