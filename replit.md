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
- **DEEP_RESEARCH Opt-In (2026-02-10)**: DEEP_RESEARCH is only routed when the message contains explicit research keywords: research, investigate, analyse/analyze, summarise/summarize, overview, report, sources, articles, history, guide, best-of list. Without these keywords, requests default to SEARCH_PLACES. A `[DEEP_RESEARCH_GUARD]` log is emitted when blocking. A new `router_decision_detail` AFR event is logged with `{ intent, chosen_tool, reason, matched_keywords }` at both entry points (`simulate-chat-task` and `processChatTask`).
- **Tower Hard Gate for SEARCH_PLACES (2026-02-10)**: All SEARCH_PLACES runs (including `simulate-chat-task`) must create a `leads_list` artefact before calling `handleTowerVerdict`. `run_completed` is only emitted if Tower verdict = ACCEPT. Zero-results paths emit `run_stopped` instead of `plan_execution_finished` with `status: success`.

### System Design Choices
- An `IStorage` interface provides an abstraction layer for database operations.
- Robust logging infrastructure with structured logs and Tower integration.
- In-memory progress tracking and a Map-based event system ensure isolated and efficient handling of concurrent plan executions.
- Comprehensive error handling ensures proper status updates for failed plans.
- Artefact creation always precedes status events to ensure visibility.
- **Completion gating (2026-02-10)**: `run_completed` is never emitted without Tower approval for SEARCH_PLACES runs. All SEARCH_PLACES paths — including zero-results — route through `handleTowerVerdict` in `agent-loop.ts`. Tower verdict mapping: ACCEPT→`run_completed`, RETRY→rerun same plan, CHANGE_PLAN→generate plan v2, STOP→`run_stopped`. Error/fallback paths emit `run_stopped` (never `plan_execution_finished`) for SEARCH_PLACES runs.

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