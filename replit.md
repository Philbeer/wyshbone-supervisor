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
- ID normalization uses `job_*` IDs as the canonical `runId`, with `uiRunId` for external correlation.
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
- `TOWER_LOOP_CHAT_MODE`: Feature flag that routes all `lead_find` chat messages through the full Tower validation pipeline, including `agent_run` creation, single-step `SEARCH_PLACES` plan execution, `leads_list` artefact persistence, Tower judgment, and full AFR event chain.
- Proof V2 Real Pipeline: The `POST /api/proof/tower-loop-v2` endpoint now uses the real `executeAction` pipeline with a `SEARCH_PLACES_PROOF` tool that returns deterministic fake leads, bypassing Google API calls for testing purposes.
- Tower Judgement in Normal Chat Runs: When `TOWER_LOOP_CHAT_MODE` is enabled, the `generateLeadsForChat` flow calls `judgeArtefact` immediately after `leads_list` persistence, handling Tower verdicts and errors.
- Plan Executor Per-Step Tower Judgement: The plan executor calls Tower via `judgeArtefact` after every step completes. Each step runs in a bounded retry/replan inner loop: Tower can return CONTINUE (proceed to next step, mark completed), RETRY (re-run same step with same args, max 2 retries per step), CHANGE_PLAN (adjust args via `buildAdjustedArgs` and re-run, max 2 plan versions total), or STOP (halt plan immediately). Step completion (`stepsCompleted++`, `logStepCompleted`) only occurs after Tower confirms CONTINUE, preventing inflated progress counts on retries/replans. For SEARCH_PLACES steps, the `leads_list` artefact is judged (preferred over `step_result`). The redundant snapshot-based `requestJudgement()` call (from `tower-judgement.ts`) has been removed. AFR events are emitted for each reaction type (`supervisor_reaction`) with metadata including reaction type, step index, retry count, plan version, and reasons. The end-of-run safety net still runs for lead runs where Tower was never called during steps.
- `ENABLE_TOWER_DURING_RUN` Feature Flag (default: `false`): When `true`, Tower judgement is fully synchronous and sequence-true — no backfill, no polling, no after-run lookups. Each step follows a strict sequence: `STEP_RESULT_WRITTEN -> TOWER_CALLED -> TOWER_JUDGEMENT_WRITTEN -> REACTION_TAKEN` with timestamped logs. Tower failures are fatal: an error artefact is persisted, the run is marked `failed`, and no "pretend" verdicts are issued. STOP produces a `run_stopped` artefact with reason. The backfill poller in `supervisor.ts` is automatically disabled when this flag is `true`. The manual `request-judgement` endpoint remains available but is not part of the synchronous run sequence. `plan_result` artefact is only created after all steps finish successfully.
- Manual Request Judgement: `POST /api/supervisor/request-judgement` accepts `{ runId, crid?, conversationId?, goal?, userId? }`, locates the latest `leads_list` artefact for that run, emits `tower_call_started` AFR, calls `judgeArtefact`, persists `tower_judgement` artefact, emits `tower_verdict` AFR, and returns `{ ok, tower_judgement_artefact_id, verdict, action, stubbed }`. Handles Tower errors by persisting error artefacts and emitting error verdict AFR events.
- ID Alignment Fix: Both `simulate-chat-task` (debug) and `processChatTask` (production polling) now use `uiRunId` (the `run_id` sent by the UI) as the canonical run ID for all artefact storage, agent run creation, and AFR logging. Previously, a separate `jobId`/`chatRunId` was generated via `generateJobId()`, causing a mismatch where Tower judgement artefacts were stored under an ID the UI couldn't query. This was the root cause of Tower judgement not appearing automatically in the UI.
- Tower Judgement Backfill Poller: The Supervisor polls Supabase `agent_runs` every cycle (alongside signal/task/goal processing). For each recently completed run (last 5 min) that has a `leads_list` artefact but no `tower_judgement`, it automatically calls Tower judgement and inserts the `tower_judgement` artefact directly into Supabase's `artefacts` table. This covers runs created by the UI's own backend (which bypasses `supervisor_tasks` and doesn't call Tower). The poller is idempotent — it skips runs that already have a `tower_judgement` artefact.

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
- **2026-02-12**: Step-level observation-only Tower judgement. After every tool call completes in `server/supervisor/plan-executor.ts`, the system now unconditionally (no feature flags): (1) writes a `step_result` artefact to Supabase, (2) calls Tower to judge that `step_result`, (3) writes a `tower_judgement` artefact with `observation_only: true` in the payload. The verdict is logged (`[STEP_OBSERVATION]`) but never branched on — no retries, plan changes, or stopping result from these observation judgements. If the Tower call fails, the error is logged and the run continues unaffected. The existing conditional judgement flow (`shouldJudge`, `judgeStepResultSync`, reaction switch) and end-of-run judgement (safety net, `plan_result`) remain completely unchanged.
- **2026-02-12**: Added per-step `step_result` artefacts written to Supabase after every completed plan step (success or fail). Both the supervisor plan executor (`server/supervisor/plan-executor.ts`) and the legacy plan executor (`server/plan-executor.ts`) now create these artefacts. Additionally, the three UI-triggered chat executor flows in `server/supervisor.ts` — `executeTowerLoopChat`, `generateLeadsForChat`, and `executeDeepResearchForChat` — now also emit `step_result` artefacts. Payloads include `run_id`, `client_request_id`, `goal`, `plan_version`, `step_id`, `step_title`, `step_type`, `step_index`, `step_status`, `inputs_summary` (redacted), `outputs_summary`, `outputs_raw` (size-gated at 50k chars, whitelisted fields only for leads to prevent contact info leakage), `outputs_raw_omitted` flag, and `timings` (started_at, finished_at, duration_ms). Feature flag: `ENABLE_STEP_ARTEFACTS` (default: `true`). This flag does NOT affect judgement or any existing behaviour. Secret keys are redacted from inputs/outputs. Helper functions (`isStepArtefactsEnabled`, `redactRecord`, `safeOutputsRaw`, `compactInputs`) are exported from `server/supervisor/plan-executor.ts` for reuse across executors.