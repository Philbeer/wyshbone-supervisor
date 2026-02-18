# Supervisor Codebase Audit — State of Truth Report

**Date:** 2026-02-18
**Scope:** delivery_summary, CVL, Tower verdict, DB schema, delta plan for 1-day implementation

---

## Section A: Where delivery_summary Currently Comes From

### Primary function
`server/supervisor/delivery-summary.ts` — `buildDeliverySummaryPayload(input)` + `emitDeliverySummary(input)`

### Inputs used
| Field | Source | Notes |
|-------|--------|-------|
| `leads` (DeliverySummaryLeadInput[]) | Accumulated lead map from executor | Raw lead objects with name/address/entity_id |
| `requestedCount` | `successCriteria.target_leads` or parsed user goal | Number user asked for |
| `hardConstraints` / `softConstraints` | Derived from tool filters (`deriveConstraintsFromFilters`) or `state.hardConstraints` | Loose strings, not structured constraints |
| `planVersions` | Synthetic array from `currentPlanVersion` counter | `[{version:1, changes_made:['Initial plan']}, ...]` |
| `softRelaxations` | Usually empty `[]` in plan-executor; sometimes populated in supervisor.ts | Tracks which constraints were relaxed |
| `finalVerdict` | Passed as string: `'pass'`, `'STOP'`, `'error'`, `'change_plan'`, or Tower verdict | NOT Tower's raw verdict object |
| `stopReason` | Free text or null | e.g. `"Max retries exceeded"` |
| `cvlVerifiedExactCount` | From `cvlVerification.verified_exact_count` (optional) | Only populated by supervisor.ts chat flow |
| `cvlUnverifiableCount` | From `cvlVerification.summary.unverifiable_count` | Only in supervisor.ts |
| `cvlRequestedCountUser` | From `cvlVerification.summary.requested_count_user` | Only in supervisor.ts |
| `cvlHardUnverifiable` | From `cvlVerification.summary.unverifiable_hard_constraints` | String array |

### Where it ignores CVL/Tower

1. **plan-executor.ts** (lines 883, 933, 1012, 1113, 1147): All 5 call sites pass `finalVerdict` as a simple string (`'pass'` or `'STOP'`) and **never pass CVL fields** (`cvlVerifiedExactCount` etc. are absent). The plan-executor flow has zero CVL integration.

2. **agent-loop.ts** (`emitAgentLoopDeliverySummary`, line 354): Also never passes CVL fields. Uses Tower v1 verdict (`ACCEPT`/`RETRY`/`CHANGE_PLAN`/`STOP`) but maps it to `'pass'` or verdict string — not the canonical PASS/PARTIAL/STOP rules.

3. **supervisor.ts** (lines 1607, 2590): The chat flow (line 2590) **does** pass CVL data. The error path (line 1607) does not.

### Verdict derivation in `buildDeliverySummaryPayload` (line 210)
Current logic (simplified):
```
if hasCvl:
  isStop = verdictIsFailure OR exactCount < requested OR hasHardUnverifiable
else:
  isStop = rawTotalCount < requested OR verdictIsFailure
```
Then in `emitDeliverySummary`:
```
verdictLabel = stop_reason ? (finalVerdict==='change_plan' ? 'NEEDS_VERIFICATION' : 'STOP') : 'PASS'
```

**GAP vs target rules:** There is no `PARTIAL` verdict. "PASS" is derived from absence of stop_reason rather than `verified_exact >= user_requested AND Tower != STOP`. Raw counts CAN currently imply success when CVL is absent.

### Call sites (7 total)

