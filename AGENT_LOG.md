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

---

## Add single verdict field to EvidenceResult (Part 1 of verdict simplification)

**Date:** 2026-03-21

### What Changed

Six targeted changes in `server/supervisor/mission-executor.ts` to introduce a `verdict` field on `EvidenceResult` that is set exactly once at each evidence-gathering site.

**Change 1 — EvidenceResult interface** (line ~109):
Added `verdict: 'verified' | 'plausible' | 'no_evidence'` as the final field.

**Change 2 — processOneLead verdict derivation** (after evidenceStrength, line ~1296):
Added a `verdict` constant immediately after `evidenceStrength` using the same tower status / keywordFound logic but mapping to the new three-value enum. Also added `verdict,` to the `evidenceResults.push` call so the field is populated on all processOneLead results.

**Change 3 — GPT-4o fallback verified path** (line ~1504):
Added `er.verdict = 'verified'` inside the `if (!hasContradiction)` block, after the other `er.*` assignments.

**Change 4 — GPT-4o fallback non-verified paths** (lines ~1493, ~1509, ~1513, ~1520):
- `if (hasContradiction)` block → `er.verdict = 'no_evidence'`
- `else if CONTRADICTED` block → `er.verdict = 'no_evidence'`
- final `else` (unverified) block → `er.verdict = 'no_evidence'`
- `catch` block → `er.verdict = 'no_evidence'`

**Change 5 — FILTER_FIELDS push** (line ~1097):
Added `verdict: 'verified' as const` to the field-match evidence push. Only one FILTER_FIELDS block exists (the task brief mentioned a possible replan block, but it does not exist in this file).

**Change 6 — RANK_SCORE push** (line ~1832):
Added `verdict: 'plausible' as const` to the ranking evidence push.

### Files Modified

- `server/supervisor/mission-executor.ts` — six locations, additive changes only

### Decisions Made

- No existing fields were removed or changed — this is a purely additive pass as specified. `evidenceStrength`, `evidenceFound`, `match_valid`, and all other existing fields remain untouched.
- The three-value enum (`verified` / `plausible` / `no_evidence`) maps directly from the existing tower status and keyword evidence signals, so downstream logic in the next prompt can switch on `verdict` without any semantic loss.
- The task brief mentioned a second (replan) FILTER_FIELDS block — it does not exist in the current file. Only one FILTER_FIELDS push was found and updated.
- TypeScript compiled cleanly; no runtime errors observed in workflow logs.

### What's Next

- Part 2: Replace the hard evidence filter, `match_valid`, and `verification_status` derivation logic downstream to use `verdict` directly, removing the redundant overlapping checks.

---

## Add missing verdict to replan FILTER_FIELDS evidence push

**Date:** 2026-03-21

### What Changed

In `server/supervisor/mission-executor.ts`, inside the replan `while` loop's FILTER_FIELDS block (line ~1987), the `evidenceResults.push` call was missing `verdict`. Added `verdict: 'verified' as const,` after the `snippets` line, matching the identical fix already applied to the main FILTER_FIELDS block in the previous task.

### Files Modified

- `server/supervisor/mission-executor.ts` — one line added inside the replan FILTER_FIELDS push

### Decisions Made

- This was the replan block that the previous task brief flagged as a possible second location. It was not found by grep at that time (grep searched for "Field match:" but this block uses "Field match (replan v${planVersion}):"). Now corrected.
- No other changes needed — the fix is identical to the main block.

### What's Next

- EvidenceResult.verdict is now fully populated at every push site. Part 2 (replacing hard evidence filter and match_valid checks with verdict) can proceed.

---

## Replace hard evidence filter and match_valid with single verdict field (Part 2)

**Date:** 2026-03-21

### What Changed

Two blocks replaced in `server/supervisor/mission-executor.ts`.

**Change 1 — Hard evidence filter → Verdict-based filter** (line ~2072):

The `hardEvidenceConstraints` / `applyHardEvidenceFilter` block was replaced with a verdict-based filter. The new filter keeps any lead that has at least one `EvidenceResult` with `verdict !== 'no_evidence'`. The condition is gated on `hasEvidenceConstraintsForFilter && evidenceResults.length > 0` (equivalent semantics to the old `hardEvidenceConstraints.length > 0` gate). The log line now reads `[MISSION_EXEC] Verdict filter:` instead of `Hard evidence filter:`.

