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

---

## Replace GPT-4o fallback prefix parsing with structured JSON output

**Date:** 2026-03-21

### What Changed

Two changes in `server/supervisor/mission-executor.ts` inside the GPT4O_FALLBACK section.

**Change 1 — Prompt replaced** (line ~1433):

The old prefix-based prompt (`Start your response with exactly one of: VERIFIED / UNVERIFIED / CONTRADICTED`) was replaced with a JSON-output prompt. GPT-4o is now asked to return a JSON object with five fields: `business_found`, `constraint_met`, `confidence`, `reasoning`, `source_url`. The IMPORTANT block makes the semantic distinction explicit: `business_found` = found info about the business; `constraint_met` = the constraint itself is genuinely true. The fourth bullet explicitly prevents the "mentions/uses ≠ manufactures/provides" confusion (VMS Solutions pattern).

**Change 2 — Response parsing replaced** (lines ~1496–1535):

The old block (`fbUpper.startsWith('VERIFIED')` → contradictionSignals array → hasNegatedConstraint check) was replaced with:

1. JSON extraction via `fbContent.match(/\{[\s\S]*\}/)` and `JSON.parse`.
2. A legacy prefix fallback inside the `catch` block: if JSON parse fails, falls back to the old VERIFIED/CONTRADICTED prefix check (with the stricter negation guards) — handles edge cases where GPT-4o ignores the JSON instruction.
3. Three outcome branches on the parsed object:
   - `business_found && constraint_met` → `verdict = 'verified'`, `towerConfidence` derived from `confidence` field (high=0.85, medium=0.65, low=0.45), `towerReasoning` from `reasoning` field
   - `business_found && !constraint_met` → `verdict = 'no_evidence'`, `fallbackContradicted++`
   - everything else (business not found, unparseable) → `verdict = 'no_evidence'`, `fallbackUnverified++`

The `contradictionSignals` array and `hasNegatedConstraint` check from the previous task now only exist inside the legacy `catch` fallback. They are harmless and will be cleaned up in a future prompt.

### Files Modified

- `server/supervisor/mission-executor.ts` — two locations in the GPT4O_FALLBACK section

### Decisions Made

- The legacy prefix fallback is inside the `catch` block (JSON parse failure), not in the main path. This means the new JSON path is the only path for well-formed GPT-4o responses.
- `towerConfidence` is now dynamic (0.85 / 0.65 / 0.45) rather than a fixed 0.75, giving the AFR audit trail a calibrated confidence signal.
- The workflow was restarted to load the new backend code.

### What's Next

- Observe next fallback run logs for `CONSTRAINT MET` / `CONSTRAINT NOT MET` / `unparseable response` log lines to confirm JSON parsing is working.
- Prompt 3: Update `delivery-summary.ts` to use `verdict`.
- Future cleanup: remove the now-redundant `contradictionSignals` array and `hasNegatedConstraint` from the legacy catch block.

---

## Fix combined delivery to only include verified entities and build proper delivery summary

**Date:** 2026-03-21

### What Changed

Two changes in `server/supervisor/reloop/loop-skeleton.ts`.

**Change 1 — Verified-only filter on combined delivery** (line ~444):

The old trim-to-count logic (`combinedLeads.slice(0, requestedCount)`) was replaced with a two-step filter. First, `combinedLeads` is filtered to only leads where `l.verified === true`, producing `verifiedLeads`. Then the count cap is applied to `verifiedLeads`. A log line records the three counts: accumulated → verified → delivered. This ensures unverified candidates (e.g. those that failed GPT-4o fallback with `constraint_met=false`) are dropped at the reloop level, not just per-loop.

**Change 2 — Merged delivery summary** (lines ~546–595):

The old `combinedResult.deliverySummary` simply forwarded `lastRawResult.deliverySummary` — the last loop's summary only. The new block:
1. Collects all loops' `deliverySummary` objects from `loopHistory`.
2. Merges `delivered_exact` and `delivered_closest` across all loops, deduplicating by name (case-insensitive).
3. Builds `mergedDeliverySummary` by spreading the last loop's summary and overriding the exact/closest arrays with the merged versions, plus recalculating `delivered_exact_count`, `delivered_total_count`, `shortfall`, and `tower_verdict`.
4. Passes `mergedDeliverySummary` into `combinedResult` instead of the per-loop summary.

### Files Modified

- `server/supervisor/reloop/loop-skeleton.ts` — two locations

