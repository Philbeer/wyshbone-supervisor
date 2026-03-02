# REPORT\_PART3\_SUPERVISOR.md

## Audit: Part 3 – MVP Learning Plan — Supervisor Implementation Status

**Date:** 2 March 2026
**Scope:** Wyshbone Supervisor repo only

---

## 1. Executive Summary

- **A cross-run learning layer exists and is operational.** The `learning-layer.ts` module persists policy bundles scoped by vertical + location + constraints, adjusts radius/search-budget/stop-early rules after each run, and re-applies them on the next matching run.
- **Tower governance is wired into the step loop, but is conditional.** The Plan Executor calls `/api/tower/judge-artefact` after tool steps, but only when step-artefacts are enabled (`ENABLE_STEP_ARTEFACTS` env var, defaults to `true`). When active, the verdict is persisted and the Supervisor reacts deterministically (continue / retry / change\_plan / stop).
- **Outcome persistence is thorough.** Run outcomes, artefacts, judgements, delivery summaries, beliefs, decision logs, and outcome logs are all written to Supabase PostgreSQL via well-defined tables.
- **Three adaptive policy knobs exist: radius, search budget, and stop-when-verified-zero.** Enrichment policy is defined in the bundle structure but is **not** auto-tuned by outcome feedback. Verification depth, clarification strictness, and replan ceiling remain static, governed only by hard-coded constants and env vars.
- **No formal "learning ledger" table exists** that directly matches the Part 3 spec (query signature, entity type, outcomes, run duration, retries, final verdict, stop reason as first-class columns). The data is spread across `artefacts` (outcome\_log type), `policy_versions`, `agent_runs`, and `tower_judgements`.

---

## 2. What Learning or Cross-Run Persistence Exists Today

### 2.1 Learning Layer (`server/supervisor/learning-layer.ts`)

The primary adaptive mechanism. Key moving parts:

| Component | Description |
|---|---|
| `PolicyBundleV1` | Composite bundle containing `radius_policy_v1`, `enrichment_policy_v1`, `stop_policy_v1` |
| `applyPolicy()` | Reads the latest `policy_versions` row for the run's scope key; falls back to `GLOBAL_DEFAULT` if none exists |
| `writeOutcomePolicyVersion()` | After a run completes, inspects fill rate (delivered / requested). If < 50% → expands `max_cap_km` by 10 km (ceiling 100 km). If < 30% → increases `search_budget_count` by 10 (ceiling 60). If zero verified → enables `stop_when_verified_exact_is_zero_after_enrichment` |
| `persistPolicyApplication()` | Records which policy version was applied to each run and why |
| `writeDecisionLog()` / `writeOutcomeLog()` | Creates `decision_log` and `outcome_log` artefacts containing full policy snapshot and run metrics |

### 2.2 Scope Key Derivation

Policies are keyed by `deriveScopeKey(vertical, location, constraintBucket)`, producing keys like `pubs::arundel::c_attr_live_music`. This allows the system to learn different policies for different query shapes.

### 2.3 Preference Learner (`server/services/preference-learner.ts`)

A separate user-level preference system that tracks industries, regions, contact types, and keywords with 0–1 weights updated from user feedback (helpful / not\_helpful). Stores preferences as `AgentMemory` rows. Used for task scoring via `scoreTaskByPreferences`.

### 2.4 Belief Writer (`server/supervisor/belief-writer.ts`)

After each run, writes up to 3 beliefs to the `belief_store` table. Examples: "Hard constraint unverifiable: live\_music", "Tower stopped execution: cost\_overrun", "Partial delivery: 3 of 10 verified". These beliefs are keyed by `runId` and `goalId` and carry a confidence score.

---

## 3. Whether Any "Policy Knobs" Exist and Where They Come From

