# Wyshbone Supervisor Suite

## Overview
Wyshbone Supervisor is a B2B lead generation system designed to identify and score prospects automatically based on user behavior and preferences. It provides real-time lead suggestions with contact information, delivered via email notifications and integrated chat within the Wyshbone UI. The system emphasizes high data density, workflow efficiency, and a Linear-inspired aesthetic, aiming to streamline lead generation, enhance sales processes, and expand market reach by delivering actionable insights to users.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
The frontend utilizes React, TypeScript, Vite, and Wouter for routing. Styling is managed with Tailwind CSS and custom design tokens, while UI components are built using `shadcn/ui` (Radix UI primitives) in a "New York" style variant, drawing inspiration from Linear's B2B design.

### Technical Implementations
- **Frontend**: React with TypeScript, Vite, Wouter, and TanStack Query for state management.
- **Backend**: Node.js with Express and TypeScript (ESM modules).
- **Data Storage**: PostgreSQL (Neon serverless) with Drizzle ORM for type-safe queries and migrations.
- **Lead Generation Logic**: Features conditional step execution, automatic fallback between data sources, and utilizes historical performance data. It supports a comprehensive plan execution pipeline with real-time tracking and concurrent execution.
- **Chat Integration**: Employs a queue-based architecture using shared Supabase tables for AI interaction within the Wyshbone UI, including intent-based routing for chat tasks.
- **Job Execution**: Manages background jobs such as nightly maintenance, Xero syncing, monitor checks, and lead generation, ensuring lifecycle management and overlap prevention.
- **Agentic Decision Loop**: Integrates with the Tower Judgement API to evaluate plan execution against success criteria, determining continuation or halting, specifically for `SEARCH_PLACES` operations with retry and plan adjustment mechanisms.
- **Logging**: A three-tier logging system (API, Executor, Tower Integration) is implemented for comprehensive monitoring, including structured logs for agent loop summaries, routing decisions, and artefact POST attempts.
- **Progress Tracking**: Utilizes an in-memory store for real-time tracking of concurrent plan executions.
- **Event System**: A Map-based registry per `planId` ensures isolated event streams during concurrent executions.
- **Deep Research**: A multi-provider research system (OpenAI, Perplexity, Anthropic, Fallback) generates reports based on user queries, posting them as artefacts.

