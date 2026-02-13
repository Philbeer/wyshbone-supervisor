# Wyshbone Supervisor Suite

## Overview
Wyshbone Supervisor is a B2B lead generation system designed for automatic prospect identification and scoring. It delivers real-time lead suggestions with contact information via email and an integrated chat within the Wyshbone UI. The system aims to enhance sales processes and expand market reach by providing actionable, high-density data and promoting workflow efficiency with a Linear-inspired design.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
The frontend uses React, TypeScript, Vite, and Wouter for routing. Styling is managed with Tailwind CSS and custom design tokens. UI components are built using `shadcn/ui` (Radix UI primitives) in a "New York" style variant, drawing inspiration from Linear's B2B design.

### Technical Implementations
- **Frontend**: React with TypeScript, Vite, Wouter, and TanStack Query.
- **Backend**: Node.js with Express and TypeScript (ESM modules).
- **Data Storage**: PostgreSQL (Neon serverless) with Drizzle ORM.
- **Lead Generation Logic**: Features conditional step execution, automatic data source fallback, and utilizes historical performance data within a comprehensive, real-time tracking, concurrent execution pipeline.
- **Chat Integration**: Employs a queue-based architecture using shared Supabase tables for AI interaction, including intent-based routing for chat tasks.
- **Job Execution**: Manages background tasks such as nightly maintenance, Xero syncing, monitoring, and lead generation with lifecycle management and overlap prevention.
- **Agentic Decision Loop**: Integrates with the Tower Judgement API to evaluate plan execution against success criteria, determining continuation or halting, especially for `SEARCH_PLACES` operations with retry and plan adjustment mechanisms.
- **Logging**: A three-tier logging system (API, Executor, Tower Integration) provides comprehensive monitoring, including structured logs for agent loop summaries, routing decisions, and artefact POST attempts.
- **Progress Tracking**: Uses an in-memory store for real-time tracking of concurrent plan executions.
- **Event System**: A Map-based registry per `planId` ensures isolated event streams during concurrent executions.
- **Deep Research**: A multi-provider research system (OpenAI, Perplexity, Anthropic, Fallback) generates reports based on user queries, posted as artefacts.

### Feature Specifications
- RESTful API for managing leads, user context, signals, and plan execution, including endpoints for plan creation, approval, and progress monitoring.
- Supervisor APIs for executing plans, managing background jobs, and polling deep research runs.
- Database schema supports users, signals, suggested leads, plan executions, and plans.
- ID normalization uses the UI-provided `run_id` (or a generated UUID) as the canonical `runId` for all artefacts, agent runs, and AFR logging.
- Artefacts are posted for lead generation results and deep research reports.
- `LEAD_FIND` Intent Classification: Routes messages containing lead-finding verbs, business types, and locations to `SEARCH_PLACES`, overriding `DEEP_RESEARCH`.
- `DEEP_RESEARCH` Opt-In: Requires explicit research keywords in messages for `DEEP_RESEARCH` routing; otherwise, requests default to `SEARCH_PLACES`.
- Run Trace Report: A debug endpoint (`GET /api/debug/run-trace`) provides a JSON diagnostic report for a given run, detailing supervisor interactions, plan summaries, tool calls, Tower attempts, and AFR events.
- Tower Hard Gate for `SEARCH_PLACES`: All `SEARCH_PLACES` runs must create a `leads_list` artefact before calling `handleTowerVerdict`; `run_completed` is emitted only if Tower verdict is `ACCEPT`. Zero-result paths emit `run_stopped`.

