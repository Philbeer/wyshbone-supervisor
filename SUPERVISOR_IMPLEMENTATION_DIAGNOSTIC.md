# Supervisor Implementation Diagnostic Report

Honest snapshot of what the system actually does today. No idealisation.

---

## 1. Input Handling

### What the UI sends
Two entry paths:

1. **Chat-based (primary)**: `supervisor_tasks` row with a raw natural language string (e.g. "Find 5 pubs in Arundel that mention live music on their website"). No structured fields from the UI — entity type, location, constraints are all extracted server-side.

2. **Plan-based (legacy)**: `POST /api/plan/start` with `{ rawGoal, targetRegion, targetPersona, volume, preferredChannels }`. This path still exists but is secondary; most traffic uses the chat supervisor path.

### How intent is parsed
Two-pass LLM pipeline in `mission-extractor.ts`:

**Pass 1** — Semantic interpretation. An LLM strips surface phrasing and restates meaning. Outputs:
- `constraint_checklist`: 13 boolean flags (`has_entity`, `has_location`, `has_website_evidence`, `has_attribute_check`, `has_relationship_check`, etc.)
- `semantic_interpretation`: Clean English restatement
- `mission_mode`: `research_now | monitor | alert_on_change | recurring_check`

**Implicit Expansion** — Deterministic (no LLM) layer adds inferred constraints from phrasing patterns. E.g. "on their website" reinforces `website_evidence`, "best" infers ranking signals. Inferred constraints default to `soft`.

**Pass 2** — Structured mapping. A second LLM call maps the Pass 1 output to a strict JSON schema: `entity_category`, `location_text`, `requested_count`, and a typed `constraints[]` array.

### Weaknesses in input handling
- **Two LLM calls** means two chances for hallucination or dropped concepts. A `mission-completeness-check.ts` module tries to catch dropped concepts but it is itself LLM-based.
- **Hardness classification is LLM-decided**. Whether a constraint is `hard` or `soft` depends on the LLM interpreting hedging language ("must" vs "preferably"). No deterministic override exists.
- **No user confirmation step**. The extracted mission is never shown back to the user for validation before execution begins.

---

## 2. Constraint Construction

### Types and schema
Constraints are Zod-validated objects (`MissionConstraintSchema` in `mission-schema.ts`):

```typescript
{
  type: 'website_evidence' | 'text_compare' | 'relationship_check' | 
        'attribute_check' | 'location_constraint' | 'numeric_range' | 
        'contact_extraction' | 'entity_discovery' | 'time_constraint' | 
        'status_check' | 'ranking',
  field: string,       // e.g. 'website_text', 'name', 'rating'
  operator: string,    // e.g. 'contains', 'mentions', 'gte', 'has'
  value: string | number | boolean | null,
  value_secondary?: string | number | null,  // for 'between' ranges
  hardness: 'hard' | 'soft',
}
```

### What constraints carry
- **Type**: Yes — one of 11 enumerated types
- **Hard/soft status**: Yes — `hardness: 'hard' | 'soft'`
- **`evidence_requirement`**: **NO.** Does not exist. There is no field specifying what kind of evidence is needed (website_text, directory_data, lead_field, external_source, none). The system infers evidence strategy from `type` alone via the mission planner's rule mapping.
- **`source_tier`**: **NO.** Constraints carry no indication of acceptable evidence sources or trust levels.

### How the planner maps constraints to execution
`mission-planner.ts` uses deterministic rules:

| Constraint type | Rule fired | Tool sequence |
|---|---|---|
| (none — discovery only) | RULE_DISCOVERY | SEARCH_PLACES |
| `text_compare`, `numeric_range` | RULE_DIRECT_FIELD_CHECK | SEARCH_PLACES → FILTER_FIELDS |
| `website_evidence`, `attribute_check`, `status_check` | RULE_WEBSITE_EVIDENCE | SEARCH_PLACES → WEB_VISIT → EVIDENCE_EXTRACT → TOWER_JUDGE |
| `relationship_check` | RULE_RELATIONSHIP_EXTERNAL | SEARCH_PLACES → WEB_SEARCH → WEB_VISIT → EVIDENCE_EXTRACT → TOWER_JUDGE |

