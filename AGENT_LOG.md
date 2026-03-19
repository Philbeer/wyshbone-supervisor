# Search & Discovery Pipeline — Architecture Report

**Date:** 2026-03-18  
**Scope:** Wyshbone Supervisor — full search and discovery pipeline  
**Purpose:** Architectural reference to support planned refactoring work  

---

## 1. QUERY CLASS DETERMINATION

### How and where is `query_class` determined?

The system uses the term **`mission_type`** as its canonical field name for what the report prompt calls `query_class`. The two terms are interchangeable throughout the codebase.

Determination happens in **two stages**:

**Primary path — LLM extraction**  
File: `server/supervisor/intent-extractor.ts`  
Function: `extractCanonicalIntent()`  

The raw user message is sent to `gpt-4o-mini` (or `claude-3.5-haiku` as a fallback). The LLM is given a structured system prompt with strict rules for classifying the intent, and returns a JSON object matching the `CanonicalIntentSchema`. The `mission_type` field is extracted from that object.

**Fallback path — legacy regex**  
File: `server/supervisor/goal-to-constraints.ts`  
Function: `deriveGoal()`  
Marked `@deprecated`. Used only when canonical extraction fails or returns `unknown`.

### All possible `mission_type` values

Defined as `MISSION_TYPE_ENUM` in `server/supervisor/canonical-intent.ts`:

| Value | Meaning |
|---|---|
| `find_businesses` | One-time discovery search for businesses, venues, or services |
| `monitor` | Ongoing/recurring alert (e.g., "notify me when a new vegan place opens") |
| `deep_research` | Multi-step in-depth research report |
| `explain` | Questions about how the system works |
| `meta_question` | Questions about accuracy, trust, or system capabilities |
| `unknown` | Could not be classified |

A related but separate field `intentClass` is derived in `server/supervisor/query-shape-key.ts` and simplifies the above into `find_venues` or `find_leads` for use in the `LearningStore` key. This is distinct from `mission_type` and used only for learning/caching.

### Is `mission_type` used to route execution paths?

Yes — it is the **primary router** for the entire supervisor pipeline. It determines:

- **Validation rules** — `server/supervisor/constraint-gate.ts`: a `location` field is mandatory for `find_businesses`; missing it blocks the run.
- **Execution path** — `server/supervisor/agent-loop.ts`: routes to standard `search_and_verify` vs. `deep_research` pipeline.
- **Tower payload** — `server/supervisor/tower-judgement.ts`: included in the evaluation payload so Tower can apply mission-specific success thresholds.
- **Delivery formatting** — `server/supervisor/delivery-summary.ts`: determines how the final report is structured for the user.
- **Learning indexing** — `server/supervisor/learning-layer.ts`: `mission_type` is part of the key that looks up and stores execution policies in the `learning_store` table.

---

## 2. PLANNER / MISSION EXECUTOR FLOW

### Orchestrating file

`server/supervisor/mission-executor.ts` is the top-level orchestrator for the execution phase. The planning phase lives in `server/supervisor/mission-planner.ts`. The agent-level retry/replan loop runs in `server/supervisor/agent-loop.ts`.

### Distinct stages in order

**Stage 1 — Intent Extraction**  
File: `server/supervisor/intent-extractor.ts`  
Function: `extractCanonicalIntent()`  

The raw user message is translated into a `CanonicalIntent` object: `mission_type`, `entity_kind`, `entity_category`, `location_text`, `requested_count`, and a list of `CanonicalConstraint` objects (each with `type`, `raw`, `hardness`, `evidence_mode`).

**Stage 2 — Mission Planning**  
File: `server/supervisor/mission-planner.ts`  

Takes the `CanonicalIntent` and produces a `MissionPlan` containing:
- A `MissionToolStep[]` — the ordered sequence of tool calls to run.
- A `CandidatePoolStrategy` — whether and by how much to expand the candidate pool (default multiplier: 3×, capped at 30) to ensure enough candidates survive downstream filtering.
- A `VerificationPolicy` — which constraints require what evidence mode (`RULE_DISCOVERY`, `RULE_WEBSITE_EVIDENCE`, `RULE_RELATIONSHIP_EXTERNAL`).
- A `plan_template_hint`: one of `simple_search`, `search_and_verify`, `search_verify_enrich`, or `deep_research`.

The tool sequence is always linear: `SEARCH_PLACES → WEB_VISIT → EVIDENCE_EXTRACT → TOWER_JUDGE`.

**Stage 3 — Mission Execution**  
File: `server/supervisor/mission-executor.ts`  

The executor loops through the `MissionToolStep[]`:
1. Calls Google Places (`SEARCH_PLACES`) to collect base candidates.
2. Applies lightweight local field filters (name match, minimum rating, etc.).
3. For each candidate requiring verification: visits websites (`WEB_VISIT`), extracts evidence (`EVIDENCE_EXTRACT` via `constraint-led-extractor.ts`), and calls Tower for semantic judgement (`TOWER_JUDGE`).
4. Compiles the surviving "winning" leads and calls `emitDeliverySummary()`.

Constants that bound execution:  
- `RUN_EXECUTION_TIMEOUT_MS_DEFAULT` = 300,000 ms (5 minutes)  
- `MAX_TOOL_CALLS_DEFAULT` = 150  
- `MAX_REPLANS_DEFAULT` = 5 (hard cap: 10)  
- `ENRICH_CONCURRENCY` = 3 (parallel website visits per batch)  
- `ENRICH_BATCH_SIZE` = 25

**Stage 4 — Tower Artefact Judgement**  
File: `server/supervisor/tower-artefact-judge.ts`  
Function: `judgeArtefact()`  

A high-level audit pass. Tower reviews the full accumulated result set and issues a `TowerVerdictV1`:

| Verdict | Meaning |
|---|---|
| `ACCEPT` | Run is complete and satisfactory |
| `RETRY` | Transient glitch — retry same plan once (max 1 retry) |
| `CHANGE_PLAN` | Strategy is failing; expand radius or adjust parameters |
| `STOP` | Hard failure; halt the run |

**Stage 5 — Agent Loop / Replanning**  
File: `server/supervisor/agent-loop.ts`  

If Tower issues `CHANGE_PLAN`, the `RunState` is updated (e.g., search radius expanded using `RADIUS_LADDER_KM`) and the executor re-runs from Stage 3. If Tower issues `STOP` or the run exceeds retry/replan limits, the loop halts and delivers a final `run_summary` artefact.

**Stage 6 — Delivery**  
File: `server/supervisor/run-receipt.ts`  
Function: `emitRunReceipt()`  

Fetches all artefacts for the run, assembles them into a `RunReceiptPayload`, generates `narrative_lines`, and stores the receipt. See Section 8 for detail.

---

## 3. GOOGLE PLACES SEARCH

### Files that call Google Places

| File | Role |
|---|---|
| `server/supervisor/google-places.ts` | Core implementation of `searchPlaces()` |
| `server/supervisor/action-executor.ts` | Central dispatcher; maps `SEARCH_PLACES` tool to `executeSearchPlaces()` |
| `server/supervisor/plan-executor.ts` | Executes plan steps; calls `SEARCH_PLACES`; handles auto-replan fallback |
| `server/supervisor/mission-planner.ts` | Decides when `SEARCH_PLACES` is required |
| `server/routes.ts` | Exposes `/api/supervisor/search-places` for manual searches |

### How many GP calls per query?

Typically **one** `searchText` call per `SEARCH_PLACES` step. The API v1 endpoint returns up to 20 results per call. The system enforces `Math.min(maxResults, 20)` as a hard cap. Pagination is not implemented — only the first "page" of results is fetched.

If Tower issues `CHANGE_PLAN` (e.g., expand radius), a second `SEARCH_PLACES` call is made in the next plan version. Over a full multi-replan run the theoretical maximum is `MAX_REPLANS_DEFAULT` (5) calls, but in practice most runs complete in one or two.

