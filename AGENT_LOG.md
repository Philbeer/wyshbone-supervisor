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
