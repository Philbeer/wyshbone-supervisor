# Autonomous Agent - Goal Generator

## Overview

The Autonomous Goal Generator uses Claude AI to automatically generate daily tasks for users based on their business goals, active monitors, and recent activity.

**Key Features:**
- 🤖 **Fully Autonomous** - No human intervention required
- 🎯 **Goal-Aware** - Reads user objectives and monitors from database
- 📋 **Specific Tasks** - Generates 3-5 actionable tasks (not vague)
- ⚡ **Rate Limited** - Respects API limits (5 calls/minute)
- 💾 **Tracked** - All activities stored in `agent_activities` table

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     AUTONOMOUS AGENT                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Read User Goals      ┌──────────────────────┐              │
│     from Database  ──────>│  User Context:       │              │
│                           │  - Primary Objective │              │
│                           │  - Active Monitors   │              │
│                           │  - Recent Research   │              │
│                           │  - Suggested Leads   │              │
│                           └──────────────────────┘              │
│                                    │                             │
│  2. Call Claude API                │                             │
│     with Context       ────────────┘                             │
│                           ┌──────────────────────┐              │
│                           │  Claude API:         │              │
│                           │  - Generate 3-5      │              │
│                           │    specific tasks    │              │
│                           │  - Prioritize        │              │
│                           │  - Add reasoning     │              │
│                           └──────────────────────┘              │
│                                    │                             │
│  3. Store Results                  │                             │
│     in Database        ────────────┘                             │
│                           ┌──────────────────────┐              │
│                           │  agent_activities:   │              │
│                           │  - Tasks generated   │              │
│                           │  - Tokens used       │              │
│                           │  - Timestamp         │              │
│                           └──────────────────────┘              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Setup

### 1. Install Dependencies

```bash
cd wyshbone-supervisor
npm install
```

This will install `@anthropic-ai/sdk` (added to `package.json`).

### 2. Set Environment Variables

Create or update `.env`:

```bash
# Required: Your Anthropic API key
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here

# Optional: Test user ID for testing
TEST_USER_ID=user-123
```

**Get your API key:**
1. Go to https://console.anthropic.com/
2. Sign up / Log in
3. Go to API Keys
4. Create a new key
5. Copy and paste into `.env`

### 3. Run Database Migration

```bash
# Run the SQL migration in Supabase
# File: migrations/2026-01-04-agent-activities.sql
```

This creates the `agent_activities` table.

**Or run in Supabase SQL Editor:**

```sql
-- Copy contents of migrations/2026-01-04-agent-activities.sql
-- Paste into Supabase SQL Editor
-- Click "Run"
```

---

## Usage

### Option 1: Generate Tasks for Single User

```typescript
import { generateDailyTasks } from './server/autonomous-agent';

const result = await generateDailyTasks('user-123');

console.log('Tasks:', result.tasks);
console.log('Tokens:', result.tokensUsed);
```

### Option 2: Generate Tasks for All Users

```typescript
import { generateTasksForAllUsers } from './server/autonomous-agent';

const result = await generateTasksForAllUsers();

console.log('Success:', result.success);
console.log('Failed:', result.failed);
```

### Option 3: Run Test Script

```bash
npm run test:goals
# or
tsx server/scripts/test-goal-generator.ts
```

### Option 4: Add to Cron Job (Recommended)

```typescript
// In server/supervisor.ts or server/index.ts

import { generateTasksForAllUsers } from './autonomous-agent';

// Run daily at 9am
cron.schedule('0 9 * * *', async () => {
  console.log('🤖 Running autonomous goal generator...');
  await generateTasksForAllUsers();
});
```

---

## API Reference

### `generateDailyTasks(userId: string)`

Generate 3-5 tasks for a specific user.

**Parameters:**
- `userId` (string) - The user ID to generate tasks for

**Returns:** `Promise<GoalGenerationResult>`