### Weaknesses in constraint construction
- **Evidence requirement is implicit, not declared.** A `website_evidence` constraint implies "check the website" but this is a planner convention, not a constraint property. Nothing stops a future code path from satisfying a `website_evidence` constraint with directory data.
- **No source trust levels on constraints.** The constraint doesn't say "I need first-party website evidence" — the planner just happens to route `website_evidence` through WEB_VISIT.
- **Hardness is one-dimensional.** There's no distinction between "hard requirement for filtering" and "hard requirement for evidence quality". A `hard` `website_evidence` constraint means the lead must have *some* evidence found, but the evidence quality threshold is a separate, disconnected mechanism.

---

## 3. Search and Lead Gathering

### How search executes
1. `SEARCH_PLACES` calls Google Places Text Search via `google-places.ts`
2. Parameters: `query` (entity category), `location` (location text), `country`, `maxResults` (from search budget, often inflated by candidate pool strategy to `requested_count × 3`, capped at 30)
3. Fetches up to 3 pages of results (60 leads max)
4. For each result, makes a concurrent Place Details call to get `website` and `phone` (often missing from the initial search)
5. Results come back as `PlaceResult[]` with `name`, `address`, `placeId`, `website`, `phone`, `rating`, `userRatingsTotal`, `lat`, `lng`

### How the system decides a lead is worth passing on
**No quality gate at discovery time.** Every lead returned by Google Places is kept. The only filtering happens downstream:

1. **FILTER_FIELDS** (if plan includes it): Checks lead name/address against `text_compare` constraints. Hard filters (contains, starts_with, equals) can discard leads.
2. **Evidence gathering**: WEB_VISIT/WEB_SEARCH phase collects evidence per lead per constraint. Leads without websites get no evidence.
3. **Hard evidence filter** (`applyHardEvidenceFilter`): Removes leads that were never checked or had no evidence found for hard constraints.
4. **Count trim**: Final leads capped to `requestedCount`.

### Weaknesses in lead gathering
- **Single source (Google Places).** No fallback to other directories, databases, or web scrapers if Google returns sparse results.
- **No quality scoring at discovery.** A pub with 2 reviews and no website is treated identically to a pub with 500 reviews and a full website until the evidence phase.
- **Candidate pool inflation is blunt.** `requested_count × 3` is a fixed multiplier. If most candidates in an area won't have websites, a 3× pool may still be too small.

---

## 4. Hard Evidence Filter

### What it does
`applyHardEvidenceFilter()` in `mission-executor.ts` (line 297):

```typescript
function applyHardEvidenceFilter<T>(
  leads: T[],
  evidenceResults: HardEvidenceFilterInput[],
  hardEvidenceConstraints: HardEvidenceConstraintRef[],
): T[] {
  // Build set of lead indices with positive evidence for hard constraints
  const leadsWithEvidence = new Set<number>();
  for (const er of evidenceResults) {
    if (er.evidenceFound && hardEvidenceConstraints.some(c => 
      c.field === er.constraintField || String(c.value) === er.constraintValue
    )) {
      leadsWithEvidence.add(er.leadIndex);
    }
  }
  // Build set of lead indices that were checked at all
  const leadsChecked = new Set(evidenceResults.map(r => r.leadIndex));
  // Keep only leads that were both checked AND had evidence
  return leads.filter((_, i) => {
    if (!leadsChecked.has(i)) return false;  // unchecked → discard
    return leadsWithEvidence.has(i);          // no evidence → discard
  });
}
```

### Can an unchecked lead survive it?
**No.** Fixed in the previous bugfix session. Previously `return true` for unchecked leads; now `return false`.

