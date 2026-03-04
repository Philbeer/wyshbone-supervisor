# Wyshbone System Behaviour Audit

**Date**: 2026-03-04
**Scope**: Full behavioural audit of the Wyshbone agent pipeline — observation only, no modifications.

---

## Part 1 — Pipeline Overview

### Full Execution Pipeline

```
User input
→ Clarify Gate (server/supervisor/clarify-gate.ts)         [Line ~1060 in supervisor.ts]
    ├─ direct_response → respond and stop
    ├─ clarify_before_run → ask questions and wait
    └─ agent_run → continue ↓
→ Constraint Gate (server/supervisor/constraint-gate.ts)    [Pre-execution gate]
    ├─ can_execute: false → ask clarifying questions
    └─ can_execute: true → continue ↓
→ Goal Parser / Constraint Extraction (server/supervisor/goal-to-constraints.ts) [Line ~1657]
→ CVL Capability Check (server/supervisor/cvl.ts → buildCapabilityCheck)
→ Plan Generation (server/supervisor/tool-planning-policy.ts)
→ Plan Executor (server/supervisor/plan-executor.ts)
→ Action Executor (server/supervisor/action-executor.ts)
→ Tool Execution (server/actions/*)
→ Artefact Creation (server/supervisor/artefacts.ts)
→ Tower Judgement (server/supervisor/tower-artefact-judge.ts)
→ Reaction: Continue / Retry / Replan / Stop
→ CVL Lead Verification (server/supervisor/cvl.ts → verifyLeads)
→ Delivery Summary (server/supervisor/delivery-summary.ts)
→ Run Receipt (server/supervisor/run-receipt.ts)
→ UI Rendering (client/src/pages/Activity.tsx)
```

Note: The clarify gate runs first (line ~1060 in `server/supervisor.ts`). If the route is `agent_run`, the constraint gate runs next to check for subjective terms, time predicates, relationship predicates, and attribute verification needs. Goal parsing via LLM (`parseGoalToConstraints`) runs later (line ~1657) after the constraint gate has passed. The constraint gate and goal parser are **separate extraction systems** that operate on the raw user message independently.

### Stage-by-Stage Breakdown

| Stage | File(s) | Main Function(s) | Artefacts Produced |
|-------|---------|-------------------|--------------------|
| **User input** | `server/supervisor.ts` | `processChatTask()` | — |
| **Clarify Gate** | `server/supervisor/clarify-gate.ts` | `evaluateClarifyGate()` | — |
| **Constraint Gate** | `server/supervisor/constraint-gate.ts` | `extractAllConstraints()`, `buildGateState()` | `constraint_contract` artefact |
| **Goal Parsing** | `server/supervisor/goal-to-constraints.ts` | `parseGoalToConstraints()` | `constraints_extracted` artefact |
| **CVL Capability Check** | `server/supervisor/cvl.ts` | `buildCapabilityCheck()` | `capability_check` artefact |
| **Plan Generation** | `server/supervisor/tool-planning-policy.ts` | `buildToolPlan()` | `tool_plan_explainer` artefact |
| **Plan Execution** | `server/supervisor/plan-executor.ts` | `executePlan()` | Step-level artefacts |
| **Tool Execution** | `server/supervisor/action-executor.ts` | `executeAction()` | `search_places_result`, `web_visit`, `contact_extract`, `lead_pack` |
| **Tower Judgement** | `server/supervisor/tower-artefact-judge.ts` | `judgeArtefact()` | `tower_judgement` (persisted to DB) |
| **Replan** | `server/supervisor/replan-policy.ts` | `applyLeadgenReplanPolicy()` | `plan_update` artefact |
| **Delivery Summary** | `server/supervisor/delivery-summary.ts` | `emitDeliverySummary()` | `delivery_summary` artefact |
| **Run Receipt** | `server/supervisor/run-receipt.ts` | `emitRunReceipt()` | `run_receipt` artefact |
| **UI Rendering** | `client/src/pages/Activity.tsx` | `DeliverySummaryCard` component | — |

---

## Part 2 — Constraint System Audit

### Constraint Types Supported

Defined in `server/supervisor/goal-to-constraints.ts` (`CONSTRAINT_TYPES`):

| Type | Default Hardness | Example |
|------|-----------------|---------|
| `COUNT_MIN` | **Hard** (always) | "Find 10 pubs" → `value: 10, hard: true` |
| `LOCATION_EQUALS` | Soft | "in Arundel" → `value: "Arundel", hard: false` |
| `LOCATION_NEAR` | Soft | "near Brighton" |
| `CATEGORY_EQUALS` | **Disabled** — filtered out post-parse | Never emitted |
| `NAME_STARTS_WITH` | Soft | "starting with S" |
| `NAME_CONTAINS` | Soft | "with the word swan in the name" |
| `MUST_USE_TOOL` | Soft | "using google places" |
| `HAS_ATTRIBUTE` | **Hard** (unless hedged) | "with live music" → `hard: true` |

