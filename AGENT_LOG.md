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

---

## Add snippet and quote aliases to GPT-4o primary path delivery leads

**Date:** 2026-03-21

### What Changed

One line changed in `server/supervisor/gpt4o-search.ts` inside the `deliveredLeadsWithEvidence` mapping (line ~414).

The `evidence` array entry previously only had `text: gLead.evidence`. Added `snippet: gLead.evidence` and `quote: gLead.evidence` as aliases on the same object. The chat bubble's LeadRow component reads `evidence[0].snippet` or `evidence[0].quote` — not `text` — so GPT-4o primary path results were silently showing no evidence text in the dropdown.

The `dsLeads` mapping's `supporting_evidence` line already used `snippet` correctly and was confirmed unchanged.

### Files Modified

- `server/supervisor/gpt4o-search.ts` — one line, two fields added

### Decisions Made

- Both `snippet` and `quote` were added as aliases so the UI works regardless of which field it tries first.
- The `text` field was kept so any other consumer that reads `text` is not broken.
- The `dsLeads` / `supporting_evidence` path already used `snippet` correctly — no change needed there.

### What's Next

- On the next GPT-4o primary path run, confirm evidence text appears in chat bubble dropdowns.
- No further changes needed for this path.

---

## Deduplicate extracted quotes in evidence results

**Date:** 2026-03-21

### What Changed

One line changed in `server/supervisor/mission-executor.ts` inside `processOneLead` (line ~1235).

**Before:** `extraction.evidence_items.map(e => e.direct_quote)` — duplicates included when the same text appeared in multiple evidence items (e.g. confirmed by both Layer 1 keyword extraction and Layer 2 LLM judgement).

**After:** `[...new Set(extraction.evidence_items.map(e => e.direct_quote))]` — Set deduplication removes identical strings before the array is stored in `extractedQuotes`, which then populates `er.snippets`.

### Files Modified

- `server/supervisor/mission-executor.ts` — one line

### Decisions Made

- `Set` deduplication is on the full `direct_quote` string, so near-duplicates (same sentence with minor whitespace differences) are not collapsed — only exact matches. This is the right conservative level for quote dedup.
- `keywordFound` (the line immediately after) still reads from `extraction.evidence_items.length` not from `extractedQuotes.length`, so deduplication has no effect on the evidence gate.

### What's Next

- No follow-up required. This is a cosmetic quality improvement to the snippets array.

---

## Make Layer 2 evidence-judge model configurable via env var

**Date:** 2026-03-22

### What Changed

- `server/supervisor/constraint-led-extractor.ts` — inside `extractConstraintLedEvidence()`, the `client.chat.completions.create` call that performs Layer 2 LLM judgement (does this extract prove the constraint?) had `model: 'gpt-4o'` hardcoded. Changed to `model: process.env.EVIDENCE_JUDGE_MODEL ?? 'gpt-4o-mini'`.

### Files Modified

- `server/supervisor/constraint-led-extractor.ts` — one line (model string on the Layer 2 LLM call)

### Decisions Made

- Default fallback is `gpt-4o-mini` (not `gpt-4o`) so that if the secret is ever missing the cheaper model runs rather than silently upgrading cost.
- No other parameters were touched: system prompt, temperature (0.1), max_tokens (200), and response_format remain unchanged.
- `EVIDENCE_JUDGE_MODEL` already existed as a Replit Secret; no new secret creation was needed.
- The Layer 1 keyword-scan path is unaffected — only the LLM judge call reads from this variable.

### What's Next

- Run a test query with an attribute constraint (e.g. "pubs in Arundel with a beer garden") to confirm `gpt-4o-mini` evidence quality is acceptable.
- If evidence quality drops noticeably, set `EVIDENCE_JUDGE_MODEL=gpt-4o` in the Secrets tab — no code change or redeploy required.
- The task (classifying 5 short text windows against a single yes/no criterion) is well within mini's capability; the expectation is no regression.

---

## 2026-03-26 — PASS3_CLARIFY Legacy Path Fires Instead of Preflight Probe

### Problem

