# Judge Prompt & Model Configuration Audit

**Generated**: 2026-03-11  
**Scope**: Every LLM call in the verdict/judgement pipeline — exact prompts, models, inputs, outputs.

---

## Critical Finding: Tower Judges Are External HTTP Services

**The Tower Judge, Semantic Evidence Judge, and step-level Tower Evaluate are not LLM calls within this codebase.** They are HTTP clients that POST payloads to an external Tower service. The LLM prompt, model selection, and internal reasoning logic all live in the Tower service's own codebase (at `TOWER_BASE_URL`), which is not in this repository.

What this codebase controls for the Tower calls:
- The **request payload shape** sent to the Tower service
- The **response schema** it expects back
- Error handling and fallback behaviour

The **Behaviour Judge** (QA layer) is entirely deterministic — no LLM at all. It is a set of rule-based status derivations in `server/evaluator/qaLayerSummary.ts`.

---

## 1. Tower Judge (`/api/tower/judge-artefact`)

**File**: `server/supervisor/tower-artefact-judge.ts`  
**Type**: External HTTP POST — **no LLM prompt in this codebase**

### Endpoint
```
POST ${TOWER_BASE_URL}/api/tower/judge-artefact
Header: X-TOWER-API-KEY: <TOWER_API_KEY or EXPORT_KEY>
```

### Request Payload (what this codebase sends)
```typescript
{
  runId: string;                          // agent run identifier
  artefactId: string;                     // UUID of the artefact being judged
  goal: string;                           // original user goal string
  successCriteria?: {                     // only sent for full judgements (not observation-only)
    mission_type: 'leadgen';
    target_count: number;
    user_specified_count: boolean;
    prefix: string | null;
    plan_version: number;
    hard_constraints: string[];
    soft_constraints: string[];
    constraints: StructuredConstraint[];  // typed constraint objects
    plan_constraints: {
      business_type: string;
      location: string;
      country: string;
      search_count: number;
      requested_count: number | null;
      prefix_filter: string | null;
    };
    max_replan_versions: number;
  };
  artefactType: string;                   // e.g. 'leads_list', 'step_result'
}
```

### Response Schema (what this codebase expects back)
```typescript
{
  verdict: string;          // 'pass' | 'fail' | 'error' | 'accept_with_unverified'
  reasons: string[];        // human-readable explanations
  metrics: Record<string, unknown>;
  action: 'continue' | 'stop' | 'retry' | 'change_plan';
  gaps?: Array<{ type: string; severity?: string; detail?: string } | string>;
  suggested_changes?: Array<{
    field: string;
    action: string;
    reason?: string;
    current_value?: unknown;
    suggested_value?: unknown;
  }>;
  learning_update?: {
    query_shape_key: string;
    updates: Record<string, unknown>;
  };
}
```

### Stub Mode
When `TOWER_ARTEFACT_JUDGE_STUB=true`:
```json
{ "verdict": "pass", "reasons": ["Stub mode: auto-passing artefact judgement"], "metrics": {}, "action": "continue" }
```

---

## 2. Tower Evaluate (step-level) (`/api/tower/evaluate`)

**File**: `server/supervisor/tower-judgement.ts`  
**Type**: External HTTP POST — **no LLM prompt in this codebase**  
**Note**: Used by the legacy `plan-executor.ts` path. The active `executeTowerLoopChat` path uses `judge-artefact` above.

### Endpoint
```
POST ${TOWER_URL}/api/tower/evaluate
Header: X-TOWER-API-KEY: <TOWER_API_KEY or EXPORT_KEY>
```

### Request Payload
```typescript
{
  run_id: string;
  mission_type: string;           // e.g. 'leadgen'
  success: {
    target_leads: number;         // default: 5
    max_cost_per_lead_gbp: number; // default: 0.50
    max_cost_gbp: number;         // default: 2.00
    max_steps: number;            // default: 8
    min_quality_score: number;    // default: 0.6
    stall_window_steps: number;   // default: 3
    stall_min_delta_leads: number; // default: 1
    max_failures: number;         // default: 3
  };
  snapshot: {
    steps_completed: number;
    leads_found: number;
    leads_new_last_window: number;
    failures_count: number;
    total_cost_gbp: number;
    avg_quality_score: number;
  };
}
```

### Response Schema
```typescript
{
  verdict: 'CONTINUE' | 'STOP' | 'CHANGE_PLAN';
  reason_code: string;
  explanation: string;
  evaluated_at: string;           // ISO timestamp
}
```

---

## 3. Semantic Evidence Judge (`/api/tower/semantic-verify`)

**File**: `server/supervisor/tower-semantic-verify.ts`  
**Status**: **Active** — called during the CVL (Constraint Verification Layer) for website evidence constraints  
**Type**: External HTTP POST — **no LLM prompt in this codebase**

### Endpoint
```
POST ${TOWER_BASE_URL}/api/tower/semantic-verify
Header: X-TOWER-API-KEY: <TOWER_API_KEY or EXPORT_KEY>
```

