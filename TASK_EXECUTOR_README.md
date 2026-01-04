# Task Executor - Implementation Guide

## Overview

The Task Executor automatically executes generated tasks using the unified tool endpoint from wyshbone-ui. It evaluates results, logs activities to database, and handles errors gracefully.

**Key Features:**
- 🤖 **Autonomous Execution** - Executes tasks without user approval
- 🔗 **Unified Tool Endpoint** - Calls `/api/tools/execute` in wyshbone-ui
- 🧠 **Smart Evaluation** - Determines if results are "interesting"
- ⏱️ **Rate Limited** - 2 second delay between tasks
- 💾 **Fully Logged** - All activities stored in `agent_activities` table
- 🛡️ **Error Handling** - Graceful failure without stopping execution

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     TASK EXECUTOR                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Receive Generated Tasks                                      │
│     ┌──────────────────────┐                                    │
│     │  GeneratedTask[]     │                                    │
│     │  - title             │                                    │
│     │  - description       │                                    │
│     │  - priority          │                                    │
│     └──────────────────────┘                                    │
│              │                                                   │
│  2. Execute Each Task (with 2s delay)                           │
│              │                                                   │
│     ┌────────▼──────────────────┐                               │
│     │ Call Tool Endpoint:       │                               │
│     │ POST /api/tools/execute   │                               │
│     │   → wyshbone-ui           │                               │
│     └──────────────────────────┘                                │
│              │                                                   │
│  3. Evaluate Results                                             │
│              │                                                   │
│     ┌────────▼──────────────────┐                               │
│     │ Is result interesting?    │                               │
│     │ - Found leads?            │                               │
│     │ - Discovered insights?    │                               │
│     │ - Issues detected?        │                               │
│     └──────────────────────────┘                                │
│              │                                                   │
│  4. Log to Database                                              │
│              │                                                   │
│     ┌────────▼──────────────────┐                               │
│     │ agent_activities:         │                               │
│     │ - agent_type: task_executor │                             │
│     │ - activity_type: execute_task │                           │
│     │ - status: success/failed  │                               │
│     │ - interesting: true/false │                               │
│     └──────────────────────────┘                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Setup

### Prerequisites

1. **Goal Generator Setup** - Task executor requires the goal generator to be set up first
   - See `AUTONOMOUS_AGENT_README.md`
   - Database migration must be applied

2. **Wyshbone UI Running** - The UI must be running for tool execution
   - Start wyshbone-ui: `npm run dev` (runs on port 5173)
   - Task executor calls `http://localhost:5173/api/tools/execute`

### Environment Variables

```bash
# Required (already set if goal generator works)
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here

# Optional: Override UI URL
UI_URL=http://localhost:5173

# Optional: Test user
TEST_USER_ID=user-123
```

---

## Usage

### Option 1: Generate and Execute Tasks (Recommended)

```typescript
import { generateAndExecuteTasks } from './server/autonomous-agent';

const result = await generateAndExecuteTasks('user-123');

console.log('Tasks Generated:', result.generation.tasks.length);
console.log('Tasks Executed:', result.execution.totalTasks);
console.log('Successful:', result.execution.successful);
console.log('Interesting:', result.execution.interesting);
```

### Option 2: Execute Existing Tasks

```typescript
import { executeTasks } from './server/services/task-executor';

const tasks = [
  {
    title: "Review top 3 suggested leads",
    description: "Check leads dashboard and prioritize",
    priority: "high",
    estimatedDuration: "20 min",
    actionable: true,
    reasoning: "47 leads waiting"
  }
];

const result = await executeTasks(tasks, 'user-123');

console.log('Successful:', result.successful);
console.log('Failed:', result.failed);
console.log('Interesting:', result.interesting);
```

### Option 3: Run Test Script

```bash
npm run test:executor
# or
tsx server/scripts/test-task-executor.ts
```

### Option 4: Execute for All Users (Bulk)

