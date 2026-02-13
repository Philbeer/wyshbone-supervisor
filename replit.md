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