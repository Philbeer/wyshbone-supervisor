/**
 * Supervisor Plan Types
 * Minimal TypeScript interfaces for Session 1
 */

export interface PlanStep {
  id: string;
  type: string;
  label: string;
  description?: string;
  dependsOn?: string[];
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

export interface Plan {
  planId: string;
  userId: string;
  conversationId?: string;
  clientRequestId?: string;
  goal: string;
  steps: PlanStep[];
  skipJudgement?: boolean;
  toolMetadata?: {
    toolName: string;
    toolArgs: Record<string, unknown>;
  };
}

export interface ExecutePlanRequest {
  planId: string;
  userId: string;
  conversationId?: string;
  goal: string;
  steps: PlanStep[];
  toolMetadata?: {
    toolName: string;
    toolArgs: Record<string, unknown>;
  };
}

export interface ExecutePlanResponse {
  ok: boolean;
  planId?: string;
  status?: 'executing' | 'failed';
  error?: string;
}

export type StepStatus = 'pending' | 'running' | 'success' | 'failed';
