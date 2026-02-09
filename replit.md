# Wyshbone Supervisor Suite

## Overview
Wyshbone Supervisor is a proactive B2B lead generation system that automatically identifies and scores prospects based on user behavior and preferences. It provides real-time lead suggestions with contact information, delivering insights via email notifications and direct chat integration within the Wyshbone UI. The system is designed for high data density and workflow efficiency, featuring a Linear-inspired aesthetic. It integrates with the Wyshbone UI application through a shared Supabase database.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
The frontend is a React with TypeScript application built with Vite, using Wouter for routing. Styling is handled by Tailwind CSS with custom design tokens. The UI components are built on `shadcn/ui` (Radix UI primitives) in a "New York" style variant, inspired by Linear's B2B design.

### Technical Implementations
- **Frontend**: React with TypeScript, Vite, Wouter, and TanStack Query for server state management.
- **Backend**: Node.js with Express and TypeScript, utilizing ESM modules.
- **Data Storage**: PostgreSQL (via Neon serverless) managed with Drizzle ORM for type-safe queries and migrations.
- **Lead Generation Logic**:
    - Supports conditional step execution and automatic fallback between ordered data sources based on runtime results.
    - Utilizes historical performance data of past plan executions to inform future planning decisions, ensuring user and account isolation.
    - Features a comprehensive plan execution pipeline from creation and approval to real-time progress tracking, supporting concurrent executions.
- **Chat Integration**: Uses a queue-based architecture with shared Supabase tables (`messages`, `supervisor_tasks`) for seamless AI interaction within the Wyshbone UI chat.
- **Job Execution**: Handles all long-running background jobs, including nightly maintenance, Xero syncing, monitor checks, and lead generation execution, with lifecycle management and overlap prevention.
- **Agentic Decision Loop**: Integrates with the Tower Judgement API to evaluate plan execution against success criteria after each step, determining whether to continue or halt execution based on verdicts.
- **Logging**: Implements a three-tier logging system (API, Executor, Tower Integration) for monitoring and debugging.
- **Progress Tracking**: Uses an in-memory store keyed by `planId` for real-time progress tracking of concurrent plan executions.
- **Event System**: Employs a Map-based registry per `planId` for isolated event streams during concurrent plan executions.

### Feature Specifications
- RESTful API for managing leads, user context, signals, and plan execution.
- API endpoints for plan creation, approval, and real-time progress monitoring.
- Supervisor APIs for executing plans, managing background jobs, and polling deep research runs.
- Database schema supports users, signals, suggested leads, plan executions, and plans.

### System Design Choices
- `IStorage` interface provides an abstraction layer for database operations.
- Robust logging infrastructure with structured logs and Tower integration.
- In-memory progress tracking and a Map-based event system ensure isolated and efficient handling of concurrent plan executions.
- Comprehensive error handling ensures proper status updates for failed plans.

## External Dependencies

- **Supabase**: Shared database for Wyshbone UI and Supervisor, storing user profiles, conversations, facts, monitors, deep research runs, integrations, and user signals. Used for polling signals and chat task management.
- **Resend**: Transactional email service for sending lead notification emails.
- **Google Places API**: Used for finding business locations and enriching lead data.
- **Hunter.io**: Email discovery service for populating `emailCandidates` for leads.
- **Radix UI**: Provides accessible, unstyled primitive UI components.
- **shadcn/ui**: Component library built on Radix UI.
- **PostgreSQL (Neon)**: Serverless relational database.
- **Drizzle ORM**: Type-safe ORM for database interactions.
- **Vite**: Frontend build tool and development server.
- **Wouter**: Lightweight client-side router.
- **TanStack Query**: For server state management and caching.
- **Tailwind CSS**: Utility-first CSS framework.
- **Zod**: Runtime schema validation library.
- **Tower Judgement API**: External service for agentic decision-making and evaluation of plan execution.

## DATABASE RULES (NON-NEGOTIABLE)

This project uses a **dual database** setup. These rules are absolute:

| Database | Env Var | Purpose |
|---|---|---|
| **Supabase** | `SUPABASE_DATABASE_URL` | Production source of truth. ALL persistent tables live here. |
| **Replit dev DB** | `DATABASE_URL` | Local dev only. Used by `drizzle-kit` for schema diffing. Never receives real schema. |

