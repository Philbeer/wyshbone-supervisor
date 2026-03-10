# Supervisor Judgement & Evidence Flow Audit

**Date:** 2026-03-10  
**Scope:** Current Supervisor-side constraint parsing, evidence collection, run-level verdict derivation, and data structures passed to Tower.

---

## 1. Architecture Summary (Plain English)

The Supervisor is an autonomous execution engine that:

1. **Parses** a user query into a `ParsedGoal` containing typed `StructuredConstraint` objects.
2. **Plans** a multi-step tool sequence (e.g., Google Places search, website visits) based on constraint types.
3. **Executes** the plan: discovers candidate leads via search, then optionally visits websites to gather evidence for attribute/relationship constraints.
4. **Verifies** each lead against each constraint using the CVL (Canonical Verification Layer) — a deterministic checker that compares lead data against constraints.
5. **Sends evidence to Tower** for semantic verification (per-lead, per-constraint) — Tower returns `verified | weak_match | no_evidence | insufficient_evidence`.
6. **Filters leads** by hard constraint evidence, then builds a final delivery artefact.
7. **Sends the final delivery artefact to Tower** for an overall run-level judgement (`pass | fail | error` → action `continue | stop | retry | change_plan`).
8. **Builds a Delivery Summary** that derives a canonical status (`PASS | PARTIAL | STOP | ERROR | COMPLETED`) and splits leads into `delivered_exact` vs. `delivered_closest`.
9. **Emits QA/Benchmark logs** that classify the run across 7 layers (interpretation, planning, execution, discovery, delivery, verification, tower).

**Key architectural fact — two pipelines:** There are two active constraint pipelines:
- **Mission path** (primary): Uses `mission-extractor.ts` → `StructuredMission` with `MissionConstraint` objects using types like `text_compare`, `website_evidence`, `attribute_check`, `relationship_check`. Constraints default to `hardness: "hard"` in the mission extractor's LLM prompt. Tower receives `hard_constraints` and `soft_constraints` as **normalized label strings** (e.g., `"name_contains"`, `"website_evidence"`), not raw constraint IDs.
- **Legacy path** (fallback): Uses `goal-to-constraints.ts` → `ParsedGoal` with `StructuredConstraint` objects using types like `NAME_CONTAINS`, `HAS_ATTRIBUTE`. Tower receives flat constraint ID strings (e.g., `"c_attr_beer_garden"`).

In both paths, Tower receives per-lead evidence arrays with `constraint_type` and `constraint_value` in the final delivery artefact payload. However, the `successCriteria` object passed to Tower's `judgeArtefact()` does not include typed constraint objects — only the label/ID lists.

---

## 2. Files and Functions Involved

### 2.1 Constraint Parsing

| File | Function | Role |
|------|----------|------|
| `server/supervisor/mission-extractor.ts` | LLM extraction | **Primary path**: Extracts `StructuredMission` with `MissionConstraint[]` using types `text_compare`, `website_evidence`, `attribute_check`, etc. |
| `server/supervisor/mission-schema.ts` | Schema definition | Defines `MissionConstraintType` and operators |
| `server/supervisor/intent-extractor.ts` | `extractCanonicalIntent()` | Canonical intent extraction (intermediate path) |
| `server/supervisor/intent-bridge.ts` | `canonicalIntentToParsedGoal()` | Bridges canonical intent → `ParsedGoal` |
| `server/supervisor/goal-to-constraints.ts` | `callLLMForParsing()` | Legacy LLM-based parser (GPT-4o-mini / Claude Haiku) |
| `server/supervisor/goal-to-constraints.ts` | `regexFallback()` | Emergency fallback parser |
| `server/supervisor/mission-bridge.ts` | `missionToParsedGoal()` | Bridges active missions → `ParsedGoal` |

### 2.2 Evidence Collection & Transformation

| File | Function | Role |
|------|----------|------|
| `server/supervisor/mission-executor.ts` | `executeMission()` (lines 700–1000) | Orchestrates WEB_VISIT + WEB_SEARCH per lead |
| `server/supervisor/constraint-led-extractor.ts` | `extractConstraintLedEvidence()` | Keyword/synonym scan of page text against constraint value |
| `server/supervisor/tower-semantic-verify.ts` | `requestSemanticVerification()` | Sends extracted quotes to Tower `/api/tower/semantic-verify` |
| `server/supervisor/tower-semantic-verify.ts` | `towerStatusToVerdict()` | Maps Tower status → `{verdict, confidence, evidenceStrength}` |

