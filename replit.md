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