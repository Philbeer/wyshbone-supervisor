# Bugfix: Unchecked-Lead Pass-Through in Hard Evidence Filter

## Root Cause

In `server/supervisor/mission-executor.ts`, the hard evidence filtering step ran after
website/evidence enrichment. When leads were never checked (e.g. no website to scrape,
or outside the batch enrichment limit), the filter returned `true` for those leads:

```typescript
if (!leadsChecked.has(i)) return true;   // BUG
```

This allowed leads with no evidence verification to pass through the hard evidence
filter, defeating the purpose of requiring hard evidence (e.g. `website_evidence`
constraints with `hardness: "hard"`).

## Exact Fix

**File:** `server/supervisor/mission-executor.ts`

1. Extracted the inline hard evidence filtering logic into an exported function
   `applyHardEvidenceFilter()` (lines 300–317).
2. Changed the unchecked-lead guard from `return true` to `return false`.
3. Updated the call site (line 1299) to use the extracted function.

The fix is a one-line semantic change. The extraction into a named function is solely
for testability.

Before:
```typescript
if (!leadsChecked.has(i)) return true;    // unchecked leads pass — wrong
```

After:
```typescript
if (!leadsChecked.has(i)) return false;   // unchecked leads fail — correct
```

## Test Added

**File:** `server/supervisor/hard-evidence-filter.test.ts`

Nine test cases covering:

| Test | Purpose |
|------|---------|
| removes leads never checked | Core regression — unchecked leads must not survive |
| keeps leads checked with evidence | Checked + evidence → kept |
| removes leads checked without evidence | Checked + no evidence → removed |
| regression: unchecked leads do not survive | Multi-lead scenario with batch limit simulation |
| multiple hard constraints | Lead passes if at least one hard constraint matches |
| all leads fail | Returns empty array when no evidence found |
| AFR regression (5 leads, 2 without website) | Exact reproduction of AFR run 30b2a043 |
| outer guard bypass (empty evidence array) | All leads rejected when no evidence gathered |
| empty evidence array with no constraints | Safe no-op when function shouldn't be called |

## Additional Fix: Outer Guard Bypass (found during AFR validation)

The original outer guard at the call site:

```typescript
if (hardEvidenceConstraints.length > 0 && evidenceResults.length > 0) {
```

skipped the filter entirely when `evidenceResults` was empty (e.g. all enrichment
failed). This meant hard constraints were silently ignored. Fixed by removing the
`evidenceResults.length > 0` condition. See `SUPERVISOR_EVIDENCE_FILTER_RUNTIME_AUDIT.md`
for the full trace.

## Edge Cases Still Remaining

1. **OR semantics across constraints:** The current matching logic
   (`hardEvidenceConstraints.some(...)`) uses OR across multiple hard constraints.
   A lead with evidence for *any one* hard constraint passes the filter, even if
   it lacks evidence for others. This is inherited behaviour and not changed here.

2. **Field/value matching ambiguity:** The evidence→constraint matching uses
   `c.field === er.constraintField || String(c.value) === er.constraintValue`,
   which can produce false positives when unrelated constraints share the same
   value string. Not addressed in this minimal fix.

3. **Index staleness during replanning:** If replanning changes the leads array,
   old evidence entries retain stale `leadIndex` values. Should use `placeId`
   instead of array index for evidence tracking. Not addressed in this patch.
