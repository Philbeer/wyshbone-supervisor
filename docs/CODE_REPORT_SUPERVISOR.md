# Wyshbone Supervisor Suite — Comprehensive Technical Report

**Report date:** 11 May 2026  
**Scope:** Full read-only static analysis of the production codebase. No code was modified.  
**Analyst note:** All line counts, file counts, and observations are taken directly from source. Section cross-references use §N notation.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Repository Topology & Scale](#2-repository-topology--scale)
3. [Runtime Architecture](#3-runtime-architecture)
4. [Data Layer](#4-data-layer)
5. [Supervisor Core — Mission Lifecycle](#5-supervisor-core--mission-lifecycle)
6. [Constraint System](#6-constraint-system)
7. [Evidence Gathering Tools](#7-evidence-gathering-tools)
8. [Verification & Judgement Layer (Tower)](#8-verification--judgement-layer-tower)
9. [Reloop Engine](#9-reloop-engine)
10. [Auxiliary Systems](#10-auxiliary-systems)
11. [LLM Usage Inventory](#11-llm-usage-inventory)
12. [External Integrations](#12-external-integrations)
13. [Testing Coverage](#13-testing-coverage)
14. [Technical Debt & Risk Register](#14-technical-debt--risk-register)
15. [Replication Difficulty Assessment](#15-replication-difficulty-assessment)

---

## 1. Executive Summary

Wyshbone Supervisor is a B2B lead-generation platform that translates natural-language user queries into structured search missions, executes multi-step evidence-gathering runs against a constellation of external APIs, verifies each candidate lead against user constraints, and delivers ranked results via chat and email.

The system is architecturally ambitious: it layers a deterministic constraint-planning engine, an LLM-driven mission extractor, a three-provider LLM failover chain, an external Tower judgement service, a rule-based re-loop engine, a sleep/wake monitoring scheduler, a subconscious nudge system, and a self-healing rescue/promotion loop — all within a single Node.js Express process.

**Headline metrics:**

| Metric | Value |
|---|---|
| Total source files | ~341 |
| Total lines of code (approx.) | ~87,705 |
| Supervisor module alone | ~37,364 LOC across ~101 `.ts` files |
| SQL migration files | 15 |
| Test files | 35 |
| External API dependencies | 9 (Google Places, Brave, Hunter, Resend, OpenAI, Anthropic, Groq, Perplexity, Tower) |
| LLM callsites | 20 distinct callsites across 5 providers |
| Named environment variables | 20+ (15 required, 5+ optional) |

The system's greatest strengths are the depth of its constraint modelling, the defence-in-depth verification approach, and the well-structured failover chain. Its most significant risks are the concentration of critical control flow in a single process without distributed coordination, the per-message cost from Sonnet-class models on routing calls, and the reliance on an external Tower service whose unavailability halts execution.

---

## 2. Repository Topology & Scale

### 2.1 Directory Structure

```
/
├── server/
│   ├── index.ts                    Entry point — Express app, startup hooks
│   ├── routes.ts                   API route registration
│   ├── storage.ts                  IStorage interface + DatabaseStorage impl (~837 LOC)
│   ├── schema.ts                   Server-side schema (extends shared/schema.ts)
│   ├── db.ts                       Drizzle ORM client (Neon serverless)
│   ├── supabase.ts                 Supabase JS client (real-time + auxiliary tables)
│   ├── supervisor/                 Core intelligence (~101 files, ~37,364 LOC)
│   │   ├── mission-extractor.ts    2-pass LLM extraction (~1,110 LOC)
│   │   ├── mission-planner.ts      Deterministic rule planner
│   │   ├── mission-executor.ts     Main execution orchestrator (~3,047 LOC)
│   │   ├── mission-schema.ts       Zod types for StructuredMission
│   │   ├── mission-bridge.ts       Legacy→mission translation (~572 LOC)
│   │   ├── conversation-router.ts  Turn routing (LLM)
│   │   ├── chat-handler.ts         HTTP handler + circuit breaker
│   │   ├── constraint-gate.ts      Pre-execution constraint gates (~1,241 LOC)
│   │   ├── clarify-gate.ts         Clarification blocking gate
│   │   ├── cvl.ts                  Constraint Verification Layer (~707 LOC)
│   │   ├── tower-judgement.ts      Tower /evaluate client
│   │   ├── tower-artefact-judge.ts Tower /judge-artefact client
│   │   ├── tower-semantic-verify.ts Tower /semantic-verify client
│   │   ├── llm-failover.ts         3-provider failover chain (~385 LOC)
│   │   ├── gpt4o-search.ts         GPT-4o Responses API path (~824 LOC)
│   │   ├── web-search.ts           Brave Search wrapper (~339 LOC)
│   │   ├── web-visit.ts            Cheerio/Playwright scraper (~727 LOC)
│   │   ├── google-places.ts        Google Places API wrapper
│   │   ├── delivery-summary.ts     Payload assembly + lead exactness (~554 LOC)
│   │   ├── outreach-drafter.ts     GPT-4o email drafting (~137 LOC)
│   │   ├── outreach-transport.ts   Resend transport + safety layers (~310 LOC)
│   │   ├── rescue-llm.ts           Self-heal / clarification on extraction fail (~558 LOC)
│   │   ├── rescue-promotion.ts     Pattern promotion into extractor prompt (~349 LOC)
│   │   ├── belief-writer.ts        Per-run belief derivation (~95 LOC)
│   │   ├── learning-layer.ts       Query-shape learning abstraction
│   │   ├── learning-store.ts       DB read/write for learning knobs
│   │   ├── afr-logger.ts           Agent activity logger → Supabase (~431 LOC)
│   │   ├── sleep-wake/             Scheduled re-run monitor system
│   │   │   ├── index.ts
│   │   │   ├── wake-scheduler.ts   Polling + nudge dispatch (~141 LOC)
│   │   │   ├── wake-executor.ts    Re-runs goal via supervisor
│   │   │   ├── delta-detector.ts   Set-diff for new/removed entities (~25 LOC)
│   │   │   └── types.ts
│   │   ├── reloop/                 Multi-attempt re-loop engine
│   │   │   ├── loop-skeleton.ts    Orchestrator (~1,062 LOC)
│   │   │   ├── planner.ts          Rule-based executor selection
│   │   │   ├── llm-planner.ts      LLM fallback planner
│   │   │   ├── index.ts            3 executor adapters
│   │   │   ├── gp-cascade-adapter.ts
│   │   │   ├── gpt4o-adapter.ts
│   │   │   ├── judge-adapter.ts
│   │   │   └── executor-registry.ts
│   │   └── schedulers/
│   │       └── deep-research-scheduler.ts
│   ├── core/                       Infrastructure primitives
│   │   ├── event-bus/              InMemoryEventBus
│   │   ├── scheduler/              InMemoryScheduler
│   │   └── task-runner/            TaskRunner with lifecycle/retry/timeout (~451 LOC)
│   ├── subcon/                     Subconscious nudge system
│   │   ├── registry.ts             Pack registry
│   │   ├── scheduler.ts            Periodic pack runner
│   │   ├── SubconVerticalMapping.ts Industry → pack mapping
│   │   └── packs/                  Registered packs (e.g. stale_leads)
│   ├── verticals/
│   │   └── brewery/                Brewery-specific vertical pack + tests
│   ├── evaluator/                  Run failure classification
│   │   ├── classifyRunFailure.ts
│   │   └── failureClassification.ts
│   ├── cron/
│   │   └── daily-agent.ts          node-cron 9am daily agent (~351 LOC)
│   └── notifications/
│       └── resend-client.ts        Resend SDK wrapper
├── shared/
│   ├── schema.ts                   Drizzle table definitions (~384 LOC)
│   └── types/                      Shared TypeScript types
├── ui/ (or client/)                React frontend
├── migrations/                     15 SQL files + TS runners
├── config/
│   └── benchmarkQueries.ts
└── docs/                           Internal docs (not shipped)
```

### 2.2 Scale Summary

| Area | Files | Approx. LOC |
|---|---|---|
| Supervisor module | ~101 | ~37,364 |
| Server (non-supervisor) | ~60 | ~15,000 |
| Frontend (ui/) | ~80 | ~18,000 |
| Shared | ~20 | ~3,000 |
| Tests | 35 | ~6,000 |
| Migrations (SQL) | 15 | ~3,000 |
| **Total** | **~341** | **~87,705** |

---

## 3. Runtime Architecture

### 3.1 Process Model

The entire backend runs as a **single Node.js ESM process** started via `npm run dev` (Vite dev server + Express on the same port, served by `server/vite.ts`). There is no microservice split, no worker threads for heavy computation, and no job queue. All supervisor runs, cron jobs, reloop iterations, and background schedulers share one event loop.

**Startup sequence (server/index.ts):**
1. Load `.env.local` via `./env.js`
2. Create Express app, configure CORS (dev + production origins, `.replit.app` wildcard)
3. `registerRoutes()` — mount all API handlers
4. `supervisor.initialize()` — recover orphaned `agent_runs`
5. `startSubconScheduler()` — begin subconscious nudge pack polling
6. `startDailyAgentCron()` — register node-cron 9am job
7. `startDeepResearchScheduler()` — deep research background runner
8. `assertTowerConfig()` — validate Tower env vars on startup (throws if missing in production)
9. Vite dev server or static file serving

### 3.2 HTTP Layer

```
Client → Express → /api/chat → chat-handler.ts
                              ↓
                    conversation-turn-classifier.ts  (LLM, every message)
                              ↓
                    conversation-router.ts           (LLM, every message)
                              ↓
               ┌──────────────────────────────┐
               │  SEARCH → mission-extractor  │
               │  CLARIFY → smart-clarify     │
               │  DISCUSS → result-discussion │
               │  CHAT    → streaming reply   │
               └──────────────────────────────┘
```

**Circuit breaker in `chat-handler.ts`:** In-memory array of call timestamps. Window: 5 minutes. Limit: 10 calls. **Process-local only** — does not survive restarts and does not coordinate across multiple instances.

### 3.3 Frontend

React SPA using **Wouter** for routing, **TanStack Query v5** for data fetching, **Tailwind CSS** + **shadcn/ui** component library, **Radix UI** primitives. Vite builds and serves via the same Express process. Frontend communicates with backend exclusively via relative API URLs (no hardcoded ports).

---

## 4. Data Layer

### 4.1 Dual Database Architecture

The system uses two separate database clients simultaneously:

| Database | Client | Purpose |
|---|---|---|
| **PostgreSQL (Neon serverless)** | Drizzle ORM (`server/db.ts`) | Primary relational store — users, plans, leads, artefacts, agent runs, beliefs, learning store |
| **Supabase** | `@supabase/supabase-js` (`server/supabase.ts`) | Real-time features, auxiliary tables — `scheduled_monitors`, `messages`, `agent_activities`, `outreach_messages`, `rescue_log` |

This dual-database design means writes are split across two separate transactional systems with no cross-database atomicity. A failure in one does not roll back the other.

### 4.2 Drizzle Schema (shared/schema.ts + server/schema.ts)

Key tables defined in Drizzle:

| Table | Purpose |
|---|---|
| `users` | Auth — username + hashed password |
| `user_signals` | Inbound signals triggering lead generation |
| `suggested_leads` | Delivered lead records with pipeline state |
| `processed_signals` | Idempotency guard for signal deduplication |
| `supervisor_state` | Polling checkpoint per data source |
| `plans` | Lead generation plan objects (JSONB `plan_data`) |
| `plan_executions` | Execution records with step results |
| `subconscious_nudges` | Nudge messages from subcon packs |
| `agent_memory` | Tool usage memory with 90-day expiry |
| `artefacts` | Named structured outputs from runs |
| `tower_judgements` | Tower API response records |
| `agent_runs` | Run lifecycle tracking |
| `goal_ledger` | Goal lifecycle with status and stop reasons |
| `belief_store` | Per-run derived beliefs (max 3 per run) |
| `feedback_events` | User feedback on results |
| `telemetry_events` | Internal run telemetry |
| `policy_versions` / `policy_applications` | Verification policy audit trail |
| `learning_store` | Query-shape behavioural knobs |

### 4.3 Supabase Tables (SQL migrations)

Managed via raw SQL migrations in `/migrations/`. Key Supabase-only tables:

| Table | Purpose |
|---|---|
| `scheduled_monitors` | Sleep-wake goal schedule records |
| `messages` | Conversation messages (chat history) |
| `agent_activities` | Live activity feed (AFR logger) |
| `outreach_messages` | Outreach email state machine |
| `rescue_log` | Rescue LLM outcomes + pattern promotion tracking |
| `reloop_loop_state` | Per-loop execution records |
| `conversation_summaries` | Compressed conversation context |

### 4.4 ORM & Migrations

Drizzle ORM with `drizzle-zod` for insert schema generation. Migrations are a mix of SQL files run manually against Supabase and TypeScript migration runners for the Neon database. There is no unified migration runner — the two databases are migrated independently.

---

## 5. Supervisor Core — Mission Lifecycle

### 5.1 Overview

A user message travels through the following pipeline stages before results are delivered:

```
User message
    │
    ▼
[1] Turn Classification     (LLM — Haiku)
    │
    ▼
[2] Conversation Routing    (LLM — Sonnet)  →  CHAT / DISCUSS / CLARIFY / SEARCH / ITERATE
    │ (SEARCH path)
    ▼
[3] Mission Extraction      (2-pass LLM — gpt-4o-mini primary)
    │
    ▼
[4] Clarify Gate            (deterministic rules)  →  may block and ask user
    │
    ▼
[5] Constraint Gate         (deterministic rules)  →  may block on unresolvable hard constraints
    │
    ▼
[6] Mission Planning        (deterministic rules — no LLM)
    │
    ▼
[7] Reloop Engine           (loop-skeleton.ts)
    │   ┌─────────────────────────────────┐
    │   │  Loop 1..N (max 3, 8-min wall)  │
    │   │  planner.ts → executor choice   │
    │   │  gp_cascade / gpt4o_search /    │
    │   │  outreach executor              │
    │   └─────────────────────────────────┘
    │
    ▼
[8] CVL Verification        (deterministic, per-lead)
    │
    ▼
[9] Tower Judgement         (external API)
    │
    ▼
[10] Delivery Summary       (payload assembly)
    │
    ▼
[11] Belief Writer          (derived beliefs)
    │
    ▼
[12] Response to user       (chat + optional email)
```

### 5.2 Turn Classification (`conversation-turn-classifier.ts`)

Every incoming message fires an LLM call (Haiku by default) to classify the conversation turn. Output is used downstream by the router to distinguish whether the user is answering a clarification, refining a prior search, asking a question about results, or starting a new search. This fires on **every message** — even simple chat replies.

### 5.3 Conversation Routing (`conversation-router.ts`)

A second LLM call (Sonnet-class by default — see §11) routes the message to one of: `SEARCH`, `CLARIFY`, `DISCUSS`, `ITERATE`, `CHAT`. This is a structured JSON classification task executed with a premium model. This is the most significant per-message cost driver in the system.

### 5.4 Mission Extraction (`mission-extractor.ts` — ~1,110 LOC)

The mission extractor runs **three sequential LLM calls** (all `gpt-4o-mini` with Anthropic `claude-3-haiku-20240307` fallback on HTTP 429):

**Pass 1 — Semantic Interpreter:**  
Rewrites the raw user query into a clean semantic statement. Also produces a `ConstraintChecklist` (explicit list of every user constraint detected) and an `ImplicitExpansionTrace` (inferred intent not literally stated). Output is natural language + structured checklist.

**Pass 2 — Schema Mapper:**  
Takes the Pass 1 output and maps it to a `StructuredMission` JSON object conforming to the `mission-schema.ts` Zod schema. Constraint types are: `entity_discovery`, `location_constraint`, `text_compare`, `attribute_check`, `relationship_check`, `numeric_range`, `time_constraint`, `status_check`, `website_evidence`, `contact_extraction`, `ranking`.

**Pass 3 — Intent Narrative:**  
Generates an `IntentNarrative` object describing `entityDescription`, `keyDiscriminator`, `findability`, `scarcityExpectation`, `entityExclusions`, and `suggestedApproaches`. Used downstream by the GPT-4o search executor and outreach drafter for context-aware prompting.

**Failure recovery:** If extraction fails, `rescue-llm.ts` attempts self-healing (estimated 70% of cases) or generates a single clarifying question (30%). Successful rescues are logged to `rescue_log` and promoted into the extractor prompt via `rescue-promotion.ts` on a weekly/manual cycle.

### 5.5 Mission Planner (`mission-planner.ts`)

**Pure deterministic logic — no LLM.** Maps the constraint types in the `StructuredMission` to one of six execution strategies:

| Strategy ID | Description |
|---|---|
| `discovery_only` | Entity discovery with no attribute verification |
| `discovery_then_direct_filter` | Discovery + name/text constraint filtering |
| `discovery_then_rank` | Discovery + ranking |
| `discovery_then_website_evidence` | Discovery + website scraping for attribute evidence |
| `discovery_then_external_evidence` | Discovery + relationship/external evidence |
| `composite` | Multiple constraint types requiring mixed evidence |

Also derives a `VerificationPolicy` (§6.4) and produces `ConstraintPlanMappings` linking each constraint to its required verification method.

### 5.6 Mission Executor (`mission-executor.ts` — ~3,047 LOC)

The largest file in the codebase. Orchestrates the full execution of a single run:
- Creates `AgentRun` record, emits SSE events to connected clients
- Dispatches to GP cascade (Google Places → Brave Search → Web Visit) or GPT-4o primary path
- Calls Hunter.io for contact extraction on discovered leads
- Enforces `RUN_EXECUTION_TIMEOUT_MS` (default 120,000ms) via `Promise.race`
- Enforces `MAX_TOOL_CALLS_PER_RUN` (default 150) as a hard counter
- **Session isolation guard:** drops deliveries from runs whose `conversationId` has been superseded by a newer run — prevents stale result delivery
- Calls CVL (§6.3), assembles `DeliverySummary`, calls Tower (§8), writes beliefs, updates `AgentRun` status

---

## 6. Constraint System

### 6.1 Constraint Types

Two parallel constraint type systems coexist in the codebase (a known migration in progress):

**Legacy (`goal-to-constraints.ts`):**  
`COUNT_MIN`, `LOCATION_EQUALS`, `LOCATION_NEAR`, `CATEGORY_EQUALS`, `NAME_STARTS_WITH`, `NAME_CONTAINS`, `MUST_USE_TOOL`, `HAS_ATTRIBUTE`, `RELATIONSHIP_CHECK`, `STATUS_CHECK`, `TIME_CONSTRAINT`, `WEBSITE_EVIDENCE`, `RANKING`

**Mission schema (`mission-schema.ts`):**  
`entity_discovery`, `location_constraint`, `text_compare`, `attribute_check`, `relationship_check`, `numeric_range`, `time_constraint`, `status_check`, `website_evidence`, `contact_extraction`, `ranking`

`mission-bridge.ts` (~572 LOC) translates between the two representations and tracks `ConstraintDowngrade` events (e.g. `relationship_to_has_attribute`) where the mission schema type is semantically narrower than the canonical intent type. It also computes `mapping_fidelity`: `exact`, `degraded`, or `unknown`.

### 6.2 Constraint Gate (`constraint-gate.ts` — ~1,241 LOC)

The gate runs before any tool execution. It evaluates every hard constraint against a capability matrix:
- Can the constraint be verified by available tools?
- Is there enough location information to proceed?
- Are there any constraints that are structurally unresolvable (e.g. relationship checks with no known counterpart data source)?

**Unresolvable hard constraints block execution** and return a clarification prompt. Soft constraints that cannot be verified are downgraded and logged as `soft_relaxations` in the delivery summary.

### 6.3 CVL — Constraint Verification Layer (`cvl.ts` — ~707 LOC)

Per-lead constraint checking after evidence is gathered. For each lead:
- Evaluates each constraint against collected evidence (web visit snippets, Places data, search results)
- Assigns `VerificationStatus`: `yes`, `no`, `unknown`, `search_bounded`
- Assigns `LocationConfidence`: `verified_geo`, `search_bounded`, `out_of_area`, `unknown`, `not_applicable`
- Applies `geo-regions.ts` bounding-box verification for location constraints
- Produces a `CvlLeadVerification` record used by `delivery-summary.ts` to classify leads as `exact` or `closest`

Evidence requirement tiers define what proof is needed per constraint type: `none`, `lead_field`, `directory_data`, `search_snippet`, `website_text`, `external_source`.

### 6.4 Verification Policy

Three policies derived deterministically from the planner's constraint mappings:

| Policy | Triggered by | Meaning |
|---|---|---|
| `DIRECTORY_VERIFIED` | Discovery-only or direct-filter strategies | Lead verified from directory data alone |
| `WEBSITE_VERIFIED` | `attribute_check`, `status_check`, `website_evidence`, `time_constraint` | Lead requires website evidence |
| `RELATIONSHIP_VERIFIED` | `relationship_check` | Lead requires external relationship evidence |

---

## 7. Evidence Gathering Tools

### 7.1 Google Places (`google-places.ts`)

Primary discovery tool. Uses the Google Places Text Search API to find businesses by type and location. Returns structured place data (name, address, place_id, rating, website, phone, opening hours). Used in the GP cascade as the first and cheapest discovery step.

### 7.2 Brave Search (`web-search.ts` — ~339 LOC)

Wraps the Brave Search API (`https://api.search.brave.com/res/v1/web/search`). Used for:
- Discovering businesses not in Google Places (especially B2B/non-venue targets)
- Finding evidence for attribute constraints (e.g. "does this pub serve cask ale?")
- Returns ranked results with `match_signals`: `name_match`, `town_match`, `address_fragment_match`, `phone_match`, `domain_match`
- Quota exceeded (HTTP 402/429) is handled gracefully; result is flagged `quota_exceeded: true`
- 10-second fetch timeout, 10-result cap

### 7.3 Web Visit (`web-visit.ts` — ~727 LOC)

Scrapes business websites for constraint evidence. Two-tier fetch:
1. **Cheerio (HTML parser):** Primary fetch with realistic browser headers, 15-second timeout, 2MB body cap, bot-detection signal detection (Cloudflare, hCaptcha, Turnstile, etc.)
2. **Playwright fallback:** Headless browser for JS-rendered pages or bot-blocked sites, 20-second timeout

Features:
- `PAGE_HINT_PATHS`: predefined URL slug lists per page type (home, contact, about, events, menu)
- **LLM-assisted page hint generation:** When constraint-specific paths are needed, calls `callLLMText` (5-second timeout) to suggest URL slugs (e.g. `/beers`, `/real-ale` for a "cask ale" constraint on a pub)
- Results cached in `_pageHintCache` (process-local Map)
- Deterministic quote extraction with tiered phrase matching

### 7.4 GPT-4o Search (`gpt4o-search.ts` — ~824 LOC)

An alternative execution path using OpenAI's Responses API (`web_search_preview` tool). Combines discovery and verification in a single call. Up to 3 search rounds (`MAX_SEARCH_ROUNDS`), with a low-result threshold of 5 (`LOW_RESULT_THRESHOLD`) triggering additional rounds. This is the highest per-call cost in the system (§11).

### 7.5 Hunter.io

Used for contact email lookup on discovered leads. Called from `mission-executor.ts` post-discovery. Requires `HUNTER_API_KEY`. Returns contact email, name, and role where available, which are passed to `outreach-drafter.ts`.

---

## 8. Verification & Judgement Layer (Tower)

Tower is an **external proprietary API** that acts as the final authority on run quality and lead acceptance. Its unavailability is a hard blocker for run completion.

### 8.1 Three Tower Endpoints

| Module | Endpoint | Purpose |
|---|---|---|
| `tower-judgement.ts` | `/evaluate` | Evaluates run-level quality — returns `CanonicalVerdict`: `PASS`, `PARTIAL`, `STOP`, `ERROR`, `CHANGE_PLAN` |
| `tower-artefact-judge.ts` | `/judge-artefact` | Judges a specific artefact (delivery summary) — returns verdict + action |
| `tower-semantic-verify.ts` | `/semantic-verify` | Verifies semantic correctness of extracted mission vs. raw user input |

### 8.2 Stub Mode

`TOWER_ARTEFACT_JUDGE_STUB=true` stubs the artefact judge, returning a hardcoded `PASS` verdict. Allows development/testing without a live Tower connection. The evaluate and semantic-verify endpoints do not have an equivalent stub.

### 8.3 Verdict Flow

Tower's verdict is the **final determinant** of run status. After CVL produces `cvlVerifiedExactCount`, the delivery summary is sent to Tower via `/judge-artefact`. Tower returns a `finalVerdict` and `finalAction` (`accept`, `stop`, `change_plan`, `retry`, `continue`). These are mapped to `CanonicalVerdict` and stored in the `DeliverySummaryPayload.status` field. `TrustStatus` (`VERIFIED`, `UNVERIFIED`, `UNTRUSTED`) is also derived from Tower's response.

The `COMPLETED` and `TRUSTED` status values were intentionally removed in Phase 3 (noted in comments) as they added no signal.

### 8.4 Startup Validation

`assertTowerConfig()` is called on startup and throws if required Tower environment variables (`TOWER_API_BASE_URL`, `TOWER_API_KEY`) are absent in non-development environments.

---

## 9. Reloop Engine

### 9.1 Loop Skeleton (`reloop/loop-skeleton.ts` — ~1,062 LOC)

The reloop system manages multi-attempt search execution. It wraps the entire mission execution in a retry loop governed by two hard limits:

| Limit | Default | Override |
|---|---|---|
| Wall-clock deadline | 8 minutes | `RELOOP_WALL_CLOCK_TIMEOUT_MS` |
| Maximum loops | 3 | `RELOOP_MAX_LOOPS` |

Each loop iteration:
1. Calls `rulesPlan()` (§9.2) to select an executor
2. Executes the chosen executor
3. Evaluates results via the judge adapter
4. Decides whether to continue, stop, or change strategy

A `circuitBreaker` flag is set on the final loop, constraining the planner to the fastest available executor.

Per-loop state is persisted to the `reloop_loop_state` Supabase table, enabling post-run analysis.

### 9.2 Reloop Planner (`reloop/planner.ts`)

**Rule-based — no LLM as primary path.** Logic:

1. If `circuitBreaker` is active → use the first available executor unconditionally
2. If loop 1 and `executionPath === 'gpt4o_primary'` → use `gpt4o_search`
3. If loop 1 and a **learning store record** exists for this query shape:
   - `search_budget_pages >= 2` → skip GP cascade, start with `gpt4o_search` (prior runs needed multiple loops)
   - Otherwise → proceed with `gp_cascade`
4. Default loop 1 → `gp_cascade`
5. Subsequent loops → rotate through untried executors

An `llm-planner.ts` module exists as a fallback (hardcoded `gpt-4o-mini`, no env override) for cases where the rules planner cannot decide.

### 9.3 Three Executors

| Executor | Description |
|---|---|
| `gp_cascade` | Google Places → Brave Search → Web Visit — cheap, structured, fast |
| `gpt4o_search` | GPT-4o Responses API — high quality, higher cost |
| `outreach` | Outreach drafting and sending executor |

### 9.4 Learning Store

The learning store (`learning-store.ts`, `learning-layer.ts`) records behavioural knobs per **query shape key**. The shape key is a deterministic hash:

```
intent_class :: canonicalised_entity_type :: COUNTRY :: [sorted constraint attrs]
```

Example: `find_venues::pubs::UK::attr:cask_ale`

Currently **two active knobs**:
- `default_result_count` — adjusts target result count for this shape
- `search_budget_pages` — how many search loops prior runs required

The learning system is functional but conservative. Only these two knobs are actively used by the planner; richer signals (e.g. which executor performed best) are not yet leveraged.

---

## 10. Auxiliary Systems

### 10.1 Sleep-Wake Monitor System (`sleep-wake/`)

Enables recurring goal monitoring (hourly, daily, weekly). Architecture:

- `scheduled_monitors` Supabase table holds active goals with `next_wake_at`, `is_active`, `schedule` type
- `wake-scheduler.ts` polls for due monitors (max 5 at a time), gated by `SLEEP_WAKE_ENABLED=true` and `SLEEP_WAKE_MAX_DAILY` (default 5 per day)
- `wake-executor.ts` re-runs the goal through the supervisor and collects found entity names
- `delta-detector.ts` compares current entity names against `baseline_entity_names` using normalised string set-diff (`the ` prefix stripping, lowercase)
- **New entities found:** inserts a nudge message into the `messages` table for the original conversation
- **5+ consecutive empty wakes:** inserts an escalation nudge asking the user whether to continue monitoring

The scheduler uses a process-local `isWaking` mutex (not distributed) to prevent concurrent wake runs.

### 10.2 Subconscious Nudge System (`subcon/`)

A pluggable background analysis system. Architecture:

- `SubconsciousPack` interface: `{ id: SubconsciousPackId, run(ctx: SubconContext): Promise<SubconOutput> }`
- `registry.ts`: `Map<SubconsciousPackId, SubconsciousPack>` — packs registered at startup
- `scheduler.ts`: periodic runner that invokes registered packs per account
- `SubconVerticalMapping.ts`: maps industry vertical to relevant packs (e.g. brewery vertical → brewery pack)
- Nudge output stored in `subconscious_nudges` Drizzle table
- Current known packs: `stale_leads` (flags leads with no pipeline activity), `BreweryVerticalPack` (brewery-specific signals)

### 10.3 Outreach System

Complete cold-outreach pipeline within the supervisor:

1. **`outreach-drafter.ts`** — GPT-4o-mini drafts personalised email (<150 words). Uses lead name, address, website, contact info, match summary, and evidence snippets. Requires `OPENAI_API_KEY` (hard throw if absent — no Anthropic fallback).
2. **`outreach-transport.ts`** — Resend transport with two safety layers:
   - **Layer 1 (test mode):** `OUTREACH_TEST_MODE=true` redirects all outgoing email to `OUTREACH_TEST_REDIRECT_EMAIL` with a warning banner
   - **Layer 2 (domain allow-list):** `OUTREACH_ALLOWED_DOMAINS` (comma-separated) blocks sends to unrecognised domains and marks the message `failed` in the DB
3. State machine in `outreach_messages` Supabase table tracks: draft → queued → sent / failed

### 10.4 Belief Store

After each run, `belief-writer.ts` derives up to 3 structured claims from the delivery summary and writes them to the `belief_store` Drizzle table. Current belief triggers:
- Hard constraint listed as unverifiable by CVL (confidence 0.95)
- Tower returned `STOP` verdict with a stop reason (confidence 0.90)
- Partial delivery with shortfall (confidence 0.85)

Beliefs are linked to both `runId` and `goalId` for cross-run aggregation.

### 10.5 AFR Logger (`afr-logger.ts`)

All significant run events are written to the `agent_activities` Supabase table in a format compatible with the UI's Live Activity panel. Fields: `user_id`, `run_id`, `conversation_id`, `action_taken`, `status`, `task_generated`, `metadata`. Writes are fire-and-forget — a Supabase error is logged but does not fail the enclosing operation.

### 10.6 Daily Cron Agent (`cron/daily-agent.ts`)

`node-cron` job running at `0 9 * * *` (configurable via `DAILY_AGENT_CRON_SCHEDULE`). Calls `executeTasksForAllUsers()` from `server/autonomous-agent.ts`. Gated by `DAILY_AGENT_ENABLED` (default `true`). Produces a `CronExecutionResult` report with per-user task counts and success rates. Uses `ClaudeAPIService` (`claude-3-5-sonnet-20241022`, `temperature=1.0`, 5 calls/minute server-side rate limit — see §11 callsite #15).

### 10.7 Deep Research

`server/supervisor/research-provider.ts` implements three research providers:
- `OpenAIResponsesProvider` — `gpt-4.1` with Responses API web search
- `PerplexityResearchProvider` — `llama-3.1-sonar-large-128k-online`
- `AnthropicResearchProvider` — `claude-sonnet-4-20250514`

Provider selection is via constructor argument. Scheduled by `deep-research-scheduler.ts`.

### 10.8 Core Infrastructure

`server/core/` provides three infrastructure primitives — all **in-memory and process-local**:

| Primitive | Implementation | Notable limitation |
|---|---|---|
| Event Bus | `InMemoryEventBus` | No persistence, no cross-process delivery |
| Scheduler | `InMemoryScheduler` | No persistence, lost on restart |
| Task Runner | `TaskRunner` with lifecycle hooks, timeout, retry | Solid implementation but single-process |

---

## 11. LLM Usage Inventory

Full credit to the existing `docs/LLM_USAGE_REPORT.md` (generated April 22 2026) which contains the definitive per-callsite table. The following is a structural summary plus additions/corrections from the current analysis.

### 11.1 All Callsites

| # | File | Purpose | Provider Chain | Default Model | Hot Path | Cost Tier |
|---|---|---|---|---|---|---|
| 1 | `conversation-turn-classifier.ts` | Turn type classification | Groq → Anthropic → OpenAI | `claude-haiku-4-5-20251001` | ✅ Every message | Low |
| 2 | `conversation-router.ts` | Route to SEARCH/CLARIFY/etc. | Anthropic → OpenAI → Groq | `claude-sonnet-4-5-20250929` | ✅ Every message | **💰 High** |
| 3 | `chat-handler.ts` | Streaming chat response | Groq → Anthropic | `claude-sonnet-4-6` | DISCUSS/CHAT | **💰 High** |
| 4 | `llm-failover.ts` callLLMStream | Streaming wrapper | Groq → Anthropic | `llama-3.3-70b` / `claude-sonnet-4-6` | DISCUSS/CHAT | Medium |
| 5 | `mission-extractor.ts` Pass 1 | Semantic interpreter | OpenAI → Anthropic (429) | `gpt-4o-mini` | SEARCH path | Medium |
| 6 | `mission-extractor.ts` Pass 2 | Schema mapper | OpenAI → Anthropic (429) | `gpt-4o-mini` | SEARCH path | Medium |
| 7 | `mission-extractor.ts` Pass 3 | Intent narrative | OpenAI → Anthropic (429) | `gpt-4o-mini` | SEARCH path | Medium |
| 8 | `goal-to-constraints.ts` | Legacy constraint parser | OpenAI → Anthropic (429) | `gpt-4o-mini` | SEARCH path | Medium |
| 9 | `gpt4o-search.ts` | Web search discovery + verify | OpenAI only | `gpt-4o` | gpt4o executor | **💰💰 Highest** |
| 10 | `rescue-llm.ts` | Self-heal / clarification | Anthropic | `claude-3-haiku-20240307` | Failure path | Low |
| 11 | `smart-clarify.ts` | Clarification generation | Anthropic | `claude-3-5-haiku-20241022` | Failure/edge | Low |
| 12 | `result-discussion.ts` | Answer questions on results | Anthropic → Groq → OpenAI | `claude-3-haiku-20240307` | DISCUSS route | Low |
| 13 | `outreach-drafter.ts` | Draft personalised emails | OpenAI only | `gpt-4o-mini` | On-demand | Low |
| 14 | `reloop/llm-planner.ts` | Reloop executor selection fallback | OpenAI only | `gpt-4o-mini` | Fallback only | Low |
| 15 | `services/claude-api.ts` | Autonomous agent intelligence | Anthropic only | `claude-3-5-sonnet-20241022` | Daily cron | **💰 High** |
| 16 | `intent-extractor.ts` | Canonical intent extraction | OpenAI → Anthropic | `gpt-4o-mini` | Possibly legacy | Unknown |
| 17 | `explain-run.ts` | Human-readable run summaries | OpenAI → Anthropic | `gpt-4o-mini` | On-demand | Low |
| 18 | `research-provider.ts` (OpenAI) | Deep research web search | OpenAI | `gpt-4.1` | Scheduled | **💰 High** |
| 19 | `research-provider.ts` (Perplexity) | Deep research live web | Perplexity | `llama-3.1-sonar-large-128k-online` | Scheduled | Medium |
| 20 | `research-provider.ts` (Anthropic) | Deep research | Anthropic | `claude-sonnet-4-20250514` | Scheduled | **💰 High** |
| +1 | `web-visit.ts` `getLLMPageHints()` | URL slug suggestion | via `callLLMText` | inherits failover defaults | Per scraped page | Low |

**Total: 20+ distinct callsites across 5 providers.**

### 11.2 Provider Summary

| Provider | Callsites | Notes |
|---|---|---|
| Anthropic | 13 | Dominant. Powers routing, chat, mission extraction fallback, rescue, research |
| OpenAI | 12 | Primary for mission extraction, GPT-4o web search, outreach, research |
| Groq | 2 active | Available as failover for classifier, router, chat streaming |
| Perplexity | 1 | Deep research only. Key not in documented env vars |
| Google/Gemini | 0 | Not present |

### 11.3 Key Observations

- **Router cost risk:** Callsite #2 fires on every single user message using Sonnet-class model. This is a structured JSON classification task that Haiku handles reliably. Swapping to Haiku would reduce per-message cost by ~10×.
- **Three sequential LLM calls on SEARCH path:** Passes 1, 2, and 3 of mission extraction all fire sequentially. On a 15-second timeout each, worst-case pre-execution latency from extraction alone is 45 seconds.
- **Deprecated model references:** `claude-3-haiku-20240307` (old Claude 3 Haiku) appears in rescue-llm.ts (callsite #10) and result-discussion.ts (callsite #12). This model may be deprecated or removed by Anthropic.
- **LLM failover is not universal:** `outreach-drafter.ts` (callsite #13), `reloop/llm-planner.ts` (callsite #14), and `services/claude-api.ts` (callsite #15) do not use `llm-failover.ts`. They hard-throw if their specific provider key is absent.
- **`intent-extractor.ts` status unclear:** It defines its own `callLLM()` function independent of `llm-failover.ts` and overlaps semantically with mission extractor. Its relationship to the active pipeline is not fully resolved — it may be dead code or a shadow path controlled by `INTENT_EXTRACTOR_MODE`.

### 11.4 LLM Failover Chain (`llm-failover.ts`)

The central failover utility for most callsites. Default provider order: **Groq → Anthropic → OpenAI** (filtered by available API keys). Supports:
- `preferredProvider` override per call
- `providerChain` fully custom ordered list
- Per-label model override via env: `${LABEL.toUpperCase()}_LLM_MODEL`
- `callLLMText` — simple string return
- `callLLMStream` — SSE streaming (Groq first, then Anthropic raw SSE, fallback to non-streaming)
- Per-provider timeout (default 15 seconds, `LLM_TIMEOUT_MS` override)

---

## 12. External Integrations

| Service | Key Env Var | Usage | Failure Mode |
|---|---|---|---|
| **Google Places API** | `GOOGLE_PLACES_API_KEY` | Primary business discovery | GP cascade falls back to Brave Search |
| **Brave Search API** | `BRAVE_SEARCH_API_KEY` | Web search for discovery + evidence | Quota exceeded flagged; run degrades |
| **Hunter.io** | `HUNTER_API_KEY` | Contact email lookup | Non-fatal; leads delivered without contact |
| **OpenAI** | `OPENAI_API_KEY` | GPT-4o search, mission extraction, outreach | Outreach hard-throws; extraction falls back to Anthropic |
| **Anthropic** | `ANTHROPIC_API_KEY` | Chat, routing, mission extraction, rescue | Falls back to OpenAI/Groq via failover |
| **Groq** | `GROQ_API_KEY` | LLM failover (streaming preferred) | Non-fatal; removed from chain if absent |
| **Perplexity** | `PERPLEXITY_API_KEY` | Deep research provider | Not in documented required env vars |
| **Resend** | `RESEND_API_KEY` | Outreach email transport | Non-fatal if outreach not requested |
| **Tower** | `TOWER_API_BASE_URL` + `TOWER_API_KEY` | Final run verdict + semantic verification | **Hard blocker** — startup throws if missing in production |
| **Supabase** | `SUPABASE_URL` + `SUPABASE_ANON_KEY` | Real-time features, scheduled monitors, messages, activity feed | Many features degrade; sleep-wake disabled; AFR logging silently skipped |
| **Neon PostgreSQL** | `DATABASE_URL` | Primary relational store | Fatal — app cannot start |

---

## 13. Testing Coverage

### 13.1 Test File Inventory

35 test files found (`.test.ts` pattern), concentrated in:

| Area | File | Notes |
|---|---|---|
| Supervisor core | `canonical-intent.test.ts` | Canonical intent extraction contract |
| Supervisor core | `verification-policy.test.ts` | Policy derivation rules |
| Supervisor core | `learning-layer.test.ts` | Learning store read/write |
| Subcon | `registry.test.ts` | Pack registration and lookup |
| Subcon | `scheduler.test.ts` | Pack scheduler execution |
| Subcon | `SubconVerticalMapping.test.ts` | Vertical → pack mapping |
| Subcon | `scheduler.vertical-mapping.test.ts` | Combined mapping + scheduling |
| Verticals | `BreweryVerticalPack.test.ts` | Brewery pack behaviour |

### 13.2 Coverage Gaps

The following areas have **no test files** identified:

- `mission-extractor.ts` (the most complex LLM pipeline)
- `mission-executor.ts` (3,047 LOC, main execution path)
- `constraint-gate.ts` / `clarify-gate.ts`
- `cvl.ts` (constraint verification logic)
- `delivery-summary.ts` (lead exactness classification)
- `llm-failover.ts` (provider chain logic)
- `gpt4o-search.ts`
- `web-search.ts` / `web-visit.ts`
- `rescue-llm.ts` / `rescue-promotion.ts`
- `sleep-wake/` system
- `reloop/` engine
- `outreach-drafter.ts` / `outreach-transport.ts`
- Tower integration clients

### 13.3 Test Framework

Tests use what appears to be **Vitest** (inferred from test file patterns and the project's Vite stack). No CI configuration file (`github/workflows/` or similar) was found in the scanned directories, suggesting tests are run manually.

### 13.4 Assessment

Test coverage is concentrated on infrastructure utilities and pluggable subsystems (subcon, verticals). The **core intelligence path** — from mission extraction through execution to delivery — has no automated tests. This is a significant quality risk: any regression in the 7-step LLM pipeline would only be caught by manual testing or production observation.

---

## 14. Technical Debt & Risk Register

### 14.1 High Severity

| ID | Area | Description | Impact |
|---|---|---|---|
| TD-01 | LLM cost | Conversation router (callsite #2) uses Sonnet on every message for a JSON classification task | Linear cost scaling with user volume |
| TD-02 | Tower dependency | Tower unavailability is a hard blocker — no fallback verdict logic | Production outage risk |
| TD-03 | Single process | All execution happens in one Node.js process — no job queue, no worker isolation, no distributed coordination | Memory pressure, GC pauses during heavy runs, no horizontal scaling |
| TD-04 | Dual database | PostgreSQL + Supabase with no cross-database atomicity | Inconsistent state risk on partial failures |
| TD-05 | Deprecated models | `claude-3-haiku-20240307` used in rescue and discussion paths | May fail silently when Anthropic removes the model |
| TD-06 | Test coverage | No tests on the critical execution path (extractor, executor, CVL, delivery) | Regressions undetected until production |

### 14.2 Medium Severity

| ID | Area | Description | Impact |
|---|---|---|---|
| TD-07 | Dual constraint systems | `goal-to-constraints.ts` (legacy) and `mission-schema.ts` coexist with `mission-bridge.ts` translating between them | Constraint fidelity loss via `ConstraintDowngrade`; maintenance complexity |
| TD-08 | In-memory circuit breaker | Chat handler circuit breaker is process-local, reset on every restart | No protection in multi-instance or restart scenarios |
| TD-09 | In-memory infrastructure | EventBus, Scheduler, page-hint cache are all process-local Maps | Lost on restart; no persistence guarantee |
| TD-10 | Three sequential LLM calls | Mission extraction Pass 1 + 2 + 3 fires three `gpt-4o-mini` calls sequentially | ~45s worst-case latency before execution begins |
| TD-11 | No env override for key callsites | `reloop/llm-planner.ts` (callsite #14) and `services/claude-api.ts` (callsite #15) hardcode model names | Cannot tune without code changes |
| TD-12 | intent-extractor.ts status | Defines its own `callLLM()`, overlaps with mission extractor, unclear pipeline role | May be dead code; if live, creates redundant LLM calls |
| TD-13 | Perplexity key undocumented | `PERPLEXITY_API_KEY` not in `replit.md` required env vars | Deep research silently fails if key absent |
| TD-14 | `run-narrative.ts` domain mismatch | File contains manufacturing/scrap-rate domain concepts (`scrap_rate_percent`, `achievable_scrap_floor`, `drift_detected`) unrelated to lead generation | Suggests copy-paste from another product; dead/misleading code |

### 14.3 Low Severity

| ID | Area | Description |
|---|---|---|
| TD-15 | `RESCUE_LLM_MODEL` shared env var | `rescue-llm.ts` and `smart-clarify.ts` share the same env var but have different hardcoded defaults — setting the var affects both inconsistently |
| TD-16 | Learning store knobs | Only 2 of a possible rich set of knobs (`default_result_count`, `search_budget_pages`) are actively used by the planner |
| TD-17 | No migration runner unification | SQL migrations for Neon and Supabase are run via separate tools with no single command |
| TD-18 | `temperature=1.0` for autonomous agent | `claude-api.ts` uses temperature 1.0 for autonomous agent reasoning — unusually high for structured planning tasks |

---

## 15. Replication Difficulty Assessment

### 15.1 Summary

Replicating this system at feature parity is a **very high effort** undertaking. The following assessment uses a 1–5 scale (1 = trivial, 5 = extremely difficult).

### 15.2 Component-by-Component Assessment

| Component | Difficulty | Reason |
|---|---|---|
| Express + Vite monorepo scaffold | 1 | Standard pattern |
| Drizzle + Neon schema | 2 | Straightforward but many tables |
| Frontend (React/TQ/shadcn) | 2 | Standard modern stack |
| LLM failover chain | 2 | Well-structured, documented logic |
| Conversation routing | 2 | LLM + prompt engineering |
| Mission extraction (2-pass) | **4** | 3 sequential LLM calls with custom prompt engineering, implicit expansion logic, checklist generation, and rescue/promotion feedback loop |
| Constraint gate (1,241 LOC) | **4** | Deep domain logic with 13+ constraint types, capability matrix, blocking vs. downgrade decisions |
| CVL — constraint verification | **4** | Evidence tiers, geo-bbox verification, source-aware confidence scoring, lead exactness classification |
| Mission planner | 3 | Deterministic but requires deep constraint type knowledge |
| Mission executor (3,047 LOC) | **5** | Largest file; orchestrates all tools, manages session isolation, timeout/tool-call limits, SSE events, full delivery pipeline |
| Tower integration | **4** | Proprietary external service — replication requires building the Tower API itself or finding an equivalent |
| Reloop engine | **4** | Rule-based planner + learning store integration + 3-executor rotation + wall-clock deadline enforcement |
| Sleep-wake monitor | 3 | Polling + delta detection is straightforward; the complexity is in the wake executor re-running the full supervisor |
| Belief store + delivery summary | 3 | Well-defined logic once the domain types are understood |
| Subconscious nudge system | 3 | Clean registry pattern; complexity is in pack logic |
| Outreach pipeline | 3 | Email drafting + Resend transport + safety layers |
| Rescue + promotion loop | **4** | Self-healing + Supabase pattern promotion + hourly cache is non-trivial |
| Learning store + shape key | 3 | Deterministic hash + DB knobs, but the feedback loop to planner is implicit |
| Deep research providers | 2 | Thin wrappers around existing APIs |

### 15.3 Irreplaceable / Hardest to Replicate

1. **Tower API** — The system is architecturally dependent on an external proprietary judgement service. Without Tower, there is no final verdict and no run completion. Replacing it requires either building an equivalent scoring API or encoding its judgement logic locally.

2. **Mission extractor prompt engineering** — The three-pass extraction system (semantic → schema → narrative) with the `ConstraintChecklist`, `ImplicitExpansionTrace`, and auto-rescue/auto-promotion feedback loop represents deep, accumulated prompt work. The prompts themselves are the intellectual core of the extraction quality.

3. **Constraint gate capability matrix** — The 1,241-line gate encodes a large domain knowledge graph about which constraint types are verifiable by which tools, under what conditions. This knowledge was accumulated through operational experience rather than derived from first principles.

4. **Dual-database coordination logic** — The implicit conventions governing which data lives in Neon vs. Supabase, and the fallback/degradation behaviour when Supabase is unavailable, would require significant reverse-engineering to reproduce.

### 15.4 Overall Replication Estimate

| Dimension | Estimate |
|---|---|
| Engineering effort (solo, senior) | 12–18 months |
| Engineering effort (team of 3) | 5–8 months |
| Prompt engineering investment | 2–4 months additional (not substitutable with pure code time) |
| Risk of functional equivalence | Moderate — the Tower API is a proprietary external dependency; its behaviour cannot be fully replicated without specification documents |

The system represents a mature, product-specific intelligence layer — not a generic framework. Its value is primarily in the accumulated constraint domain knowledge, prompt engineering, and the Tower integration contracts, not in the underlying infrastructure patterns, which use standard open-source libraries throughout.

---

*End of report. Sections are self-contained and can be read independently.*