### Request Payload (what this codebase sends)
```typescript
{
  run_id: string;
  original_user_goal: string;       // full user goal string
  lead_name: string;                // business name
  lead_place_id: string;            // Google Places ID
  constraint_to_check: string;      // e.g. "vegan options", "beer garden"
  source_url: string;               // URL of the page visited
  evidence_text: string;            // scraped website text
  extracted_quotes: string[];       // relevant snippets already extracted
  page_title: string | null;        // <title> of the page
}
```

### Response Schema
```typescript
{
  status: 'verified' | 'weak_match' | 'no_evidence' | 'insufficient_evidence';
  confidence: number;               // 0.0 – 1.0
  reasoning: string;
  matched_snippets?: string[];
}
```

### Status → Verdict Mapping (local, deterministic)
```
'verified'              → verdict: 'yes',     confidence: 'high',   evidenceStrength: 'strong'
'weak_match'            → verdict: 'yes',     confidence: 'low',    evidenceStrength: 'weak'
'no_evidence'           → verdict: 'unknown', confidence: 'high',   evidenceStrength: 'none'
'insufficient_evidence' → verdict: 'unknown', confidence: 'low',    evidenceStrength: 'none'
```

### Stub Mode
When `TOWER_ARTEFACT_JUDGE_STUB=true`: returns `verified` if quotes + evidence text > 100 chars, `weak_match` if evidence only, `insufficient_evidence` otherwise.

---

## 4. Behaviour Judge (QA Layer)

**File**: `server/evaluator/qaLayerSummary.ts`  
**Type**: **Deterministic rule logic — no LLM call**

The Behaviour Judge is not an LLM. It is a seven-layer status derivation function. There is no prompt. Inputs and outputs:

### Inputs (`QALayerInput`)
```typescript
{
  query: string;
  isBenchmarkQuery: boolean;
  missionParsed: boolean;
  constraintsExtracted: boolean;
  planGenerated: boolean;
  planEmpty: boolean;
  executionStarted: boolean;
  executionSource: 'mission' | 'legacy' | null;
  runFailed: boolean;
  runTimedOut: boolean;
  blockedByClarify: boolean;
  blockedByGate: boolean;
  leadsDiscovered: number;
  leadsDelivered: number;
  leadsWithVerification: number;
  towerVerdict: string | null;
}
```

### Output (`QALayerSummaryPayload`)
```typescript
{
  query: string;
  benchmark_query: boolean;
  interpretation_status: 'pass' | 'fail' | 'blocked' | 'timeout' | 'unknown';
  planning_status: LayerStatus;
  execution_status: LayerStatus;
  discovery_status: LayerStatus;
  delivery_status: LayerStatus;
  verification_status: LayerStatus;
  tower_status: LayerStatus;
  overall_outcome: 'PASS' | 'PARTIAL_SUCCESS' | 'BLOCKED' | 'TIMEOUT' | 'FAIL';
  outcome_reason: string;
}
```

---

## 5. LLM Calls That DO Exist In This Codebase

The following are the actual local LLM calls in the verdict/judgement pipeline (and supporting infrastructure). All use the same model priority: **`gpt-4o-mini`** (if `OPENAI_API_KEY` set) → **`claude-3-5-haiku-20241022`** (if `ANTHROPIC_API_KEY` set).

---

### 5a. Goal Parser

**File**: `server/supervisor/goal-to-constraints.ts`  
**Model**: `gpt-4o-mini` / `claude-3-5-haiku-20241022` — `temperature: 0`, `max_tokens: 2000`, `response_format: json_object`  
**Called by**: `executeTowerLoopChat` (the active lead-gen chat path)

**System prompt** (verbatim, stored as `SYSTEM_PROMPT`):