| File | Line | Context | CVL? | Tower verdict used? |
|------|------|---------|------|---------------------|
| plan-executor.ts | 883 | Max retries exceeded | No | Uses Tower's step-level reaction |
| plan-executor.ts | 933 | Max plan versions exceeded | No | Same |
| plan-executor.ts | 1012 | Tower STOP reaction | No | Reaction='stop' |
| plan-executor.ts | 1113 | Plan completed successfully | No | Always passes 'pass' |
| plan-executor.ts | 1147 | Plan execution error (catch) | No | Always passes 'STOP' |
| agent-loop.ts | 354 (via helper) | All agent-loop terminal states (12+ call sites) | No | Tower v1 verdict mapped |
| supervisor.ts | 1607 | Tower call error in chat flow | No | Error string |
| supervisor.ts | 2590 | Chat flow final delivery | YES | Composite verdict from Tower + CVL |

---

## Section B: CVL State (Where Computed, Where Stored, Fields)

### Where computed
`server/supervisor/cvl.ts` — `verifyLeads()` function (line 259)

### Where called
Only in `server/supervisor.ts` (chat flow, around lines 2400-2460):
```ts
const cvlVerification = verifyLeads(verifiableLeads, structuredConstraints, userRequestedCountFinal, searchBudgetCount, leadsReturnedFromApi);
```

### Where stored
As an **artefact** of type `'verification_summary'` (supervisor.ts line 2435):
```ts
await createArtefact({
  runId: chatRunId,
  type: 'verification_summary',
  title: `Verification Summary: ${vs.verified_exact_count} of ${vs.requested_count_user} verified`,
  summary: `...`,
  payload: vs as Record<string, unknown>,
  userId: task.user_id,
  conversationId,
});
```
Stored in the `artefacts` table (`payload_json` column) — NOT in a dedicated table.

Also emitted as artefact types:
- `constraints_extracted` (line 1025)
- `constraint_capability_check` (line 1051)

### Key output fields (CvlVerificationOutput)
```ts
{
  leadVerifications: LeadVerificationResult[]   // per-lead constraint checks
  evidenceItems: VerificationEvidence[]          // evidence snippets
  summary: VerificationSummaryPayload            // aggregate summary
  verified_exact_count: number                   // count of leads passing all hard constraints
}
```

### VerificationSummaryPayload fields
| Field | Type | Description |
|-------|------|-------------|
| `mission_type` | `'lead_finder'` | Always |
| `requested_count_user` | `number \| null` | User's requested count |
| `candidates_checked` | `number` | Total leads checked |
| `verified_exact_count` | `number` | Leads passing ALL hard constraints |
| `verified_total_count` | `number` | Total leads (same as candidates_checked) |
| `unverifiable_count` | `number` | Constraints that can't be verified |
| `hard_unknown_count` | `number` | Leads with unknown hard constraint status |
| `unverifiable_hard_constraints` | `UnverifiableHardConstraint[]` | Details on unverifiable hard constraints |
| `suggested_next_action` | `string \| null` | Guidance for next steps |
| `constraint_results` | Array | Per-constraint aggregation |
| `budget` | Object | `search_budget_count`, `leads_returned`, `leads_after_filters` |

### GAP: CVL is only invoked in the `supervisor.ts` chat flow. The `plan-executor.ts` and `agent-loop.ts` paths never run CVL.

---

## Section C: Tower Verdict State (Where Computed, Where Stored, Fields)

### Two Tower integration paths

#### Path 1: Tower Artefact Judge (per-step)
- **File:** `server/supervisor/tower-artefact-judge.ts` — `judgeArtefact()`
- **Called from:** `plan-executor.ts` `judgeStepResultSync()` (line 305) after each step
- **Request:** `ArtefactJudgementRequest { runId, artefactId, goal, successCriteria, artefactType }`
- **Response:** `ArtefactJudgementResponse { verdict, reasons[], metrics, action: 'continue'|'stop'|'retry'|'change_plan', gaps?, suggested_changes? }`
- **Persisted:** `tower_judgements` table via `storage.createTowerJudgement()` (line 199)
  - Columns: `id, run_id, artefact_id, verdict, action, reasons_json, metrics_json, created_at`
- **Also persisted as artefact:** type `'tower_judgement'` in `artefacts` table (plan-executor.ts line 372)
- **Stub mode:** `TOWER_ARTEFACT_JUDGE_STUB=true` → auto-pass

