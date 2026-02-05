# Wyshbone Supervisor Suite

## Overview

Wyshbone Supervisor is a proactive lead generation system designed as a B2B productivity tool. It automatically finds and scores prospects based on user signals, monitoring user behavior and preferences to identify and suggest relevant leads with contact information.

**Key Capabilities:**
- **Email Notifications**: Automatically sends email notifications when new leads are found.
- **Chat Integration**: Supervisor's AI participates directly in Wyshbone UI chat conversations.
- **Real-time Responses**: Provides intelligent lead-finding responses within 30 seconds.
- **Multi-channel Communication**: Delivers insights via both email and chat.

The system features a Linear-inspired design system optimized for data density and workflow efficiency. It consists of a React frontend, a Node.js/Express backend, PostgreSQL (via Neon) for data persistence, and Drizzle ORM for database operations. The Supervisor backend integrates with the separate Wyshbone UI application through a shared Supabase database.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
The frontend uses a React with TypeScript stack, built with Vite and Wouter for routing. Styling is managed with Tailwind CSS, utilizing custom design tokens. The UI component system is built on `shadcn/ui` (Radix UI primitives) with a "New York" style variant, inspired by Linear's B2B aesthetic. Key components include Dashboard, LeadCard, and a sidebar navigation.

### Technical Implementations
- **Frontend**: React with TypeScript, Vite, Wouter, TanStack Query for server state management.
- **Backend**: Node.js with Express and TypeScript, using ESM module system.
- **Data Storage**: PostgreSQL via Neon serverless, managed with Drizzle ORM for type-safe queries and migrations.
- **Lead Generation Logic**:
    - **Branching Plans (SUP-010)**: Supports conditional step execution in lead generation plans based on runtime results (e.g., `too_many_results`, `too_few_results`, `data_source_failed`).
    - **Fallback Data Sources (SUP-011)**: Implements automatic fallback between ordered data sources if a primary source fails to meet minimum thresholds, tracking the source used and the fallback chain.
    - **Historical Performance (SUP-012)**: Uses past plan executions and lead outcomes to guide future planning decisions. Analyzes strategy performance across niche, region, data source, and outreach channel dimensions. Includes user AND account isolation to prevent cross-user and cross-account data leakage.
    - **Plan Execution Pipeline**: Complete workflow from plan creation → approval → execution → real-time progress tracking. Plans stored in PostgreSQL `plans` table. Progress tracked in-memory keyed by planId, supporting concurrent executions by same user. Event system uses Map-based registry for isolated event streams per plan.
- **Chat Integration**: Supervisor's AI integrates into Wyshbone UI chat via a queue-based architecture using shared Supabase tables (`messages`, `supervisor_tasks`). The UI detects Supervisor intent, creates tasks, and streams Supervisor responses.

### Feature Specifications
- RESTful API endpoints for leads, user context, signals, and plan execution.
- **Plan Execution API**:
  - POST `/api/plan/start` - Creates a plan using SUP-001 + SUP-012, stores in database with "pending_approval" status
  - POST `/api/plan/approve` - Validates ownership, starts execution asynchronously with comprehensive logging. When SUPERVISOR_EXECUTION_ENABLED=true, routes to Supervisor backend execution.
  - GET `/api/plan/progress?planId=xxx` - Returns real-time progress for specific plan or user's most recent plan
  - GET `/api/plan-status` - Alias for `/api/plan/progress` with enhanced logging for UI integration
- **Supervisor Execution API** (Session 1):
  - POST `/api/supervisor/execute-plan` - Accepts plan execution requests, validates input, returns immediately with ok=true, executes steps asynchronously in background
  - Feature flag: SUPERVISOR_EXECUTION_ENABLED (default: false) gates execution path in /api/plan/approve
  - AFR logging: Writes to agent_activities table for display in UI Live Activity panel
  - Sequential execution: Stops on first failure, no retries (Session 1 scope)
  - Native SEARCH_PLACES: Uses Google Places Text Search API directly (requires GOOGLE_MAPS_API_KEY)
  - Test script: `./scripts/test-supervisor-plan.sh` tests endpoint with sample "pubs in Kent GB" query
- **Supervisor Jobs API** (Session 2):
  - POST `/api/supervisor/jobs/start` - Start a new background job
  - GET `/api/supervisor/jobs/:jobId` - Get job status
  - POST `/api/supervisor/jobs/:jobId/cancel` - Cancel a job
  - **Job Handlers**:
    - `nightly-maintenance` - Cleans up stale memories and executes autonomous agent tasks
    - `xero-sync` - Syncs Xero integrations for users with connected accounts
    - `monitor-worker` - Checks all active monitors for issues (stalled, no_plan, repeated_failures), publishes alerts
    - `monitor-executor` - Executes scheduled monitors to generate leads using SUP-001 (planner) + SUP-002 (executor)
    - `deep-research-poll` - Polls pending deep research runs and updates their status (migrated from UI)
  - AFR events: job_started, job_progress (multiple milestones), job_completed/job_failed with resultSummary
  - Safety: "already running" guard prevents overlapping runs of same jobType
