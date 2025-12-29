# Agent Guidelines for Wyshbone Supervisor

This document defines how AI agents (Cursor, Claude, etc.) should operate in this repository.

## 🚫 CRITICAL: QA Gate Requirement

**You MUST NOT declare any task complete until you have:**

1. ✅ Booted the supervisor service locally (`npm run dev`)
2. ✅ Run the smoke test (`npx tsx scripts/smoke-test.ts`)
3. ✅ Confirmed no unhandled errors in logs
4. ✅ Verified no 404/500 on modified endpoints
5. ✅ Added and passed 1-3 task-specific checks

**If any check fails:** Diagnose → Fix → Re-run → Repeat until green.

See `.cursor/rules/qa-gate.mdc` for full QA gate specification.

---

## Repository Structure

```
wyshbone-supervisor/
├── server/              # Backend (Express + TypeScript)
│   ├── routes.ts        # API endpoints
│   ├── storage.ts       # Database operations
│   ├── plan-executor.ts # Plan execution logic
│   ├── supervisor.ts    # Core supervisor service
│   └── types/           # TypeScript types
├── client/              # Frontend (React + Vite)
│   └── src/
│       ├── pages/       # Route pages
│       └── components/  # UI components
├── shared/              # Shared types/schemas
├── scripts/             # Utility scripts
│   └── smoke-test.ts    # QA smoke test
└── migrations/          # Database migrations
```

## Development Commands

```bash
# Start development server (backend + frontend)
npm run dev

# Run smoke test (QA gate)
npx tsx scripts/smoke-test.ts

# Type check
npm run check

# Database operations
npm run db:migrate    # Run migrations
npm run db:seed       # Seed data
npm run db:reset      # Reset database
```

## Key APIs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/plan/start` | POST | Create a new plan |
| `/api/plan/approve` | POST | Approve and execute plan |
| `/api/plan/progress` | GET | Get execution progress |
| `/api/plan-status` | GET | Alias for progress |
| `/api/leads` | GET | Get suggested leads |
| `/api/signals` | GET | Get user signals |
| `/api/user/context` | GET | Get user context |

## Task Completion Checklist

Before marking ANY task as done:

```markdown
## QA Report

### Smoke Test: [✅ PASSED / ❌ FAILED]
- Endpoints: X/Y passed
- Failures: [none / list]

### Task-Specific Checks:
- [ ] [Specific check 1]
- [ ] [Specific check 2]
- [ ] [Specific check 3]

### Fixes Applied:
- [List any fixes]

### Files Changed:
- [List files]

### Status: [✅ READY / ❌ NEEDS FIX]
```

## Common Patterns

### Adding a New Endpoint
1. Add route in `server/routes.ts`
2. Add types if needed in `server/types/`
3. Run smoke test
4. Add endpoint-specific check to QA report

### Modifying Plan Execution
1. Update `server/plan-executor.ts`
2. Test with: POST `/api/plan/start` → POST `/api/plan/approve`
3. Verify plan completes without errors
4. Check `plan-progress` shows correct status

### Database Changes
1. Update schema in `shared/schema.ts`
2. Create migration in `migrations/`
3. Run `npm run db:migrate`
4. Verify with smoke test

## Environment Variables

Required for full functionality:
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_ANON_KEY` - Supabase anon key
- `GOOGLE_PLACES_API_KEY` - For places search
- `HUNTER_API_KEY` - For email enrichment
- `OPENAI_API_KEY` - For AI features

## Branching Strategy

- `main` - Production-ready code
- `v1-*` - Version 1 feature branches
- Feature branches: `feature/description`
- Always run QA gate before merging

---

**Remember: No task is complete without a passing QA report!**


