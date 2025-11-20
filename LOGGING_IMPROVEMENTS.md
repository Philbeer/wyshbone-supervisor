# Supervisor Logging Improvements

## Summary

Added comprehensive logging infrastructure to enable production debugging and Control Tower monitoring of lead generation plan executions.

## Changes Made

### 1. `/api/plan-status` Endpoint (Bug Fix)
**File:** `server/routes.ts`

The UI was calling `/api/plan-status` but the backend only had `/api/plan/progress`. Added a new endpoint that:
- Aliases `/api/plan/progress` functionality
- Includes comprehensive logging of all requests
- Logs query parameters, user context, and response data
- Returns `hasActivePlan` flag for UI convenience

**Example Log Output:**
```
[PLAN_STATUS] Request received - query params: { planId: 'plan_123', conversationId: 'conv_456' }
[PLAN_STATUS] userId: demo-user, planId: plan_123, conversationId: conv_456
[PLAN_STATUS] Found progress for plan plan_123 - status: executing, steps: 3
[PLAN_STATUS] Returning: { "hasActivePlan": true, "status": "executing", ... }
```

### 2. Enhanced `/api/plan/approve` Logging
**File:** `server/routes.ts`

Added structured logging throughout the entire approval and execution lifecycle:
- Request receipt with timestamp
- Database operations (plan retrieval, ownership validation)
- User context fetching
- Status updates
- Execution kickoff
- Error handling with stack traces
- Timing metrics

**Example Log Output:**
```
============================================================
[PLAN_APPROVE] RECEIVED REQUEST
  planId: plan_abc123
  userId: demo-user
  timestamp: 2025-11-20T12:44:53.123Z
============================================================

[PLAN_APPROVE] Retrieving plan plan_abc123 from database...
[PLAN_APPROVE] Found plan - status: pending_approval, owner: demo-user
[PLAN_APPROVE] Plan plan_abc123 has 3 steps
[PLAN_APPROVE] Fetching user context for demo-user...
[PLAN_APPROVE] User context: accountId=acct_123, email=user@example.com
[PLAN_APPROVE] Updating plan status to 'executing'...
[PLAN_APPROVE] Starting progress tracking for plan plan_abc123 (session: demo-user)...
[PLAN_APPROVE] Kicking off execution for plan plan_abc123...

============================================================
[PLAN_APPROVE] SUCCESS - Execution kicked off
  planId: plan_abc123
  status: executing
  elapsed: 245ms
============================================================
```

### 3. Plan Executor Logging
**File:** `server/types/lead-gen-plan.ts`

Added comprehensive logging to the `executeLeadGenerationPlan` function:
- Plan start with complete context
- Step-by-step execution with status indicators
- Branch decisions
- Final execution summary with metrics
- Visual status indicators (✓ ✗ ○)

**Example Log Output:**
```
======================================================================
[PLAN_EXEC] STARTING EXECUTION
  planId: plan_abc123
  userId: demo-user
  accountId: acct_123
  goal: Find fintech companies in San Francisco
  totalSteps: 3
  startedAt: 2025-11-20T12:44:53.456Z
======================================================================

[PLAN_EXEC] Step 1/3: Google Places Search (step_1) → status=running
[PLAN_EXEC] Step 1/3: Google Places Search → ✓ status=succeeded
[PLAN_EXEC] Step 2/3: Email Discovery (step_2) → status=running
[PLAN_EXEC] Step 2/3: Email Discovery → ✓ status=succeeded
[PLAN_EXEC] Step 3/3: Send Notifications (step_3) → status=running
[PLAN_EXEC] Step 3/3: Send Notifications → ✓ status=succeeded

======================================================================
[PLAN_EXEC] ✓✓✓ SUCCEEDED
  planId: plan_abc123
  duration: 2.3s
  steps: 3 succeeded, 0 failed, 0 skipped
  executionPath: [step_1, step_2, step_3]
======================================================================
```

### 4. Tower (Control Tower) Integration
**File:** `server/tower-logger.ts` (NEW)

