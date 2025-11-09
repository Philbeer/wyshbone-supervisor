// Supabase message with Supervisor extensions
export interface SupervisorMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  source?: 'ui' | 'supervisor' | 'system';
  metadata?: MessageMetadata;
  created_at: number;
}

export interface MessageMetadata {
  supervisor_task_id?: string;
  capabilities?: string[];
  lead_ids?: string[];
  thread_context?: Record<string, any>;
}

// Supervisor task queue
export interface SupervisorTask {
  id: string;
  conversation_id: string;
  user_id: string;
  task_type: 'analyze_conversation' | 'generate_leads' | 'provide_insights' | 'find_prospects';
  request_data: TaskRequestData;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: TaskResult;
  error?: string;
  created_at: number;
  processed_at?: number;
}

export interface TaskRequestData {
  user_message: string;
  conversation_context?: Array<{
    role: string;
    content: string;
    created_at: number;
  }>;
  user_profile?: {
    industry?: string;
    location?: {
      city?: string;
      country?: string;
    };
    target_audience?: string;
  };
  search_query?: {
    business_type?: string;
    location?: string;
    radius_km?: number;
  };
}

export interface TaskResult {
  message_id?: string;
  lead_ids?: string[];
  insights?: string[];
  capabilities_used?: string[];
}

// Conversation context from Supabase
export interface ConversationContext {
  conversation_id: string;
  user_id: string;
  messages: Array<{
    role: string;
    content: string;
    created_at: number;
  }>;
  user_profile?: {
    company_name?: string;
    industry?: string;
    objectives?: string[];
  };
}
