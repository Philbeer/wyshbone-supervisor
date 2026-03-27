/**
 * Protocol Logger - Emit typed protocol events to agent_activities
 *
 * Dual-emit companion to afr-logger.ts. All functions write rows to
 * agent_activities with metadata.protocol = 'v1' so the UI ticker can
 * filter and display them separately from AFR events.
 *
 * Metadata uses camelCase keys to match the existing afr-logger.ts convention.
 */

import { supabase } from '../supabase';

interface ProtocolBase {
  userId: string;
  runId: string;
  conversationId?: string;
  clientRequestId?: string;
}

async function emitProtocolEvent(params: ProtocolBase & {
  actionTaken: string;
  taskGenerated: string;
  status: 'pending' | 'success';
  metadata: Record<string, unknown>;
}): Promise<void> {
  if (!supabase) return;
  const { userId, runId, conversationId, clientRequestId, actionTaken, taskGenerated, status, metadata } = params;
  await supabase.from('agent_activities').insert({
    id: `proto_${actionTaken.substring(0, 12)}_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    user_id: userId,
    timestamp: Date.now(),
    task_generated: taskGenerated,
    action_taken: actionTaken,
    action_params: {},
    results: null,
    interesting_flag: 0,
    status,
    error_message: null,
    duration_ms: null,
    conversation_id: conversationId ?? null,
    run_id: runId,
    client_request_id: clientRequestId ?? null,
    metadata: {
      protocol: 'v1',
      runType: 'tool',
      ...(clientRequestId ? { clientRequestId } : {}),
      ...metadata,
    },
    created_at: Date.now(),
  }).catch(() => {});
}

export async function emitPhaseEntered(params: ProtocolBase & {
  phaseName: string;
  phaseLabel: string;
  phaseIcon?: string;
  phaseIndex?: number;
  totalPhases?: number;
  detail?: string;
}): Promise<void> {
  return emitProtocolEvent({
    ...params,
    actionTaken: 'phase_entered',
    taskGenerated: `Phase entered: ${params.phaseLabel}${params.detail ? ` — ${params.detail}` : ''}`,
    status: 'pending',
    metadata: {
      event: 'phase_entered',
      phaseName: params.phaseName,
      phaseLabel: params.phaseLabel,
      phaseIcon: params.phaseIcon ?? null,
      phaseIndex: params.phaseIndex ?? null,
      totalPhases: params.totalPhases ?? null,
      detail: params.detail ?? null,
    },
  });
}

export async function emitMilestoneReached(params: ProtocolBase & {
  milestoneKey: string;
  milestoneText: string;
  milestoneIcon?: string;
  phaseName?: string;
  detail?: string;
}): Promise<void> {
  return emitProtocolEvent({
    ...params,
    actionTaken: 'milestone_reached',
    taskGenerated: `Milestone: ${params.milestoneText}${params.detail ? ` — ${params.detail}` : ''}`,
    status: 'success',
    metadata: {
      event: 'milestone_reached',
      milestoneKey: params.milestoneKey,
      milestoneText: params.milestoneText,
      milestoneIcon: params.milestoneIcon ?? null,
      phaseName: params.phaseName ?? null,
      detail: params.detail ?? null,
    },
  });
}

export async function emitProgressTick(params: ProtocolBase & {
  pubName: string;
  domain: string | null;
  tickText?: string;
  tickIcon?: string;
  phaseName?: string;
}): Promise<void> {
  const tickText = params.tickText ?? `Visiting ${params.pubName}${params.domain ? ` (${params.domain})` : ''}`;
  return emitProtocolEvent({
    ...params,
    actionTaken: 'progress_tick',
    taskGenerated: tickText,
    status: 'pending',
    metadata: {
      event: 'progress_tick',
      tickText,
      tickIcon: params.tickIcon ?? null,
      pubName: params.pubName,
      domain: params.domain ?? null,
      phaseName: params.phaseName ?? 'web_evidence',
    },
  });
}

export async function emitIntentResolved(params: ProtocolBase & {
  entityDescription: string;
  scarcityExpectation?: string;
  keyDiscriminator?: string;
  findability?: string;
  exclusions?: string[];
  detail?: string;
}): Promise<void> {
  return emitProtocolEvent({
    ...params,
    actionTaken: 'intent_resolved',
    taskGenerated: `Intent resolved: ${params.entityDescription.substring(0, 120)}`,
    status: 'success',
    metadata: {
      event: 'intent_resolved',
      entityDescription: params.entityDescription,
      scarcityExpectation: params.scarcityExpectation ?? null,
      keyDiscriminator: params.keyDiscriminator ?? null,
      findability: params.findability ?? null,
      exclusions: params.exclusions ?? null,
      detail: params.detail ?? null,
    },
  });
}

export async function emitResultsReady(params: ProtocolBase & {
  resultCount: number;
  resultType?: string;
  towerVerdict?: string | null;
  totalLoops?: number;
  detail?: string;
}): Promise<void> {
  const resultType = params.resultType ?? 'leads';
  return emitProtocolEvent({
    ...params,
    actionTaken: 'results_ready',
    taskGenerated: `Results ready: ${params.resultCount} ${resultType}${params.detail ? ` — ${params.detail}` : ''}`,
    status: 'success',
    metadata: {
      event: 'results_ready',
      resultCount: params.resultCount,
      resultType,
      towerVerdict: params.towerVerdict ?? null,
      totalLoops: params.totalLoops ?? null,
      detail: params.detail ?? null,
    },
  });
}
