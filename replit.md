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

### System Design Choices
- An `IStorage` interface provides an abstraction layer for database operations.
- Robust logging infrastructure with structured logs and Tower integration.
- In-memory progress tracking and a Map-based event system ensure isolated and efficient handling of concurrent plan executions.
- Comprehensive error handling ensures proper status updates for failed plans.
- Artefact creation always precedes status events to ensure visibility.

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