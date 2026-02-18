# Wyshbone Supervisor — Lead-Finder Execution Flow: Baseline Behavior

This document describes exactly how the Wyshbone Supervisor's Lead-Finder execution flow works today, tracing a user request from intake through parsing, execution, Tower judgement, and replanning to final delivery.

---

## 1. Entry Point

The Lead-Finder flow is invoked via `executeTowerLoopChat` in `server/supervisor.ts`. It receives:

- `task` — a `SupervisorTask` containing `user_id`, `conversation_id`, and `request_data`
- `userContext` — pre-built context about the user
- `chatRunId` — a unique run identifier
- `clientRequestId` — idempotency key for retries

The raw user message is extracted from `task.request_data.user_message`. An optional `search_query` object may override `business_type`, `location`, and `count`.

---

## 2. Intent Parsing (`goal-to-constraints.ts`)

The raw user goal string is passed to `parseGoalToConstraints()`, which attempts two parsing strategies in order:

### 2a. LLM Parsing (Primary)

Calls one of two LLMs (tried in order of API key availability):

1. **OpenAI `gpt-4o-mini`** — `temperature: 0`, `max_tokens: 2000`, JSON response mode enabled
2. **Anthropic `claude-3-5-haiku-20241022`** — `temperature: 0`, `max_tokens: 2000`

The LLM receives a system prompt that instructs it to return structured JSON with:

| Field | Description |
|---|---|
| `original_goal` | Verbatim user input |
| `requested_count_user` | Explicit number from user, or `null` if unspecified |
| `search_budget_count` | `max(20, requested_count_user or 20)` |
| `business_type` | e.g. "pubs", "dentists" |
| `location` | e.g. "arundel", "london" |
| `country` | Defaults to "UK" |
| `prefix_filter` | Names starting with a letter/prefix, or `null` |
| `name_filter` | Names containing a word, or `null` |
| `tool_preference` | e.g. "GOOGLE_PLACES", or `null` |
| `constraints` | Array of typed `StructuredConstraint` objects |
| `success_criteria` | `required_constraints`, `optional_constraints`, `target_count` |

The LLM output is validated against `ParsedGoalSchema` (Zod). If validation fails, the system falls back to regex.

### 2b. Regex Fallback

If the LLM call fails or its output doesn't pass Zod validation, `regexFallback()` runs. It extracts:

- **Count**: `/\bfind\s+(\d+)\s+/i` → capped at 200
- **Business type**: `/\bfind\s+(?:\d+\s+)?([a-zA-Z\s]+?)(?:\s+in\b)/i` → defaults to "pubs"
- **Location**: `/\bin\s+([A-Z][a-zA-Z\s,]+?)(?:\s+(?:that|who|which|with|using)\b|$)/i` → defaults to "Local"
- **Prefix**: `/\b(?:begin|start|starting)\s+with\s+([A-Za-z])\b/i`
- **Name contains**: Multiple patterns for "with the word X in the name", "containing X", "named X", "called X"
- **Tool preference**: `/\b(?:with|using)\s+(google\s+places?\s+search|google\s+places?|google\s+maps?)\b/i`

### 2c. Constraint Classification

Each parsed constraint is classified as hard or soft:

| Constraint Type | Default Hardness | Override Condition |
|---|---|---|
| `COUNT_MIN` | **Always hard** | — |
| `CATEGORY_EQUALS` | **Always hard** | — |
| `LOCATION_EQUALS` | Soft | Hard if user says "must", "only", "exactly", "strict", etc. |
| `LOCATION_NEAR` | Soft | Same override keywords |
| `NAME_STARTS_WITH` | Soft | Hard if "must", "exactly", "strict" detected |
| `NAME_CONTAINS` | Soft | Hard if "must", "exactly", "strict" detected |
| `MUST_USE_TOOL` | Soft | Hard if "must use" detected |

After parsing, `business_type` and `requested_count` are force-added to `hard_constraints` if not already present.

