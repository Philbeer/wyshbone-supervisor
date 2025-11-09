# Wyshbone Supervisor Suite

## Overview

Wyshbone Supervisor is a proactive lead generation system that automatically finds and scores prospects based on user signals. The application monitors user behavior and preferences, then uses AI to identify and suggest relevant leads with contact information. 

**Key Capabilities:**
- **Email Notifications**: Automatically sends email notifications when new leads are found
- **Chat Integration**: Supervisor's AI participates directly in Wyshbone UI chat conversations
- **Real-time Responses**: Users can ask Supervisor to find leads and get intelligent responses within 30 seconds
- **Multi-channel Communication**: Supervisor delivers insights via both email and chat

Built as a B2B productivity tool, it features a Linear-inspired design system optimized for data density and workflow efficiency. The system consists of a React frontend with a Node.js/Express backend, using PostgreSQL (via Neon) for data persistence and Drizzle ORM for database operations.

**Architecture**: The Supervisor backend runs independently and integrates with the separate Wyshbone UI application through a shared Supabase database.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Technology Stack:**
- React with TypeScript
- Vite for build tooling and development server
- Wouter for client-side routing
- TanStack Query (React Query) for server state management
- Tailwind CSS for styling with custom design tokens

**UI Component System:**
- Built on shadcn/ui components (Radix UI primitives)
- "New York" style variant with custom theming
- Design system inspired by Linear for professional B2B aesthetics
- Component library includes: Dashboard, LeadCard, SuggestionsPanel, UserContextPanel, SignalEvent, StatsCard, EmptyState
- Sidebar navigation pattern with collapsible states
- UserContextPanel displays company profile, objectives, top facts, and active monitors

**State Management:**
- React Query for API data fetching and caching
- Local component state for UI interactions
- Query invalidation on user actions (refresh, create)

**Routing:**
- Three main routes: Dashboard (/), Settings (/settings), Signals (/signals)
- Wouter for lightweight client-side routing

### Backend Architecture

**Technology Stack:**
- Node.js with Express
- TypeScript for type safety
- ESM module system

**API Structure:**
- RESTful endpoints under `/api` prefix
- Endpoints:
  - `GET /api/leads` - Fetch suggested leads for demo user
  - `GET /api/user/context` - Fetch comprehensive user context (profile, facts, messages, monitors)
  - `GET /api/signals` - Fetch recent user signals
  - `POST /api/signals` - Create new signal (testing)
  - `POST /api/seed` - Seed initial data

**Storage Layer:**
- Database abstraction through `IStorage` interface
- `DatabaseStorage` implementation using Drizzle ORM
- Methods for user management, lead retrieval, signal tracking

**Development Features:**
- Vite middleware integration for HMR
- Request logging with timing
- Error overlay for runtime errors
- Custom logger with timestamps

### Data Storage

**Database:**
- PostgreSQL via Neon serverless
- Connection pooling with `@neondatabase/serverless`
- WebSocket support for serverless environment

**Schema Design:**
Three main tables defined in `shared/schema.ts`:

1. **users** - User accounts
   - id (UUID primary key)
   - username (unique)
   - password

2. **user_signals** - User behavior tracking
   - id (UUID primary key)
   - userId (foreign reference)
   - type (signal classification)
   - payload (JSONB for flexible data)
   - createdAt (timestamp)

3. **suggested_leads** - AI-generated lead suggestions
   - id (UUID primary key)
   - userId (foreign reference)
   - rationale (explanation text)
   - source (origin of suggestion)
   - score (real number for ranking)
   - lead (JSONB for lead details including name, address, email candidates)
   - createdAt (timestamp)

**ORM:**
- Drizzle ORM for type-safe database queries
- Drizzle-Zod integration for runtime validation
- Migration support via `drizzle-kit`

**Data Flow:**
- Signals represent user actions/preferences that trigger lead discovery
- Supervisor processes signals to generate scored lead suggestions
- Leads include enriched data (emails via Hunter.io, places via Google Places API)
- When lead is created, supervisor sends email notification to user via Resend
- Email notifications include full lead details and link to dashboard

### Authentication & Authorization

**Current Implementation:**
- Demo user mode with hardcoded "demo-user" ID
- User schema supports username/password authentication (not yet implemented)
- No session management or authentication middleware currently active

**Future Considerations:**
- Session-based authentication using `connect-pg-simple` (already in dependencies)
- User-specific data isolation once auth is enabled

## External Dependencies

### Third-Party Services

