# Wyshbone Supervisor Suite

## Overview
Wyshbone Supervisor is a B2B lead generation system designed for automatic prospect identification and scoring. It delivers real-time lead suggestions with contact information via email and an integrated chat. The system aims to enhance sales processes, expand market reach, provide actionable data, and improve workflow efficiency. Future ambitions include integrating AI for plan evaluation, deep research, and intelligent replanning to optimize lead generation and verification.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
The frontend uses React, TypeScript, Vite, and Wouter. Styling is managed with Tailwind CSS and custom design tokens. UI components leverage `shadcn/ui` (based on Radix UI primitives) adopting a "New York" aesthetic inspired by Linear's B2B design.

### Technical Implementations
- **Frontend**: React with TypeScript, Vite, Wouter, and TanStack Query.
- **Backend**: Node.js with Express and TypeScript (ESM modules).
- **Data Storage**: PostgreSQL (Neon serverless) with Drizzle ORM.
- **Lead Generation Logic**: Employs conditional step execution, automatic data source fallback, and leverages historical performance data within a real-time, concurrent execution pipeline.
- **Chat Integration**: Uses a queue-based architecture with shared Supabase tables for AI interaction and intent-based routing.
- **Job Execution**: Manages background tasks such as nightly maintenance, syncing, monitoring, and lead generation with lifecycle management.
- **Agentic Decision Loop**: Integrates with the Tower Judgement API for plan evaluation (`CONTINUE`, `RETRY`, `CHANGE_PLAN`, `STOP`).
- **Logging**: A three-tier logging system provides comprehensive monitoring with structured logs.
- **Progress Tracking**: Uses an in-memory store for real-time tracking of concurrent plan executions.
- **Event System**: A Map-based registry per `planId` ensures isolated event streams during concurrent executions.
- **Deep Research**: A multi-provider research system generates reports based on user queries.
- **Intent Classification**: Routes messages with lead-finding verbs to `SEARCH_PLACES` and explicit deep research keywords to `DEEP_RESEARCH`.
- **Plan Execution**: Calls Tower via `judgeArtefact` after every step, with a bounded retry/replan inner loop.
- **Two-Phase Multi-Tool Execution**: Discovers leads with `SEARCH_PLACES` then enriches them using `WEB_VISIT`, `CONTACT_EXTRACT`, and `LEAD_ENRICH`, with `WEB_SEARCH` as a fallback.
- **RESTful API**: Manages leads, user context, signals, and plan execution, including creation, approval, and progress monitoring.
- **Constraint Verification Layer (CVL)**: An additive layer that extracts, checks, and performs per-lead deterministic verification, influencing the final verdict.
- **Intelligent Replanning**: Separates user-requested counts from search budgets, accumulates and deduplicates leads across replan versions, employs a progressive geographic expansion strategy, enforces hard constraints, and includes early stopping.
- **LLM-backed Goal-to-Constraints Parser**: Converts natural language user goals into structured constraints using LLMs and strict JSON schema validation.
- **Canonical Delivery Summary**: `delivery_summary` provides a canonical `status` field (PASS/PARTIAL/STOP) derived from Tower verdict and CVL verified counts, serving as the authoritative user-facing output.
- **Goal Ledger + Belief Store + Feedback Events**: Supabase tables track user goals, beliefs derived from failures, and user feedback actions.
- **ToolResult Contract**: Shared types and helpers for consistent data exchange between tools and the supervisor.
- **Core Tools**:
    - `WEB_VISIT`: A deterministic website crawler and text cleaner.
    - `CONTACT_EXTRACT`: A deterministic contact detail extractor.
    - `WEB_SEARCH`: A strict, auditable web search fallback using Brave Search API.
    - `LEAD_ENRICH`: A deterministic lead pack builder.
    - `ASK_LEAD_QUESTION`: An evidence-backed question answerer.