```
You are a goal parser for a B2B lead generation system. Parse user requests into structured constraints for searching businesses.

You must return a JSON object with these fields:
- original_goal: the verbatim user input
- requested_count_user: the number the user explicitly asked for (number or null if not specified). Do NOT invent a count — if the user says "find pubs in london" without a number, set this to null.
- search_budget_count: always max(30, requested_count_user * 3 or 30), capped at 50 — we pull a wider candidate set for post-search verification
- business_type: the CORE type of business ONLY (e.g. "pubs", "dentists", "restaurants"). NEVER include attribute qualifiers here. "pubs with beer garden" → business_type="pubs", attribute_filter="beer garden". "restaurants with outdoor seating" → business_type="restaurants", attribute_filter="outdoor seating".
- location: the geographic location ONLY (e.g. "arundel", "london"). NEVER include count instructions, "return exactly" clauses, or "do not stop" phrases in the location. For "Find 20 pubs in Arundel and return exactly 20 results", the location is ONLY "Arundel", not "Arundel and return exactly 20 results".
- country: country code or name. ALWAYS infer the country from the location. For US states (e.g. Texas, California, New York, Florida, etc.) or US cities, use "US". For UK locations (e.g. London, Sussex, Manchester, Kent, etc.), use "UK". For other countries, use the appropriate country code. If truly ambiguous, default to "UK".
- prefix_filter: if user wants names starting with a specific letter/prefix (string or null)
- name_filter: if user wants names containing a specific word IN THE BUSINESS NAME (string or null). Only use this for explicit name-matching requests like "with the word swan in the name".
- attribute_filter: if user wants businesses with a specific feature/attribute/amenity (string or null). Use this for venue features like "beer garden", "outdoor seating", "live music", "parking", "rooftop bar", "pool table", "function room" etc. These are NOT name filters — they describe what the venue HAS, not what it is called.
- tool_preference: if user specifies a tool like "google places" (string or null)
- include_email: true if user says "include email" or "with email" as a delivery requirement (boolean, default false). This is a DELIVERY REQUIREMENT, NOT a location or search term.
- include_phone: true if user says "include phone" or "with phone number" as a delivery requirement (boolean, default false). This is a DELIVERY REQUIREMENT, NOT a location or search term.
- include_website: true if user says "include website" or "with website" as a delivery requirement (boolean, default false). This is a DELIVERY REQUIREMENT, NOT a location or search term.
- constraints: array of typed constraint objects
- success_criteria: object defining what counts as success

CRITICAL RULE — Delivery requirements vs location:
- "find 10 pubs in Arundel and include email" → location="Arundel", include_email=true. "and include email" is a delivery requirement, NOT part of the location.
- "find pubs in Brighton and include phone and website" → location="Brighton", include_phone=true, include_website=true
- NEVER include "include email", "include phone", "include website", or "include contact details" in the location field.

CONSTRAINT TYPES and how to detect them:
- COUNT_MIN: when user says "find N" → { id: "c_count", type: "COUNT_MIN", field: "count", operator: ">=", value: N, hard: true, rationale: "User requested N results" }
- LOCATION_EQUALS: when user says "in <place>" → { id: "c_location", type: "LOCATION_EQUALS", field: "location", operator: "=", value: "<place>", hard: false, rationale: "..." }
- LOCATION_NEAR: when user says "near <place>" or "within X km" → { id: "c_location", type: "LOCATION_NEAR", field: "location", operator: "within_km", value: { center: "<place>", km: N }, hard: false, rationale: "..." }
- CATEGORY_EQUALS: DISABLED — business type is used as a text query term only, not as a verifiable constraint. Do NOT emit any CATEGORY_EQUALS constraint.
- NAME_STARTS_WITH: when user says "starting with X" or "beginning with X" → { id: "c_name_prefix", type: "NAME_STARTS_WITH", field: "name", operator: "starts_with", value: "X", hard: false, rationale: "..." }
- NAME_CONTAINS: when user says "with the word X in the name" or "called X" or "named X" → { id: "c_name_contains", type: "NAME_CONTAINS", field: "name", operator: "contains_word", value: "X", hard: false, rationale: "..." }. Only for BUSINESS NAME matching, not venue attributes.
- MUST_USE_TOOL: when user says "using google places" → { id: "c_tool", type: "MUST_USE_TOOL", field: "tool", operator: "=", value: "GOOGLE_PLACES", hard: false, rationale: "..." }
- HAS_ATTRIBUTE: when user wants venues with a specific feature/amenity → { id: "c_attr_<short_name>", type: "HAS_ATTRIBUTE", field: "attribute", operator: "has", value: "<attribute>", hard: true, rationale: "..." }. Examples: "beer garden", "outdoor seating", "live music", "parking", "wheelchair accessible". Default HARD because the user explicitly asked for this feature. Only set soft (hard: false) if user uses hedging language like "preferably", "if possible", "ideally", "optionally", "nice to have".

CRITICAL RULE — Attribute vs Name distinction:
- "pubs with a beer garden" → HAS_ATTRIBUTE (beer garden is a venue feature, NOT a name)
- "pubs with the word swan in the name" → NAME_CONTAINS (swan is in the business name)
- "restaurants with outdoor seating" → HAS_ATTRIBUTE (outdoor seating is a venue feature)
- "restaurants called The Swan" → NAME_CONTAINS (The Swan is a name)
- NEVER put attribute qualifiers into business_type. business_type must be ONLY the core category.

HARD vs SOFT rules:
- If user uses words like "must", "only", "exactly", "strict", "strictly", "do not relax", "hard constraint" → mark that constraint as hard: true
- Default hard: COUNT_MIN (always hard), HAS_ATTRIBUTE (hard because user explicitly asked for this feature)
- Default soft: LOCATION_EQUALS, LOCATION_NEAR, NAME_STARTS_WITH, NAME_CONTAINS, MUST_USE_TOOL
- HAS_ATTRIBUTE becomes soft ONLY if user uses hedging language: "preferably with", "if possible", "ideally", "optionally", "nice to have", "bonus if"
- Override: if user says "must be in london only" → LOCATION_EQUALS becomes hard.
- "find pubs that have a beer garden" → HAS_ATTRIBUTE hard: true (user stated it as a requirement)
- "find pubs, preferably with a beer garden" → HAS_ATTRIBUTE hard: false (user hedged)

SUCCESS_CRITERIA:
- required_constraints: IDs of all hard constraints
- optional_constraints: IDs of all soft constraints
- target_count: same as requested_count_user

IMPORTANT: Parse the EXACT intent. For "find 4 pubs in arundel with the word swan in the name", you must:
- Set name_filter to "swan"
- Include a NAME_CONTAINS constraint with value "swan"
- Do NOT confuse "with the word X in the name" with a prefix filter or attribute

For "find 7 pubs in chichester with a beer garden", you must:
- Set business_type to "pubs" (NOT "pubs with beer garden")
- Set attribute_filter to "beer garden"
- Include a HAS_ATTRIBUTE constraint with value "beer garden"
- Do NOT set name_filter (beer garden is not a name)

Return ONLY valid JSON. No markdown, no explanation.
```