| Knob | Source | Adaptive? |
|---|---|---|
| `max_cap_km` (radius ceiling) | `RadiusPolicyV1` in `policy_versions` table | **Yes** — auto-increased when fill rate < 50% |
| `search_budget_count` | `StopPolicyV1` in `policy_versions` table | **Yes** — auto-increased when fill rate < 30% |
| `stop_when_verified_exact_is_zero_after_enrichment` | `StopPolicyV1` | **Yes** — set to `true` if a run delivers zero |
| `max_replans` | `StopPolicyV1` (default 2); overridable via `MAX_REPLANS` env var | **Stored** but not yet auto-tuned by outcome feedback |
| `enrichment_batch_size` | `EnrichmentPolicyV1` (default 10) | **Static** — not adjusted by learning |
| `max_enrich_calls_per_lead` | `EnrichmentPolicyV1` (default 1) | **Static** |
| Clarification strictness | Hard-coded regex lists in `clarify-gate.ts` | **Static** — no feedback loop |
| Verification depth | Hard-coded in CVL module (`cvl.ts`) | **Static** |
| `MAX_RETRIES_PER_STEP` | Constant = 2 in `plan-executor.ts` | **Static** |
| `MAX_PLAN_VERSIONS` | Constant = 2 in `plan-executor.ts` | **Static** (though `max_replans` in policy bundle is available, the plan-executor constant takes precedence) |
| Tower success criteria | `LEADGEN_SUCCESS_DEFAULTS` in `tower-judgement.ts` | **Static** — `max_cost_gbp: 2.00`, `max_steps: 8`, `min_quality_score: 0.6` etc. |

---

## 4. Biggest Correctness and Reliability Risks

1. **Dual replan ceiling conflict.** `MAX_PLAN_VERSIONS` (constant = 2) in `plan-executor.ts` competes with `max_replans` from the policy bundle. If the learning layer sets `max_replans = 4`, the plan executor still caps at 2. The learned value is partially ignored.
2. **Tower failure default is `continue`.** When `callTowerJudgeArtefact` throws a network error, the Supervisor defaults to `action: 'continue'` and `shouldStop: false` (`tower-artefact-judge.ts:191`). This means an unreachable Tower silently lets un-judged steps pass, undermining the "Tower invariant."
3. **No Tower URL = immediate stop, but only at call time.** The startup assertion (`assertTowerConfig`) throws if stub mode is off and no URL is set. But if the URL becomes invalid after boot (DNS failure, service down), the fallback above applies.
4. **Outcome policy writes are fire-and-forget.** `writeOutcomePolicyVersion` failures are caught and logged but do not fail the run or flag a learning-layer integrity issue.
5. **No deduplication of scope keys.** `canonicaliseBusinessType` does basic normalisation but "pub" vs "pubs" vs "public houses" will create separate scope keys, fragmenting learned policies.
6. **Learning only adjusts three knobs.** Many relevant parameters (enrichment depth, clarification strictness, replan ceiling, success criteria thresholds) remain static regardless of outcome history.

---

## 5. Learning Ledger and Persistence

### 5.1 Is There a Dedicated Learning Ledger Table?

**No.** There is no single table with first-class columns for query signature, constraint types, entity type, outcomes, run duration, replans, retries, final verdict, and stop reason.

The closest equivalents are:

| Part 3 Ledger Field | Where It Lives Today | Format |
|---|---|---|
| Query signature | `outcome_log` artefact → `payload_json.scope_key` | Embedded in JSONB |
| Constraint types | `decision_log` artefact → `payload_json.constraint_bucket` | Embedded in JSONB |
| Entity type | `decision_log` artefact → `payload_json.input_vertical` | Embedded in JSONB |
| Outcomes (delivered/requested) | `outcome_log` artefact → `payload_json.delivered_count`, `requested_count` | Embedded in JSONB |
| Run duration | `outcome_log` artefact → `payload_json.duration_ms` | Embedded in JSONB |
| Replans | `outcome_log` artefact → `payload_json.plan_versions_used` | Embedded in JSONB |
| Retries | Not persisted at ledger level | Only visible in AFR activity log |
| Final verdict | `delivery_summary` artefact → `payload_json.status` (PASS/PARTIAL/STOP/ERROR) | Embedded in JSONB |
| Stop reason | `outcome_log` → `payload_json.stop_reason`; `delivery_summary` → `payload_json.stop_reason` | Embedded in JSONB |

