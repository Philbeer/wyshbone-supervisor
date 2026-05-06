# Wyshbone Supervisor Suite

Wyshbone Supervisor is a B2B lead generation system for automatic prospect identification and scoring, delivering real-time lead suggestions with contact information via email and an integrated chat.

## Run & Operate

```bash
# Run the development server
npm run dev

# Build the project
npm run build

# Run type checking
npm run typecheck

# Generate Drizzle migrations
npm run generate-migrations

# Push DB schema changes
npm run db:push
```

**Required Environment Variables:**
- `DATABASE_URL`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `PERPLEXITY_API_KEY`
- `HUNTER_API_KEY`
- `RESEND_API_KEY`
- `GOOGLE_PLACES_API_KEY`
- `BRAVE_SEARCH_API_KEY`
- `TOWER_API_BASE_URL`
- `TOWER_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `RUN_EXECUTION_TIMEOUT_MS` (optional, default: 120000)
- `MAX_TOOL_CALLS_PER_RUN` (optional, default: 150)
- `MISSION_EXTRACTOR_MODE` (optional: `active`, `shadow`, `off`, default: `active`)
- `INTENT_EXTRACTOR_MODE` (optional: `active`, `shadow`, `off`, default: `off`)
- `TOWER_ARTEFACT_JUDGE_STUB` (optional: `true`/`false`, default: `false` for stubbing Tower semantic verification)

## Stack

- **Frontend**: React, TypeScript, Vite, Wouter, TanStack Query, Tailwind CSS, shadcn/ui
- **Backend**: Node.js (ESM), Express, TypeScript
- **Database**: PostgreSQL (Neon serverless)
- **ORM**: Drizzle ORM
- **Validation**: Zod
- **Build Tool**: Vite

## Where things live

- **Frontend UI Components**: `ui/`
- **Backend API Routes**: `server/api/`
- **Supervisor Logic**: `server/supervisor/`
  - **Mission Extraction & Planning**: `server/supervisor/mission-extractor.ts`, `server/supervisor/mission-planner.ts`
  - **Execution**: `server/supervisor/mission-executor.ts`
  - **Constraint Gates**: `server/supervisor/clarify-gate.ts`, `server/supervisor/constraint-gate.ts`
  - **Verification Logic**: `server/supervisor/cvl.ts`, `server/supervisor/verification-policy.ts`, `server/supervisor/tower-semantic-verify.ts`
  - **Core Tools**: `server/supervisor/tools/`
- **Database Schema**: `shared/schema.ts`
- **Migrations**: `migrations/`
- **Shared Types**: `shared/types/`
- **Configuration**: `config/`

## Architecture decisions

- **Mission-Driven Execution First**: The `StructuredMission` extracted from user input is the primary driver for plan execution, moving away from legacy `ParsedGoal` as the source of truth. This ensures consistent interpretation and execution.
- **Strict Pre-Execution Constraint Gates**: A multi-layered gate system (`clarify-gate.ts`, `constraint-gate.ts`) runs before any costly tool execution (LLM calls, Google searches) to ensure all user constraints are understood and resolvable. Unresolved hard constraints block execution until clarified.
- **Deterministic Constraint-Led Evidence Extraction**: Evidence gathering (WEB_VISIT, WEB_SEARCH) is driven by specific constraints, with deterministic quote extraction, tiered phrase matching, and source-aware confidence scoring to reduce LLM reliance for basic evidence.
- **Tower-Authoritative Delivery Status**: Final run status and lead verification are determined by the Tower Judgement API, ensuring consistent, external validation of lead quality and adherence to constraints, replacing internal, less rigorous checks.
- **Real Execution Timeout System**: Critical for stability, runs have hard time and tool-call limits. Exceeding these limits forces a `timed_out` status, preventing indefinite execution and resource exhaustion.

## Product

- Automatic prospect identification and scoring
- Real-time lead suggestions via email and integrated chat
- Enhanced sales processes and expanded market reach
- Actionable data for sales teams
- Improved workflow efficiency
- Deep research capabilities
- Lead refinement (post-search keyword filtering)
- Monitoring and alerts for lead changes

## User preferences

Preferred communication style: Simple, everyday language.

### Wine Recommendation Response Format
When responding to any wine recommendation query, always use this structure:

1. **Bold header** naming the region, grape, or style.
2. One sentence of specific context — what makes this region or style distinctive.
3. If presenting options, use a short labelled list (max 3 unless user asks for more):
   - **Taste direction label** in bold (e.g. **Dry**, **Sweeter**, **Special occasion**)
   - Wine name or style in *italics*
   - One sentence max explaining why it fits
4. Close with a single focused question — either a specific bottle search or a next step. Never ask two questions.

**Tone**: Knowledgeable but not condescending. Confident recommendations, not hedged lists. Write as a sommelier talking to a curious customer.

**Formatting rules**:
- Use markdown: **bold** for labels, *italics* for wine names and classifications
- Emoji sparingly — one per option at most, only where it aids scannability
- No bullet walls
- Never start a response with "I" or "Certainly"

### General Response Formatting
- Never include image placeholders or `[IMAGE: ...]` tags in any response. If a visual would be helpful, describe it in text only.

## Gotchas

- **Tower Integration**: Tower is critical for final verdicts and semantic verification. Network issues or misconfigurations with Tower can halt execution.
- **Clarification Loop**: If the system enters a clarification loop due to ambiguous user input or unresolved constraints, it will not proceed to lead generation until all blocking issues are resolved.
- **Stale Runs**: Ensure your local environment does not have orphaned or stuck `agent_runs` from previous sessions; `recoverOrphanedAgentRuns()` handles this on startup, but manual intervention might be needed.
- **Context Switching**: The session isolation guard will silently drop deliveries from older runs if a new task for the same conversation is initiated while the old one is still processing.

## Pointers

- **Drizzle ORM Docs**: [https://orm.drizzle.team/docs/overview](https://orm.drizzle.team/docs/overview)
- **TanStack Query Docs**: [https://tanstack.com/query/latest](https://tanstack.com/query/latest)
- **Tailwind CSS Docs**: [https://tailwindcss.com/docs](https://tailwindcss.com/docs)
- **shadcn/ui Docs**: [https://ui.shadcn.com/docs](https://ui.shadcn.com/docs)
- **Radix UI Docs**: [https://www.radix-ui.com/docs/primitives/overview/introduction](https://www.radix-ui.com/docs/primitives/overview/introduction)
- **Zod Docs**: [https://zod.dev/](https://zod.dev/)
- **Supabase Docs**: [https://supabase.com/docs](https://supabase.com/docs)
- **Google Places API Docs**: [https://developers.google.com/maps/documentation/places/web-service/overview](https://developers.google.com/maps/documentation/places/web-service/overview)