#### Path 2: Tower Evaluate (run-level, legacy)
- **File:** `server/supervisor/tower-judgement.ts` — `callTowerEvaluate()`, `requestJudgement()`
- **Called from:** agent-loop.ts (via `handleTowerVerdict`)
- **Request:** `TowerEvaluateRequest { run_id, mission_type, success: TowerSuccessCriteria, snapshot: TowerSnapshot }`
- **Response:** `TowerEvaluateResponse { verdict: 'CONTINUE'|'STOP'|'CHANGE_PLAN', reason_code, explanation, evaluated_at }`
- **NOT persisted to `tower_judgements` table** — only logged as AFR events
- **Mapped to agent-loop TowerVerdictV1:** `ACCEPT | RETRY | CHANGE_PLAN | STOP`

#### Path 3: Chat flow (supervisor.ts)
- Uses `judgeArtefact()` (artefact judge path) for leads_list artefact
- Also applies CVL verification on top
- Final verdict derived from Tower action + CVL results

### Verdict representation in data
| Value | Meaning | Where used |
|-------|---------|------------|
| `'pass'` / `'ACCEPT'` | Tower says results are good | tower-artefact-judge, delivery-summary |
| `'fail'` | Tower says results are bad | tower-artefact-judge (verdict field) |
| `'continue'` | Keep going (action) | tower-artefact-judge (action field) |
| `'stop'` | Halt execution (action) | tower-artefact-judge (action field) |
| `'retry'` | Retry same step (action) | tower-artefact-judge (action field) |
| `'change_plan'` | Adjust and rerun (action) | tower-artefact-judge (action field) |
| `'CONTINUE'` | Keep going (Tower evaluate) | tower-judgement.ts |
| `'STOP'` | Halt (Tower evaluate) | tower-judgement.ts |
| `'CHANGE_PLAN'` | Replan (Tower evaluate) | tower-judgement.ts |
| `'error'` | Tower call failed | tower-artefact-judge |

### GAP: Two different Tower APIs with inconsistent verdict schemas. `tower_judgements` table only captures artefact-judge path, not evaluate path.

---

## Section D: Existing DB Tables Relevant

### From `shared/schema.ts` (Drizzle ORM)

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| `users` | id, username, password | Auth |
| `user_signals` | id, userId, type, payload, createdAt | Inbound signals |
| `suggested_leads` | id, userId, accountId, rationale, source, score, lead(jsonb), createdAt, pipelineStage | Lead storage |
| `processed_signals` | id, signalId, signalSource, processedAt | Idempotency |
| `supervisor_state` | id, source, lastProcessedTimestamp, lastProcessedId | Polling cursor |
| `plans` | id, userId, accountId, status, planData(jsonb), goalText, createdAt, updatedAt | Plan definitions |
| `plan_executions` | id, planId, userId, accountId, **goalId**, **goalText**, overallStatus, startedAt, finishedAt, stepResults(jsonb), metadata(jsonb) | Execution history |
| `subconscious_nudges` | id, accountId, userId, nudgeType, title, message, importance, leadId, context(jsonb) | Nudge system |
| `agent_memory` | id, userId, accountId, toolUsed, query(jsonb), outcome(jsonb), userFeedback, confidenceScore, planId, taskId | Learning system |
| `artefacts` | id, **runId**, type, title, summary, **payloadJson**(jsonb), createdAt | All artefacts (step_result, leads_list, tower_judgement, delivery_summary, verification_summary, etc.) |
| `tower_judgements` | id, **runId**, **artefactId**, verdict, action, reasonsJson(jsonb), metricsJson(jsonb), createdAt | Tower artefact-judge results |
| `agent_runs` | id, clientRequestId, userId, conversationId, createdAt, updatedAt, status, terminalState, uiReady, lastEventAt, error, errorDetails(jsonb), metadata(jsonb), startedAt, endedAt | Run tracking |

