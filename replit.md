# Wyshbone Supervisor Suite

## Overview
Wyshbone Supervisor is a B2B lead generation system designed for automatic prospect identification and scoring. It delivers real-time lead suggestions with contact information via email and an integrated chat. The system aims to enhance sales processes and expand market reach by providing actionable, high-density data and promoting workflow efficiency.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
The frontend uses React, TypeScript, Vite, and Wouter, with styling managed by Tailwind CSS and custom design tokens. UI components are built with `shadcn/ui` (Radix UI primitives) in a "New York" style variant, inspired by Linear's B2B design.

### Technical Implementations
- **Frontend**: React with TypeScript, Vite, Wouter, and TanStack Query.
- **Backend**: Node.js with Express and TypeScript (ESM modules).
- **Data Storage**: PostgreSQL (Neon serverless) with Drizzle ORM.
- **Lead Generation Logic**: Features conditional step execution, automatic data source fallback, and utilizes historical performance data within a comprehensive, real-time tracking, concurrent execution pipeline.
- **Chat Integration**: Employs a queue-based architecture using shared Supabase tables for AI interaction, including intent-based routing for chat tasks.
- **Job Execution**: Manages background tasks such as nightly maintenance, Xero syncing, monitoring, and lead generation with lifecycle management and overlap prevention.
- **Agentic Decision Loop**: Integrates with the Tower Judgement API for plan evaluation, continuation, or halting, especially for `SEARCH_PLACES` operations with retry and plan adjustment mechanisms.
- **Logging**: A three-tier logging system (API, Executor, Tower Integration) provides comprehensive monitoring, including structured logs for agent loop summaries, routing decisions, and artefact POST attempts.
- **Progress Tracking**: Uses an in-memory store for real-time tracking of concurrent plan executions.
- **Event System**: A Map-based registry per `planId` ensures isolated event streams during concurrent executions.
- **Deep Research**: A multi-provider research system (OpenAI, Perplexity, Anthropic, Fallback) generates reports based on user queries.
- **ID Normalization**: Uses `run_id` (from UI or generated UUID) as the canonical `runId` for all artefacts, agent runs, and AFR logging.
- **Intent Classification**: `LEAD_FIND` intent routes messages with lead-finding verbs, business types, and locations to `SEARCH_PLACES`. `DEEP_RESEARCH` requires explicit keywords.
- **Plan Execution**: Calls Tower via `judgeArtefact` after every step, with a bounded retry/replan inner loop allowing for `CONTINUE`, `RETRY`, `CHANGE_PLAN`, or `STOP` verdicts.

### Feature Specifications
- RESTful API for managing leads, user context, signals, and plan execution, including endpoints for plan creation, approval, and progress monitoring.
- Supervisor APIs for executing plans, managing background jobs, and polling deep research runs.
- Database schema supports users, signals, suggested leads, plan executions, and plans.
- Artefacts are posted for lead generation results and deep research reports.
- Run Trace Report: A debug endpoint (`GET /api/debug/run-trace`) provides a JSON diagnostic report for a given run.
- Tower Hard Gate for `SEARCH_PLACES`: All `SEARCH_PLACES` runs must create a `leads_list` artefact and receive an `ACCEPT` verdict from Tower to emit `run_completed`.
- Supervisor-Only Execution: All execution flows through the Supervisor via `executeTowerLoopChat` or the `supervisor_tasks` queue. No inline execution endpoints exist.
- Inline Tower Observation: After every tool call, a `step_result` artefact is written, Tower judges it, and a `tower_judgement` artefact is written (`observation_only: true`). Tower failures are fatal.
- Automated Replan Loop: If Tower returns `change_plan` on a `leads_list` artefact, the supervisor automatically replans by applying policies (e.g., expanding location, increasing search count) and re-executes the plan, up to a maximum of two plan versions.

