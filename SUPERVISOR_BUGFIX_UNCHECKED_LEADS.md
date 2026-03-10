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

Seven test cases covering:

| Test | Purpose |
|------|---------|
| removes leads never checked | Core regression — unchecked leads must not survive |
| keeps leads checked with evidence | Checked + evidence → kept |
| removes leads checked without evidence | Checked + no evidence → removed |
| regression: unchecked leads do not survive | Multi-lead scenario with batch limit simulation |
| multiple hard constraints | Lead passes if at least one hard constraint matches |
| all leads fail | Returns empty array when no evidence found |
| empty evidence array | Edge case — no evidence gathered at all |

## Edge Cases Still Remaining

1. **Outer guard skips entire block when `evidenceResults.length === 0`:** If no
   evidence was gathered at all (e.g. enrichment step completely failed), the
   `if (hardEvidenceConstraints.length > 0 && evidenceResults.length > 0)` guard
   at the call site means the filter never runs and all leads pass through
   unfiltered. This is a separate design decision — fixing it here would risk
   dropping all leads on enrichment failures.

2. **OR semantics across constraints:** The current matching logic
   (`hardEvidenceConstraints.some(...)`) uses OR across multiple hard constraints.
   A lead with evidence for *any one* hard constraint passes the filter, even if
   it lacks evidence for others. This is inherited behaviour and not changed here.

3. **Field/value matching ambiguity:** The evidence→constraint matching uses
   `c.field === er.constraintField || String(c.value) === er.constraintValue`,
   which can produce false positives when unrelated constraints share the same
   value string. Not addressed in this minimal fix.