### 2.3 CVL (Canonical Verification Layer)

| File | Function | Role |
|------|----------|------|
| `server/supervisor/cvl.ts` | `verifyLeads()` | Runs all constraints against all leads, produces `CvlVerificationOutput` |
| `server/supervisor/cvl.ts` | `verifyOneConstraint()` | Single constraint × single lead check |
| `server/supervisor/cvl.ts` | `buildCapabilityCheck()` | Pre-flight check: which constraints are verifiable? |

### 2.4 Delivery & Verdict

| File | Function | Role |
|------|----------|------|
| `server/supervisor/delivery-summary.ts` | `buildDeliverySummaryPayload()` | Derives canonical status, splits exact/closest |
| `server/supervisor/delivery-summary.ts` | `deriveCanonicalStatus()` | Status derivation: `COMPLETED` if any leads delivered |
| `server/supervisor/delivery-summary.ts` | `determineLeadExactness()` | Per-lead exact vs closest classification |
| `server/supervisor/tower-artefact-judge.ts` | `judgeArtefact()` | Final Tower judgement on the delivery artefact |
| `server/supervisor/tower-judgement.ts` | `requestJudgement()` | Step-level Tower evaluation (CONTINUE/STOP/CHANGE_PLAN) |
| `server/supervisor/verification-policy.ts` | `deriveVerificationPolicy()` | Determines `DIRECTORY_VERIFIED | WEBSITE_VERIFIED | RELATIONSHIP_VERIFIED` |

### 2.5 QA / Benchmark / AFR

| File | Function | Role |
|------|----------|------|
| `server/evaluator/qaLayerSummary.ts` | `buildQALayerSummary()` | 7-layer pass/fail classification |
| `server/evaluator/benchmarkLogger.ts` | `recordBenchmarkRun()` | Logs benchmark runs with failure classification |
| `server/evaluator/classifyRunFailure.ts` | `classifyRunFailure()` | Categorises failure type |
| `server/evaluator/failureClassification.ts` | `FailureClassification` enum | `INTERPRETATION_FAILURE | PLANNER_FAILURE | DISCOVERY_FAILURE | CRAWL_FAILURE | EVIDENCE_EXTRACTION_FAILURE | TOWER_JUDGEMENT_FAILURE | REPLAN_FAILURE | UI_TRUTH_FAILURE | NONE` |
| `server/supervisor/afr-logger.ts` | `logAFREvent()` | Per-step activity logging to `agent_activities` |
| `server/supervisor/run-receipt.ts` | `buildRunReceipt()` | Post-run forensic audit |

---

## 3. Data Structures Passed Forward

### 3.1 Constraints

```typescript
// server/supervisor/goal-to-constraints.ts
interface StructuredConstraint {
  id: string;           // e.g. 'c_count', 'c_attr_beer_garden', 'c_name_contains'
  type: ConstraintType; // 'COUNT_MIN' | 'LOCATION_EQUALS' | 'LOCATION_NEAR' | 'CATEGORY_EQUALS' |
                        // 'NAME_STARTS_WITH' | 'NAME_CONTAINS' | 'MUST_USE_TOOL' |
                        // 'HAS_ATTRIBUTE' | 'RELATIONSHIP_CHECK' | 'STATUS_CHECK' |
                        // 'TIME_CONSTRAINT' | 'WEBSITE_EVIDENCE' | 'RANKING'
  field: string;        // e.g. 'count', 'location', 'name', 'attribute'
  operator: string;     // e.g. '>=', '=', 'contains_word', 'has'
  value: string | number | { center: string; km: number };
  hard: boolean;        // THE primary enforcement toggle
  rationale: string;
  canonical?: { type, field, operator, value, hardness, value_secondary? }  // source intent
}
```

**Hard/soft defaults (from LLM system prompt and regex fallback):**
- Always hard: `COUNT_MIN`
- Default hard: `HAS_ATTRIBUTE` (soft only if user hedges: "preferably", "if possible")
- Default soft: `LOCATION_EQUALS`, `LOCATION_NEAR`, `NAME_STARTS_WITH`, `NAME_CONTAINS`, `MUST_USE_TOOL`