### 5.2 Tables, Collections, and Artefacts Storing Cross-Run Signals

| Table | Schema File | Purpose |
|---|---|---|
| `policy_versions` | `shared/schema.ts:317` | Versioned policy bundles per scope key |
| `policy_applications` | `shared/schema.ts:337` | Which policy version was applied to which run |
| `agent_memory` | `shared/schema.ts:105` | Tool-level outcomes + user feedback (90-day TTL) |
| `belief_store` | `shared/schema.ts:255` | Cross-run beliefs with confidence scores |
| `goal_ledger` | `shared/schema.ts:231` | High-level goal tracking with linked run IDs |
| `feedback_events` | `shared/schema.ts:277` | Raw user feedback events per goal/run |
| `artefacts` (type = `outcome_log`) | `shared/schema.ts:165` | Run outcome metrics as JSONB payload |
| `artefacts` (type = `decision_log`) | `shared/schema.ts:165` | Policy application snapshots as JSONB payload |

---

## 6. Where Run Outcomes Are Written

### 6.1 Code Paths That Persist Run Data

| What Is Persisted | File | Function | Target |
|---|---|---|---|
| Agent run record (status, terminal state, timestamps) | `server/storage.ts` | `createAgentRun`, `updateAgentRun` | `agent_runs` table |
| Step-level artefacts | `server/supervisor/artefacts.ts` | `createArtefact` | `artefacts` table |
| Tower judgements | `server/supervisor/tower-artefact-judge.ts` | `judgeArtefact` → `storage.createTowerJudgement` | `tower_judgements` table |
| Plan execution results | `server/storage.ts` | `createPlanExecution` | `plan_executions` table (JSONB `step_results`) |
| AFR activity events | `server/supervisor/afr-logger.ts` | `logAFREvent` | `agent_activities` table (Supabase direct) |
| Delivery summary | `server/supervisor/delivery-summary.ts` | `emitDeliverySummary` → `createArtefact` | `artefacts` table (type = `delivery_summary`) |
| Decision log | `server/supervisor/learning-layer.ts` | `writeDecisionLog` → `createArtefact` | `artefacts` table (type = `decision_log`) |
| Outcome log | `server/supervisor/learning-layer.ts` | `writeOutcomeLog` → `createArtefact` | `artefacts` table (type = `outcome_log`) |
| Beliefs | `server/supervisor/belief-writer.ts` | `writeBeliefs` | `belief_store` table |
| Updated policy version | `server/supervisor/learning-layer.ts` | `writeOutcomePolicyVersion` → `storage.createPolicyVersion` | `policy_versions` table |
| Policy application record | `server/supervisor/learning-layer.ts` | `persistPolicyApplication` → `storage.createPolicyApplication` | `policy_applications` table |

---

## 7. Any Existing Policy or Tuning Logic

### 7.1 Behaviour That Changes Based on Prior Runs

| Mechanism | How It Works | Influenced Parameters |
|---|---|---|
| `applyPolicy()` | Reads latest `policy_versions` for the run's scope key. If a learned version exists, its bundle overrides the global default. | `search_budget_count`, `max_cap_km`, `radius_steps_km`, `stop_when_verified_exact_is_zero` |
| `writeOutcomePolicyVersion()` | After each run, writes a new policy version with adjusted knobs based on fill rate and stop reason. | Same as above |
| Preference Learner | Updates user-level industry/region/contact-type weights from feedback events. Influences future task scoring. | Task prioritisation (not execution parameters) |
| Belief Writer | Persists claims like "hard constraint unverifiable" which can be read by future runs (though no automated reader is wired in yet). | None directly — belief data is available but not consumed by planner |

### 7.2 What Remains Static

