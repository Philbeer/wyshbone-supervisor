# Wyshbone Supervisor Suite

## Overview
Wyshbone Supervisor is a B2B lead generation system designed to identify and score prospects automatically based on user behavior and preferences. It provides real-time lead suggestions with contact information, delivered via email notifications and integrated chat within the Wyshbone UI. The system emphasizes high data density, workflow efficiency, and a Linear-inspired aesthetic, integrating with the Wyshbone UI application through a shared Supabase database. Its purpose is to streamline lead generation, enhance sales processes, and expand market reach by delivering actionable insights to users.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
The frontend is built with React, TypeScript, Vite, and Wouter for routing. Styling uses Tailwind CSS with custom design tokens, and UI components are based on `shadcn/ui` (Radix UI primitives) in a "New York" style variant, inspired by Linear's B2B design aesthetic.

### Technical Implementations
- **Frontend**: React with TypeScript, Vite, Wouter, and TanStack Query.
- **Backend**: Node.js with Express and TypeScript (ESM modules).
- **Data Storage**: PostgreSQL (Neon serverless) with Drizzle ORM for type-safe queries and migrations.
- **Lead Generation Logic**: Supports conditional step execution, automatic fallback between data sources, and utilizes historical performance data for planning. Features a comprehensive plan execution pipeline with real-time tracking and concurrent execution support.
- **Chat Integration**: Employs a queue-based architecture with shared Supabase tables (`messages`, `supervisor_tasks`) for AI interaction within the Wyshbone UI.
- **Job Execution**: Manages all long-running background jobs, including nightly maintenance, Xero syncing, monitor checks, and lead generation, with lifecycle management and overlap prevention.
- **Agentic Decision Loop**: Integrates with the Tower Judgement API to evaluate plan execution against success criteria after each step, determining continuation or halting.
- **Logging**: Three-tier logging system (API, Executor, Tower Integration) for monitoring.
- **Progress Tracking**: Uses an in-memory store for real-time progress tracking of concurrent plan executions.
- **Event System**: Map-based registry per `planId` for isolated event streams during concurrent executions.

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

## Recent Changes

### 2026-02-09: Canonical UI RunId + Required Identifiers + Run Bridge
- **Required identifiers**: `request_data.run_id` (UI canonical runId) and `request_data.client_request_id` are REQUIRED. If either is missing, Supervisor emits `artefact_post_failed` with `errorCode: 'missing_identifiers'`, marks the task as failed, and aborts. No fallback IDs are generated.
- **Canonical UI runId**: All artefact POSTs use `request_data.run_id` as the `runId` field. Supervisor internal IDs (e.g. deep research run IDs) are kept in metadata only, never used as the artefact runId.
- **Run bridge**: `bridgeRunToUI(uiRunId, supervisorRunId, clientRequestId?)` calls `POST UI_URL/api/afr/run-bridge` with `{ runId, supervisorRunId, clientRequestId? }` to link supervisor internal IDs with the UI canonical runId. Log line: `[RUN_BRIDGE] uiRunId=<...> supervisorRunId=<...> status=<HTTP>`.
- **Canonical artefact body**: POSTs to `UI_URL/api/afr/artefacts` with `{ runId, clientRequestId, type, payload: { title, summary, leads, query: { businessType, location, country }, tool: "SEARCH_PLACES" }, createdAt }`.
- **Normalized leads**: Each lead in the payload includes `name`, `address`, `phone` (string|null), `website` (string|null), `placeId`, `source: "google_places"`, `score` (number|null).
- **Gated events**: `artefact_created` and `run_completed` are ONLY emitted after POST returns 2xx and `artefactId` is parsed from the response.
- **Observability**: `[ARTEFACT_POST] runId=<...> clientRequestId=<...> status=<HTTP> hasArtefactId=<bool> artefactId=<...>` — one line per POST attempt. `[SUPERVISOR] ... uiRunId=<...> clientRequestId=<...>` for task processing.
- **artefact_post_succeeded**: Emitted inside `postArtefactToUI` when POST returns 2xx and response contains `artefactId`. Metadata: `{ runId, artefactId }`.
- **artefact_post_failed**: Emitted for all failure paths: missing identifiers, non-2xx, missing artefactId, network error, UI_URL missing. Metadata: `{ runId, status, hasBody, errorCode }`. No secrets, no PII.
- **simulate-chat-task**: Requires `run_id` and `client_request_id` in request body (returns 400 if missing). Mirrors the real path with canonical body and gated events.
- **Files**: `server/supervisor.ts`, `server/types/supervisor-chat.ts`, `server/routes.ts`