# Wyshbone Supervisor Suite

## Overview
Wyshbone Supervisor is a B2B lead generation system designed for automatic prospect identification and scoring. It provides real-time lead suggestions with contact information via email and an integrated chat. The system aims to enhance sales processes, expand market reach, deliver actionable, high-density data, and improve workflow efficiency. The project's ambition is to integrate AI for plan evaluation, deep research, and intelligent replanning to optimize lead generation and verification.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
The frontend uses React, TypeScript, Vite, and Wouter. Styling is managed with Tailwind CSS and custom design tokens. UI components are built with `shadcn/ui` (based on Radix UI primitives) in a "New York" style, inspired by Linear's B2B design.

### Technical Implementations
- **Frontend**: React with TypeScript, Vite, Wouter, and TanStack Query.
- **Backend**: Node.js with Express and TypeScript (ESM modules).
- **Data Storage**: PostgreSQL (Neon serverless) with Drizzle ORM.
- **Lead Generation Logic**: Employs conditional step execution, automatic data source fallback, and leverages historical performance data within a real-time, concurrent execution pipeline.
- **Chat Integration**: Features a queue-based architecture using shared Supabase tables for AI interaction and intent-based routing.
- **Job Execution**: Manages background tasks such as nightly maintenance, Xero syncing, monitoring, and lead generation, including lifecycle management and overlap prevention.
- **Agentic Decision Loop**: Integrates with the Tower Judgement API for plan evaluation (`CONTINUE`, `RETRY`, `CHANGE_PLAN`, `STOP`).
- **Logging**: A three-tier logging system (API, Executor, Tower Integration) provides comprehensive monitoring with structured logs.
- **Progress Tracking**: Uses an in-memory store for real-time tracking of concurrent plan executions.
- **Event System**: A Map-based registry per `planId` ensures isolated event streams during concurrent executions.
- **Deep Research**: A multi-provider research system (OpenAI, Perplexity, Anthropic, Fallback) generates reports based on user queries.
- **ID Normalization**: `run_id` serves as the canonical ID for all artefacts.
- **Intent Classification**: `LEAD_FIND` intent routes messages with lead-finding verbs, business types, and locations to `SEARCH_PLACES`. `DEEP_RESEARCH` requires explicit keywords.
- **Plan Execution**: Calls Tower via `judgeArtefact` after every step, with a bounded retry/replan inner loop allowing for various verdicts.
- **RESTful API**: Manages leads, user context, signals, and plan execution, including endpoints for plan creation, approval, and progress monitoring.
- **Supervisor APIs**: Executes plans, manages background jobs, and polls deep research runs.
- **Database Schema**: Supports users, signals, suggested leads, plan executions, and plans.
- **Artefacts**: Posted for lead generation results and deep research reports.
- **Tower Hard Gate for `SEARCH_PLACES`**: All `SEARCH_PLACES` runs must create a `leads_list` artefact and receive an `ACCEPT` verdict from Tower to emit `run_completed`.
- **Supervisor-Only Execution**: All execution flows through the Supervisor.
- **Inline Tower Observation**: After every tool call, a `step_result` artefact is written, Tower judges it, and a `tower_judgement` artefact is written. Tower failures are fatal.
- **Automated Replan Loop**: If Tower returns `change_plan` on a `leads_list` artefact, the supervisor automatically replans by applying policies and re-executes the plan.
- **Constraint Verification Layer (CVL) V1**: An additive-only verification layer that extracts constraints, checks verifiability, and performs per-lead deterministic verification. It emits various verification artefacts and influences the final verdict.
- **CVL-Truthful Delivery Summary**: When CVL `verification_summary` exists, `delivery_summary` uses CVL-verified counts and aligns the verdict label with CVL-corrected `finalVerdict`.
- **Intelligent Replanning**: Separates `requested_count_user` from `search_budget_count`, accumulates and deduplicates leads across replan versions, implements a progressive geographic expansion strategy, enforces hard constraints, and includes early stopping.
- **Partial Accumulation Across Replans**: Distinguishes between `accumulated_total_unique` and `accumulated_matching` leads, using the latter for early stop decisions.
- **LLM-backed Goal-to-Constraints Parser**: Converts natural language user goals into structured constraints with hard/soft classification using LLMs and strict JSON schema validation.
- **Factory Simulator Demo**: A deterministic injection-moulding simulation tool for testing agent decision-making.
- **Canonical Delivery Summary**: `delivery_summary` now emits a canonical `status` field (PASS/PARTIAL/STOP) derived from Tower verdict + CVL verified counts.
- **Goal Ledger + Belief Store + Feedback Events**: New Supabase tables track user goals, store beliefs derived from failures, and log user feedback actions.
- **Feedback Signal Logging**: Endpoints for accepting, retrying, abandoning goals, and logging export events.
- **ToolResult Contract**: Shared types and helpers for tool results, evidence, and errors for consistent data exchange between tools and the supervisor.
- **WEB_VISIT Tool**: A deterministic website crawler and text cleaner.
- **CONTACT_EXTRACT Tool**: A deterministic contact detail extractor.
- **WEB_SEARCH Tool**: A strict, auditable web search fallback using Brave Search API.
- **LEAD_ENRICH Tool**: A deterministic lead pack builder that assembles identity, contacts, and signals from various sources.

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
- **Bypass Detector**: Detects runs that bypass the Supervisor.
- **Manual Request Judgement**: Allows manual triggering of Tower judgment for a given run.

## External Dependencies

- **Supabase**: Used for user profiles, conversations, facts, monitors, deep research runs, integrations, user signals, goal ledger, belief store, and feedback events.
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
- **Brave Search API**: Used by the `WEB_SEARCH` tool for web searches.
- **cheerio**: Used for HTML parsing by the `WEB_VISIT` tool.