- **Search budget:** Only adjusted by learning layer fill-rate logic. No Tower feedback or user override influences it during a run.
- **Verification depth:** CVL verification logic is hard-coded. No policy knob controls how deep verification goes.
- **Clarification strictness:** `clarify-gate.ts` uses static regex lists. No learning from past clarification sessions.
- **Replan ceiling:** `MAX_PLAN_VERSIONS = 2` in `plan-executor.ts` is a hard constant not influenced by policy.
- **Stop-early decisions beyond zero-verified:** Tower success criteria (`LEADGEN_SUCCESS_DEFAULTS`) are static. No learning adjusts `max_cost_gbp`, `max_steps`, or `min_quality_score`.

---

## 8. Interfaces to Tower

### 8.1 How Supervisor Calls Tower

**Primary path (per-step artefact judgement):**

- **Caller:** `plan-executor.ts` → `judgeStepResultSync()` → `judgeArtefact()` in `tower-artefact-judge.ts`
- **Endpoint:** `POST ${TOWER_BASE_URL}/api/tower/judge-artefact`
- **Auth:** `X-TOWER-API-KEY` header (from `TOWER_API_KEY` or `EXPORT_KEY` env var)
- **Conditional:** Step-level artefact creation (and therefore Tower judgement) is gated by `ENABLE_STEP_ARTEFACTS` env var (defaults to `true` if unset). When disabled, no per-step artefact is written and Tower is not called per step.

**Legacy path (run-level snapshot evaluation):**

- **Caller:** `tower-judgement.ts` → `callTowerEvaluate()`
- **Endpoint:** `POST ${TOWER_URL}/api/tower/evaluate`
- **Used for:** High-level run snapshot evaluation with cost/step/quality thresholds

### 8.2 Inputs Sent to Tower (Artefact Judge)

```typescript
interface ArtefactJudgementRequest {
  runId: string;
  artefactId: string;
  goal: string;                          // User's original mission
  artefactType: string;                  // Usually "step_result"
  successCriteria?: {
    target_count: number;
    plan_constraints: {
      requested_count: number;
      location: string;
    };
    hard_constraints: string[];
    soft_constraints: string[];
    plan_version: number;
  };
}
```

### 8.3 Outputs Expected from Tower

```typescript
interface ArtefactJudgementResponse {
  verdict: string;                       // "pass", "fail", "partial", "error"
  action: 'continue' | 'stop' | 'retry' | 'change_plan';
  reasons: string[];                     // Human-readable explanations
  metrics: Record<string, unknown>;      // Performance data
  gaps?: Array<{ type: string; severity?: string; detail?: string }>;
  suggested_changes?: Array<{
    field: string;
    action: string;                      // "drop", "relax", "expand", "increase", "broaden"
    reason?: string;
    current_value?: unknown;
    suggested_value?: unknown;
  }>;
}
```

### 8.4 How Supervisor Reacts

| Tower Action | Supervisor Behaviour | Code Location |
|---|---|---|
| `continue` | Advance to next step | `plan-executor.ts` main loop |
| `retry` | Re-execute same step (up to `MAX_RETRIES_PER_STEP = 2`) | `plan-executor.ts` |
| `change_plan` | Invoke `replan-policy.ts` to adjust constraints (expand radius, broaden query, increase count). Increment plan version (up to `MAX_PLAN_VERSIONS = 2`). Restart step. | `plan-executor.ts` + `replan-policy.ts` |
| `stop` | Set `shouldStop = true`, exit loop, finalise run as stopped | `plan-executor.ts` |
| `verdict: 'fail'` + action ≠ `change_plan` | Treated as stop | `tower-artefact-judge.ts:232` |
| HTTP error (Tower unreachable) | Default to `action: 'continue'`, `shouldStop: false` | `tower-artefact-judge.ts:191` |
| No `TOWER_BASE_URL` configured | Return `action: 'stop'`, `shouldStop: true` immediately | `tower-artefact-judge.ts:167` |

---

## 9. Data Flow Map