### System Design Choices
- **IStorage Interface**: Provides an abstraction for database operations.
- **Logging Infrastructure**: Robust, structured logging integrated with Tower.
- **Concurrent Execution Handling**: In-memory progress tracking and a Map-based event system ensure isolated and efficient handling.
- **Error Handling**: Comprehensive error handling with proper status updates for failed plans.
- **Completion Gating**: Ensures `run_completed` is emitted only with Tower approval for `SEARCH_PLACES` runs.
- **Tower AFR Provability**: Every `SEARCH_PLACES` Tower call emits specific AFR events and a `tower_judgement` artefact.
- **Live Activity `clientRequestId` Threading**: `RunState` carries `clientRequestId` for correlation across all Tower events.
- **Mandatory Inline Tower Observation**: Always-on inline Tower observation with fatal failures.
- **Plan Executor Per-Step Tower Judgement**: The plan executor calls Tower via `judgeArtefact` after every step, enabling a bounded retry/replan inner loop.
- **Bypass Detector**: Detects runs that bypass the Supervisor.
- **Short-Circuit Diagnostics**: Emits `diagnostic` artefacts and AFR events when runs short-circuit due to concurrency guard, execution errors, or unhandled exceptions, ensuring at least one artefact is always visible for any agent run.
- **Canonical Run ID Propagation**: `startJob` for `deep_research` sets `run_id` as a column AND in `request_data`, using the caller-provided `run_id` or `jobId` as the canonical ID, preventing run ID mismatches between the routing layer and supervisor.
- **Batch-Claim + Background Claimer**: The supervisor atomically claims ALL pending tasks upfront before processing any, preventing the external Wyshbone UI from racing to grab tasks during long-running executions. A background claimer runs every 2 seconds (via `setInterval`) to claim tasks that arrive while the main loop is busy processing, queuing them for immediate processing after the current batch.
- **Attribute Verification Gate**: Verifies hard constraints (e.g., "live music") after `SEARCH_PLACES` by running `WEB_SEARCH` and `WEB_VISIT`, influencing replanning.
- **Learning Layer v1**: A deterministic policy engine using a canonical three-policy bundle (`radius_policy_v1`, `enrichment_policy_v1`, `stop_policy_v1`) with `policy_bundle_version: 1`. Stored in `policy_versions.policy_data` as the canonical JSON contract. A `GLOBAL_DEFAULT` scope key seeds defaults on first use. Every run writes a `policy_applications` row with the canonical snapshot (`scope_key`, `applied_at`, `applied_versions`, `applied_policies`, `why_short`). Legacy flat policies auto-upgrade via `upgradeFlatPolicyToBundle`. Execution params (`searchBudgetCount`, `searchCount`, `maxReplans`, `enrichmentBatchSize`, radius steps/caps) are derived from the bundle and override supervisor defaults. The `why_short` array includes a line for `stop_policy_v1.max_replans` stating whether it is default or learned and showing the previous value. The `policy_application_snapshot` artefact payload includes `applied_max_replans`. The Activity UI renders policy snapshot cards with `max_replans` badge and `why_short` lines.
- **Tool Planning Policy**: Deterministic tool ordering rules for primary and fallback paths.
- **Verification Pending Artefact**: When hard attribute verification starts (e.g., "beer garden", "live music"), a `verification_pending` artefact is emitted immediately after enrichment completes, showing total checks expected and attributes being verified. This keeps the UI informed during the 1-2 minute verification window.
- **Run Bridge Diagnostics**: `bridgeRunToUI` logs full request/response details (payload, status, body) and emits a `diagnostic` artefact on HTTP or network failure, including the response body and request payload for debugging.

## External Dependencies

- **Supabase**: User profiles, conversations, facts, monitors, deep research runs, integrations, user signals, goal ledger, belief store, feedback events.
- **Resend**: Transactional email service.
- **Google Places API**: Business locations and lead data enrichment.
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
- **OpenAI API**: Deep research.
- **Perplexity API**: Deep research.
- **Anthropic API**: Deep research.
- **Brave Search API**: Used by `WEB_SEARCH` tool.
- **cheerio**: HTML parsing by `WEB_VISIT` tool.
- **Playwright**: Headless Chromium fallback for bot-blocked sites.