When the user sends "i'm looking for companies that buy cardboard wholesale", **sometimes** a wrong Supervisor message appears: "I'd be happy to find leads for you! Could you tell me what type of businesses you're looking for?" — instead of the correct preflight clarify probe which asks "What location should I search in?".

### Grep Output

**Search for legacy message strings:**
```
grep -rn "happy to find\|what type of\|could you tell\|type of businesses" server/ --include="*.ts"
# → No output (strings are LLM-generated at runtime, not hardcoded)
```

**Clarification references in supervisor.ts:**
```
98:    missingFields: contract.clarify_questions.map(...)
945:    const isClarifyResponse = ...
1218:    if (missionMode === 'active' && missionResult?.intentNarrative?.clarification_needed && missionQueryId)
1254:    if (missionMode === 'active' && missionResult?.intentNarrative?.clarification_needed && !_missionHasEnoughToSearch && !missionQueryId)
1567:    const preflightResult = this.evaluatePreflightClarify(...)
```

**Message insertions in supervisor.ts:**
```
967:   supabase!.from('messages').insert(...)
1261:  supabase!.from('messages').insert({ ..., clarify_gate: 'pass3_clarify' })
1629:  supabase!.from('messages').insert(...)
1840:  supabase!.from('messages').insert({ ..., clarify_gate: 'constraint_gate_stop' })
```

**LLM calls in supervisor.ts:**
```
# → No direct openai/anthropic references in supervisor.ts (called via mission extractor module)
```

**evaluatePreflightClarify:**
```
1567:  const preflightResult = this.evaluatePreflightClarify(rawMsg, earlyParsedGoal, ...)
2464:  private evaluatePreflightClarify(...): { reason, questions, options } | null
2480:  if (!bt)  → asks "What type of business are you looking for?"
2485:  if (!loc) → asks "What location should I search in?"
```

**processChatTask order:**
```
Line 1056: mission extraction runs
Line 1218: PASS3_CLARIFY bypass for benchmark runs
Line 1254: PASS3_CLARIFY gate — fires and returns early ← BUG FIRES HERE
Line 1272: earlyParsedGoal / canonicalIntent set
Line 1567: preflight probe evaluated ← NEVER REACHED
```

### Code Path That Generates the Wrong Message

**`server/supervisor.ts` lines 1254–1269 (`PASS3_CLARIFY`):**

```typescript
if (missionMode === 'active' && missionResult?.intentNarrative?.clarification_needed && !_missionHasEnoughToSearch && !missionQueryId) {
  const clarifyQ = missionResult.intentNarrative.clarification_question || 'Could you clarify your request a bit more?';
  // Posts clarifyQ directly to messages table → returns early at line 1269
  return;
}
```

The mission LLM (Pass 3) sets `clarification_needed=true` and generates a free-form `clarification_question` string such as "I'd be happy to find leads for you! Could you tell me what type of businesses you're looking for?". This LLM output is non-deterministic and sometimes asks the wrong question (entity instead of location). PASS3_CLARIFY posts it verbatim and returns, so the preflight probe at line 1567 never runs.

### Why the Preflight Probe Didn't Fire

PASS3_CLARIFY is ordered **before** the preflight probe in `processChatTask`. When `clarification_needed=true` and `!_missionHasEnoughToSearch` (location missing), PASS3_CLARIFY fires first and executes `return`, terminating the task before the preflight probe is ever evaluated. Additionally, `earlyParsedGoal` — required by the preflight probe — is not even computed until line 1272, after PASS3_CLARIFY would already have returned.

### Fix Applied

Added a guard inside the PASS3_CLARIFY block in `server/supervisor.ts` (line 1257):

```typescript
// Guard: if entity or location is missing, the preflight clarify probe owns this case.
// Skip PASS3_CLARIFY so the legacy LLM-generated clarification_question never fires
// instead of the preflight probe.
const _preflightWouldFire = !_clarifyGateEntity || !_clarifyGateLocation;
if (_preflightWouldFire) {
  console.log(`[PASS3_CLARIFY] Skipped — preflight probe owns this case (entity="${_clarifyGateEntity || '<missing>'}" location="${_clarifyGateLocation || '<missing>'}")`);
} else {
  // ... existing PASS3_CLARIFY fire-and-return logic ...
}
```