### Migration Rules
- **ALWAYS** use `npm run db:migrate:supabase` for creating or altering tables.
- **NEVER** use `drizzle-kit push` (`npm run db:push`) for real schema changes — it targets the Replit dev DB.
- The migration script (`server/scripts/migrate-supabase.ts`) has built-in safety guards: it refuses to run unless the DB host contains "supabase" or `CONFIRM_SUPABASE_MIGRATE=true` is set.
- Add new migrations to the `migrations` array in `server/scripts/migrate-supabase.ts`.

### Runtime Rules
- `server/db.ts` connects **only** to `SUPABASE_DATABASE_URL`. If it is missing, the server crashes immediately.
- On startup, the server logs the active DB host so you can confirm the correct database is connected.
- The `execute_sql_tool` in Replit targets `DATABASE_URL` (local dev DB), **NOT** Supabase. Use `psql "$SUPABASE_DATABASE_URL"` for Supabase inspection.

## Recent Changes

### 2026-02-09: Chat Run Outputs — Artefacts + run_completed
- **`logRunCompleted()`**: New AFR logger function emits `run_completed` events with summary + metadata (lead count, tool used).
- **Chat path (supervisor.ts)**: `generateLeadsForChat()` now creates a `leads` artefact with normalized lead data (name, address, phone, website, place_id, score, emailCandidates) and emits `run_completed` after leads are persisted. Fire-and-forget with `.catch()`.
- **simulate-chat-task (routes.ts)**: Updated to request richer Places fields (websiteUri, nationalPhoneNumber, internationalPhoneNumber), create artefacts, and emit `run_completed`. Returns normalized leads array instead of just names.
- **`GET /api/afr/artefacts?run_id=`**: New query-param endpoint for fetching artefacts by run ID (alongside existing path-param `/api/afr/runs/:runId/artefacts`).
- **SSE mapping**: `run_completed` mapped in AFR stream; Activity.tsx renders with CheckCircle2 icon in green.
- **Full event chain**: mission_received → router_decision (SEARCH_PLACES) → tool_call_started → tool_call_completed → artefact_created → run_completed.
- **Files**: `server/supervisor/afr-logger.ts`, `server/supervisor.ts`, `server/routes.ts`, `client/src/pages/Activity.tsx`

### 2026-02-08: Hard Gating for SEARCH_WYSHBONE_DB
- **Env flag `WYSHBONE_DB_READY`** (default `false`): When false, SEARCH_WYSHBONE_DB is force-disabled at boot and hidden from planning prompts. Set to `true` only when the Wyshbone internal DB is populated and ready.
- **Intent gating** (`isHospitalityQuery()` + `checkIntentGate()`): Even when WYSHBONE_DB_READY=true, SEARCH_WYSHBONE_DB is only allowed for pub/bar/brewery/hospitality queries. Non-hospitality queries (hat shops, pet shops, restaurants, retail) are always blocked.
- **Three-layer enforcement**:
  1. **Planning layer** (task-interpreter.ts): Prompt excludes disabled tools; Claude selections validated via `checkIntentGate()` before returning. Fallback `guardToolCall()` also validates intent. Rejected tools auto-replan to SEARCH_PLACES.
  2. **Execution layer** (action-executor.ts): `isToolEnabled()` + `checkIntentGate()` checked before execution. Rejected SEARCH_WYSHBONE_DB calls auto-replan to SEARCH_PLACES with the same query/location.
  3. **Registry layer** (tool-registry.ts): `applyEnvOverrides()` at boot reads WYSHBONE_DB_READY and force-disables the tool. Routing rules provide a final keyword check.
- **Rejection logging**: All rejections produce `[ACTION_EXECUTOR] REJECTED tool=X reason="..."` or `[TASK_INTERPRETER] REJECTED tool=X reason="..."` log lines.
- **Hospitality keywords**: pub, pubs, bar, bars, brewery, breweries, tavern, inn, landlord, hospitality, ale, beer garden, taproom, gastropub, freehouse, public house.
- **Debug endpoint updates**: `GET /api/debug/tool-registry` now shows `gating.WYSHBONE_DB_READY` flag value and sample intent checks.
- **Files**: `server/supervisor/tool-registry.ts`, `server/supervisor/action-executor.ts`, `server/services/task-interpreter.ts`, `server/routes.ts`