```typescript
import { executeTasksForAllUsers } from './server/autonomous-agent';

const result = await executeTasksForAllUsers();

console.log('Users processed:', result.success);
console.log('Failures:', result.failed);

result.results.forEach(user => {
  console.log(`${user.userId}: ${user.successful}/${user.tasksExecuted} successful`);
});
```

---

## API Reference

### `executeTask(task, userId, taskId)`

Execute a single task.

**Parameters:**
- `task` (GeneratedTask) - The task to execute
- `userId` (string) - User ID
- `taskId` (string) - Unique task ID

**Returns:** `Promise<TaskExecutionResult>`

```typescript
interface TaskExecutionResult {
  taskId: string;
  task: GeneratedTask;
  status: 'success' | 'failed' | 'partial';
  executionTime: number;
  toolResponse?: any;
  interesting: boolean;
  interestingReason?: string;
  error?: string;
}
```

### `executeTasks(tasks, userId)`

Execute multiple tasks with rate limiting.

**Parameters:**
- `tasks` (GeneratedTask[]) - Array of tasks to execute
- `userId` (string) - User ID

**Returns:** `Promise<BatchExecutionResult>`

```typescript
interface BatchExecutionResult {
  totalTasks: number;
  successful: number;
  failed: number;
  interesting: number;
  results: TaskExecutionResult[];
  totalDuration: number;
}
```

---

## Result Evaluation

The executor uses **heuristics** to determine if results are "interesting":

### Interesting Results Include:

1. **New Leads/Contacts**
   ```typescript
   data.leads.length > 0 → "Found 5 new leads"
   ```

2. **Opportunities**
   ```typescript
   data.opportunities.length > 0 → "Identified 3 opportunities"
   ```

3. **Alerts/Issues**
   ```typescript
   data.alerts.length > 0 → "Found 2 alerts requiring attention"
   ```

4. **Significant Counts**
   ```typescript
   data.count > 0 → "Found 10 items"
   ```

5. **Changes/Updates**
   ```typescript
   data.updated > 0 → "Updated 7 items"
   ```

6. **Insights/Recommendations**
   ```typescript
   data.insights.length > 0 → "Generated 4 insights"
   ```

7. **High Priority Success**
   ```typescript
   task.priority === 'high' && data.result → "High priority task completed"
   ```

### Not Interesting:
- Empty results
- No actionable data
- Generic success messages

---

## Rate Limiting

**Configuration:**
- 2 second delay between tasks (configurable)
- Prevents overwhelming the UI/API
- Applied in batch execution only

**Example:**
```
Task 1: Execute → Success (500ms)
         Wait 2s...
Task 2: Execute → Success (750ms)
         Wait 2s...
Task 3: Execute → Failed (100ms)
         Wait 2s...
Task 4: Execute → Success (600ms)
```

---

## Error Handling

### Graceful Failures

The executor **never stops** due to errors:

```typescript
try {
  result = await executeTask(task, userId, taskId);
} catch (error) {
  // Log error, continue to next task
  result = {
    status: 'failed',
    error: error.message,
    // ... other fields
  };
}
```

### Error Types Handled:

1. **Network Errors**
   - UI not running
   - Timeout (30s)
   - Connection refused

2. **HTTP Errors**
   - 404 - Endpoint not found
   - 500 - Server error
   - 429 - Rate limit

3. **Tool Errors**
   - Invalid tool parameters
   - Tool execution failure
   - Missing dependencies

4. **Unexpected Errors**
   - JSON parse errors
   - Type errors
   - Unknown exceptions

All errors are:
- ✅ Logged to console
- ✅ Stored in database
- ✅ Reported to debug bridge
- ✅ Returned in result object

---

## Database Logging

Every task execution is logged to `agent_activities`:

```typescript
{
  user_id: "user-123",
  agent_type: "task_executor",
  activity_type: "execute_task",
  input_data: {
    task: {
      title: "Review top 3 leads",
      description: "...",
      priority: "high",
      estimatedDuration: "20 min"
    }
  },
  output_data: {
    status: "success",
    interesting: true,
    interestingReason: "Found 3 new leads",
    toolResponse: { leads: [...] }
  },
  metadata: {
    taskId: "task_user-123_1735996800000_0",
    executionTime: 1234,
    error: null
  },
  status: "completed",
  created_at: 1735996800000,
  completed_at: 1735996801234
}
```

