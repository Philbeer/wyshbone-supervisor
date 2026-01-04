# Daily Agent Cron Job - Implementation Guide

## Overview

The Daily Agent Cron Job automatically runs the autonomous agent every day at 9am for all active users. It generates goals, executes tasks, and handles errors gracefully without stopping if one user fails.

**Key Features:**
- 🕐 **Scheduled Execution** - Runs daily at 9am local time
- 🔄 **All Users Processing** - Processes all active users sequentially
- 🛡️ **Error Isolation** - One user's error doesn't stop others
- 💾 **Full Logging** - All executions logged to database
- 🧪 **Manual Trigger** - Can be manually triggered for testing
- ⚙️ **Configurable** - Schedule and enable/disable via environment variables

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     DAILY CRON JOB                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Scheduled Trigger (9am daily)                               │
│     ┌──────────────────────┐                                    │
│     │ node-cron scheduler  │                                    │
│     │ "0 9 * * *"          │                                    │
│     └──────────────────────┘                                    │
│              │                                                   │
│  2. Execute For All Users                                        │
│              │                                                   │
│     ┌────────▼──────────────────┐                               │
│     │ Get all active users:     │                               │
│     │ - Users with monitors     │                               │
│     │ - Users with goals        │                               │
│     └──────────────────────────┘                                │
│              │                                                   │
│  3. Process Each User (Sequential)                              │
│              │                                                   │
│     ┌────────▼──────────────────┐                               │
│     │ For each user:            │                               │
│     │ 1. Generate tasks (Claude)│                               │
│     │ 2. Execute tasks (Tools)  │                               │
│     │ 3. Log results            │                               │
│     │ 4. Handle errors          │                               │
│     │ 5. Continue to next user  │                               │
│     └──────────────────────────┘                                │
│              │                                                   │
│  4. Log Aggregate Results                                        │
│              │                                                   │
│     ┌────────▼──────────────────┐                               │
│     │ agent_activities:         │                               │
│     │ - user_id: 'system'       │                               │
│     │ - activity_type: daily_cron│                              │
│     │ - Total users processed   │                               │
│     │ - Success/failure stats   │                               │
│     │ - Execution duration      │                               │
│     └──────────────────────────┘                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Setup

### 1. Install Dependencies

Dependencies are already added to `package.json`:
- `node-cron@^3.0.3` - Cron scheduler
- `@types/node-cron@^3.0.11` - TypeScript types

Run:
```bash
npm install
```

### 2. Environment Variables

```bash
# Optional: Enable/disable cron job (default: enabled)
DAILY_AGENT_ENABLED=true

# Optional: Custom schedule (default: "0 9 * * *" = 9am daily)
DAILY_AGENT_CRON_SCHEDULE="0 9 * * *"

# Optional: For testing - run every minute
# DAILY_AGENT_CRON_SCHEDULE="*/1 * * * *"
```

### 3. Start Server

The cron job starts automatically when the server starts:

```bash
npm run dev
```

You should see:
```
🕐 Starting daily agent cron job...
   Schedule: 0 9 * * *  (Daily at 9:00 AM)
   Next run: 2026-01-05T09:00:00.000Z
✅ Daily agent cron job started successfully
```

---

## Usage

### Automatic Execution

The cron job runs automatically at 9am daily. No action needed!

It will:
1. Find all users with active goals/monitors
2. For each user:
   - Generate 3-5 daily tasks using Claude
   - Execute each task via unified tool endpoint
   - Log results to database
3. Report aggregate statistics

### Manual Trigger (Testing)

#### Option 1: API Endpoint

```bash
curl -X POST http://localhost:5000/api/agent/trigger
```

Response:
```json
{
  "status": "success",
  "message": "Daily agent executed successfully",
  "result": {
    "cronJobId": "daily_agent_1735996800000",
    "totalUsers": 5,
    "successfulUsers": 5,
    "failedUsers": 0,
    "totalTasksGenerated": 17,
    "totalTasksExecuted": 17,
    "totalSuccessfulTasks": 15,
    "totalInterestingResults": 8,
    "duration": 45230
  }
}
```