**Success criteria (flat ID lists):**
```typescript
interface SuccessCriteria {
  required_constraints: string[];  // IDs of hard constraints
  optional_constraints: string[];  // IDs of soft constraints
  target_count: number | null;
}
```

### 3.2 Evidence

**Per-lead evidence result (mission-executor internal):**
```typescript
interface EvidenceResult {
  leadIndex: number;
  leadName: string;
  leadPlaceId: string;
  constraintField: string;
  constraintValue: string;
  constraintType: string;        // e.g. 'attribute_check', 'relationship_check'
  evidenceFound: boolean;
  evidenceStrength: 'strong' | 'weak' | 'none';
  towerStatus: 'verified' | 'weak_match' | 'no_evidence' | 'insufficient_evidence' | null;
  towerConfidence: number | null;
  towerReasoning: string | null;
  sourceUrl: string | null;
  snippets: string[];
}
```

**CVL attribute evidence (passed into CVL):**
```typescript
type AttributeEvidenceMap = Map<string, Map<string, AttributeEvidenceEntry>>;
// outer key = placeId, inner key = attribute value (lowercased)

interface AttributeEvidenceEntry {
  verdict: 'yes' | 'no' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  evidenceUrl: string | null;
}
```

**CVL per-lead verification output:**
```typescript
interface LeadVerificationResult {
  lead_index: number;
  lead_name: string;
  lead_place_id: string;
  constraint_checks: ConstraintCheck[];  // one per constraint
  all_hard_satisfied: boolean;
  verified_exact: boolean;
  location_confidence: LocationConfidence;
}

interface ConstraintCheck {
  constraint_id: string;
  constraint_type: string;
  field: string;
  hard: boolean;
  status: 'yes' | 'no' | 'unknown' | 'search_bounded';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  evidence_id: string | null;
  geo_evidence?: { method, region_key, lat, lng };
}
```

### 3.3 Delivered Results

**What Tower receives as `successCriteria` in the final judgement call:**
```typescript
{
  mission_type: 'leadgen',
  target_count: number,
  requested_count_user: 'explicit' | 'implicit',
  requested_count_value: number | null,
  hard_constraints: string[],      // flat constraint ID strings, e.g. ['c_count', 'c_attr_beer_garden']
  soft_constraints: string[],      // flat constraint ID strings
  plan_constraints: {
    business_type: string,
    location: string,
    country: string,
    search_count: number,
    requested_count: number,
  },
  max_replan_versions: number,
  requires_relationship_evidence: boolean,
  run_deadline_exceeded: boolean,
  verification_policy: 'DIRECTORY_VERIFIED' | 'WEBSITE_VERIFIED' | 'RELATIONSHIP_VERIFIED',
  verification_policy_reason: string,
}
```

**What the delivery artefact carries (in its payload):**
```typescript
{
  execution_source: 'mission',
  delivered_count: number,
  target_count: number | null,
  evidence_summary: { total_checks, checks_with_evidence, tower_verified, tower_weak } | null,
  evidence_ready_for_tower: boolean,
  verification_policy: string,
  leads: Array<{
    name, address, phone, website, placeId, source,
    verified: boolean | undefined,
    verification_status: 'verified' | 'weak_match' | 'no_evidence' | 'ranking_only' | 'field_filter_only' | 'not_attempted',
    evidence: Array<{ constraint_field, constraint_value, constraint_type, evidence_found, evidence_strength, source_url, snippets, tower_status, tower_confidence }>,
    match_valid: boolean,
    match_summary: string,
    match_basis: MatchBasisItem[],
    supporting_evidence: SupportingEvidenceItem[],
    match_evidence: MatchEvidenceItem[],
  }>,
}
```

### 3.4 Run Verdict Inputs

**`DeliverySummaryInput` — what feeds into canonical status derivation:**
```typescript
interface DeliverySummaryInput {
  runId, userId, conversationId, originalUserGoal,
  requestedCount: number | null,
  hardConstraints: string[],        // flat ID lists
  softConstraints: string[],        // flat ID lists
  planVersions: PlanVersionEntry[],
  softRelaxations: SoftRelaxation[],
  leads: DeliverySummaryLeadInput[],
  finalVerdict: string,             // Tower's verdict string
  stopReason?: string | null,
  cvlVerifiedExactCount?: number | null,
  cvlUnverifiableCount?: number | null,
  cvlHardUnverifiable?: string[],
  cvlLeadVerifications?: CvlLeadVerification[],
  relationshipContext?: RelationshipContext,
  verificationPolicy?: VerificationPolicy,
}
```