**Supabase:**
- Shared database with Wyshbone UI app
- Stores rich user context data:
  - `users` - Company profiles, industry, objectives, target markets, **email addresses**
  - `conversations` - Chat sessions
  - `messages` - Full conversation history (user ↔ AI)
  - `facts` - Ranked user preferences/needs with importance scores
  - `scheduled_monitors` - Active monitoring tasks showing engagement
  - `deep_research_runs` - Research queries revealing interests
  - `integrations` - Connected CRM/accounting platforms
  - `user_signals` - Behavioral signals triggering lead generation
- Credentials configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE, SUPABASE_ANON)
- Supervisor polls every 30s for new signals and builds comprehensive user context
- Ready for integration

**Resend (Email Service):**
- Transactional email service for lead notifications
- Automatically sends emails when new leads are generated
- Email includes: lead name, contact info, score, rationale, dashboard link
- HTML and plain-text templates with proper escaping
- Integration configured via Replit Connectors (connection:conn_resend_01K8TGCAX8WZAJ52G7YFJW46SB)
- Graceful error handling - email failures don't block supervisor
- Emails sent to user's address from Supabase `users` table

## Supervisor Chat Integration (NEW)

The Supervisor's AI intelligence now participates directly in Wyshbone UI chat conversations through a queue-based architecture:

### Architecture Overview

**Shared Database (Supabase):**
- `messages` table extended with `source` ('ui' | 'supervisor' | 'system') and `metadata` (JSONB)
- `supervisor_tasks` queue table for UI to request Supervisor processing
- Both Wyshbone Supervisor and Wyshbone UI apps connect to same Supabase instance

**Data Flow:**
1. User types message in Wyshbone UI chat
2. UI detects if Supervisor help is needed (keywords: "find leads", "analyze", etc.)
3. UI creates `supervisor_task` entry in Supabase with conversation context
4. Supervisor polls every 30s, finds pending tasks
5. Supervisor analyzes conversation, generates leads, formats response
6. Supervisor posts message to `messages` table with `source='supervisor'`
7. UI streams new messages via Supabase realtime subscription
8. User sees Supervisor's response with special badge and styling

### Task Types

- **generate_leads**: Find prospects using Google Places + Hunter.io
- **find_prospects**: Same as generate_leads
- **analyze_conversation**: Analyze chat history and provide insights
- **provide_insights**: Share business intelligence from user profile

### Supervisor Response Format

Supervisor messages include rich metadata:
```json
{
  "source": "supervisor",
  "metadata": {
    "supervisor_task_id": "task-uuid",
    "capabilities": ["lead_generation", "email_enrichment"],
    "lead_ids": ["lead-1", "lead-2", "lead-3"]
  }
}
```

### Integration with Wyshbone UI

See `INTEGRATION_INSTRUCTIONS_FOR_WYSHBONE_UI.md` for complete integration guide.

**UI Requirements:**
- Detect Supervisor intent from user messages
- Create supervisor_tasks in Supabase
- Subscribe to Supabase realtime for message updates
- Render Supervisor messages with distinctive styling (badge, border, metadata chips)
- Handle loading states while waiting for Supervisor response (~30s)

**Testing:**
- Test endpoint: `POST /api/test/supervisor-task` creates demo tasks
- Supervisor processes within 30 seconds
- Check Supabase `supervisor_tasks` and `messages` tables to verify

**Google Places API:**
- Mentioned in schema (place_id field) for lead enrichment
- Used to find physical business locations based on user signals

**Hunter.io:**
- Email discovery service for lead contact information
- Referenced in settings page with maxHunter configuration
- Used to populate emailCandidates field in leads

### UI Component Libraries

**Radix UI:**
- Comprehensive primitive component set (@radix-ui/react-*)
- Accordion, Dialog, Dropdown, Popover, Tabs, Toast, Tooltip, etc.
- Provides accessible, unstyled components for custom theming

**shadcn/ui:**
- Component configuration via `components.json`
- Custom styling applied through Tailwind utilities
- Path aliases for clean imports (@/components, @/lib, @/hooks)

### Development Tools

**Build & Development:**
- Vite with React plugin
- Replit-specific plugins: runtime error modal, cartographer, dev banner
- PostCSS with Tailwind and Autoprefixer
- esbuild for server bundling

**Type Safety:**
- TypeScript with strict mode
- Zod for runtime schema validation
- Drizzle-Zod for database schema validation

### Fonts & Assets

**Typography:**
- Inter font family via Google Fonts CDN
- Variable font weights (100-900)
- Preconnect optimization for performance