#### Option 2: TypeScript

```typescript
import { triggerDailyAgentManually } from './server/cron/daily-agent';

const result = await triggerDailyAgentManually();
console.log('Processed', result.totalUsers, 'users');
console.log('Duration:', result.duration, 'ms');
```

### Check Status

```bash
curl http://localhost:5000/api/agent/status
```

Response:
```json
{
  "enabled": true,
  "schedule": "0 9 * * *",
  "nextRun": "2026-01-05T09:00:00.000Z",
  "timezone": "America/Los_Angeles"
}
```

---

## API Reference

### POST /api/agent/trigger

Manually trigger the daily agent to run immediately.

**Parameters:** None

**Response:**
```typescript
{
  status: 'success' | 'error',
  message: string,
  result?: {
    cronJobId: string,
    totalUsers: number,
    successfulUsers: number,
    failedUsers: number,
    totalTasksGenerated: number,
    totalTasksExecuted: number,
    totalSuccessfulTasks: number,
    totalInterestingResults: number,
    duration: number
  },
  error?: string
}
```

### GET /api/agent/status

Get current cron job status and schedule.

**Parameters:** None

**Response:**
```typescript
{
  enabled: boolean,
  schedule: string,
  nextRun: string,
  timezone: string
}
```

---

## Cron Schedule Format

The schedule uses standard cron syntax:

```
 ┌───────────── minute (0 - 59)
 │ ┌───────────── hour (0 - 23)
 │ │ ┌───────────── day of month (1 - 31)
 │ │ │ ┌───────────── month (1 - 12)
 │ │ │ │ ┌───────────── day of week (0 - 6, Sunday = 0)
 │ │ │ │ │
 * * * * *
```

**Common schedules:**

| Schedule | Description |
|----------|-------------|
| `0 9 * * *` | Daily at 9:00 AM (default) |
| `0 */2 * * *` | Every 2 hours |
| `*/5 * * * *` | Every 5 minutes |
| `0 0 * * *` | Daily at midnight |
| `0 12 * * *` | Daily at noon |
| `0 9 * * 1` | Every Monday at 9am |
| `0 9 1 * *` | First day of month at 9am |

---

## Error Handling

### Per-User Error Isolation

If one user fails, execution continues for other users:

```
Processing User 1... ✅ Success (3 tasks, 2 interesting)
Processing User 2... ❌ Failed (Claude API timeout)
Processing User 3... ✅ Success (4 tasks, 1 interesting)
Processing User 4... ✅ Success (3 tasks, 3 interesting)
```

Final result:
- Total: 4 users
- Successful: 3 users
- Failed: 1 user

### Error Types Handled

1. **Claude API Errors**
   - Rate limit exceeded
   - Timeout
   - API key invalid
   - Network errors

2. **Tool Execution Errors**
   - UI not running
   - Tool endpoint errors
   - Timeout (30s)

3. **Database Errors**
   - Connection failures
   - Query errors
   - Write failures

4. **User Context Errors**
   - No goals/monitors
   - Invalid user data

All errors are:
- ✅ Logged to console
- ✅ Stored in database
- ✅ Reported to debug bridge
- ✅ Don't stop other users

---

## Database Logging

### Cron Execution Log

Every cron run is logged to `agent_activities`:

```sql
SELECT * FROM agent_activities
WHERE activity_type = 'daily_cron'
ORDER BY created_at DESC
LIMIT 1;
```