### Feature Specifications
- RESTful API for managing leads, user context, signals, and plan execution, including endpoints for plan creation, approval, and progress monitoring.
- Supervisor APIs for executing plans, managing background jobs, and polling deep research runs.
- Database schema supports users, signals, suggested leads, plan executions, and plans.
- **ID Normalization (2026-02-10)**: All entry points now generate a `job_*` ID (via `generateJobId()` from `server/supervisor/jobs.ts`) as the canonical `runId`. The UI's original `run_id` is treated as `uiRunId` for external correlation only. `[ID_MAP]` log lines show the mapping at each entry point (`processChatTask`, `simulate-chat-task`, `executePlan`). `bridgeRunToUI()` notifies the UI of the `uiRunId ↔ jobId` mapping. `planId` remains authoritative for plan progress tracking (`updateStepStatus`, `failProgress`, `completeProgress`).
- Artefacts are posted for lead generation results and deep research reports, with specific types and payloads.
- **LEAD_FIND Intent Classification (2026-02-10)**: A hard rule fires BEFORE deep_research routing in all entry points. If a message contains lead-finding verbs (find/list/get/show) + venue business types (pub/bar/venue) + a location, the intent is classified as `lead_find` and routed to `SEARCH_PLACES`, never `DEEP_RESEARCH`. The `tool_dispatch_decision` AFR event includes `{ intent: 'lead_find', requested_count, parsed_location, chosen_tool, reason }`. `requested_count` is parsed from message and capped at 200. In `simulate-chat-task`, a `[LEAD_FIND_GUARD]` log is emitted when overriding `simulate_type=deep_research`.
- **DEEP_RESEARCH Opt-In (2026-02-10)**: DEEP_RESEARCH is only routed when the message contains explicit research keywords: research, investigate, analyse/analyze, summarise/summarize, summary, overview, report, sources, article(s), history, guide, best-of list. Without these keywords, requests default to SEARCH_PLACES. A `[DEEP_RESEARCH_GUARD]` log is emitted when blocking. A new `router_decision_detail` AFR event is logged with `{ intent, chosen_tool, reason, matched_keywords }` at both entry points (`simulate-chat-task` and `processChatTask`). A `router_override` AFR event is emitted with `{ original_tool, forced_tool: "SEARCH_PLACES", reason: "deep_research_opt_in_only"|"lead_find_priority", message }` whenever the gate overrides routing. Controlled by `DEEP_RESEARCH_OPT_IN_ONLY` env var (default `true`; set to `false` to disable the gate). The guard is enforced at the **router decision level** in three code paths: `server/routes.ts` (simulate-chat-task), `server/supervisor.ts` (processChatTask), and `server/supervisor/jobs.ts` (`startJob` — the initial router decision before any job is dispatched). The job-level guard in `runDeepResearchExecuteJob` has been removed; `startJob` blocks the job before it reaches the handler, making the old path unreachable. A `[ROUTER_SIGNATURE] DEEP_RESEARCH_GUARD_V1_ACTIVE` log with `entry=startJob` is emitted whenever a deep_research routing attempt is evaluated at the jobs API level.
- **Run Trace Report (2026-02-10)**: `GET /api/debug/run-trace?crid=...&runId=...` returns a JSON diagnostic report for a given run. Answers 6 supervisor findings: (1) did Supervisor receive the request, (2) plan summary (version, step count, tool names), (3) tool calls executed and artefacts created with ids/types, (4) per-artefact Tower call attempt (yes/no), (5) per Tower attempt: request payload summary, response status, verdict, (6) AFR events emitted (artefact_created, tower_call_started, tower_call_completed, tower_verdict) with timestamps. Returns `suspected_breakpoint` field: one of `tower_call_never_attempted`, `tower_call_failed`, `tower_return_missing_fields`, `tower_verdict_not_emitted`, `afr_emit_failed`, `all_good`. Resolves run by crid (via agent_runs table) or runId, with fallback to AFR metadata search. Protected by ENABLE_DEBUG_ENDPOINTS flag.
- **Tower Hard Gate for SEARCH_PLACES (2026-02-10)**: All SEARCH_PLACES runs (including `simulate-chat-task`) must create a `leads_list` artefact before calling `handleTowerVerdict`. `run_completed` is only emitted if Tower verdict = ACCEPT. Zero-results paths emit `run_stopped` instead of `plan_execution_finished` with `status: success`.