**Canonical status derivation (`deriveCanonicalStatus`):**
```typescript
function deriveCanonicalStatus(
  verifiedExact, requested, towerVerdict, hasHardUnverifiable, deliveredTotal
): CanonicalVerdict {
  if (towerVerdict === 'ERROR' && totalDelivered === 0) return 'ERROR';
  if (totalDelivered > 0) return 'COMPLETED';     // ← ANY leads = COMPLETED
  if (hasHardUnverifiable) return 'STOP';
  return 'STOP';
}
```

**Key observation:** The current `deriveCanonicalStatus` is extremely coarse. If `deliveredTotal > 0`, the status is always `COMPLETED` regardless of constraint satisfaction quality. `PASS` and `PARTIAL` are dead code paths — they can never be reached by the current logic.

---

## 4. Gap Analysis

### 4.1 What Already Exists That Supports Claim-Sensitive Judgement

| Capability | Where | Status |
|-----------|-------|--------|
| Per-constraint `hard: boolean` flag | `StructuredConstraint.hard` | ✅ Exists and populated |
| Constraint type taxonomy (12 types) | `CONSTRAINT_TYPES` in `goal-to-constraints.ts` | ✅ Exists |
| Attribute-like grouping | `ATTRIBUTE_LIKE_TYPES` array | ✅ Exists |
| CVL per-constraint verification status | `ConstraintCheck.status` with `yes/no/unknown/search_bounded` | ✅ Exists |
| Verification policy tiers | `DIRECTORY_VERIFIED / WEBSITE_VERIFIED / RELATIONSHIP_VERIFIED` | ✅ Exists |
| Policy derivation from constraint types | `deriveVerificationPolicy()` | ✅ Exists |
| Per-lead evidence with Tower status | `EvidenceResult.towerStatus` | ✅ Exists |
| Keyword extraction with confidence scoring | `constraint-led-extractor.ts` sentence scoring | ✅ Exists |
| Tower semantic verification endpoint | `/api/tower/semantic-verify` | ✅ Exists |
| Hard evidence filtering (drops leads without evidence for hard constraints) | `mission-executor.ts` lines 1292–1312 | ✅ Exists |
| CVL `all_hard_satisfied` per lead | `LeadVerificationResult` | ✅ Exists |

### 4.2 What Is Missing

| Gap | Detail |
|-----|--------|
| **No constraint-type-aware proof burden** | All constraints with `hard: true` are treated identically in CVL. A `NAME_CONTAINS` constraint (trivially checkable from lead data) has the same proof burden as `HAS_ATTRIBUTE` (requires website evidence). |
| **No `evidence_requirement` per constraint** | There is no field like `evidence_requirement: 'name_match' | 'directory_data' | 'website_text' | 'external_source'` that tells Tower what KIND of evidence is needed. |
| **Tower receives flat ID strings, not typed constraint objects** | `successCriteria.hard_constraints` is `string[]` of IDs like `['c_count', 'c_attr_live_music']`. Tower cannot distinguish constraint types without parsing the ID. |
| **`deriveCanonicalStatus` is degenerate** | Any run with `deliveredTotal > 0` returns `COMPLETED`. The `PASS` and `PARTIAL` verdicts are unreachable. Constraint satisfaction quality does not influence the run-level status. |
| **No per-constraint verdict in delivery summary** | `DeliverySummaryPayload` carries `hard_constraints: string[]` and `cvl_summary` with aggregate counts, but not per-constraint pass/fail with evidence type. |
| **CVL `verified_exact` conflates all constraint types** | A lead is `verified_exact` if all hard constraints are `status === 'yes'`. But for `HAS_ATTRIBUTE` constraints, `status` is set from `AttributeEvidenceMap` which may contain Tower semantic results OR may be `unknown` if no website was visited — and both are treated equally. |
| **Evidence is not tagged with its provenance tier** | Evidence items don't carry a `source_tier: 'lead_field' | 'directory_api' | 'website_text' | 'web_search_snippet'` that would let Tower apply different trust levels. |
| **No constraint-type-specific minimum confidence** | Tower semantic verify returns a confidence score (0–1), but this is never thresholded differently per constraint type. A `weak_match` (confidence 0.4) for `HAS_ATTRIBUTE: "live music"` is treated the same as for `NAME_CONTAINS: "swan"`. |
| **Unchecked leads pass through hard evidence filter** | At `mission-executor.ts` line 1304: `if (!leadsChecked.has(i)) return true`. Leads that were never enriched (no website, skipped by batch limit) bypass the hard evidence filter entirely. This is a correctness bug, not just a gap. |
| **Benchmark/QA does not track per-constraint outcomes** | `QALayerSummaryPayload` has 7 binary layer statuses but no per-constraint verdict breakdown. Cannot see "B06 failed because `website_evidence: live music` had no website evidence." |
| **`FailureClassification` is run-level only** | The enum has no category for "evidence was found but was wrong type" or "constraint was satisfiable but required different evidence source." |
| **Mission vs legacy constraint type divergence** | Mission path uses `MissionConstraintType` (`text_compare`, `website_evidence`, etc.) while legacy uses `ConstraintType` (`NAME_CONTAINS`, `HAS_ATTRIBUTE`, etc.). Both coexist and feed into different parts of the system, creating mapping fragility. `verification-policy.ts` has an explicit `LEGACY_TO_MISSION_CONSTRAINT_TYPE` map to bridge them. |

