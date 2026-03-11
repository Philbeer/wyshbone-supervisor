# Wyshbone Supervisor — Benchmark Reference: Expected System Behaviour

**Generated**: 2026-03-11  
**Scope**: Full end-to-end expected behaviour for benchmark calibration

---

## 1. Tower Verdicts

The system has two Tower verdict vocabularies — the **legacy agent-loop** path and the **active executeTowerLoopChat** path — plus a **canonical normalised** layer used in delivery summaries.

### 1a. Active Path — Raw Tower HTTP Verdicts

These are the strings returned by the external Tower service over HTTP and normalised inside `server/supervisor/delivery-summary.ts`:

| Raw Tower String | Normalised To | Canonical Status | Meaning |
|---|---|---|---|
| `pass`, `accepted`, `continue`, `approved` | `PASS` | `PASS` | All criteria met; results accepted in full |
| `accept_with_unverified` | `PASS_UNVERIFIED` | `PARTIAL` | Results accepted but one or more constraints could not be verified; delivered as partial |
| `change_plan` | `CHANGE_PLAN` | `CHANGE_PLAN` | Current search approach is insufficient; system should replan (expand radius, drop prefix, broaden type) |
| `fail`, `reject`, `rejected`, `blocked` | `FAIL` | `STOP` | Results do not meet criteria and cannot be recovered by replan; run halted |
| `stop` | `FAIL` | `STOP` | Hard termination — Tower has decided no further progress is possible |
| `error` | `FAIL` | `STOP` | Tower system error; run halted |
| `retry` | `RETRY` | *(loop only)* | Retry the same tool with the same args once (max 1 retry before escalating to STOP) |

**Canonical Verdict type** (`CanonicalVerdict`): `'PASS' | 'PARTIAL' | 'STOP' | 'ERROR' | 'CHANGE_PLAN'`

### 1b. Legacy Agent-Loop Verdicts (`TowerVerdictV1`, `server/supervisor/agent-loop.ts`)

Used in the older `handleTowerVerdict` path (not the primary tower-loop-chat path):

| Verdict | Meaning |
|---|---|
| `ACCEPT` | Run is complete; emit delivery summary. Maps from Tower raw `pass`. |
| `RETRY` | Output was flawed but retriable with identical args. Maximum 1 retry; if already retried, escalates to STOP. Maps from Tower raw `retry`. |
| `CHANGE_PLAN` | Current approach is failing (e.g. insufficient leads). Increment `plan_version`, adjust search args (radius expansion ladder), rerun. Maps from Tower raw `replan`/`change_plan`. |
| `STOP` | Task cannot be completed. Execution halted; stop reason recorded. Maps from Tower raw `fail`/`stop`/`error`. |

> **Confirmation**: The 4 verdicts ACCEPT, RETRY, CHANGE_PLAN, STOP are correct for the legacy agent-loop path. The active tower-loop-chat path normalises raw Tower strings differently (see 1a above) — it does not use RETRY as a canonical output, and ACCEPT_WITH_UNVERIFIED is treated as a distinct `PASS_UNVERIFIED` state that forces a `PARTIAL` outcome.

---

## 2. Behaviour Judge / QA Layer Outcomes

The QA layer is an **observability and benchmarking** layer that runs after every mission. Its outcomes are computed by `server/evaluator/qaLayerSummary.ts` based on seven internal layer statuses.

### 2a. QA Layer — OverallOutcome Values (code-level)

| Outcome | Meaning | Trigger Condition |
|---|---|---|
| `PASS` | All layers succeeded | Discovery pass + Delivery pass + Verification pass + Tower pass (or Tower unknown with Verification pass) |
| `PARTIAL_SUCCESS` | Discovery and delivery succeeded but verification or Tower failed | Core layers pass; verification fail or tower fail |
| `BLOCKED` | Execution never started — gate stopped it | `blockedByClarify` (Clarify Gate) or `blockedByGate` (Constraint Gate) returned true |
| `TIMEOUT` | Run exceeded time limit before completing | `runTimedOut` flag set |
| `FAIL` | A foundational layer failed | Interpretation fail, planning fail, execution fail, discovery fail, delivery fail |

### 2b. Behaviour Judge — Audit/Forensic Classification Terms

The terms `HONEST_PARTIAL`, `BATCH_EXHAUSTED`, `CAPABILITY_FAIL`, and `WRONG_DECISION` appear in audit and forensic reports as **descriptive classification labels** for evaluating run truthfulness. They are not enum values in production code. Their meanings for benchmark calibration:

| Term | Maps To QA Outcome | Meaning |
|---|---|---|
| `PASS` | `PASS` | Agent delivered the full requested count of verified leads satisfying all hard constraints. Tower confirmed pass. |
| `HONEST_PARTIAL` | `PARTIAL_SUCCESS` | Agent correctly identified it could not meet the full count, reported the shortfall honestly, and delivered the best available verified subset. The delivery_summary includes a `stop_reason` and `suggested_next_question`. |
| `BATCH_EXHAUSTED` | `PARTIAL_SUCCESS` or `FAIL` | Discovery returned all available candidates but the count target was not met. Agent may or may not have handled the transition or triggered correct replanning. Distinguished from HONEST_PARTIAL by whether the replan loop ran correctly. |
| `CAPABILITY_FAIL` | `BLOCKED` or `FAIL` | The task requires a capability the system cannot currently exercise — tool missing, API unavailable, constraint unverifiable, or CVL capability check returned `cannot_verify`. |
| `WRONG_DECISION` | `PARTIAL_SUCCESS` or `FAIL` | The Tower or agent made an incorrect logical choice — e.g. accepted a lead that violates a hard constraint, or halted prematurely when more results were available. Identified by the delivery classification system or post-hoc audit. |

---

## 3. Full Pipeline (for context)

```
User input
→ Clarify Gate           [route: direct_response | clarify_before_run | agent_run]
→ Constraint Gate        [can_execute: true/false; blocks subjective/time/relationship predicates]
→ Goal Parser            [parseGoalToConstraints → LLM then regex fallback]
→ CVL Capability Check   [buildCapabilityCheck → can each constraint be verified?]
→ Mission Planner        [buildToolPlan → strategy + tool sequence]
→ Plan Executor          [executePlan → step-by-step]
→ Tool Execution         [SEARCH_PLACES / WEB_VISIT / EVIDENCE_EXTRACT / CONTACT_EXTRACT]
→ Tower Judgement        [judgeArtefact → pass/fail/change_plan/accept_with_unverified]
→ Replan Loop            [while change_plan && !usedStub && replansUsed < MAX_REPLANS]
→ CVL Lead Verification  [verifyLeads → per-lead constraint check]
→ Delivery Summary       [emitDeliverySummary → canonical status, exact/closest classification]
→ QA Layer Summary       [buildQALayerSummary → OverallOutcome for benchmarking]
```

---

## 4. Expected Behaviour by Query Type

### 4.1 Clear Discoverable Query
**Example**: "Find pubs in Arundel with Swan in the name"

| Dimension | Expected |
|---|---|
| **Clarify Gate route** | `agent_run` — clear entity type, clear location, clear name filter |
| **Constraint Gate** | `can_execute: true` — NAME_CONTAINS is verifiable client-side |
| **Constraints extracted** | `COUNT_MIN` (default 20, hard), `LOCATION_EQUALS` "Arundel" (soft), `NAME_CONTAINS` "Swan" (soft unless "must") |
| **Strategy** | `discovery_only` |
| **Tool sequence** | `SEARCH_PLACES` → client-side name filter → `leads_list` → Tower judge |
| **Name filter mechanism** | Applied client-side as case-insensitive `includes` check after SEARCH_PLACES returns |
| **Replan behaviour** | If count not met, radius ladder expansion (Arundel → within 5km → 10km → 25km…) |
| **Tower response expected** | `pass` if sufficient results found; `change_plan` if count not met |
| **Canonical delivery status** | `PASS` if results found; `PARTIAL` if shortfall; `STOP` if zero results after all replans |

**Perfect run**: Tower `pass` → Canonical `PASS` → QA `PASS`

---

### 4.2 Discovery-Only Query
**Example**: "Find 10 cafes in York"

| Dimension | Expected |
|---|---|
| **Clarify Gate route** | `agent_run` — clear entity, clear location, explicit count |
| **Constraint Gate** | `can_execute: true` |
| **Constraints extracted** | `COUNT_MIN` 10 (hard), `LOCATION_EQUALS` "York" (soft) |
| **Strategy** | `discovery_only` |
| **Tool sequence** | `SEARCH_PLACES` only |
| **Verification** | None — directory data only, no website visits |
| **Replan behaviour** | Radius expansion if fewer than 10 returned |
| **Tower response expected** | `pass` if ≥10 delivered |
| **Canonical delivery status** | `PASS` |

**Perfect run**: Tower `pass` → Canonical `PASS` → QA `PASS`

> Note: `leadsWithVerification` will be 0 for this query type; QA `verification_status` = `fail`, so overall QA outcome is `PARTIAL_SUCCESS` unless the benchmark definition treats directory-sourced leads as inherently verified.