### Can the filter be bypassed entirely?
**No.** Fixed in the previous bugfix session. The outer guard previously required `evidenceResults.length > 0` (meaning if zero leads were enriched, the filter never ran). Now it runs whenever hard evidence constraints exist, regardless of evidence results count.

### Weaknesses in the hard evidence filter
- **Index-based matching.** Evidence is linked to leads by array index (`leadIndex`). If any operation reorders the `leads` array between evidence collection and filtering (e.g., RANK_SCORE), indices go stale and evidence maps to the wrong lead. This doesn't affect `discovery_then_website_evidence` (no RANK_SCORE in sequence) but would break `discovery_then_rank` or mixed strategies.
- **Binary evidence check.** The filter asks "was evidence found?" (yes/no). It does not check evidence *strength*. A `weak_match` from Tower passes the hard evidence filter identically to a `verified` result. The quality distinction only happens later in delivery classification.
- **Constraint matching is loose.** Matching is `c.field === er.constraintField || String(c.value) === er.constraintValue`. The `||` means if any evidence result has a matching *value* string (even for a different field), it counts. This is fragile — if two constraints share the same value string, evidence for one could satisfy the other.

---

## 5. What Tower Receives

### Tower endpoint 1: `POST /api/tower/judge-artefact`
Used for step-level observations and the single authoritative final verdict.

**Payload structure:**
```typescript
{
  runId: string,
  artefactId: string,          // UUID of the artefact being judged
  goal: string,                // normalised natural language goal
  successCriteria: {
    mission_type: 'leadgen',
    target_count: number,
    requested_count_user: 'explicit' | 'implicit',
    requested_count_value: number | null,
    hard_constraints: string[],   // ← FLAT STRING LABELS like ['website_evidence', 'name_contains']
    soft_constraints: string[],   // ← FLAT STRING LABELS like ['ranking']
    plan_constraints: {
      business_type: string,
      location: string,
      country: string,
      search_count: number,
      requested_count: number,
    },
    requires_relationship_evidence: boolean,
    verification_policy: string,
    verification_policy_reason: string,
  },
  artefactType: string,
}
```

**What Tower does NOT receive in `successCriteria`:**
- No typed constraint objects (type/field/operator/value/hardness)
- No `evidence_requirement` per constraint
- No `source_tier` per constraint
- No per-lead evidence chain
- `hard_constraints` is an array of **label strings** like `['website_evidence']`, built by `buildHardConstraintLabels()` which does `c.type` for most types, `name_${operator}` for text_compare, `${field}_${operator}` for numeric_range

### Tower endpoint 2: `POST /api/tower/semantic-verify`
Used per-lead, per-constraint for evidence quality assessment.

**Payload structure:**
```typescript
{
  run_id: string,
  original_user_goal: string,
  lead_name: string,
  lead_place_id: string,
  constraint_to_check: string,      // ← FLAT STRING, just the constraint value
  source_url: string,
  evidence_text: string,             // truncated to 5000 chars
  extracted_quotes: string[],
  page_title: string | null,
}
```

**What Tower does NOT receive in semantic verify:**
- No constraint type, operator, or hardness
- No source classification (first-party website vs search snippet vs directory)
- `constraint_to_check` is just the raw value string (e.g. "live music"), not a typed object
- No indication of what evidence quality threshold is expected

### Weaknesses in Tower communication
- **Flat string constraints.** Tower gets `["website_evidence"]` not `[{type: "website_evidence", field: "website_text", operator: "mentions", value: "live music", hardness: "hard", evidence_requirement: "first_party_website"}]`. Tower cannot make evidence-quality-aware judgements because it doesn't know what quality is required.
- **No source provenance to Tower.** Tower semantic-verify receives `source_url` and `evidence_text` but no classification of whether this is a first-party website, a directory listing, or a search snippet. Tower cannot weight trust appropriately.
- **`constraint_to_check` is ambiguous.** For "pubs that mention live music on their website", Tower receives `constraint_to_check: "live music"`. It doesn't know this should be found specifically on the lead's own website vs. any source.