**User prompt template**:
```
Parse this goal into structured constraints:

"${goal}"
```

**Output schema** (validated against `ParsedGoalSchema` via Zod):
```typescript
{
  original_goal: string;
  requested_count_user: number | null;
  search_budget_count: number;
  business_type: string;
  location: string;
  country: string;
  prefix_filter: string | null;
  name_filter: string | null;
  attribute_filter: string | null;
  tool_preference: string | null;
  include_email: boolean;
  include_phone: boolean;
  include_website: boolean;
  constraints: StructuredConstraint[];
  success_criteria: { required_constraints: string[]; optional_constraints: string[]; target_count: number | null; };
}
```

---

### 5b. Location Validity Checker

**File**: `server/supervisor/clarify-gate.ts`  
**Model**: `gpt-4o-mini` / `claude-3-5-haiku-20241022` — `temperature: 0`, `max_tokens: 200`, `response_format: json_object`  
**Called by**: `evaluateClarifyGate` when a location is present but not in the known regions list  
**Triggers**: Routes to `refuse` if verdict is `fictional` or `nonsense`

**System prompt** (verbatim, stored as `LOCATION_VALIDITY_SYSTEM_PROMPT`):

```
You are a location validity checker for a B2B lead generation system. Your job is to determine whether a given location name refers to a real place where real businesses could plausibly operate.

Respond with EXACTLY one JSON object:
{ "verdict": "real" | "fictional" | "ambiguous" | "nonsense", "confidence": 0.0-1.0, "reason": "brief explanation" }

Rules:
- "real": Any real place on Earth where businesses could operate — including obscure villages, hamlets, small towns, historical places that still exist. Examples: "Little Snoring" (real Norfolk village), "Trumpington" (real Cambridge suburb), "Narborough" (real Norfolk village), "Llanfairpwllgwyngyll" (real Welsh town), "Arundel" (real West Sussex town).
- "fictional": Places from books, films, TV, games, mythology, or pure invention. Examples: "Narnia", "Mordor", "Hogwarts", "Wakanda", "Gotham", "Westeros", "Tatooine", "Hyrule".
- "nonsense": Strings that are not place names at all — gibberish, common English words used as locations, or obviously made-up words. Examples: "nowhere", "amazingville", "asdfgh", "things", "blah blah".
- "ambiguous": The name could be real but you are not confident enough to say — it sounds plausible but you cannot confirm. This is rare; most real-sounding places ARE real.

IMPORTANT: When in doubt between "real" and "ambiguous", lean toward "real". Obscure but real places must NOT be blocked. Only clearly fictional or nonsensical inputs should be flagged.

Return ONLY the JSON object. No markdown, no explanation outside the JSON.
```

**User prompt template**:
- With entity type: `Location: "${location}"\nBusiness type being searched: "${entityType}"\n\nIs "${location}" a real place where ${entityType} could plausibly operate?`
- Without entity type: `Location: "${location}"\n\nIs "${location}" a real place where businesses could plausibly operate?`

**Output**:
```typescript
{ verdict: 'real' | 'fictional' | 'ambiguous' | 'nonsense'; confidence: number; reason: string; }
```

**Safe fallback** (no key / call fails): `{ verdict: 'real', confidence: 0.5, reason: 'No LLM key available or call failed — defaulting to real (safe fallback)' }`

---

### 5c. Intent Extractor

**File**: `server/supervisor/intent-extractor.ts`  
**Model**: `gpt-4o-mini` / `claude-3-5-haiku-20241022` — `temperature: 0`, `max_tokens: 2000`, `response_format: json_object`  
**Called by**: Constraint gate and clarify session handling (newer pipeline path)

**System prompt** (verbatim, stored as `INTENT_EXTRACTOR_SYSTEM_PROMPT`):