- **Deep Research Poller Scheduler** (Session 2 Migration):
  - Replaces UI deep research polling to run reliably in Supervisor
  - **Environment Variables**:
    - `ENABLE_DEEP_RESEARCH_POLLER` - Set to "true" to enable (default: disabled)
    - `DEEP_RESEARCH_POLL_INTERVAL_MS` - Polling interval in ms (default: 5000)
  - Logs on startup: "Deep Research poller: disabled" or "Deep Research poller: enabled, interval = Xms"
  - Manual trigger via: `POST /api/supervisor/jobs/start` with `{jobType:"deep-research-poll", payload:{}, requestedBy:"ui"}`
  - Example resultSummary output:
    ```json
    {
      "success": true,
      "jobType": "deep-research-poll",
      "durationMs": 150,
      "pendingFound": 3,
      "processed": 3,
      "succeeded": 2,
      "failed": 0,
      "skipped": 1
    }
    ```
    - `succeeded`: Runs that completed successfully
    - `failed`: Runs that failed permanently (marked as failed in DB)
    - `skipped`: Runs still processing or couldn't be polled (API errors, no API key)
- Database schema includes `users`, `user_signals`, `suggested_leads`, `plan_executions`, and `plans` tables.
- Signals represent user actions that trigger lead discovery.
- Leads include enriched data (e.g., emails, places) and trigger email notifications.
- Plans support concurrent execution with isolated progress tracking and event streams.

### System Design Choices
- `IStorage` interface for database abstraction, with `DatabaseStorage` using Drizzle ORM.
- Hardcoded "demo-user" for current authentication, with future support for username/password and session management planned.
- **Logging Infrastructure**: Three-tier logging system for production debugging and monitoring:
  - **API Layer** (`server/routes.ts`): Structured logs for all plan-related endpoints with timing metrics, user context, and error details
  - **Executor Layer** (`server/types/lead-gen-plan.ts`): Step-by-step execution logs with visual status indicators and performance metrics
  - **Tower Integration** (`server/tower-logger.ts`): JSON-formatted logs for Control Tower monitoring with source identifier "plan_executor"
- **Progress Tracking**: In-memory store keyed by planId (not sessionId) to support concurrent plan executions by same user. Includes cleanup functions to prevent memory leaks.
- **Event System**: Map-based registry keyed by planId for isolated event streams. Each plan execution has its own event handler, preventing cross-contamination between concurrent plans.
- **Error Handling**: Both success and failure paths use planId for progress updates, ensuring failed plans are correctly marked and can be cleaned up.

## External Dependencies

- **Supabase**: Used as the shared database for both Wyshbone UI and Supervisor. It stores user profiles, conversations, facts, scheduled monitors, deep research runs, integrations, and user signals. Supervisor polls Supabase for new signals and task management for chat integration.
- **Resend**: Transactional email service used for sending lead notification emails to users.
- **Google Places API**: Utilized for finding physical business locations and enriching lead data.
- **Hunter.io**: An email discovery service used to populate `emailCandidates` for leads.
- **Radix UI**: Provides accessible, unstyled primitive components for UI development.
- **shadcn/ui**: Component library built on Radix UI, providing custom-themed components.
- **PostgreSQL (Neon)**: Serverless relational database for data persistence.
- **Drizzle ORM**: Type-safe ORM for database interactions.
- **Vite**: Build tool and development server for the frontend.
- **Wouter**: Lightweight client-side router.
- **TanStack Query**: For server state management and caching.
- **Tailwind CSS**: Utility-first CSS framework for styling.
- **Zod**: Runtime schema validation library.

---

## Session 2 Complete

**Status**: ✅ Complete (February 2026)

### Summary
Supervisor is now the authoritative executor for all long-running background jobs. The UI should delegate job execution to Supervisor rather than executing jobs locally.

### Job Types Implemented
| Job Type | Description |
|----------|-------------|
| `nightly-maintenance` | Cleans up stale memories and executes autonomous agent tasks |
| `xero-sync` | Syncs Xero integrations for users with connected accounts |
| `monitor-worker` | Checks all active monitors for issues (stalled, no_plan, repeated_failures) |
| `monitor-executor` | Executes scheduled monitors to generate leads using SUP-001/SUP-002 |
| `deep-research-poll` | Polls pending deep research runs and updates their status |

### Scheduler Configuration
- **Default**: Scheduler is OFF
- **Enable**: Set `ENABLE_DEEP_RESEARCH_POLLER=true`
- **Interval**: Configure with `DEEP_RESEARCH_POLL_INTERVAL_MS` (default: 5000ms)

### Safety Features
- **Overlap Guard**: Prevents concurrent runs of the same job type (poller and monitors)
- **Production Warnings**: Loud console warnings when poller is enabled in production
- **Aggressive Polling Warning**: Additional warning when poll interval < 3000ms in production
- **Debug Endpoints**: Gated behind `ENABLE_DEBUG_ENDPOINTS=true` AND `NODE_ENV !== production`

### Architecture Principle
UI should delegate long-running jobs to Supervisor, not execute them locally. Supervisor handles:
- Job lifecycle management
- AFR event logging
- Overlap prevention
- Error handling and retries