Created a structured logging module for Control Tower monitoring:
- JSON-formatted logs with `[TOWER_LOG]` prefix
- Source identifier: `plan_executor`
- Logs plan start and completion events
- Includes user/account isolation
- Tracks execution metrics (steps, duration, status)

**Example Log Output:**
```json
[TOWER_LOG] {
  "source": "plan_executor",
  "userId": "demo-user",
  "accountId": "acct_123",
  "runId": "plan_abc123",
  "timestamp": "2025-11-20T12:44:53.456Z",
  "status": "running",
  "request": {
    "goal": "Find fintech companies in San Francisco",
    "planId": "plan_abc123"
  }
}

[TOWER_LOG] {
  "source": "plan_executor",
  "userId": "demo-user",
  "accountId": "acct_123",
  "runId": "plan_abc123",
  "timestamp": "2025-11-20T12:44:55.789Z",
  "status": "success",
  "request": {
    "goal": "Find fintech companies in San Francisco",
    "planId": "plan_abc123"
  },
  "metadata": {
    "totalSteps": 3,
    "succeededSteps": 3,
    "failedSteps": 0,
    "skippedSteps": 0,
    "durationSeconds": 2.333
  }
}
```

## Testing Instructions

### 1. Test the UI Integration
1. Open the Wyshbone Supervisor UI
2. Create a new lead generation plan
3. Approve the plan
4. Watch the logs in the workflow output for:
   - `[PLAN_STATUS]` logs when the UI polls for progress
   - `[PLAN_APPROVE]` logs when you click approve
   - `[PLAN_EXEC]` logs as the plan executes
   - `[TOWER_LOG]` logs for Control Tower integration

### 2. Test with curl

**Create a plan:**
```bash
curl -X POST http://localhost:5000/api/plan/start \
  -H "Content-Type: application/json" \
  -d '{"goal": "Find 5 coffee shops in Seattle"}'
```

**Approve and execute:**
```bash
curl -X POST http://localhost:5000/api/plan/approve \
  -H "Content-Type: application/json" \
  -d '{"planId": "YOUR_PLAN_ID"}'
```

**Check status:**
```bash
curl http://localhost:5000/api/plan-status?planId=YOUR_PLAN_ID
```

### 3. Grep for Tower Logs
```bash
grep "TOWER_LOG" /tmp/logs/Start_application_*.log | tail -20
```

## Tower Integration Details

The Tower logger (`server/tower-logger.ts`) logs structured JSON that Control Tower can ingest:

- **source**: Always `"plan_executor"` to distinguish from other sources
- **userId**: User who initiated the plan
- **accountId**: Account isolation for multi-tenant filtering
- **runId**: Plan ID for tracking individual executions
- **status**: `running`, `success`, `failed`, or `partial`
- **metadata**: Execution metrics (steps, duration)

These logs can be:
1. Parsed from stdout/stderr by Control Tower
2. Sent to a log aggregation service (e.g., CloudWatch, Datadog)
3. Filtered by `source: "plan_executor"` to show plan executions
4. Filtered by `userId` or `accountId` for user/account-specific monitoring

## Benefits

1. **Production Debugging**: Comprehensive logs make it easy to trace issues through the entire execution pipeline
2. **Performance Monitoring**: Timing metrics at API and executor levels
3. **Control Tower Visibility**: Structured logs enable monitoring dashboard filtering by source, user, account
4. **UI Troubleshooting**: Detailed logs for frontend-backend integration issues
5. **Audit Trail**: Complete record of plan approvals and executions

## Files Changed

- `server/routes.ts` - Added `/api/plan-status`, enhanced `/api/plan/approve` logging
- `server/types/lead-gen-plan.ts` - Added executor logging
- `server/tower-logger.ts` - NEW: Tower logging infrastructure

## Notes

- All timing metrics include milliseconds for precise performance analysis
- Error logs include stack traces for debugging
- Tower logs are JSON-formatted for easy parsing
- Logging is production-ready and can be filtered by log level/prefix
