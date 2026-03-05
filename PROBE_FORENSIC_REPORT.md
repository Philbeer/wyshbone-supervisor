# Probe Forensic Report — Why intent_extractor_probe Never Appears in AFR

**Date:** 05 March 2026
**Build:** f724bed
**Scope:** Trace why `intent_extractor_probe` and `intent_extractor_after_probe` never appear in `agent_activities` for clarify-routed queries

---

## 1. Executive Summary

**The initial hypothesis — that clarify routing happens BEFORE the supervisor task pipeline — is WRONG.**

Every `clarify_gate` artefact and every `clarify_before_run` metadata tag is produced inside `processChatTask()`. There is no alternative execution path. If the user sees `clarify_gate` in the UI, then `processChatTask` ran, and the `intent_extractor_probe` at line 786 executed BEFORE the clarify gate at line 1221.

The real issue is one of two things:

1. **The `emitProbe()` call succeeds (no throw) but the Supabase insert silently fails** — the `logAFREvent` function catches errors at line 57 of `afr-logger.ts` and logs them to console, but the probe is lost.
2. **The user's AFR query is not finding the probe rows** — the probes use `action_taken = 'intent_extractor_probe'`, which may not match the UI's filter or display logic.

---

## 2. Evidence: Execution Order Inside processChatTask

All line numbers reference `server/supervisor.ts`:

| Order | Line | Action | Mechanism |
|-------|------|--------|-----------|
| 1 | 786 | `intent_extractor_probe` | `emitProbe()` → `logAFREvent()` → Supabase `agent_activities` insert |
| 2 | 798 | `createAgentRun` | Drizzle/Neon write to `agent_runs` |
| 3 | 834 | Ownership guard | Supabase query on `supervisor_tasks` |
| 4 | 874 | `task_execution_started` | `logAFREvent()` → Supabase `agent_activities` insert |
| 5 | 886 | `runIntentExtractorShadow` | Shadow intent extraction (OpenAI call + createArtefact) |
| 6 | 892 | `intent_extractor_after_probe` | `emitProbe()` → `logAFREvent()` → Supabase `agent_activities` insert |
| 7 | 987 | Pending constraint check | In-memory check, possible early return |
| 8 | 1034 | Existing clarify session check | In-memory check, possible early return |
| 9 | 1221 | Clarify gate evaluation | `evaluateClarifyGate(rawMsg)` |
| 10 | 1226 | Clarify gate artefact | `createArtefact()` → Drizzle write + `logAFREvent()` |
| 11 | 1256 | `clarify_before_run` handler | Creates session, sends message, returns |
| 12 | 1288 | `clarify_before_run_probe` | `emitProbe()` → `logAFREvent()` → Supabase `agent_activities` insert |

**Key fact:** The `intent_extractor_probe` (line 786) fires BEFORE `task_execution_started` (line 874), which fires BEFORE the clarify gate (line 1221). However, `emitProbe()` is gated by `isProbeEnabled()` (checks `INTENT_EXTRACTOR_PROBE === 'true'`). If the env var is not set or set to anything other than `'true'`, all probes are silently skipped — this alone could explain missing probes.

**Prerequisite:** `INTENT_EXTRACTOR_PROBE=true` must be set in the shared environment. The scratchpad states this is set, but if the running build doesn't have it loaded (e.g., env var set after server start, or set in a different env context), probes will never appear.

---

## 3. Evidence: "No Pending Tasks" Observation

The `[SUPERVISOR_POLL] No pending tasks (heartbeat)` log at line 644 only prints when `tasksToProcess.length === 0` AND at least 60 seconds have passed since the last log. Tasks can be created, claimed, and processed between heartbeat logs. The heartbeat is NOT proof that no task was ever processed — it's only proof that the queue was empty at that specific moment.

The background claimer (line 187, runs every 2000ms) claims tasks independently of the poll loop. A task could be:
1. Inserted into `supervisor_tasks` by the external Wyshbone UI
2. Claimed by the background claimer within 2 seconds
3. Processed by `processSupervisorTasks()` on the next poll cycle
4. Completed before the next heartbeat log

---

## 4. Evidence: "clarify_for_run" Does Not Exist in Server Code

The string `clarify_for_run` does not exist anywhere in the server codebase. It originates from the **Wyshbone UI repo** (a separate codebase), which emits `clarify_for_run` SSE events based on the supervisor's `clarify_before_run` metadata in message/task results.

The actual route values in the supervisor are:
- `clarify_before_run` (line 1256)
- `direct_response` (line 1236)
- `agent_run` (implicit — no early return, falls through to execution)

---

## 5. Evidence: "router_decision" Is Only Emitted Once

`logRouterDecision()` is called exactly once in the entire server codebase — at line 4892, inside `generateLeadsFromSignal()`, for signal-triggered searches (action: `SEARCH_PLACES`). It is NOT called for chat tasks. There is no `router_decision clarify_for_run` event emitted by this server.

If the user sees a "router_decision" for clarify queries, it's either:
- From an older build
- From a different field in the UI (e.g., `clarify_gate` metadata in message records)
- From the UI repo interpreting supervisor response metadata

---

## 6. Evidence: clarify_gate Artefact Failure Mode