```
User Request (UI chat message)
  │
  ▼
user_signals table (Supabase)
  │
  ▼
SupervisorService.poll() ──► signal detected
  │
  ▼
generateLeadsFromSignal() ──► supervisor_task created [status: pending]
  │
  ▼
evaluateClarifyGate()
  ├── route: direct_response ──► reply text, no run
  ├── route: clarify_before_run ──► ClarifySession created ──► questions sent to UI
  │       └── (follow-up answers) ──► session complete ──► re-enter as agent_run
  └── route: agent_run
        │
        ▼
  applyPolicy() ──► PolicyApplicationResult (learned or default bundle)
        │
        ▼
  persistPolicyApplication() ──► policy_applications row
  writeDecisionLog() ──► artefact [type: decision_log]
        │
        ▼
  buildToolPlan() ──► Plan (sequence of steps: SEARCH_PLACES, ENRICH, SCORE, etc.)
        │
        ▼
  ┌─── Plan Executor Loop ───────────────────────────────┐
  │                                                       │
  │  executeAction(step) ──► ActionResult                 │
  │      │                                                │
  │      ▼                                                │
  │  createArtefact(step_result) ──► artefacts table      │
  │      │                                                │
  │      ▼                                                │
  │  judgeArtefact() ──► POST /api/tower/judge-artefact   │
  │      │                                                │
  │      ▼                                                │
  │  Tower responds: verdict + action                     │
  │      │                                                │
  │      ▼                                                │
  │  storage.createTowerJudgement() ──► tower_judgements   │
  │      │                                                │
  │      ▼                                                │
  │  Reaction:                                            │
  │    continue ──► next step                             │
  │    retry ──► same step (max 2)                        │
  │    change_plan ──► replan-policy adjusts constraints  │
  │    stop ──► exit loop                                 │
  │                                                       │
  └───────────────────────────────────────────────────────┘
        │
        ▼
  emitDeliverySummary() ──► artefact [type: delivery_summary]
  writeBeliefs() ──► belief_store rows
  writeOutcomeLog() ──► artefact [type: outcome_log]
  writeOutcomePolicyVersion() ──► policy_versions row (learned)
        │
        ▼
  supervisor_task marked completed
  AgentEmailNotifier sends email (if configured)
        │
        ▼
  UI: artefacts + delivery summary rendered to user
```

### Event and Artefact Types

| Type | Origin |
|---|---|
| `step_result` | Per-step tool output |
| `tower_judgement` | Tower response row in `tower_judgements` |
| `decision_log` | Policy application snapshot at run start |
| `outcome_log` | Run completion metrics |
| `delivery_summary` | Final structured output for user |
| `deep_research_result` | Extended research artefact |
| AFR events (in `agent_activities`) | `plan_started`, `step_started`, `step_completed`, `step_failed`, `plan_completed`, `plan_failed`, `tower_judgement`, `tower_judgement_failed`, `router_decision`, `tools_update` |

---

## 10. Gaps vs Part 3 Spec