### System Design Choices
- An `IStorage` interface provides an abstraction layer for database operations.
- Robust logging infrastructure with structured logs and Tower integration.
- In-memory progress tracking and a Map-based event system for isolated and efficient handling of concurrent plan executions.
- Comprehensive error handling ensures proper status updates for failed plans.
- Artefact creation always precedes status events.
- Completion gating ensures `run_completed` is never emitted without Tower approval for `SEARCH_PLACES` runs, with different verdicts mapping to `run_completed`, retry, change plan, or `run_stopped`.
- Tower AFR Provability: Every `SEARCH_PLACES` Tower call emits `tower_call_started`, `tower_call_completed`, and `tower_verdict` AFR events, along with a `tower_judgement` artefact.
- Live Activity `clientRequestId` threading: `RunState` carries `clientRequestId`, which is included in all Tower AFR and terminal events for correlation with originating chat requests.
- Tower 30s timeout: `callTowerJudgeV1` uses an `AbortController` with a 30-second timeout, returning `STOP` on timeout to prevent UI hangs.
- Supervisor-Only Execution: ALL execution flows through the Supervisor (`executeTowerLoopChat` or plan executor via `supervisor_tasks` queue). No inline execution endpoints exist — `demo-plan-run`, `proof/tower-loop`, and `proof/tower-loop-v2` have been deleted. Debug endpoints are enqueue-only (`simulate-chat-task`).
- Mandatory Inline Tower Observation: After every tool call completes, the system unconditionally (no feature flags): (1) writes a `step_result` artefact to Supabase, (2) calls Tower to judge that `step_result`, (3) writes a `tower_judgement` artefact with `observation_only: true`. The `ENABLE_TOWER_DURING_RUN` flag has been removed — inline observation is always-on. Tower failures are fatal: an error artefact is persisted, the run is marked `failed`, and no fallback verdicts are issued.
- Plan Executor Per-Step Tower Judgement: The plan executor calls Tower via `judgeArtefact` after every step completes. Each step runs in a bounded retry/replan inner loop: Tower can return CONTINUE (proceed to next step, mark completed), RETRY (re-run same step with same args, max 2 retries per step), CHANGE_PLAN (adjust args via `buildAdjustedArgs` and re-run, max 2 plan versions total), or STOP (halt plan immediately). Step completion (`stepsCompleted++`, `logStepCompleted`) only occurs after Tower confirms CONTINUE. The plan executor requires a `jobId` — missing jobId is a fatal error (throws immediately).
- No Safety Nets: The `ensureTowerJudgement` safety net has been removed. If inline observation didn't run, the run is flagged rather than patched.
- Bypass Detector: The former backfill poller now only detects runs that bypassed the Supervisor. If a completed run has `leads_list` artefacts but no `step_result`, a `run_bypassed_supervisor` artefact is created to flag the bug. No backfilling of `step_result` or `tower_judgement` occurs.
- Manual Request Judgement: `POST /api/supervisor/request-judgement` accepts `{ runId, crid?, conversationId?, goal?, userId? }`, locates the latest `leads_list` artefact for that run, emits `tower_call_started` AFR, calls `judgeArtefact`, persists `tower_judgement` artefact, emits `tower_verdict` AFR, and returns `{ ok, tower_judgement_artefact_id, verdict, action, stubbed }`. Handles Tower errors by persisting error artefacts and emitting error verdict AFR events.
- ID Alignment Fix: Both `simulate-chat-task` (debug) and `processChatTask` (production polling) now use `uiRunId` (the `run_id` sent by the UI) as the canonical run ID for all artefact storage, agent run creation, and AFR logging.

## External Dependencies

- **Supabase**: Shared database for user profiles, conversations, facts, monitors, deep research runs, integrations, and user signals.
- **Resend**: Transactional email service.
- **Google Places API**: For business locations and lead data enrichment.
- **Hunter.io**: Email discovery service.
- **Radix UI**: Accessible, unstyled primitive UI components.
- **shadcn/ui**: Component library built on Radix UI.
- **PostgreSQL (Neon)**: Serverless relational database.
- **Drizzle ORM**: Type-safe ORM.
- **Vite**: Frontend build tool.
- **Wouter**: Lightweight client-side router.
- **TanStack Query**: Server state management and caching.
- **Zod**: Runtime schema validation.
- **Tower Judgement API**: External service for agentic decision-making.
- **OpenAI API**: For deep research via Responses API.
- **Perplexity API**: For deep research with `llama-3.1-sonar-large-128k-online`.
- **Anthropic API**: For deep research with Claude models.