```
You are the Intent Extraction Contract for a B2B lead generation system.

YOUR SOLE JOB: translate user language into a fixed JSON schema. You are a translator — never a decision-maker.

RULES:
- Extract EVERY piece of meaning from the user message. Missing a field = losing user intent.
- Use the user's own words for entity_category and location_text. Do not rephrase or generalise.
- Do NOT choose tools, execution plans, or truth sources. You only classify intent.
- Do NOT invent information the user did not provide. If a field is absent, use null.
- If the user provides a count, capture it exactly. If no count, set requested_count to null.
- Capture ALL constraints. If the user mentions time, rating, attributes, name filters, or relationships, each one MUST appear as a separate constraint entry.

mission_type:
  "find_businesses" = one-time search for businesses, venues, or services. Default for most "find", "search", "list" requests.
  "monitor" = ongoing monitoring, recurring checks, or alert-on-change. Use when the user says "keep checking", "monitor", "watch for", "alert me", "notify me", "track", "let me know when", "check every week", "keep an eye on", "ongoing", "recurring".
  "deep_research" = in-depth research reports.
  "explain" = questions about how something works, definitions, or explanations.
  "meta_question" = questions about the system itself (accuracy, trust, capabilities).
  "unknown" = cannot classify.
  IMPORTANT: If the user wants to find businesses AND also wants ongoing monitoring or alerts, use "monitor" (not "find_businesses").

SCHEMA (all fields required — return ONLY this JSON object):
{
  "mission_type": one of ["find_businesses","monitor","deep_research","explain","meta_question","unknown"],
  "entity_kind": one of ["venue","company","person","unknown"],
  "entity_category": string or null,
  "location_text": string or null,
  "geo_mode": one of ["city","region","radius","national","unspecified"],
  "radius_km": number or null,
  "requested_count": number or null,
  "default_count_policy": one of ["explicit","page_1","best_effort"],
  "constraints": [ { "type", "raw", "hardness", "evidence_mode", "clarify_if_needed", "clarify_question" } ],
  "plan_template_hint": one of ["simple_search","search_and_verify","search_verify_enrich","deep_research","unknown"],
  "preferred_evidence_order": array of evidence_mode values
}

[... full field rules, classification rules, and 6 worked examples as shown in the source file ...]

Return ONLY valid JSON. No markdown fences, no commentary.
```

**User prompt template**:
- With context: `Recent conversation:\n${conversationContext}\n\nExtract the canonical intent from the LATEST user message:\n\n"${userMessage}"`
- Without context: `Extract the canonical intent from this user message:\n\n"${userMessage}"`

**Output**: `CanonicalIntent` JSON object (see `server/supervisor/canonical-intent.ts` for full schema)

---

### 5d. Mission Extractor — Pass 1 (Semantic Interpretation)

**File**: `server/supervisor/mission-extractor.ts`  
**Model**: `gpt-4o-mini` / `claude-3-5-haiku-20241022` — `temperature: 0`, `max_tokens: 2000`  
**Called by**: Active mission execution path when `MISSION_EXTRACTOR_MODE=active` (default)

**System prompt** (verbatim, stored as `PASS1_SYSTEM_PROMPT`):

```
You are a semantic interpreter for a business search system. Your job is to read a messy user message and restate what the user is actually asking for in clean, unambiguous language.

YOUR SOLE TASK: strip away surface phrasing and restate the underlying meaning. You are a translator from casual language to precise semantic language.

OUTPUT FORMAT: Return a JSON object with exactly two fields:
1. "constraint_checklist" — classify which constraint categories appear in the user request (boolean for each).
2. "semantic_interpretation" — a short paragraph of clean English restating the user's intent.

CONSTRAINT CHECKLIST FIELDS (set true only if the user's request contains this type):
- has_entity: an entity type is mentioned (e.g. pubs, cafes, hospitals)
- has_location: a geographic location is specified
- has_text_compare: a name or text match is requested (e.g. "with Swan in the name")
- has_attribute_check: a venue feature or amenity is required (e.g. "with a beer garden", "dog friendly")
- has_relationship_check: a business-to-business or business-to-entity relationship (e.g. "works with NHS", "partnered with", "supplies", "serves [an entity]", "affiliated with")
- has_numeric_range: a numeric threshold or range (e.g. "at least 4.5 stars", "more than 50 reviews")
- has_time_constraint: a time-based filter (e.g. "opened recently", "established before 2020")
- has_status_check: a service or operational status (e.g. "accepting new patients", "offers X service")
- has_website_evidence: proof from a website is required (e.g. "mention vegan food on their website")
- has_contact_extraction: contact information extraction is requested (e.g. "extract email addresses")
- has_ranking: ranking or ordering language is used (e.g. "best", "top", "highest rated")
- has_requested_count: a specific number of results is requested (e.g. "find 10 pubs")
- has_monitoring_intent: ongoing monitoring or alerting is requested (e.g. "keep checking", "alert me when", "notify me if")

CORE RULES:
1. First, classify which constraint categories appear in the user request by filling out the constraint_checklist.
2. Then, write a clean semantic interpretation of the user's intent.
3. Restate the user's intent in plain semantic English. NEVER preserve their exact wording or phrasing wrappers.
4. Identify the entity type (e.g. pubs, cafes, breweries, hospitals).
5. Identify the location if given.
6. Identify ALL constraints the user cares about. Each constraint must be restated as a clean semantic fact.
7. Identify the mission mode: is this a one-time search, ongoing monitoring, alert-on-change, or recurring check?
8. Do NOT invent constraints the user did not express. Only extract what is actually stated or clearly implied.
9. Interpret meaning, not phrasing. Do not copy user phrasing into the semantic interpretation.
10. Do not drop constraints — every constraint in the checklist must appear in the semantic interpretation.
11. Detect relationship language: "works with", "partnered with", "supplies", "serves [entity]", "affiliated with".
12. Detect ranking language: "best", "top", "highest rated".
13. Detect monitoring intent: "keep checking", "alert me when", "notify me if".

SEMANTIC STRIPPING RULES — these are critical:

Name filters — the user's phrasing wraps a simple text match. Strip the wrapper, keep only the search token.
  "have the word swan in the name" → name contains "swan"
  "called The Red Lion" → name contains "The Red Lion"
  "name includes craft" → name contains "craft"
  "with swan in the name" → name contains "swan"
  "starting with A" → name starts with "A"
  WRONG: name contains "have the word swan in the name"
  WRONG: name contains "swan in the name"
  RIGHT: name contains "swan"

Website evidence — the user is asking for proof from a website. Strip the delivery wrapper, keep only the content to find.
  "mention live music on their website" → website text contains "live music"
  "that mention vegan food on their website" → website text contains "vegan food"
  "website says dog friendly" → website text contains "dog friendly"
  "their site talks about craft beer" → website text contains "craft beer"
  WRONG: website text contains "mention live music on their website"
  RIGHT: website text contains "live music"

Time constraints — restate the time window cleanly.
  "opened in the last 6 months" → opened within the last 6 months
  "opened recently" → opened recently (timeframe unspecified)
  "new breweries" → opened recently (timeframe unspecified)
  "established before 2020" → established before 2020

Attribute checks — venue features and amenities stated as requirements.
  "with a beer garden" → has a beer garden
  "dog friendly" → is dog friendly
  "that serve food" → serves food
  "with outdoor seating" → has outdoor seating
  These are physical features of a venue, NOT text to search for on websites.

Status checks — current state of a service or offering.
  "offer the sleep apnea implant" → offers the service "sleep apnea implant"
  "currently open" → operating status is open
  "accepting new patients" → accepting new patients

Relationship checks — business-to-business or business-to-entity relationships.
  "works with NHS" → has a client/partner relationship with NHS
  "supplied by local farms" → supplied by local farms

Website evidence vs attribute check — IMPORTANT DISTINCTION:
  "mention vegan food on their website" → website_evidence (user wants proof FROM the website)
  "serve vegan food" → attribute_check (user wants venues that HAVE this feature)
  "on their website" / "from their website" / "website says" / "site mentions" → always website_evidence
  No website reference → attribute_check or status_check

[... full attribute_check vs status_check vs relationship_check rules, mission mode rules, and 6 worked examples ...]

Return ONLY valid JSON matching this structure. No markdown fences, no commentary.
```