### Hard vs Soft Determination

**Hard by default**: `COUNT_MIN`, `HAS_ATTRIBUTE`

**Soft by default**: `LOCATION_EQUALS`, `LOCATION_NEAR`, `NAME_STARTS_WITH`, `NAME_CONTAINS`, `MUST_USE_TOOL`

**Promotion to hard**: When user uses keywords: "must", "only", "exactly", "strict", "strictly", "do not relax"

**Demotion to soft**: When user uses hedging language: "preferably", "if possible", "ideally", "optionally", "nice to have", "bonus if"

### Verifiability Determination

Verifiability is assessed in two separate systems that do **not** fully align:

1. **Constraint Gate** (`constraint-gate.ts`): Pre-execution. Classifies as `verifiable`, `proxy`, or `unverifiable`. Only checks specific predicate patterns (time predicates, subjective terms, relationship predicates, and certain attribute patterns like `live_music`).

2. **CVL** (`cvl.ts`): Post-execution. `buildCapabilityCheck()` marks all defined constraint types as verifiable except `default` (unknown types). Notably, `HAS_ATTRIBUTE` is marked `verifiable` with `verification_method: 'website_visit'` — but this verification **only works if attribute evidence was actually collected** during the run.

### Example Input Analysis

#### 1. "Find pubs in Arundel"

