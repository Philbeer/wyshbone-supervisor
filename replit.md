# Wyshbone Supervisor Suite

## Overview

Wyshbone Supervisor is a proactive lead generation system that automatically finds and scores prospects based on user signals. The application monitors user behavior and preferences, then uses AI to identify and suggest relevant leads with contact information. Built as a B2B productivity tool, it features a Linear-inspired design system optimized for data density and workflow efficiency.

The system consists of a React frontend with a Node.js/Express backend, using PostgreSQL (via Neon) for data persistence and Drizzle ORM for database operations.

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
- Component library includes: Dashboard, LeadCard, SuggestionsPanel, SignalEvent, StatsCard, EmptyState
- Sidebar navigation pattern with collapsible states

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
- Credentials configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE, SUPABASE_ANON available as environment variables)
- Referenced in attached documentation for signal storage
- Intended for user_signals polling by supervisor meta-agent
- Ready for integration

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