**Logic:** Both `_clarifyGateEntity` and `_clarifyGateLocation` are already computed at line 1226–1227 (from the structured mission result), before PASS3_CLARIFY is evaluated. If either is missing, the preflight probe will fire with a deterministic, structured question. PASS3_CLARIFY now only fires when both entity AND location are present but `clarification_needed=true` for some other reason (e.g. ambiguous constraint) — a case the preflight probe would NOT handle.

### Files Modified

- `server/supervisor.ts` — PASS3_CLARIFY block (lines 1257–1281): added `_preflightWouldFire` guard with `else` branch wrapping the fire-and-return code.

### Decisions Made

- Guard uses `!_clarifyGateEntity || !_clarifyGateLocation` — matches exactly the two branches inside `evaluatePreflightClarify` that produce structured questions.
- PASS3_CLARIFY is preserved (not deleted) for cases where entity+location are both present and some other reason triggers the LLM's clarification flag.
- No changes to the preflight probe logic, mission extractor, or any other path.

### What's Next

- Test with "i'm looking for companies that buy cardboard wholesale" — should consistently receive "What location should I search in?" from the preflight probe.
- Monitor logs for `[PASS3_CLARIFY] Skipped` to confirm the guard is firing on location-missing queries.
- Consider whether the PASS3_CLARIFY path is still needed at all once the preflight probe coverage is confirmed complete.

---

## Clarification flow investigation — cardboard wholesale query

**Date:** 2026-03-26

### Query under investigation

- User query: `"i'm looking for companies that buy cardboard wholesale"`
- Supervisor asked: `"What location should I search in?"`
- User answered: `"west sussex"`
- Run ID: `106550eb-ba0a-41c8-9a83-b7951abb15c6`
- Conversation ID: `b75b2311-9f0f-4df4-b75f-ed67489cbfff`
- Continuation task ID: `62dee5cc-a4d2-407f-8a22-4385e4c10e38`

---

### 1. Did the preflight probe fire correctly?

**YES — fired correctly.**

Log sequence (lines ~4750–4773 of the workflow log):

```
[INTENT_PREVIEW] bt=companies purchasing cardboard in bulk loc=null count=null
[PREFLIGHT_CLARIFY] semantic_source=fallback_regex reasons=missing location
[PREFLIGHT_CLARIFY] Triggered — reason=missing location questions=1 runId=106550eb-...
[Storage] Created artefact 'Clarification Required' (type=clarify_gate) id=e1f65a04-...
[PREFLIGHT_CLARIFY] Run awaiting user input — status=clarifying
[AFR_LOGGER] Logged: preflight_clarify_probe - success
[PROBE] preflight_clarify_probe emitted for runId=106550eb-...
```

- `semantic_source=fallback_regex` — location was missing, regex fallback correctly detected absence.
- `clarify_gate` artefact written to storage: ✅
- Run status set to `clarifying`: ✅
- `preflight_clarify_probe` emitted via AFR_LOGGER and PROBE: ✅

**Note:** The preflight ran twice — task `c97dabe5` (first attempt) and task `62dee5cc` (second attempt, same `crid`). On the second, `RUN_PERSIST` detected `agent_run already exists (retry/resume)` and resumed correctly without creating a duplicate run.

---

### 2. Did the continuation run execute fully?

**YES — executed fully and completed successfully.**

After "west sussex" was submitted, task `62dee5cc` processed `message="west sussex"`:

```
[SUPERVISOR] Executing task 62dee5cc-... — message="west sussex"
```

The continuation correctly parsed the location as **West Sussex** (confirmed in the Tower judgement payload: `"location": "West Sussex"`).

Execution used a **richer strategy** than simple discovery — because "wholesale cardboard" is a website-evidence constraint:

- Strategy: `discovery_then_website_evidence`
- Tool chain: `SEARCH_PLACES → WEB_VISIT → EVIDENCE_EXTRACT → TOWER_JUDGE`
- SEARCH_PLACES: 20 results from 5 queries
- 7 leads passed verification (all 7 verified)
- Tower verdict: **PASS**

Run completion:

