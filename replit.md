# Wyshbone Supervisor Suite

## Overview
Wyshbone Supervisor is a B2B lead generation system designed for automatic prospect identification and scoring. It provides real-time lead suggestions with contact information via email and an integrated chat, aiming to enhance sales processes and expand market reach. The system focuses on delivering actionable, high-density data and improving workflow efficiency.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
The frontend utilizes React, TypeScript, Vite, and Wouter for development, with styling handled by Tailwind CSS and custom design tokens. UI components are built using `shadcn/ui` (based on Radix UI primitives) in a "New York" style, inspired by Linear's B2B design.

### Technical Implementations
- **Frontend**: React with TypeScript, Vite, Wouter, and TanStack Query.
- **Backend**: Node.js with Express and TypeScript (ESM modules).
- **Data Storage**: PostgreSQL (Neon serverless) with Drizzle ORM.
- **Lead Generation Logic**: Employs conditional step execution, automatic data source fallback, and leverages historical performance data within a real-time, concurrent execution pipeline.
- **Chat Integration**: Features a queue-based architecture using shared Supabase tables for AI interaction and intent-based routing.
- **Job Execution**: Manages background tasks such as nightly maintenance, Xero syncing, monitoring, and lead generation, including lifecycle management and overlap prevention.
- **Agentic Decision Loop**: Integrates with the Tower Judgement API for plan evaluation (`CONTINUE`, `RETRY`, `CHANGE_PLAN`, `STOP`), especially for `SEARCH_PLACES` operations with retry and plan adjustment mechanisms.
- **Logging**: A three-tier logging system (API, Executor, Tower Integration) provides comprehensive monitoring with structured logs for agent loop summaries, routing decisions, and artefact POST attempts.
- **Progress Tracking**: Uses an in-memory store for real-time tracking of concurrent plan executions.
- **Event System**: A Map-based registry per `planId` ensures isolated event streams during concurrent executions.
- **Deep Research**: A multi-provider research system (OpenAI, Perplexity, Anthropic, Fallback) generates reports based on user queries.
- **ID Normalization**: `run_id` (from UI or generated UUID) serves as the canonical ID for all artefacts, agent runs, and AFR logging.
- **Intent Classification**: `LEAD_FIND` intent routes messages with lead-finding verbs, business types, and locations to `SEARCH_PLACES`. `DEEP_RESEARCH` requires explicit keywords.
- **Plan Execution**: Calls Tower via `judgeArtefact` after every step, with a bounded retry/replan inner loop allowing for various verdicts.

### Feature Specifications
- **RESTful API**: Manages leads, user context, signals, and plan execution, including endpoints for plan creation, approval, and progress monitoring.
- **Supervisor APIs**: Executes plans, manages background jobs, and polls deep research runs.
- **Database Schema**: Supports users, signals, suggested leads, plan executions, and plans.
- **Artefacts**: Posted for lead generation results and deep research reports.
- **Delivery Summary Artefact** (Feb 2026): A canonical `delivery_summary` artefact emitted at the end of every Supervisor-orchestrated run (both PASS and STOP outcomes). Captures: `requested_count`, `hard_constraints`, `soft_constraints`, `plan_versions` with changes, `soft_relaxations` with from/to/reason, `delivered_exact` and `delivered_closest` entity lists with per-lead match classification, `shortfall`, `stop_reason`, and `suggested_next_question`. Per-lead classification: "exact" = satisfies all hard constraints + all original soft constraints; "closest" = violates ≥1 constraint. Hard constraint validation via text matching on lead name/address. Soft constraint validation: textual constraints use lead name/address string matching against original "from" value; non-textual constraints (radius, distance) use `found_in_plan_version` to determine if lead was found before relaxation. Builder module: `server/supervisor/delivery-summary.ts`. Integrated into `executeTowerLoopChat` (with accumulatedCandidates and softRelaxations tracking), `handleTowerVerdict` (all 10 terminal paths), and `executePlan` (5 return paths with constraints derived from leadsFilters). No synthetic/fabricated leads; empty arrays when no real candidates exist.
- **Run Trace Report**: A debug endpoint (`GET /api/debug/run-trace`) provides a JSON diagnostic report for a given run.
- **Run Narrative System** (Feb 2026): Generates plain-English reports from run artefacts. Module: `server/supervisor/run-narrative.ts`. Builds a facts bundle from plan, factory_state, factory_decision, tower_judgement, and plan_result artefacts, then generates an LLM narrative constrained to only use facts from the bundle. Produces two artefacts: `run_narrative_facts` (raw bundle) and `run_narrative` (with `tldr` and `full_explanation` fields). TL;DR is deterministic (no LLM), 2-3 sentences in plain language avoiding technical terms. Extensible to other run types via `buildFactsBundle` switch. Debug endpoint: `POST /api/debug/run-narrative`.
- **Tower Hard Gate for `SEARCH_PLACES`**: All `SEARCH_PLACES` runs must create a `leads_list` artefact and receive an `ACCEPT` verdict from Tower to emit `run_completed`.
- **Supervisor-Only Execution**: All execution flows through the Supervisor via `executeTowerLoopChat` or the `supervisor_tasks` queue. No inline execution endpoints exist.
- **Inline Tower Observation**: After every tool call, a `step_result` artefact is written, Tower judges it, and a `tower_judgement` artefact is written (`observation_only: true`). Tower failures are fatal.
- **Automated Replan Loop**: If Tower returns `change_plan` on a `leads_list` artefact, the supervisor automatically replans by applying policies (e.g., expanding location, increasing search count) and re-executes the plan, up to a maximum of two plan versions.
- **Intelligent Replanning**:
    - Separates `requested_count_user` (user request) from `search_budget_count` (tools fetch).
    - Accumulates and deduplicates leads across replan versions using `place_id` or `name+address` hash.
    - Implements a progressive geographic expansion strategy (radius ladder).
    - Enforces hard constraints (`business_type`, `requested_count`) while allowing relaxation of soft constraints (`location`, `prefix_filter`).
    - Includes early stopping when the goal is met or no further progress can be made.
    - Supports a configurable maximum number of replans.