### Decisions Made

- The filter uses strict `=== true` so leads with `verified: false`, `verified: undefined`, or missing the field are excluded. Leads from ranking-only or field-filter-only strategies (which previously had `verified: false`) will be excluded from multi-loop combined delivery. This is intentional — if a strategy produced no verified leads in any loop, the combined delivery should reflect that.
- Deduplication in the delivery summary merge is by lowercased name, consistent with other dedup logic in the codebase.
- The workflow was restarted to load the new backend code.

### What's Next

- On a multi-loop run, confirm the `[RELOOP_SKELETON] Combined delivery: X accumulated → Y verified → Z delivered` log line appears with the correct counts.
- Prompt 3: Update `delivery-summary.ts` to use `verdict`.

---

## Fix discovery-only runs showing 0 delivered in delivery summary

**Date:** 2026-03-21

### What Changed

Single targeted change in `server/supervisor/mission-executor.ts` inside the `deliveredLeadsWithEvidence` mapping, in the `bestVerdict` computation (line ~2216).

**Before:** `bestVerdict` always ran the `reduce` over `leadEvidence`, which initialised with `'no_evidence'`. For discovery-only runs (no evidence constraints), `leadEvidence` is empty, so the reduce returned `'no_evidence'` immediately → `match_valid = false` → leads were excluded from the delivery summary.

**After:** An explicit `leadEvidence.length === 0` guard returns `'plausible' as const` before the reduce runs. Leads with no evidence records at all (discovery-only) now get `bestVerdict = 'plausible'` → `match_valid = true` → count as `delivered_exact`.

The biodegradable packaging protection is preserved: a lead that HAS evidence records but they are all `verdict = 'no_evidence'` still reduces to `'no_evidence'` and is excluded.

### Files Modified

- `server/supervisor/mission-executor.ts` — three lines changed inside the `bestVerdict` block

### Decisions Made

- `'plausible'` (not `'verified'`) is the correct default for discovery-only leads — they passed discovery and exclusion filtering but haven't been Tower-verified. Using `'verified'` would misrepresent the confidence level.
- The guard is on `leadEvidence.length === 0`, not on any strategy flag, so it applies correctly regardless of which strategy produced the run.

### What's Next

- Confirm discovery-only runs (e.g. "find restaurants in X") now show a non-zero `delivered_exact_count` in the delivery summary.
- Prompt 3: Update `delivery-summary.ts` to use `verdict`.

---

## Emit per-lead evidence artefacts from GPT-4o primary search path

**Date:** 2026-03-21

### What Changed

New block added in `server/supervisor/gpt4o-search.ts` immediately after the `attribute_verification` artefact creation (after line 340) and before `const deliveryLeads = ...`.

The block iterates over `allLeads` and calls `createArtefact` once per lead with `type: 'constraint_led_evidence'` — the same artefact type the GP cascade path emits. Each artefact is built to match the field structure the UI expects for evidence dropdowns:
- `evidence_items` array (populated if `lead.evidence` exists, empty otherwise)
- `tower_status` and `tower_confidence` derived from `lead.confidence`
- `lead_place_id` is a synthetic key (`gpt4o_{index}_{sanitised_name}`) since GPT-4o results don't have Google Place IDs
- `extraction_method: 'gpt4o_web_search'` distinguishes these from GP cascade artefacts
- Each `.catch()` is non-fatal so a single failed write does not abort delivery

A summary log line `[GPT4O_SEARCH] Emitted N per-lead evidence artefacts for UI dropdowns` is emitted after the loop.

### Files Modified

- `server/supervisor/gpt4o-search.ts` — one block added (~52 lines)

### Decisions Made

- The existing `attribute_verification` and `final_delivery` artefacts are untouched — they serve aggregate/summary purposes.
- `lead_place_id` uses a synthetic index-based key rather than a real Place ID. If the UI performs placeId-based lookups, this may need to be updated once real Place IDs are available in the GPT-4o path.
- Confidence mapping: `high → 0.85 / tower_status=verified`, `medium → 0.65 / tower_status=weak_match`, `low/null → 0.4 / tower_status=null`.
- The workflow was restarted to load the new backend code.

### What's Next

- On a GPT-4o primary path run, check the artefact list for `constraint_led_evidence` entries per lead and confirm the UI dropdowns populate.
- If `lead_place_id` lookups fail, consider whether the UI falls back gracefully or needs a real Place ID mapping.