### 2026-02-07: Step Artefacts + Tower Judgement + Supervisor Reaction
- **Step artefacts**: At the end of each completed step, a `step_result` artefact is created with goal, step_id, step_title, step_index, step_status, outputs, and timestamps. Both successful and failed steps produce artefacts.
- **Tower artefact judgement**: After each step artefact, Tower is called via `POST /api/tower/judge-artefact` to judge the artefact. Response: `{ verdict, reasons[], metrics{}, action }` where action in `["continue","stop","retry","change_plan"]`.
- **Stub mode**: If `TOWER_BASE_URL` / `TOWER_URL` is not set, or `TOWER_ARTEFACT_JUDGE_STUB=true`, the judge returns `{ verdict:"pass", action:"continue" }` automatically. This is the current default.
- **tower_judgements table**: Created in Supabase via `db:migrate:supabase`. Fields: id, run_id, artefact_id, verdict, action, reasons_json, metrics_json, created_at.
- **Storage methods**: `createTowerJudgement()`, `getTowerJudgementsByRunId()` added.
- **AFR events**: `artefact_created` and `tower_judgement` events are emitted and interleaved in Live Activity. Tower judgement metadata includes artefactId, verdict, action, shortReason, stubbed flag.
- **Supervisor reaction**: If Tower action is "stop" or verdict is "fail", execution halts cleanly. If Tower call fails, a warning is logged and execution continues.
- **Testing**: Run a demo execution (POST `/api/debug/demo-plan-run`). Check Supabase for `step_result` rows in `artefacts` and corresponding rows in `tower_judgements`. Live Activity shows interleaved `artefact_created` + `tower_judgement` events.
- **Files**: `server/supervisor/tower-artefact-judge.ts` (client+stub), `server/supervisor/plan-executor.ts` (wiring), `shared/schema.ts` + `server/storage.ts` (tower_judgements schema/storage)

### 2026-02-07: Artefact Persistence & Creation
- Added `artefacts` table to `shared/schema.ts` with fields: id (uuid), run_id, type, title, summary, payload_json (jsonb), created_at
- Added `createArtefact`, `getArtefactsByRunId`, `getArtefact` storage methods
- Created `server/supervisor/artefacts.ts` helper: inserts artefact row and emits `artefact_created` AFR event with artefactId, type, title, summary in metadata
- Wired artefact creation into `server/supervisor/plan-executor.ts` at end of successful plan execution (wrapped in try/catch so failures don't crash the run)
- Artefact type is generic `plan_result`, payload includes goal, step summaries, and run stats
- Live Activity shows "Artefact created: <title>" via AFR; AFR rows include artefact_id in metadata

### 2026-02-07: AFR Stream Endpoint & Live Activity Page
- Created GET `/api/afr/stream` SSE endpoint that polls `agent_activities` table and streams events to the frontend
- Event mapping supports: `plan_execution_started`, `plan_execution_completed`, `plan_execution_failed`, `step_started:*`, `step_completed:*`, `step_failed:*` (prefixed and unprefixed forms)
- Preserves original `task_generated` text as event summary — no overwriting
- Created `/activity` page (`client/src/pages/Activity.tsx`) with "Run Supervisor Demo" button and real-time SSE event display
- Added "Live Activity" to sidebar navigation with Radio icon
- Enforced Supabase-only database: removed `DATABASE_URL` fallback from `db.ts` and 5 service files (`wabs-scorer`, `wabs-feedback`, `task-executor`, `memory-writer`, `memory-reader`)

### 2026-02-06: Agent Run Tracking for AFR Runs List
- Added `agentRuns` table definition to `shared/schema.ts` matching the Supabase DB schema (bigint for `created_at`/`updated_at`/`last_event_at`, timestamptz for `started_at`/`ended_at`)
- Added `createAgentRun`, `updateAgentRun`, `getAgentRuns` storage methods in `server/storage.ts`
- Added GET `/api/afr/runs` endpoint to return agent runs from the database
- Updated POST `/api/debug/demo-plan-run` to create an `agent_runs` row on start and update it on completion/halt/failure
- Fixed Supabase DB trigger `set_updated_at()` — was using `now()` (timestamp) for a bigint column, causing all UPDATEs to fail. Changed to `(extract(epoch from now()) * 1000)::bigint`. Migration script: `migrations/001_fix_set_updated_at_trigger.sql`
- **Important**: The `execute_sql_tool` queries the Replit DATABASE_URL, NOT the Supabase DB. Use `psql "$SUPABASE_DATABASE_URL"` for Supabase schema inspection.