---

## 3. Pre-Execution Setup

After parsing, the function computes:

- `userRequestedCountFinal`: the user's explicit count, or `null`
- `searchBudgetCount`: `max(20, requestedCount)` — how many results to request from the API
- `normalizedGoal`: a formatted string like `"Find 4 pubs in arundel containing "swan" for B2B outreach"`
- `postProcessing`: list of client-side filter steps (prefix filter, name filter, trim to requested count)
- `assumptions`: documented notes about what the system infers (e.g., "Google Places cannot filter by name prefix")
- `MAX_REPLANS`: from `process.env.MAX_REPLANS`, defaults to `5`

An `agent_run` row is created/upserted in the database with status `'executing'`. Duplicate key conflicts are handled by reusing the existing run.

A **Plan v1 artefact** is created and persisted before any tool execution. It contains the plan steps, constraints, success criteria, and assumptions.

---

## 4. Plan v1 Execution (SEARCH_PLACES)

The single-step plan calls `searchGooglePlaces(businessType, city, country, searchCount)`.

### 4a. Result Processing

If Google Places returns results:

1. Results are mapped to a lead structure: `{ name, address, phone, website, placeId, source }`
2. **Prefix filter** (if set): case-insensitive `startsWith` check, applied client-side
3. **Name-contains filter** (if set): case-insensitive `includes` check, applied client-side
4. **Count trim**: if more results than `requestedCount`, slice to that limit

### 4b. Fallback

If Google Places returns zero results or throws an error:

- `generateStubLeads()` produces 5 deterministic fake leads with formulaic names like "The {city} {type} House"
- `usedStub` is set to `true`
- The stub source is recorded as `'deterministic_stub'`

### 4c. Lead Persistence

Each lead is persisted to the `suggested_leads` table via `storage.createSuggestedLead()` with:

- `source`: `'supervisor_chat'` (real) or `'supervisor_chat_stub'` (fallback)
- `score`: hard-coded `0.75`
- `tags`: `[businessType, 'tower_loop_chat']`

### 4d. Step Result Artefact

A `step_result` artefact is created containing timing data, inputs summary, outputs summary, and lead details. This artefact is then submitted to Tower for an **observation-only** judgement: `judgeArtefact()` is called with the step_result artefact, the run's goal, and the user/conversation IDs — but **without** `successCriteria` (unlike the leads_list judgement). The resulting `tower_judgement` artefact is persisted with `observation_only: true` in its payload. The observation verdict/action is logged but does **not** influence control flow (no branching or replanning based on this judgement).

---

## 5. Leads List Artefact

After step execution, a `leads_list` artefact is created and persisted. It contains:

- The full list of leads (name, address, phone, website)
- Hard and soft constraints
- Delivered count vs. target count
- Constraint relaxation metadata
- Plan artefact ID reference

---

## 6. Tower Judgement

### 6a. Tower Configuration

Tower can operate in two modes:

- **Live mode**: HTTP POST to `${TOWER_BASE_URL}/api/tower/judge-artefact` with `X-TOWER-API-KEY` header
- **Stub mode** (`TOWER_ARTEFACT_JUDGE_STUB=true`): returns `{ verdict: 'pass', action: 'continue' }` immediately

If neither `TOWER_BASE_URL` nor `TOWER_URL` is set and stub mode is off, the system refuses to proceed (throws at startup via `assertTowerConfig()`).

### 6b. Judgement Request

The `leads_list` artefact is submitted to Tower via `judgeArtefact()` with `successCriteria` containing:

- `mission_type`: `'leadgen'`
- `target_count`: the user's requested count
- `user_specified_count`: boolean
- `prefix`: the prefix filter (if any)
- `plan_version`: current version number
- `hard_constraints` and `soft_constraints` arrays
- `constraints`: typed constraint objects
- `plan_constraints`: business type, location, country, search count, requested count, prefix filter
- `max_replan_versions`: `MAX_REPLANS + 1`