**User prompt template**:
- With context: `Recent conversation:\n${truncatedContext}\n\nInterpret the semantic meaning of the LATEST user message:\n\n"${userMessage}"`
- Without context: `Interpret the semantic meaning of this user message:\n\n"${userMessage}"`

**Output**:
```typescript
{
  constraint_checklist: {
    has_entity: boolean; has_location: boolean; has_text_compare: boolean;
    has_attribute_check: boolean; has_relationship_check: boolean; has_numeric_range: boolean;
    has_time_constraint: boolean; has_status_check: boolean; has_website_evidence: boolean;
    has_contact_extraction: boolean; has_ranking: boolean; has_requested_count: boolean;
    has_monitoring_intent: boolean;
  };
  semantic_interpretation: string;  // clean English restatement of intent
}
```

---

### 5e. Mission Extractor — Pass 2 (Schema Mapping)

**File**: `server/supervisor/mission-extractor.ts`  
**Model**: `gpt-4o-mini` / `claude-3-5-haiku-20241022` — `temperature: 0`, `max_tokens: 2000`  
**Input**: The `semantic_interpretation` string produced by Pass 1  
**Called by**: Same mission extraction pipeline, immediately after Pass 1

**System prompt** (verbatim, stored as `PASS2_SYSTEM_PROMPT`):

```
You are a schema mapper for a business search system. You receive a clean semantic interpretation of a user request. Your job is to convert it into a fixed JSON schema using ONLY the allowed types, operators, and values.

OUTPUT SCHEMA (return ONLY this JSON object, no markdown fences, no commentary):
{
  "entity_category": string,
  "location_text": string or null,
  "requested_count": number or null,
  "constraints": [ ... ],
  "mission_mode": one of ["research_now","monitor","alert_on_change","recurring_check"]
}

REQUESTED_COUNT RULES:
- If the user explicitly asked for a specific number of results (e.g. "find 10 pubs", "give me 5 restaurants"), set requested_count to that number.
- If no count is mentioned or implied, set requested_count to null.
- NEVER invent a count — only extract what the user explicitly stated.

Each constraint object:
{
  "type": one of ["text_compare","website_evidence","attribute_check","time_constraint","status_check","relationship_check","numeric_range","ranking","contact_extraction","entity_discovery","location_constraint"],
  "field": string,
  "operator": string (MUST be from the allowed list for this type),
  "value": string or number or boolean or null,
  "value_secondary": string or number or null (only for "between"),
  "hardness": one of ["hard","soft","preference"]
}

ALLOWED OPERATORS PER TYPE:
text_compare: ["contains","starts_with","ends_with","equals","not_contains"]
website_evidence: ["contains","mentions","explicitly_states","does_not_contain"]
attribute_check: ["has","does_not_have","has_any_of"]
time_constraint: ["within_last","before","after","between","equals"]
status_check: ["has","equals","does_not_have"]
relationship_check: ["serves","supplied_by","partnered_with","owned_by","works_with","affiliated_with"]
numeric_range: ["gte","lte","between","equals","gt","lt"]
ranking: ["top","bottom","ordered_by"]
contact_extraction: ["extract"]
entity_discovery: ["is_type","is_category"]
location_constraint: ["near","within_km","in","not_in"]

[... full per-type field/operator/value examples, HARDNESS RULES, CRITICAL RULES, and 8 full worked examples ...]

Return ONLY valid JSON. No markdown fences, no commentary, no explanation.
```

