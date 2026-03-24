export interface SleepingGoal {
  id: string;
  userId: string;
  conversationId: string | null;
  label: string;
  description: string;
  scheduleType: 'daily' | 'weekly' | 'hourly';
  monitorType: string;
  config: {
    original_goal: string;
    business_type: string;
    location: string;
    country: string;
    constraints: Array<{ type: string; field: string; operator: string; value: string }>;
    mission_mode: string;
    source_run_id: string;
  };
  baselineEntityNames: string[];
  consecutiveEmptyWakes: number;
  lastRunAt: string | null;
  lastRunId: string | null;
  nextWakeAt: string;
  createdAt: string;
}

export interface WakeResult {
  goalId: string;
  runId: string;
  entitiesFound: string[];
  newEntities: string[];
  removedEntities: string[];
  deltaCount: number;
  succeeded: boolean;
  error?: string;
}

export interface DeltaResult {
  newEntities: string[];
  removedEntities: string[];
  unchangedCount: number;
  baselineCount: number;
  currentCount: number;
}