### System Design Choices
- An `IStorage` interface provides an abstraction layer for database operations.
- Robust logging infrastructure with structured logs and Tower integration.
- In-memory progress tracking and a Map-based event system for isolated and efficient handling of concurrent plan executions.
- Comprehensive error handling ensures proper status updates for failed plans.
- Artefact creation always precedes status events.
- Completion gating ensures `run_completed` is never emitted without Tower approval for `SEARCH_PLACES` runs.
- Tower AFR Provability: Every `SEARCH_PLACES` Tower call emits `tower_call_started`, `tower_call_completed`, and `tower_verdict` AFR events, along with a `tower_judgement` artefact.
- Live Activity `clientRequestId` threading: `RunState` carries `clientRequestId`, included in all Tower AFR and terminal events for correlation.
- Tower 30s timeout: `callTowerJudgeV1` uses an `AbortController` with a 30-second timeout, returning `STOP` on timeout.
- Mandatory Inline Tower Observation: Always-on inline Tower observation; Tower failures are fatal.
- Plan Executor Per-Step Tower Judgement: The plan executor calls Tower via `judgeArtefact` after every step completes, enabling a bounded retry/replan inner loop.
- No Safety Nets: Removed `ensureTowerJudgement` and backfill mechanisms; bypasses are flagged.
- Bypass Detector: Detects runs that bypassed the Supervisor and creates `run_bypassed_supervisor` artefacts.
- Manual Request Judgement: `POST /api/supervisor/request-judgement` accepts run details, locates `leads_list` artefact, calls `judgeArtefact`, persists `tower_judgement` artefact, and emits `tower_verdict` AFR.

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
- **2026-02-13**: Truth-aligned artefact titles/summaries: All artefact titles and summaries (plan, step_result, leads_list, final UI artefact) now build from the active plan's constraints rather than the original goal text. When constraints are relaxed in replans, annotations are appended (e.g., "prefix relaxed", "area expanded to 10km", "type broadened"). The user-facing `displayCount` (parsed from user message) is used instead of the internal `requestedCount`. Leads_list payloads now include `relaxed_constraints: string[]` and `constraint_diffs: { field, from, to }[]` structured fields.
- **2026-02-13**: Hard/soft constraint classification: Plan v1 now includes `hard_constraints` and `soft_constraints` arrays in the plan payload. A keyword heuristic (must, only, exactly, strict, within, etc.) promotes location/prefix_filter to hard; defaults are business_type=hard, requested_count=hard, location=soft, prefix_filter=soft. These arrays are carried forward into Plan v2+ replan artefacts, step_result payloads, leads_list payloads, and Tower successCriteria. `original_user_goal` is persisted verbatim alongside `normalized_goal`. No behaviour changes — recording only.
- **2026-02-13**: `MAX_REPLANS` env var: Configurable bound on how many replans are allowed after Plan v1. Default: 1 (Plan v1 → Plan v2 only). The replan section is now a `while` loop instead of a single `if` block, supporting arbitrary `MAX_REPLANS` values (e.g., `MAX_REPLANS=3` allows up to Plan v4). When the limit is hit, the system creates a terminal artefact explaining the halt (original goal, replans attempted, configured limit), emits `run_halted` AFR with `reason: max_replans_exceeded`, and stops cleanly. `MAX_REPLANS` is logged at run start. Each iteration feeds forward `currentConstraints`, `priorPlanArtefactId`, and `priorLeadsCount` so successive replans build on each other's results.
- **2026-02-13**: Tower field mapping fix in `replan-policy.ts`: Added `mapTowerField` (Tower's `prefix` → internal `prefix_filter`) and `mapTowerType` (Tower's `RELAX_CONSTRAINT` → internal `drop`, `EXPAND_AREA` → `expand`, `BROADEN_QUERY` → `broaden`). Also reads Tower's `from`/`to` fields alongside `current_value`/`suggested_value`. Policy now accepts both `drop` and `relax` actions for prefix_filter removal.
- **2026-02-14**: Intelligent replanning overhaul:
  - **Count split**: `requested_count_user` (what user asked for, what Tower judges against) is separate from `search_budget_count` (what tools actually fetch, always ≥20).
  - **Cross-replan accumulator**: Leads from all plan versions are accumulated into a `Map<string, AccumulatedCandidate>` with deduplication via `makeDedupeKey` (uses `placeId`/`place_id` when available, falls back to normalized name+address hash). Final output uses the union of all accumulated leads, trimmed to `requested_count_user`.
  - **Radius ladder**: Progressive geographic expansion `0→5→10→25→50→100km` via `RADIUS_LADDER_KM` in `agent-loop.ts`. Each replan steps one rung up the ladder. `base_location` is preserved so expansion is always relative to the original location.
  - **Hard/soft constraint enforcement**: `business_type` and `requested_count` are hard constraints (never relaxed). `location` and `prefix_filter` are soft (can be relaxed/expanded). Policy blocks and logs attempts to relax hard constraints.
  - **Early stopping**: Replan loop stops when `accumulatedCandidates.size >= userRequestedCountFinal` — no wasted API calls once goal is met.
  - **Identical params detection**: `constraintsAreIdentical()` prevents re-running the same search when policy cannot change any parameters.
  - **No-progress guard**: If policy cannot make any changes AND radius is at max, loop stops cleanly instead of spinning.
  - **MAX_REPLANS default**: Changed from 1 to 5 to support full radius ladder traversal.
  - **PlanV2Constraints**: Extended with `base_location`, `radius_rung`, `radius_km`, `requested_count_user`, `search_budget_count`.
  - **PlanV2Result**: Now includes `blocked_changes`, `no_progress`, `cannot_expand_further` fields for audit and decision-making.
- **2026-02-14**: Dev-only Explain Run endpoint (`POST /api/dev/explain-run`): Read-only diagnostic endpoint that fetches artefacts and AFR events for a run, builds a compact evidence bundle, and calls an LLM (OpenAI or Anthropic) to produce a factual markdown report. Features anti-hallucination system prompt, goal drift/label honesty audit, per-runId rate limiting (30s), and dev gating (`NODE_ENV !== 'production'` or `DEV_EXPLAIN_RUN=true`). Located in `server/supervisor/explain-run.ts`.