## Recent Changes
- **2026-02-13**: Fixed critical ID mismatch: The `supervisor_tasks` table has top-level `run_id` and `client_request_id` columns (set by the UI), separate from `request_data`. The supervisor was only reading from `request_data` (which the UI doesn't populate), causing all artefacts/agent_runs to be stored under wrong IDs. Fix: ID resolution now follows precedence chain: top-level column → `request_data` → task.id fallback. Applied to `processChatTask`, `evaluateAndRecoverTask`, and all recovery/sweep queries.
- **2026-02-13**: Resilient ID handling: `processChatTask` auto-generates deterministic `run_id` (= task.id) and `client_request_id` (= `crid_${task.id}`) when the UI omits them from `request_data`. Generated IDs are persisted back to `supervisor_tasks.request_data` so recovery/retry uses consistent IDs. `evaluateAndRecoverTask` uses the same deterministic fallback instead of failing. `executeTowerLoopChat` handles duplicate agent_run inserts (pkey or crid unique constraint) by updating the existing record.
- **2026-02-13**: Supervisor task recovery system: (1) Startup recovery (`recoverOrphanedTasks`) resets tasks stuck in "processing" to "pending" with agent_run reconciliation. (2) Periodic stale sweep (`sweepStaleTasks`) catches tasks stuck >5min during runtime. (3) Double-execution guard skips requeue if run already completed with artefacts (leads_list + step_result + tower_judgement). (4) Max 3 recovery attempts per task with metadata tracking in agent_run. (5) AFR audit events for all recovery actions (task_recovered, task_recovery_skipped, task_recovery_exhausted). (6) `created_at` column uses bigint epoch milliseconds for stale sweep cutoff queries.
- **2026-02-13**: Removed all safety nets and backfill mechanisms. Deleted `ensureTowerJudgement` safety net — inline observation is mandatory and any bypass is flagged, not patched. The former backfill poller is now a bypass detector (`flagBypassedRuns`) that creates `run_bypassed_supervisor` artefacts when runs have `leads_list` but no `step_result`.
- **2026-02-13**: Deleted inline executor debug endpoints (`demo-plan-run`, `proof/tower-loop`, `proof/tower-loop-v2`). All execution must go through the `supervisor_tasks` queue. Only enqueue-only debug endpoints remain (`simulate-chat-task`).
- **2026-02-13**: Removed `ENABLE_TOWER_DURING_RUN` feature flag — inline Tower observation is now always-on with no dual-mode branching. Tower failures are fatal (error artefact persisted, run marked failed).
- **2026-02-13**: Plan executor now requires `jobId` — missing jobId throws immediately instead of falling back to generated ID. Removed unused `generateJobId` import.
- **2026-02-13**: Fixed plan approval → plan executor runId mismatch. The `POST /api/plan/approve` endpoint now: (1) Accepts optional `run_id` and `client_request_id` from the request body. (2) Creates an `agent_run` record with the run ID (generated UUID if not provided). (3) Passes `jobId` and `clientRequestId` to `startPlanExecutionAsync`, ensuring the plan executor uses the correct run ID for all artefacts instead of generating its own `job_*` ID. (4) Returns `runId` and `clientRequestId` in the response.
- **2026-02-13**: Supervisor simplified to pure execution engine. Removed ~2,000 lines of dead/redundant code. The supervisor now follows a clean flow: poll → receive task → `executeTowerLoopChat` → persist outputs → mark complete.
- **2026-02-13**: Supervisor-first routing: ALL chat messages now go directly through the supervisor's plan-based execution (`executeTowerLoopChat`). The `TOWER_LOOP_CHAT_MODE` feature flag has been removed — the plan path is always used.