### Query Examples

```sql
-- Get all task executions today
SELECT * FROM agent_activities
WHERE agent_type = 'task_executor'
  AND created_at > EXTRACT(EPOCH FROM CURRENT_DATE) * 1000
ORDER BY created_at DESC;

-- Count interesting results
SELECT
  COUNT(*) as total_executions,
  SUM(CASE WHEN (output_data->>'interesting')::boolean THEN 1 ELSE 0 END) as interesting_count
FROM agent_activities
WHERE agent_type = 'task_executor';

-- Average execution time
SELECT AVG((metadata->>'executionTime')::int) as avg_time_ms
FROM agent_activities
WHERE agent_type = 'task_executor'
  AND status = 'completed';

-- Failed executions
SELECT
  input_data->'task'->>'title' as task_title,
  error,
  created_at
FROM agent_activities
WHERE agent_type = 'task_executor'
  AND status = 'failed'
ORDER BY created_at DESC
LIMIT 10;
```

---

## Integration with Goal Generator

### Combined Workflow

```typescript
import { generateAndExecuteTasks } from './server/autonomous-agent';

// This does BOTH:
// 1. Generate tasks using Claude
// 2. Execute tasks using tool endpoint
const result = await generateAndExecuteTasks('user-123');

// Result includes both generation and execution:
console.log('Generated:', result.generation.tasks.length);
console.log('Executed:', result.execution.successful);
console.log('Interesting:', result.execution.interesting);
```

### Scheduled Execution

```typescript
import cron from 'node-cron';
import { executeTasksForAllUsers } from './server/autonomous-agent';

// Run daily at 9am - generate and execute for all users
cron.schedule('0 9 * * *', async () => {
  console.log('🤖 Running autonomous agent...');
  const result = await executeTasksForAllUsers();
  console.log(`✅ Processed ${result.success} users`);
});
```

---

## Verification Steps

### 1. Check Executor Service Exists

```bash
ls server/services/task-executor.ts
```

Should see: `server/services/task-executor.ts`

### 2. Run Test Script

```bash
npm run test:executor
```

Expected output:
```
🧪 TASK EXECUTOR TEST
============================================================

Test Configuration:
- User ID: user-123
- UI Endpoint: http://localhost:5173/api/tools/execute

🚀 Starting task generation and execution...

[AUTONOMOUS_AGENT] Generating daily tasks for user user-123...
[AUTONOMOUS_AGENT] Executing 3 generated tasks...
[TASK_EXECUTOR] Executing task: Review top 3 suggested leads
[TASK_EXECUTOR] ✅ Task completed successfully (1234ms)
[TASK_EXECUTOR] 🌟 Interesting result: Found 3 new leads
[TASK_EXECUTOR] Waiting 2000ms before next task...
...

📊 RESULTS
============================================================

TASK GENERATION:
  Tasks Generated: 3
  Model: claude-3-5-sonnet-20241022
  Input Tokens: 456
  Output Tokens: 389

TASK EXECUTION:
  Total Tasks: 3
  Successful: 3
  Failed: 0
  Interesting Results: 2
  Total Duration: 8567ms

✅ TEST COMPLETE
```

### 3. Verify Database Logs

```sql
SELECT * FROM agent_activities
WHERE agent_type = 'task_executor'
ORDER BY created_at DESC
LIMIT 5;
```

Should see execution records with:
- ✅ `agent_type` = `'task_executor'`
- ✅ `activity_type` = `'execute_task'`
- ✅ `status` = `'completed'` or `'failed'`
- ✅ `output_data` contains `interesting` boolean
- ✅ `metadata` contains `executionTime`

### 4. Check Rate Limiting Works

Watch console output - should see:
```
[TASK_EXECUTOR] Waiting 2000ms before next task...
```

