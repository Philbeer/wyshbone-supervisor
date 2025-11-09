# Integration Instructions for Wyshbone UI Agent

Copy these instructions to your Wyshbone UI Replit agent to integrate Supervisor chat functionality.

---

## Overview

The Supervisor backend is running in a separate Replit and monitoring your Supabase database. When users ask for leads or insights in chat, the UI needs to:
1. Create a task in `supervisor_tasks` table
2. Stream Supervisor responses via Supabase realtime
3. Display Supervisor messages with special styling

---

## Database Schema Changes (Already Done)

Your Supabase database already has these updates:

**messages table:**
- ✅ `source` column (TEXT) - values: 'ui', 'supervisor', 'system'
- ✅ `metadata` column (JSONB) - contains `supervisor_task_id`, `capabilities`, `lead_ids`

**supervisor_tasks table:**
- ✅ Exists and ready to use
- Structure: `id`, `conversation_id`, `user_id`, `task_type`, `request_data`, `status`, `result`, `error`, `created_at`, `processed_at`

---

## Step 1: Detect Supervisor Intent

When user sends a message, detect if they want Supervisor help based on keywords:

**Trigger words:**
- "find leads", "find prospects", "search for", "generate leads"
- "analyze conversation", "what have we discussed", "summary"
- "give me insights", "what do you know about"

**Implementation:**
```typescript
function needsSupervisor(message: string): boolean {
  const supervisorKeywords = [
    'find leads', 'find prospects', 'search for', 'generate leads',
    'analyze conversation', 'summary', 'insights'
  ];
  
  const lowerMessage = message.toLowerCase();
  return supervisorKeywords.some(keyword => lowerMessage.includes(keyword));
}
```

---

## Step 2: Create Supervisor Tasks

When Supervisor is needed, create a task in Supabase:

**Task Types:**
- `generate_leads` - Find prospects/leads
- `find_prospects` - Same as generate_leads
- `analyze_conversation` - Analyze chat history
- `provide_insights` - Share business insights

**Code Example:**
```typescript
async function createSupervisorTask(
  conversationId: string,
  userId: string,
  userMessage: string,
  searchQuery?: {
    business_type: string;
    location: string;
  }
) {
  const { data, error } = await supabase
    .from('supervisor_tasks')
    .insert({
      conversation_id: conversationId,
      user_id: userId,
      task_type: 'generate_leads',
      request_data: {
        user_message: userMessage,
        search_query: searchQuery || {}
      },
      status: 'pending',
      created_at: Date.now()
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to create supervisor task:', error);
    throw error;
  }

  return data;
}
```

**Parsing Search Queries:**
Extract business type and location from user messages:

```typescript
function parseSearchQuery(message: string): { business_type?: string; location?: string } {
  // Simple pattern matching - improve as needed
  const locationMatch = message.match(/in ([A-Za-z\s]+?)(?:\s|$|,)/i);
  const businessMatch = message.match(/(?:find|search for)\s+([A-Za-z\s]+?)(?:\sin|$)/i);
  
  return {
    business_type: businessMatch?.[1]?.trim(),
    location: locationMatch?.[1]?.trim()
  };
}

// Example usage:
const message = "Find dental clinics in York";
const searchQuery = parseSearchQuery(message);
// Result: { business_type: "dental clinics", location: "York" }
```

---

## Step 3: Setup Supabase Realtime Subscription

Subscribe to new messages to stream Supervisor responses:

```typescript
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase'; // Your Supabase client

function useSupervisorMessages(conversationId: string) {
  useEffect(() => {
    if (!conversationId) return;

    // Subscribe to new messages in this conversation
    const channel = supabase
      .channel(`conversation:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`
        },
        (payload) => {
          const newMessage = payload.new;
          
          // Check if it's from Supervisor
          if (newMessage.source === 'supervisor') {
            console.log('🤖 New Supervisor message:', newMessage);
            
            // Add to your chat state
            // setMessages(prev => [...prev, newMessage]);
            
            // Optional: Show toast notification
            // toast.success('Supervisor found new leads!');
          }
        }
      )
      .subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, [conversationId]);
}
```

---

## Step 4: Display Supervisor Messages

Render Supervisor messages differently in your chat UI:

```typescript
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  source?: 'ui' | 'supervisor' | 'system';
  metadata?: {
    supervisor_task_id?: string;
    capabilities?: string[];
    lead_ids?: string[];
  };
  created_at: number;
}

function ChatMessage({ message }: { message: Message }) {
  const isSupervisor = message.source === 'supervisor';
  
  return (
    <div className={`message ${isSupervisor ? 'supervisor-message' : ''}`}>
      {isSupervisor && (
        <div className="supervisor-badge">
          🤖 Supervisor
        </div>
      )}
      
      <div className="message-content">
        {message.content}
      </div>
      
      {isSupervisor && message.metadata?.lead_ids && (
        <div className="supervisor-metadata">
          <span>Found {message.metadata.lead_ids.length} leads</span>
          {message.metadata.capabilities?.map(cap => (
            <span key={cap} className="capability-badge">
              {cap}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Styling Example:**
```css
.supervisor-message {
  background: linear-gradient(to right, #f0f9ff, #ffffff);
  border-left: 3px solid #3b82f6;
  padding: 16px;
  margin: 8px 0;
}

.supervisor-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #3b82f6;
  color: white;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 8px;
}

.supervisor-metadata {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.capability-badge {
  background: #e0f2fe;
  color: #0369a1;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
}
```

---

## Step 5: Complete Integration Flow

Here's how it all works together:

```typescript
async function handleUserMessage(
  message: string,
  conversationId: string,
  userId: string
) {
  // 1. Save user message to Supabase as normal
  await supabase.from('messages').insert({
    id: crypto.randomUUID(),
    conversation_id: conversationId,
    role: 'user',
    content: message,
    source: 'ui',
    created_at: Date.now()
  });

  // 2. Check if Supervisor should help
  if (needsSupervisor(message)) {
    const searchQuery = parseSearchQuery(message);
    
    // 3. Create Supervisor task
    await createSupervisorTask(
      conversationId,
      userId,
      message,
      searchQuery
    );
    
    // 4. Show loading state (optional)
    // setWaitingForSupervisor(true);
    
    // Supervisor will process within 30 seconds and post response
    // Your realtime subscription will receive it automatically
  } else {
    // Handle with regular UI AI
    // ... your existing logic
  }
}
```

---

## Step 6: Optional Enhancements

### Loading State While Waiting for Supervisor

```typescript
function SupervisorLoadingIndicator() {
  return (
    <div className="supervisor-loading">
      <div className="supervisor-badge">🤖 Supervisor</div>
      <div className="loading-text">
        Analyzing your request and searching for leads...
        <div className="spinner"></div>
      </div>
    </div>
  );
}
```

### "Ask Supervisor" Button

Add a button to explicitly request Supervisor:

```typescript
function ChatInput({ onSendMessage }) {
  const [message, setMessage] = useState('');
  
  const askSupervisor = () => {
    // Prepend trigger word
    onSendMessage(`Find leads: ${message}`);
  };
  
  return (
    <div className="chat-input">
      <input 
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Type a message..."
      />
      <button onClick={() => onSendMessage(message)}>Send</button>
      <button onClick={askSupervisor}>🤖 Ask Supervisor</button>
    </div>
  );
}
```

---

## Testing the Integration

**Manual Test:**
1. User types: "Find dental clinics in York"
2. UI creates supervisor_task in Supabase
3. Wait ~30 seconds
4. Supervisor processes task
5. Supervisor posts response to messages table with source='supervisor'
6. UI realtime subscription receives message
7. Message displays with Supervisor badge and styling

**Check it worked:**
```sql
-- In Supabase SQL Editor
SELECT * FROM supervisor_tasks ORDER BY created_at DESC LIMIT 5;
SELECT * FROM messages WHERE source = 'supervisor' ORDER BY created_at DESC LIMIT 5;
```

---

## Troubleshooting

**Supervisor not responding:**
- Check supervisor_tasks table - is task status stuck on 'pending'?
- Check if Supervisor backend is running (separate Replit)
- Verify task_type is valid: 'generate_leads', 'analyze_conversation', 'provide_insights'

**Messages not streaming:**
- Check Supabase realtime is enabled for messages table
- Verify subscription filter matches conversation_id
- Check browser console for connection errors

**Messages missing metadata:**
- Supervisor always includes metadata with source='supervisor'
- Check you're reading the metadata field correctly

---

## Summary for Agent

Please implement:
1. ✅ Keyword detection for Supervisor triggers
2. ✅ Function to create supervisor_tasks in Supabase
3. ✅ Supabase realtime subscription for new messages
4. ✅ Special UI styling for Supervisor messages (badge, border, metadata)
5. ✅ Optional: Loading indicator while waiting
6. ✅ Optional: "Ask Supervisor" button

The Supervisor backend is already running and monitoring Supabase every 30 seconds!