**Change 2 — deliveredLeadsWithEvidence mapping** (line ~2191):

The old mapping computed `hasAnyEvidence`, `strongCount`, and `weakCount` and then derived `verified`, `verification_status`, `match_valid`, and `constraintVerdicts` from those counts. The new mapping:
- Computes `bestVerdict` via a single reduce over `leadEvidence[].verdict`
- Sets `verified = bestVerdict === 'verified'`
- Sets `verification_status = bestVerdict` (the three-value string directly)
- Sets `match_valid = bestVerdict !== 'no_evidence'`
- Sets `constraintVerdicts` from `er.verdict` directly (no more towerStatus re-derivation)
- Adds `verdict: e.verdict` to the `evidenceAttachment` items so it is visible in the payload
- Removes the five separate recalculation paths for `verification_status` (evidenceWasAttempted / isRankingOnly / isFieldFilterOnly branches)

### Files Modified

- `server/supervisor/mission-executor.ts` — two blocks replaced

### Decisions Made

- `applyHardEvidenceFilter` function definition was NOT removed — it may be referenced elsewhere. Cleanup deferred to a later prompt as instructed.
- `isRankingOnly`, `isFieldFilterOnly`, and `evidenceWasAttempted` variables are still declared above the mapping and referenced in the diagnostic artefact payload below it — they were not touched.
- The workflow was restarted after the edit so the new backend code is live for the next run.

### What's Next

- Prompt 3: Update `delivery-summary.ts` to use `verdict` instead of the old status strings.
- Separately: remove the now-unused `applyHardEvidenceFilter` function and its supporting interfaces after confirming end-to-end correctness.

---

## Fix GPT-4o fallback prompt ambiguity and strengthen contradiction detector

**Date:** 2026-03-21

### What Changed

Three changes in `server/supervisor/mission-executor.ts` inside the GPT-4o fallback section.

**Change 1 — Prompt clarification** (line ~1433):

The `fbPrompt` wording was made unambiguous about what VERIFIED means. Old text: *"Determine whether the following is genuinely true..."* — GPT-4o was sometimes using VERIFIED as "I found the business" rather than "the constraint is true". New text: *"Determine whether the following constraint is genuinely true..."* with an explicit IMPORTANT block: *"Only use VERIFIED if the constraint IS true for this business. If the business exists but does NOT match the constraint, use CONTRADICTED."* The VERIFIED response format now also reads *"evidence that the constraint IS true, with source URL"* to reinforce the distinction.

Note: the task brief prompt text was truncated at `[evidence that the constraint IS true, wit ...[Truncated]`. The completion `with source URL]` was inferred from the original prompt pattern — the most natural and consistent completion.

**Change 2 — Additional contradiction signals** (line ~1489):

Eight new signals added to the `contradictionSignals` array:
`'not a '`, `'not an '`, `'is not '`, `'are not '`, `'isn\'t '`, `'aren\'t '`, `'rather than '`, `'instead of '`

**Change 3 — Constraint-specific negation check** (lines ~1494–1498):

After `hasContradiction` is computed, three new lines derive `hasNegatedConstraint` by checking whether the lowercased response contains the constraint value (or its individual words >3 chars) negated with `'not a '`, `'not '`, or `'no '`. The `if` gate was widened from `if (hasContradiction)` to `if (hasContradiction || hasNegatedConstraint)` to catch the VMS Solutions pattern: GPT-4o returning VERIFIED but then writing "not a [constraint value]".

### Files Modified

- `server/supervisor/mission-executor.ts` — three locations in the GPT4O_FALLBACK section

### Decisions Made

- The truncated prompt ending was completed as `with source URL]` — the only sensible reading consistent with the original prompt structure.
- The new broad signals (`'not a '`, `'is not '`, etc.) include a trailing space to reduce false positives on tokens like "isn't" within compound words.
- The constraint-specific check is deliberately additive (OR), so the existing broad check still applies independently.

### What's Next

- Monitor fallback runs to confirm VMS-style false-positives are caught without over-filtering legitimate VERIFIED responses.
- Prompt 3: Update `delivery-summary.ts`.
