# Input Breakage Audit Report

**Date:** 2026-03-04
**Scope:** Wyshbone Supervisor clarify gate (`clarify-gate.ts`) — 30 test inputs
**Method:** Static analysis of `evaluateClarifyGate()` routing decisions post-tightening

---

## Test Input Matrix

| # | Input | Category | Route Decision | Clarify Triggered? | triggerCategory | STOP Risk | Notes |
|---|-------|----------|---------------|-------------------|-----------------|-----------|-------|
| 1 | `"Find 5 pubs in Arundel"` | short simple | `agent_run` | No | — | No | Clean pass |
| 2 | `"Find 5 pubs in Arundel with emails"` | extra clauses | `agent_run` | No | — | No | "with emails" is a delivery requirement, not a gate concern |
| 3 | `"Find pubs in Arundel and then email them"` | two-action single flow | `agent_run` | No | — | No | Single intent with downstream action — correctly passes |
| 4 | `"Find pubs in Arundel and also find cafes in Bristol"` | two requests in one line | `clarify_before_run` | Yes | `multiple_requests` | No | Correctly caught by `hasMixedIntent` |
| 5 | `"find pubs in LeedsShow me cafes in Bristol"` | concatenated (no space) | `clarify_before_run` | Yes | `multiple_requests` | No | Correctly caught by `isMalformedInput` camelCase detector |
| 6 | `"FIND PUBS IN BRIGHTON"` | all caps | `agent_run` | No | — | No | Works fine, case-insensitive matching |
| 7 | `"fIND puBs iN bRiStOl"` | weird casing | `agent_run` | No | — | No | Regex handles mixed case |
| 8 | `"find thee best pubbs in Mancester"` | typos | `agent_run` | No | — | No | Typos pass through — downstream handles best-effort |
| 9 | `"find,, pubs... in bristol!!!"` | messy punctuation | `agent_run` | No | — | No | Punctuation doesn't trigger any gate |
| 10 | `"find the best pubs in Bristol"` | subjective (best) | `agent_run` | No | — | No | Previously blocked, now allowed through |
| 11 | `"find nice cafes in Manchester"` | subjective (nice) | `agent_run` | No | — | No | Previously blocked, now allowed through |
| 12 | `"find good bars in Leeds"` | subjective (good) | `agent_run` | No | — | No | Previously blocked, now allowed through |
| 13 | `"find cool pubs in Brighton"` | subjective (cool) | `agent_run` | No | — | No | Previously blocked, now allowed through |
| 14 | `"find pubs with good atmosphere in Bath"` | subjective (good atmosphere) | `agent_run` | No | — | No | Previously blocked, now allowed through |
| 15 | `"find pubs with live music in Bristol"` | hard constraint | `agent_run` | No | — | No | Clean pass, attribute handled downstream |
| 16 | `"find dog friendly cafes in Bath"` | hard constraint | `agent_run` | No | — | No | Clean pass |
| 17 | `"find pubs in Bristol in 2 minutes"` | time/budget constraint | `agent_run` | No | — | No | "in 2 minutes" is not a location — passes through |
| 18 | `"only do one search for pubs in Leeds"` | budget constraint | `agent_run` | No | — | No | Meta-constraint, not a gate concern |
| 19 | `"find pubs near the council in Leeds"` | vague proximity | `agent_run` | No | — | No | Previously blocked, now allowed through |
| 20 | `"find pubs near council things"` | nonsense location | `agent_run` | No | — | No | Previously blocked — now allowed as imperfect single request |
| 21 | `"find organisations in London"` | vague entity type | `agent_run` | No | — | No | Previously blocked, now allowed through |
| 22 | `"find cafes"` | missing location | `agent_run` | No | — | No | Previously blocked, now allowed through |
| 23 | `"asdfgh jklzxcv qwerty"` | pure nonsense | `clarify_before_run` | Yes | `malformed` | No | Correctly caught by `isNonsenseInput` |
| 24 | `""` | empty | `clarify_before_run` | Yes | `empty` | No | Correctly caught |
| 25 | `"   "` | whitespace only | `clarify_before_run` | Yes | `empty` | No | Correctly caught |
| 26 | `"What is Wyshbone?"` | meta question | `direct_response` | No | — | No | Correctly routed |
| 27 | `"Can I trust these results?"` | trust query | `direct_response` | No | — | No | Correctly routed |
| 28 | `"find the nicest scenic restaurants in Cornwall"` | subjective + measurable | `agent_run` | No | — | No | Previously blocked, now allowed through |
| 29 | `"find best walkable pubs in York"` | subjective + measurable | `agent_run` | No | — | No | Previously blocked, now allowed through |
| 30 | `"list bars in Brighton plus find cafes in Bath"` | two requests (plus find) | `clarify_before_run` | Yes | `multiple_requests` | No | Correctly caught by `hasMixedIntent` |

---

## Breakage Classes

### Class 1: Subjective Criteria False Positives (FIXED)
- **Inputs affected:** #10, #11, #12, #13, #14, #28, #29
- **Root cause:** `SUBJECTIVE_CRITERIA` regex was overly broad — words like "best", "nice", "good", "cool" triggered `clarify_before_run` even when the request was clearly a single actionable search.
- **Fix applied:** Removed subjective criteria as a clarify gate trigger. These terms are now treated as imperfect but runnable single requests.
- **Layer:** Supervisor only.

