# Supervisor DB Startup Fix

## Issue
The supervisor service was throwing `PGRST205` errors on startup because the `supervisor_tasks` table didn't exist in Supabase.

## Fix Applied
Modified `server/supervisor.ts` to gracefully handle the missing table:
- Added a `missingTableWarned` flag to prevent repeated warnings
- Check for error code `PGRST205` (table not found)
- Show a helpful warning message once, then continue without errors
- Server now starts cleanly even if the table doesn't exist

## Result
✅ `npm run dev` now starts without database errors
✅ Server runs on http://127.0.0.1:3001
✅ Chat integration feature is gracefully disabled until migration is run

## Optional: Enable Chat Integration

If you want to enable the chat integration feature, create the `supervisor_tasks` table in Supabase:

### Option 1: Supabase Dashboard (Recommended)
1. Open Supabase Dashboard: https://supabase.com/dashboard
2. Navigate to your project: `zipsbmldjxytzowmmohu`
3. Go to SQL Editor
4. Copy and run the contents of `migrations/supabase-supervisor-integration.sql`

### Option 2: Using the Migration Script
```bash
tsx server/migrations/run-supabase-migration.ts
```

Note: This script may fail if your Supabase instance doesn't have the `exec_sql` RPC function enabled. Use Option 1 if this occurs.

## What the Migration Creates

The migration creates:
1. **supervisor_tasks table** - Queue for UI to request Supervisor processing
2. **Indexes** - For efficient querying by status, conversation, and user
3. **Messages table extensions** - Adds `source` and `metadata` columns

## Verification

After running the migration:
1. Restart the supervisor: `npm run dev`
2. The warning message should disappear
3. Check Supabase for the `supervisor_tasks` table

## Files Modified
- `server/supervisor.ts` - Added graceful error handling for missing table