### Existing goal-related fields
- `plan_executions.goalId` — exists but sparsely populated, references Supabase `scheduled_monitor` id
- `plan_executions.goalText` — exists, snapshot of goal text
- `plans.goalText` — exists

### Tables that DO NOT exist yet
- `belief_store` / `beliefs` — **does not exist**
- `goal_ledger` — **does not exist**
- `feedback_events` — **does not exist**

---

## Section E: Minimal Schema Additions (SQL)

```sql
-- E1: Belief Store
CREATE TABLE IF NOT EXISTS belief_store (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  goal_id TEXT,
  belief_type TEXT NOT NULL,          -- 'cvl_failure' | 'tower_stop' | 'capability_gap' | 'constraint_unverifiable'
  belief_text TEXT NOT NULL,          -- Human-readable belief
  source TEXT NOT NULL,               -- 'cvl' | 'tower' | 'plan_executor'
  confidence REAL DEFAULT 1.0,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX idx_belief_store_run_id ON belief_store(run_id);
CREATE INDEX idx_belief_store_goal_id ON belief_store(goal_id);

-- E2: Goal Ledger
CREATE TABLE IF NOT EXISTS goal_ledger (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL,
  account_id TEXT,
  goal_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'completed' | 'stopped' | 'abandoned'
  stop_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX idx_goal_ledger_user_id ON goal_ledger(user_id);
CREATE INDEX idx_goal_ledger_status ON goal_ledger(status);

-- E3: Link runs to goals (add column to agent_runs)
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS goal_id TEXT REFERENCES goal_ledger(id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_goal_id ON agent_runs(goal_id);

-- E4: Feedback Events
CREATE TABLE IF NOT EXISTS feedback_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL,
  goal_id TEXT REFERENCES goal_ledger(id),
  run_id TEXT REFERENCES agent_runs(id),
  event_type TEXT NOT NULL,          -- 'accept_result' | 'retry_goal' | 'abandon_goal' | 'export_data'
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX idx_feedback_events_goal_id ON feedback_events(goal_id);
CREATE INDEX idx_feedback_events_run_id ON feedback_events(run_id);
```

No new table needed for delivery_summary — it stays as an artefact (type='delivery_summary') but the payload schema changes.

---

## Section F: Minimal Code Changes (by file)

### F1: `server/supervisor/delivery-summary.ts` — Canonical verdict derivation

**Change:** Replace verdict derivation with canonical rules:
```
PASS:    verified_exact >= user_requested AND Tower != STOP
PARTIAL: verified_exact > 0 AND verdict != PASS
STOP:    Tower verdict is STOP or CHANGE_PLAN, or cvl failure
```

- Add `verdict: 'PASS' | 'PARTIAL' | 'STOP'` to `DeliverySummaryPayload`
- `buildDeliverySummaryPayload` must require Tower verdict + CVL counts (make optional fields required with defaults)
- Remove the logic that derives success from raw lead count when CVL is absent
- All call sites must pass `cvlVerifiedExactCount` (default 0 if CVL not run) and `towerVerdict` (the actual Tower action, not a free string)

### F2: `server/supervisor/plan-executor.ts` — Pass Tower + CVL to delivery_summary

**Change:** All 5 `emitDeliverySummary()` call sites must include:
- `cvlVerifiedExactCount: 0` (plan-executor has no CVL yet — make this explicit)
- `towerVerdict: judgement.action || 'unknown'`

### F3: `server/supervisor/agent-loop.ts` — Same for agent-loop

**Change:** `emitAgentLoopDeliverySummary()` must pass:
- `cvlVerifiedExactCount: 0`
- `towerVerdict: verdict.verdict`

### F4: `server/supervisor.ts` — Already passes CVL, just align field names

**Change:** Ensure the chat flow call site (line 2590) uses the same canonical field names.

### F5: `shared/schema.ts` — Add Drizzle table definitions

**Change:** Add `beliefStore`, `goalLedger`, `feedbackEvents` tables matching Section E SQL.
Add `goalId` column to `agentRuns` table definition.