---

## 5. Proof Burden: Are All Constraints Treated Equally?

**Yes — with one partial exception.**

The system currently treats all constraints with roughly the same proof burden at the verdict level:

1. **CVL verification** (`verifyOneConstraint`): The switch statement handles each type differently in terms of *how* it checks (name string comparison vs. geo bbox vs. attribute evidence map lookup), but the *outcome* is always the same `VerificationStatus` enum (`yes | no | unknown | search_bounded`). A `NAME_CONTAINS` that fails string matching produces `status: 'no'` with `confidence: 'high'`. An `HAS_ATTRIBUTE` with no website evidence produces `status: 'unknown'` with `confidence: 'low'`. Both are treated as "hard constraint not satisfied" if `hard: true`.

2. **Hard evidence filtering** (`mission-executor.ts` lines 1292–1312): This filters out leads that lack evidence for hard evidence constraints. But it operates on the `EvidenceResult` array, which only exists for attribute-like constraints. `NAME_CONTAINS` and `LOCATION_EQUALS` constraints do not produce `EvidenceResult` entries — they are handled entirely within CVL.

3. **Delivery summary**: `determineLeadExactness()` uses CVL's `verified_exact` boolean, which is a flat AND across all hard constraints. There is no weighting or differentiated treatment.

**The partial exception:** The `VerificationPolicy` system (`verification-policy.ts`) does assign different *strategies* based on constraint types — `DIRECTORY_VERIFIED` for simple queries vs. `WEBSITE_VERIFIED` for attribute queries vs. `RELATIONSHIP_VERIFIED` for relationship queries. But this only affects *which tools are used*, not *how evidence is judged*. A run with `verification_policy: 'WEBSITE_VERIFIED'` still passes through the same `deriveCanonicalStatus` that returns `COMPLETED` for any nonzero delivery.

---

## 6. Case Studies

### 6.1 B01: "Find pubs in Arundel with Swan in the name"

**Two pipelines produce different results:**

**Mission path (primary):** The mission extractor produces:
- `text_compare`, field=name, operator=contains, value="swan", hardness=**"hard"** (default for `text_compare` in mission extractor)
- Location constraint (implicit in search query)

Flow in mission path:
1. Google Places search for "pubs in Arundel" returns candidate leads.
2. `FILTER_FIELDS` step applies `applyFieldFilters()` which filters leads to only those whose name contains "swan" (case-insensitive).
3. Non-matching leads are **removed** before evidence gathering.
4. Tower receives `hard_constraints: ['name_contains']` via `buildHardConstraintLabels()`.
5. If 2 pubs match and user asked for 4, the run delivers 2 and Tower judges on count shortfall.

**Legacy path (fallback):** The regex/LLM parser produces:
- `c_name_contains` → `NAME_CONTAINS`, field=name, value="swan", hard=**false** (default soft for `NAME_CONTAINS`)

In legacy path, leads without "swan" pass CVL as `verified_exact` because the name constraint is soft.