### Class 2: Vague Proximity / Nonsense Location False Positives (FIXED)
- **Inputs affected:** #19, #20
- **Root cause:** `hasNonsenseLocation` and `detectVagueProximityWithRealLocation` triggered clarification for single requests with imperfect locations (e.g., "near the council in Leeds").
- **Fix applied:** Removed as clarify gate triggers. Downstream systems (goal-to-constraints parser, LLM) handle imperfect locations better than a hard gate.
- **Layer:** Supervisor only.

### Class 3: Missing Location False Positives (FIXED)
- **Inputs affected:** #22
- **Root cause:** `isMissingLocation` blocked any search request without an explicit `in <location>` pattern. "find cafes" with no location was blocked.
- **Fix applied:** Removed as a clarify gate trigger. If location is missing, downstream systems can infer defaults or ask later.
- **Layer:** Supervisor only.

### Class 4: Vague Entity Type False Positives (FIXED)
- **Inputs affected:** #21
- **Root cause:** `hasVagueEntityType` flagged generic terms like "organisations" without a sector qualifier.
- **Fix applied:** Removed as a clarify gate trigger.
- **Layer:** Supervisor only.

### Class 5: True Positives — Multiple Requests (RETAINED)
- **Inputs affected:** #4, #5, #30
- **Root cause:** Correctly detected via `isMalformedInput` (camelCase boundary) and `hasMixedIntent` ("and also find", "plus find").
- **Status:** Working as intended. These are genuinely ambiguous multi-request inputs.
- **Layer:** Supervisor only.

### Class 6: True Positives — Empty/Nonsense (RETAINED)
- **Inputs affected:** #23, #24, #25
- **Root cause:** Correctly detected via empty string check and `isNonsenseInput` (low recognisable-word ratio).
- **Status:** Working as intended.
- **Layer:** Supervisor only.

### Class 7: Direct Response Routing (STABLE)
- **Inputs affected:** #26, #27
- **Root cause:** `isDirectResponse` and `isMetaTrust` correctly route meta/trust queries away from agent execution.
- **Status:** Working as intended, unchanged.
- **Layer:** Supervisor only.

### Class 8: Downstream Subjective Handling Gap (POTENTIAL)
- **Inputs affected:** #10, #11, #12, #13, #14
- **Root cause:** Now that subjective terms pass the gate, downstream systems (goal-to-constraints parser, CVL) must handle "best", "nice", etc. gracefully — either ignoring them or converting them to soft constraints.
- **Status:** Not a gate issue. Requires audit of `goal-to-constraints.ts` and CVL to confirm they don't fail on subjective input.
- **Layer:** Supervisor (downstream).

### Class 9: UI Bubble Consistency (NOT TESTED — REQUIRES LIVE ENVIRONMENT)
- **Inputs affected:** All
- **Root cause:** Cannot verify UI bubble rendering from static code analysis. Chat bubbles may still show stale clarify-state metadata if the UI reads `clarify_gate` from message metadata.
- **Status:** Requires live integration test.
- **Layer:** UI only.

### Class 10: Constraint Gate Double-Block (POTENTIAL)
- **Inputs affected:** #15, #16
- **Root cause:** Even though the clarify gate now lets these through, the downstream `preExecutionConstraintGate` in `constraint-gate.ts` may still block on attribute constraints (e.g., "live music" requires clarification). This is by design but could cause user confusion if they expect the relaxed gate to mean immediate execution.
- **Status:** Not a clarify gate issue — constraint gate is a separate, intentional layer.
- **Layer:** Supervisor (constraint-gate.ts).

---

## Prioritised Fix List

| Priority | Issue | Fix Scope | Status |
|----------|-------|-----------|--------|
| P0 | Subjective criteria triggering clarify_before_run on normal requests | Supervisor only | **FIXED** |
| P0 | Missing location triggering clarify_before_run | Supervisor only | **FIXED** |
| P0 | Vague entity type triggering clarify_before_run | Supervisor only | **FIXED** |
| P0 | Nonsense location / vague proximity triggering clarify_before_run | Supervisor only | **FIXED** |
| P0 | Add `triggerCategory` diagnostic field | Supervisor only | **FIXED** |
| P1 | Verify `goal-to-constraints.ts` handles subjective terms gracefully now that they pass | Supervisor only | Open |
| P1 | Verify UI bubbles render correctly when clarify gate stops triggering | UI only | Open |
| P2 | Constraint gate may still block on `live_music` attributes after clarify gate passes | Supervisor only | By design — document for users |
| P2 | UI should show `triggerCategory` in diagnostic/debug views | UI + Supervisor | Open |
| P3 | False prior context detection removed — monitor for regressions | Supervisor only | Monitor |

---

## Summary

The clarify gate was triggering on **7 out of 10 "imperfect but single" request categories**, causing UX failures where users with normal (if slightly vague) requests were stopped and asked unnecessary questions.

After tightening, `clarify_before_run` now only fires for three categories:
1. **Empty input** (`triggerCategory: 'empty'`)
2. **Unintelligible nonsense** (`triggerCategory: 'malformed'`)
3. **Multiple concatenated requests** (`triggerCategory: 'multiple_requests'`)

All other single requests — even those with subjective terms, missing locations, vague entities, or imperfect phrasing — now proceed to `agent_run` and are handled by downstream systems.