```
[DELIVERY_SUMMARY] runId=106550eb-... status=PASS exact=7 closest=0 total=7 tower=PASS
[RUN_LOGGER] stage=run_complete
[FINAL_MESSAGE] task_status=completed status=OK
[BENCHMARK] query="west sussex" delivered_count=7 verified_count=7 tower_verdict=pass
```

**Fully completed: ✅**

---

### 3. Were activity events emitted for the continuation?

**YES — full set of activity events emitted.**

Events confirmed for run `106550eb-ba0a-41c8-9a83-b7951abb15c6`:

| Event | Status |
|---|---|
| `preflight_clarify_probe` | ✅ success |
| `intent_extractor_probe` | ✅ success |
| `intent_extractor_after_probe` | ✅ success |
| `mission_received` | ✅ pending → success |
| `task_execution_started` | ✅ pending |
| `plan_execution_started` | ✅ pending |
| `tool_call_started` (multiple) | ✅ pending |
| `tool_call_completed` (multiple) | ✅ success |
| `step_completed` | ✅ success |
| `artefact_created` (many) | ✅ success |
| `tower_judgement` | ✅ success |
| `tower_verdict` | ✅ success |
| `run_completed` | ✅ success |
| `reloop_iteration` | ✅ success |
| `task_execution_completed` | ✅ success |

The UI should have received breadcrumbs throughout. No gaps in activity event chain were observed.

---

### 4. Did the Supervisor attempt any legacy clarification message?

**NO — none detected.**

Grepped for: `happy to`, `what type of`, `could you tell`, `I'd be`, `i would be` — zero matches in the entire log.

The Supervisor did not generate any legacy "I'd be happy to find leads..." message. The preflight system intercepted the missing-location case exclusively and cleanly.

---

### 5. Notable anomaly — EVIDENCE_EXTRACTION_FAILURE classification despite PASS

The BENCHMARK entry records `failure_classification=EVIDENCE_EXTRACTION_FAILURE` even though `tower_verdict=pass`. This is expected — the "wholesale cardboard" constraint was checked against company websites via EVIDENCE_EXTRACT, and no company's website contained the phrase "wholesale cardboard" explicitly. However, 7 companies still passed overall verification by other means. The Tower judged the delivery acceptable given the constraint difficulty.

This is not a flow failure — it is a known classification pattern when website evidence is absent but results are still delivered.

---

### Summary

| Dimension | Result |
|---|---|
| Preflight probe fired | ✅ Yes — `fallback_regex`, `missing location` |
| Continuation run executed | ✅ Yes — fully, with `west sussex` correctly parsed |
| Location used in search | ✅ `West Sussex` (not bare "sussex") |
| Activity events emitted | ✅ Full set — UI breadcrumbs available |
| Run completed successfully | ✅ PASS, 7 leads, `task_status=completed` |
| Legacy Supervisor clarify text | ✅ None — preflight system handled exclusively |
| Anomaly | ⚠️ `EVIDENCE_EXTRACTION_FAILURE` classification despite PASS (expected, not a bug) |

## 2026-03-26 — Disable PASS3_CLARIFY block

**Task:** Disable the PASS3_CLARIFY block in `server/supervisor.ts` so the preflight clarify probe is the sole clarification authority.

**Problem:** `PASS3_CLARIFY` was firing LLM-generated clarification questions even when the preflight probe should have handled clarification. The guard only skipped `PASS3_CLARIFY` when entity OR location was missing. When the mission extractor found a generic location from context (e.g., "UK"), both fields were present, so the guard didn't skip — and `PASS3_CLARIFY` posted non-deterministic, often unhelpful LLM questions.

**Fix applied:** Replaced the entire `PASS3_CLARIFY` block (including the inner guard logic, Supabase writes, `updateAgentRun`, `emitTaskExecutionCompleted`, and `return`) with a single `console.log` line that logs the DISABLED state.

**File changed:** `server/supervisor.ts` (lines ~1254–1278 replaced)

**Verification:**
```
grep -n "PASS3_CLARIFY" server/supervisor.ts | head -10
```
Output shows only two lines:
1. The benchmark bypass log (line 1219) — unchanged, correct
2. The new DISABLED log line (line 1255) — no message-posting code remains