Example:
```json
{
  "id": "abc123",
  "user_id": "system",
  "agent_type": "task_executor",
  "activity_type": "daily_cron",
  "input_data": {
    "cronJobId": "daily_agent_1735996800000",
    "scheduledTime": "2026-01-04T09:00:00.000Z",
    "cronSchedule": "0 9 * * *"
  },
  "output_data": {
    "totalUsers": 5,
    "successfulUsers": 5,
    "failedUsers": 0,
    "totalTasksGenerated": 17,
    "totalTasksExecuted": 17,
    "totalSuccessfulTasks": 15,
    "totalInterestingResults": 8,
    "userResults": [...]
  },
  "metadata": {
    "duration": 45230,
    "actualStartTime": "2026-01-04T09:00:00.123Z",
    "actualEndTime": "2026-01-04T09:00:45.353Z"
  },
  "status": "completed",
  "created_at": 1735996800000
}
```

### Query Examples

```sql
-- Get all cron executions
SELECT
  created_at,
  status,
  output_data->>'totalUsers' as users,
  output_data->>'successfulUsers' as successful,
  metadata->>'duration' as duration_ms
FROM agent_activities
WHERE activity_type = 'daily_cron'
ORDER BY created_at DESC;

-- Calculate average execution time
SELECT AVG((metadata->>'duration')::int) as avg_duration_ms
FROM agent_activities
WHERE activity_type = 'daily_cron'
  AND status = 'completed';

-- Count failures
SELECT
  COUNT(*) as total_runs,
  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
FROM agent_activities
WHERE activity_type = 'daily_cron';

-- Get user results from last run
SELECT
  jsonb_array_elements(output_data->'userResults') as user_result
FROM agent_activities
WHERE activity_type = 'daily_cron'
ORDER BY created_at DESC
LIMIT 1;
```

---

## Testing

### 1. Test Manual Trigger

```bash
# Trigger manually
curl -X POST http://localhost:5000/api/agent/trigger

# Check it ran
curl http://localhost:5000/api/agent/status
```

### 2. Test Multiple Users

Create test users with goals:
```sql
-- Add test users with active monitors
INSERT INTO scheduled_monitors (user_id, label, description, is_active)
VALUES
  ('test-user-1', 'Test Monitor 1', 'Test description', 1),
  ('test-user-2', 'Test Monitor 2', 'Test description', 1);
```

Trigger and verify:
```bash
curl -X POST http://localhost:5000/api/agent/trigger
```

Check logs:
```sql
SELECT * FROM agent_activities
WHERE activity_type = 'daily_cron'
ORDER BY created_at DESC
LIMIT 1;
```

### 3. Test Error Handling

Stop wyshbone-ui and trigger:
```bash
# Stop UI in another terminal

# Trigger cron
curl -X POST http://localhost:5000/api/agent/trigger
```

Should see errors logged but execution completes.

### 4. Test Custom Schedule

Run every minute for testing:
```bash
# Set in .env
DAILY_AGENT_CRON_SCHEDULE="*/1 * * * *"

# Restart server
npm run dev

# Wait 1 minute and check logs
# Should auto-run
```

---

## Production Deployment

### 1. Set Production Schedule

```bash
# .env.production
DAILY_AGENT_ENABLED=true
DAILY_AGENT_CRON_SCHEDULE="0 9 * * *"
```

### 2. Monitor Execution

Check daily logs:
```sql
-- Daily execution status
SELECT
  DATE(TO_TIMESTAMP(created_at / 1000)) as date,
  status,
  output_data->>'totalUsers' as users,
  output_data->>'successfulUsers' as successful,
  metadata->>'duration' as duration_ms
FROM agent_activities
WHERE activity_type = 'daily_cron'
ORDER BY created_at DESC;
```

### 3. Alert on Failures

Set up monitoring:
```sql
-- Check for recent failures
SELECT * FROM agent_activities
WHERE activity_type = 'daily_cron'
  AND status = 'failed'
  AND created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '1 day') * 1000);
```

### 4. Performance Tuning

For large numbers of users:
```typescript
// In daily-agent.ts, add delay between users
await new Promise(resolve => setTimeout(resolve, 2000));
```

---

## Acceptance Criteria

