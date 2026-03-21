# Agent Log — wyshbone-supervisor

Previous logs archived to AGENT_LOG_ARCHIVE_20260321.md

---

## Archive and reset log

**Date:** 2026-03-21

### What Changed

- `AGENT_LOG.md` → renamed to `AGENT_LOG_ARCHIVE_20260321.md` (preserves all prior session entries)
- `AGENT_LOG.md` → recreated fresh with header and archive reference only

### Decisions Made

- Archive filename includes the date so it is unambiguous if further archives are created later.
- The fresh log starts immediately with this summary entry so the format is consistent from the first commit.

### What's Next

- All future entries append to the new `AGENT_LOG.md`.

---

## Skip combined Tower call for single-loop PASS runs

**Date:** 2026-03-21

### What Changed

**File modified:** `server/supervisor/reloop/loop-skeleton.ts`

After the `combinedArtefact` is created, the code now reads `finalRawResult.towerVerdict` to determine whether the per-loop Tower already returned `'pass'`.

Two new variables:
- `perLoopTowerVerdict` — reads `(finalRawResult as any)?.towerVerdict ?? null`
- `skipCombinedTower` — `true` when `totalLoops === 1 && perLoopTowerVerdict === 'pass'`

When `skipCombinedTower` is true:
- The `judgeArtefact` call is not made
- `combinedTowerVerdict` is set to `'pass'` directly
- A `[RELOOP_SKELETON] Single loop with per-loop Tower PASS — skipping combined Tower call` log line is emitted

When `skipCombinedTower` is false (multi-loop runs, or single-loop where per-loop Tower did not pass):
- `judgeArtefact` is called as before — no change to that path

The `combinedArtefact` is always created regardless, so AFR and audit trails are unaffected.

### Problem

For single-loop runs, the combined delivery artefact is byte-for-byte identical to the per-loop delivery. Sending it to Tower a second time introduced a risk of a contradictory verdict — Tower would sometimes see `evidence_strength` metadata in a different context and reject results the per-loop Tower had already approved. This was an unnecessary second call with no new information.

### Decision

The skip condition is deliberately conservative: both guards must be true (`totalLoops === 1` AND `perLoopTowerVerdict === 'pass'`). Multi-loop runs always go through the combined Tower call — that is the exact scenario it was designed for (merging results from different executors needs a fresh judgement). Single-loop runs where the per-loop Tower did NOT pass also still call combined Tower, which gives it a chance to recover.

### What's Next

- Monitor `[RELOOP_SKELETON] Single loop with per-loop Tower PASS — skipping combined Tower call` log entries to confirm the path fires correctly on real runs.
- Consider whether the same logic should be applied to multi-loop runs where every per-loop Tower returned `'pass'` — currently not done to keep the change minimal.

---

## Lower hasSubstantialEvidence threshold to include keyword evidence

**Date:** 2026-03-21

### What Changed

**File modified:** `server/supervisor/mission-executor.ts` (line 1252)

**Before:**
```typescript
const hasSubstantialEvidence = structuredEvidenceText.length > 30 || extractedQuotes.length > 0;
```

**After:**
```typescript
const hasSubstantialEvidence = structuredEvidenceText.length > 30 || extractedQuotes.length > 0 || keywordFound;
```

`keywordFound` is already defined in the same scope as `const keywordFound = extraction.evidence_items.length > 0`.

### Problem

Leads where Layer 1 found keyword matches (`evidence_items.length > 0`) were not reaching Tower if `structuredEvidenceText` was short (≤30 chars) and `direct_quote` fields were empty strings. This is common — many evidence items have a source URL and context snippet but no literal `direct_quote`. The 30-char threshold was silently skipping Tower for an entire class of leads that had real keyword evidence.

### Decision

`keywordFound` is the most semantically correct gate: if Layer 1 found any evidence at all, Tower should rule on it. Tower is the authority on whether keyword matches constitute genuine constraint satisfaction — the character count was a poor proxy for "has evidence". The addition is purely additive (OR), so all leads that previously reached Tower still do.

### What's Next

- On the next live run, expect more Tower calls per run for leads that previously slipped through with keyword evidence but short structured text.
- Monitor whether Tower PASS rate changes significantly — a large drop would indicate the previous threshold was quietly masking low-quality keyword matches.

---

## Treat GPT-4o fallback VERIFIED results as Tower-verified

**Date:** 2026-03-21

### What Changed

In `server/supervisor/mission-executor.ts`, inside the `GPT4O_FALLBACK` section, the block that processes a successful VERIFIED result (the `else` branch after the contradiction check, around line 1486) was updated.

**Before:**
```typescript
er.evidenceFound = true;
er.evidenceStrength = 'weak';
er.snippets = [fbContent.substring(0, 500)];
if (fbSourceUrl) er.sourceUrl = fbSourceUrl;
fallbackVerified++;
```

**After:**
```typescript
er.evidenceFound = true;
er.evidenceStrength = 'strong';
er.towerStatus = 'verified' as any;
er.towerConfidence = 0.75;
er.towerReasoning = 'Verified via GPT-4o web search fallback (website was bot-blocked or had no extractable evidence)';
er.snippets = [fbContent.substring(0, 500)];
if (fbSourceUrl) er.sourceUrl = fbSourceUrl;
fallbackVerified++;
```

### Files Modified

- `server/supervisor/mission-executor.ts` — single block change, ~5 lines

### Decisions Made

- `evidenceStrength` upgraded from `'weak'` to `'strong'`: GPT-4o web search with cited sources is at least as reliable as Tower for constraint verification purposes.
- `towerStatus` set to `'verified'`: eliminates the misleading "unverified" UI state for leads where GPT-4o already confirmed the constraint with real web sources.
- `towerConfidence` set to `0.75` and `towerReasoning` populated: preserves a clear audit trail explaining that verification came from the GPT-4o fallback path, not Tower itself.
- No other code paths were changed. Contradicted results, unverified results, and error paths are unchanged.

### What's Next

- On the next live run, bot-blocked leads (e.g. The White Swan) where GPT-4o found confirming evidence will now show as "verified" in the UI.
- Monitor fallback-verified leads in the AFR audit trail to confirm `towerReasoning` is surfacing correctly.
- Consider whether `towerConfidence` of 0.75 is the right calibration after observing a batch of fallback-verified results.
