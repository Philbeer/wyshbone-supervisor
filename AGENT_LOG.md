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