The `createArtefact()` call at line 1226 has a `.catch()` at line 1234 that swallows errors:
```
.catch((e: any) => console.warn(`[CLARIFY_GATE] Failed to emit artefact: ${e.message}`));
```

`createArtefact()` in `artefacts.ts`:
1. Calls `storage.createArtefact()` (Drizzle/Neon write) — if this throws, the function re-throws at line 30
2. Only if step 1 succeeds, calls `logAFREvent()` at line 33

So:
- If the Drizzle write fails: the `.catch()` at line 1234 catches it, no AFR event is logged, BUT the console warning is printed
- If the Drizzle write succeeds: the artefact exists in the `artefacts` table AND an `artefact_created` event appears in `agent_activities`

---

## 7. Root Cause Analysis

### Hypothesis A (MOST LIKELY): Probe env var not loaded in running process
`emitProbe()` is gated by `isProbeEnabled()` which checks `process.env.INTENT_EXTRACTOR_PROBE === 'true'`. If the env var was set AFTER the server started, or set in a Replit secrets UI without restarting the workflow, the running Node process won't see it. This is the simplest explanation and should be checked first.

**Diagnostic:** Search server logs for `[PROBE]` — if NO probe log lines exist at all (not even failures), the env var is not reaching the running process.

### Hypothesis B: emitProbe logAFREvent Supabase insert fails (visible in console)
The `emitProbe()` function at `intent-shadow.ts:26` calls `logAFREvent()`. If the Supabase insert to `agent_activities` fails (e.g., missing column, constraint violation, permission issue), the error is:
1. Logged by `logAFREvent()` at line 57 of `afr-logger.ts` — prints `[AFR_LOGGER] Error logging AFR event: <error>`
2. Or caught at line 61 — prints `[AFR_LOGGER] Exception logging AFR event: <message>`
3. Caught again by `emitProbe()` at line 37 of `intent-shadow.ts` — prints `[PROBE] <name> emit failed: <message>`

These are NOT silent — they produce console output. But if console logs are not being monitored, the failure would go unnoticed.

### Hypothesis C: AFR query filters exclude probe rows (speculative — requires UI repo check)
The UI's activity panel queries `agent_activities` and may filter by `action_taken` values it knows about. If the probe's `action_taken = 'intent_extractor_probe'` is not in the UI's known action list, the row exists but is never displayed.

### Hypothesis D: Supabase insert succeeds but probe is for a different run_id (speculative — requires UI repo check)
At line 786, the probe uses `jobId` which equals `uiRunId` (line 781). If the AFR query uses a different run ID (e.g., `clientRequestId`), the probe rows won't match.

---

## 8. Recommended Diagnostic Steps (No Code Changes)

### Step 1: Check console logs for probe emissions
Search server logs for `[PROBE] intent_extractor_probe` — if present, the probe ran. Search for `[PROBE] intent_extractor_probe emit failed` — if present, the Supabase insert is failing.

### Step 2: Query agent_activities directly
```sql
SELECT id, action_taken, run_id, user_id, created_at
FROM agent_activities
WHERE action_taken LIKE '%probe%'
ORDER BY created_at DESC
LIMIT 20;
```
If rows exist, the probes ARE being written — the issue is the UI query filter (Hypothesis B).

### Step 3: Check for Supabase insert errors
```sql
SELECT id, action_taken, run_id, status, created_at
FROM agent_activities
WHERE run_id = '<known_clarify_run_id>'
ORDER BY created_at ASC;
```
Compare the run_id used in the probe (logged as `[PROBE] intent_extractor_probe emitted for runId=<X>`) with the run_id used in the clarify_gate artefact.

---

## 9. Key Finding: The Original Hypothesis Is Disproved

The scratchpad stated: "Clarify routing happens BEFORE supervisor_tasks row is created; no task → supervisor never polls it → processChatTask never runs → no probes."

This is **impossible** given the code. Every `clarify_gate` artefact, every `clarify_before_run` message, and every clarify session creation happens exclusively inside `processChatTask()`. There is no alternative path. The supervisor task MUST exist and be claimed for any clarify behaviour to occur.

The "No pending tasks" heartbeat log is not evidence of no tasks ever being processed — it's a periodic snapshot of queue state.

---

## 10. Files Examined

| File | Lines | Purpose |
|------|-------|---------|
| `server/supervisor.ts` | 160-220, 630-700, 712-755, 771-900, 975-1030, 1218-1300 | Poll loop, task claiming, processChatTask, clarify gate |
| `server/supervisor/intent-shadow.ts` | 1-40 | emitProbe, isProbeEnabled, getIntentExtractorMode |
| `server/supervisor/artefacts.ts` | 1-50 | createArtefact with Drizzle write + logAFREvent |
| `server/supervisor/afr-logger.ts` | 1-64, 410-431 | logAFREvent Supabase insert, logRouterDecision |
| `server/supervisor/clarify-gate.ts` | (referenced) | evaluateClarifyGate routes |
| `server/supervisor/jobs.ts` | 550-620 | startJob supervisor_tasks insert for deep_research |
| `server/routes.ts` | 79-540, 940-984 | API endpoints, simulate-chat-task, task-queue debug |
