# Delivery Classification Fix: Evidence-Based Exact/Closest

## Root Cause

Two defects allowed weak or missing evidence to be promoted into `delivered_exact`:

1. **`match_valid` was too permissive** (`mission-executor.ts`):  
   `match_valid` was set to `true` whenever *any* evidence existed (`hasAnyEvidence`), including `weak_match` evidence from Tower. This meant leads with only ambiguous or partial evidence were marked as valid matches.

2. **`delivery-summary.ts` ignored `match_valid`**:  
   The `buildDeliverySummaryPayload` function classified leads into `exact` vs `closest` using `determineLeadExactness`, which only checked CVL data or heuristic name/address matching. It never consulted the `match_valid` signal, so even leads explicitly flagged as having weak evidence were placed into `delivered_exact`.

Together, this meant all 5 leads in the AFR run were classified as `delivered_exact` with `match_level: "exact"` and `match_valid: true`, even though only 3 had any website evidence at all and that evidence was only `weak_match` strength.

## Exact Classification Rule Change

### Before
```
match_valid = evidenceWasAttempted ? hasAnyEvidence : true
```
Any evidence (including `weak_match`) → `match_valid = true` → classified as `exact`.

### After
```
match_valid = evidenceWasAttempted ? strongCount > 0 : true
```
Only leads with at least one `strong` evidence item (Tower `verified` status) get `match_valid = true`.

In `buildDeliverySummaryPayload`, after `determineLeadExactness` returns `match_level`:
- If `match_level === 'exact'` but `match_valid === false` **and no CVL verification exists for the lead** → downgrade to `closest`
- A `weak_or_missing_evidence` violation is added to `soft_violations`
- If `match_valid` is `undefined` (non-evidence queries), no downgrade occurs
- If CVL `verified_exact=true`, the lead stays in `exact` regardless of `match_valid` — CVL is the authoritative override

## How Shortfall Is Now Handled

If only 3 out of 5 requested leads have verified evidence:
- `delivered_exact` = 3 (genuinely verified)
- `delivered_closest` = 2 (weak or unverified)
- `shortfall` = 2 (calculated from `requestedCount - exactCount`)

The system no longer pads `delivered_exact` with weaker candidates to hit the requested count. Shortfall is reported honestly.

## Test Coverage Added

File: `server/supervisor/delivery-classification.test.ts` — 8 tests:

| Test | Scenario | Expected |
|------|----------|----------|
| 1 | 3 verified + 2 weak | exact=3, closest=2 |
| 2 | Weak not promoted to exact | exact=1, closest=2; all closest have match_valid=false |
| 3 | No forced padding | exact=2, closest=3, shortfall=3 |
| 4 | Downgraded leads carry violation | closest[0].soft_violations includes `weak_or_missing_evidence` |
| 5 | match_valid undefined → no downgrade | Non-evidence queries: exact=2, closest=0 |
| 6 | All verified → all exact | exact=3, closest=0, shortfall=0 |
| 7 | AFR reproduction (all weak/none) | exact=0, closest=5, shortfall=5 |
| 8 | CVL verified_exact overrides match_valid (helper) | CVL=true + match_valid=false → still exact |
| 9 | CVL override through full payload path | CVL verified_exact=true keeps lead in exact even with match_valid=false |

## Files Changed

- `server/supervisor/mission-executor.ts` — `match_valid` uses `strongCount > 0` instead of `hasAnyEvidence`
- `server/supervisor/delivery-summary.ts` — Evidence-based downgrade in `buildDeliverySummaryPayload`
- `server/supervisor/delivery-classification.test.ts` — 8 regression tests (new file)
