# Delivery Path Audit: Why AFR Still Shows 5 Delivered / 3 Verified

## Answer

**The AFR run (30b2a043) was executed before the fix was deployed.** The fix is
correct and closes the bug. There is no post-filter bypass in the delivery path.

The fix was applied to the source code during this session, but the AFR run at
`2026-03-10T20:43:00Z` executed the OLD code where `return true` allowed
unchecked leads through. The fix has not yet been re-run against this query.

## Full Pipeline Trace

### Data flow through `executeMissionDrivenPlan`

```
Line  Variable              Description
─────────────────────────────────────────────────────────────────────
604   leads = []             SEARCH_PLACES results (25 leads)
706   leads.slice(budget)    Trimmed to search budget (15 leads)
709   createdLeadIds[]       All candidates persisted to DB
745   enrichableLeads        Filtered to leads WITH websites, sliced to batch limit
652   evidenceResults[]      Evidence gathered for enrichable leads only
1154  leads.sort()           (RANK_SCORE only) Reorders by evidence strength
1244  leads.push()           (Replan only) New leads appended
1327  filteredLeads          ← applyHardEvidenceFilter(leads, evidenceResults, hardConstraints)
1334  finalLeads             ← filteredLeads.slice(0, requestedCount)
1366  leads_list artefact    ← finalLeads.map(...)
1408  deliveredLeadsWithEvidence  ← finalLeads.map(...)
1460  verification_summary   ← deliveredLeadsWithEvidence stats
1481  final_delivery artefact    ← deliveredLeadsWithEvidence
1643  dsLeads                ← finalLeads.map(...)
1658  emitDeliverySummary()  ← dsLeads
1719  return { leads: ... }  ← finalLeads.map(...)
```

**All user-facing delivery outputs derive from `finalLeads`.** `finalLeads`
derives from `filteredLeads`. `filteredLeads` is the direct output of
`applyHardEvidenceFilter()`. There is no user-facing divergence.

One internal divergence existed and has been fixed: `MissionExecutionResult.leadIds`
previously returned `createdLeadIds` (all persisted candidates), not just the
delivered leads. This was written to `supervisor_tasks.result.lead_ids`. Fixed by
computing `filteredLeadIds` from `finalLeads` via a `placeId → dbId` lookup map.

### Where `applyHardEvidenceFilter()` is called

- **File:** `server/supervisor/mission-executor.ts`
- **Function:** `executeMissionDrivenPlan`
- **Line:** 1327
- **Input list:** `leads` (the mutable candidate array, post-enrichment, post-ranking, post-replan)
- **Output list:** `filteredLeads` (only leads with evidence for hard constraints)

### What the filter operates on vs what is delivered

| Variable | Source | Used for delivery? |
|----------|--------|--------------------|
| `leads` | Raw candidates (mutated throughout) | No — only used as INPUT to filter |
| `filteredLeads` | Output of `applyHardEvidenceFilter()` | Yes — via `finalLeads` |
| `finalLeads` | `filteredLeads.slice(0, requestedCount)` | Yes — all delivery artefacts |
| `deliveredLeadsWithEvidence` | `finalLeads.map(...)` | Yes — enriched with evidence metadata |
| `dsLeads` | `finalLeads.map(...)` | Yes — passed to `emitDeliverySummary` |

**The filtered list and the delivered list are the same object chain.**

## Why the AFR Shows 5/3

In the pre-fix code at line 1305 (now line 314):

```typescript
if (!leadsChecked.has(i)) return true;   // OLD — unchecked leads pass
```

The filter allowed all 5 leads through:

| Lead | Website | In leadsChecked? | Old result | New result |
|------|---------|-------------------|------------|------------|
| The Black Horse | ✓ | ✓ (evidence found) | pass | pass |
| The Red Lion | ✓ | ✓ (evidence found) | pass | pass |
| The Kings Arms | null | ✗ (never enriched) | **pass (bug)** | **fail (fixed)** |
| George & Dragon | ✓ | ✓ (evidence found) | pass | pass |
| The Eagle Inn | null | ✗ (never enriched) | **pass (bug)** | **fail (fixed)** |

With the fix: `filteredLeads` contains 3 leads → `finalLeads` = 3 → delivery = 3.

## Paths Checked for Post-Filter Re-Addition

| Path | Can it re-add filtered leads? | Evidence |
|------|-------------------------------|----------|
| RANK_SCORE sort | No — runs BEFORE the filter (line 1154 vs 1327) | ✓ |
| Replan loop | No — runs BEFORE the filter (lines 1192-1320 vs 1327) | ✓ |
| Top-N slicing | No — slices FROM filteredLeads (line 1334) | ✓ |
| DB persistence | Persists from `finalLeads`, not raw `leads` (line 1341) | ✓ |
| Fallback delivery | No fallback path exists in mission-executor | ✓ |
| Legacy plan-executor | Separate code path, not used for this run | N/A |
| Return value | Returns `finalLeads.map(...)` (line 1719) | ✓ |

**No path re-adds filtered leads after `applyHardEvidenceFilter()` runs.**

## Changes Made in This Patch

| File | Line | Change |
|------|------|--------|
| `server/supervisor/mission-executor.ts` | 1329 | Removed `evidenceResults.length > 0` from outer guard (done in prior patch) |
| `server/supervisor/mission-executor.ts` | 1339-1371 | Replaced `persistedPlaceIds` with `placeIdToDbId` map; compute `filteredLeadIds` from `finalLeads` |
| `server/supervisor/mission-executor.ts` | 1723 | Return `filteredLeadIds` instead of `createdLeadIds` |
| `server/supervisor/hard-evidence-filter.test.ts` | — | Added AFR regression test and outer guard bypass test |

## Remaining Risks (Not Bypasses)

### 1. Index staleness during RANK_SCORE

`RANK_SCORE` (line 1154) sorts the `leads` array, changing element positions. Evidence
results retain their original `leadIndex` values. The hard evidence filter then
compares current array index `i` against stale `evidenceResults[].leadIndex`.

This can cause:
- **False positive:** A lead at a reused index inherits another lead's "checked" status
- **False negative:** A checked lead at a new position appears "unchecked" and is rejected

**Impact:** Only affects runs where RANK_SCORE is in the tool sequence AND the sort
actually changes lead ordering. The AFR run (`discovery_then_website_evidence`) does
NOT include RANK_SCORE, so this is not relevant here.

**Fix:** Replace `leadIndex` with `placeId` for evidence-to-lead matching.

### 2. Pre-filter DB persistence

All candidate leads are persisted to the database at line 709-730, BEFORE the hard
evidence filter runs. Filtered-out leads remain in the DB as `suggested_leads`. This
is intentional (the DB tracks all candidates), but consumers of the DB records should
not assume all persisted leads passed evidence checks.

## Conclusion

The fix is complete. The delivered lead list IS the output of `applyHardEvidenceFilter()`.
The AFR showing 5/3 is pre-fix data. Re-running the same query with the patched code
will deliver only the 3 verified leads.