**How B01 can succeed from user perspective but still fail internally:**
- In mission path: `FILTER_FIELDS` correctly removes non-matching leads. But if only 2 pubs in Arundel have "swan", and the user asked for 4, the system delivers 2 — user is satisfied (correct results), but run is judged as shortfall.
- `deriveCanonicalStatus` returns `COMPLETED` (any nonzero delivery), so the shortfall is hidden at the verdict level. But QA/benchmark might classify this as partial or failed because `delivered_count < requested_count`.
- In legacy path: the opposite problem — 4 pubs delivered but only 2 match. User sees wrong results but system marks `COMPLETED`.

### 6.2 B06: "Find pubs in Arundel that mention live music on their website"

**Mission path constraint parsing (primary):**

The mission extractor explicitly recognizes "on their website" and produces:
- `website_evidence`, field=website_text, operator=contains, value="live music", hardness=**"hard"**
- Location constraint (implicit)

This is correctly distinguished from `attribute_check` ("has live music") — the mission extractor's LLM prompt includes the example:
```
"website text contains live music" → { "type": "website_evidence", ... "hardness": "hard" }
```

**Legacy path:** Would classify this as `HAS_ATTRIBUTE` with value "live music", losing the "on their website" qualifier.

**Flow (mission path):**
1. `deriveVerificationPolicy` detects `website_evidence` → returns `WEBSITE_VERIFIED`.
2. Planner creates a `discovery_then_website_evidence` strategy.
3. Google Places search returns pubs in Arundel.
4. For each lead with a `website` field, `WEB_VISIT` is called with `page_hints: ['events', 'whats-on', 'live-music', 'entertainment', 'gigs']`.
5. `extractConstraintLedEvidence()` scans page text for "live music" and synonyms ("live band", "acoustic", "live entertainment", etc.).
6. If keyword evidence is found, it's sent to Tower `/api/tower/semantic-verify` which returns `verified | weak_match | no_evidence`.

**Where website evidence is required:**
- `requiresWebVisit(plan)` returns true because strategy is `discovery_then_website_evidence`.
- Evidence gathering happens at `mission-executor.ts` lines 704–1010.

**Where website evidence can be rejected or lost:**
- If a lead has **no `website` field** from Google Places, it is skipped entirely for web visit (line 716: `filter(l => needsWebSearch || (needsWebVisit && l.website))`). No evidence is ever gathered for that lead.
- If `WEB_VISIT` fails (HTTP error, Cloudflare block, timeout), pages array is empty. A fallback `WEB_SEARCH` is attempted.
- If both WEB_VISIT and WEB_SEARCH fail, the lead gets `evidenceStrength: 'none'`, `evidenceFound: false`.
- Hard evidence filtering (line 1292) then removes this lead from `filteredLeads`.

**Critical bug pattern — unchecked leads pass through:**
- Leads that were **never checked** (not in the enrichable batch, or skipped because no website) are NOT in the `leadsChecked` set. The hard evidence filter at line 1304 has: `if (!leadsChecked.has(i)) return true` — meaning unchecked leads **pass through unfiltered**.
- Additionally, if NO leads had evidence at all (total `evidenceResults.length === 0`), the entire hard evidence filter is a no-op (line 1295: `if (hardEvidenceConstraints.length > 0 && evidenceResults.length > 0)`). ALL leads pass through.
- If zero evidence results exist and a "fallback delivery" kicks in (line 1081–1116): leads without any evidence for hard constraints get synthetic `EvidenceResult` entries with `evidenceStrength: 'none'`, then those leads are still delivered but marked `verified: false`.

**Source provenance gap:**
- The system treats a web search snippet mentioning "live music" the same as a first-party website page. There is no `source_authority` or `source_tier` distinction. For B06, where the user explicitly said "on their website", a third-party snippet should NOT satisfy the constraint — but the current code does not enforce this.
- Tower's semantic verification receives `source_url` but does not receive information about whether that URL is the lead's own website vs. a third-party page. The constraint type `website_evidence` implies first-party source, but this implication is not enforced.

**How B06 can fail internally:**
- `deriveCanonicalStatus` returns `COMPLETED` if any leads are delivered, regardless of evidence quality.
- If 3 pubs are delivered but none have website evidence for "live music" (all have `evidenceStrength: 'none'`), the run is still `COMPLETED`.
- Tower might issue `pass` on the artefact because it sees `delivered_count: 3` meeting `target_count: 3`.
- The QA layer would mark `verification_status: 'fail'` (leadsWithVerification === 0), but `overall_outcome` could still be `PARTIAL_SUCCESS` since discovery and delivery passed.