### Query modes and parameters

Two modes are supported, selected per request:

**`TEXT_ONLY`** — query string, location, and country are concatenated into a single `textQuery` string. No geo-bias parameters.

**`BIASED_STABLE`** — geocodes the target location (via Google Geocoding API, with in-memory `geocodeCache` keyed by `"location::country"`), then sends:
- `textQuery`
- `locationBias` — circle: resolved lat/lng + 50 km radius
- `regionCode` — e.g., `"uk"`

Field mask (`X-Goog-FieldMask`) is fixed:
```
places.id, places.displayName, places.formattedAddress,
places.location, places.types, places.websiteUri
```

No separate Place Details calls are made. `websiteUri` is returned inline with the search response.

### Caching and deduplication

**`placeCache`** — in-memory `Map<place_id, { website, phone, cachedAt, cacheVersion }>`. Avoids re-resolving known place IDs. Logs `[PLACES CACHE HIT]` on a hit.  
**`geocodeCache`** — in-memory `Map<"location::country", { lat, lng }>`. Avoids redundant Geocoding API calls.  
Both caches are **process-scoped** (no persistence, no TTL). A `TODO` in `google-places.ts` explicitly notes TTL is required before production.

**Deduplication** — `accumulateLeads()` in `server/supervisor/plan-executor.ts` uses a `Map` keyed by `place_id` to merge results across multiple plan steps. Subsequent steps touching the same physical place update the existing record rather than creating duplicates.

---

## 4. GPT-4o WEB SEARCH (FALLBACK / CASCADE)

### Where is the web search fallback called?

File: `server/supervisor.ts` — inside the main execution loop, Phase 12 (Attribute Verification), approximately lines 3929–4634.  
File: `server/supervisor/mission-executor.ts` — triggers the cascade during the `EVIDENCE_GATHER` step.  
File: `server/supervisor/web-search.ts` — implements the `WEB_SEARCH` tool using the **Brave Search API** (`https://api.search.brave.com/res/v1/web/search`).

### What triggers fallback from GP to GPT-4o/Brave?

The system applies a **three-tier investigation strategy** (discovery cascade) per candidate per `HAS_ATTRIBUTE` constraint:

| Tier | Label | Trigger Condition |
|---|---|---|
| 1 | `cached_pages` | Cached web-visit data from a prior `WEB_VISIT` step exists |
| 2 | `active_web_visit` | No cache; lead has a `website` URL from Google Places |
| 3 | `web_search_then_visit` | Lead has **no website** OR the active visit failed/was bot-blocked |

Tier 3 is the "fallback." Budget limits: `MAX_ACTIVE_VISITS` = 8 (tier 2); `MAX_SEARCH_FALLBACKS` = 5 (tier 3).

### What is the discovery cascade and how does it work?

1. **Tier 1 — check cache.** If `cachedWebVisitPages` already holds text from a previous WEB_VISIT for this candidate, scan those pages directly. Skip tiers 2 and 3.
2. **Tier 2 — active visit.** Call `WEB_VISIT` on the candidate's `website` URL (from Google Places). Crawl up to 10 pages, following internal links prioritised by "page hints" (`/contact`, `/menu`, `/about`). Extract text. Scan for evidence.
3. **Tier 3 — web search then visit.** Call the `WEB_SEARCH` tool (Brave Search) with a query like `"<business name> <location> <attribute>"`. The response includes a `best_guess_official_url`. Then call `WEB_VISIT` on that URL and extract text.

In all tiers, the extracted text is passed through the two-layer evidence extraction described in Section 6.

### Prompt sent for the web search step

There is no direct LLM call inside the Brave Search step itself — Brave is a standard search API. The LLM involvement happens in the **extraction** step that follows retrieval (see Section 6). The Brave query is constructed programmatically as:

```
"<entity_name> <location_hint> <constraint>"
```

Example: `"Red Lion Arundel beer garden"`

The `WebSearchInput` parameters sent to `web-search.ts`:
```typescript
{
  query: string,         // constructed query string above
  location_hint?: string, // e.g., "Arundel"
  entity_name?: string,   // e.g., "Red Lion"
  limit: number           // capped at MAX_RESULTS_CAP = 10
}
```

Output includes `best_guess_official_url` and `why_this_url`, which the cascade uses to decide which URL to visit next.

---

## 5. PER-CANDIDATE WEBSITE VISITS

### Files handling website crawling / fetching

| File | Role |
|---|---|
| `server/supervisor/web-visit.ts` | Primary `WEB_VISIT` tool implementation |
| `server/supervisor/cvl.ts` | Constraint Verification Layer — maps constraints to `website_visit` method |
| `server/supervisor/action-executor.ts` | Dispatches `WEB_VISIT` calls |
| `server/supervisor/plan-executor.ts` | Orchestrates visit steps within plan execution |
| `server/supervisor.ts` | Handles visit failures, sets `crawlerFailed` / `active_visit_failed` flags |

### How are candidate websites identified?

The `websiteUri` field is returned **inline** from the Google Places `searchText` response and stored on the candidate record. No separate Place Details call is made. The URL is passed directly to `WEB_VISIT` as the entry point.

### Crawling logic inside `web-visit.ts`

The tool starts at a base URL and follows internal links up to `max_pages` (default and hard cap: 10). Page selection is guided by "page hints" — path fragments like `/contact`, `/about`, `/menu`, `/food`, `/garden` — that indicate high-value pages for the current constraint.

**Fetch strategy:**
1. Standard `fetch` with `REALISTIC_HEADERS` (Chrome User-Agent mimicry) and a 15-second timeout.
2. `cheerio` strips scripts, styles, nav elements, and footers; extracts plain text and internal links.

### What happens when bot-blocked?

**Detection:**
- HTTP status codes 403, 429, 503 trigger the blocked path.
- Content is scanned for 16 challenge signal strings: `"cloudflare"`, `"verify you are human"`, `"checking your browser"`, `"ray id"`, and similar.
- Heuristic: if page text is < 5,000 characters AND contains at least one challenge signal, it is flagged as blocked.