### 6c. Judgement Response

Tower returns an `ArtefactJudgementResponse`:

```typescript
{
  verdict: string;          // e.g. 'pass', 'fail', 'error'
  reasons: string[];        // human-readable explanations
  metrics: Record<string, unknown>;
  action: 'continue' | 'stop' | 'retry' | 'change_plan';
  gaps?: Array<{ type, severity?, detail? }>;
  suggested_changes?: Array<{ field, action, reason?, current_value?, suggested_value? }>;
}
```

### 6d. shouldStop Determination

`shouldStop` is `true` when:

- `action === 'stop'`, OR
- `verdict === 'error'`, OR
- `verdict === 'fail'` AND `action !== 'change_plan'`

### 6e. Error Handling (Two Layers)

**Layer 1 — Inside `judgeArtefact()` (`tower-artefact-judge.ts`):**

- If `TOWER_BASE_URL` is not set and stub mode is off: returns `{ verdict: 'error', action: 'stop', shouldStop: true }` and logs a `tower_judgement_failed` AFR event. The run will halt.
- If the HTTP fetch to Tower throws: returns `{ verdict: 'error', action: 'continue', shouldStop: false }` and logs a `tower_judgement_failed` AFR event. The run continues despite the Tower failure.

**Layer 2 — Inside `executeTowerLoopChat()` (`supervisor.ts`):**

- If `judgeArtefact()` itself throws (i.e., an unexpected exception not caught by Layer 1): the outer try/catch creates a `tower_judgement` artefact with `verdict: 'error'`, `action: 'stop'`, emits a `delivery_summary`, terminates the run, and returns results with a message that Tower validation was unavailable. See Section 10 "Tower-Unreachable" for details.

### 6f. Tower Judgement Artefact

Regardless of outcome, a `tower_judgement` artefact is created and persisted, plus posted to the UI via `postArtefactToUI()`.

---

## 7. Local Replan Override (Safety Net)

Before entering the replan loop, a local safety net checks whether the supervisor should override Tower's decision:

**Conditions (all must be true):**

1. Tower did NOT return `action: 'change_plan'`
2. Not using stub data
3. Replans used < `MAX_REPLANS`
4. Delivered count < target count (quantifiable shortfall)
5. `'location'` is in `soft_constraints`

**Effect**: If all conditions are met, `finalAction` is overridden to `'change_plan'` with a synthetic directive containing `{ field: 'location', action: 'expand' }`. An AFR event is logged for the override.

---

## 8. Replan Loop

The replan loop runs as a `while` loop: `while (finalAction === 'change_plan' && !usedStub)`.

### 8a. Loop Guard

If `replansUsed >= MAX_REPLANS`:

- A `terminal` artefact is created recording `reason: 'max_replans_exceeded'`
- The loop breaks

### 8b. Directive Extraction (`extractChangePlanDirective`)

The Tower judgement is parsed to extract:

- **Gaps**: from `judgement.gaps` array, or inferred from `judgement.reasons` via `inferGapType()`
  - Types: `insufficient_count`, `constraint_too_strict`, `location_too_narrow`, `quality_issue`, `general_gap`
- **Suggested changes**: from `judgement.suggested_changes`, or derived from gaps via `deriveChangesFromGaps()`

If Tower provides neither `gaps` nor `suggested_changes`, the system derives changes from reasons text:

| Gap Type | Derived Change |
|---|---|
| `constraint_too_strict` | Drop `prefix_filter` |
| `insufficient_count` or `location_too_narrow` | Expand `location` |
| `insufficient_count` (without constraint_too_strict) | Increase `search_count` |
| (fallback if no changes derived) | Expand `location` |

### 8c. Replan Policy Application (`applyLeadgenReplanPolicy`)

The replan policy processes each suggested change against constraint hardness:

| Change | Action | Behavior |
|---|---|---|
| `prefix_filter` drop/relax | If soft: removes prefix filter. If hard: blocked. |
| `location` expand | If soft: advances radius ladder. If hard: blocked. |
| `search_count` increase | Sets to `min(60, max(current_search_count, 40))`. Only applies if the computed value differs from current. No hardness check applies to this field. |
| `business_type` broaden | If soft: replaces with `suggested_value`. If hard: blocked. |

**Radius Ladder** (`RADIUS_LADDER_KM`): `[0, 5, 10, 25, 50, 100]`

Location expansion changes the location string from `"arundel"` to `"arundel within 5km"`, then `"arundel within 10km"`, etc.

**Blocked changes**: When a suggested change targets a hard constraint, it is recorded in `blocked_changes` (with `blocked_reason`) and no adjustment is made. Blocked changes are logged and included in replan AFR metadata.

**Fallback**: If no adjustments were made (`no_progress: true`) and location is soft and radius is not at max, the policy attempts a radius ladder expansion as a fallback. If the radius is already at max, `cannot_expand_further` is set to `true`.

**Stop conditions within replan policy:**

- `no_progress: true` AND `cannot_expand_further: true` → loop breaks
- Constraints are identical before and after policy application → loop breaks

### 8d. Early Stop Check (Pre-Execution)

Before executing the replan search, accumulated candidates are checked:

- If all hard constraints are satisfied AND matching count >= user requested count → set `finalAction = 'accept'`, `finalVerdict = 'pass'`, break

### 8e. Replan Execution

A new `plan` artefact is created (e.g., Plan v2), then SEARCH_PLACES is re-executed with the adjusted constraints. Results go through the same prefix/name/count filtering. New leads are merged into `accumulatedCandidates` using deduplication keys (place_id or name+address hash).

A `step_result` artefact is created and submitted to Tower for observation-only judgement (no control flow impact).

A `leads_list` artefact is created for the replan results and submitted to Tower for a **full judgement** (this one drives the next loop iteration).

### 8f. Early Stop Check (Post-Execution)

After accumulation:

- If hard constraints satisfied AND matching count met → break with `finalAction = 'accept'`
- If zero new unique leads and Tower action is NOT `change_plan` → break (stale results)
- If zero new unique leads but Tower says `change_plan` → continue (Tower believes further expansion may help)

### 8g. Loop Variables Updated

At the end of each iteration: `finalVerdict`, `finalAction`, `finalLeads`, `currentConstraints`, `priorPlanArtefactId`, `priorLeadsCount` are all updated to reflect the latest replan results.

---

## 9. Final Lead Assembly

After the replan loop exits, the system decides which leads to deliver:

### 9a. Union Build Condition

A union of accumulated candidates is built when EITHER:

- `hasHardNameConstraints` is true (there are hard NAME_STARTS_WITH or NAME_CONTAINS constraints), OR
- Replans occurred (`replansUsed > 0`) AND total unique accumulated leads exceed the last batch size

### 9b. Union Build Process

When the union build triggers:

1. `countMatchingLeads()` filters accumulated candidates through hard name constraints (prefix starts-with and/or contains checks)
2. Matching candidates are mapped to the lead structure (`name, address, phone, website, placeId, source`)
3. If `userRequestedCountFinal` is not null, the list is sliced to that count
4. `finalLeads` is replaced with this union list

When the union build does NOT trigger, `finalLeads` remains as the last batch of leads from the most recent plan execution.

---

## 10. Terminal State

### Early-Stop Override

Before determining terminal state, a regression guard runs: if the replan loop's early-stop logic set `finalVerdict = 'pass'` but the last Tower result still has `shouldStop: true` (stale from a prior fail), `shouldStop` is overridden to `false`. This ensures the early-stop acceptance is not masked by a prior Tower failure.

### Halted

A run is halted (`isHalted = true`) when ALL of:

- `finalVerdict !== 'pass'`
- `finalAction !== 'change_plan'`
- (`finalTowerResult.shouldStop === true` OR `finalVerdict === 'error'`)

