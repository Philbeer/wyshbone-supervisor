/**
 * AFR Logger - Write AFR-compatible rows to agent_activities
 * 
 * Writes to agent_activities table in a format that the existing
 * UI Live Activity panel can display.
 */

import { supabase } from '../supabase';
import { randomUUID } from 'crypto';

interface AFRLogParams {
  userId: string;
  runId: string;
  conversationId?: string;
  actionTaken: string;
  status: 'pending' | 'success' | 'failed';
  taskGenerated: string;
  runType: 'plan' | 'tool';
  metadata?: Record<string, unknown>;
}

export async function logAFREvent(params: AFRLogParams): Promise<void> {
  if (!supabase) {
    console.warn('[AFR_LOGGER] Supabase not configured - skipping AFR logging');
    return;
  }

  const activityId = `afr_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  try {
    const { error } = await supabase
      .from('agent_activities')
      .insert({
        id: activityId,
        user_id: params.userId,
        timestamp: Date.now(),
        task_generated: params.taskGenerated,
        action_taken: params.actionTaken,
        action_params: {},
        results: null,
        interesting_flag: 0,
        status: params.status,
        error_message: params.status === 'failed' ? (params.metadata?.error as string) : null,
        duration_ms: null,
        conversation_id: params.conversationId || null,
        run_id: params.runId,
        metadata: {
          runType: params.runType,
          ...params.metadata
        },
        created_at: Date.now()
      });

    if (error) {
      console.error('[AFR_LOGGER] Error logging AFR event:', error);
    } else {
      console.log(`[AFR_LOGGER] Logged: ${params.actionTaken} - ${params.status}`);
    }
  } catch (error: any) {
    console.error('[AFR_LOGGER] Exception logging AFR event:', error.message);
  }
}

export async function logPlanStarted(
  userId: string,
  planId: string,
  goal: string,
  conversationId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    actionTaken: 'plan_execution_started',
    status: 'pending',
    taskGenerated: `Started execution: ${goal}`,
    runType: 'plan'
  });
}

export async function logStepStarted(
  userId: string,
  planId: string,
  stepId: string,
  stepLabel: string,
  conversationId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    actionTaken: `step_started:${stepId}`,
    status: 'pending',
    taskGenerated: `Running: ${stepLabel}`,
    runType: 'tool',
    metadata: { stepId }
  });
}

export async function logStepCompleted(
  userId: string,
  planId: string,
  stepId: string,
  stepLabel: string,
  summary?: string,
  conversationId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    actionTaken: `step_completed:${stepId}`,
    status: 'success',
    taskGenerated: summary || `Completed: ${stepLabel}`,
    runType: 'tool',
    metadata: { stepId }
  });
}

export async function logStepFailed(
  userId: string,
  planId: string,
  stepId: string,
  stepLabel: string,
  errorMessage: string,
  conversationId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    actionTaken: `step_failed:${stepId}`,
    status: 'failed',
    taskGenerated: `Failed: ${stepLabel} - ${errorMessage}`,
    runType: 'tool',
    metadata: { stepId, error: errorMessage }
  });
}

export async function logPlanCompleted(
  userId: string,
  planId: string,
  summary: string,
  conversationId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    actionTaken: 'plan_execution_completed',
    status: 'success',
    taskGenerated: summary,
    runType: 'plan'
  });
}

export async function logPlanFailed(
  userId: string,
  planId: string,
  errorMessage: string,
  conversationId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    actionTaken: 'plan_execution_failed',
    status: 'failed',
    taskGenerated: `Plan failed: ${errorMessage}`,
    runType: 'plan',
    metadata: { error: errorMessage }
  });
}