### F6: `server/storage.ts` — Add CRUD operations

**Change:** Add to IStorage interface:
- `createBelief(data): Promise<Belief>`
- `getBeliefsByRunId(runId): Promise<Belief[]>`
- `createGoal(data): Promise<Goal>`
- `updateGoalStatus(goalId, status, stopReason?): Promise<void>`
- `getGoalsByUserId(userId): Promise<Goal[]>`
- `createFeedbackEvent(data): Promise<FeedbackEvent>`
- `getFeedbackEventsByGoalId(goalId): Promise<FeedbackEvent[]>`

### F7: New file `server/supervisor/belief-writer.ts`

**Change:** Create `writeBeliefs(runId, goalId?)` function:
- Fetch artefacts for run: type='verification_summary' and type='tower_judgement'
- From CVL failures: extract up to 2 beliefs (e.g. "hard constraint X is unverifiable", "only N of M leads verified")
- From Tower stop reasons: extract 1 belief (e.g. "Tower stopped: stall detected after 3 steps")
- Cap at 3 beliefs total
- Write to `belief_store` table

### F8: `server/routes.ts` — Add API endpoints

**Change:** Add endpoints:
- `POST /api/feedback` — create feedback event (accept_result, retry_goal, abandon_goal, export_data)
- `GET /api/goals/:userId` — list goals for user
- `POST /api/goals` — create goal
- `PATCH /api/goals/:goalId` — update goal status
- `GET /api/beliefs/:runId` — get beliefs for a run
- `GET /api/demo/scenarios` — list 3 preset demo scenarios
- `POST /api/demo/run/:scenarioId` — execute a demo scenario

### F9: New file `server/supervisor/demo-orchestrator.ts`

**Change:** Create manual demo orchestrator with 3 preset scenarios:
1. **Happy path:** 5 pubs in Bristol → PASS (all verified)
2. **Partial delivery:** 10 pubs with beer garden in London → PARTIAL (CVL can't verify beer garden attribute)
3. **Tower STOP:** 20 craft breweries in rural Wales → STOP (stall detected, insufficient results)

Each scenario calls existing supervisor flow with pre-set parameters.

### F10: `client/src/pages/Activity.tsx` — Update delivery_summary rendering

**Change:** Read canonical `verdict` field instead of deriving from `stop_reason`. Display PASS/PARTIAL/STOP with appropriate styling.

---

## Section G: Risks / Unknowns (max 5)

1. **CVL not run in plan-executor or agent-loop paths.** The plan-executor and agent-loop flows produce delivery_summary with `cvlVerifiedExactCount` absent. The canonical rules require CVL data. Decision needed: run CVL in those paths too (adds latency), or treat missing CVL as `verified_exact = 0` (conservative but potentially wrong for simple searches).

2. **Two Tower APIs with different verdict schemas.** `tower-judgement.ts` uses `CONTINUE/STOP/CHANGE_PLAN` while `tower-artefact-judge.ts` uses `pass/fail + continue/stop/retry/change_plan`. Unifying these or mapping consistently is essential for the canonical delivery_summary.

3. **goal_id population.** `plan_executions.goalId` exists but is rarely populated (comes from Supabase `scheduled_monitor`). Migrating to goal_ledger requires ensuring every run gets a goal_id — either user-provided or auto-generated from the goal text. Backfill for existing runs may be needed.

4. **Artefact payload is untyped jsonb.** delivery_summary, verification_summary, and tower_judgement artefacts all store structured data in `payload_json` (jsonb). There's no runtime validation on read. Adding typed parsers or Zod schemas for artefact payloads would reduce bugs but adds scope.

5. **Demo orchestrator vs factory-demo.** An existing `factory-demo.ts` (903 lines) runs a manufacturing simulation demo. The new demo orchestrator targets lead-gen scenarios. These are separate concerns, but naming/routing could collide. Ensure clear separation (`/api/demo/leadgen/*` vs existing `/api/demo/factory/*`).
