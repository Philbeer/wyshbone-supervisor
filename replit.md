# Wyshbone Supervisor Suite

## Overview
Wyshbone Supervisor is a B2B lead generation system designed for automatic prospect identification and scoring. It provides real-time lead suggestions with contact information via email and an integrated chat. The system aims to enhance sales processes, expand market reach, deliver actionable, high-density data, and improve workflow efficiency.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
The frontend uses React, TypeScript, Vite, and Wouter, styled with Tailwind CSS and custom design tokens. UI components are built with `shadcn/ui` (based on Radix UI primitives) in a "New York" style, inspired by Linear's B2B design.

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
- **ID Normalization**: `run_id` serves as the canonical ID for all artefacts, agent runs, and AFR logging.
- **Intent Classification**: `LEAD_FIND` intent routes messages with lead-finding verbs, business types, and locations to `SEARCH_PLACES`. `DEEP_RESEARCH` requires explicit keywords.
- **Plan Execution**: Calls Tower via `judgeArtefact` after every step, with a bounded retry/replan inner loop allowing for various verdicts.
- **RESTful API**: Manages leads, user context, signals, and plan execution, including endpoints for plan creation, approval, and progress monitoring.
- **Supervisor APIs**: Executes plans, manages background jobs, and polls deep research runs.
- **Database Schema**: Supports users, signals, suggested leads, plan executions, and plans.
- **Artefacts**: Posted for lead generation results and deep research reports, including `delivery_summary` and `run_narrative` artefacts for run outcomes and explanations.
- **Tower Hard Gate for `SEARCH_PLACES`**: All `SEARCH_PLACES` runs must create a `leads_list` artefact and receive an `ACCEPT` verdict from Tower to emit `run_completed`.
- **Supervisor-Only Execution**: All execution flows through the Supervisor via `executeTowerLoopChat` or the `supervisor_tasks` queue. No inline execution endpoints exist.
- **Inline Tower Observation**: After every tool call, a `step_result` artefact is written, Tower judges it, and a `tower_judgement` artefact is written (`observation_only: true`). Tower failures are fatal.
- **Automated Replan Loop**: If Tower returns `change_plan` on a `leads_list` artefact, the supervisor automatically replans by applying policies (e.g., expanding location, increasing search count) and re-executes the plan, up to a configurable maximum (default 5 via `MAX_REPLANS` env var).
- **Baseline Behavior Documentation**: Full execution flow documented in `docs/LEAD_FINDER_BASELINE_BEHAVIOR.md`.
- **Intelligent Replanning**: Separates `requested_count_user` from `search_budget_count`, accumulates and deduplicates leads across replan versions, implements a progressive geographic expansion strategy, enforces hard constraints while allowing relaxation of soft constraints, and includes early stopping.
- **Partial Accumulation Across Replans**: Distinguishes between `accumulated_total_unique` and `accumulated_matching` leads, using the latter for early stop decisions. Emits `accumulation_update` artefacts and provides honest summaries in final outputs.
- **LLM-backed Goal-to-Constraints Parser**: Converts natural language user goals into structured constraints with hard/soft classification using LLMs and strict JSON schema validation.
- **Factory Simulator Demo**: A deterministic injection-moulding simulation tool (`FACTORY_SIM`) and demo runner (`RUN_FACTORY_DEMO`) for testing agent decision-making in a controlled environment, including sensor scripts and a preview/dry-run feature.

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
- **Perplexity API**: Used for deep research.
- **Anthropic API**: Used for deep research.