```typescript
interface GoalGenerationResult {
  userId: string;
  tasks: GeneratedTask[];
  contextUsed: {
    goals: string[];
    monitors: string[];
    recentActivity: string;
  };
  model: string;
  tokensUsed: {
    input: number;
    output: number;
  };
  timestamp: number;
}

interface GeneratedTask {
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  estimatedDuration: string;
  actionable: boolean;
  reasoning: string;
}
```

**Example:**

```typescript
const result = await generateDailyTasks('user-123');

result.tasks.forEach(task => {
  console.log(`[${task.priority}] ${task.title}`);
  console.log(`  ${task.description}`);
  console.log(`  Duration: ${task.estimatedDuration}`);
  console.log(`  Why: ${task.reasoning}`);
});
```

### `generateTasksForAllUsers()`

Generate tasks for all users with active goals/monitors.

**Returns:** `Promise<{ success: number; failed: number; results: Array<...> }>`

**Example:**

```typescript
const result = await generateTasksForAllUsers();

console.log(`Generated tasks for ${result.success} users`);
console.log(`Failed for ${result.failed} users`);
```

---

## Database Schema

### `agent_activities` Table

```sql
CREATE TABLE agent_activities (
  id VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  agent_type VARCHAR NOT NULL DEFAULT 'goal_generator',
  activity_type VARCHAR NOT NULL,
  input_data JSONB DEFAULT '{}',
  output_data JSONB DEFAULT '{}',
  status VARCHAR DEFAULT 'pending',
  metadata JSONB DEFAULT '{}',
  created_at BIGINT NOT NULL,
  completed_at BIGINT,
  error TEXT
);
```

**Fields:**
- `id` - Unique activity ID
- `user_id` - User this activity is for
- `agent_type` - Type of agent (`goal_generator`, `task_executor`, etc.)
- `activity_type` - Specific activity (`generate_tasks`, etc.)
- `input_data` - Context used (goals, monitors, etc.)
- `output_data` - Tasks generated
- `status` - `pending`, `in_progress`, `completed`, `failed`
- `metadata` - Model used, tokens, duration
- `created_at` - When activity started (Unix timestamp ms)
- `completed_at` - When activity finished (Unix timestamp ms)
- `error` - Error message if failed

**Query Examples:**

```sql
-- Get all tasks for a user
SELECT * FROM agent_activities
WHERE user_id = 'user-123'
  AND activity_type = 'generate_tasks'
ORDER BY created_at DESC;

-- Get today's tasks
SELECT output_data->>'tasks' as tasks
FROM agent_activities
WHERE user_id = 'user-123'
  AND activity_type = 'generate_tasks'
  AND created_at > EXTRACT(EPOCH FROM CURRENT_DATE) * 1000
ORDER BY created_at DESC
LIMIT 1;

-- Get task generation stats
SELECT
  COUNT(*) as total_generations,
  SUM((metadata->>'taskCount')::int) as total_tasks,
  AVG((metadata->>'outputTokens')::int) as avg_tokens
FROM agent_activities
WHERE activity_type = 'generate_tasks'
  AND status = 'completed';
```

---

## Rate Limiting

The Claude API service implements rate limiting:

**Limits:**
- Max 5 calls per minute
- Automatic retry on 429 (rate limit exceeded)
- 2-second delay between users in bulk generation

**Check rate limit status:**

```typescript
import { claudeAPI } from './server/services/claude-api';

const status = claudeAPI.getRateLimitStatus();
console.log('Remaining calls:', status.remaining);
console.log('Reset in:', status.resetIn, 'ms');
```

---

## Cost Estimation

**Claude 3.5 Sonnet pricing (as of 2024):**
- Input: $3 per million tokens
- Output: $15 per million tokens

**Typical task generation:**
- Input: ~500 tokens (user context)
- Output: ~400 tokens (3-5 tasks)
- **Cost per generation: ~$0.007** (less than 1 cent)

**Daily cost for 100 users:**
- 100 generations * $0.007 = **$0.70/day** or **$21/month**

---