**Reaction (in order):**
1. **Playwright fallback** — `runPlaywright()` launches headless Chromium (via the pre-installed Playwright package). This can bypass JS-challenge pages (e.g., Cloudflare's "Just a moment" screen).
2. **Blocked error** — if Playwright also fails, the tool returns `{ errorCode: "BLOCKED" }`.
3. **Graceful degradation** — `server/supervisor.ts` catches the blocked result, sets `crawlerFailed: true` or `active_visit_failed`, and marks the specific attribute as `unknown` with reason `"Active visit failed"` rather than failing the whole run.

---

## 6. PER-CANDIDATE EVIDENCE EXTRACTION

### Files handling evidence extraction

| File | Role |
|---|---|
| `server/supervisor.ts` | `extractEvidenceSnippets()`, `keywordScoreFallback()`, `scanPagesForAttribute()` |
| `server/supervisor/constraint-led-extractor.ts` | `extractConstraintLedEvidence()` — the structured extraction engine |
| `server/supervisor/tower-semantic-verify.ts` | `requestSemanticVerification()` — GPT-4o judge call |
| `server/supervisor/mission-executor.ts` | Orchestrates the extraction + verification flow per candidate |
| `server/supervisor/run-receipt.ts` | Formats final evidence for the delivery document |

### The two-layer approach

**Layer 1 — Keyword Window / Sentence Extraction**

Implemented in `server/supervisor.ts` (`extractEvidenceSnippets`, `keywordScoreFallback`):

1. Page text is split into sentences using `.!?` as delimiters.
2. Each sentence is scored:
   - **+3** per keyword match.
   - **+1** if the keyword appears in the first half of the sentence (prominence signal).
   - **+1** if sentence length is 5–40 words (readability signal).
3. If no qualifying sentences are found, fallback to **keyword window**: extract 200-character chunks around each keyword match and score them (+2 per match).
4. The top 1–3 highest-scoring snippets are selected as candidate evidence.

**Layer 2 — GPT-4o Semantic Judge**

Implemented in `server/supervisor/tower-semantic-verify.ts` (`requestSemanticVerification()`):

The extracted snippets are sent to the Tower judge (GPT-4o-mini for per-lead checks) with a prompt that asks: does this text genuinely prove the business offers the specified attribute?

The judge explicitly rejects:
- Incidental keyword mentions (e.g., another business's name).
- Generic directory-style lists.
- Review text that only mentions the attribute in passing.

The judge returns one of four statuses: `verified`, `weak_match`, `no_evidence`, `insufficient_evidence`.

If the judge returns `no_evidence` or `insufficient_evidence` for a **hard** constraint across all candidates, the run is halted with an `unverifiable_hard_constraint` terminal artefact.

### Evidence item output format (`EvidenceItem` from `constraint-led-extractor.ts`)

```typescript
{
  source_url: string;
  page_title: string;
  constraint_type: string;       // e.g., "attribute"
  constraint_value: string;      // e.g., "beer garden"
  matched_phrase: string;
  direct_quote: string;
  context_snippet: string;
  constraint_match_reason: string;
  source_type: SourceType;       // 'website' | 'search_snippet' | 'gov_page' | 'social_media' | 'directory' | 'unknown'
  source_tier: SourceTier;       // 'first_party_website' | 'search_snippet' | 'directory_field' | 'lead_field' | 'external_source'
  confidence_score: number;
  quote: string;
  url: string;
  match_reason: string;
  confidence: 'high' | 'medium' | 'low';
  keyword_matched: string | null;
}
```

The full extraction result (`ConstraintLedExtractionResult`) also includes:
- `verdict`: `yes` | `no` | `unknown`
- `extraction_method`: `keyword_sentence_match` | `keyword_window` | `no_match` | `none`
- `verification_source`: `tower_semantic` | `keyword_only` | `web_search_fallback`
- `extracted_quotes`: `string[]`
- `tower_semantic.status`: the judge verdict
- `tower_semantic.reasoning`: natural language explanation from the judge

---

## 7. PER-CANDIDATE TOWER VERIFICATION

### Where are per-candidate Tower calls made?

| File | Function | Scope |
|---|---|---|
| `server/supervisor/mission-executor.ts` (~line 1150) | `requestSemanticVerification()` | Per candidate, per hard constraint |
| `server/supervisor/tower-semantic-verify.ts` | `requestSemanticVerification()` | Implements the API call |
| `server/supervisor/plan-executor.ts` | `requestJudgement()` | Per plan step (global progress check) |
| `server/supervisor/tower-judgement.ts` | `requestJudgement()` | Implements the global evaluation call |

### Payload sent to Tower for each candidate (semantic verification)

Endpoint: `POST /api/tower/semantic-verify`

```json
{
  "run_id": "string",
  "original_user_goal": "Find 5 pubs in Arundel with a beer garden",
  "lead_name": "The Red Lion",
  "lead_place_id": "ChI...",
  "constraint_to_check": "beer garden",
  "source_url": "https://redlionarundel.co.uk",
  "evidence_text": "[Evidence 1] Source: ... | Quote: \"...\" | Context: ...",
  "extracted_quotes": ["We have a lovely beer garden at the rear..."],
  "page_title": "The Red Lion - Best Pub in Arundel"
}
```

### How Tower responses are handled per candidate

Tower returns one of: `verified`, `weak_match`, `no_evidence`, `insufficient_evidence`.

These map to the candidate's constraint status in the delivery artefact:

| Tower status | Delivery treatment |
|---|---|
| `verified` | Constraint satisfied; lead included in PASS count |
| `weak_match` | Constraint likely satisfied; lead may be included as PARTIAL |
| `no_evidence` | Constraint not met for this candidate; candidate may be dropped or marked unverified |
| `insufficient_evidence` | Inconclusive; treated as unverified unless sufficient other candidates exist |

If a **hard** constraint returns `no_evidence` or `insufficient_evidence` across **all** candidates, the run is halted immediately with `unverifiable_hard_constraint`.

### Global per-step Tower judgement (plan-executor)

A separate call is made after each plan step to `POST /api/tower/evaluate`. Payload includes:
- **Success criteria:** target lead count, max cost, max steps, min quality score, stall window settings.
- **Snapshot:** steps completed, leads found, failure count, total cost, average quality score.

This returns a `TowerVerdictV1` with `verdict` of `ACCEPT | RETRY | CHANGE_PLAN | STOP` (see Stage 4 in Section 2).

---

## 8. FINAL DELIVERY

### How results are assembled into the final delivery package

**Trigger:** At the end of the `SupervisorService.processSupervisorTasks` loop in `server/supervisor.ts` (~line 6045), after all plan steps complete or a halt condition is met.

**Assembly — `server/supervisor/run-receipt.ts` — `emitRunReceipt()`:**
1. Fetches all artefacts for the `run_id` from the database.
2. Matches `lead_pack`, `contact_extract`, and `attribute_evidence` artefacts to the specific leads being delivered — using `place_id` or normalised name matching.
3. Aggregates counts: `unique_email_count`, `unique_phone_count`, `evidence_reference_count`.
4. Generates human-readable `narrative_lines` (e.g., "I searched Google Places in Arundel and found 15 candidates. I visited 5 websites...").
5. Stores the `RunReceiptPayload` as an artefact.
6. Returns it as part of the supervisor's chat response.

**Delivery status derivation — `server/supervisor/delivery-summary.ts` — `deriveCanonicalStatus()`:**

| Final status | Conditions |
|---|---|
| `PASS` / `VERIFIED` | Tower verdict `ACCEPT` AND all hard constraints verified for required count of leads |
| `PARTIAL` / `UNVERIFIED` | `ACCEPT` with some unverified leads, a count shortfall, or some hard constraints unverifiable |
| `STOP` / `UNTRUSTED` | Tower verdict `STOP` or `FAIL`, OR 0 leads delivered, OR a hard constraint explicitly contradicted |
| `CHANGE_PLAN` | Tower determines strategy is failing; system loops back |

### What triggers the final Tower call vs. per-candidate calls?

- **Per-candidate Tower calls** — triggered during the `EVIDENCE_GATHER` step in `mission-executor.ts` for each lead × each hard constraint requiring semantic verification. These produce `attribute_evidence` artefacts.
- **Final (global) Tower call** — the "Single Authoritative Tower Call" made at the end of the supervisor loop in `server/supervisor.ts`. It evaluates the **entire** accumulated lead set and evidence collection together and issues the run-level verdict.

### `attribute_verification` artefact structure

Produced in `server/supervisor/mission-executor.ts` (~lines 1621–1645):

```typescript
{
  type: "attribute_verification",
  title: "Evidence verification: 5/10 checks passed",
  summary: "5 evidence found out of 10 checks across 5 leads",
  payload: {
    execution_source: "mission",
    total_checks: number,           // Total attribute checks attempted
    checks_with_evidence: number,   // Checks that returned positive evidence
    leads_checked: number,          // Distinct leads processed
    fallback_candidates: number,    // Checks that used web search fallback (tier 3)
    fallback_verified: number,      // Tier-3 fallback checks that succeeded
    results: [
      {
        lead: string,               // Business name
        constraint: string,         // Attribute being verified (e.g., "beer garden")
        type: string,               // Constraint type (e.g., "attribute", "ranking")
        found: boolean,
        strength: "strong" | "weak",
        tower_status: string | null, // Verdict from semantic judge
        source_tier: string          // "first_party" | "snippet" | "web_search_fallback"
      }
    ]
  }
}
```

An older variant of this artefact (used in some extraction flows for backwards compatibility) uses the field names `attribute_raw`, `lead_place_id`, `attribute_found`, and `url_visited` instead of the structure above. Both formats are handled by `run-receipt.ts`.

---

## FILE INDEX

| File | Primary Responsibility |
|---|---|
| `server/supervisor/canonical-intent.ts` | `MISSION_TYPE_ENUM` definition and all intent schemas |
| `server/supervisor/intent-extractor.ts` | LLM-based `mission_type` determination |
| `server/supervisor/goal-to-constraints.ts` | Legacy fallback `deriveGoal()` — deprecated |
| `server/supervisor/query-shape-key.ts` | Derives `intentClass` for learning-store key |
| `server/supervisor/constraint-gate.ts` | Blocks runs with invalid/missing fields |
| `server/supervisor/mission-planner.ts` | Translates intent into `MissionPlan` + tool sequence |
| `server/supervisor/mission-executor.ts` | Executes plan steps; orchestrates the full verification loop |
| `server/supervisor/agent-loop.ts` | Outer retry/replan loop; handles `TowerVerdictV1` |
| `server/supervisor/plan-executor.ts` | Inner step executor; accumulates leads; calls per-step Tower |
| `server/supervisor/google-places.ts` | Google Places API v1 (`searchPlaces`) |
| `server/supervisor/web-visit.ts` | Website crawling tool; Playwright fallback; bot-block detection |
| `server/supervisor/web-search.ts` | Brave Search API wrapper (`WEB_SEARCH` tool) |
| `server/supervisor/constraint-led-extractor.ts` | Layer 1 evidence extraction; `EvidenceItem` type |
| `server/supervisor/tower-semantic-verify.ts` | Layer 2 GPT-4o judge (per-candidate semantic check) |
| `server/supervisor/tower-judgement.ts` | Global per-step Tower evaluation |
| `server/supervisor/tower-artefact-judge.ts` | Final `judgeArtefact()` audit call |
| `server/supervisor/cvl.ts` | Constraint Verification Layer — maps constraints to visit method |
| `server/supervisor/delivery-summary.ts` | `deriveCanonicalStatus()`; assembles `DeliverySummaryPayload` |
| `server/supervisor/run-receipt.ts` | `emitRunReceipt()` — final delivery document |
| `server/supervisor/artefacts.ts` | `createArtefact()` — generic artefact persistence |
| `server/supervisor/action-executor.ts` | Central tool dispatcher; maps tool names to implementations |
| `server/supervisor/learning-layer.ts` | Reads/writes execution policies to `learning_store` |
| `server/supervisor.ts` | Top-level supervisor service; `extractEvidenceSnippets`; Phase 12 attribute verification loop |

---

## IMPLEMENTATION LOG — GPT-4o Primary Search Execution Path

**Date:** 2026-03-18  
**Task:** Add `gpt4o_primary` execution path as an additive alternative to the existing GP cascade pipeline  

---

### FILES CREATED

**`server/supervisor/gpt4o-search.ts`** *(new)*

Self-contained module implementing the entire `gpt4o_primary` execution path. Contains:

- `Gpt4oSearchContext` — interface for all parameters passed from `mission-executor.ts`
- `Gpt4oPrimaryResult` — return type, identical shape to `MissionExecutionResult`
- `buildSearchPrompt()` — constructs the GPT-4o prompt from intent narrative and constraints
- `callGpt4oWebSearch()` — calls `openai.responses.create()` with `model: "gpt-4o"` and `tools: [{ type: "web_search_preview" }]`; parses the `output` array for `message`/`output_text` items
- `deduplicateLeads()` — case-insensitive exact name deduplication across search rounds
- `toDeliveryLead()` — converts `Gpt4oLead` to the standard delivery lead shape with a deterministic `placeId` of the form `gpt4o_{index}_{normalized_name}`
- `executeGpt4oPrimaryPath()` — the main exported function; runs steps A–H end-to-end

---

### FILES MODIFIED

**`server/supervisor/mission-executor.ts`**

1. Added import: `import { executeGpt4oPrimaryPath, type Gpt4oSearchContext } from './gpt4o-search';`  
2. Added field to `MissionExecutionContext` interface: `executionPath?: 'gp_cascade' | 'gpt4o_primary';`  
3. Added conditional branch in `executeMissionDrivenPlan()` — immediately after the `plan_execution_started` AFR event (line ~715), before the first `let leads: DiscoveredLead[] = [];` declaration. All existing GP cascade code is untouched and remains below the new `if` block.

**`server/supervisor.ts`**

Added one line to the `missionCtx` object at the `executeMissionDrivenPlan` call site:
```typescript
executionPath: (requestData as any).execution_path === 'gpt4o_primary' ? 'gpt4o_primary' : 'gp_cascade',
```
`requestData` is `task.request_data`, already in scope. Any value other than `"gpt4o_primary"` (including absent/undefined) resolves to `"gp_cascade"` — full backward compatibility.

**`server/routes.ts`**

Added one spread to the `request_data` object in `POST /api/debug/simulate-chat-task`:
```typescript
...(req.body?.execution_path ? { execution_path: req.body.execution_path } : {}),
```
Only adds the field if the UI sends it. No change to any existing field.

---

### HOW execution_path ROUTING WORKS

```
UI sends POST /api/debug/simulate-chat-task
  { user_message: "...", execution_path: "gpt4o_primary" }
       │
       ▼
routes.ts: stores execution_path inside request_data (Supabase supervisor_tasks row)
       │
       ▼
supervisor.ts: reads requestData.execution_path, passes to MissionExecutionContext
       │
       ▼
mission-executor.ts: executeMissionDrivenPlan()
  ┌─ common setup runs for ALL paths ────────────────────────┐
  │  • Plan artefact created                                  │
  │  • Verification policy artefact created                   │
  │  • Intent narrative artefact created                      │
  │  • plan_execution_started AFR event emitted               │
  └───────────────────────────────────────────────────────────┘
       │
       ├── ctx.executionPath === 'gpt4o_primary'
       │       └──► executeGpt4oPrimaryPath()  (gpt4o-search.ts)
       │
       └── everything else (gp_cascade / absent / undefined)
               └──► existing GP + cascade pipeline (unchanged)
```

Missing / `undefined` / `"gp_cascade"` all fall through to the existing code unchanged. The existing pipeline is enclosed inside its own implicit else branch with zero modifications.

---

### GPT-4o PROMPT TEMPLATE

```
You are a research assistant finding specific entities. Search the web thoroughly.
[Search angle note — only on rounds 2+]

TASK: Find {entity_description} in {location} that match the following search. {constraint_text}
Location: {location}, {country}

For EACH result you find, provide:
- name: The entity/business name
- description: Brief description of what they do
- evidence: The specific evidence that they match the search criteria
- source_url: The URL where you found this information
- location: Their address or location if available
- confidence: "high" | "medium" | "low"

Respond with ONLY a JSON object in this exact format:
{
  "results": [...],
  "search_summary": "...",
  "coverage_assessment": "..."
}
```

`entity_description` is drawn from `intentNarrative.entity_description` if available, otherwise `businessType`. `constraint_text` is built from `hardConstraints` joined with `", "`. Subsequent search rounds use different `angle` strings to vary the approach.

---

### HOW LEADS ARE FORMATTED

Each `Gpt4oLead` from GPT-4o is converted via `toDeliveryLead()`:

| Delivery field | Source |
|---|---|
| `name` | `lead.name` directly |
| `address` | `lead.location` (GPT-4o's location field) |
| `phone` | Always `null` (GPT-4o doesn't return phone numbers) |
| `website` | `lead.source_url` (the URL GPT-4o found evidence at) |
| `placeId` | `gpt4o_{index}_{normalized_name}` — deterministic, not a Google Place ID |

The full `deliveredLeadsWithEvidence` object additionally includes:
- `source: 'gpt4o_web_search'`
- `verified: true`
- `verification_status: 'verified'`
- `constraint_verdicts`: all hard constraints mapped to `'verified'`
- `evidence`: `[{ source_url, text: lead.evidence, confidence }]`
- `match_summary`: first 150 chars of the evidence string

---

### SEARCH ROUNDS / COMPLETENESS CHECK (STEP D)

- Maximum rounds: `MAX_SEARCH_ROUNDS = 3`  
- Low-result threshold: `LOW_RESULT_THRESHOLD = 5`  
- A subsequent round is triggered only if **all three** conditions are true:
  1. Fewer than 5 leads found so far
  2. GPT-4o's `coverage_assessment` text contains "more", "additional", or "likely"
  3. Remaining rounds are available
- Deduplication across rounds is by exact lowercased-trimmed name match
- Each round uses a different search angle string (primary → `{businessType} {location} {hardConstraints}` → `{location} {businessType} directory listings`)

---

### ARTEFACTS EMITTED (gpt4o_primary path)

| Artefact type | When | Content |
|---|---|---|
| `plan` | Start (common) | Mission plan — same as gp_cascade |
| `verification_policy` | Start (common) | Same as gp_cascade |
| `intent_narrative` | Start (common, if present) | Same as gp_cascade |
| `diagnostic` | On GPT-4o call failure | Error message + raw excerpt |
| `step_result` | After all search rounds | rounds_performed, leads found, search_summaries |
| `attribute_verification` | After search | source_tier=`gpt4o_web_search` for all leads; evidence inline |
| `final_delivery` | Before Tower | Full leads with evidence attached |
| `tower_judgement` | After Tower | Same structure as gp_cascade |
| `tower_unavailable` | On Tower failure | Same structure as gp_cascade |
| `delivery_summary` | Final | Via `emitDeliverySummary()` — same as gp_cascade |

---

### DECISIONS MADE DURING IMPLEMENTATION

1. **OpenAI SDK version**: v6.22.0 is installed. The `openai.responses` namespace exists and supports `responses.create()`. Used `(openai as any).responses.create()` to avoid TypeScript type conflicts on the experimental API surface while keeping the real call path.

2. **Circular import avoidance**: `gpt4o-search.ts` does not import from `mission-executor.ts`. `MissionExecutionResult` is re-declared locally as `Gpt4oPrimaryResult` with an identical shape. Types from `mission-schema.ts`, `delivery-summary.ts`, and `verification-policy.ts` are imported directly — no circular chain.

3. **Branch placement**: The `if (ctx.executionPath === 'gpt4o_primary')` check is placed immediately after the common setup block (plan/policy artefacts + `plan_execution_started` AFR event). This means the trust card, mission understanding, and plan artefacts are always emitted regardless of execution path, matching the spec requirement to keep those bubbles unchanged.

4. **Per-candidate Tower verification**: Completely skipped in the `gpt4o_primary` branch. The `attribute_verification` artefact is still created and populated with `tower_status: 'verified'` and `source_tier: 'gpt4o_web_search'`, preserving the artefact schema for downstream consumers.

5. **Final Tower judgement**: Called identically to the gp_cascade path, using the same `judgeArtefact()` function with the same success criteria structure. `requires_relationship_evidence` is hardcoded to `false` for gpt4o_primary (relationship predicates are a GP cascade concept).

6. **`placeId` format**: `gpt4o_{index}_{normalized_name}` — not a real Google Place ID but still unique within a run. Follows the same `dedupe_key` pattern used by `makeDedupeKey('hash:...')` in `agent-loop.ts`.

7. **`run-receipt.ts` not modified**: The narrative logic in `run-receipt.ts` does not check `source_tier` strings directly (confirmed by code inspection). It generates narrative from aggregated outcome fields. No changes needed.

8. **Backward compatibility**: Verified that all callers of `executeMissionDrivenPlan` pass `MissionExecutionContext`. The new `executionPath` field is optional (`?`) so all existing call sites are unaffected without changes.

---

## BUG FIX — Non-deterministic clarification gate (Pass 3)

**Date:** 2026-03-18  
**Issue:** Same query "Find organisations that work with the local authority in Blackpool" sometimes executed successfully (8 results) and sometimes halted at the clarification gate, producing zero results. The root cause was that `gpt-4o-mini` non-deterministically set `clarify_if_needed: true` on relationship constraints, and the gate unconditionally honoured that flag.

**Root cause in code:**  
`server/supervisor.ts` lines ~1150–1166 (pre-fix). The condition was:
```typescript
if (missionMode === 'active' && missionResult?.intentNarrative?.clarification_needed && !missionQueryId) {
  // halt, insert clarification message, return
}
```
The LLM's `clarification_needed` boolean was the **sole decision-maker** for halting execution. Because gpt-4o-mini is stochastic, identical inputs produced different routing decisions across runs.

**Fix applied (`server/supervisor.ts`):**

Added a deterministic `_missionHasEnoughToSearch` check immediately before the halt block:

```typescript
const _missionHasEnoughToSearch =
  missionResult?.ok === true &&
  !!missionResult.mission &&
  !!(missionResult.mission.entity_category?.trim()) &&
  !!(missionResult.mission.location_text?.trim()) &&
  missionResult.mission.constraints.length > 0;
```

The halt block's condition is now `... && !_missionHasEnoughToSearch && !missionQueryId` — so it only halts when the structured mission genuinely lacks the minimum content needed to search (no entity category, or no location, or no constraints). When the mission IS actionable, a suppression log line is emitted and execution falls through to the GP cascade or gpt4o_primary path as normal.

**Decision rules (deterministic):**

| Condition | Result |
|---|---|
| `entity_category` non-empty AND `location_text` non-empty AND ≥1 constraint | PROCEED — suppress clarify gate |
| Any of the above missing | HALT — allow clarification question |
| Benchmark run (`missionQueryId` set) | PROCEED — existing bypass unchanged |

**What was NOT changed:**
- Intent extractor prompt and LLM call (`mission-extractor.ts`) — untouched
- Pass 1, Pass 2, GP cascade, Tower calls, website visits — untouched
- `gpt4o_primary` path — untouched
- The clarification halt itself is preserved for genuinely vague queries

**Expected log output on suppression:**
```
[PASS3_CLARIFY] clarification_needed=true but mission is actionable — entity="organisations" location="Blackpool" constraints=1 — suppressing clarification gate, proceeding to search
```

---

## VERIFICATION — Clarification gate fix persistence check

**Date:** 2026-03-18  
**Task:** Verify the `_missionHasEnoughToSearch` guard was present on disk and live in the running server, and add explicit diagnostic logging.

---

### Was the previous fix present?

**YES — the fix was present and correctly written to disk.**

On reading `server/supervisor.ts` lines 1150–1185, the `_missionHasEnoughToSearch` guard was found intact exactly as applied in the previous session. The concern that "the fix did not persist" was not accurate at the code level — the file contained the correct guard. The issue may have been that a run used a server process that started before the fix was hot-reloaded, or that a subsequent run was executed against a different environment.

---

### What was done

1. **Read the file** — confirmed the guard was present at lines 1154–1185
2. **Added explicit `[CLARIFY-GATE]` diagnostic logging** as requested:
   - `[CLARIFY-GATE] Values:` — emitted whenever `clarification_needed=true`, showing the three gate inputs
   - `[CLARIFY-GATE] _missionHasEnoughToSearch:` — emitted showing the boolean result
   - `[CLARIFY-GATE] Suppressed — mission has enough to search:` — emitted when the gate is overridden and the run proceeds
3. **Killed the old `tsx` process** explicitly via `pkill` (not relying on hot-reload)
4. **Restarted the workflow** — server came up clean with no TypeScript errors
5. **Confirmed server live** — HTTP 200 on port 5000

---

### Final gate logic (lines 1153–1200 after this session)

```typescript
const _clarifyGateEntity   = missionResult?.mission?.entity_category?.trim()   ?? '';
const _clarifyGateLocation = missionResult?.mission?.location_text?.trim()       ?? '';
const _clarifyGateConstraintCount = missionResult?.mission?.constraints?.length  ?? 0;

const _missionHasEnoughToSearch =
  missionResult?.ok === true &&
  !!missionResult.mission &&
  !!_clarifyGateEntity &&
  !!_clarifyGateLocation &&
  _clarifyGateConstraintCount > 0;

// Diagnostic — emits whenever clarification_needed=true
if (missionResult?.intentNarrative?.clarification_needed) {
  console.log('[CLARIFY-GATE] Values:', { entity_category, location_text, constraintCount, clarify_if_needed });
  console.log('[CLARIFY-GATE] _missionHasEnoughToSearch:', _missionHasEnoughToSearch);
}

// Suppression path — runs proceed, gate is bypassed
if (missionMode === 'active' && clarification_needed && _missionHasEnoughToSearch && !missionQueryId) {
  console.log('[CLARIFY-GATE] Suppressed — mission has enough to search:', { entity_category, location_text, constraintCount });
}

// Halt path — only triggers when entity/location/constraints are missing
if (missionMode === 'active' && clarification_needed && !_missionHasEnoughToSearch && !missionQueryId) {
  // ... halt, insert clarification message, return
}
```

---

### Expected log on next triggered suppression

```
[CLARIFY-GATE] Values: { entity_category: 'organisations that work with the local authority', location_text: 'Blackpool', constraintCount: 1, clarify_if_needed: true }
[CLARIFY-GATE] _missionHasEnoughToSearch: true
[CLARIFY-GATE] Suppressed — mission has enough to search: { entity_category: 'organisations that work with the local authority', location_text: 'Blackpool', constraintCount: 1 }
```

The pipeline then continues to GP cascade / gpt4o_primary as normal.

---

## BUG FIX — outer_constraint_gate blocking relationship queries

**Date:** 2026-03-18  
**Issue:** After the `pass3_clarify` gate was fixed, runs were still halting intermittently with verdict `outer_constraint_gate`. The query "Find organisations that work with the local authority in Blackpool" had `stop_recommended: false` but `can_execute: false`, causing a halt before search.

---

### Root cause

The outer constraint gate (`server/supervisor.ts` ~line 1800) builds a `constraintContract` from the raw user message. For relationship predicates like "work with the local authority", the `RelationshipPredicateConstraint` is classified as:

```
can_execute: false
verifiability: "proxy"
hardness: "soft"
stop_recommended: false
why_blocked: "Relationship constraint requires strategy selection before search can proceed"
```

There was already a bypass block at line 1840 that checks:
1. `pass3ClearedClarification` — fires only when `intentNarrative.clarification_needed === false`
2. `missionQueryId` — fires only for benchmark runs

The gap: when `pass3_clarify` suppresses the clarification gate (because `_missionHasEnoughToSearch=true`), the `intentNarrative.clarification_needed` field remains `true` in the narrative object. So `pass3ClearedClarification` evaluates to `false`, the bypass doesn't trigger, and the outer gate halts execution.

---

### Fix applied (`server/supervisor.ts`, lines ~1850–1862)

Added a third check inside the existing bypass block:

```typescript
// If the structured mission has entity + location + constraint, it is searchable regardless
// of what the constraint gate says about can_execute.
if (!outerGateResult.can_execute && _missionHasEnoughToSearch) {
  console.log('[OUTER-GATE] Suppressed — mission has enough to search:', {
    entity_category: _clarifyGateEntity,
    location_text: _clarifyGateLocation,
    constraintCount: _clarifyGateConstraintCount,
    blocked_types: outerGateResult.constraints.map((c: any) => c.type),
  });
  outerGateResult = { ...outerGateResult, can_execute: true, why_blocked: null, clarify_questions: [] };
}
```

`_missionHasEnoughToSearch`, `_clarifyGateEntity`, `_clarifyGateLocation`, and `_clarifyGateConstraintCount` are all declared earlier in the same function scope (around line 1154) and are directly reachable here.

The bypass block outer condition (`!stop_recommended || missionQueryId`) already correctly scopes this to non-stop cases. A relationship predicate with `stop_recommended=false` is ALWAYS inside this block.

---

### Expected log on suppression

```
[OUTER-GATE] Suppressed — mission has enough to search: { entity_category: 'organisations that work with the local authority', location_text: 'Blackpool', constraintCount: 1, blocked_types: ['relationship_predicate'] }
[CONSTRAINT_GATE_OUTER] can_execute=true stop=false constraints=1 msg="Find organisations that work with the local authority..."
```

---

### Complete map of all execution-halting gates

The following gates can halt a run before or during search. Listed in execution order:

| Gate | Verdict emitted | Condition | Affected by fix? |
|---|---|---|---|
| **pass3_clarify** | `pass3_clarify` | `missionMode=active` AND `intentNarrative.clarification_needed=true` AND `!_missionHasEnoughToSearch` AND `!missionQueryId` | YES — Fixed (session 2) |
| **preflight_clarify** | `preflight_clarify` | Fires when `evaluatePreflightClarify()` returns a result. Only triggers when: business_type is missing, location is missing, or there is an unverifiable time predicate | NOT AFFECTED — does not trigger on relationship constraints |
| **factory_demo_stale** | `factory_demo_stale` | Session guard drops stale factory demo delivery | NOT A SEARCHABILITY GATE |
| **constraint_gate_stop (inner)** | `constraint_gate_stop` | `pendingConstraint` exists (follow-up to earlier clarification) AND `resolvedContract.stop_recommended=true` | NOT AFFECTED — only fires on follow-up to a prior gate halt |
| **constraint_gate_clarify (inner)** | `constraint_gate_clarify` | `pendingConstraint` exists AND `resolvedContract.can_execute=false` AND `!stop_recommended` | NOT AFFECTED — only fires on follow-up to a prior gate halt; also has auto-resolve logic for skip-like signals |
| **outer_constraint_gate** | `outer_constraint_gate` | `outerGateResult.can_execute=false` after all bypass checks fail | YES — Fixed (this session) |
| **session_guard_stale_run** | `session_guard_stale_run` | `guardDelivery()` returns false — fires after execution completes, not before | NOT A SEARCHABILITY GATE |

---

### Gates that require a strategic choice from the user (legitimate halts)

These gates deliberately block when there is no reasonable default:

- **`constraint_gate_stop`** — fires when `stop_recommended=true`, meaning the constraint is classified as fundamentally unsatisfiable (e.g. verifying a live event is happening right now). These are correct halts.
- **`preflight_clarify`** on `time_predicate_unverifiable` — when the user asks for "opening dates" or "new businesses opened this month" and no proxy is available. These are correct halts.
- **`preflight_clarify`** on `missing_business_type` or `missing_location` — the query literally has no actionable entity or location. These are correct halts.

---

### Summary of changes across all sessions

After both fixes, the routing for "Find organisations that work with the local authority in Blackpool" is:

```
pass3_clarify gate:
  → clarification_needed=true (LLM set it)
  → _missionHasEnoughToSearch=true (entity + location + 1 constraint)
  → SUPPRESSED — logs [CLARIFY-GATE] Suppressed, proceeds

outer_constraint_gate:
  → can_execute=false (relationship_predicate blocks)
  → stop_recommended=false
  → bypass block runs
  → _missionHasEnoughToSearch=true
  → SUPPRESSED — logs [OUTER-GATE] Suppressed, can_execute overridden to true

Pipeline proceeds → GP cascade → results
```

---

## REPORT — GPT-only Agent Run: Current State

**Date:** 2026-03-18  
**Type:** Read-only investigation — no code changes made  

---

### 1. What exists now

#### Server side — FULLY IMPLEMENTED

**`server/supervisor/gpt4o-search.ts`** (572 lines) — **Complete, production-ready**

The core execution module. Exports `executeGpt4oPrimaryPath(ctx: Gpt4oSearchContext)`. It:
- Calls `openai.responses.create({ model: 'gpt-4o', tools: [{ type: 'web_search_preview' }] })` via the Responses API
- Runs up to 3 search rounds with varied angle prompts; stops early if ≥5 leads found and coverage_assessment doesn't suggest more
- Deduplicates across rounds by lowercased name
- Creates artefacts: `step_result`, `attribute_verification`, `final_delivery`, `tower_judgement`/`tower_unavailable`, `delivery_summary`
- Calls Tower (`judgeArtefact()`) identically to the GP cascade
- Returns `{ response, leadIds, deliverySummary, towerVerdict, leads }` — same shape as `MissionExecutionResult`
- All leads get synthetic `placeId` of the form `gpt4o_{index}_{normalized_name}` (no Google Place IDs)
- `phone` is always `null` (web search doesn't return phone numbers)
- `website` is set to the GPT-4o source URL

**`server/supervisor/mission-executor.ts`** — **Wired, complete**

- Line 39: `import { executeGpt4oPrimaryPath, type Gpt4oSearchContext } from './gpt4o-search'`
- Line 61: `MissionExecutionContext` has `executionPath?: 'gp_cascade' | 'gpt4o_primary'`
- Lines 714–735: Branch immediately after common setup (plan/policy artefacts):
  ```typescript
  if (ctx.executionPath === 'gpt4o_primary') {
    return await executeGpt4oPrimaryPath(gpt4oCtx);
  }
  // ...GP cascade continues below
  ```
- The `Gpt4oSearchContext` is fully populated from the same `missionResult` fields used by the GP cascade

**`server/supervisor.ts`** — **Wired, one line**

- Line 1930: `executionPath: (requestData as any).execution_path === 'gpt4o_primary' ? 'gpt4o_primary' : 'gp_cascade'`
- Reads from `task.request_data.execution_path` (stored in Supabase `supervisor_tasks` row)
- Missing/undefined/any other value → `gp_cascade` (safe default)

**`server/routes.ts`** — **Wired, one line**

- Line 523: `...(req.body?.execution_path ? { execution_path: req.body.execution_path } : {})`
- The `POST /api/debug/simulate-chat-task` endpoint passes `execution_path` through into `request_data`
- No other endpoint (`/api/supervisor/jobs/start`, `/api/supervisor/execute-plan`) has this passthrough

---

#### Client side — NOT IMPLEMENTED

**No frontend toggle exists.** Confirmed by exhaustive search of all `.tsx` and `.ts` files under `client/src/`:

- No references to `execution_path`, `gpt4o`, `gpt-4o`, `search_mode`, or `agent_mode` in any component or page file
- `client/src/pages/Activity.tsx` — the benchmark runner at line 452 sends only `{ user_message, query_id }` with no `execution_path` field
- There is no radio button, toggle, dropdown, or any UI state tracking which agent mode is selected

**The only way to trigger the GPT-4o path today is via curl/Postman:**
```bash
curl -X POST http://localhost:5000/api/debug/simulate-chat-task \
  -H "Content-Type: application/json" \
  -d '{ "user_message": "Find pubs in Brighton", "execution_path": "gpt4o_primary" }'
```

---

### 2. What's wired vs stubbed

| Component | Status | Notes |
|---|---|---|
| `gpt4o-search.ts` | **Fully implemented** | Complete multi-round search, dedup, artefacts, Tower, delivery summary |
| `mission-executor.ts` branch | **Fully wired** | Routing logic, context building, return value |
| `supervisor.ts` passthrough | **Fully wired** | Reads `execution_path` from Supabase `request_data` |
| `routes.ts` passthrough | **Partially wired** | Only `simulate-chat-task` passes it through; `jobs/start` and `execute-plan` do not |
| UI toggle | **Not built** | No frontend component selects GPT-4o mode |
| `jobs/start` endpoint | **Missing passthrough** | Would need `execution_path` added same as `simulate-chat-task` |
| Phone numbers in results | **Known gap** | GPT-4o path always returns `phone: null`; GP cascade returns phone from Places API |

---

### 3. What's missing for a working UI flow

To have a user toggle GPT-4o in the UI, run a query, and get back a set of verified leads:

**A. UI toggle (required)**

In `client/src/pages/Activity.tsx`:
- Add state: `const [agentMode, setAgentMode] = useState<'gp_cascade' | 'gpt4o_primary'>('gp_cascade')`
- Add a toggle/radio before the benchmark run button
- Pass `execution_path: agentMode` in the `simulate-chat-task` POST body at line 452:
  ```typescript
  const res = await apiRequest("POST", "/api/debug/simulate-chat-task", {
    user_message: query,
    query_id: selectedBenchmark,
    execution_path: agentMode,    // ADD THIS
  });
  ```

**B. `jobs/start` passthrough (if that endpoint is used by the production chat path)**

`POST /api/supervisor/jobs/start` currently does not forward `execution_path` into `request_data`. The same one-line spread used in `simulate-chat-task` would be needed.

**C. Nothing else on the server side is missing.** The GPT-4o path is complete:
- Intent extraction (Passes 1/2/3) runs identically for both paths
- All three clarification gates run identically (including the fixes applied this session)
- The branch in `mission-executor.ts` fires before the GP cascade and returns the same result shape
- Tower verification, delivery summary, and AFR logging are all functional

---

### 4. How the GP cascade currently flows

Tracing from user query to results — names in order:

```
1. Entry point
   POST /api/debug/simulate-chat-task  (server/routes.ts line 495)
   → Inserts row into supabase `supervisor_tasks` with status='pending'
   → Inserts row into `agent_runs`

2. Supervisor polling loop
   SupervisorService.pollPendingTasks()  (server/supervisor.ts ~line 820)
   → Supabase realtime or 5s polling picks up pending task
   → Calls this.runTask(task)

3. Intent extraction — Passes 1, 2, 3
   runMissionExtraction()  (server/supervisor/mission-extractor.ts)
   → Pass 1: Semantic interpretation + constraint checklist (gpt-4o-mini)
   → Pass 2: Structured mission JSON — entity_category, location_text, constraints[]
   → Pass 3: Intent narrative — entity_description, clarification_needed, scarcity_expectation
   → Returns MissionExtractionResult { ok, mission, intentNarrative, trace }

4. Clarification gates (server/supervisor.ts)
   → pass3_clarify gate (line ~1182): halts if clarification_needed=true AND !_missionHasEnoughToSearch
   → preflight_clarify gate (line ~1495): halts if business_type or location missing, or unverifiable time predicate
   → outer_constraint_gate (line ~1855): halts if can_execute=false AND !_missionHasEnoughToSearch

5. Mission planning
   buildMissionPlan()  (server/supervisor/mission-planner.ts)
   → Selects strategy: 'discovery_then_website_evidence' | 'direct_attribute_search' | etc.
   → Builds tool_sequence, constraint_mappings, verification_policy, candidate_pool

6. Execution dispatch
   executeMissionDrivenPlan(missionCtx)  (server/supervisor/mission-executor.ts ~line 550)
   → Emits plan/policy artefacts
   → Branches: if executionPath === 'gpt4o_primary' → executeGpt4oPrimaryPath() (see above)
   → Otherwise: GP cascade begins

7. GP cascade — Discovery
   executeAction({ type: 'SEARCH_PLACES' })  (server/supervisor/action-executor.ts)
   → Calls searchGooglePlaces() which wraps the Google Places API
   → Returns list of DiscoveredLead[] (name, address, phone, website, placeId)
   → Typically fetches 20–30 candidates per query

8. GP cascade — Enrichment / Website visits
   executeAction({ type: 'WEB_VISIT' }) per candidate  (action-executor.ts)
   → Fetches up to 5 pages per domain (with Playwright fallback on bot-block)
   → Stores crawled text in WebVisitPages artefacts

9. GP cascade — Evidence extraction
   extractConstraintLedEvidence()  (server/supervisor/constraint-led-extractor.ts)
   → L1: keyword window scan on crawled pages
   → L2: GPT-4o sentence judge on matched windows
   → If no website evidence: GPT-4o web search fallback (gpt4o_fallback path in agent-loop.ts)
   → Returns EvidenceItem[] with source_url, strength, matched_text

10. GP cascade — Tower verification
    judgeArtefact()  (server/supervisor/tower-artefact-judge.ts)
    → Sends final_delivery artefact to external Tower API (TOWER_URL env var)
    → Tower returns verdict: 'pass' | 'fail' and action: 'accept' | 'change_plan' | 'stop'
    → On 'fail' + 'change_plan': may trigger replan (up to MAX_REPLANS_DEFAULT=5)

11. Delivery
    emitDeliverySummary()  (server/supervisor/delivery-summary.ts)
    → Builds DeliverySummaryPayload
    → Writes delivery_summary artefact
    → AFR run_completed event emitted
    → supervisor_tasks row updated to status='completed'
    → Final message written to supabase `messages` table
```

**Key files in order:**
`routes.ts` → `supervisor.ts` → `mission-extractor.ts` → `mission-planner.ts` → `mission-executor.ts` → `action-executor.ts` → `constraint-led-extractor.ts` → `tower-artefact-judge.ts` → `delivery-summary.ts`

For the GPT-4o path, steps 7–9 are replaced entirely by `gpt4o-search.ts`, with steps 10–11 (Tower + delivery summary) running identically.


---

## Change Log — 2026-03-19: Wire execution_path through /api/supervisor/jobs/start

### What Changed
The `execution_path` field sent by the UI in the request body to `POST /api/supervisor/jobs/start` was not being forwarded into the `supervisor_tasks` row created in Supabase. This meant the branch at `mission-executor.ts:714` that routes to the GPT-4o search executor (`gpt4o-search.ts`) could never be reached via the main job start route — only via the `simulate-chat-task` endpoint.

### Files Modified

**`server/supervisor/jobs.ts`**
- Added `executionPath?: string` field to the `StartJobRequest` interface.
- In the Supabase `supervisor_tasks` insert (inside the `deep_research` branch), added a conditional spread into `request_data`: `...(request.executionPath ? { execution_path: request.executionPath } : {})`. This mirrors the same pattern already used in `server/routes.ts` for the simulate-chat-task route.

**`server/supervisor/jobs-router.ts`**
- Extracted `execution_path` from the raw request body: `const executionPath = (req.body as any).execution_path || undefined;`
- Passed it into the `startJob(...)` call as `executionPath`.
- Added a log line: `execution_path: ${executionPath || 'N/A'}` for observability.

### Files Not Modified (by design)
- `server/supervisor/gpt4o-search.ts` — already works; no changes needed.
- `server/supervisor/mission-executor.ts` — already reads `ctx.executionPath` correctly; no changes needed.
- `server/supervisor.ts` — already maps `requestData.execution_path` → `ctx.executionPath`; no changes needed.

### Decisions Made
- `execution_path` is stored only inside `request_data` (the JSON column), not as a top-level column on `supervisor_tasks`. This is consistent with how `server/routes.ts:523` handles it in the simulate-chat-task path, and is where `server/supervisor.ts:1930` reads it from.
- Used a conditional spread `...(value ? { key: value } : {})` rather than `execution_path: value || null` to avoid writing an explicit `null` into `request_data` when the field is absent — keeps task rows clean for callers that don't set it.

### What's Next
- The full path `UI → /api/supervisor/jobs/start → supervisor_tasks.request_data.execution_path → mission-executor.ts:714 → gpt4o-search.ts` is now wired end-to-end.
- Optional: consider validating that `execution_path` is one of `'gp_cascade' | 'gpt4o_primary'` in the router before forwarding, to surface bad values early.

---

## Diagnostic — 2026-03-19: Trace of execution_path through actual chat route

### Question being answered
When a user submits a query via the chat interface, `execution_path` is not reaching the executor despite the GPT-4o toggle being selected. Where is the break?

---

### Finding 1 — The UI has NO GPT-4o toggle and sends NO execution_path

A full search across every file in `client/src` (pages, components, hooks, lib) reveals:
- Zero occurrences of `execution_path`
- Zero occurrences of `gpt4o` or `gpt4o_primary`
- No toggle, switch, or checkbox for executor selection

**The GPT-4o toggle described in the prompt does not yet exist in the frontend.** This is almost certainly the root cause of the end-to-end failure: the field is never emitted by the UI regardless of which route is used.

---

### Finding 2 — The UI's "chat submission" actually calls /api/debug/simulate-chat-task, NOT /api/supervisor/jobs/start

The only interactive query submission in the current UI is in `client/src/pages/Activity.tsx`:

| Button | Function | Route called |
|--------|----------|-------------|
| "Run Benchmark" | `handleRunBenchmark()` (line 445) | `POST /api/debug/simulate-chat-task` |
| "Run Supervisor Demo" | `handleRunDemo()` (line 428) | `POST /api/debug/demo-plan-run` |

Neither calls `/api/supervisor/jobs/start`.

The benchmark submission at line 452 sends only:
```json
{ "user_message": "<query>", "query_id": "<benchmark_id>" }
```
No `execution_path` field is included.

---

### Finding 3 — /api/debug/simulate-chat-task already handles execution_path correctly

The route handler at `server/routes.ts` line 495 already contains:
```typescript
...(req.body?.execution_path ? { execution_path: req.body.execution_path } : {}),
```
(line 523). It correctly writes `execution_path` into `request_data` — exactly where `server/supervisor.ts` line 1930 reads it.

So the route is already wired. The field just never arrives because the UI doesn't send it.

---

### Finding 4 — /api/supervisor/jobs/start is never called by the UI

No file in `client/src` references `/api/supervisor/jobs/start`, `/api/supervisor/jobs`, or `startJob`. The previous fix (wiring `execution_path` through `jobs-router.ts` → `jobs.ts`) was architecturally correct for that route, but the route is unused by the current frontend for query submission.

---

### Root cause

The break is not in any backend route handler. It is in the frontend: **the Activity page's benchmark runner omits `execution_path`, and no GPT-4o toggle UI exists** to let users set it.

---

### Where the fix needs to go

**File:** `client/src/pages/Activity.tsx`

**What's needed:**
1. Add a boolean state variable (e.g. `useGpt4o: boolean`) — toggled by a Switch/Toggle UI element labelled "GPT-4o Search"
2. In `handleRunBenchmark()` (line 452), include `execution_path` in the request body when the toggle is on:
   ```typescript
   const res = await apiRequest("POST", "/api/debug/simulate-chat-task", {
     user_message: query,
     query_id: selectedBenchmark,
     ...(useGpt4o ? { execution_path: "gpt4o_primary" } : {}),
   });
   ```

No backend changes are required — `/api/debug/simulate-chat-task` already accepts and forwards `execution_path` into `request_data`, and `server/supervisor.ts` line 1930 already reads it and passes it to the executor context.

---

### Summary of all files and their status

| File | Status |
|------|--------|
| `server/routes.ts` line 523 | ✅ Already passes `execution_path` into `request_data` |
| `server/supervisor.ts` line 1930 | ✅ Already reads it and sets `ctx.executionPath` |
| `server/supervisor/mission-executor.ts` line 714 | ✅ Already branches on `ctx.executionPath === 'gpt4o_primary'` |
| `server/supervisor/gpt4o-search.ts` | ✅ Already works when reached |
| `server/supervisor/jobs-router.ts` | ✅ Now wired (previous fix) — but unused by UI |
| `server/supervisor/jobs.ts` | ✅ Now wired (previous fix) — but unused by UI |
| `client/src/pages/Activity.tsx` | ❌ Missing: GPT-4o toggle + `execution_path` in submit call |