Between each task execution.

### 5. Test Error Handling

Stop wyshbone-ui and run test:
```bash
# In one terminal: Stop UI (Ctrl+C)

# In another terminal:
npm run test:executor
```

Expected:
- ✅ Tasks still attempted
- ✅ Errors logged (not thrown)
- ✅ Execution continues
- ✅ Status shows "failed"
- ✅ Error message: "Unable to connect to UI"

---

## Acceptance Criteria

| Criteria | Status | Evidence |
|----------|--------|----------|
| ✅ Calls /api/tools/execute endpoint for each task | DONE | `callToolEndpoint()` in task-executor.ts:152 |
| ✅ Evaluates if results are interesting | DONE | `evaluateResults()` in task-executor.ts:196 |
| ✅ Logs all activities to agent_activities table | DONE | `logTaskActivity()` in task-executor.ts:278 |
| ✅ Rate limits API calls (2 second delay) | DONE | Rate limiting in `executeTasks()` at task-executor.ts:109 |
| ✅ Handles errors gracefully without stopping | DONE | Error handling in `executeTask()` at task-executor.ts:76 |

**All acceptance criteria met!** ✅

---

## Files Created/Modified

| File | Status | Purpose |
|------|--------|---------|
| `server/services/task-executor.ts` | ✅ Created | Task execution service |
| `server/autonomous-agent.ts` | ✅ Extended | Added execution functions |
| `migrations/2026-01-04-agent-activities.sql` | ✅ Updated | Added 'execute_task' activity type |
| `server/scripts/test-task-executor.ts` | ✅ Created | Test script |
| `package.json` | ✅ Updated | Added npm scripts |
| `TASK_EXECUTOR_README.md` | ✅ Created | This documentation |

---

## Troubleshooting

### Error: "Unable to connect to UI"

**Cause:** wyshbone-ui not running

**Fix:**
```bash
cd ../wyshbone-ui
npm run dev
```

UI must be running on port 5173.

### Error: "Execution timeout"

**Cause:** Tool endpoint took >30 seconds

**Fix:**
- Check tool endpoint is working
- Increase timeout in task-executor.ts
- Optimize tool execution

### No "interesting" results

**Cause:** Heuristics don't match your data format

**Fix:**
- Review `evaluateResults()` in task-executor.ts
- Add custom heuristics for your data
- Check tool response format

### Rate limit not working

**Cause:** Only one task executed

**Fix:**
- Rate limiting only applies when multiple tasks
- Single task = no delay needed
- Check logs for "Waiting 2000ms" message

---

## Cost Impact

Task execution itself is **free** (just HTTP calls).

**Only costs:**
- Task generation (Claude API)
- Tool execution (if tools call paid APIs)

**No additional cost** for task executor logic.

---

## Next Steps

1. **✅ Set up Goal Generator** (Phase 2 Task 2)
2. **✅ Set up Task Executor** (Phase 2 Task 3) ← YOU ARE HERE
3. **📋 Build UI Dashboard** - Display generated tasks
4. **📧 Email Notifications** - Send daily task summaries
5. **🔄 Feedback Loop** - Learn from execution results
6. **🎯 Smart Prioritization** - Improve task ranking

---

## Questions?

**Need help?**
1. Check code comments in `server/services/task-executor.ts`
2. Run test script: `npm run test:executor`
3. Check debug bridge: `http://localhost:9999/code-data`
4. Review logs for error messages

**Want to extend?**
- Add more result evaluation heuristics
- Integrate with different tool endpoints
- Add task retry logic
- Create execution metrics dashboard
- Build task approval workflow

---

## Summary

The Task Executor is production-ready and provides:

- ✅ Autonomous task execution via unified tool endpoint
- ✅ Smart result evaluation (interesting vs. not interesting)
- ✅ Complete activity logging to database
- ✅ Rate limiting to prevent API abuse
- ✅ Graceful error handling
- ✅ Integration with goal generator
- ✅ Test script for verification

**Ready to execute autonomously!** 🚀