## Verification

### 1. Check Claude API is initialized

```bash
tsx server/scripts/test-goal-generator.ts
```

Should see: `✅ Claude API initialized`

### 2. Verify tasks are generated

Run for a test user:

```typescript
const result = await generateDailyTasks('test-user-id');
console.log('Generated', result.tasks.length, 'tasks');
```

Should see 3-5 tasks with specific titles and descriptions.

### 3. Verify tasks are saved to database

```sql
SELECT * FROM agent_activities
WHERE activity_type = 'generate_tasks'
ORDER BY created_at DESC
LIMIT 5;
```

Should see recent activity records.

### 4. Check tasks are actionable

Generated tasks should be:
- ✅ **Specific** (not "work on marketing")
- ✅ **Actionable** (user can start immediately)
- ✅ **Realistic** (15-60 minutes each)
- ✅ **Prioritized** (high/medium/low)
- ✅ **Reasoned** (explains why task matters)

**Good task example:**
```json
{
  "title": "Review and respond to top 3 suggested leads",
  "description": "Open the leads dashboard, sort by priority, and send personalized introduction emails to the top 3 freehouse leads in Yorkshire",
  "priority": "high",
  "estimatedDuration": "20-30 min",
  "actionable": true,
  "reasoning": "You have 47 suggested leads waiting for action. Focusing on top 3 high-priority leads first will yield quickest results."
}
```

**Bad task example:**
```json
{
  "title": "Do marketing",
  "description": "Work on marketing stuff",
  "priority": "medium"
}
```

---

## Troubleshooting

### Error: "Claude API not initialized"

**Cause:** `ANTHROPIC_API_KEY` not set in `.env`

**Fix:**
```bash
# Add to .env
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
```

### Error: "Rate limit exceeded"

**Cause:** Made more than 5 API calls in 1 minute

**Fix:** Wait 60 seconds and try again. The system will automatically retry.

### Error: "Supabase not configured"

**Cause:** Supabase connection not set up

**Fix:** Ensure `DATABASE_URL` or Supabase credentials are in `.env`

### No tasks generated

**Cause:** User has no goals or monitors

**Fix:** User needs to:
1. Set primary objective in profile
2. OR create at least one active scheduled monitor

### Tasks are vague/not actionable

**Cause:** Claude needs more context

**Fix:**
1. Ensure user has clear, specific objectives
2. Add more active monitors
3. Adjust system prompt in `autonomous-agent.ts` for more specificity

---

## Files Created

| File | Purpose |
|------|---------|
| `server/autonomous-agent.ts` | Main goal generator logic |
| `server/services/claude-api.ts` | Claude API integration |
| `server/scripts/test-goal-generator.ts` | Test script |
| `migrations/2026-01-04-agent-activities.sql` | Database schema |
| `AUTONOMOUS_AGENT_README.md` | This documentation |

---

## Next Steps

1. ✅ Set up `ANTHROPIC_API_KEY` in `.env`
2. ✅ Run database migration
3. ✅ Test with `tsx server/scripts/test-goal-generator.ts`
4. ✅ Verify tasks are specific and actionable
5. 🚀 Add to daily cron job
6. 🚀 Build UI to display generated tasks
7. 🚀 Add task execution (Phase 2)
8. 🚀 Add feedback loop (learn from completed tasks)

---

## Acceptance Criteria (from Task)

| Criteria | Status |
|----------|--------|
| Autonomous agent reads user goals from database | ✅ Complete |
| Uses Claude API to generate 3-5 specific tasks | ✅ Complete |
| Tasks are actionable and specific (not vague) | ✅ Complete |
| Tasks stored in agent_activities table | ✅ Complete |
| Rate limiting implemented | ✅ Complete (5 calls/min) |

---

## Questions?

See the code comments in:
- `server/autonomous-agent.ts` - Main logic
- `server/services/claude-api.ts` - API client
- `migrations/2026-01-04-agent-activities.sql` - Database schema