---

## 6. Evidence Provenance

### Evidence item types
Two levels:

**`EvidenceItem`** (from `constraint-led-extractor.ts`): Raw extraction output.
- `source_url`, `page_title`
- `source_type`: `'website' | 'search_snippet' | 'gov_page' | 'social_media' | 'directory' | 'unknown'`
- `confidence_score` (0-1 numeric)
- `matched_phrase`, `direct_quote`, `context_snippet`
- `constraint_type`, `constraint_value`

**`EvidenceResult`** (from `mission-executor.ts`): Aggregated per-lead per-constraint.
- `evidenceStrength`: `'strong' | 'weak' | 'none'`
- `towerStatus`: `'verified' | 'weak_match' | 'no_evidence' | 'insufficient_evidence' | null`
- `towerConfidence`: `number`
- `sourceUrl`: `string | null`
- `snippets`: `string[]`
- Does NOT carry `source_type` or `source_tier`

### How `evidenceStrength` is computed
```typescript
const evidenceStrength: 'strong' | 'weak' | 'none' =
  towerStatus === 'verified' ? 'strong' :
  towerStatus === 'weak_match' || keywordFound ? 'weak' :
  'none';
```

This is the complete logic. `strong` requires Tower to return `verified`. `weak` covers both Tower `weak_match` AND keyword-only matches (no Tower call). `none` means no evidence found at all.

### Do evidence items carry `source_tier`?
**No.** The `EvidenceItem` has `source_type` (website/search_snippet/gov_page/social_media/directory/unknown), which is populated by `classifySourceType(url)` based on URL patterns. But this is used only for confidence multipliers during extraction scoring. It is NOT propagated to `EvidenceResult`, NOT sent to Tower, NOT used in delivery classification, and NOT stored in the final artefact in a way that influences exact/closest decisions.

### Confidence multipliers exist but are local
`constraint-led-extractor.ts` applies `SOURCE_CONFIDENCE_MULTIPLIERS`:
- website: 1.0
- gov_page: 1.15
- search_snippet: 0.35
- social_media: 0.5
- directory: 0.45

These affect the internal `confidence_score` of `EvidenceItem`, but this score does not flow into the final `evidenceStrength` field. Strength is determined solely by Tower status.

### Weaknesses in evidence provenance
- **Source classification exists but is dead-end.** `source_type` is computed but not carried through to where decisions are made. The hard evidence filter doesn't check it. Delivery classification doesn't check it. Tower doesn't receive it.
- **No `source_tier` concept.** There is no field distinguishing "first-party website text" from "search snippet about the lead" from "directory listing field". All website evidence is treated equally.
- **Confidence multipliers are disconnected.** The extraction engine applies source-aware scoring, but the final evidence assessment collapses everything to Tower's `verified`/`weak_match` binary.

---

## 7. Final Status Logic

### `agent_runs.status` (database)
Always set to `'completed'` if the execution function reaches its end without crash/timeout. Set to `'timed_out'` on deadline exceeded. This reflects *technical* completion, not result quality.

### `deriveCanonicalStatus` (delivery summary)
```typescript
function deriveCanonicalStatus(
  verifiedExact: number,
  requested: number | null,
  towerVerdict: string | null,
  hasHardUnverifiable: boolean,
  deliveredTotal?: number,
): CanonicalVerdict {
  const totalDelivered = deliveredTotal ?? 0;
  if (towerVerdict === 'ERROR' && totalDelivered === 0) return 'ERROR';
  if (totalDelivered > 0) return 'COMPLETED';   // ← THIS LINE
  if (hasHardUnverifiable) return 'STOP';
  return 'STOP';
}
```

**Critical: `verifiedExact` is not used.** The function receives it as a parameter but never checks it. If ANY leads are delivered (even all in `delivered_closest`), status is `COMPLETED`.

