# Runtime Audit: Hard Evidence Filter — AFR Validation

## AFR Run Under Analysis

- **Run ID:** `30b2a043-2142-446b-9aed-a726834f2754`
- **Query:** "Find 5 pubs in Arundel that mention live music on their website"
- **Strategy:** `discovery_then_website_evidence`
- **Tool sequence:** `SEARCH_PLACES → WEB_VISIT → EVIDENCE_EXTRACT → TOWER_JUDGE`
- **Outcome:** 5 leads delivered, only 3 carry verification data, Tower verdict: **fail**

## Delivered Leads (from AFR)

| # | Name | Website | Evidence | verification_status |
|---|------|---------|----------|---------------------|
| 1 | The Black Horse | https://theblackhorsebinsted.com/ | 1 item (weak_match) | weak_match |
| 2 | The Red Lion | https://www.redlionarundel.com/ | 1 item (weak_match) | weak_match |
| 3 | **The Kings Arms** | **null** | **[]** | **no_evidence** |
| 4 | George & Dragon | https://www.georgeanddragonhoughton.co.uk/ | 1 item (weak_match) | weak_match |
| 5 | **The Eagle Inn** | **null** | **[]** | **no_evidence** |

Leads 3 and 5 have no website, were never enriched, and have zero evidence. They should not have been delivered for a hard `website_evidence` constraint.

## Root Cause Analysis

Two bugs combined to allow unchecked leads through:

### Bug 1 (fixed previously): Unchecked-lead pass-through in `applyHardEvidenceFilter`

**File:** `server/supervisor/mission-executor.ts` line 314 (now fixed)

The filter function returned `true` for leads not present in `leadsChecked`:

```typescript
if (!leadsChecked.has(i)) return true;   // OLD — unchecked leads pass
```

**Fix applied:** Changed to `return false`.

### Bug 2 (found in this audit): Outer guard skips filter entirely when evidenceResults is empty

**File:** `server/supervisor/mission-executor.ts` line 1326 (was)

```typescript
if (hardEvidenceConstraints.length > 0 && evidenceResults.length > 0) {
```

The `evidenceResults.length > 0` check means: if ALL enrichment fails (every website
unreachable, no web search in tool sequence), the filter is completely bypassed and
all leads pass through — even for hard `website_evidence` constraints.

**Bypass scenario:**
1. Plan has `WEB_VISIT` but not `WEB_SEARCH` (like this AFR run)
2. Every lead's website is unreachable (DNS failure, timeout, etc.)
3. No text_compare constraints exist to create fallback evidence entries
4. `evidenceResults` array stays empty
5. Guard evaluates to `false`, filter never runs
6. All leads pass through unfiltered

**Fix applied:** Removed the `evidenceResults.length > 0` guard:

```typescript
if (hardEvidenceConstraints.length > 0) {
```

Now `applyHardEvidenceFilter` always runs when hard evidence constraints exist.
When `evidenceResults` is empty, `leadsChecked` is an empty set, and every lead
fails `!leadsChecked.has(i) → return false`. Result: 0 leads delivered, which is
correct for hard constraints with no evidence.

## Tracing the Full Pipeline for This AFR Run

```
25 leads from SEARCH_PLACES
  → no FILTER_FIELDS (no text_compare constraints)
  → trimmed to search budget (15 leads)
  → persisted to DB
  → enrichableLeads filter:
      requiresWebSearch = false (WEB_SEARCH not in tool sequence)
      requiresWebVisit = true
      → filter: (false || (true && l.website))
      → only leads WITH a website URL enter enrichment
      → Kings Arms (website: null) and Eagle Inn (website: null) excluded
  → effectiveEnrichBatch = 15 (pool strategy: 15 ×3)
  → evidence gathering runs for leads with websites
  → evidenceResults populated with 15 entries for enriched leads
  → hard evidence filter (line 1326):
      hardEvidenceConstraints.length = 1 (website_evidence, hard)
      evidenceResults.length = 15 > 0 → guard passes
      BUT: with old code, Kings Arms and Eagle Inn at indices not in
           leadsChecked → return true → they pass through
      WITH FIX: return false → they are correctly filtered out
```

## Is the Bug Truly Fixed?

**Yes, for the primary case.** The `return false` fix in `applyHardEvidenceFilter`
directly fixes the AFR scenario. Kings Arms and Eagle Inn (indices not in
`leadsChecked`) would now be rejected.

**The secondary bypass (outer guard) is also now fixed.** Removing the
`evidenceResults.length > 0` condition ensures the filter runs even when all
enrichment fails.

## All Delivery Paths Checked

| Path | Goes through hard evidence filter? | Status |
|------|------------------------------------|----|
| Normal execution (evidence gathered) | Yes | Fixed (Bug 1) |
| All enrichment fails (evidenceResults empty) | Now yes (was skipped) | Fixed (Bug 2) |
| Ranking-only strategy | No hard evidence constraints exist | N/A — correct |
| Field-filter-only strategy | No hard evidence constraints exist | N/A — correct |
| Replan with lead list rebuild | Yes, but indices may be stale | Known limitation (see below) |
| Deadline exceeded (evidence phase skipped) | Now yes (was skipped) | Fixed (Bug 2) |

## Remaining Edge Cases

### 1. Index staleness during replanning

During replanning, leads are merged and re-filtered. Old evidence entries retain
their original `leadIndex` values. If the leads array changes (leads removed or
reordered during replan), old indices become stale. This can cause:
- False positives: a new lead at an old index inherits "checked" status
- False negatives: an old lead at a new index appears "unchecked"

**Severity:** Medium. Replanning is uncommon for simple queries but can occur
for complex ones. The false-negative case is fail-safe (lead is rejected).
The false-positive case could incorrectly pass a lead.

**Fix:** Use `placeId` instead of array index for evidence tracking.
Not addressed in this minimal patch.

### 2. Total enrichment failure delivers 0 leads

With the outer guard fix, if all enrichment fails and no evidence is gathered,
ALL leads are filtered out and 0 leads are delivered. This is semantically
correct for hard constraints but may surprise users. The run would correctly
receive a Tower fail verdict.

### 3. Evidence strength not gated

A `weak_match` Tower status with `evidenceFound: true` passes the hard evidence
filter the same as a `verified` status. The filter does not distinguish evidence
quality — only presence. All 3 verified leads in this AFR had `weak_match` status.

## Changes Made in This Patch

| File | Change |
|------|--------|
| `server/supervisor/mission-executor.ts:1329` | Removed `evidenceResults.length > 0` from outer guard |
| `server/supervisor/hard-evidence-filter.test.ts` | Added AFR regression test (5 leads, 2 without website) |
| `server/supervisor/hard-evidence-filter.test.ts` | Added outer guard bypass test (empty evidence array) |