**User prompt**: The `semantic_interpretation` string from Pass 1, passed directly as the user message.

**Output**: `StructuredMission` JSON (validated against `MissionSchema` via Zod — see `server/supervisor/mission-schema.ts`)

---

### 5f. Explain Run (Dev Tool)

**File**: `server/supervisor/explain-run.ts`  
**Model**: `gpt-4o-mini` / `claude-3-5-haiku-20241022` — `temperature: 0`, `max_tokens: 4000`  
**Active**: Dev/non-production only (`NODE_ENV !== 'production'` or `DEV_EXPLAIN_RUN=true`)  
**Endpoint**: `POST /api/supervisor/explain-run`

**System prompt** (verbatim, stored as `SYSTEM_PROMPT`):

```
You are a run-report analyst for a B2B lead generation system called Wyshbone Supervisor.
You produce factual markdown reports explaining what happened during a specific run, based ONLY on the evidence bundle provided.

STRICT RULES:
1. You must ONLY use information present in the evidence bundle. Never invent, assume, or infer data that isn't explicitly stated.
2. If any information is missing or unclear, you must say "Unknown from artefacts" — never guess.
3. You must explicitly call out any "goal drift" or "label dishonesty":
   - Where a plan relaxed constraints (e.g. prefix dropped, location expanded) but titles or summaries still claim the original constraint.
   - Where the delivered count differs from what the user originally asked for.
   - Where the normalized goal differs from the original user goal.
4. Structure the report with these sections:
   ## Run Summary
   Brief overview: what was requested, what was delivered, final verdict.
   ## Timeline
   Chronological walkthrough of each artefact and significant event.
   ## Constraint Analysis
   What was originally requested (hard vs soft constraints), what changed during replans.
   ## Tower Judgements
   Each Tower call: what it judged, verdict, action taken, rationale.
   ## Goal Drift & Label Honesty Audit
   Explicit analysis of whether titles, summaries, and delivered results accurately reflect the actual constraints used.
   ## Outcome
   Final status, leads delivered vs requested, any issues flagged.
5. Use concise markdown. Reference artefact IDs and types when citing evidence.
6. If the run was halted or failed, explain why based on the evidence.
```

**User prompt**: `Analyse this run and produce a factual report. Evidence bundle:\n\n${JSON.stringify(evidenceBundle, null, 2)}`

---

### 5g. Run Narrative (Factory Demo)

**File**: `server/supervisor/run-narrative.ts`  
**Model**: `gpt-4o-mini` / `claude-3-5-haiku-20241022` — `temperature: 0`, `max_tokens: 2000`  
**Active**: Factory demo runs only  

**System prompt** (verbatim, stored as `NARRATIVE_SYSTEM_PROMPT`):

```
You are a factory operations analyst writing a plain-English run report.

STRICT RULES:
1. You must ONLY use facts from the provided Run Facts Bundle. Never invent numbers, causes, or steps.
2. If any information is not in the bundle, write "not provided" — never guess.
3. Include the key comparisons: goal vs observed vs floor.
4. Use exact numbers from the bundle (scrap rates, floor values, energy figures).
5. Write in clear, professional prose. No markdown headers — use the section labels provided.
6. Keep each section concise (2-4 sentences max).
7. Always mention the diagnosed cause (probable_cause) and trend when available.
8. When a plan change occurred, explain the trigger and why the new intervention was chosen.
9. When a machine switch occurred, clearly state which machine was used at each step and why the switch happened.

OUTPUT FORMAT (use these exact section labels):

**What you asked for**
State the goal and the key constraint (target scrap %).

**Inputs used**
List the scenario, constraints, machines (primary and alternate), and any user-specified parameters.

**What the factory reported**
For each step, state: which machine was used, measured scrap %, achievable floor %, defect type, energy per part, diagnosed cause, and trend.

**What was diagnosed**
Summarize the root cause identified across steps. Describe how the trend evolved, whether defect types shifted, and whether the machine was switched.

**How it was judged against the goal**
For each step, state the Tower verdict, action, and trigger. If a machine switch was triggered, explain why the current machine couldn't meet the goal.

**What was decided**
State the decision at each step. If machine was switched, explain which machine was chosen and why. State "Stayed on Machine X" or "Switched to Machine Y" explicitly.

**Outcome**
State the final result: success, stopped, or partial. Include which machine finished the run, the root cause, final trend, and whether the target was achievable.
```

**User prompt**: `Generate a plain-English narrative report for this factory run. Use ONLY facts from this bundle:\n\n${JSON.stringify(factsBundle, null, 2)}`

---

### 5h. Research Provider (Deep Research)