### System Design Choices
- An `IStorage` interface provides an abstraction layer for database operations.
- Robust logging infrastructure with structured logs and Tower integration.
- In-memory progress tracking and a Map-based event system ensure isolated and efficient handling of concurrent plan executions.
- Comprehensive error handling ensures proper status updates for failed plans.
- Artefact creation always precedes status events to ensure visibility.
- **Completion gating (2026-02-10)**: `run_completed` is never emitted without Tower approval for SEARCH_PLACES runs. All SEARCH_PLACES paths — including zero-results — route through `handleTowerVerdict` in `agent-loop.ts`. Tower verdict mapping: ACCEPT→`run_completed`, RETRY→rerun same plan, CHANGE_PLAN→generate plan v2, STOP→`run_stopped`. Error/fallback paths emit `run_stopped` (never `plan_execution_finished`) for SEARCH_PLACES runs.
- **Tower AFR Provability (2026-02-10)**: Every SEARCH_PLACES Tower call emits three AFR events in sequence: `tower_call_started` (before HTTP call, status=pending), `tower_call_completed` (after HTTP response, status=success/failed with `duration_ms`), and `tower_verdict` (parsed verdict with full metadata: verdict, delivered, requested, gaps, confidence, rationale, plan_version, run_id). A `tower_judgement` artefact (type=`tower_judgement`) is always created with verdict, delivered, requested, gaps, confidence, rationale, and plan_version. All events and artefacts use the same canonical `runId` (the `job_*` ID) for UI query consistency. Error/fallback Tower calls also emit `tower_call_completed` with `status=failed` and `http_ok=false`.
- **Live Activity clientRequestId threading (2026-02-10)**: `RunState` now carries `clientRequestId`. All Tower AFR events (`tower_call_started`, `tower_call_completed`, `tower_verdict`) and terminal events (`run_completed`, `run_stopped`) include `clientRequestId` in metadata, ensuring Live Activity can correlate them with the originating chat request. `initRunState` accepts optional `clientRequestId` at all call sites (`processChatTask`, `simulate-chat-task`, `executePlan`).
- **Tower 30s timeout (2026-02-10)**: `callTowerJudgeV1` uses `AbortController` with a 30-second timeout. On timeout, `obtainVerdict` returns `STOP` with `gaps=['tower_call_timed_out']` and rationale "Tower unavailable (timed out after 30s)". The `tower_call_completed` AFR event includes `timed_out=true`. This prevents UI hanging on "Awaiting Tower judgement".
- **TOWER_LOOP_CHAT_MODE (2026-02-11)**: Feature flag (`TOWER_LOOP_CHAT_MODE=true`) that routes all `lead_find` chat messages through the full Tower validation pipeline. When enabled, chat-originated lead requests bypass the normal plan execution flow and instead: (1) create an `agent_run`, (2) build a single-step SEARCH_PLACES plan, (3) execute Google Places search with deterministic stub fallback, (4) persist a `leads_list` artefact, (5) call Tower for judgement, (6) persist a `tower_judgement` artefact, (7) emit the complete AFR event chain (plan_execution_started → step_started → step_completed → artefact_created → tower_call_started → tower_verdict → run_completed/run_halted). Implemented in both `processChatTask` (server/supervisor.ts) and `simulate-chat-task` (server/routes.ts). Terminal states use DB-allowed values: `completed` for Tower pass, `stopped` for Tower halt/error. The chat response directs users to "View results in the dashboard."
- **Proof V2 Real Pipeline (2026-02-11)**: `POST /api/proof/tower-loop-v2` now uses the real `executeAction` pipeline (same code path as chat) instead of hardcoded inline leads. A new `SEARCH_PLACES_PROOF` tool in `server/supervisor/action-executor.ts` returns 10-15 deterministic fake leads shaped like real Google Places results, with no Google API calls. The proof route creates a 1-step plan, calls `executeAction({ toolName: 'SEARCH_PLACES_PROOF' })`, persists a `leads_list` artefact via `createArtefact`, calls Tower via `judgeArtefact`, persists a `tower_judgement` artefact, and emits the full AFR event chain: plan_execution_started → step_started → step_completed → artefact_created → tower_call_started → tower_verdict → run_completed. Response includes `pipeline: 'executeAction'` to confirm the real code path. `SEARCH_PLACES_PROOF` bypasses tool registry, intent gate, and routing checks in `executeAction` (proof tools are always allowed).

## External Dependencies

- **Supabase**: Shared database for Wyshbone UI and Supervisor, storing user profiles, conversations, facts, monitors, deep research runs, integrations, and user signals.
- **Resend**: Transactional email service for lead notification emails.
- **Google Places API**: Used for finding business locations and enriching lead data.
- **Hunter.io**: Email discovery service.
- **Radix UI**: Provides accessible, unstyled primitive UI components.
- **shadcn/ui**: Component library built on Radix UI.
- **PostgreSQL (Neon)**: Serverless relational database.
- **Drizzle ORM**: Type-safe ORM.
- **Vite**: Frontend build tool.
- **Wouter**: Lightweight client-side router.
- **TanStack Query**: For server state management and caching.
- **Tailwind CSS**: Utility-first CSS framework.
- **Zod**: Runtime schema validation library.
- **Tower Judgement API**: External service for agentic decision-making and evaluation.
- **OpenAI API**: Used for deep research via the Responses API with web search capabilities.
- **Perplexity API**: Used for deep research with `llama-3.1-sonar-large-128k-online`.
- **Anthropic API**: Used for deep research with Claude models.