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
  clientRequestId?: string;
  actionTaken: string;
  status: 'pending' | 'success' | 'failed' | 'skipped';
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
          ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
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
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    clientRequestId,
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
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    clientRequestId,
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
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    clientRequestId,
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
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    clientRequestId,
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
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    clientRequestId,
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
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    clientRequestId,
    actionTaken: 'plan_execution_failed',
    status: 'failed',
    taskGenerated: `Plan failed: ${errorMessage}`,
    runType: 'plan',
    metadata: { error: errorMessage }
  });
}

export async function logToolsUpdate(
  userId: string,
  planId: string,
  toolsUsed: string[],
  toolsRejected: { tool: string; reason: string }[],
  replans: { from_tool: string; to_tool: string; reason: string }[],
  stepIndex: number,
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    clientRequestId,
    actionTaken: 'tools_update',
    status: 'success',
    taskGenerated: `Tools so far: ${toolsUsed.join(', ') || 'none'}${toolsRejected.length > 0 ? ` | Rejected: ${toolsRejected.map(r => r.tool).join(', ')}` : ''}`,
    runType: 'plan',
    metadata: {
      tools_used: toolsUsed,
      tools_rejected: toolsRejected,
      replans,
      after_step_index: stepIndex,
    },
  });
}

export async function logTowerEvaluationCompleted(
  userId: string,
  planId: string,
  verdict: string,
  reason: string,
  metrics: Record<string, unknown>,
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    clientRequestId,
    actionTaken: 'tower_evaluation_completed',
    status: 'success',
    taskGenerated: `Tower verdict: ${verdict} — ${reason}`,
    runType: 'plan',
    metadata: {
      tower_verdict: verdict.toLowerCase(),
      reason,
      ...metrics,
    }
  });
}

export async function logTowerDecisionStop(
  userId: string,
  planId: string,
  reason: string,
  metrics: Record<string, unknown>,
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    clientRequestId,
    actionTaken: 'tower_decision_stop',
    status: 'failed',
    taskGenerated: `Tower halted execution: ${reason}`,
    runType: 'plan',
    metadata: {
      tower_verdict: 'stop',
      reason,
      ...metrics,
    }
  });
}

export async function logTowerDecisionChangePlan(
  userId: string,
  planId: string,
  reason: string,
  metrics: Record<string, unknown>,
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId: planId,
    conversationId,
    clientRequestId,
    actionTaken: 'tower_decision_change_plan',
    status: 'pending',
    taskGenerated: `Tower requested plan change: ${reason}`,
    runType: 'plan',
    metadata: {
      tower_verdict: 'change_plan',
      reason,
      ...metrics,
    }
  });
}

export async function logToolCallStarted(
  userId: string,
  runId: string,
  toolName: string,
  inputsSummary: Record<string, unknown>,
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId,
    conversationId,
    clientRequestId,
    actionTaken: 'tool_call_started',
    status: 'pending',
    taskGenerated: `Executing tool: ${toolName}`,
    runType: 'tool',
    metadata: {
      tool_name: toolName,
      inputs: inputsSummary,
    },
  });
}

export async function logToolCallCompleted(
  userId: string,
  runId: string,
  toolName: string,
  outputsSummary: Record<string, unknown>,
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId,
    conversationId,
    clientRequestId,
    actionTaken: 'tool_call_completed',
    status: 'success',
    taskGenerated: `Tool completed: ${toolName}`,
    runType: 'tool',
    metadata: {
      tool_name: toolName,
      outputs: outputsSummary,
    },
  });
}

export async function logToolCallFailed(
  userId: string,
  runId: string,
  toolName: string,
  errorMessage: string,
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId,
    conversationId,
    clientRequestId,
    actionTaken: 'tool_call_failed',
    status: 'failed',
    taskGenerated: `Tool failed: ${toolName} — ${errorMessage}`,
    runType: 'tool',
    metadata: {
      tool_name: toolName,
      error: errorMessage,
    },
  });
}

export async function logRunCompleted(
  userId: string,
  runId: string,
  summary: string,
  metadata?: Record<string, unknown>,
  conversationId?: string,
): Promise<void> {
  await logAFREvent({
    userId,
    runId,
    conversationId,
    actionTaken: 'run_completed',
    status: 'success',
    taskGenerated: summary,
    runType: 'plan',
    metadata: metadata || {},
  });
}

export async function logMissionReceived(
  userId: string,
  runId: string,
  taskId: string,
  taskType: string,
  conversationId?: string,
): Promise<void> {
  await logAFREvent({
    userId,
    runId,
    conversationId,
    actionTaken: 'mission_received',
    status: 'pending',
    taskGenerated: `Mission received: ${taskType} (task ${taskId})`,
    runType: 'plan',
    metadata: {
      source: 'supervisor_tasks_poll',
      task_id: taskId,
      task_type: taskType,
      conversation_id: conversationId || null,
    },
  });
}

export async function logRouterDecision(
  userId: string,
  runId: string,
  canonicalToolName: string,
  reason: string,
  conversationId?: string,
  clientRequestId?: string
): Promise<void> {
  await logAFREvent({
    userId,
    runId,
    conversationId,
    clientRequestId,
    actionTaken: 'router_decision',
    status: 'success',
    taskGenerated: `Router: using ${canonicalToolName} — ${reason}`,
    runType: 'plan',
    metadata: {
      tool_name: canonicalToolName,
      reason,
    },
  });
}
