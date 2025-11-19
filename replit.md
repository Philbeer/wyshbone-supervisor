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
- **Chat Integration**: Supervisor's AI integrates into Wyshbone UI chat via a queue-based architecture using shared Supabase tables (`messages`, `supervisor_tasks`). The UI detects Supervisor intent, creates tasks, and streams Supervisor responses.

### Feature Specifications
- RESTful API endpoints for leads, user context, and signals.
- Database schema includes `users`, `user_signals`, and `suggested_leads` tables.
- Signals represent user actions that trigger lead discovery.
- Leads include enriched data (e.g., emails, places) and trigger email notifications.

### System Design Choices
- `IStorage` interface for database abstraction, with `DatabaseStorage` using Drizzle ORM.
- Hardcoded "demo-user" for current authentication, with future support for username/password and session management planned.
- Comprehensive logging and error handling for robustness.

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