---

### 4.3 Website Evidence Query
**Example**: "Find restaurants in Bath with vegan options"

| Dimension | Expected |
|---|---|
| **Clarify Gate route** | `agent_run` — clear entity, clear location, verifiable attribute |
| **Constraint Gate** | `can_execute: true` — attribute classified as verifiable via website visit |
| **Constraints extracted** | `LOCATION_EQUALS` "Bath" (soft), `HAS_ATTRIBUTE` "vegan options" (hard) |
| **Strategy** | `discovery_then_website_evidence` |
| **Tool sequence** | `SEARCH_PLACES` → `WEB_VISIT` (per candidate) → `EVIDENCE_EXTRACT` → `TOWER_JUDGE` |
| **Verification policy** | `WEBSITE_VERIFIED` |
| **CVL behaviour** | Marks each lead `verified`, `unverified`, or `unknown` for the vegan attribute |
| **Tower response expected** | `pass` if all hard constraints verified; `accept_with_unverified` if some leads lack evidence |
| **Canonical delivery status** | `PASS` (all verified) or `PARTIAL` (some unverified) |
| **Delivery classification** | Verified leads → `exact`; unverified leads → `closest` |

**Perfect run**: All leads verified → Tower `pass` → Canonical `PASS` → QA `PASS`  
**Acceptable partial run**: Some verified → Tower `accept_with_unverified` → Canonical `PARTIAL` → QA `PARTIAL_SUCCESS`, Behaviour Judge: `HONEST_PARTIAL`

---

### 4.4 Vague / Ambiguous Query
**Example**: "Find amazing vibes in London"

| Dimension | Expected |
|---|---|
| **Clarify Gate route** | `agent_run` (location present, entity attempted) |
| **Constraint Gate** | `can_execute: false` — subjective term ("amazing vibes") detected; unquantifiable |
| **Gate behaviour** | Blocks execution; returns clarification question: asks user for a measurable definition |
| **Agent execution** | Does not start |
| **Tower called** | No |
| **Canonical delivery status** | N/A — no run |
| **QA outcome** | `BLOCKED` (blockedByGate = true) |

**Perfect run**: Gate fires correctly, explains why the term is unverifiable, asks for measurable substitute → QA `BLOCKED`  
**Behaviour Judge**: `CAPABILITY_FAIL` (the system correctly recognises it cannot execute)

---

### 4.5 Impossible / Fictional Query
**Example**: "Find pubs in Narnia"

| Dimension | Expected |
|---|---|
| **Clarify Gate route** | `refuse` — LLM-backed Location Validity Checker identifies fictional/nonsense location |
| **Gate behaviour** | Politely refuses; no agent run, no clarification loop |
| **Agent execution** | Does not start |
| **Tower called** | No |
| **QA outcome** | `BLOCKED` (blockedByClarify = true) |

**Perfect run**: Clarify Gate correctly identifies fictional location, returns polite refusal → QA `BLOCKED`  
**Behaviour Judge**: `CAPABILITY_FAIL` (correct system behaviour — refusing is the right action)

---

### 4.6 Clarification-Required Query (Missing Location)
**Example**: "Find breweries" (no location specified)

| Dimension | Expected |
|---|---|
| **Clarify Gate route** | `clarify_before_run` — missing location field |
| **Gate behaviour** | Asks 1–3 targeted questions; explicitly states execution will wait; never starts run |
| **ClarifySession created** | Yes — tracks `missingFields: ['location']`, `collectedFields: { businessType: 'breweries' }` |
| **Agent execution** | Suspended until location is provided |
| **Tower called** | No |
| **QA outcome** | `BLOCKED` (blockedByClarify = true) |
| **Follow-up handling** | When user provides location (e.g. "Yorkshire"), classified as `ANSWER_TO_MISSING_FIELD` → session completes → `agent_run` proceeds |

