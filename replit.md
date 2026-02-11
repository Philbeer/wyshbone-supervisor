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
- Plan Executor Tower Integration: The plan executor now uses `judgeArtefact` for `SEARCH_PLACES` steps, aligning with the Tower client used by `simulate-chat-task` and Proof V2, ensuring `tower_judgement` artefacts and AFR events are consistently generated.

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