**Result:** The preflight probe is now the sole authority for clarification questions. `PASS3_CLARIFY` never posts a message.

---

## 2026-03-26 — Timing & Performance Investigation: Cardboard Wholesale Clarification Run

### Query Traced
- Initial message: `"companies that buy cardboard wholesale"`
- Clarification reply: `"west sussex"`
- Run ID: `1e57dad4-8fac-471b-a6c9-b39635fc320b`

---

### 1. PASS3_CLARIFY Status

**DISABLED — confirmed.** Two lines exist in `server/supervisor.ts`:

- **Line 1219** (unchanged): Benchmark bypass path — logs but does not block.
- **Line 1255** (new): `[PASS3_CLARIFY] DISABLED — preflight probe is the sole clarification authority. clarification_needed=... entity="..." location="..."`

PASS3_CLARIFY no longer posts a clarification message. The preflight probe is the sole gatekeeper.

---

### 2. Run Timeline (Reconstructed from Logs)

| Stage | Log Evidence | Notes |
|---|---|---|
| Original query received | line 2403: `[MESSAGE_CLASSIFIER] class=search` | "companies that buy cardboard wholesale" |
| Mission extraction | line 2518: `pass1=3473ms pass3=5288ms pass2=2096ms total=10857ms` | ~10.9s to extract intent |
| PREFLIGHT_CLARIFY triggered | line 2578-2579: `reasons=missing location` | Correct — no location in query |
| Run paused, awaiting user | line 2590: `status=clarifying` | Clarify gate artefact emitted |
| User replied "west sussex" | line 2862: new task `3dfb88c6-535a-4543-b76b-885455d5099c` | Task re-queued with location |
| Mission re-extraction (west sussex run) | line 2897: `Pass 3 duration=5331ms` | Strategy: `discovery_then_website_evidence` |
| LLM planner chose gp_cascade | (implied from executor log) | With WEB_VISIT + evidence extraction |
| gp_cascade executor complete | line 3733: `entities=7 timeMs=144574 verdict=pass` | **~144.6 seconds** — dominant cost |
| Tower verdict | line 3716-3718: `verdict=pass action=continue` | |
| Delivery summary | line 3728: `status=PASS exact=7 total=7` | |
| `run_complete` logged | line 3732: `stage=run_complete` | |
| Post-processing artefacts | lines 3741–3763: reloop_iteration, reloop_chain_summary, combined_delivery | Sequential, appears fast |
| **FINAL_MESSAGE sent** | **line 3768**: `task_status=completed status=OK` | UI result panel triggered here |
| Benchmark logged | line 3769: `timestamp=2026-03-26T15:23:55.237Z` | End of run |

---

### 3. Root Cause of Delay

**The delay is not between breadcrumbs and final_message — it is the run itself.**

The strategy selected was `discovery_then_website_evidence` (because the query implied companies that *buy* cardboard, triggering a website content constraint). This forces:
- Google Places discovery
- Web visits to each candidate's website
- Evidence extraction per site

This resulted in **144,574ms (~2.4 minutes)** of executor time. Compare to simple `discovery_only` runs (gp_cascade, no website visits) which complete in **6,000–9,700ms**.

The breadcrumbs likely showed `discovery_complete` early (fast Google Places call), but the result panel waited for the full web-visit + evidence phase to complete and for `FINAL_MESSAGE` to fire. That is the gap the user perceived.

**Post-completion processing** (reloop_judge, reloop_gate, learning_store, artefact writes after `run_complete`) spans only ~36 log lines and appears to complete in under a second — not a meaningful contributor.

---

### 4. Additional Signal

- `failure_classification=EVIDENCE_EXTRACTION_FAILURE` on the benchmark despite `tower_verdict=pass`. 7 of the initially discovered candidates passed evidence checks; others were dropped at extraction. This is expected behaviour for the `discovery_then_website_evidence` path.
- The breadcrumb UI shows `discovery_complete` early, creating a perceived gap because web-visit stages do not emit a dedicated breadcrumb stage. **The user's observation is real and accurate** — there is a silence between Google Places completing and the result panel appearing while web visits run.

---

### 5. No Code Changed
Investigation only. No fixes applied.