| Part 3 Requirement | Present Now | Missing | Next Concrete Step |
|---|---|---|---|
| **Learning ledger with first-class columns** (query signature, entity type, outcomes, run duration, retries, final verdict, stop reason) | Data exists but scattered across JSONB payloads in `artefacts` (outcome\_log, decision\_log) and `agent_runs` | No dedicated ledger table with queryable columns | Create `learning_ledger` table with typed columns mirroring the spec; backfill from existing artefact payloads |
| **Query signature tracking** | `scope_key` in `policy_versions` and `outcome_log` artefact | Not a first-class indexed column in a ledger | Add `query_signature` column to learning ledger |
| **Retry count per run** | Step retry count tracked in `plan-executor.ts` loop variable only | Not persisted to any table | Persist `total_retries` in outcome log and/or learning ledger |
| **Verification depth adapts** | CVL verification is hard-coded | No policy knob or learning feedback for verification depth | Add `verification_depth` to `PolicyBundleV1` and wire into CVL |
| **Clarification strictness adapts** | Static regex patterns in `clarify-gate.ts` | No feedback loop from run outcomes to clarification rules | Track clarification-triggered runs and their outcomes; tune strictness thresholds |
| **Replan ceiling adapts** | `max_replans` field exists in `StopPolicyV1` but `MAX_PLAN_VERSIONS` constant in `plan-executor.ts` overrides it | Plan executor ignores learned `max_replans` | Remove hard-coded constant; read `max_replans` from applied policy bundle |
| **Search budget adapts** | **Yes** — `writeOutcomePolicyVersion` adjusts `search_budget_count` | Ceiling is fixed at 60 with no override | Consider making the ceiling a policy field or env var |
| **Stop-early adapts** | **Partial** — `stop_when_verified_exact_is_zero` is learned | Other stop criteria (`max_cost_gbp`, `max_steps`, `min_quality_score`) remain static | Add these to `PolicyBundleV1` and wire into outcome feedback |
| **Tower provides history context** | Tower receives `successCriteria` and current step artefact only | No run history, prior outcomes, or belief data sent to Tower | Include `prior_run_beliefs` or `scope_policy_version` in `ArtefactJudgementRequest` |
| **Belief store consumed by planner** | Beliefs are written but not read by any planner or gate | `belief_store` is write-only | Wire `belief_store` reads into `clarify-gate`, `tool-planning-policy`, and/or Tower requests |
| **Goal ledger tracks cross-run goal completion** | `goal_ledger` table exists with `linkedRunIds` and `stopReason` | Not clear if `stopReason` is populated or if goal status is updated post-run | Audit `goal_ledger` writes; ensure status transitions happen |
| **Feedback events close the loop** | `feedback_events` table exists | No code path reads feedback events to adjust policies | Wire `feedback_events` into `writeOutcomePolicyVersion` or a separate learning job |
| **Telemetry events for observability** | `telemetry_events` table exists | No evidence of systematic write calls in the Supervisor flow | Instrument key decision points to emit telemetry |

---

## 11. Appendix — Relevant Files

| File | Why It Matters |
|---|---|
| `shared/schema.ts` | Source of truth for all table definitions: `policy_versions`, `policy_applications`, `artefacts`, `tower_judgements`, `agent_runs`, `belief_store`, `goal_ledger`, `agent_memory`, `feedback_events`, `telemetry_events` |
| `server/supervisor/learning-layer.ts` | Core adaptive logic: `applyPolicy`, `writeOutcomePolicyVersion`, `writeDecisionLog`, `writeOutcomeLog`, scope key derivation, policy bundle structure |
| `server/supervisor/tower-artefact-judge.ts` | Per-step Tower judgement: request/response types, stub mode, error handling, judgement persistence |
| `server/supervisor/tower-judgement.ts` | Legacy run-level Tower evaluation: success criteria defaults, `RunSummary`, `TowerSnapshot` |
| `server/supervisor/plan-executor.ts` | Core execution loop: step execution → artefact → Tower → reaction. Contains `MAX_RETRIES_PER_STEP` and `MAX_PLAN_VERSIONS` constants |
| `server/supervisor/replan-policy.ts` | Constraint adjustment logic when Tower returns `change_plan`: radius expansion, query broadening, count increases |
| `server/supervisor/delivery-summary.ts` | Final structured output: constraint verification (CVL), trust status, delivered/requested counts, shortfall |
| `server/supervisor/belief-writer.ts` | Post-run belief extraction from delivery summary; writes to `belief_store` |
| `server/supervisor/clarify-gate.ts` | Intent gating: direct response / clarify / agent run routing; static regex-based |
| `server/supervisor/afr-logger.ts` | AFR event logging to `agent_activities` (Supabase); audit trail for every decision |
| `server/supervisor/artefacts.ts` | Generic artefact creation helper |
| `server/supervisor.ts` | Main orchestrator: polling, task lifecycle, calls to learning layer and plan executor |
| `server/services/preference-learner.ts` | User-level preference weights from feedback; task scoring |
| `server/storage.ts` | Storage interface: CRUD for all tables via Drizzle ORM |
| `server/supervisor/agent-loop.ts` | Agent loop v1 with radius ladder `[0, 5, 10, 25, 50, 100]` km |
| `server/supervisor/tool-planning-policy.ts` | Generates multi-step tool plans from parsed constraints |
| `server/supervisor/cvl.ts` | Constraint verification logic (hard-coded depth) |
