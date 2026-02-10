# Supervisor Artefacts Debug Report

Generated: 2026-02-10

---

## 1) Authoritative Run Identifier

**`runId`** is the authoritative identifier inside Supervisor. It is a UUID string generated at execution time.

- **Plan execution path**: `planId` (a UUID) is used as the `runId`. Created in `server/supervisor/plan-executor.ts` at the start of `executePlan()`.
- **Agent loop path**: The `runId` is passed into `initRunState()` in `server/supervisor/agent-loop.ts:L90+`. It originates from the plan executor or caller.
- **Chat task path**: In `server/routes.ts` (simulate-chat-task, L530+), `chatRunId` is set from `req.body.run_id` (the UI's canonical run ID). In `server/supervisor.ts` (`generateLeadsForChat`), the `uiRunId` parameter serves as the `runId`.

**`clientRequestId` (crid)** is a secondary, external-facing correlation ID. It is passed alongside `runId` in artefact POST bodies to link Supervisor's internal `runId` with the UI's canonical run. It is **not** stored in the local `artefacts` table — it is only sent in the HTTP POST to the UI endpoint.

**Summary**: `runId` = internal authority. `crid` = external correlation only.

---

## 2) Fields Written When Creating an Artefact

### Local DB (via `createArtefact` in `server/supervisor/artefacts.ts`)

| Field | Column | Source |
|-------|--------|--------|
| `runId` | `run_id` (varchar, NOT NULL) | Caller-supplied |
| `type` | `type` (text, NOT NULL) | e.g. `leads_list`, `step_result`, `run_summary`, `tower_judgement`, `plan_update` |
| `title` | `title` (text, NOT NULL) | Human-readable label |
| `summary` | `summary` (text, nullable) | Short description |
| `payloadJson` | `payload_json` (jsonb, nullable) | Structured data blob |
| `id` | `id` (varchar, PK) | Auto-generated UUID via `gen_random_uuid()` |
| `createdAt` | `created_at` (timestamp) | Auto `now()` |

### Remote UI POST (via `postArtefactToUI` in `server/supervisor.ts:L427`)

POST body sent to `{UI_URL}/api/afr/artefacts`:

```json
{
  "runId": "<run_id>",
  "clientRequestId": "<crid>",       // optional, included when available
  "type": "<artefact_type>",
  "payload": { ... },
  "createdAt": "<ISO timestamp>"
}
```

---

## 3) Where Artefacts Go

### Local Database

- **Table**: `artefacts` (Postgres, defined in `shared/schema.ts:L165`)
- **Index**: `artefacts_run_id_idx` on `run_id`
- **ORM**: Drizzle, storage method at `server/storage.ts:L435` (`DatabaseStorage.createArtefact`)
- **Env var**: `SUPABASE_DATABASE_URL` (connection string for the Neon/Supabase Postgres DB)

### Remote UI (Wyshbone Frontend)

- **Endpoint**: `POST {UI_URL}/api/afr/artefacts`
- **Env var**: `UI_URL` (base URL of the Wyshbone UI app)
- **Called from**: `postArtefactToUI()` in `server/supervisor.ts:L427`

---

## 4) All SEARCH_PLACES Code Paths That Write Artefacts

### A. Agent Loop (`server/supervisor/agent-loop.ts`)

| Line(s) | Function | Artefact Type | Trigger |
|---------|----------|---------------|---------|
| 233 | `postRunSummary` | `run_summary` | Every terminal path (ACCEPT, STOP, max retries, retry fail, replan fail, etc.) |
| 257 | `postTowerJudgementArtefact` | `tower_judgement` | After every Tower verdict received |
| 390 | `createRerunLeadsListArtefact` | `leads_list` | After retry or replan re-execution |
| 513 | inline in CHANGE_PLAN handler | `plan_update` | When Tower says CHANGE_PLAN, before re-execution |

Called via `handleTowerVerdict()` at these terminal paths:
- **ACCEPT** (L428): `postRunSummary` then `emitRunCompleted`
- **RETRY max exceeded** (L438): `postRunSummary` then `emitRunStopped`
- **RETRY exec fail** (L452): `postRunSummary` then `emitRunStopped`
- **RETRY → ACCEPT** (L470): `postRunSummary` then `emitRunCompleted`
- **RETRY → still bad** (L482): `postRunSummary` then `emitRunStopped`
- **RETRY → other** (L489): `postRunSummary` then `emitRunStopped`
- **CHANGE_PLAN max ver** (L499): `postRunSummary` then `emitRunStopped`
- **CHANGE_PLAN → replan fail** (L536): `postRunSummary` then `emitRunStopped`
- **CHANGE_PLAN → ACCEPT** (L551): `postRunSummary` then `emitRunCompleted`
- **CHANGE_PLAN → still bad** (L562): `postRunSummary` then `emitRunStopped`
- **STOP** (L576): `postRunSummary` then `emitRunStopped`
- **Unknown verdict** (L589): `postRunSummary` (no event emitter)

### B. Plan Executor (`server/supervisor/plan-executor.ts`)

| Line(s) | Artefact Type | Trigger |
|---------|---------------|---------|
| 264 | `step_result` | Step failed |
| 329 | `step_result` | Step succeeded |
| 355 | `leads_list` | SEARCH_PLACES step succeeded (pre-Tower) |
| 532 | `step_result` | Error artefact on catch |
| 563 | `step_result` | Fallback error artefact |

### C. Supervisor Chat Path (`server/supervisor.ts`)

| Line(s) | Method | Write Type | Trigger |
|---------|--------|------------|---------|
| 577 | `postArtefactToUI` | Remote POST | Zero-result SEARCH_PLACES (missing leads) |
| 652 | `postArtefactToUI` | Remote POST | Successful SEARCH_PLACES with leads |
| 680 | `createArtefact` | Local DB | Local leads_list artefact after successful SEARCH_PLACES |
| 807 | `postArtefactToUI` | Remote POST | `executeSupervisorWithChat` path |
| 841 | `createArtefact` | Local DB | leads_list in executeSupervisorWithChat |
| 946 | `postArtefactToUI` | Remote POST | Error path in generateLeadsForChat |
| 974 | `createArtefact` | Local DB | Error run_summary artefact |

### D. Debug Route (`server/routes.ts`)

| Line(s) | Write Type | Trigger |
|---------|------------|---------|
| 553 | Remote POST (inline fetch) | simulate-chat-task leads artefact |
| 747 | Remote POST (inline fetch) | simulate-chat-task zero-result artefact |

---

## 5) [ARTEFACT_WRITE] Log Line

Added to `server/supervisor/artefacts.ts` — the single `createArtefact` function all local DB writes pass through. Logs on every attempt:

```
[ARTEFACT_WRITE] run_id=<runId> type=<type> ok=true/false err=<message>
```

This covers all paths listed in section 4 that call `createArtefact()`.

For remote UI POSTs via `postArtefactToUI`, the existing `[ARTEFACT_POST]` log already covers success/failure with `runId`, `clientRequestId`, `status`, and `artefactId`.