- **Partial Accumulation Across Replans** (Feb 2026):
    - Distinguishes between `accumulated_total_unique` (all deduped leads found) and `accumulated_matching` (leads satisfying hard NAME constraints like `NAME_STARTS_WITH`, `NAME_CONTAINS`).
    - Early stop decisions use `accumulated_matching` count against `requested_count_user`, not total unique count.
    - Emits `accumulation_update` artefacts after each plan execution showing matching vs total progress.
    - Tower `leads_list` payloads include `accumulated_total_unique` and `accumulated_matching` for informed judgements.
    - Final leads artefact and chat response provide honest summaries: "X matching of Y total found".
    - `perPlanAdded` array tracks per-plan contribution (matching delta and new unique count).
- **LLM-backed Goal-to-Constraints Parser**: Converts natural language user goals into structured constraints with hard/soft classification using LLMs (OpenAI, Anthropic) and strict JSON schema validation. Handles various constraint types like `COUNT_MIN`, `LOCATION_EQUALS`, `CATEGORY_EQUALS`, `NAME_STARTS_WITH`, `NAME_CONTAINS`, and `MUST_USE_TOOL`.
- **Factory Simulator Demo** (Feb 2026): A deterministic injection-moulding simulation tool (`FACTORY_SIM`) and demo runner (`RUN_FACTORY_DEMO`). Triggered by exact message "run the injection moulding demo" in chat. Implements a fixed 3-step plan: (1) baseline assessment, (2) production drift detection, (3) mitigation response. Scenarios: `normal`, `moisture_high`, `tool_worn`. Each step writes `factory_state` and `factory_decision` artefacts, followed by a deterministic factory-aware Tower judgement (`tower_judgement` artefact). Supports `CHANGE_PLAN` (switches mitigation strategy) and `STOP` (terminates when `achievable_scrap_floor > max_scrap_percent`). Key rule: `moisture_high` with `max_scrap_percent <= 1%` produces STOP because floor is 1.5%. Files: `server/supervisor/factory-sim.ts` (tool + presets), `server/supervisor/factory-demo.ts` (runner + local judgement), routing in `server/supervisor.ts` (`processChatTask`). Debug endpoint: `POST /api/debug/factory-demo`.

### System Design Choices
- **IStorage Interface**: Provides an abstraction layer for database operations.
- **Logging Infrastructure**: Robust, structured logging with Tower integration.
- **Concurrent Execution Handling**: In-memory progress tracking and a Map-based event system ensure isolated and efficient handling.
- **Error Handling**: Comprehensive error handling provides proper status updates for failed plans.
- **Completion Gating**: Ensures `run_completed` is only emitted with Tower approval for `SEARCH_PLACES` runs.
- **Tower AFR Provability**: Every `SEARCH_PLACES` Tower call emits specific AFR events and a `tower_judgement` artefact.
- **Live Activity `clientRequestId` Threading**: `RunState` carries `clientRequestId` for correlation across all Tower AFR and terminal events.
- **Tower Timeout**: `callTowerJudgeV1` includes a 30-second timeout, returning `STOP` on expiration.
- **Mandatory Inline Tower Observation**: Always-on inline Tower observation; Tower failures are fatal.
- **Plan Executor Per-Step Tower Judgement**: The plan executor calls Tower via `judgeArtefact` after every step, enabling a bounded retry/replan inner loop.
- **Bypass Detector**: Detects runs that bypass the Supervisor and creates `run_bypassed_supervisor` artefacts.
- **Manual Request Judgement**: Allows manual triggering of Tower judgment for a given run.

## External Dependencies

- **Supabase**: Used for user profiles, conversations, facts, monitors, deep research runs, integrations, and user signals.
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
- **OpenAI API**: Used for deep research.
- **Perplexity API**: Used for deep research with `llama-3.1-sonar-large-128k-online`.
- **Anthropic API**: Used for deep research with Claude models.