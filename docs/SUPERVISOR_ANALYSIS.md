# Wyshbone Supervisor - Complete System Analysis

## A. Architecture Overview

### What is Supervisor?

**Supervisor** is the autonomous backend brain of Wyshbone that:
- **Plans** lead generation strategies based on user goals
- **Executes** multi-step plans (search, enrich, save, email)
- **Monitors** for user signals and triggers proactive actions
- **Integrates** with external APIs (Google Places, Hunter.io)
- **Schedules** background "subconscious" tasks

### Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js + TypeScript |
| Framework | Express.js |
| Database | PostgreSQL (Neon serverless) / SQLite / Mock |
| ORM | Drizzle ORM |
| External DB | Supabase (shared with UI) |
| Build | TSX, Vite, esbuild |

### System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        WYSHBONE UI                               │
│                    (React Frontend)                              │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP REST API
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     SUPERVISOR                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Express    │  │  Supervisor │  │  Subcon Scheduler       │  │
│  │  Routes     │  │  Service    │  │  (Background Tasks)     │  │
│  │  /api/*     │  │  (Polling)  │  │  Hourly/Daily           │  │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘  │
│         │                │                      │                │
│         ▼                ▼                      ▼                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    ACTION REGISTRY                        │   │
│  │  GLOBAL_DB | EMAIL_FINDER | DEEP_RESEARCH | MONITOR       │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                             │                                    │
└─────────────────────────────┼────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
   │ Google      │    │ Hunter.io   │    │ Supabase    │
   │ Places API  │    │ API         │    │ (Shared)    │
   └─────────────┘    └─────────────┘    └─────────────┘
                                                │
                                                ▼
                              ┌─────────────────────────────────┐
                              │          TOWER                   │
                              │    (Control Tower Logger)        │
                              └─────────────────────────────────┘
```

---

## B. Agent Inventory

| Agent/Service | Purpose | Trigger | Status |
|--------------|---------|---------|--------|
| **SupervisorService** | Polls Supabase for signals, generates leads, monitors goals | Timer (30s polling) | ✅ Working |
| **Plan Executor** | Executes multi-step lead gen plans | POST /api/plan/approve | ✅ Working |
| **Subcon Scheduler** | Runs background "subconscious" packs | Configurable intervals | ✅ Working |
| **Goal Monitor** | Checks if goals are on track | Each poll cycle | ✅ Working |
| **Deep Research Agent** | Runs deep research queries | Placeholder - not integrated | ⏳ Stub |
| **Email Finder Agent** | Finds emails via Hunter.io | Plan step execution | ✅ Working |
| **Lead Search Agent** | Searches Google Places | Plan step execution | ✅ Working |

### Agent Details

#### 1. SupervisorService (`server/supervisor.ts`)
- **What it does**: Background service that polls Supabase every 30 seconds
- **Triggers**:
  - New `user_signals` in Supabase → generates leads
  - Pending `supervisor_tasks` → processes chat tasks
  - Goal monitoring → checks goals and publishes events
- **Outputs**: Suggested leads, chat responses, goal monitoring events

#### 2. Plan Executor (`server/plan-executor.ts`)
- **What it does**: Executes approved lead generation plans step-by-step
- **Triggered by**: POST `/api/plan/approve`
- **Features**:
  - Sequential step execution with dependencies
  - Retry logic with exponential backoff
  - Real-time progress tracking
  - Branch conditions for conditional flows (SUP-010)

#### 3. Subcon Scheduler (`server/subcon/scheduler.ts`)
- **What it does**: Runs periodic background "subconscious" tasks
- **Triggers**: Configurable tick interval (default: 60s)
- **Packs registered**:
  - `stale_leads` - Detects leads that haven't been contacted

---

## C. Tool Execution Flow

### Action Registry (`server/actions/registry.ts`)

All tool execution goes through a central registry with 4 action types:

| Action Type | Purpose | External API |
|-------------|---------|--------------|
| `GLOBAL_DB` | Search for businesses | Google Places API |
| `EMAIL_FINDER` | Find/enrich emails | Hunter.io API |
| `DEEP_RESEARCH` | Run deep research | (Placeholder) |
| `SCHEDULED_MONITOR` | Create monitors | Supabase |

### Execution Flow Diagram

```
Tool: GLOBAL_DB (Google Places Search)

POST /api/plan/approve
    │
    ▼
Plan Executor: executeLeadGenerationPlan()
    │
    ▼
executeStep() → executeAction('GLOBAL_DB', input)
    │
    ▼
Action Registry: switch(type) → executors.runGlobalDatabaseSearch()
    │
    ▼
searchLeadsWithFallback() → Primary: google_places
    │
    ├── Success → Return leads
    │
    └── Failure → Fallback sources (internal_pubs, dataledger, mock)
    │
    ▼
Result stored in step.result
    │
    ▼
Progress updated → Next step (or complete)
```

### Tool Implementation Details

#### GLOBAL_DB (Google Places)
- **File**: `server/actions/executors.ts`
- **API**: `POST https://places.googleapis.com/v1/places:searchText`
- **Validation**: query and region required
- **Fallback**: internal_pubs → dataledger → fallback_mock

#### EMAIL_FINDER (Hunter.io)
- **File**: `server/actions/executors.ts`
- **API**: `GET https://api.hunter.io/v2/domain-search`
- **Validation**: leads array required
- **Rate limiting**: 300ms delay between requests

#### SCHEDULED_MONITOR
- **File**: `server/actions/executors.ts`
- **Storage**: Supabase `scheduled_monitors` table
- **Validation**: label and userId required

#### DEEP_RESEARCH
- **File**: `server/actions/executors.ts`
- **Status**: ⏳ Placeholder - returns stub data
- **Note**: Will integrate with UI's deep research system

---

## D. API Endpoints

### Plan Execution Pipeline

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/plan/start` | Create a new lead generation plan |
| `POST` | `/api/plan/approve` | Approve and execute a plan |
| `GET` | `/api/plan/progress` | Get execution progress for a plan |
| `GET` | `/api/plan-status` | Alias for progress (UI compatibility) |

### Leads & Signals

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/leads` | Get suggested leads for user |
| `POST` | `/api/leads/save` | Save a lead to in-memory store |
| `GET` | `/api/leads/saved` | List saved leads |
| `GET` | `/api/signals` | Get recent user signals |
| `POST` | `/api/signals` | Create a new signal (testing) |

### User & Context

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/user/context` | Get user profile, facts, messages |
| `GET` | `/health` | Health check endpoint |

### Subconscious Nudges (SUP-13)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/subcon/nudges/account/:accountId` | Get nudges for account |
| `POST` | `/api/subcon/nudges/resolve/:id` | Resolve a nudge |
| `POST` | `/api/subcon/nudges/dismiss/:id` | Dismiss a nudge |

### Features

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/features/run` | Run a feature (leadFinder) |

### Debug & Testing

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/debug/supabase` | Debug Supabase tables |
| `POST` | `/api/seed` | Seed demo data |
| `POST` | `/api/test/supervisor-task` | Create test supervisor task |
| `POST` | `/api/test/signal-supabase` | Create test signal |

### Export API (Protected)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/export/status.json` | Get codebase summary |
| `GET` | `/export/file` | Get file contents |

*Requires `X-EXPORT-KEY` header*

---

## E. External Integrations

| Service | Purpose | API Key Needed | Status |
|---------|---------|---------------|--------|
| **Google Places API** | Search businesses by query/location | `GOOGLE_PLACES_API_KEY` | ✅ Working |
| **Hunter.io** | Email finding/enrichment | `HUNTER_API_KEY` or `HUNTER_IO_API_KEY` | ✅ Working |
| **Supabase** | Shared DB with UI (users, signals, tasks) | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE` | ✅ Working |
| **Resend** | Email notifications | `RESEND_API_KEY` | ✅ Working |
| **Anthropic Claude** | AI processing | Not used directly | ❌ N/A |

### Environment Variables

```bash
# Required for full functionality
DATABASE_URL=           # PostgreSQL connection string
SUPABASE_URL=          # Supabase project URL
SUPABASE_SERVICE_ROLE= # Supabase service role key

# External APIs
GOOGLE_PLACES_API_KEY= # Google Places API
HUNTER_API_KEY=        # Hunter.io (or HUNTER_IO_API_KEY)
RESEND_API_KEY=        # Resend for email notifications

# Optional
EXPORT_KEY=            # Export API authentication
FRONTEND_URL=          # For email links
DASHBOARD_URL=         # For email links
NODE_ENV=              # development/production
PORT=                  # Server port (default: 5000)
HOST=                  # Server host (default: 127.0.0.1)

# Subcon scheduler
SUBCON_SCHEDULER_ENABLED=  # true/false
SUBCON_TICK_INTERVAL_MS=   # Tick interval in ms
```

---

## F. Task Queue System

### Current Implementation

Supervisor uses a **polling-based task system**, not a traditional queue:

1. **Signal Processing** (SupervisorService.poll)
   - Polls Supabase `user_signals` table every 30 seconds
   - Uses checkpoint system to track last processed signal
   - Processes signals in batches of 50
   - Stops on first failure (won't advance checkpoint)

2. **Chat Tasks** (SupervisorService.processSupervisorTasks)
   - Polls Supabase `supervisor_tasks` table
   - Processes tasks with status = 'pending'
   - Updates status to 'processing' → 'completed'/'failed'

3. **Plan Execution** (Plan Executor)
   - Executes steps sequentially with dependencies
   - Retry logic: 2 retries with exponential backoff (1s base)
   - Progress tracked in-memory (plan-progress.ts)

### No External Queue System

There is **no Bull, Redis, or SQS** - everything is:
- In-memory progress tracking
- Database-backed persistence
- Polling-based triggers

### Prioritization

- Chat tasks: FIFO (oldest first)
- Signals: By `created_at` timestamp (oldest first)
- Plan steps: By `dependsOn` dependencies

---

## G. Autonomous Behavior

### Supervisor Service (Automatic)

The SupervisorService runs automatically on server start:

```typescript
// server/index.ts
server.listen(port, host, () => {
  supervisor.start(); // Starts 30s polling loop
  startSubconScheduler(); // Starts subcon scheduler
});
```

### What Runs Autonomously

| Process | Frequency | Trigger | Description |
|---------|-----------|---------|-------------|
| Signal polling | Every 30s | Timer | Checks Supabase for new user_signals |
| Chat task processing | Every 30s | Timer | Processes pending supervisor_tasks |
| Goal monitoring | Every 30s | Timer | Checks if goals are on track |
| Subcon scheduler | Configurable | Timer | Runs subconscious packs |

### Subconscious Scheduler

Configured in `server/subcon/schedules.ts`:

| Schedule ID | Pack | Frequency | Description |
|-------------|------|-----------|-------------|
| `stale_leads_hourly` | `stale_leads` | Hourly | Detects un-contacted leads |

### Decision Logic

#### Lead Generation from Signals

```
Signal received (type: search_performed, idle, profile_update)
    │
    ├── Extract userProfile from payload
    │   ├── industry (required)
    │   ├── location.city
    │   └── location.country
    │
    ├── Build user context from Supabase
    │   ├── Profile (company, industry, objectives)
    │   ├── Facts (high-scored learnings)
    │   ├── Messages (conversation history)
    │   └── Monitors (active monitors)
    │
    ├── Search Google Places for businesses
    │
    ├── Find emails via Hunter.io
    │
    ├── Calculate lead score based on:
    │   ├── Industry match (+10%)
    │   ├── Target markets (+5%)
    │   ├── High-value facts (+5%)
    │   └── Active monitors (+3%)
    │
    └── Create suggested lead with rationale
```

#### Plan Execution Decision

```
User submits goal → POST /api/plan/start
    │
    ├── Parse goal (region, persona, volume, timing)
    │
    ├── Fetch historical performance (SUP-012)
    │   ├── Top strategies (data source, niche, region)
    │   └── Low performers (to avoid)
    │
    ├── Generate plan steps:
    │   1. GOOGLE_PLACES_SEARCH (find businesses)
    │   2. HUNTER_DOMAIN_LOOKUP (get domains)
    │   3. HUNTER_ENRICH (find contacts)
    │   4. LEAD_LIST_SAVE (save leads)
    │   5. EMAIL_SEQUENCE_SETUP (optional)
    │   6. MONITOR_SETUP (if requested)
    │
    └── Return plan for approval
```

---

## H. Communication with UI

### Protocol: HTTP REST

UI communicates with Supervisor via standard HTTP REST API.

### Key Flows

#### 1. Plan Creation & Execution

```
UI                          Supervisor                    External
│                               │                            │
│──POST /api/plan/start────────>│                            │
│<──Plan + pending_approval─────│                            │
│                               │                            │
│  [User reviews plan]          │                            │
│                               │                            │
│──POST /api/plan/approve──────>│                            │
│<──status: executing───────────│                            │
│                               │────Google Places──────────>│
│                               │<───Businesses──────────────│
│                               │────Hunter.io──────────────>│
│                               │<───Emails──────────────────│
│  [Poll for progress]          │                            │
│──GET /api/plan-status────────>│                            │
│<──Progress + step status──────│                            │
```

#### 2. Background Lead Generation

```
UI (Supabase)              Supervisor                    External
│                               │                            │
│──user_signal inserted────────>│  (polling every 30s)       │
│                               │────Check new signals───────│
│                               │────Google Places──────────>│
│                               │<───Business───────────────│
│                               │────Hunter.io──────────────>│
│                               │<───Email──────────────────│
│                               │────Create suggested_lead──>│
│                               │────Send email notification─│
│                               │                            │
│──UI polls /api/leads─────────>│                            │
│<──New lead appears────────────│                            │
```

---

## I. Database Architecture

### Supervisor's Own Database

Supervisor has its own PostgreSQL database (or mock in dev):

| Table | Purpose |
|-------|---------|
| `users` | Local user records |
| `user_signals` | Signals (also read from Supabase) |
| `suggested_leads` | Generated lead suggestions |
| `processed_signals` | Idempotency tracking |
| `supervisor_state` | Checkpoint for signal processing |
| `plans` | Lead generation plans |
| `plan_executions` | Execution history (SUP-003) |
| `subconscious_nudges` | Background nudges (SUP-13) |

### Shared with UI (Supabase)

Supervisor reads/writes to Supabase tables owned by UI:

| Table | Read | Write | Purpose |
|-------|------|-------|---------|
| `users` | ✅ | ❌ | User profiles, account_id |
| `user_signals` | ✅ | ✅ | User activity signals |
| `facts` | ✅ | ❌ | Learned facts about users |
| `messages` | ✅ | ✅ | Chat messages |
| `conversations` | ✅ | ❌ | Chat conversations |
| `supervisor_tasks` | ✅ | ✅ | Chat task queue |
| `scheduled_monitors` | ✅ | ✅ | Active monitors |
| `deep_research_runs` | ✅ | ❌ | Research history |

---

## J. Key Files Reference

| File | Purpose |
|------|---------|
| `server/index.ts` | Server entry point, starts services |
| `server/routes.ts` | All HTTP endpoint definitions |
| `server/supervisor.ts` | Background polling service |
| `server/plan-executor.ts` | Plan execution engine |
| `server/plan-progress.ts` | In-memory progress tracking |
| `server/storage.ts` | Database access layer |
| `server/db.ts` | Database connection (PG/SQLite/Mock) |
| `server/supabase.ts` | Supabase client |
| `server/actions/registry.ts` | Action type definitions |
| `server/actions/executors.ts` | Tool implementations |
| `server/types/lead-gen-plan.ts` | Plan types & execution logic |
| `server/subcon/scheduler.ts` | Background task scheduler |
| `server/lead-search-with-fallback.ts` | Search with fallback sources |
| `shared/schema.ts` | Database schema (Drizzle) |

---

## K. Development Notes

### Running Locally

```bash
# Install dependencies
npm install

# Start dev server (auto-restarts on changes)
npm run dev

# Run smoke test
npm run smoke

# Type check
npm run check
```

### Mock Mode

Without `DATABASE_URL`, Supervisor runs in mock mode:
- Data doesn't persist
- Basic API testing works
- No real database operations

### Key Limitations

1. **No real-time updates** - UI must poll for progress
2. **No distributed queue** - Single instance only
3. **Deep research placeholder** - Not integrated with UI system
4. **No WebSocket** - HTTP polling only