**Perfect run**: Gate fires, asks for location, waits — no premature execution → QA `BLOCKED`  
**Behaviour Judge**: `CAPABILITY_FAIL` (correctly parked; not a failure, it's the correct gate behaviour)

---

### 4.7 Relationship Query
**Example**: "Find organisations working with the local authority" (no location)

| Dimension | Expected |
|---|---|
| **Clarify Gate route** | `clarify_before_run` — relationship predicate detected ("working with") + vague entity type ("organisations") + missing location. All three trigger clarification. |
| **Gate behaviour** | Asks for: (1) location, (2) specific sector/type of organisation, (3) confirmation of the relationship to verify |
| **Agent execution** | Suspended until fields resolved |
| **QA outcome** | `BLOCKED` |

**If the query were fully specified** (e.g. "Find housing associations in Leeds that work with Leeds City Council"):

| Dimension | Expected |
|---|---|
| **Clarify Gate route** | `clarify_before_run` — relationship predicate still triggers clarification to confirm verification approach |
| **If user confirms** | `agent_run` proceeds |
| **Strategy** | `discovery_then_external_evidence` |
| **Tool sequence** | `SEARCH_PLACES` → `WEB_SEARCH` (relationship search) → `WEB_VISIT` → `EVIDENCE_EXTRACT` → `TOWER_JUDGE` |
| **Verification policy** | `RELATIONSHIP_VERIFIED` |
| **Relationship direction** | Determined by `relationship-direction.ts` heuristic (institutional score) — searches "forward" or "reverse" |
| **Invariant** | NEVER degrades to discovery-only; if relationship unverified → `closest` classification |
| **Tower response expected** | `pass` if relationship verified; `accept_with_unverified` if partially verified |
| **Canonical delivery status** | `PASS` (verified) or `PARTIAL` (some unverified) or `STOP` (no evidence found) |

**Perfect run for vague form**: Gate fires, asks clarifying questions → QA `BLOCKED`  
**Perfect run for fully specified form**: Relationship verified for all leads → Tower `pass` → Canonical `PASS` → QA `PASS`  
**Behaviour Judge**: `HONEST_PARTIAL` if only some relationships verified

---

## 5. Verdict / Outcome Matrix for Perfect Benchmark Runs

| Query Type | Expected Clarify Gate Route | Expected Tower Verdict | Expected Canonical Status | Expected QA OverallOutcome | Behaviour Judge Label |
|---|---|---|---|---|---|
| Clear discoverable (pubs in Arundel, Swan in name) | `agent_run` | `pass` | `PASS` | `PASS` | `PASS` |
| Discovery-only (10 cafes in York) | `agent_run` | `pass` | `PASS` | `PARTIAL_SUCCESS`* | `PASS` |
| Website evidence (restaurants in Bath, vegan) | `agent_run` | `pass` | `PASS` | `PASS` | `PASS` |
| Vague/ambiguous (amazing vibes in London) | `agent_run` → Constraint Gate blocks | N/A | N/A | `BLOCKED` | `CAPABILITY_FAIL` |
| Impossible/fictional (pubs in Narnia) | `refuse` | N/A | N/A | `BLOCKED` | `CAPABILITY_FAIL` |
| Clarification-required (find breweries, no location) | `clarify_before_run` | N/A | N/A | `BLOCKED` | `CAPABILITY_FAIL` |
| Relationship (orgs + local authority, vague) | `clarify_before_run` | N/A | N/A | `BLOCKED` | `CAPABILITY_FAIL` |

\* Discovery-only runs produce `leadsWithVerification = 0`, so QA `verification_status = fail`, pushing overall to `PARTIAL_SUCCESS` unless the benchmark definition overrides this for pure discovery strategies.

---

## 6. Key Constants for Benchmark Calibration

| Parameter | Value | Source |
|---|---|---|
| Default search budget | 20 | `max(20, requestedCount)` |
| MAX_REPLANS | 5 (default) | `process.env.MAX_REPLANS` |
| RADIUS_LADDER_KM | [0, 5, 10, 25, 50, 100] | `agent-loop.ts` |
| Max retry per step | 1 (agent-loop) / 2 (plan-executor) | Hard-coded |
| Stub mode Tower verdict | `pass` (auto-ACCEPT) | `TOWER_ARTEFACT_JUDGE_STUB=true` |
| No Tower URL (hard gate) | `STOP` | `assertTowerConfig()` |
| ClarifySession TTL | 15 minutes | `clarify-session.ts` |
| Max clarification questions | 3 | `clarify-gate.ts` |

---

## 7. Artefact Sequence for a Perfect Discovery Run

```
1. plan (v1)
2. step_result (SEARCH_PLACES v1)
3. tower_judgement (observation-only on step_result — no control flow)
4. leads_list (v1)
5. tower_judgement (full judgement on leads_list — drives replan/accept decision)
6. accumulation_update (v1)
[7-12. repeated per replan iteration if needed]
N-1. delivery_summary
N.   run_receipt
```

---

*This document reflects the codebase state as of 2026-03-11. Key files: `server/supervisor/clarify-gate.ts`, `server/supervisor/delivery-summary.ts`, `server/supervisor/agent-loop.ts`, `server/evaluator/qaLayerSummary.ts`, `docs/LEAD_FINDER_BASELINE_BEHAVIOR.md`, `docs/clarify-gate.md`.*