| Field | Value |
|-------|-------|
| **Extracted constraints** | `c_location` (LOCATION_EQUALS, "Arundel", soft) |
| **Hard / Soft** | Location: soft. No count constraint (user didn't specify a number). |
| **Verifiability** | Location: verifiable (address_contains + geo_bbox) |
| **Capability check** | All verifiable |
| **Clarify gate** | `agent_run` — clear intent, has entity type and location |
| **STOP triggers** | No |
| **Resulting plan** | SEARCH_PLACES → WEB_VISIT → CONTACT_EXTRACT → LEAD_ENRICH (per lead) |

#### 2. "Find 10 pubs in Arundel with email"

| Field | Value |
|-------|-------|
| **Extracted constraints** | `c_count` (COUNT_MIN, 10, hard), `c_location` (LOCATION_EQUALS, "Arundel", soft) |
| **Delivery flags** | `include_email: true` |
| **Hard / Soft** | Count: hard. Location: soft. |
| **Verifiability** | Count: verifiable (count_check). Location: verifiable. |
| **Capability check** | All verifiable |
| **Clarify gate** | `agent_run` |
| **STOP triggers** | No |
| **Resulting plan** | SEARCH_PLACES → WEB_VISIT → CONTACT_EXTRACT → LEAD_ENRICH |

#### 3. "Find pubs in Arundel that have live music"

| Field | Value |
|-------|-------|
| **Extracted constraints** | `c_location` (LOCATION_EQUALS, "Arundel", soft), `c_attr_live_music` (HAS_ATTRIBUTE, "live music", **hard**) |
| **Constraint Gate** | Detects `live_music` attribute → classified as `proxy` verifiability → `requires_clarification: true` |
| **CVL capability check** | HAS_ATTRIBUTE marked as verifiable via `website_visit` |
| **Clarify gate** | `agent_run` — intent is clear |
| **Constraint Gate behaviour** | Triggers clarification: "Live music isn't reliably verified from Places data. Do you want me to verify via website/listings (slower) or treat as best-effort unverified?" |
| **STOP triggers** | `can_execute: false` until user responds to clarification |
| **Critical observation** | The constraint gate blocks execution and asks for proxy choice. However, if the user says "verify via website", execution proceeds with `chosen_verification: 'website_verify'`. The actual website visit may or may not find live music evidence. If no evidence is found, CVL marks it as `status: 'unknown'` with reason "Attribute was not checked via website visit". **The HAS_ATTRIBUTE constraint is hard, but may pass CVL as unknown rather than failing.** |

#### 4. "Find pubs in Arundel that say they have live music on their website"

| Field | Value |
|-------|-------|
| **Extracted constraints** | Same as #3: `c_location` (soft), `c_attr_live_music` (HAS_ATTRIBUTE, hard) |
| **Constraint Gate** | Same as #3 — `live_music` triggers clarification |
| **Key observation** | The user explicitly stated "on their website" which implies `website_verify` intent, but the system **still asks the clarification question** because the constraint gate uses pattern matching, not semantic understanding of the user's full sentence. This is a **false positive clarification**. |
| **Resulting plan** | Same as #3 after clarification |

#### 5. "Find 10 pubs in Arundel but only if they have dog friendly beer gardens"

| Field | Value |
|-------|-------|
| **Extracted constraints** | `c_count` (COUNT_MIN, 10, hard), `c_location` (LOCATION_EQUALS, "Arundel", soft), `c_attr_dog_friendly` (HAS_ATTRIBUTE, hard), `c_attr_beer_garden` (HAS_ATTRIBUTE, hard) |
| **Note** | The regex fallback in `goal-to-constraints.ts` only matches one attribute at a time (`attrMatch` takes the first match). LLM parsing should extract both. The phrase "only if" reinforces hardness. |
| **Constraint Gate** | `dog_friendly` and `beer_garden` are not in `BLOCKING_ATTRIBUTES` (only `live_music` is), so they're classified as `verifiable`, not `proxy`. No clarification triggered. |
| **CVL capability check** | Both marked verifiable via `website_visit`. But **actual verification depends on attribute evidence being collected during WEB_VISIT**, which is not guaranteed. |
| **Clarify gate** | `agent_run` |
| **STOP triggers** | No |
| **Critical observation** | These hard constraints pass the gate and proceed. But the tool pipeline (SEARCH_PLACES → WEB_VISIT → CONTACT_EXTRACT → LEAD_ENRICH) does **not have a dedicated attribute verification step**. The `WEB_VISIT` tool crawls pages and extracts text, but there is no explicit step where the system checks crawled text for "dog friendly" or "beer garden" keywords and populates `attributeEvidence`. **The constraints are extracted but never verified during execution.** CVL would report `status: 'unknown'` for these attributes. |

#### 6. "Find pubs in Arundel and also dentists in Texas"

| Field | Value |
|-------|-------|
| **Clarify gate** | Detects mixed intent via `hasMixedIntent()` — the phrase "and also find" triggers the split. Returns `clarify_before_run` with question: "Your message seems to contain more than one request. Could you tell me which one to tackle first?" |
| **Constraint extraction** | Not reached (blocked by clarify gate) |
| **STOP triggers** | No (clarification requested instead) |

#### 7. "Find the best pubs in Arundel"

| Field | Value |
|-------|-------|
| **Clarify gate** | `agent_run` — has search verb, entity type, and location |
| **Constraint Gate** | Detects subjective term "best" via `SUBJECTIVE_TERMS_PATTERN`. Creates a `subjective_predicate` constraint with `verifiability: 'unverifiable'`, `hardness: 'soft'`, `can_execute: false`. Triggers clarification with options: Lively, Quiet, Cosy, Late-night, Live music, Good for food, Beer garden, Dog friendly. |
| **Note** | "best" is treated as always unverifiable. The system asks the user to rephrase with measurable criteria. |
| **STOP triggers** | `can_execute: false` until user provides measurable criteria |

---

## Part 3 — CVL Analysis

### What CVL Currently Checks

The CVL (`server/supervisor/cvl.ts`) verifies leads against extracted constraints **after** search results are returned. It operates on a per-lead, per-constraint basis.

| Constraint Type | What CVL Checks | Method | Confidence |
|----------------|-----------------|--------|------------|
| `COUNT_MIN` | Auto-passes per lead; checked at summary level | `count_check` | High |
| `CATEGORY_EQUALS` | Checks if business type is in `PLACES_SUPPORTED_CATEGORIES` set | `search_query_proxy` | High if supported, Low otherwise |
| `LOCATION_EQUALS` | Geo-verification via `verifyLocationGeo()` using bounding boxes from `geo-regions.ts` | `address_contains` + `geo_bbox` | High if geo match, Medium if search-bounded |
| `LOCATION_NEAR` | **Always returns `unknown`** with reason "Proximity check requires geocoding" | None functional | Low |
| `NAME_STARTS_WITH` | String prefix match on `lead.name` | `name_prefix_check` | High |
| `NAME_CONTAINS` | Substring match on `lead.name` | `name_contains_check` | High |
| `MUST_USE_TOOL` | Checks `lead.source` matches requested tool | `tool_source_check` | High |
| `HAS_ATTRIBUTE` | Looks up `attributeEvidence` map for the lead's `placeId` and attribute value | `website_visit` | Depends on evidence availability |

### Constraint Types Currently Implemented in CVL

All 8 types from `CONSTRAINT_TYPES` have switch cases in `verifyOneConstraint()`. `CATEGORY_EQUALS` is handled but is disabled at the extraction layer (filtered out in `parseGoalToConstraints`).

### What CVL Ignores

1. **`LOCATION_NEAR`**: Always returns `unknown`. The system has lat/lng data from Google Places but does not perform distance calculations.

2. **`HAS_ATTRIBUTE` without evidence**: If no `attributeEvidence` entry exists for a lead+attribute combination, CVL returns `status: 'unknown'`. This is the **default case** because the execution pipeline does not systematically populate attribute evidence.

3. **Delivery requirements** (`include_email`, `include_phone`, `include_website`): These are **not modelled as constraints** in the CVL. They are flags on `ParsedGoal` but are never verified by CVL. A run could complete with `include_email: true` but deliver zero emails, and CVL would not flag this.

### Constraints That Bypass CVL Entirely

- **Delivery requirements** (email, phone, website) — tracked as flags, not as CVL constraints
- **Subjective predicates** ("best", "nicest") — caught by constraint gate pre-execution, never reach CVL
- **Time predicates** ("opened in the last 6 months") — caught by constraint gate, never reach CVL
- **Relationship predicates** ("works with", "supplies") — caught by constraint gate, never reach CVL
- **Numeric ambiguity** ("a few", "top") — caught by constraint gate, never reach CVL
- **Attribute constraints in practice** — technically in CVL but dependent on evidence that is rarely populated

---

## Part 4 — Clarify Gate Behaviour

### When `clarify_before_run` Is Triggered

The clarify gate (`server/supervisor/clarify-gate.ts` → `evaluateClarifyGate()`) triggers clarification for:

1. **Empty input** — message is blank or < 3 characters
2. **Nonsense input** — low ratio of recognisable words (< 25% for 3+ word messages)
3. **Malformed input** — no-space sentence joins (e.g., "find pubsShow me cafes"), multiple lead-finding verbs without conjunction
4. **Mixed intent** — conjunctions like "and also find", "plus find"
5. **Direct response** — questions, meta-trust queries, acknowledgements → routed to `direct_response` (not `clarify_before_run`)

### What the Clarify Gate Does NOT Check

The clarify gate does **not** check for:
- Missing location (the `isMissingLocation()` function exists but is **not called** in `evaluateClarifyGate()`)
- Vague entity types (the `hasVagueEntityType()` function exists but is **not called** in `evaluateClarifyGate()`)
- Relationship predicates (the `hasRelationshipPredicate()` function exists but is **not called** in `evaluateClarifyGate()`)
- False prior context (the `hasFalsePriorContext()` function exists but is **not called** in `evaluateClarifyGate()`)
- Nonsense locations (the `hasNonsenseLocation()` function exists but is **not called** in `evaluateClarifyGate()`)

**These functions are defined in the file but never invoked from the main gate evaluation function.** This means:
- "Find pubs" (no location) → passes as `agent_run` ← should likely clarify
- "Find organisations in London" (vague entity) → passes as `agent_run` ← should likely clarify
- "Find businesses that work with Tesco" (relationship) → passes as `agent_run` ← caught later by constraint gate, not clarify gate

### False Positives

1. **Short acknowledged inputs**: Messages < 3 characters return `clarify_before_run` (triggerCategory: `empty`). A user typing "ok" gets routed to `direct_response` since it matches that check first, but single-character replies could falsely trigger.

2. **Compound verb phrases**: "Find and list pubs in London" contains two lead-finding verbs but the compound verb exclusion (`find and list`) handles this. However, "Search pubs in London. List cafes in Brighton" (period-separated) would be flagged as malformed due to multiple verb matches without the exclusion pattern.

3. **The clarify gate is relatively conservative** — it allows most inputs through to `agent_run`. The real gating happens in the constraint gate, which is a separate downstream system.

### Clarify Session Follow-Up

When clarification is triggered, the system creates a `ClarifySession` (`server/supervisor/clarify-session.ts`) with:
- Max 3 turns (`MAX_CLARIFY_TURNS`)
- Tracks `missingFields` and `collectedFields`
- Classifies follow-ups as: `ANSWER_TO_MISSING_FIELD`, `REFINEMENT`, `EXECUTE_NOW`, `NEW_REQUEST`
- On completion, generates a synthetic search message from collected fields

---

## Part 5 — Planner Behaviour

### Mission Types Supported

The system currently supports one mission type: **`lead_finder`** (B2B lead generation via Google Places).

### Templates Used

The planner (`server/supervisor/tool-planning-policy.ts` → `buildToolPlan()`) uses **two path templates**:

1. **Primary path** (website exists):
   ```
   SEARCH_PLACES → WEB_VISIT → CONTACT_EXTRACT → LEAD_ENRICH
   ```

2. **Fallback path** (no website or website unreachable):
   ```
   SEARCH_PLACES → WEB_SEARCH → WEB_VISIT → CONTACT_EXTRACT → LEAD_ENRICH
   ```

3. **Optional addition**: If `user_question` is present, `ASK_LEAD_QUESTION` is appended (budgeted).

### How Constraints Affect Plan Generation

**Constraints do NOT affect plan generation.** The `buildToolPlan()` function takes a `LeadContext` that contains:
- `business_name`
- `website` (nullable)
- `phone` (nullable)
- `address` (nullable)
- `user_question` (nullable)

It does **not** receive:
- Extracted constraints
- Hard/soft classification
- Attribute requirements
- Count targets

The plan is identical regardless of whether the user asked for "pubs in Arundel" or "pubs in Arundel with dog-friendly beer gardens". The only variable is whether a website exists.

### Why Some Constraints Are Ignored by the Planner

**The planner is constraint-blind.** It generates a fixed tool sequence based solely on website availability. Constraints like "live music", "beer garden", or "dog friendly" do not cause the planner to:
- Add an attribute verification step
- Modify the WEB_VISIT page hints to prioritise relevant pages
- Include targeted searches for the attribute

This is the **core constraint gap**: the system extracts and classifies constraints but the planner does not adapt its tool plan to verify them.

### Where Constraints Fail to Influence Planning

| Constraint | Expected Planning Impact | Actual Planning Impact |
|-----------|------------------------|----------------------|
| `HAS_ATTRIBUTE("live music")` | Should add attribute verification via website crawl | None — same plan as without attribute |
| `HAS_ATTRIBUTE("beer garden")` | Should scan website pages for evidence | None |
| `COUNT_MIN(10)` | Should set `maxResults` on SEARCH_PLACES accordingly | Count is passed via `search_budget_count` to SEARCH_PLACES, but the plan structure doesn't change |
| `include_email: true` | Could prioritise CONTACT_EXTRACT | Always included anyway |

---

## Part 6 — Tool Capability Coverage

### All Available Tools

| Tool ID | Category | Can Verify | Constraint Types Supported |
|---------|----------|-----------|---------------------------|
| `SEARCH_PLACES` | Search | Location (via geo-bounded search), Business type (via query proxy) | LOCATION_EQUALS (implicit), CATEGORY_EQUALS (implicit) |
| `SEARCH_WYSHBONE_DB` | Search | Same as SEARCH_PLACES (hospitality only) | LOCATION_EQUALS (implicit) |
| `WEB_VISIT` | Utility | Can extract text that **could** be used for attribute verification | None directly — text extraction only |
| `WEB_SEARCH` | Utility | URL discovery for disambiguation | None |
| `CONTACT_EXTRACT` | Enrich | Email and phone extraction | Delivery requirements (email/phone), but not modelled as constraints |
| `LEAD_ENRICH` | Enrich | Assembles lead pack from all sources | None |
| `ASK_LEAD_QUESTION` | Enrich | Evidence-backed answer to user question | Potentially HAS_ATTRIBUTE (but not integrated into CVL) |
| `ENRICH_LEADS` | Enrich | Basic Places enrichment | None |
| `SCORE_LEADS` | Score | Relevance ranking | None |
| `EVALUATE_RESULTS` | Evaluate | Run quality assessment | None |

### Constraints That Cannot Be Verified With Current Tools

| Constraint | Why Unverifiable |
|-----------|-----------------|
| `HAS_ATTRIBUTE` (any attribute) | No tool step systematically checks website text for attribute keywords and feeds results back to CVL as `attributeEvidence`. `WEB_VISIT` extracts text but nobody parses it for attributes. |
| `LOCATION_NEAR` | No geocoding/distance calculation tool. CVL always returns `unknown`. |
| Delivery requirements (email/phone/website) | Not modelled as constraints. No verification that the requirement was met. |
| Subjective terms ("best", "nicest") | By design — caught pre-execution. |
| Time predicates ("opened recently") | By design — caught pre-execution or handled via proxy. |
| Relationship predicates ("works with X") | By design — caught pre-execution. |

---

## Part 7 — Tower Judgement Behaviour

### What Tower Evaluates Today

Tower is an **external service** called via HTTP POST to `/api/tower/judge-artefact`. The system sends:
- `runId`
- `artefactId`
- `goal`
- `successCriteria` (includes target_count, constraints, hard/soft labels, plan_constraints)
- `artefactType`

Tower returns:
- `verdict`: string (e.g., "pass", "fail", "change_plan")
- `reasons`: string array
- `metrics`: object
- `action`: one of `continue`, `stop`, `retry`, `change_plan`
- `gaps`: optional gap descriptions
- `suggested_changes`: optional change directives

### Judgement Criteria

Tower's internal logic is external to this codebase. The Supervisor passes success criteria including:
- Target count
- Constraint list with hard/soft labels
- Plan version and constraints
- Accumulated candidate count

Based on Tower's response, the system reacts:

| Tower Action | Supervisor Reaction |
|-------------|-------------------|
| `continue` | Proceed to next step |
| `retry` | Re-run same tool (max 2 retries in plan-executor, max 1 in agent-loop) |
| `change_plan` | Apply replan policy, increment plan version, re-execute |
| `stop` | Halt execution, emit delivery summary |

### When Tower Requests Retry

Tower returns `action: 'retry'` when a step's output is insufficient but might succeed on re-execution (e.g., transient API failure, partial results).

- `plan-executor.ts`: `MAX_RETRIES_PER_STEP = 2`
- `agent-loop.ts`: `MAX_RETRIES = 1`

If retries are exhausted, the system treats it as a stop.

### When Tower Requests Replan

Tower returns `action: 'change_plan'` with `suggested_changes` (expand location, drop prefix, broaden query). The replan policy (`replan-policy.ts`) applies changes respecting hard constraint boundaries:

- Location expansion via `RADIUS_LADDER_KM = [0, 5, 10, 25, 50, 100]`
- Prefix filter dropping (if soft)
- Query broadening via `QUERY_SYNONYM_MAP`
- Search count increase (up to 60)

Hard cap: `HARD_CAP_MAX_REPLANS = 10` in plan-executor, `MAX_PLAN_VERSION = 2` in agent-loop.

### When Tower Stops

- Budget exceeded (cost or steps)
- Explicit `STOP` verdict
- Tower unreachable (governance gate — refuses to proceed without Tower)
- No progress possible (max radius reached, all changes blocked by hard constraints)
- `no_progress: true` and `cannot_expand_further: true` from replan policy

### Does Tower Evaluate Constraint Compliance?

**Partially.** Tower receives the constraint list and target count as `successCriteria`. It can evaluate count compliance (delivered vs requested). However:

- Tower does **not** receive CVL verification results
- Tower does **not** know whether `HAS_ATTRIBUTE` constraints were satisfied
- Tower does **not** verify attribute evidence
- Tower's evaluation is based on the artefact payload (search results, lead counts) not on per-constraint verification

**Tower evaluates quantity, not quality against user constraints.**

### Stub Mode

When `TOWER_ARTEFACT_JUDGE_STUB=true`, all judgements auto-pass with `action: 'continue'`. This means:
- No quality gating
- No replan triggers
- No stop protection
- Every step proceeds regardless of results

---

## Part 8 — Run Receipt Audit

### How the Run Receipt Is Produced

`emitRunReceipt()` in `server/supervisor/run-receipt.ts`:

1. Fetches all artefacts for the `runId` from storage
2. Filters for `lead_pack` and `contact_extract` artefact types
3. Matches artefacts to delivered leads using `matchesDeliveredLead()`:
   - Match by `place_id`
   - Match by normalised name
   - Match by artefact title substring
4. Counts unique emails and phones from matched artefacts
5. Sets `contacts_proven` flag
6. Generates narrative lines

### Field Analysis

| Field | Source | Accuracy Assessment |
|-------|--------|-------------------|
| `delivered_count` | `input.deliveredLeads.length` — count of leads passed by caller | **Accurate** — reflects what was actually delivered |
| `candidate_count_from_google` | `input.candidateCountFromGoogle` — raw count from SEARCH_PLACES | **Accurate** — direct from API response count |
| `contacts_proven` | `hasMatchedArtefacts && hasAnyContact` — true only if contact artefacts matched to delivered leads AND contained emails/phones | **Conservative but accurate** — prevents false claims |
| `unique_email_count` | De-duplicated emails from matched `contact_extract` and `lead_pack` artefacts | **Potentially understated** — matching logic may miss some artefacts if `place_id` or name normalisation fails |
| `unique_phone_count` | Same logic as emails | **Same risk as emails** |

### Potential Mismatches

1. **Artefact matching failures**: The `matchesDeliveredLead()` function matches by place_id, normalised name, or title substring. If an artefact title uses a different name format than the delivered lead (e.g., "The Swan Inn" vs "Swan Inn"), the match could fail, causing `contacts_proven: false` even when contacts were found.

2. **Email/phone extraction paths**: The receipt looks for contacts in two different payload structures:
   - `contact_extract`: `p.outputs.contacts.emails` (string array)
   - `lead_pack`: `p.outputs.lead_pack.contacts.emails[*].value` (object array)
   
   If a new artefact format is introduced that doesn't match either pattern, contacts would be silently missed.

3. **Narrative vs reality**: The narrative says "I checked the websites of X of the Y delivered" but `websitesChecked` is derived from `input.deliveredLeads.filter(l => l.website).length` — this counts leads that **have** a website URL, not leads whose website was actually crawled. A lead could have a website URL from Places but the WEB_VISIT step may have failed or been skipped.

4. **No constraint compliance in receipt**: The run receipt does not mention whether user constraints were satisfied. It reports counts and contacts but not "8 of 10 had beer gardens" or "live music could not be verified".

---

## Part 9 — UI Truth Alignment

### What the UI Currently Shows

The `DeliverySummaryCard` component (`Activity.tsx`) displays:

1. **Verdict badge**: "COMPLETED" or "STOP"
2. **Exact match count** / **Closest match count** / **Requested count**
3. **Fill rate percentage**: `delivered_exact_count / requested_count * 100`
4. **Shortfall count**: How many exact matches are still needed
5. **Stop reason**: If applicable
6. **Hard constraints**: Displayed as secondary badges
7. **Soft constraints**: Displayed as outline badges
8. **Soft relaxations**: Shows `from → to` with plan version
9. **Exact matches list**: Green checkmarks
10. **Closest matches list**: Warning triangles with `soft_violations` badges
11. **Suggested next question**: If applicable

### Truth Alignment Issues

#### Issue 1: "Exact" Does Not Mean Constraint-Satisfied

The `match_level: 'exact'` classification comes from `determineLeadExactness()` in `delivery-summary.ts`. A lead is classified as "exact" if:
- CVL says `verified_exact: true` (all hard constraints pass with `status: 'yes'` and all checks pass)
- OR heuristic check passes (name/address string matching against hard constraints)

**Problem**: For `HAS_ATTRIBUTE` constraints (e.g., "dog friendly"), CVL returns `status: 'unknown'` (no evidence collected). A lead with `all_hard_satisfied: false` due to `unknown` status would be classified as "closest". However, `verified_exact` requires all checks to be `'yes'` or `'search_bounded'` (for non-hard). So a lead with an `unknown` hard attribute would be "closest" — which is technically correct but the UI doesn't explain **why** it's closest.

The `soft_violations` array on closest matches shows constraint names, but for `HAS_ATTRIBUTE` violations it would show something like `"c_attr_live_music"` or the hard constraint label — which may not be meaningful to the user.

#### Issue 2: "COMPLETED" Implies Success

The verdict logic in `deriveCanonicalStatus()` returns `'COMPLETED'` if `totalDelivered > 0`, regardless of constraint satisfaction. It only returns `'ERROR'` if Tower verdict is error AND zero delivered, and `'STOP'` if zero delivered or hard constraints are unverifiable. This means a user asking for "10 pubs with live music" who receives 10 pubs (none verified for live music) would see:
- Badge: **COMPLETED** (green) — because `totalDelivered = 10 > 0`
- Exact: 0 / Closest: 10
- Fill rate: 0%

The UI's `DeliverySummaryCard` derives its verdict from `!payload.stop_reason` — if there's no stop reason, it shows "COMPLETED". Combined with `deriveCanonicalStatus`, the "COMPLETED" badge may mislead the user into thinking the task succeeded. The shortfall and fill rate partially correct this, but the green badge is the most prominent visual signal.

#### Issue 3: Constraints Displayed As Labels, Not Verification Results

Hard constraints are shown as badges (e.g., `"query=pubs"`, `"attribute=live music"`) but there is no per-constraint verification status. The user sees that "live music" was a constraint but cannot tell whether any lead actually has live music.

#### Issue 4: Run Receipt Narrative

The run receipt narrative ("I searched Google Places for pubs in Arundel and found 20 candidates. You asked for 10 and I delivered 10.") makes no mention of attribute constraints. A user who asked for "pubs with beer gardens" would see a narrative that says "I delivered 10 pubs" without mentioning whether any have beer gardens.

#### Issue 5: No Attribute Evidence Display

The UI has no component for showing per-lead attribute evidence. Even if the CVL had verified attributes, the UI would only show the lead name, address, and violation labels — not the evidence (e.g., "Website mentions 'beer garden' on the homepage").

---

## Part 10 — Failure Classes

### Class 1: Constraint Ignored

**Description**: User specifies a constraint that is correctly extracted but has no effect on execution or verification.

**Examples**:
- "Find pubs with beer garden" → `HAS_ATTRIBUTE("beer garden")` extracted as hard, but planner produces the same plan as "Find pubs". No step checks for beer gardens. CVL returns `unknown`.
- "Find pubs with outdoor seating" → Same pattern.

**Root cause**: Planner is constraint-blind. No attribute verification step exists in the tool pipeline.

### Class 2: Constraint Misclassified

**Description**: A constraint is classified with incorrect hardness or verifiability.

**Examples**:
- Regex fallback only matches first attribute from a hardcoded list. "pubs with a pool table and garden" → regex matches "garden" but misses "pool table" (not in the hardcoded pattern). LLM parsing handles this better.
- `LOCATION_NEAR` marked as verifiable in CVL (`address_contains`) but actually always returns `unknown`.

### Class 3: Unverifiable Constraint Not Caught

**Description**: A constraint that cannot be verified passes through the constraint gate without blocking or clarifying.

**Examples**:
- "Find pubs with a skittle alley" → not in `ATTRIBUTE_PATTERNS` or `BLOCKING_ATTRIBUTES`. LLM may extract as `HAS_ATTRIBUTE` but the constraint gate won't flag it. CVL marks it verifiable via `website_visit` but no evidence is ever collected.
- "Find pubs with live entertainment" → if LLM maps to `live_music`, constraint gate catches it. If LLM maps to a generic `HAS_ATTRIBUTE`, it bypasses the gate.

### Class 4: Clarify False Positive

**Description**: Normal user input incorrectly triggers clarification.

**Examples**:
- "Find pubs in Arundel that say they have live music on their website" → constraint gate triggers `live_music` clarification even though user explicitly stated verification method
- "Find and list pubs in Brighton" → `isMalformedInput()` detects two lead-finding verbs. The compound verb exclusion handles "find and list" specifically, but similar patterns like "search and show" are not excluded.

### Class 5: Planner Ignoring Constraint

**Description**: The planner generates a plan that cannot satisfy user constraints because it doesn't receive them.

**Examples**:
- Any `HAS_ATTRIBUTE` constraint → planner produces the same plan
- The planner's `buildToolPlan()` takes `LeadContext` which has no constraint fields

### Class 6: Tool Capability Gap

**Description**: No tool exists that can verify a constraint.

**Examples**:
- `LOCATION_NEAR` → no geocoding/distance calculation
- `HAS_ATTRIBUTE` → `WEB_VISIT` extracts text but no tool step parses that text for attribute keywords and populates `attributeEvidence`
- Delivery requirements → `CONTACT_EXTRACT` finds contacts but there's no constraint-level check that the delivery requirement was met

### Class 7: UI Truth Mismatch

**Description**: UI presentation implies constraint satisfaction that didn't occur.

**Examples**:
- "COMPLETED" badge shown when constraints are unsatisfied
- Narrative mentions delivery count without mentioning constraint compliance
- Exact/closest classification doesn't explain which constraints failed
- No per-lead attribute verification display

### Class 8: Dead Code in Clarify Gate

**Description**: Functions exist to check for missing location, vague entity types, false prior context, and nonsense locations, but these functions are never called from `evaluateClarifyGate()`.

**Impact**: Inputs that should trigger clarification pass straight through to the agent. The constraint gate or the LLM parser may or may not handle these gracefully.

---

## Part 11 — Priority Fixes

### Supervisor Fixes

| Priority | Fix | Impact |
|----------|-----|--------|
| **P0** | **Wire clarify gate dead code**: Call `isMissingLocation()`, `hasVagueEntityType()`, `hasNonsenseLocation()`, `hasFalsePriorContext()` from `evaluateClarifyGate()` | Prevents execution of ambiguous queries that currently bypass all checks |
| **P0** | **Build attribute verification step**: Create a tool/step that takes `WEB_VISIT` output text and checks for `HAS_ATTRIBUTE` keywords, populating `attributeEvidence` for CVL | Enables the constraint system to actually verify attribute constraints |
| **P1** | **Make planner constraint-aware**: Pass extracted constraints to `buildToolPlan()` so the plan adapts (e.g., adding attribute verification steps, adjusting WEB_VISIT page hints) | Closes the gap between extraction and execution |
| **P1** | **Implement LOCATION_NEAR verification**: Add distance calculation using lat/lng from Google Places | Currently always returns `unknown` |
| **P2** | **Model delivery requirements as constraints**: Convert `include_email`, `include_phone`, `include_website` flags into formal CVL constraints that are verified | Prevents "delivered 10 pubs with email" narrative when zero emails were found |
| **P2** | **Fix live music false positive**: If user says "verify via website" or "on their website", auto-select `website_verify` without asking the clarification question | Reduces unnecessary clarification turns |

### Tower Fixes

| Priority | Fix | Impact |
|----------|-----|--------|
| **P0** | **Send CVL verification results to Tower**: Include per-constraint verification status in `successCriteria` so Tower can make constraint-aware judgements | Currently Tower only evaluates quantity |
| **P1** | **Tower should evaluate attribute compliance**: If `HAS_ATTRIBUTE` constraints are hard and `unknown`, Tower should not auto-accept | Prevents constraint-blind acceptance |
| **P2** | **Stub mode warnings**: When `TOWER_ARTEFACT_JUDGE_STUB=true`, emit a visible warning in the UI that quality gating is disabled | Prevents silent bypass in production |

### UI Fixes

| Priority | Fix | Impact |
|----------|-----|--------|
| **P0** | **Replace "COMPLETED" with constraint-aware verdict**: If hard constraints are unsatisfied, show "PARTIAL" or "UNVERIFIED" instead of "COMPLETED" | Prevents false confidence |
| **P1** | **Show per-constraint verification status**: For each hard/soft constraint, show whether it was verified (yes/no/unknown) with evidence | Users can see exactly what was and wasn't checked |
| **P1** | **Add attribute evidence display**: Show per-lead evidence for attribute constraints (e.g., "Website mentions 'beer garden'") | Transparency |
| **P2** | **Improve narrative honesty**: Run receipt narrative should mention unverified constraints (e.g., "I could not verify which pubs have live music from their websites") | Prevents false implication |
| **P2** | **Make soft_violations human-readable**: Transform constraint IDs like `c_attr_live_music` into readable labels like "Live music not verified" | Usability |

---

*End of audit report.*