Effect:

- `agent_run` updated: `status: 'completed'`, `terminalState: 'stopped'`
- Response message includes "didn't fully meet quality criteria" and offers to retry

### Completed

When `isHalted` is false:

- `agent_run` updated: `status: 'completed'`, `terminalState: 'completed'`
- Response message: "validated by our quality system" with a link to `/leads`

### Tower-Unreachable (Separate Branch)

There is a separate early-exit path: if `judgeArtefact()` itself throws (i.e., the Tower call raises an exception at the `executeTowerLoopChat` level, not inside `judgeArtefact`'s internal catch), the system:

1. Creates a `tower_judgement` artefact with `verdict: 'error'`, `action: 'stop'`
2. Posts it to the UI
3. Updates `agent_run` to `status: 'completed'`, `terminalState: 'stopped'`
4. Emits a `delivery_summary`
5. Returns immediately with a message that Tower validation was unavailable but results can still be viewed

This is distinct from `judgeArtefact`'s internal HTTP failure handling (see Section 6e).

---

## 11. Artefact Emission Sequence

For a complete run, the following artefacts are emitted in order:

1. **`plan`** — Plan v1 (before execution)
2. **`step_result`** — SEARCH_PLACES v1 results
3. **`tower_judgement`** — Observation on step_result (observation-only)
4. **`leads_list`** — v1 leads list
5. **`tower_judgement`** — Full judgement on leads_list
6. **`accumulation_update`** — v1 accumulation stats

If replanning occurs (repeated per replan iteration):

7. **`plan`** — Plan vN
8. **`step_result`** — SEARCH_PLACES vN results
9. **`tower_judgement`** — Observation on step_result (observation-only)
10. **`leads_list`** — vN leads list
11. **`tower_judgement`** — Full judgement on leads_list
12. **`accumulation_update`** — vN accumulation stats

If max replans exceeded:

- **`terminal`** — reason: `max_replans_exceeded`

Always at the end:

- **`delivery_summary`** — final summary with all plan versions, soft relaxations, final verdict

### UI Posting

In addition to persisted artefacts, `postArtefactToUI()` pushes two payloads to the UI at the end of execution:

1. **`tower_judgement`** — final verdict, action, reasons, metrics, accumulated counts
2. **`leads`** — final lead list with query context, Tower verdict, per-plan stats, and constraint relaxation details

These UI posts are fire-and-forget (errors are caught and swallowed).

---

## 12. Delivery Summary

`emitDeliverySummary()` accepts inputs (`originalUserGoal`, `requestedCount`, `hardConstraints`, `softConstraints`, `planVersions`, `softRelaxations`, `leads`, `finalVerdict`, `stopReason`) and transforms them into a `DeliverySummaryPayload` via `buildDeliverySummaryPayload()`.

### 12a. Lead Classification

Each lead is classified as `'exact'` or `'closest'`:

- **Hard constraint check**: each hard constraint string is parsed for `key=value` patterns. If the lead's name/address doesn't include the value for query/keyword/type/category constraints, it's a hard violation → classified as `'closest'`.
- **Soft constraint check** (only if no hard violations): each `SoftRelaxation` is checked. For location constraints, the lead's address must contain the original value. For prefix constraints, the lead's name must start with the original value. For non-textual constraints (radius/distance/count), the check uses `found_in_plan_version` vs. relaxation `plan_version`. Any violations → `'closest'`.
- No violations → `'exact'`.

### 12b. Output Payload

The `delivery_summary` artefact payload contains:

| Field | Description |
|---|---|
| `requested_count` | User's requested count |
| `hard_constraints` | Array of hard constraint strings |
| `soft_constraints` | Array of soft constraint strings |
| `plan_versions` | Array of `{ version, changes_made }` |
| `soft_relaxations` | Array of `{ constraint, from, to, reason, plan_version }` |
| `delivered_exact` | Array of leads classified as exact matches (`{ entity_id, name, address, match_level, soft_violations }`) |
| `delivered_closest` | Array of leads classified as closest matches |
| `delivered_exact_count` | Count of exact matches |
| `delivered_total_count` | Total delivered (exact + closest) |
| `shortfall` | `max(0, requested_count - delivered_total_count)` |
| `stop_reason` | Set if there's a shortfall or non-pass verdict; uses provided `stopReason` or derives one |
| `suggested_next_question` | Derived follow-up question if exact count < requested (e.g., "Do you want me to include nearby results?") |

### 12c. Stop Reason Derivation

A `stop_reason` is set when `delivered_total_count < requestedCount` OR `finalVerdict` is not `'pass'`/`'ACCEPT'`. If the caller provided a `stopReason`, that's used; otherwise it defaults to `"Delivered N of M requested"` (shortfall) or `"Run ended with verdict: X"` (failure).

### 12d. Suggested Next Question

Derived only when `exact_count < requested_count` and soft relaxations exist:

- Multiple relaxations → "Do you want me to broaden the criteria?"
- Single location/radius/area relaxation → "Do you want me to include nearby results?"
- Other single relaxation → "Do you want me to include similar matches?"

---

## 13. AFR (Audit/Flow/Reporting) Events

Throughout execution, `logAFREvent()` is called at each significant state transition:

| Event (`actionTaken`) | When |
|---|---|
| `artefact_created` | After every artefact creation |
| `plan_execution_started` | Before executing each plan version |
| `step_started` | Before SEARCH_PLACES call |
| `step_completed` | After SEARCH_PLACES returns |
| `tower_call_started` | Before calling Tower |
| `tower_verdict` | After Tower returns |
| `tower_judgement` | After Tower judgement persisted |
| `tower_judgement_failed` | When Tower call fails |
| `replan_override` | When local safety net overrides Tower |
| `replan_initiated` | When starting a replan iteration |
| `replan_completed` | After replan iteration finishes |
| `run_completed` | Successful termination |
| `run_halted` | Failed/stopped termination |
| `run_stopped` | Tower error termination |

---

## 14. Constants and Defaults

| Constant | Value | Source |
|---|---|---|
| Default search budget | 20 | `max(20, requestedCount)` |
| Max search budget cap | 200 | `Math.min(Number(searchQuery.count), 200)` |
| `MAX_REPLANS` | 5 (default) | `process.env.MAX_REPLANS` |
| `RADIUS_LADDER_KM` | `[0, 5, 10, 25, 50, 100]` | `agent-loop.ts` |
| Replan search_count increase | 40–60 | `min(60, max(current, 40))` |
| Lead score | 0.75 | Hard-coded in lead persistence |
| Stub lead count | 5 | `generateStubLeads()` |
| Default business type | "pubs" | Regex fallback default |
| Default location | "Local" | Regex fallback default |
| Default country | "UK" | Regex fallback / schema default |

---

## 15. Two Execution Paths (Historical Note)

Two execution path implementations exist in the codebase:

1. **`agent-loop.ts`** — Older implementation with radius ladder, ACCEPT/RETRY/CHANGE_PLAN/STOP verdicts, and retry logic (maxRetry=1). Defined `RADIUS_LADDER_KM` and `AccumulatedCandidate` which are imported by other modules.

2. **`plan-executor.ts`** — Step-by-step executor with `MAX_RETRIES=2` and `MAX_PLAN_VERSIONS=2` constants. Supports multi-step plans (SEARCH_PLACES, ENRICH_LEADS, SCORE_LEADS) in its type definitions.

The active Lead-Finder chat path (`executeTowerLoopChat`) in `supervisor.ts` implements its own inline version that draws on both: it uses `RADIUS_LADDER_KM` and `AccumulatedCandidate` from `agent-loop.ts`, and the replan policy from `replan-policy.ts`. It does **not** call `agent-loop.ts` or `plan-executor.ts` directly for the tower-loop-chat flow.
