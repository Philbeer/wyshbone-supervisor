# Supervisor Chat Integration Design

## Overview
Integrate Supervisor's AI intelligence into Wyshbone UI chat conversations. Supervisor will analyze user conversations and respond directly in the chat interface with insights, leads, and recommendations.

## Database Schema Changes

### 1. Extend `messages` Table
Add optional metadata columns to distinguish Supervisor messages:

```sql
ALTER TABLE messages 
ADD COLUMN source TEXT DEFAULT 'ui',
ADD COLUMN metadata JSONB DEFAULT '{}';
```

**Column Descriptions:**
- `source`: Identifies message origin ('ui' | 'supervisor' | 'system')
- `metadata`: JSON object for additional context:
  - `capabilities`: Array of actions Supervisor performed
  - `thread_context`: Reference to related entities
  - `supervisor_task_id`: Link to originating task
  - `lead_ids`: Array of lead IDs mentioned in response

**Example Supervisor Message:**
```json
{
  "id": "uuid",
  "conversation_id": "uuid",
  "role": "assistant",
  "content": "I found 3 dental clinics in York...",
  "source": "supervisor",
  "metadata": {
    "supervisor_task_id": "task-123",
    "capabilities": ["lead_generation", "email_enrichment"],
    "lead_ids": ["lead-1", "lead-2", "lead-3"]
  },
  "created_at": 1234567890
}
```

### 2. Create `supervisor_tasks` Queue Table
Allows UI to request Supervisor processing:

```sql
CREATE TABLE supervisor_tasks (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id VARCHAR NOT NULL REFERENCES conversations(id),
  user_id VARCHAR NOT NULL,
  task_type VARCHAR NOT NULL,
  request_data JSONB NOT NULL,
  status VARCHAR DEFAULT 'pending',
  result JSONB,
  error TEXT,
  created_at BIGINT NOT NULL,
  processed_at BIGINT,
  CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX idx_supervisor_tasks_status ON supervisor_tasks(status, created_at);
CREATE INDEX idx_supervisor_tasks_conversation ON supervisor_tasks(conversation_id);
```

**Column Descriptions:**
- `task_type`: Type of request ('analyze_conversation', 'generate_leads', 'provide_insights')
- `request_data`: Context needed for processing (conversation snapshot, user preferences)
- `status`: Processing state
- `result`: Supervisor's output (lead IDs, insights, etc.)

**Example Task:**
```json
{
  "id": "task-123",
  "conversation_id": "conv-456",
  "user_id": "user-789",
  "task_type": "generate_leads",
  "request_data": {
    "user_message": "Find dental clinics in York",
    "conversation_context": ["Previous 5 messages..."],
    "user_profile": {"industry": "dental", "location": "UK"}
  },
  "status": "pending",
  "created_at": 1234567890
}
```

## Data Flow

1. **User sends message** → UI saves to `messages` table
2. **UI determines Supervisor needed** → Creates entry in `supervisor_tasks`
3. **Supervisor polls tasks** (every 30s) → Finds pending tasks
4. **Supervisor processes** → Analyzes conversation, generates leads
5. **Supervisor writes response** → Saves to `messages` with `source='supervisor'`
6. **Supervisor updates task** → Marks as `completed` with result
7. **UI receives update** → Supabase realtime streams new message
8. **User sees response** → Displayed with Supervisor badge/styling

## Supervisor Processing Logic

When Supervisor finds a task:
1. Fetch full conversation context from Supabase
2. Build user profile (facts, monitors, history)
3. Run AI analysis based on task_type
4. Generate leads if applicable (Google Places + Hunter.io)
5. Format response for chat display
6. Write message to Supabase messages table
7. Update task status and result

## UI Changes

### Message Display
```typescript
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  source?: 'ui' | 'supervisor' | 'system';
  metadata?: {
    capabilities?: string[];
    lead_ids?: string[];
    supervisor_task_id?: string;
  };
  created_at: number;
}
```

### Visual Differentiation
- **UI AI messages**: Default assistant styling
- **Supervisor messages**: Special badge "🤖 Supervisor", different background color
- **Lead cards**: Expandable UI showing contact details, match score

### Task Enqueueing
UI creates supervisor task when:
- User explicitly requests lead generation
- User asks analytical questions about their business
- User wants insights on conversation history
- Trigger words detected: "find leads", "analyze", "suggest prospects"

## Benefits

✅ **Unified Intelligence**: One system for email notifications AND chat interactions
✅ **Real-time Insights**: Users see Supervisor analysis immediately in chat
✅ **Context Awareness**: Supervisor has full conversation history for better responses
✅ **Async Processing**: Doesn't block UI while Supervisor thinks (30s max delay)
✅ **Scalable**: Queue-based system handles multiple users simultaneously
✅ **Traceable**: Every Supervisor action linked to specific task and conversation