| Criteria | Status | Evidence |
|----------|--------|----------|
| ✅ Cron job runs daily at 9am local time | DONE | Schedule: "0 9 * * *" with local timezone |
| ✅ Processes all active users sequentially | DONE | `executeTasksForAllUsers()` processes one by one |
| ✅ Generates goals, executes tasks for each user | DONE | Calls `generateAndExecuteTasks()` per user |
| ✅ Handles errors per-user (doesn't stop) | DONE | Try-catch per user in loop at line 601 |
| ✅ Logs cron execution to database | DONE | `logCronExecution()` at line 251 |
| ✅ Can be manually triggered for testing | DONE | `POST /api/agent/trigger` at routes.ts:987 |

**All acceptance criteria met!** ✅

---

## Files Created/Modified

| File | Status | Purpose |
|------|--------|---------|
| `server/cron/daily-agent.ts` | ✅ Created | Cron job service |
| `server/index.ts` | ✅ Modified | Registers cron on startup |
| `server/routes.ts` | ✅ Modified | Added `/api/agent/*` endpoints |
| `migrations/2026-01-04-agent-activities.sql` | ✅ Modified | Added 'daily_cron' activity type |
| `package.json` | ✅ Modified | Added node-cron dependencies |
| `DAILY_CRON_README.md` | ✅ Created | This documentation |

---

## Configuration Options

### Environment Variables

```bash
# Enable/disable cron (default: true)
DAILY_AGENT_ENABLED=true

# Custom schedule (default: 9am daily)
DAILY_AGENT_CRON_SCHEDULE="0 9 * * *"

# Inherited from goal generator
ANTHROPIC_API_KEY=sk-ant-...

# Inherited from task executor
UI_URL=http://localhost:5173
```

### Programmatic Control

```typescript
import {
  startDailyAgentCron,
  stopDailyAgentCron,
  isDailyAgentCronRunning,
  executeDailyAgent,
  triggerDailyAgentManually
} from './server/cron/daily-agent';

// Start cron
startDailyAgentCron();

// Check status
if (isDailyAgentCronRunning()) {
  console.log('Cron is running');
}

// Stop cron
stopDailyAgentCron();

// Manual trigger
await triggerDailyAgentManually();
```

---

## Troubleshooting

### Cron not running

**Check status:**
```bash
curl http://localhost:5000/api/agent/status
```

**Common causes:**
1. `DAILY_AGENT_ENABLED=false` in .env
2. Server not started
3. Error during startup (check logs)

**Fix:**
```bash
# Enable in .env
DAILY_AGENT_ENABLED=true

# Restart server
npm run dev
```

### Manual trigger fails

**Check Claude API:**
```bash
# Verify API key
echo $ANTHROPIC_API_KEY
```

**Check UI running:**
```bash
# Should see wyshbone-ui on port 5173
curl http://localhost:5173/health
```

### No users processed

**Check active users:**
```sql
SELECT DISTINCT user_id
FROM scheduled_monitors
WHERE is_active = 1;
```

**Cause:** No users with active goals/monitors

**Fix:** Add test users or ensure existing users have goals set

### Execution too slow

**Check duration:**
```sql
SELECT metadata->>'duration' as duration_ms
FROM agent_activities
WHERE activity_type = 'daily_cron'
ORDER BY created_at DESC
LIMIT 1;
```

**If >60 seconds per user:**
- Reduce tasks generated (3-5 max)
- Optimize tool execution
- Check network latency

---

## Next Steps

1. **✅ Daily cron implemented** (Phase 2 Task 5) ← YOU ARE HERE
2. **📧 Email notifications** - Send daily summaries
3. **📊 Dashboard UI** - Show cron execution history
4. **🔔 Slack integration** - Alert on interesting findings
5. **📈 Analytics** - Track task completion rates

---

## Summary

The Daily Agent Cron Job is production-ready and provides:

- ✅ Scheduled execution at 9am daily
- ✅ Processes all active users sequentially
- ✅ Error isolation per user
- ✅ Complete database logging
- ✅ Manual trigger for testing
- ✅ Configurable schedule and enable/disable
- ✅ Status endpoint for monitoring

**Ready to run autonomously!** 🕐