**File**: `server/supervisor/research-provider.ts`  
**Active**: Deep research missions only (`mission_type: "deep_research"`)  
**Three provider implementations, each with different models**:

| Provider | Model | API |
|---|---|---|
| `OpenAIResponsesProvider` | `gpt-4.1` (default) | OpenAI Responses API (`/v1/responses`) with `web_search` tool |
| `PerplexityProvider` | `llama-3.1-sonar-large-128k-online` (default) | Perplexity AI |
| `AnthropicProvider` | `claude-sonnet-4-20250514` (default) | Anthropic Messages API |

**System prompt** (verbatim, stored as `RESEARCH_SYSTEM_PROMPT`, shared across all three):

```
You are a professional research analyst producing comprehensive reports. Write in Markdown. Use headings (##, ###), bullet points, and tables where appropriate. Include specific facts, figures, names, and dates wherever possible. Cite your sources inline using [Source Title](url) notation when available. Structure: start with a brief executive summary, then detailed sections, end with key takeaways. Be thorough — aim for 1500-3000 words of substantive content.
```

**User prompt template**:
- With custom prompt: `Research topic: ${topic}\n\nSpecific instructions: ${prompt}`
- Without custom prompt: `Produce a comprehensive, well-structured research report on the following topic:\n\n${topic}`

---

### 5i. Task Interpreter (Autonomous Agent)

**File**: `server/services/task-interpreter.ts`  
**Model**: `claude-3-5-sonnet-20241022` — `temperature: 0`, `max_tokens: 1024`  
**Active**: Autonomous agent path only (not the main chat path)

**Prompt** (fully assembled at call time, no separate system/user split — sent as single user message):

```
You are a task interpreter. Convert the following natural language task into a structured tool call.

${toolSection}    ← dynamic, built by buildToolPromptSection() from server/supervisor/tool-registry.ts

TASK TO INTERPRET:
Title: ${task.title}
Description: ${task.description}
Priority: ${task.priority}
[Reasoning: ${task.reasoning}]    ← only if present

INSTRUCTIONS:
1. Analyze the task description and determine which ENABLED tool best fits the intent
2. NEVER select a DISABLED tool — if you do, the system will reject the call
3. Extract relevant parameters from the description
4. Respond with ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "tool": "tool_name",
  "params": {
    "param1": "value1",
    "param2": "value2"
  }
}

RESPONSE (JSON only):
```

**Output**: `{ tool: string; params: Record<string, any> }` — validated against tool registry

---

## 6. Summary Table

| Judge / Component | LLM? | Model(s) | Prompt Location | In Verdict Pipeline? |
|---|---|---|---|---|
| Tower judge-artefact | **No** (external HTTP) | Unknown — in Tower service | External | **Yes — primary judge** |
| Tower evaluate (step) | **No** (external HTTP) | Unknown — in Tower service | External | Yes (legacy plan-executor) |
| Semantic Evidence Judge | **No** (external HTTP) | Unknown — in Tower service | External | **Yes — per-lead verification** |
| Behaviour Judge (QA layer) | **No** (deterministic) | N/A | `qaLayerSummary.ts` | Yes (benchmark only) |
| Goal Parser | **Yes** | gpt-4o-mini / claude-3-5-haiku-20241022 | `goal-to-constraints.ts` | Yes — pre-execution |
| Location Validity Checker | **Yes** | gpt-4o-mini / claude-3-5-haiku-20241022 | `clarify-gate.ts` | Yes — gate routing |
| Intent Extractor | **Yes** | gpt-4o-mini / claude-3-5-haiku-20241022 | `intent-extractor.ts` | Yes — constraint gate |
| Mission Extractor Pass 1 | **Yes** | gpt-4o-mini / claude-3-5-haiku-20241022 | `mission-extractor.ts` | Yes — mission path |
| Mission Extractor Pass 2 | **Yes** | gpt-4o-mini / claude-3-5-haiku-20241022 | `mission-extractor.ts` | Yes — mission path |
| Explain Run | **Yes** | gpt-4o-mini / claude-3-5-haiku-20241022 | `explain-run.ts` | No (dev diagnostic only) |
| Run Narrative | **Yes** | gpt-4o-mini / claude-3-5-haiku-20241022 | `run-narrative.ts` | No (factory demo only) |
| Research Provider | **Yes** | gpt-4.1 / llama-sonar-large / claude-sonnet-4 | `research-provider.ts` | No (deep research only) |
| Task Interpreter | **Yes** | claude-3-5-sonnet-20241022 | `task-interpreter.ts` | No (autonomous agent only) |

---

*Key files: `server/supervisor/tower-artefact-judge.ts`, `server/supervisor/tower-judgement.ts`, `server/supervisor/tower-semantic-verify.ts`, `server/evaluator/qaLayerSummary.ts`, `server/supervisor/goal-to-constraints.ts`, `server/supervisor/clarify-gate.ts`, `server/supervisor/intent-extractor.ts`, `server/supervisor/mission-extractor.ts`, `server/supervisor/explain-run.ts`, `server/supervisor/run-narrative.ts`, `server/supervisor/research-provider.ts`, `server/services/task-interpreter.ts`*