---

## 7. Recommendation: Minimum Clean Backend Changes for Per-Constraint Judgement

The goal: Tower should be able to judge each constraint with a different evidence standard.

### Change 1: Add `evidence_requirement` to `StructuredConstraint`

```typescript
export type EvidenceRequirement =
  | 'lead_field'           // checkable from lead data alone (name, address)
  | 'directory_data'       // checkable from Google Places metadata
  | 'website_text'         // requires text from business's own website
  | 'external_source'      // requires evidence from third-party sources
  | 'none';                // no evidence needed (e.g., COUNT_MIN)
```

Add `evidence_requirement: EvidenceRequirement` to `StructuredConstraint`. Default it based on constraint type:
- `COUNT_MIN` → `none`
- `LOCATION_EQUALS/NEAR` → `directory_data`
- `NAME_STARTS_WITH/CONTAINS` → `lead_field`
- `HAS_ATTRIBUTE`, `STATUS_CHECK`, `TIME_CONSTRAINT`, `WEBSITE_EVIDENCE` → `website_text`
- `RELATIONSHIP_CHECK` → `external_source`

### Change 2: Pass typed constraint objects to Tower (not flat ID lists)

Replace `hard_constraints: string[]` and `soft_constraints: string[]` in `successCriteria` with:

```typescript
constraints: Array<{
  id: string;
  type: ConstraintType;
  value: string;
  hard: boolean;
  evidence_requirement: EvidenceRequirement;
}>
```

### Change 3: Tag each evidence item with source tier

Add to `EvidenceResult` and `SupportingEvidenceItem`:

```typescript
source_tier: 'first_party_website' | 'search_snippet' | 'directory_field' | 'lead_field';
```

Populate based on where the evidence actually came from:
- WEB_VISIT pages from lead's own domain → `first_party_website`
- WEB_SEARCH snippets → `search_snippet`
- Google Places fields (address, category) → `directory_field`
- Lead name/address string match → `lead_field`

### Change 4: Per-constraint verdict in delivery summary

Add to `DeliverySummaryPayload`:

```typescript
constraint_verdicts: Array<{
  constraint_id: string;
  constraint_type: ConstraintType;
  hard: boolean;
  evidence_requirement: EvidenceRequirement;
  leads_satisfied: number;
  leads_unsatisfied: number;
  leads_unknown: number;
  best_evidence_tier: string | null;
  satisfied: boolean;
}>
```

### Change 5: Fix `deriveCanonicalStatus`

Replace the degenerate logic with constraint-aware derivation:

- `PASS`: all hard constraints satisfied for `>= requestedCount` leads with appropriate evidence tier
- `PARTIAL`: some hard constraints satisfied or partial count met
- `STOP`: zero leads satisfy all hard constraints
- `COMPLETED`: deprecated or reserved for "delivered but not judged"

### Change 0 (Bug Fix — highest priority): Fix unchecked-lead pass-through

In `mission-executor.ts` line 1304, change:
```typescript
if (!leadsChecked.has(i)) return true;  // BUG: unchecked leads pass
```
to:
```typescript
if (!leadsChecked.has(i)) return false;  // unchecked leads should NOT pass hard evidence filter
```
This is a correctness fix independent of the broader architecture work.

### Summary of Files to Change

1. `server/supervisor/mission-executor.ts` — **bug fix** (Change 0), tag evidence with source tier, pass typed constraints to Tower
2. `server/supervisor/goal-to-constraints.ts` — add `evidence_requirement` to `StructuredConstraint` schema
3. `server/supervisor/mission-schema.ts` — add `evidence_requirement` to `MissionConstraint` schema (parallel to legacy)
4. `server/supervisor/cvl.ts` — pass evidence requirement through to checks
5. `server/supervisor/delivery-summary.ts` — add per-constraint verdicts, fix `deriveCanonicalStatus`
6. `server/supervisor/tower-artefact-judge.ts` — update `successCriteria` shape
7. `server/evaluator/qaLayerSummary.ts` — add per-constraint breakdown to QA output
8. `server/supervisor/verification-policy.ts` — unify mission/legacy constraint type mapping

These changes are additive (no breaking changes to existing Tower API contract if done as optional fields) and could be implemented incrementally. Changes must cover both the mission and legacy constraint pipelines.