### Can a run that failed hard constraints show as COMPLETED?
**Yes.** If a run delivers 5 leads, all with `match_valid: false` and all in `delivered_closest` with `weak_or_missing_evidence` violations, `deriveCanonicalStatus` still returns `COMPLETED` because `totalDelivered = 5 > 0`.

### Trust status
```typescript
const trustStatus = (status === 'PASS' || status === 'PARTIAL' || status === 'COMPLETED') ? 'TRUSTED' : 'UNTRUSTED';
```
Since status is almost always `COMPLETED`, trust status is almost always `TRUSTED`.

### Tower verdict influence
Tower's `STOP`/`FAIL` verdict on the final delivery artefact is captured and stored, but `deriveCanonicalStatus` ignores it when leads exist. The tower verdict string is normalised by `normalizeTowerVerdict()` but the `totalDelivered > 0` check fires first, returning `COMPLETED` before Tower verdict is evaluated.

### Weaknesses in status logic
- **`deriveCanonicalStatus` ignores `verifiedExact`.** It's a dead parameter. The function could return `PARTIAL` when `verifiedExact < requested` but it doesn't — it returns `COMPLETED` unconditionally when any leads exist.
- **Tower verdict is overridden.** Even if Tower says `STOP` (meaning "these results don't meet the goal"), the canonical status is still `COMPLETED` as long as leads were found. Tower's verdict has no teeth in the status derivation.
- **`TRUSTED` is meaningless.** Since it's derived from `COMPLETED` and `COMPLETED` is granted whenever leads exist, `TRUSTED` conveys no information about evidence quality or constraint satisfaction.
- **No `PARTIAL` status in practice.** The type includes `'PARTIAL'` but no code path ever returns it.

---

## 8. Summary of Known Weaknesses

### Structural gaps (things that don't exist)
1. **No `evidence_requirement` on constraints.** The system cannot distinguish "I need website text evidence" from "I need directory field evidence" from "no evidence needed" at the constraint level.
2. **No `source_tier` on evidence or constraints.** No way to enforce "this evidence must come from a first-party website, not a search snippet."
3. **No typed constraints to Tower.** Tower gets flat string labels, not structured constraint objects with evidence requirements and trust tiers.
4. **No `PARTIAL` status derivation.** The code type allows it but no path produces it.

### Logical weaknesses (things that exist but are flawed)
5. **`deriveCanonicalStatus` ignores `verifiedExact`.** It always returns `COMPLETED` when leads exist, even with zero exact matches.
6. **Tower verdict has no authority over status.** `STOP` from Tower is overridden by "leads found."
7. **Evidence strength is binary-then-disconnected.** The extraction engine computes nuanced confidence scores with source-aware multipliers, then collapses everything to Tower's `verified`/`weak_match` decision, and Tower currently returns `weak_match` for most real-world evidence.
8. **Hard evidence filter is strength-blind.** It checks `evidenceFound` (boolean) but not `evidenceStrength`. A `weak_match` passes the hard filter identically to `verified`.
9. **Index-based evidence tracking.** Evidence is linked to leads by array index, which can go stale if the array is reordered.
10. **Constraint matching in hard filter uses `||`.** `c.field === er.constraintField || String(c.value) === er.constraintValue` means shared value strings can cross-satisfy unrelated constraints.

### Assumptions being made
11. **Tower will return `verified` for genuine evidence.** In practice, Tower returns `weak_match` for most real website evidence (as seen in the Arundel pubs AFR). The entire `strong` evidence path depends on Tower being more decisive than it currently is.
12. **Google Places returns comprehensive results.** No fallback if Google Places has sparse coverage for a niche query.
13. **Hardness can be reliably determined by LLM from phrasing.** No user confirmation or override mechanism.
14. **Candidate pool inflation of 3× is sufficient.** Fixed multiplier, not adapted to expected attrition rate for the specific constraint type.

---

*Generated from codebase state at checkpoint `b4c6682`. All line numbers reference current HEAD.*
