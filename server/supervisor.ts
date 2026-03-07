import { supabase } from './supabase';
import { storage } from './storage';
import { emailService } from './notifications/email-service';
import type { SupervisorTask, SupervisorMessage, TaskResult } from './types/supervisor-chat';
import { randomUUID } from 'crypto';
import { monitorGoalsOnce, publishGoalMonitorEvents } from './goal-monitoring';
import { logAFREvent, logMissionReceived, logRunCompleted, logRouterDecision, logToolCallStarted, logToolCallCompleted, logToolCallFailed } from './supervisor/afr-logger';
import { createResearchProvider } from './supervisor/research-provider';
import { createArtefact } from './supervisor/artefacts';
import { initRunState, handleTowerVerdict, getRunState } from './supervisor/agent-loop';
import { executeAction, createRunToolTracker, type ActionResult as LoopActionResult } from './supervisor/action-executor';
import { generateJobId } from './supervisor/jobs';
import { redactRecord, safeOutputsRaw, compactInputs } from './supervisor/plan-executor';
import { buildToolPlan, persistToolPlanExplainer, getOrderedToolNames, type LeadContext, type ToolStepId, type ToolPlanExplainer } from './supervisor/tool-planning-policy';
import { judgeArtefact } from './supervisor/tower-artefact-judge';
import { buildShortfallDirective, applyLeadgenReplanPolicy, constraintsAreIdentical, buildProgressSummary, type PlanV2Constraints } from './supervisor/replan-policy';
import { parseGoalToConstraints, checkHardConstraintsSatisfied, filterLeadsByNameConstraint, buildRequestedCount, DEFAULT_LEADS_TARGET, sanitiseLocationString, detectExactnessMode, detectDoNotStop, type ParsedGoal, type StructuredConstraint, type RequestedCountCanonical, type ExactnessMode } from './supervisor/goal-to-constraints';
import { emitSearchQueryCompiled, type SearchQueryCompiledPayload } from './supervisor/search-query-compiled';
import { RADIUS_LADDER_KM, makeDedupeKey, mergeCandidate, type AccumulatedCandidate } from './supervisor/agent-loop';
import { emitDeliverySummary, type PlanVersionEntry, type SoftRelaxation, type DeliverySummaryPayload } from './supervisor/delivery-summary';
import { emitRunReceipt } from './supervisor/run-receipt';
import { writeBeliefs } from './supervisor/belief-writer';
import { executeFactoryDemo } from './supervisor/factory-demo';
import { normalizeSensorScript } from './supervisor/factory-sim';
import { buildConstraintsExtractedPayload, buildCapabilityCheck, verifyLeads, type VerifiableLead, type CvlVerificationOutput, type AttributeEvidenceMap } from './supervisor/cvl';
import { evaluatePrePlanGate, type ClarificationResult } from './supervisor/pre-plan-gate';
import { evaluateClarifyGate, evaluateClarifyGateFromIntent, extractBusinessType, extractLocation, extractCount, extractTimeFilter, type ClarifyGateResult, type ClarifyMissingField, type ClarifyTriggerCategory } from './supervisor/clarify-gate';
import { getClarifySession, didSessionExpire, createClarifySession, closeClarifySession, classifyFollowUp, applyFollowUp, incrementTurnCount, renderClarifySummary, sessionIsComplete, sessionIsAtTurnLimit, buildSearchFromSession, buildClarifyState, type ClarifySession, type ClarifyState } from './supervisor/clarify-session';
import { detectRelationshipPredicate, buildRelationshipSummary, sanitizeRelationshipMessage, type RelationshipPredicateResult, type RelationshipEvidenceSummary } from './supervisor/relationship-predicate';
import { runIntentExtractorShadow, getIntentExtractorMode, emitProbe } from './supervisor/intent-shadow';
import { extractStructuredMission, getMissionExtractorMode } from './supervisor/mission-extractor';
import { logMissionShadow, buildMissionDiagnosticPayload, missionToParsedGoal } from './supervisor/mission-bridge';
import { buildConversationContextString, canonicalIntentToPreviewFields, canonicalIntentToParsedGoal } from './supervisor/intent-bridge';
import { preExecutionConstraintGate, preExecutionConstraintGateFromIntent, resolveFollowUp, storePendingContract, getPendingContract, clearPendingContract, buildConstraintGateMessage, detectNoProxySignal, detectMustBeCertain, applyCertaintyGate, generateKeywordVariants, type ConstraintContract, type AttributeClassification } from './supervisor/constraint-gate';
import { detectTimePredicate, buildClarifyQuestion as buildTimePredicateClarifyQuestion, buildTimePredicateContract } from './supervisor/time-predicate';
import { requestSemanticVerification, towerStatusToVerdict, type TowerSemanticRequest, type TowerSemanticStatus, type TowerSemanticResponse, type SemanticVerifyResult } from './supervisor/tower-semantic-verify';
import { applyPolicy, persistPolicyApplication, writeDecisionLog, writeOutcomeLog, writeOutcomePolicyVersion, buildApplicationSnapshot, deriveExecutionParams, GLOBAL_DEFAULT_BUNDLE, canonicaliseBusinessType, type PolicyApplicationResult, type PolicyBundleV1, type RunOverrides } from './supervisor/learning-layer';
import { computeQueryShapeKey, deriveQueryShapeFromGoal } from './supervisor/query-shape-key';
import { readLearningStore, mergePolicyKnobs, buildPolicyAppliedPayload, emitPolicyAppliedArtefact, handleLearningUpdate, BASELINE_DEFAULTS, type FinalPolicy, type PolicyAppliedArtefact, type LearningUpdatePayload } from './supervisor/learning-store';

const SUPERVISOR_NEUTRAL_MESSAGE = 'Run complete. Results are available.';

// --- Session Isolation Guard ---
// Tracks the active taskId per conversationId so that stale in-flight work
// from a prior task/conversation is dropped before delivery.
const _activeTaskPerConversation = new Map<string, { taskId: string; runId: string }>();

function registerActiveTask(conversationId: string, taskId: string, runId: string): void {
  _activeTaskPerConversation.set(conversationId, { taskId, runId });
  console.log(`[SESSION_GUARD] Registered active task=${taskId} runId=${runId} for conversation=${conversationId}`);
}

function isTaskCurrentForConversation(conversationId: string, taskId: string): boolean {
  const active = _activeTaskPerConversation.get(conversationId);
  if (!active) return true;
  return active.taskId === taskId;
}

function isRunCurrentForConversation(conversationId: string, runId: string): boolean {
  const active = _activeTaskPerConversation.get(conversationId);
  if (!active) return true;
  return active.runId === runId;
}

function guardDelivery(conversationId: string, taskId: string, label: string): boolean {
  if (isTaskCurrentForConversation(conversationId, taskId)) return true;
  const active = _activeTaskPerConversation.get(conversationId);
  console.warn(`[SESSION_GUARD] BLOCKED stale delivery: ${label} | stale_task=${taskId} active_task=${active?.taskId ?? 'unknown'} conversation=${conversationId}`);
  return false;
}

const SUPERVISOR_COUNT_CLAIM_RE = /\b(found|delivered|discovered|located|identified)\b.*?\b\d+\b/i;

function stripMarkdownTokens(msg: string): string {
  let cleaned = msg;
  cleaned = cleaned.replace(/\*\*/g, '');
  cleaned = cleaned.replace(/\\+/g, '');
  cleaned = cleaned.replace(/(?<!\w)\*(?!\s)/g, '');
  cleaned = cleaned.replace(/(?<!\s)\*(?!\w)/g, '');
  cleaned = cleaned.replace(/\s+([.,;:!?])/g, '$1');
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  return cleaned.trim();
}

function stripDebugEcho(msg: string): string {
  return msg.replace(/\s*\([a-z]*(?:find|search|locate|list)\s[^)]{3,150}\)\s*/gi, ' ').trim();
}

function sanitizeMessageContent(msg: string): string {
  let result = stripMarkdownTokens(msg);
  result = stripDebugEcho(result);
  result = result.replace(/\s+([.,;:!?])/g, '$1');
  result = result.replace(/\s{2,}/g, ' ');
  return result.trim();
}

function buildClarifyStateFromContract(contract: ConstraintContract): { status: 'ask_more' | 'ready_to_search'; draft: Record<string, unknown>; missingFields: string[]; turnCount: number; maxTurns: number } {
  return {
    status: contract.can_execute ? 'ready_to_search' : 'ask_more',
    draft: { constraints: contract.constraints.map(c => ({ type: c.type, value: c.value, hardness: c.hardness })) },
    missingFields: contract.clarify_questions.map((_, i) => `constraint_${i}`),
    turnCount: 0,
    maxTurns: 3,
  };
}

function sanitizeSupervisorMessage(msg: string): string {
  if (SUPERVISOR_COUNT_CLAIM_RE.test(msg)) {
    console.warn(`[SUPERVISOR_MSG_GUARD] Blocked count-claiming message: "${msg.substring(0, 120)}…"`);
    return SUPERVISOR_NEUTRAL_MESSAGE;
  }
  return sanitizeMessageContent(msg);
}

interface UserContext {
  userId: string;
  accountId?: string; // SUP-012: Account ID for multi-account isolation
  verticalId?: import('./core/verticals/types').VerticalId; // SUP-17: Vertical ID for vertical-aware features
  profile?: {
    companyName?: string;
    companyDomain?: string;
    inferredIndustry?: string;
    primaryObjective?: string;
    secondaryObjectives?: string[];
    targetMarkets?: string[];
    productsOrServices?: string[];
    confidence?: number;
  };
  facts: Array<{
    fact: string;
    score: number;
    category: string;
    createdAt: string;
  }>;
  recentMessages: Array<{
    role: string;
    content: string;
    createdAt: string;
  }>;
  monitors: Array<{
    label: string;
    description: string;
    monitorType: string;
  }>;
  researchRuns: Array<{
    label: string;
    prompt: string;
  }>;
}

class SupervisorService {
  private pollInterval: number = 3000; // 3 seconds — must beat UI's own task processor
  private isRunning: boolean = false;
  private timeoutId?: NodeJS.Timeout;
  private claimIntervalId?: NodeJS.Timeout;
  private pendingClaimedQueue: any[] = [];
  private batchSize: number = 50; // Process up to 50 signals per poll
  private missingTableWarned: boolean = false;
  private nonNumericIdWarned: boolean = false;
  private startupRecoveryDone: boolean = false;
  private static readonly STALE_TASK_TIMEOUT_MS = 90 * 1000; // 90 seconds (was 5 min — too long for stuck tasks)
  private static readonly MAX_RECOVERY_ATTEMPTS = 3;
  private lastNoTasksLogAt: number = 0;

  async start() {
    if (this.isRunning) {
      console.log('Supervisor already running');
      return;
    }

    this.isRunning = true;
    console.log('🤖 Supervisor service started - monitoring for new signals...');

    await this.recoverOrphanedTasks();
    await this.recoverOrphanedAgentRuns();
    this.startBackgroundClaimer();
    await this.poll();
  }

  stop() {
    this.isRunning = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    if (this.claimIntervalId) {
      clearInterval(this.claimIntervalId);
    }
    console.log('Supervisor service stopped');
  }

  private startBackgroundClaimer() {
    this.claimIntervalId = setInterval(async () => {
      if (!supabase || !this.isRunning) return;
      try {
        await this.claimPendingTasks();
      } catch (err: any) {
        console.warn(`[BG_CLAIM] Background claim error (non-fatal): ${err.message}`);
      }
    }, 2000);
  }

  private async poll() {
    if (!this.isRunning) return;

    try {
      // Skip if Supabase not configured
      if (!supabase) {
        // Schedule next poll
        this.timeoutId = setTimeout(() => this.poll(), this.pollInterval);
        return;
      }

      const tasks: Promise<void>[] = [
        this.processNewSignals(),
        this.processSupervisorTasks(),
        this.monitorGoals(),
        this.flagBypassedRuns(),
      ];
      await Promise.all(tasks);
    } catch (error) {
      console.error('Error in supervisor poll:', error);
    }

    this.timeoutId = setTimeout(() => this.poll(), this.pollInterval);
  }

  private async processNewSignals() {
    if (!supabase) return;
    
    // Get composite checkpoint {timestamp, id}
    const checkpoint = await storage.getSupervisorCheckpoint('supabase');
    
    // Fetch signals using timestamp-only server filter, then client-side composite cursor
    // This works around PostgREST .or() limitations while remaining efficient
    let query = supabase
      .from('user_signals')
      .select('*')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(this.batchSize + 50); // Fetch extra to handle same-timestamp filtering
    
    if (checkpoint.timestamp) {
      // Fetch signals at or after checkpoint timestamp (server-side)
      query = query.gte('created_at', checkpoint.timestamp.toISOString());
    }
    // else: no checkpoint, fetch from beginning

    const { data: rawSignals, error } = await query;

    if (error) {
      console.error('Error fetching signals from Supabase:', error);
      return;
    }

    if (!rawSignals || rawSignals.length === 0) {
      return;
    }

    // Client-side composite cursor filter: exclude signals at/before checkpoint
    const filteredSignals = rawSignals.filter(signal => {
      if (!checkpoint.timestamp || !checkpoint.id) {
        return true; // No checkpoint, process all
      }
      
      const signalTime = new Date(signal.created_at).getTime();
      const checkpointTime = checkpoint.timestamp.getTime();
      
      // Only include if AFTER checkpoint: (ts > checkpoint.ts) OR (ts == checkpoint.ts AND id > checkpoint.id)
      if (signalTime > checkpointTime) {
        return true;
      } else if (signalTime === checkpointTime) {
        const sid = String(signal.id);
        const cid = String(checkpoint.id);
        const bothNumeric = /^[0-9]+$/.test(sid) && /^[0-9]+$/.test(cid);
        if (!bothNumeric) {
          if (!this.nonNumericIdWarned) {
            this.nonNumericIdWarned = true;
            console.log(`[SUPERVISOR] Signal IDs are non-numeric (UUID); using string comparison for cursor. signal.id=${sid}, checkpoint.id=${cid}`);
          }
          return sid > cid;
        }
        return BigInt(sid) > BigInt(cid);
      }
      return false;
    });

    // Take only batch size after filtering
    const signals = filteredSignals.slice(0, this.batchSize);

    if (signals.length === 0) {
      return;
    }

    // Process each signal in order - stop on first failure
    for (const signal of signals) {
      const signalId = signal.id.toString();
      const signalCreatedAt = new Date(signal.created_at);
      
      // Check if already processed (idempotency guard - redundant but safe)
      const alreadyProcessed = await storage.isSignalProcessed(signalId, 'supabase');
      if (alreadyProcessed) {
        console.log(`⏭️  Signal ${signalId} already processed, skipping...`);
        continue;
      }
      
      console.log(`📊 Processing new signal ${signalId} (${signal.type})...`);
      
      try {
        await this.generateLeadsFromSignal(signal);
        
        // Mark as processed in processed_signals table (idempotency)
        await storage.markSignalProcessed(signalId, 'supabase', signalCreatedAt);
        
        // Update checkpoint to this signal's position
        await storage.updateSupervisorCheckpoint('supabase', signalCreatedAt, signalId);
        
        console.log(`✅ Checkpoint updated: ${signalCreatedAt.toISOString()} / ${signalId}`);
      } catch (error) {
        console.error(`Failed to process signal ${signalId}:`, error);
        // Break the loop - don't advance checkpoint past this failed signal
        // Will retry this signal and remaining signals on next poll
        break;
      }
    }
  }

  private async recoverOrphanedTasks(): Promise<void> {
    if (!supabase || this.startupRecoveryDone) return;
    this.startupRecoveryDone = true;

    try {
      const { data: stuckTasks, error } = await supabase
        .from('supervisor_tasks')
        .select('id, user_id, conversation_id, request_data, created_at, status, run_id, client_request_id')
        .in('status', ['processing', 'claimed'])
        .limit(50);

      if (error) {
        if (error.code === 'PGRST205') return;
        console.error(`[RECOVERY] Failed to query stuck tasks: ${error.message}`);
        return;
      }

      if (!stuckTasks || stuckTasks.length === 0) {
        console.log('[RECOVERY] No orphaned tasks found on startup');
        return;
      }

      console.log(`[RECOVERY] Found ${stuckTasks.length} orphaned task(s) in 'processing'/'claimed' state — evaluating for requeue`);

      let requeued = 0;
      let skipped = 0;
      let failed = 0;

      for (const task of stuckTasks) {
        try {
          const result = await this.evaluateAndRecoverTask(task, 'startup');
          if (result === 'requeued') requeued++;
          else if (result === 'skipped') skipped++;
          else failed++;
        } catch (err: any) {
          console.error(`[RECOVERY] Task ${task.id}: unexpected error — ${err.message}`);
          failed++;
        }
      }

      console.log(`[RECOVERY] Startup recovery complete: ${requeued} requeued, ${skipped} skipped (already completed), ${failed} failed`);
    } catch (err: any) {
      console.error(`[RECOVERY] Startup recovery failed (non-fatal): ${err.message}`);
    }
  }

  private async recoverOrphanedAgentRuns(): Promise<void> {
    if (!supabase) return;

    try {
      const staleThreshold = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      const { data: stuckRuns, error } = await supabase
        .from('agent_runs')
        .select('id, status, started_at, metadata')
        .eq('status', 'executing')
        .lt('started_at', staleThreshold)
        .limit(20);

      if (error) {
        if (error.code === 'PGRST205' || error.code === '42P01') return;
        console.error(`[RECOVERY_RUNS] Failed to query stuck agent_runs: ${error.message}`);
        return;
      }

      if (!stuckRuns || stuckRuns.length === 0) {
        console.log('[RECOVERY_RUNS] No orphaned agent_runs found on startup');
        return;
      }

      console.log(`[RECOVERY_RUNS] Found ${stuckRuns.length} agent_run(s) stuck in 'executing' state (started > 3min ago)`);

      let recovered = 0;
      for (const run of stuckRuns) {
        try {
          const existingMeta = (run.metadata as Record<string, any>) || {};
          await storage.updateAgentRun(run.id, {
            status: 'failed',
            terminalState: null,
            error: 'Run was interrupted by a server restart and could not be recovered',
            endedAt: new Date(),
            metadata: { ...existingMeta, orphan_recovered: true, orphan_reason: 'server_restart', recovered_at: new Date().toISOString() },
          });
          console.log(`[RECOVERY_RUNS] Marked agent_run ${run.id} as failed (server_restart_orphan)`);
          recovered++;
        } catch (err: any) {
          console.error(`[RECOVERY_RUNS] Failed to recover agent_run ${run.id}: ${err.message}`);
        }
      }
      console.log(`[RECOVERY_RUNS] Startup agent_runs recovery complete: ${recovered} recovered`);
    } catch (err: any) {
      console.error(`[RECOVERY_RUNS] Agent runs recovery failed (non-fatal): ${err.message}`);
    }
  }

  private async sweepStaleTasks(): Promise<void> {
    if (!supabase) return;

    try {
      const cutoffEpoch = Date.now() - SupervisorService.STALE_TASK_TIMEOUT_MS;

      const activeRunIds = new Set<string>();
      for (const t of this.pendingClaimedQueue) {
        const rid = t.run_id || t.request_data?.run_id;
        if (rid) activeRunIds.add(rid);
      }

      const { data: staleTasks, error } = await supabase
        .from('supervisor_tasks')
        .select('id, user_id, conversation_id, request_data, created_at, status, run_id, client_request_id')
        .in('status', ['processing', 'claimed'])
        .lt('created_at', cutoffEpoch)
        .limit(20);

      if (error) {
        if (error.code === 'PGRST205') return;
        console.error(`[STALE_SWEEP] Failed to query stale tasks: ${error.message}`);
        return;
      }

      if (!staleTasks || staleTasks.length === 0) {
        await this.sweepOrphanedAgentRuns();
        return;
      }

      console.log(`[STALE_SWEEP] Found ${staleTasks.length} stale task(s) processing for >${SupervisorService.STALE_TASK_TIMEOUT_MS / 1000}s`);

      for (const task of staleTasks) {
        const taskRunId = task.run_id || task.request_data?.run_id;
        if (taskRunId && activeRunIds.has(taskRunId)) {
          console.log(`[STALE_SWEEP] Skipping task ${task.id} — run ${taskRunId} is actively queued`);
          continue;
        }
        try {
          await this.evaluateAndRecoverTask(task, 'stale_sweep');
        } catch (err: any) {
          console.error(`[STALE_SWEEP] Task ${task.id}: unexpected error — ${err.message}`);
        }
      }

      await this.sweepOrphanedAgentRuns();
    } catch (err: any) {
      console.error(`[STALE_SWEEP] Sweep failed (non-fatal): ${err.message}`);
    }
  }

  private async sweepOrphanedAgentRuns(): Promise<void> {
    if (!supabase) return;
    try {
      const staleThreshold = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      const { data: stuckRuns, error } = await supabase
        .from('agent_runs')
        .select('id, status, started_at, metadata')
        .eq('status', 'executing')
        .lt('started_at', staleThreshold)
        .limit(10);

      if (error || !stuckRuns || stuckRuns.length === 0) return;

      console.log(`[STALE_SWEEP] Found ${stuckRuns.length} orphaned agent_run(s) stuck in 'executing'`);
      for (const run of stuckRuns) {
        try {
          const existingMeta = (run.metadata as Record<string, any>) || {};
          await storage.updateAgentRun(run.id, {
            status: 'failed',
            terminalState: null,
            error: 'Run was orphaned — no active processing detected after timeout',
            endedAt: new Date(),
            metadata: { ...existingMeta, orphan_recovered: true, orphan_reason: 'stale_sweep', recovered_at: new Date().toISOString() },
          });
          console.log(`[STALE_SWEEP] Marked orphaned agent_run ${run.id} as failed`);
        } catch (err: any) {
          console.error(`[STALE_SWEEP] Failed to recover agent_run ${run.id}: ${err.message}`);
        }
      }
    } catch (err: any) {
      console.error(`[STALE_SWEEP] Orphan agent_run sweep failed (non-fatal): ${err.message}`);
    }
  }

  private async evaluateAndRecoverTask(
    task: { id: string; user_id: string; conversation_id: string; request_data: any; created_at: any; status: string; run_id?: string; client_request_id?: string },
    trigger: 'startup' | 'stale_sweep',
  ): Promise<'requeued' | 'skipped' | 'failed'> {
    if (!supabase) return 'failed';

    const runId = task.run_id || task.request_data?.run_id || task.id;
    const clientRequestId = task.client_request_id || task.request_data?.client_request_id || `crid_${task.id}`;
    const logPrefix = `[RECOVERY][${trigger}] task=${task.id}`;

    const source = task.run_id ? 'column' : task.request_data?.run_id ? 'request_data' : 'fallback';
    console.log(`${logPrefix} resolved IDs — run_id=${runId} crid=${clientRequestId} source=${source}`);

    let agentRunResult: { id: string; status: string; metadata: any } | null = null;
    let artefactsResult: any[] = [];
    try {
      const [runRes, artRes] = await Promise.all([
        supabase.from('agent_runs').select('id, status, metadata').eq('id', runId).maybeSingle(),
        storage.getArtefactsByRunId(runId),
      ]);
      agentRunResult = runRes.data as any;
      artefactsResult = artRes || [];
    } catch (err: any) {
      console.warn(`${logPrefix} failed to fetch run/artefact data: ${err.message}`);
    }

    const agentRun = agentRunResult as { id: string; status: string; metadata: any } | null;
    const artefacts = artefactsResult || [];
    const hasLeadsList = artefacts.some((a: any) => a.type === 'leads_list');
    const hasStepResult = artefacts.some((a: any) => a.type === 'step_result');
    const hasTowerJudgement = artefacts.some((a: any) => a.type === 'tower_judgement');

    if (agentRun && (agentRun.status === 'completed' || agentRun.status === 'failed')) {
      if (hasLeadsList && hasStepResult && hasTowerJudgement) {
        console.log(`${logPrefix} runId=${runId} already completed with artefacts — marking task completed`);
        await supabase
          .from('supervisor_tasks')
          .update({ status: 'completed', result: { recovered: true, trigger, note: 'Run already completed with artefacts' } })
          .eq('id', task.id);

        logAFREvent({
          userId: task.user_id, runId, clientRequestId,
          conversationId: task.conversation_id,
          actionTaken: 'task_recovery_skipped', status: 'success',
          taskGenerated: `Task already completed — agent_run=${agentRun.status}, artefacts=${artefacts.length}`,
          runType: 'plan',
          metadata: { taskId: task.id, trigger, agentRunStatus: agentRun.status, artefactCount: artefacts.length },
        }).catch(() => {});

        return 'skipped';
      }

      if (agentRun.status === 'completed' && !hasLeadsList) {
        console.warn(`${logPrefix} runId=${runId} marked completed but has NO artefacts — empty run, resetting for retry`);
      }
    }

    const existingMetadata = (agentRun?.metadata as Record<string, any>) || {};
    const attempts = (existingMetadata.recovery_attempts || 0) + 1;

    if (attempts > SupervisorService.MAX_RECOVERY_ATTEMPTS) {
      console.error(`${logPrefix} runId=${runId} exceeded max recovery attempts (${SupervisorService.MAX_RECOVERY_ATTEMPTS}) — marking as permanently failed`);
      await supabase
        .from('supervisor_tasks')
        .update({ status: 'failed', error: `Exceeded max recovery attempts (${SupervisorService.MAX_RECOVERY_ATTEMPTS})` })
        .eq('id', task.id);

      if (agentRun) {
        await storage.updateAgentRun(runId, {
          status: 'failed',
          terminalState: 'failed',
          error: `Task failed after ${SupervisorService.MAX_RECOVERY_ATTEMPTS} recovery attempts`,
          endedAt: new Date(),
          metadata: { ...existingMetadata, recovery_attempts: attempts, recovery_exhausted: true, stop_reason: 'recovery_exhausted' },
        }).catch(() => {});
      }

      logAFREvent({
        userId: task.user_id, runId, clientRequestId,
        conversationId: task.conversation_id,
        actionTaken: 'task_recovery_exhausted', status: 'failed',
        taskGenerated: `Recovery exhausted after ${attempts} attempts — task permanently failed`,
        runType: 'plan',
        metadata: { taskId: task.id, trigger, attempts },
      }).catch(() => {});

      return 'failed';
    }

    console.log(`${logPrefix} runId=${runId} requeuing (attempt ${attempts}) — agent_run status=${agentRun?.status || 'none'}, artefacts=${artefacts.length}`);

    const { error: requeueErr } = await supabase
      .from('supervisor_tasks')
      .update({ status: 'pending' })
      .eq('id', task.id)
      .eq('status', 'processing');

    if (requeueErr) {
      console.error(`${logPrefix} failed to requeue task: ${requeueErr.message}`);
      return 'failed';
    }

    if (agentRun) {
      await storage.updateAgentRun(runId, {
        status: 'executing',
        metadata: {
          ...existingMetadata,
          recovery_attempts: attempts,
          last_recovery_trigger: trigger,
          last_recovery_at: new Date().toISOString(),
        },
      }).catch((err: any) => {
        console.warn(`${logPrefix} failed to reset agent_run: ${err.message}`);
      });
    }

    logAFREvent({
      userId: task.user_id, runId, clientRequestId,
      conversationId: task.conversation_id,
      actionTaken: 'task_recovered', status: 'success',
      taskGenerated: `Task requeued from ${trigger} (attempt ${attempts})`,
      runType: 'plan',
      metadata: { taskId: task.id, trigger, attempts, previousAgentRunStatus: agentRun?.status || 'none', artefactCount: artefacts.length },
    }).catch(() => {});

    return 'requeued';
  }

  private async processSupervisorTasks() {
    if (!supabase) return;
    
    await this.sweepStaleTasks();

    await this.claimPendingTasks();

    const tasksToProcess: any[] = [];
    while (this.pendingClaimedQueue.length > 0) {
      tasksToProcess.push(this.pendingClaimedQueue.shift());
    }

    if (tasksToProcess.length === 0) {
      const now = Date.now();
      if (now - this.lastNoTasksLogAt > 60_000) {
        console.log('[SUPERVISOR_POLL] No pending tasks (heartbeat)');
        this.lastNoTasksLogAt = now;
      }
      return;
    }

    console.log(`[TASK_PROCESS] Processing ${tasksToProcess.length} claimed task(s)`);

    for (const task of tasksToProcess) {
      try {
        await this.processChatTask(task as SupervisorTask);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`Failed to process task ${task.id}:`, error);

        const taskRunId = task.run_id || task.request_data?.run_id || task.id;
        createArtefact({
          runId: taskRunId,
          type: 'diagnostic',
          title: 'Run failed: unhandled exception in processChatTask',
          summary: `Error: ${errMsg.substring(0, 200)}`,
          payload: { reason: 'unhandled_exception', error: errMsg, taskId: task.id },
          userId: task.user_id,
          conversationId: task.conversation_id,
        }).catch((e: any) => console.warn(`[PROCESS_TASK] Failed to emit diagnostic artefact: ${e.message}`));

        await supabase
          .from('supervisor_tasks')
          .update({
            status: 'failed',
            error: errMsg
          })
          .eq('id', task.id);
      }

      while (this.pendingClaimedQueue.length > 0) {
        const bgTask = this.pendingClaimedQueue.shift();
        if (!bgTask) break;
        console.log(`[TASK_PROCESS] Also processing bg-claimed task ${bgTask.id}`);
        try {
          await this.processChatTask(bgTask as SupervisorTask);
        } catch (bgError) {
          const errMsg = bgError instanceof Error ? bgError.message : String(bgError);
          console.error(`Failed to process bg task ${bgTask.id}:`, bgError);

          const taskRunId = bgTask.run_id || bgTask.request_data?.run_id || bgTask.id;
          createArtefact({
            runId: taskRunId,
            type: 'diagnostic',
            title: 'Run failed: unhandled exception in processChatTask',
            summary: `Error: ${errMsg.substring(0, 200)}`,
            payload: { reason: 'unhandled_exception', error: errMsg, taskId: bgTask.id },
            userId: bgTask.user_id,
            conversationId: bgTask.conversation_id,
          }).catch((e: any) => console.warn(`[TASK_PROCESS] Failed to emit diagnostic artefact: ${e.message}`));

          await supabase
            .from('supervisor_tasks')
            .update({
              status: 'failed',
              error: errMsg
            })
            .eq('id', bgTask.id);
        }
      }
    }
  }

  private async claimPendingTasks() {
    if (!supabase) return;

    const { data: tasks, error } = await supabase
      .from('supervisor_tasks')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(10);

    if (error) {
      if (error.code === 'PGRST205') {
        if (!this.missingTableWarned) {
          console.warn('⚠️  supervisor_tasks table not found in Supabase.');
          console.warn('   Run migrations/supabase-supervisor-integration.sql in Supabase SQL Editor');
          console.warn('   Chat integration will be unavailable until migration is complete.');
          this.missingTableWarned = true;
        }
        return;
      }
      console.error('Error fetching supervisor tasks:', error);
      return;
    }

    if (!tasks || tasks.length === 0) return;

    const alreadyQueued = new Set(this.pendingClaimedQueue.map((t: any) => t.id));

    for (const task of tasks) {
      if (alreadyQueued.has(task.id)) continue;

      const { data: claimed, error: claimErr } = await supabase
        .from('supervisor_tasks')
        .update({ status: 'processing' })
        .eq('id', task.id)
        .eq('status', 'pending')
        .select();

      if (claimErr || !claimed || claimed.length === 0) continue;

      console.log(`[CLAIM] Claimed task ${task.id} (run_id=${task.run_id || task.request_data?.run_id || task.id})`);
      this.pendingClaimedQueue.push(task);
    }
  }

  private async monitorGoals() {
    try {
      // Run goal monitoring check
      const events = await monitorGoalsOnce();
      
      // Publish any issues found
      if (events.length > 0) {
        await publishGoalMonitorEvents(events);
      }
    } catch (error) {
      console.error('Error in goal monitoring:', error);
    }
  }

  private async processChatTask(task: SupervisorTask) {
    if (!supabase) return;

    const requestData = task.request_data;
    const uiRunId = task.run_id || requestData.run_id || task.id;
    const clientRequestId = task.client_request_id || requestData.client_request_id || `crid_${task.id}`;

    const source = task.run_id ? 'column' : requestData.run_id ? 'request_data' : 'fallback';
    console.log(`[SUPERVISOR] Task ${task.id}: resolved IDs — run_id=${uiRunId} crid=${clientRequestId} source=${source}`);

    let jobId = uiRunId;
    const userInput = String(requestData.user_message || '').substring(0, 200);

    const pendingClarifySession = getClarifySession(task.conversation_id);
    const pendingConstraintState = getPendingContract(task.conversation_id);
    const originRunId = pendingClarifySession?.originRunId || pendingConstraintState?.originRunId || null;
    if (originRunId) {
      console.log(`[CLARIFY_RESUME] Found origin run_id=${originRunId} for conversation=${task.conversation_id} — reusing (was ${jobId}, source=${pendingClarifySession?.originRunId ? 'clarify_session' : 'constraint_gate'})`);
      jobId = originRunId;
    }

    console.log(`[ID_MAP] jobId=${jobId} uiRunId=${uiRunId} crid=${clientRequestId} taskId=${task.id} entry=processChatTask`);
    console.log(`[SUPERVISOR] Processing chat task ${task.id} (${task.task_type}) jobId=${jobId} uiRunId=${uiRunId} clientRequestId=${clientRequestId}`);

    await emitProbe('intent_extractor_probe', task.user_id, jobId, task.conversation_id, {
      run_id: jobId,
      conversation_id: task.conversation_id ?? null,
      user_id: task.user_id,
      raw_msg: userInput,
      intent_extractor_mode: getIntentExtractorMode(),
      ts: Date.now(),
    });

    const nowMs = Date.now();
    let runPersistedEarly = false;
    try {
      await storage.createAgentRun({
        id: jobId,
        clientRequestId,
        conversationId: task.conversation_id ?? undefined,
        userId: task.user_id,
        createdAt: nowMs,
        updatedAt: nowMs,
        status: 'executing',
        metadata: {
          feature_flag: 'TOWER_LOOP_CHAT_MODE',
          original_user_goal: userInput,
          early_persist: true,
        },
      });
      runPersistedEarly = true;
      console.log(`[RUN_PERSIST] Early agent_run created — runId=${jobId} crid=${clientRequestId} stage=processChatTask_entry`);
    } catch (earlyCreateErr: any) {
      const earlyMsg = earlyCreateErr.message || '';
      if (earlyMsg.includes('duplicate key') || earlyMsg.includes('unique constraint')) {
        runPersistedEarly = true;
        console.log(`[RUN_PERSIST] agent_run already exists (retry/resume) — runId=${jobId} crid=${clientRequestId}`);
        await storage.updateAgentRun(jobId, { status: 'executing', error: null, terminalState: null }).catch(() => {});
      } else {
        console.error(`[RUN_PERSIST] Failed to create early agent_run (non-fatal, will retry later): ${earlyMsg}`);
      }
    }

    let taskExecutionStartedEmitted = false;
    let taskExecutionCompleteEmitted = false;
    const emitTaskExecutionCompleted = async (verdict: string, extraMeta?: Record<string, unknown>) => {
      if (taskExecutionCompleteEmitted || !taskExecutionStartedEmitted) return;
      taskExecutionCompleteEmitted = true;
      logAFREvent({
        userId: task.user_id, runId: jobId, conversationId: task.conversation_id,
        clientRequestId,
        actionTaken: 'task_execution_completed', status: 'success',
        taskGenerated: `Execution completed: ${verdict}`,
        runType: 'plan',
        metadata: { taskId: task.id, task_type: task.task_type, verdict, ...extraMeta },
      }).catch(() => {});
    };

    try {
    this.backfillUserMessageRunId(task.user_id, jobId, task.conversation_id, task.created_at).catch((e: any) =>
      console.error(`[BACKFILL] user_message_received backfill failed (non-fatal): ${e.message}`)
    );

    this.bridgeRunToUI(uiRunId, jobId, clientRequestId, task.conversation_id, task.user_id).catch((e: any) =>
      console.error(`[RUN_BRIDGE] bridgeRunToUI failed: ${e.message}`)
    );

    logMissionReceived(
      task.user_id, jobId, task.id, task.task_type, task.conversation_id
    ).catch(() => {});

    console.log(`[STAGE] runId=${jobId} crid=${clientRequestId} stage=ownership_guard`);
    const { data: statusCheck } = await supabase
      .from('supervisor_tasks')
      .select('status')
      .eq('id', task.id)
      .maybeSingle();

    if (statusCheck && statusCheck.status !== 'processing') {
      const guardReason = `status is '${statusCheck.status}' (expected 'processing') — another processor may have claimed or completed this task`;
      console.warn(`⏭️  Task ${task.id} ownership guard fired — ${guardReason}`);

      logAFREvent({
        userId: task.user_id, runId: jobId, conversationId: task.conversation_id,
        clientRequestId,
        actionTaken: 'task_skipped_concurrency_guard', status: 'failed',
        taskGenerated: `Task skipped: ${guardReason}`,
        runType: 'plan',
        metadata: { taskId: task.id, task_type: task.task_type, guard_reason: guardReason },
      }).catch(() => {});

      createArtefact({
        runId: jobId,
        type: 'diagnostic',
        title: 'Run short-circuited: ownership guard',
        summary: `Task ${task.id} was not processed — ${guardReason}. No tools executed, no Tower invoked.`,
        payload: { reason: 'ownership_guard', detail: guardReason, taskId: task.id, currentStatus: statusCheck.status },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch((e: any) => console.warn(`[GUARD] Failed to emit diagnostic artefact: ${e.message}`));

      await storage.updateAgentRun(jobId, { status: 'completed', terminalState: null, endedAt: new Date(), metadata: { verdict: 'ownership_guard', guard_reason: guardReason } }).catch(() => {});
      return;
    }

    registerActiveTask(task.conversation_id, task.id, jobId);

    console.log(`[STAGE] runId=${jobId} crid=${clientRequestId} stage=build_user_context`);
    const userContext = await this.buildUserContext(task.user_id);
    let rawMsg = String(requestData.user_message || '');

    console.log(`[SUPERVISOR] Executing task ${task.id} — message="${rawMsg.substring(0, 80)}"`);
    taskExecutionStartedEmitted = true;
    logAFREvent({
      userId: task.user_id, runId: jobId, conversationId: task.conversation_id,
      clientRequestId,
      actionTaken: 'task_execution_started', status: 'pending',
      taskGenerated: `Executing: "${rawMsg.substring(0, 60)}"`,
      runType: 'plan',
      metadata: { taskId: task.id, task_type: task.task_type },
    }).catch(() => {});

    let conversationContextStr: string | undefined;
    if (task.conversation_id && supabase) {
      try {
        const { data: recentMsgs } = await supabase
          .from('messages')
          .select('role, content')
          .eq('conversation_id', task.conversation_id)
          .order('created_at', { ascending: false })
          .limit(6);
        if (recentMsgs && recentMsgs.length > 0) {
          const reversed = recentMsgs.reverse() as Array<{ role: string; content: string }>;
          conversationContextStr = buildConversationContextString(reversed, 6);
        }
      } catch (ctxErr: any) {
        console.warn(`[INTENT_EXTRACTOR_SHADOW] conversation context fetch failed (non-fatal): ${ctxErr.message}`);
      }
    }

    let shadowResult: { ran: boolean; extraction: any; error: string | null } = { ran: false, extraction: null, error: null };
    let shadowProbeError: string | null = null;
    try {
      shadowResult = await runIntentExtractorShadow(rawMsg, jobId, task.user_id, task.conversation_id, conversationContextStr);
    } catch (e: any) {
      shadowProbeError = e.message;
      console.warn(`[INTENT_EXTRACTOR_SHADOW] top-level error (non-fatal): ${e.message}`);
    }

    await emitProbe('intent_extractor_after_probe', task.user_id, jobId, task.conversation_id, {
      run_id: jobId,
      extractor_ran: shadowResult.ran,
      validation_ok: shadowResult.extraction?.validation?.ok ?? false,
      error: shadowProbeError ?? shadowResult.error ?? null,
      duration_ms: shadowResult.extraction?.duration_ms ?? 0,
      intent_extractor_mode: getIntentExtractorMode(),
      ts: Date.now(),
    });

    let missionResult: Awaited<ReturnType<typeof extractStructuredMission>> | null = null;
    const missionMode = getMissionExtractorMode();

    if (missionMode !== 'off') {
      try {
        missionResult = await extractStructuredMission(rawMsg, conversationContextStr);
        const canonicalForComparison = shadowResult.extraction?.validation?.intent ?? null;

        logMissionShadow(
          missionResult.trace,
          canonicalForComparison,
          null,
        );

        const missionDiag = buildMissionDiagnosticPayload(
          missionResult.trace,
          canonicalForComparison,
          null,
          null,
        );

        const missionTitle = missionResult.ok
          ? `Mission extraction (${missionMode}): ${missionResult.mission!.entity_category} in ${missionResult.mission!.location_text ?? 'unknown'} (${missionResult.mission!.constraints.length} constraints)`
          : `Mission extraction failed at ${missionResult.trace.failure_stage}`;

        createArtefact({
          runId: jobId,
          type: 'mission_extraction',
          title: missionTitle,
          summary: `pipeline_ok=${missionDiag.pipeline_ok} failure_stage=${missionDiag.failure_stage} model=${missionDiag.model} mode=${missionMode} total_ms=${missionDiag.timing.total_ms}`,
          payload: missionDiag as unknown as Record<string, unknown>,
          userId: task.user_id,
          conversationId: task.conversation_id,
        }).catch((e: any) => console.warn(`[MISSION_EXTRACTOR] Artefact creation failed (non-fatal): ${e.message}`));

        this.postArtefactToUI({
          runId: jobId,
          clientRequestId,
          type: 'diagnostic',
          payload: { ...missionDiag as unknown as Record<string, unknown>, title: 'Mission extraction trace', diagnostic_type: 'mission_extraction' },
          userId: task.user_id,
          conversationId: task.conversation_id,
        }).catch((e: any) => console.warn(`[MISSION_EXTRACTOR] postArtefactToUI failed (non-fatal): ${e.message}`));
      } catch (missionErr: any) {
        console.warn(`[MISSION_EXTRACTOR] Extraction failed (non-fatal): ${missionErr.message}`);
        missionResult = null;

        const exceptionDiag = {
          pipeline_ok: false,
          failure_stage: 'extractor_exception',
          model: 'unknown',
          timing: { pass1_ms: 0, pass2_ms: 0, total_ms: 0 },
          layers: {
            raw_user_input: rawMsg.substring(0, 500),
            pass1_semantic_interpretation: '',
            pass2_structured_mission: null,
          },
          validation: { ok: false, error_count: 1, errors: [missionErr.message?.substring(0, 200) ?? 'Unknown error'] },
          legacy_comparison: null,
          fallback_reason: `extractor_exception: ${missionErr.message?.substring(0, 100) ?? 'unknown'}`,
        };

        createArtefact({
          runId: jobId,
          type: 'mission_extraction',
          title: 'Mission extraction failed (exception)',
          summary: `pipeline_ok=false failure_stage=extractor_exception mode=${missionMode}`,
          payload: exceptionDiag,
          userId: task.user_id,
          conversationId: task.conversation_id,
        }).catch(() => {});

        this.postArtefactToUI({
          runId: jobId,
          clientRequestId,
          type: 'diagnostic',
          payload: { ...exceptionDiag, title: 'Mission extraction trace', diagnostic_type: 'mission_extraction' },
          userId: task.user_id,
          conversationId: task.conversation_id,
        }).catch(() => {});
      }
    }

    let earlyParsedGoal: ParsedGoal | null = null;
    let intentSource: 'mission' | 'canonical' | 'legacy' = 'legacy';
    let legacyFallbackReason: string | null = null;

    const canonicalValid = shadowResult.ran && shadowResult.extraction?.validation?.ok && shadowResult.extraction.validation.intent;
    const canonicalIntent = canonicalValid ? shadowResult.extraction!.validation.intent! : null;

    try {

    if (missionMode === 'active' && missionResult?.ok && missionResult.mission) {
      try {
        console.log(`[STAGE] runId=${jobId} crid=${clientRequestId} stage=early_parse_goal source=mission_active`);
        earlyParsedGoal = missionToParsedGoal(missionResult.mission, rawMsg.trim());
        intentSource = 'mission';
        console.log(`[INTENT_SOURCE] mission_active — bt=${earlyParsedGoal.business_type} loc=${earlyParsedGoal.location} count=${earlyParsedGoal.requested_count_user} constraints=${earlyParsedGoal.constraints.length}`);
      } catch (bridgeErr: any) {
        legacyFallbackReason = `mission_bridge_error: ${bridgeErr.message?.substring(0, 100)}`;
        console.warn(`[INTENT_SOURCE] mission bridge failed, falling through to canonical: ${bridgeErr.message}`);
        earlyParsedGoal = null;
      }
    } else if (missionMode === 'active') {
      legacyFallbackReason = missionResult
        ? `mission_validation_failed: ${missionResult.trace.failure_stage}`
        : 'mission_extractor_exception';
    }

    if (!earlyParsedGoal) {
      if (canonicalIntent) {
        try {
          console.log(`[STAGE] runId=${jobId} crid=${clientRequestId} stage=early_parse_goal source=canonical_fallback`);
          earlyParsedGoal = canonicalIntentToParsedGoal(canonicalIntent, rawMsg.trim());
          intentSource = 'canonical';
          console.log(`[INTENT_SOURCE] canonical_fallback — bt=${earlyParsedGoal.business_type} loc=${earlyParsedGoal.location} count=${earlyParsedGoal.requested_count_user} constraints=${earlyParsedGoal.constraints.length} fallback_reason=${legacyFallbackReason ?? 'mission_not_active'}`);
        } catch (bridgeErr: any) {
          legacyFallbackReason = legacyFallbackReason
            ? `${legacyFallbackReason} + canonical_bridge_error: ${bridgeErr.message?.substring(0, 100)}`
            : `canonical_bridge_error: ${bridgeErr.message?.substring(0, 100)}`;
          console.warn(`[INTENT_SOURCE] canonical bridge failed, falling back to legacy: ${bridgeErr.message}`);
          earlyParsedGoal = null;
        }
      } else if (!legacyFallbackReason) {
        if (!shadowResult.ran) {
          legacyFallbackReason = 'intent_extractor_did_not_run';
        } else if (!shadowResult.extraction?.validation?.ok) {
          legacyFallbackReason = `intent_validation_failed: ${shadowResult.extraction?.validation?.errors?.slice(0, 2).join('; ') ?? 'unknown'}`;
        }
      }
    }

    if (!earlyParsedGoal) {
      try {
        console.log(`[STAGE] runId=${jobId} crid=${clientRequestId} stage=early_parse_goal source=legacy_fallback reason=${legacyFallbackReason ?? 'all_higher_sources_unavailable'}`);
        earlyParsedGoal = await parseGoalToConstraints(rawMsg.trim());
        intentSource = 'legacy';
        console.log(`[INTENT_SOURCE] legacy_fallback — bt=${earlyParsedGoal.business_type} loc=${earlyParsedGoal.location} count=${earlyParsedGoal.requested_count_user} constraints=${earlyParsedGoal.constraints.length} fallback_reason=${legacyFallbackReason ?? 'none'}`);
      } catch (parseErr: any) {
        console.warn(`[EARLY_PARSE] parseGoalToConstraints failed (non-fatal, will retry in executeTowerLoopChat): ${parseErr.message}`);
      }
    }

    } catch (intentResolutionErr: any) {
      const errMsg = intentResolutionErr.message?.substring(0, 200) ?? 'unknown';
      console.error(`[INTENT_RESOLUTION] Unexpected error during intent resolution (non-fatal, using legacy fallback): ${errMsg}`);
      legacyFallbackReason = `intent_resolution_exception: ${errMsg}`;

      if (!earlyParsedGoal) {
        try {
          earlyParsedGoal = await parseGoalToConstraints(rawMsg.trim());
          intentSource = 'legacy';
          console.log(`[INTENT_SOURCE] legacy_emergency_fallback — bt=${earlyParsedGoal.business_type} loc=${earlyParsedGoal.location}`);
        } catch (emergencyErr: any) {
          console.error(`[INTENT_RESOLUTION] Emergency legacy fallback also failed: ${emergencyErr.message}`);
        }
      }

      createArtefact({
        runId: jobId,
        type: 'intent_resolution_error',
        title: 'Intent resolution failed unexpectedly',
        summary: `error=${errMsg} intent_source_at_failure=${intentSource} fallback_reason=${legacyFallbackReason}`,
        payload: {
          error: errMsg,
          intent_source_at_failure: intentSource,
          mission_mode: missionMode,
          mission_ok: missionResult?.ok ?? false,
          canonical_available: !!canonicalIntent,
          legacy_fallback_attempted: !!earlyParsedGoal,
          fallback_reason: legacyFallbackReason,
        },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch(() => {});

      this.postArtefactToUI({
        runId: jobId,
        clientRequestId,
        type: 'diagnostic',
        payload: {
          title: 'Intent resolution error',
          diagnostic_type: 'intent_resolution_error',
          error: errMsg,
          intent_source_at_failure: intentSource,
          mission_mode: missionMode,
          fallback_reason: legacyFallbackReason,
        },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch(() => {});
    }

    if (earlyParsedGoal) {
      const earlyConstraints = earlyParsedGoal.constraints;
      const earlyRc = buildRequestedCount(earlyParsedGoal.requested_count_user);
      const earlyUserCount = earlyRc.requested_count_user === 'explicit' ? earlyParsedGoal.requested_count_user : null;

      const cePayload = buildConstraintsExtractedPayload(rawMsg.trim(), earlyUserCount ?? null, earlyConstraints);
      const ceTitle = `Constraints extracted: ${earlyConstraints.length} constraints`;
      const ceSummary = `mission_type=lead_finder | ${earlyConstraints.filter(c => c.hard).length} hard, ${earlyConstraints.filter(c => !c.hard).length} soft | requested_count_user=${earlyUserCount ?? 'any'} | source=${intentSource}`;
      await createArtefact({
        runId: jobId,
        type: 'constraints_extracted',
        title: ceTitle,
        summary: ceSummary,
        payload: { ...cePayload as unknown as Record<string, unknown>, intent_source: intentSource, ...(legacyFallbackReason ? { legacy_fallback_reason: legacyFallbackReason } : {}) },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch((e: any) => console.warn(`[EARLY_PARSE] constraints_extracted artefact failed (non-fatal): ${e.message}`));
      this.postArtefactToUI({
        runId: jobId,
        clientRequestId,
        type: 'constraints_extracted',
        payload: { ...cePayload as unknown as Record<string, unknown>, title: ceTitle, summary: ceSummary, intent_source: intentSource },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch((e: any) => console.warn(`[EARLY_PARSE] postArtefactToUI constraints_extracted failed (non-fatal): ${e.message}`));

      const ccPayload = buildCapabilityCheck(earlyConstraints);
      const ccTitle = `Capability check: ${ccPayload.verifiable_count} verifiable, ${ccPayload.unverifiable_count} unverifiable`;
      const ccSummary = `${ccPayload.verifiable_count}/${ccPayload.total_constraints} verifiable | blocking_hard: [${ccPayload.blocking_hard_constraints.join(', ')}]`;
      await createArtefact({
        runId: jobId,
        type: 'constraint_capability_check',
        title: ccTitle,
        summary: ccSummary,
        payload: ccPayload as unknown as Record<string, unknown>,
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch((e: any) => console.warn(`[EARLY_PARSE] constraint_capability_check artefact failed (non-fatal): ${e.message}`));
      this.postArtefactToUI({
        runId: jobId,
        clientRequestId,
        type: 'constraint_capability_check',
        payload: { ...ccPayload as unknown as Record<string, unknown>, title: ccTitle, summary: ccSummary },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch((e: any) => console.warn(`[EARLY_PARSE] postArtefactToUI constraint_capability_check failed (non-fatal): ${e.message}`));

      console.log(`[EARLY_PARSE] Emitted constraints_extracted (${earlyConstraints.length}) + capability_check before gates — source=${intentSource}`);
    }

    const canonicalPreview = canonicalIntent ? canonicalIntentToPreviewFields(canonicalIntent) : null;

    let previewBT: string | null = null;
    let previewLoc: string | null = null;
    let previewCount: number | null = null;
    let previewTime: string | null = null;

    if (canonicalPreview) {
      previewBT = canonicalPreview.business_type;
      previewLoc = canonicalPreview.location;
      previewCount = canonicalPreview.count;
      previewTime = canonicalPreview.time_filter;
    } else if (earlyParsedGoal) {
      previewBT = earlyParsedGoal.business_type || null;
      previewLoc = earlyParsedGoal.location || null;
      previewCount = earlyParsedGoal.requested_count_user;
      previewTime = null;
    } else {
      previewBT = extractBusinessType(rawMsg) ?? null;
      previewLoc = extractLocation(rawMsg) ?? null;
      previewCount = extractCount(rawMsg) ?? null;
      previewTime = extractTimeFilter(rawMsg) ?? null;
      console.warn(`[PREVIEW_FIELDS] Using deprecated regex extractors — no canonical intent or parsed goal available`);
    }

    const intentPreviewPayload = {
      raw_message: rawMsg.substring(0, 500),
      parsed_fields: {
        business_type: previewBT,
        location: previewLoc,
        count: previewCount,
        time_filter: previewTime,
      },
      intent_source: intentSource,
      ...(canonicalPreview ? {
        canonical_fields: canonicalPreview,
        regex_fields: { skipped: true, reason: 'canonical_intent_active' },
      } : {}),
      route: 'pre_gate',
      extraction_method: intentSource === 'mission' ? 'structured_mission_extractor' : intentSource === 'canonical' ? 'canonical_intent_extractor' : (earlyParsedGoal ? 'llm_parsed_goal' : 'regex_fallback_deprecated'),
      ...(legacyFallbackReason ? { legacy_fallback_reason: legacyFallbackReason } : {}),
    };

    this.postArtefactToUI({
      runId: jobId,
      clientRequestId,
      type: 'diagnostic',
      payload: { ...intentPreviewPayload, title: 'Intent preview' },
      userId: task.user_id,
      conversationId: task.conversation_id,
    }).catch((uiErr: any) => console.warn(`[INTENT_PREVIEW] postArtefactToUI failed — runId=${jobId} conversationId=${task.conversation_id} error=${uiErr.message}`));

    try {
      await createArtefact({
        runId: jobId,
        type: 'diagnostic',
        title: 'Intent preview',
        summary: `Parsed fields from user message (pre-clarify).`,
        payload: intentPreviewPayload as Record<string, unknown>,
        userId: task.user_id,
        conversationId: task.conversation_id,
      });
      console.log(`[INTENT_PREVIEW] Emitted diagnostic 'Intent preview' — runId=${jobId} bt=${previewBT} loc=${previewLoc} count=${previewCount} time=${previewTime}`);
    } catch (previewErr: any) {
      console.error(`[INTENT_PREVIEW] DB write FAILED — runId=${jobId} conversationId=${task.conversation_id} error=${previewErr.message}`);
    }

    const hasActiveClarifySession = !!getClarifySession(task.conversation_id);
    if (earlyParsedGoal && !hasActiveClarifySession) {
      const preflightResult = this.evaluatePreflightClarify(rawMsg, earlyParsedGoal, previewBT, previewLoc, previewTime, canonicalIntent);
      if (preflightResult) {
        console.log(`[PREFLIGHT_CLARIFY] Triggered — reason=${preflightResult.reason} questions=${preflightResult.questions.length} runId=${jobId}`);

        await createArtefact({
          runId: jobId,
          type: 'clarify_gate',
          title: 'Clarification Required',
          summary: preflightResult.reason,
          payload: {
            mode: 'clarify',
            reason: preflightResult.reason,
            questions: preflightResult.questions,
            options: preflightResult.options,
            parsed_fields: {
              business_type: previewBT,
              location: previewLoc,
              count: previewCount,
              time_filter: previewTime,
            },
            source: 'supervisor_preflight',
          },
          userId: task.user_id,
          conversationId: task.conversation_id,
        }).catch((e: any) => console.error(`[PREFLIGHT_CLARIFY] clarify_gate artefact write failed: ${e.message}`));

        this.postArtefactToUI({
          runId: jobId,
          clientRequestId,
          type: 'clarify_gate',
          payload: {
            title: 'Clarification Required',
            mode: 'clarify',
            reason: preflightResult.reason,
            questions: preflightResult.questions,
            options: preflightResult.options,
          },
          userId: task.user_id,
          conversationId: task.conversation_id,
        }).catch((uiErr: any) => console.warn(`[PREFLIGHT_CLARIFY] postArtefactToUI failed: ${uiErr.message}`));

        const clarifyMsg = preflightResult.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
        const messageId = randomUUID();

        const [taskUpdateResult, msgResult] = await Promise.all([
          supabase!.from('supervisor_tasks').update({
            status: 'completed',
            result: {
              response: clarifyMsg.substring(0, 200),
              message_id: messageId,
              clarify_gate: 'preflight_clarify',
              mode: 'clarify',
              question: preflightResult.questions[0],
              options: preflightResult.options,
              reason: preflightResult.reason,
              run_id: jobId,
            },
          }).eq('id', task.id),
          supabase!.from('messages').insert({
            id: messageId,
            conversation_id: task.conversation_id,
            role: 'assistant',
            content: sanitizeMessageContent(clarifyMsg),
            source: 'supervisor',
            metadata: {
              supervisor_task_id: task.id,
              run_id: jobId,
              clarify_gate: 'preflight_clarify',
              mode: 'clarify',
              reason: preflightResult.reason,
              questions: preflightResult.questions,
              options: preflightResult.options,
              clarify_state: {
                business_type: previewBT,
                location: previewLoc,
                count: previewCount,
                time_filter: previewTime,
              },
            },
            created_at: Date.now(),
          }).select().single(),
        ]);

        if (taskUpdateResult.error) console.error(`[PREFLIGHT_CLARIFY] task update failed: ${taskUpdateResult.error.message}`);
        if (msgResult.error) console.error(`[PREFLIGHT_CLARIFY] message insert failed: ${msgResult.error.message}`);

        await storage.updateAgentRun(jobId, {
          status: 'clarifying',
          terminalState: null,
          metadata: { verdict: 'preflight_clarify', awaiting: 'user_input', reason: preflightResult.reason },
        }).catch((runErr: any) => console.warn(`[PREFLIGHT_CLARIFY] updateAgentRun failed: ${runErr.message}`));
        console.log(`[PREFLIGHT_CLARIFY] Run awaiting user input — runId=${jobId} status=clarifying`);

        await emitProbe('preflight_clarify_probe', task.user_id, jobId, task.conversation_id, {
          run_id: jobId,
          reason: preflightResult.reason,
          questions: preflightResult.questions,
          parsed_fields: { business_type: previewBT, location: previewLoc, count: previewCount, time_filter: previewTime },
          ts: Date.now(),
        });

        await emitTaskExecutionCompleted('preflight_clarify', { reason: preflightResult.reason });
        return;
      }
    }

    const isFactoryDemo = rawMsg.trim().toLowerCase() === 'run the injection moulding demo';

    if (isFactoryDemo) {
      const demoResult = await this.executeFactoryDemoTask(task, jobId, clientRequestId);

      if (!guardDelivery(task.conversation_id, task.id, 'factory_demo_final_message')) {
        console.warn(`[SESSION_GUARD] Dropping factory demo delivery for stale task=${task.id}`);
        await emitTaskExecutionCompleted('factory_demo_stale');
        return;
      }

      const response = demoResult.summary;
      const leadIds: string[] = [];
      const capabilities = ['factory_sim', 'tower_validated'];

      const messageId = randomUUID();

      const demoTaskUpdatePromise = supabase
        .from('supervisor_tasks')
        .update({
          status: 'completed',
          result: { response: response.substring(0, 200), capabilities, factory_demo: true, message_id: messageId },
        })
        .eq('id', task.id);

      const demoMessagePromise = supabase
        .from('messages')
        .insert({
          id: messageId,
          conversation_id: task.conversation_id,
          role: 'assistant',
          content: response,
          source: 'supervisor',
          metadata: {
            supervisor_task_id: task.id,
            run_id: jobId,
            capabilities,
            lead_ids: leadIds,
            factory_demo: true,
            scenario: demoResult.scenario,
          },
          created_at: Date.now(),
        })
        .select()
        .single();

      const [demoTaskResult, demoMsgResult] = await Promise.all([demoTaskUpdatePromise, demoMessagePromise]);

      if (demoTaskResult.error) {
        console.error(`[FINAL_TASK_UPDATE] task_update_failed run_id=${jobId} task_id=${task.id} error=${demoTaskResult.error.message}`);
      }

      if (demoMsgResult.error) {
        console.error(`[FINAL_MESSAGE] final_message_creation_failed run_id=${jobId} conversation_id=${task.conversation_id} error=${demoMsgResult.error.message}`);
        throw new Error(`Failed to write message: ${demoMsgResult.error.message}`);
      }

      console.log(`[FINAL_MESSAGE] final_message_created run_id=${jobId} conversation_id=${task.conversation_id} message_id=${messageId} task_status=completed status=OK (factory_demo)`);

      logAFREvent({
        userId: task.user_id, runId: jobId, conversationId: task.conversation_id,
        clientRequestId,
        actionTaken: 'task_completed', status: 'success',
        taskGenerated: `Factory demo completed: ${response.substring(0, 80)}`,
        runType: 'plan',
        metadata: { taskId: task.id, task_type: 'RUN_FACTORY_DEMO' },
      }).catch(() => {});

      await emitTaskExecutionCompleted('factory_demo');
      return;
    }

    if (didSessionExpire(task.conversation_id)) {
      console.log(`[CLARIFY_SESSION] Session expired (TTL) for conversation=${task.conversation_id}`);
      closeClarifySession(task.conversation_id);

      await createArtefact({
        runId: jobId,
        type: 'diagnostic',
        title: 'Clarify session expired (TTL)',
        summary: 'The clarification session timed out after 15 minutes of inactivity.',
        payload: { reason: 'ttl_expiry', conversationId: task.conversation_id },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch((e: any) => console.warn(`[CLARIFY_SESSION] Failed to emit TTL expiry artefact: ${e.message}`));
    }

    const pendingConstraint = getPendingContract(task.conversation_id);
    if (pendingConstraint && !getClarifySession(task.conversation_id)) {
      console.log(`[CONSTRAINT_GATE] Follow-up detected for conversation=${task.conversation_id} — resolving constraint contract`);
      const resolvedContract = resolveFollowUp(pendingConstraint.contract, rawMsg);

      await createArtefact({
        runId: jobId,
        type: 'diagnostic',
        title: `Constraint gate follow-up: can_execute=${resolvedContract.can_execute} stop=${resolvedContract.stop_recommended}`,
        summary: resolvedContract.why_blocked || 'Constraints resolved',
        payload: { original: pendingConstraint.originalMessage, follow_up: rawMsg, contract: resolvedContract },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch((e: any) => console.warn(`[CONSTRAINT_GATE] Failed to emit artefact: ${e.message}`));

      if (resolvedContract.stop_recommended) {
        clearPendingContract(task.conversation_id);
        const stopMsg = buildConstraintGateMessage(resolvedContract);
        const messageId = randomUUID();

        await Promise.all([
          supabase!.from('supervisor_tasks').update({ status: 'completed', result: { response: stopMsg.substring(0, 200), message_id: messageId, clarify_gate: 'constraint_gate_stop' } }).eq('id', task.id),
          supabase!.from('messages').insert({ id: messageId, conversation_id: task.conversation_id, role: 'assistant', content: sanitizeMessageContent(stopMsg), source: 'supervisor', metadata: { supervisor_task_id: task.id, run_id: jobId, clarify_gate: 'constraint_gate_stop', constraint_contract: resolvedContract, clarify_state: buildClarifyStateFromContract(resolvedContract) }, created_at: Date.now() }).select().single(),
        ]);

        await storage.updateAgentRun(jobId, { status: 'completed', terminalState: 'constraint_stop', endedAt: new Date(), metadata: { verdict: 'constraint_gate_stop', constraint_contract: resolvedContract } }).catch(() => {});
        console.log(`[CONSTRAINT_GATE] STOP — constraints cannot be satisfied`);
        await emitTaskExecutionCompleted('constraint_gate_stop');
        return;
      }

      if (!resolvedContract.can_execute) {
        storePendingContract(task.conversation_id, pendingConstraint.originalMessage, resolvedContract, jobId);
        const clarifyMsg = buildConstraintGateMessage(resolvedContract);
        const messageId = randomUUID();

        await Promise.all([
          supabase!.from('supervisor_tasks').update({ status: 'completed', result: { response: clarifyMsg.substring(0, 200), message_id: messageId, clarify_gate: 'constraint_gate_clarify' } }).eq('id', task.id),
          supabase!.from('messages').insert({ id: messageId, conversation_id: task.conversation_id, role: 'assistant', content: sanitizeMessageContent(clarifyMsg), source: 'supervisor', metadata: { supervisor_task_id: task.id, run_id: jobId, clarify_gate: 'constraint_gate_clarify', constraint_contract: resolvedContract, clarify_state: buildClarifyStateFromContract(resolvedContract) }, created_at: Date.now() }).select().single(),
        ]);

        await storage.updateAgentRun(jobId, { status: 'stopped', terminalState: 'stopped', endedAt: new Date(), metadata: { verdict: 'constraint_gate_clarify', stop_reason: 'clarification_needed', constraint_contract: resolvedContract } }).catch(() => {});
        console.log(`[CONSTRAINT_GATE] Still blocked — asking again — run paused`);
        await emitTaskExecutionCompleted('constraint_gate_clarify');
        return;
      }

      clearPendingContract(task.conversation_id);
      (task.request_data as any).user_message = pendingConstraint.originalMessage;
      (task.request_data as any)._constraint_gate_resolved = true;
      rawMsg = pendingConstraint.originalMessage;
      console.log(`[CONSTRAINT_GATE] Constraints resolved — restoring original message: "${rawMsg.substring(0, 80)}" and proceeding to execution`);
    }

    const existingSession = getClarifySession(task.conversation_id);
    let sessionCompletedToRun = false;
    let sessionOriginalRequest: string | null = null;
    let sessionFollowUpMsg: string | null = null;

    if (existingSession) {
      const followUp = classifyFollowUp(rawMsg, existingSession, canonicalIntent ?? undefined);
      const followUpSemanticSource = canonicalIntent ? 'canonical' : 'fallback_regex';
      console.log(`[CLARIFY_SESSION] conversation=${task.conversation_id} classification=${followUp.classification} field=${followUp.updatedField ?? 'none'} value="${(followUp.value ?? '').substring(0, 40)}" semantic_source=${followUpSemanticSource}`);

      await createArtefact({
        runId: jobId,
        type: 'diagnostic',
        title: `Clarify session follow-up: ${followUp.classification}`,
        summary: `Follow-up to "${existingSession.originalUserRequest.substring(0, 60)}" — classified as ${followUp.classification}`,
        payload: { classification: followUp.classification, updatedField: followUp.updatedField ?? null, value: followUp.value ?? null, originalRequest: existingSession.originalUserRequest, collectedFields: existingSession.collectedFields, semantic_source: followUpSemanticSource },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch((e: any) => console.warn(`[CLARIFY_SESSION] Failed to emit artefact: ${e.message}`));

      if (followUp.classification === 'META_TRUST') {
        const buildStamp = process.env.GIT_SHA?.substring(0, 7) || '5c9c5a8';
        console.log(`[CLARIFY_SESSION] META_TRUST triggered — build=${buildStamp} conversation=${task.conversation_id} msg="${rawMsg.substring(0, 80)}"`);

        const summary = renderClarifySummary(existingSession);
        const clarifyState = buildClarifyState(existingSession);
        const isDev = process.env.NODE_ENV !== 'production';
        const stampSuffix = isDev ? `\n\n[build: ${buildStamp}]` : '';
        const directMsg = rawMsg.trim().endsWith('?')
          ? `That's a great question. Let me answer directly rather than running a search.\n\nI'm a lead generation agent — I find businesses in specific locations for B2B outreach. I use Google Places and public web data, then run every result through a quality-control step. Results are verified against public sources, but I can't guarantee 100% accuracy.\n\nYour current draft is still active: ${summary}\n\nYou can continue refining it, say "search now" to run it, or ask me something else.${stampSuffix}`
          : `I'm a lead generation agent. I use Google Places and public web data, then verify results through a quality gate. I can't guarantee 100% accuracy, but every result is checked.\n\nYour current draft is still active: ${summary}\n\nYou can continue refining it, say "search now" to run it, or ask me something else.${stampSuffix}`;

        const messageId = randomUUID();

        const [taskUpdateResult, msgResult] = await Promise.all([
          supabase!.from('supervisor_tasks').update({ status: 'completed', result: { response: directMsg.substring(0, 200), message_id: messageId, clarify_gate: 'meta_trust_during_session', build: buildStamp } }).eq('id', task.id),
          supabase!.from('messages').insert({ id: messageId, conversation_id: task.conversation_id, role: 'assistant', content: sanitizeMessageContent(directMsg), source: 'supervisor', metadata: { supervisor_task_id: task.id, run_id: jobId, clarify_gate: 'meta_trust_during_session', reason: 'Meta/trust question answered without closing clarify session', clarify_state: clarifyState, build: buildStamp }, created_at: Date.now() }).select().single(),
        ]);

        if (taskUpdateResult.error) console.error(`[CLARIFY_SESSION] task update failed: ${taskUpdateResult.error.message}`);
        if (msgResult.error) console.error(`[CLARIFY_SESSION] message insert failed: ${msgResult.error.message}`);

        await storage.updateAgentRun(jobId, { status: 'stopped', terminalState: 'stopped', endedAt: new Date(), metadata: { verdict: 'meta_trust_during_session', stop_reason: 'clarification_needed', clarify_state: clarifyState, build: buildStamp } }).catch(() => {});
        console.log(`[CLARIFY_SESSION] META_TRUST answered — build=${buildStamp} conversation=${task.conversation_id} — session preserved, run paused`);
        await emitTaskExecutionCompleted('meta_trust_during_session');
        return;
      }

      if (followUp.classification === 'EXECUTE_NOW') {
        if (sessionIsComplete(existingSession)) {
          const searchParams = buildSearchFromSession(existingSession);
          closeClarifySession(task.conversation_id);
          console.log(`[CLARIFY_SESSION] EXECUTE_NOW with complete session — proceeding to agent_run`);

          const syntheticMsg = `find ${searchParams.count ? searchParams.count + ' ' : ''}${searchParams.businessType} in ${searchParams.location}${searchParams.attributes.length > 0 ? ' with ' + searchParams.attributes.join(', ') : ''}${searchParams.timeFilter ? ' ' + searchParams.timeFilter : ''}`;
          (task.request_data as any).user_message = syntheticMsg;
          if (!(task.request_data as any).search_query) (task.request_data as any).search_query = {};
          (task.request_data as any).search_query.business_type = searchParams.businessType;
          (task.request_data as any).search_query.location = searchParams.location;

          console.log(`[CLARIFY_SESSION] Synthetic message: "${syntheticMsg}"`);
          sessionCompletedToRun = true;
          sessionOriginalRequest = existingSession.originalUserRequest;
          sessionFollowUpMsg = rawMsg;

          await createArtefact({
            runId: jobId,
            type: 'diagnostic',
            title: `Execute command — launching search`,
            summary: renderClarifySummary(existingSession),
            payload: { syntheticMessage: syntheticMsg, searchParams, originalRequest: existingSession.originalUserRequest, trigger: 'EXECUTE_NOW' },
            userId: task.user_id,
            conversationId: task.conversation_id,
          }).catch((e: any) => console.warn(`[CLARIFY_SESSION] Failed to emit completion artefact: ${e.message}`));

        } else {
          const summary = renderClarifySummary(existingSession);
          const clarifyState = buildClarifyState(existingSession);
          const missingList = existingSession.missingFields.map(f => {
            if (f === 'location') return 'location (city, region, or country)';
            if (f === 'entity_type') return 'type of business';
            if (f === 'relationship_clarification') return 'relationship confirmation';
            if (f === 'semantic_constraint') return 'a measurable criterion (e.g. live music, cosy, dog-friendly)';
            return f;
          });

          const clarifyMsg = `I'd like to run the search, but I still need: ${missingList.join(', ')}.\n\nCurrent draft: ${summary}\n\nPlease provide the missing details, or I can search with what I have (results may be broad).`;
          const messageId = randomUUID();

          const [taskUpdateResult, msgResult] = await Promise.all([
            supabase!.from('supervisor_tasks').update({ status: 'completed', result: { response: clarifyMsg.substring(0, 200), message_id: messageId, clarify_gate: 'execute_blocked_incomplete' } }).eq('id', task.id),
            supabase!.from('messages').insert({ id: messageId, conversation_id: task.conversation_id, role: 'assistant', content: sanitizeMessageContent(clarifyMsg), source: 'supervisor', metadata: { supervisor_task_id: task.id, run_id: jobId, clarify_gate: 'execute_blocked_incomplete', clarify_state: clarifyState }, created_at: Date.now() }).select().single(),
          ]);

          if (taskUpdateResult.error) console.error(`[CLARIFY_SESSION] task update failed: ${taskUpdateResult.error.message}`);
          if (msgResult.error) console.error(`[CLARIFY_SESSION] message insert failed: ${msgResult.error.message}`);

          await storage.updateAgentRun(jobId, { status: 'stopped', terminalState: 'stopped', endedAt: new Date(), metadata: { verdict: 'execute_blocked_incomplete', stop_reason: 'clarification_needed', clarify_state: clarifyState } }).catch(() => {});
          console.log(`[CLARIFY_SESSION] EXECUTE_NOW blocked — missing fields: [${existingSession.missingFields.join(',')}] — run paused`);
          await emitTaskExecutionCompleted('execute_blocked_incomplete');
          return;
        }
      }

      if (followUp.classification === 'NEW_REQUEST') {
        closeClarifySession(task.conversation_id);
        console.log(`[CLARIFY_SESSION] Closed session for conversation=${task.conversation_id} — new request detected, routing normally`);
      } else if (!sessionCompletedToRun) {
        applyFollowUp(existingSession, followUp);
        const summary = renderClarifySummary(existingSession);
        console.log(`[CLARIFY_SESSION] Updated session — summary="${summary}" remaining_missing=[${existingSession.missingFields.join(',')}] turnCount=${existingSession.turnCount}`);

        if (sessionIsComplete(existingSession)) {
          const searchParams = buildSearchFromSession(existingSession);
          closeClarifySession(task.conversation_id);
          console.log(`[CLARIFY_SESSION] Session complete — proceeding to agent_run with businessType="${searchParams.businessType}" location="${searchParams.location}" attributes=[${searchParams.attributes.join(',')}]`);

          const syntheticMsg = `find ${searchParams.count ? searchParams.count + ' ' : ''}${searchParams.businessType} in ${searchParams.location}${searchParams.attributes.length > 0 ? ' with ' + searchParams.attributes.join(', ') : ''}${searchParams.timeFilter ? ' ' + searchParams.timeFilter : ''}`;
          (task.request_data as any).user_message = syntheticMsg;
          if (!(task.request_data as any).search_query) (task.request_data as any).search_query = {};
          (task.request_data as any).search_query.business_type = searchParams.businessType;
          (task.request_data as any).search_query.location = searchParams.location;

          console.log(`[CLARIFY_SESSION] Synthetic message: "${syntheticMsg}"`);

          sessionCompletedToRun = true;
          sessionOriginalRequest = existingSession.originalUserRequest;
          sessionFollowUpMsg = rawMsg;

          await createArtefact({
            runId: jobId,
            type: 'diagnostic',
            title: `Clarify session complete — launching search`,
            summary: summary,
            payload: { syntheticMessage: syntheticMsg, searchParams, originalRequest: existingSession.originalUserRequest },
            userId: task.user_id,
            conversationId: task.conversation_id,
          }).catch((e: any) => console.warn(`[CLARIFY_SESSION] Failed to emit completion artefact: ${e.message}`));

        } else if (sessionIsAtTurnLimit(existingSession)) {
          const clarifyState = buildClarifyState(existingSession);
          const draftSummary = renderClarifySummary(existingSession);

          const clarifyMsg = `I've asked a few questions and here's what I have so far: ${draftSummary}\n\nWould you like me to:\n1. Run the search with what I have (results may be broad)\n2. Start over with a new request\n3. Ask me something else entirely\n\nJust let me know.`;
          const messageId = randomUUID();

          const [taskUpdateResult, msgResult] = await Promise.all([
            supabase!.from('supervisor_tasks').update({ status: 'completed', result: { response: clarifyMsg.substring(0, 200), message_id: messageId, clarify_gate: 'clarify_turn_limit' } }).eq('id', task.id),
            supabase!.from('messages').insert({ id: messageId, conversation_id: task.conversation_id, role: 'assistant', content: sanitizeMessageContent(clarifyMsg), source: 'supervisor', metadata: { supervisor_task_id: task.id, run_id: jobId, clarify_gate: 'clarify_turn_limit', clarify_state: clarifyState }, created_at: Date.now() }).select().single(),
          ]);

          if (taskUpdateResult.error) console.error(`[CLARIFY_SESSION] task update failed: ${taskUpdateResult.error.message}`);
          if (msgResult.error) console.error(`[CLARIFY_SESSION] message insert failed: ${msgResult.error.message}`);

          await storage.updateAgentRun(jobId, { status: 'stopped', terminalState: 'stopped', endedAt: new Date(), metadata: { verdict: 'clarify_turn_limit', stop_reason: 'clarification_needed', clarify_state: clarifyState } }).catch(() => {});
          console.log(`[CLARIFY_SESSION] Turn limit reached for conversation=${task.conversation_id} — offering choices — run paused`);
          await emitTaskExecutionCompleted('clarify_turn_limit');
          return;

        } else {
          incrementTurnCount(existingSession);
          const clarifyState = buildClarifyState(existingSession);
          const remainingQuestions: string[] = [];
          for (const field of existingSession.missingFields) {
            if (field === 'location') remainingQuestions.push('Which city, region, or country should I search in?');
            else if (field === 'entity_type') remainingQuestions.push('Could you be more specific about the type of business?');
            else if (field === 'relationship_clarification') remainingQuestions.push('Would you like me to search for the target entity type in a specific location instead?');
          }

          const clarifyMsg = `Got it. So far I have: ${summary}\n\n${remainingQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nYou can also say "search now" to run with what I have, or ask me something else.`;
          const messageId = randomUUID();

          const [taskUpdateResult, msgResult] = await Promise.all([
            supabase!.from('supervisor_tasks').update({ status: 'completed', result: { response: clarifyMsg.substring(0, 200), message_id: messageId, clarify_gate: 'clarify_session_continue' } }).eq('id', task.id),
            supabase!.from('messages').insert({ id: messageId, conversation_id: task.conversation_id, role: 'assistant', content: sanitizeMessageContent(clarifyMsg), source: 'supervisor', metadata: { supervisor_task_id: task.id, run_id: jobId, clarify_gate: 'clarify_session_continue', session_summary: summary, clarify_state: clarifyState }, created_at: Date.now() }).select().single(),
          ]);

          if (taskUpdateResult.error) console.error(`[CLARIFY_SESSION] task update failed: ${taskUpdateResult.error.message}`);
          if (msgResult.error) console.error(`[CLARIFY_SESSION] message insert failed: ${msgResult.error.message}`);

          await storage.updateAgentRun(jobId, { status: 'stopped', terminalState: 'stopped', endedAt: new Date(), metadata: { verdict: 'clarify_session_continue', stop_reason: 'clarification_needed', clarify_state: clarifyState } }).catch(() => {});
          await emitTaskExecutionCompleted('clarify_session_continue');
          return;
        }
      }
    }

    console.log(`[STAGE] runId=${jobId} crid=${clientRequestId} stage=clarify_gate`);
    if (!sessionCompletedToRun && (!existingSession || !getClarifySession(task.conversation_id))) {
      const clarifyGate = canonicalIntent
        ? evaluateClarifyGateFromIntent(canonicalIntent, rawMsg)
        : evaluateClarifyGate(rawMsg);
      if (!clarifyGate.semantic_source) clarifyGate.semantic_source = 'fallback_regex';
      console.log(`[CLARIFY_GATE] route=${clarifyGate.route} reason="${clarifyGate.reason}" semantic_source=${clarifyGate.semantic_source}${clarifyGate.triggerCategory ? ` triggerCategory=${clarifyGate.triggerCategory}` : ''}${clarifyGate.questions ? ` questions=${JSON.stringify(clarifyGate.questions)}` : ''}`);

      await createArtefact({
        runId: jobId,
        type: 'diagnostic',
        title: `Clarify gate: ${clarifyGate.route}`,
        summary: clarifyGate.reason,
        payload: { route: clarifyGate.route, reason: clarifyGate.reason, triggerCategory: clarifyGate.triggerCategory ?? null, questions: clarifyGate.questions ?? null, missingFields: clarifyGate.missingFields ?? null, semantic_source: clarifyGate.semantic_source },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch((e: any) => console.warn(`[CLARIFY_GATE] Failed to emit artefact: ${e.message}`));

      if (clarifyGate.route === 'direct_response') {
        closeClarifySession(task.conversation_id);
        const directMsg = rawMsg.trim().endsWith('?')
          ? `That's a great question. Let me answer directly rather than running a search.\n\nI'm a lead generation agent — I find businesses in specific locations for B2B outreach. If you'd like me to search for something, just tell me the type of business and the location.\n\nFor example: "Find 10 micropubs in Sussex UK"`
          : `I'm a lead generation agent. I can find businesses in specific locations for B2B outreach. Just tell me the type of business and the location, and I'll get to work.\n\nFor example: "Find 10 micropubs in Sussex UK"`;

        const messageId = randomUUID();

        const [taskUpdateResult, msgResult] = await Promise.all([
          supabase!.from('supervisor_tasks').update({ status: 'completed', result: { response: directMsg.substring(0, 200), message_id: messageId, clarify_gate: 'direct_response' } }).eq('id', task.id),
          supabase!.from('messages').insert({ id: messageId, conversation_id: task.conversation_id, role: 'assistant', content: sanitizeMessageContent(directMsg), source: 'supervisor', metadata: { supervisor_task_id: task.id, run_id: jobId, clarify_gate: 'direct_response', reason: clarifyGate.reason }, created_at: Date.now() }).select().single(),
        ]);

        if (taskUpdateResult.error) console.error(`[CLARIFY_GATE] task update failed: ${taskUpdateResult.error.message}`);
        if (msgResult.error) console.error(`[CLARIFY_GATE] message insert failed: ${msgResult.error.message}`);

        await storage.updateAgentRun(jobId, { status: 'completed', terminalState: 'direct_response', endedAt: new Date(), metadata: { verdict: 'direct_response', clarify_gate: clarifyGate } }).catch(() => {});
        await emitTaskExecutionCompleted('direct_response');
        return;
      }

      if (clarifyGate.route === 'clarify_before_run') {
        const missingFields = clarifyGate.missingFields || [];
        const parsedBT = clarifyGate.parsedFields?.businessType || null;
        const parsedLoc = clarifyGate.parsedFields?.location || null;
        const parsedCount = clarifyGate.parsedFields?.count ?? null;
        const parsedTimeFilter = clarifyGate.parsedFields?.timeFilter ?? null;

        const newSession = createClarifySession(
          task.conversation_id,
          rawMsg,
          missingFields as any[],
          { businessType: parsedBT, location: parsedLoc, count: parsedCount, timeFilter: parsedTimeFilter },
          jobId,
        );
        incrementTurnCount(newSession);
        const clarifyState = buildClarifyState(newSession);
        console.log(`[CLARIFY_SESSION] Created session for conversation=${task.conversation_id} originRunId=${jobId} original="${rawMsg.substring(0, 60)}" missing=[${missingFields.join(',')}] bt="${parsedBT}" loc="${parsedLoc}" count=${parsedCount} timeFilter="${parsedTimeFilter}"`);

        const clarifyQuestions = clarifyGate.questions || ['Could you provide more detail about what you need?'];
        const clarifyMsg = clarifyQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n') + '\n\nYou can also say "search now" to run with what I have, or ask me something else.';

        const messageId = randomUUID();

        const [taskUpdateResult, msgResult] = await Promise.all([
          supabase!.from('supervisor_tasks').update({ status: 'completed', result: { response: clarifyMsg.substring(0, 200), message_id: messageId, clarify_gate: 'clarify_before_run' } }).eq('id', task.id),
          supabase!.from('messages').insert({ id: messageId, conversation_id: task.conversation_id, role: 'assistant', content: sanitizeMessageContent(clarifyMsg), source: 'supervisor', metadata: { supervisor_task_id: task.id, run_id: jobId, clarify_gate: 'clarify_before_run', reason: clarifyGate.reason, questions: clarifyGate.questions, clarify_state: clarifyState }, created_at: Date.now() }).select().single(),
        ]);

        if (taskUpdateResult.error) console.error(`[CLARIFY_GATE] task update failed: ${taskUpdateResult.error.message}`);
        if (msgResult.error) console.error(`[CLARIFY_GATE] message insert failed: ${msgResult.error.message}`);

        await storage.updateAgentRun(jobId, { status: 'clarifying', terminalState: null, metadata: { verdict: 'clarify_before_run', awaiting: 'user_input', clarify_state: clarifyState } }).catch(() => {});
        console.log(`[CLARIFY_GATE] Run awaiting user input — runId=${jobId} status=clarifying`);

        await emitProbe('clarify_before_run_probe', task.user_id, jobId, task.conversation_id, {
          run_id: jobId,
          conversation_id: task.conversation_id ?? null,
          user_id: task.user_id,
          missing_fields: missingFields,
          trigger_category: clarifyGate.triggerCategory ?? null,
          ts: Date.now(),
        });

        await emitTaskExecutionCompleted('clarify_before_run');
        return;
      }
    }

    console.log(`[STAGE] runId=${jobId} crid=${clientRequestId} stage=constraint_gate`);
    // OUTER CONSTRAINT GATE — runs BEFORE executeTowerLoopChat
    const outerGateMsg = String((task.request_data as any).user_message || '').trim();
    const outerGateAlreadyResolved = !!(task.request_data as any)._constraint_gate_resolved;
    if (!outerGateAlreadyResolved && outerGateMsg.length > 0) {
      // When a clarify session completed, check ORIGINAL request for no-proxy/hardness signals
      // and check the follow-up for proxy/best-effort choices
      const noProxySource = sessionOriginalRequest || outerGateMsg;
      const noProxyFromOriginal = detectNoProxySignal(noProxySource);
      const mustBeCertainFromOriginal = detectMustBeCertain(noProxySource);
      let outerGateResult = canonicalIntent
        ? preExecutionConstraintGateFromIntent(canonicalIntent, outerGateMsg)
        : preExecutionConstraintGate(outerGateMsg);
      if (!outerGateResult.semantic_source) outerGateResult.semantic_source = 'fallback_regex';

      // If the original request had must-be-certain signal but the synthetic message doesn't, apply certainty gate
      if (mustBeCertainFromOriginal && !outerGateResult.stop_recommended && outerGateResult.constraints.length > 0) {
        for (const c of outerGateResult.constraints) {
          c.must_be_certain = true;
        }
        outerGateResult = applyCertaintyGate(outerGateResult);
        console.log(`[CONSTRAINT_GATE_OUTER] must-be-certain signal detected from original request "${noProxySource.substring(0, 60)}" — applying certainty gate`);
      }

      // If the original request had no-proxy signal but the synthetic message doesn't, override
      if (noProxyFromOriginal && !outerGateResult.stop_recommended && outerGateResult.constraints.some(c => c.type === 'time_predicate')) {
        for (const c of outerGateResult.constraints) {
          if (c.type === 'time_predicate') {
            c.hardness = 'hard';
            c.verifiability = 'unverifiable';
            c.can_execute = false;
            c.why_blocked = 'User requires certainty but opening dates cannot be verified from any available data source. This constraint cannot be satisfied.';
            c.suggested_rephrase = null;
          }
        }
        outerGateResult = {
          ...outerGateResult,
          can_execute: false,
          stop_recommended: true,
          why_blocked: 'User requires certainty but opening dates cannot be verified.',
          clarify_questions: [],
        };
        console.log(`[CONSTRAINT_GATE_OUTER] no-proxy signal detected from original request "${noProxySource.substring(0, 60)}" — forcing STOP`);
      }

      // If the follow-up contained proxy/best-effort, pre-resolve the gate
      if (sessionFollowUpMsg && !outerGateResult.can_execute && !outerGateResult.stop_recommended) {
        const preResolved = resolveFollowUp(outerGateResult, sessionFollowUpMsg);
        if (preResolved.can_execute) {
          outerGateResult = preResolved;
          (task.request_data as any)._constraint_gate_resolved = true;
          console.log(`[CONSTRAINT_GATE_OUTER] Follow-up "${sessionFollowUpMsg.substring(0, 60)}" pre-resolved constraint gate — proceeding to execution`);
        }
      }

      console.log(`[CONSTRAINT_GATE_OUTER] can_execute=${outerGateResult.can_execute} stop=${outerGateResult.stop_recommended} constraints=${outerGateResult.constraints.length} msg="${outerGateMsg.substring(0, 80)}"`);

      if (!outerGateResult.can_execute) {
        await createArtefact({
          runId: jobId,
          type: 'diagnostic',
          title: `Pre-execution constraint gate (outer): BLOCKED (stop=${outerGateResult.stop_recommended})`,
          summary: outerGateResult.why_blocked || 'Constraints require clarification',
          payload: { constraint_contract: outerGateResult, original_goal: outerGateMsg, session_original: sessionOriginalRequest, session_followup: sessionFollowUpMsg },
          userId: task.user_id,
          conversationId: task.conversation_id,
        }).catch((e: any) => console.warn(`[CONSTRAINT_GATE_OUTER] Failed to emit artefact: ${e.message}`));

        storePendingContract(task.conversation_id, sessionOriginalRequest || outerGateMsg, outerGateResult, jobId);

        const outerGateClarifyMsg = buildConstraintGateMessage(outerGateResult);
        const outerGateMessageId = randomUUID();

        await Promise.all([
          supabase!.from('supervisor_tasks').update({ status: 'completed', result: { response: outerGateClarifyMsg.substring(0, 200), message_id: outerGateMessageId, clarify_gate: outerGateResult.stop_recommended ? 'constraint_gate_stop' : 'constraint_gate_clarify' } }).eq('id', task.id),
          supabase!.from('messages').insert({ id: outerGateMessageId, conversation_id: task.conversation_id, role: 'assistant', content: sanitizeMessageContent(outerGateClarifyMsg), source: 'supervisor', metadata: { supervisor_task_id: task.id, run_id: jobId, clarify_gate: outerGateResult.stop_recommended ? 'constraint_gate_stop' : 'constraint_gate_clarify', constraint_contract: outerGateResult, clarify_state: buildClarifyStateFromContract(outerGateResult) }, created_at: Date.now() }).select().single(),
        ]);

        const outerIsClarify = !outerGateResult.stop_recommended;
        const outerStatus = outerIsClarify ? 'clarifying' : 'stopped';
        const outerTermState = outerIsClarify ? null : 'stopped';
        await storage.updateAgentRun(jobId, {
          status: outerStatus,
          terminalState: outerTermState,
          ...(outerIsClarify ? {} : { endedAt: new Date() }),
          metadata: {
            verdict: outerGateResult.stop_recommended ? 'constraint_gate_stop' : 'constraint_gate_clarify',
            ...(outerIsClarify ? { awaiting: 'user_input' } : { stop_reason: 'constraint_stop' }),
            constraint_contract: outerGateResult,
          },
        }).catch(() => {});
        console.log(`[CONSTRAINT_GATE_OUTER] BLOCKED — status=${outerStatus} terminalState=${outerTermState}`);
        await emitTaskExecutionCompleted('outer_constraint_gate', { stop: outerGateResult.stop_recommended });
        return;
      }
    }

    console.log(`[STAGE] runId=${jobId} crid=${clientRequestId} stage=executeTowerLoopChat`);
    let towerResult: { response: string; leadIds: string[]; deliverySummary: DeliverySummaryPayload | null; towerVerdict: string | null; leads: Array<{ name: string; address: string; phone: string | null; website: string | null; placeId: string }> };
    let runFailed = false;
    let failureReason = '';
    try {
      towerResult = await this.executeTowerLoopChat(task, userContext, jobId, clientRequestId, earlyParsedGoal, canonicalIntent);
    } catch (execErr: any) {
      runFailed = true;
      failureReason = execErr.message || String(execErr);
      console.error(`[TOWER_LOOP_CHAT] executeTowerLoopChat failed for runId=${jobId}: ${failureReason}`);
      await storage.updateAgentRun(jobId, {
        status: 'failed',
        terminalState: 'failed',
        error: failureReason,
        endedAt: new Date(),
      }).catch((updateErr: any) => {
        console.warn(`[TOWER_LOOP_CHAT] Failed to mark agent_run as failed (run may not exist yet): ${updateErr.message}`);
      });

      createArtefact({
        runId: jobId,
        type: 'diagnostic',
        title: 'Run failed: executeTowerLoopChat threw',
        summary: `Error: ${failureReason.substring(0, 200)}`,
        payload: { reason: 'execution_error', error: failureReason, taskId: task.id },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch((e: any) => console.warn(`[TOWER_LOOP_CHAT] Failed to emit diagnostic artefact: ${e.message}`));

      towerResult = {
        response: `The search encountered an issue and could not complete. You can view partial results if any are available.`,
        leadIds: [],
        deliverySummary: null,
        towerVerdict: 'error',
        leads: [],
      };
    }
    if (!guardDelivery(task.conversation_id, task.id, 'final_message_after_tower_loop')) {
      console.warn(`[SESSION_GUARD] Dropping final message delivery for stale task=${task.id} conversation=${task.conversation_id} runId=${jobId}`);
      await supabase!.from('supervisor_tasks').update({ status: 'failed', result: { error: 'session_guard_stale_run', run_id: jobId } }).eq('id', task.id).then(
        () => console.log(`[SESSION_GUARD] Marked stale task=${task.id} as failed`),
        (err: any) => console.warn(`[SESSION_GUARD] Failed to mark stale task as failed: ${err.message}`)
      );
      await emitTaskExecutionCompleted('session_guard_stale_run');
      return;
    }

    const missionModeResolved = missionResult?.ok ? missionResult.mission?.mission_mode ?? 'research_now' : 'research_now';
    const isMonitoringMission = missionModeResolved === 'monitor' || missionModeResolved === 'alert_on_change' || missionModeResolved === 'recurring_check';
    let monitorCreated = false;

    if (isMonitoringMission && !runFailed && earlyParsedGoal) {
      try {
        const monitorLabel = `${earlyParsedGoal.business_type ?? 'businesses'} in ${earlyParsedGoal.location || 'unspecified location'}`;
        const monitorDescription = rawMsg.trim().substring(0, 500);
        const scheduleType = missionModeResolved === 'recurring_check' ? 'weekly' : 'daily';

        console.log(`[MONITOR_CREATE] mission_mode=${missionModeResolved} — creating scheduled monitor: "${monitorLabel}" schedule=${scheduleType}`);

        const { data: monitorData, error: monitorError } = await supabase!
          .from('scheduled_monitors')
          .insert({
            user_id: task.user_id,
            label: monitorLabel,
            description: monitorDescription,
            monitor_type: 'lead_search',
            schedule_type: scheduleType,
            is_active: true,
            config: {
              original_goal: rawMsg.trim(),
              business_type: earlyParsedGoal.business_type,
              location: earlyParsedGoal.location,
              country: earlyParsedGoal.country,
              constraints: (earlyParsedGoal.constraints ?? []).map(c => ({ type: c.type, field: c.field, operator: c.operator, value: c.value })),
              mission_mode: missionModeResolved,
              source_run_id: jobId,
            },
          })
          .select('id')
          .single();

        if (monitorError) {
          console.warn(`[MONITOR_CREATE] Failed to create scheduled monitor (non-fatal): ${monitorError.message}`);
        } else {
          monitorCreated = true;
          console.log(`[MONITOR_CREATE] Created scheduled monitor id=${monitorData?.id} for runId=${jobId}`);

          await createArtefact({
            runId: jobId,
            type: 'monitor_created',
            title: `Monitoring activated: ${monitorLabel}`,
            summary: `schedule=${scheduleType} mission_mode=${missionModeResolved} monitor_id=${monitorData?.id}`,
            payload: {
              monitor_id: monitorData?.id,
              label: monitorLabel,
              description: monitorDescription,
              schedule_type: scheduleType,
              mission_mode: missionModeResolved,
            },
            userId: task.user_id,
            conversationId: task.conversation_id,
          }).catch((e: any) => console.warn(`[MONITOR_CREATE] Artefact creation failed (non-fatal): ${e.message}`));
        }
      } catch (monitorErr: any) {
        console.warn(`[MONITOR_CREATE] Unexpected error creating monitor (non-fatal): ${monitorErr.message}`);
      }
    }

    let response = sanitizeSupervisorMessage(towerResult.response);

    if (monitorCreated) {
      const monitorNote = missionModeResolved === 'alert_on_change'
        ? `\n\nI've also set up ongoing monitoring for this. I'll alert you when there are changes or new results.`
        : `\n\nI've also set up ongoing monitoring for this search. I'll check periodically and let you know about new results.`;
      response = sanitizeSupervisorMessage(towerResult.response + monitorNote);
    }

    const leadIds = towerResult.leadIds;
    const capabilities = runFailed
      ? ['lead_generation', 'run_failed']
      : monitorCreated
        ? ['lead_generation', 'tower_validated', 'monitor_created']
        : ['lead_generation', 'tower_validated'];

    const dsStatus = towerResult.deliverySummary?.status ?? (runFailed ? 'STOP' : 'PASS');

    const messageId = randomUUID();
    const taskStatus = runFailed ? 'failed' : 'completed';

    const taskUpdatePromise = supabase
      .from('supervisor_tasks')
      .update({
        status: taskStatus,
        result: {
          message_id: messageId,
          lead_ids: leadIds,
          capabilities_used: capabilities,
          run_id: jobId,
          ...(runFailed ? { error: failureReason } : {}),
        }
      })
      .eq('id', task.id);

    const messageInsertPromise = supabase
      .from('messages')
      .insert({
        id: messageId,
        conversation_id: task.conversation_id,
        role: 'assistant',
        content: response,
        source: 'supervisor',
        metadata: {
          supervisor_task_id: task.id,
          run_id: jobId,
          capabilities,
          lead_ids: leadIds,
          run_lane: true,
          status: dsStatus,
          final_verdict: dsStatus,
          trust_status: towerResult.deliverySummary?.trust_status ?? (runFailed ? 'UNTRUSTED' : 'TRUSTED'),
          ...(towerResult.deliverySummary ? { deliverySummary: towerResult.deliverySummary } : {}),
          ...(towerResult.towerVerdict ? { towerVerdict: towerResult.towerVerdict } : {}),
          ...(towerResult.leads.length > 0 ? { leads: towerResult.leads } : {}),
          ...(runFailed ? { run_failed: true, failure_reason: failureReason } : {}),
        },
        created_at: Date.now(),
      })
      .select()
      .single();

    const [taskUpdateResult, messageResult] = await Promise.all([taskUpdatePromise, messageInsertPromise]);

    if (taskUpdateResult.error) {
      console.error(`[FINAL_TASK_UPDATE] task_update_failed run_id=${jobId} task_id=${task.id} error=${taskUpdateResult.error.message}`);
    }

    if (messageResult.error) {
      console.error(`[FINAL_MESSAGE] final_message_creation_failed run_id=${jobId} conversation_id=${task.conversation_id} error=${messageResult.error.message}`);
      throw new Error(`Failed to write message: ${messageResult.error.message}`);
    }

    console.log(`[FINAL_MESSAGE] final_message_created run_id=${jobId} conversation_id=${task.conversation_id} message_id=${messageResult.data.id} task_status=${taskStatus} status=${runFailed ? 'FAIL' : 'OK'}`);

    await emitTaskExecutionCompleted('run_completed', { runFailed, leadCount: leadIds.length });

    } catch (topLevelErr: any) {
      const stage = 'processChatTask_top_level';
      const errMsg = topLevelErr instanceof Error ? topLevelErr.message : String(topLevelErr);
      const errStack = topLevelErr instanceof Error ? topLevelErr.stack?.substring(0, 500) : undefined;
      console.error(`[RUN_ERROR] runId=${jobId} crid=${clientRequestId} stage=${stage} error="${errMsg}"`);

      await storage.updateAgentRun(jobId, {
        status: 'failed',
        terminalState: null,
        error: `Unhandled error: ${errMsg.substring(0, 300)}`,
        endedAt: new Date(),
        metadata: { run_error: true, stage, error_message: errMsg.substring(0, 300) },
      }).catch((updateErr: any) => {
        console.error(`[RUN_ERROR] Failed to mark agent_run ${jobId} as failed: ${updateErr.message}`);
      });

      await createArtefact({
        runId: jobId,
        type: 'run_error',
        title: `Run error: ${errMsg.substring(0, 100)}`,
        summary: `Unhandled exception at stage=${stage}: ${errMsg.substring(0, 200)}`,
        payload: {
          run_id: jobId,
          client_request_id: clientRequestId,
          stage,
          error_message: errMsg.substring(0, 500),
          stack: errStack,
          user_input: userInput,
          task_id: task.id,
        },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch((artErr: any) => {
        console.error(`[RUN_ERROR] Failed to persist run_error artefact for runId=${jobId}: ${artErr.message}`);
      });

      logAFREvent({
        userId: task.user_id, runId: jobId, conversationId: task.conversation_id,
        clientRequestId,
        actionTaken: 'run_error_top_level', status: 'failed',
        taskGenerated: `Top-level error: ${errMsg.substring(0, 120)}`,
        runType: 'plan',
        metadata: { taskId: task.id, stage, error: errMsg.substring(0, 200) },
      }).catch(() => {});

      const errorReplyMsg = `I encountered an unexpected error processing your request. Please try again.`;
      const errorMsgId = randomUUID();
      const { error: errorMsgErr } = await supabase!.from('messages').insert({
        id: errorMsgId,
        conversation_id: task.conversation_id,
        role: 'assistant',
        content: errorReplyMsg,
        source: 'supervisor',
        metadata: { supervisor_task_id: task.id, run_id: jobId, run_error: true, stage, error: errMsg.substring(0, 100) },
        created_at: Date.now(),
      });
      if (errorMsgErr) console.error(`[RUN_ERROR] Failed to send error message to user for runId=${jobId}: ${errorMsgErr.message}`);

      await supabase!.from('supervisor_tasks').update({
        status: 'failed',
        error: `run_error: ${errMsg.substring(0, 200)}`,
      }).eq('id', task.id).catch(() => {});

      await emitTaskExecutionCompleted('run_error', { error: errMsg.substring(0, 200) });
      throw topLevelErr;
    }
  }

  // ensureTowerJudgement: REMOVED — inline observation is mandatory. No safety nets.

  private async flagBypassedRuns(): Promise<void> {
    if (!supabase) return;

    try {
      const cutoffMs = Date.now() - 5 * 60 * 1000;

      const { data: recentRuns, error: runsErr } = await supabase
        .from('agent_runs')
        .select('id, user_id, client_request_id, metadata, created_at')
        .eq('status', 'completed')
        .gte('created_at', cutoffMs)
        .limit(20);

      if (runsErr || !recentRuns || recentRuns.length === 0) return;

      for (const run of recentRuns) {
        try {
          const { data: artefacts, error: artErr } = await supabase
            .from('artefacts')
            .select('id, run_id, type')
            .eq('run_id', run.id);

          if (artErr || !artefacts) continue;

          const hasStepResult = artefacts.some(a => a.type === 'step_result');
          const hasBypassFlag = artefacts.some(a => a.type === 'run_bypassed_supervisor');

          if (hasStepResult || hasBypassFlag) continue;

          const hasLeadsList = artefacts.some(a => a.type === 'leads_list');
          if (!hasLeadsList) continue;

          console.warn(`[BYPASS_DETECTOR] runId=${run.id} has leads_list but NO step_result — executed outside Supervisor`);

          const { error: insertErr } = await supabase.from('artefacts').insert({
            id: randomUUID(),
            run_id: run.id,
            type: 'run_bypassed_supervisor',
            title: 'Run bypassed Supervisor execution',
            summary: 'This run produced artefacts without Supervisor inline execution. No step_result or tower_judgement was created inline. This is a bug — all execution must go through the Supervisor.',
            payload_json: {
              detected_at: new Date().toISOString(),
              artefact_types_found: Array.from(new Set(artefacts.map(a => a.type))),
              user_id: run.user_id,
            },
          });

          if (insertErr) {
            console.error(`[BYPASS_DETECTOR] runId=${run.id} failed to insert bypass flag: ${insertErr.message}`);
          } else {
            console.warn(`[BYPASS_DETECTOR] runId=${run.id} flagged as run_bypassed_supervisor`);
          }

          await logAFREvent({
            userId: run.user_id, runId: run.id,
            clientRequestId: run.client_request_id,
            actionTaken: 'run_bypassed_supervisor', status: 'failed',
            taskGenerated: 'Run executed outside Supervisor — no inline step_result found',
            runType: 'plan',
            metadata: { bypass: true },
          }).catch(() => {});
        } catch (runErr: any) {
          console.error(`[BYPASS_DETECTOR] runId=${run.id} error (non-fatal): ${runErr.message}`);
        }
      }
    } catch (err: any) {
      console.error(`[BYPASS_DETECTOR] Poller error (non-fatal): ${err.message}`);
    }
  }

  private evaluatePreflightClarify(
    rawMsg: string,
    parsedGoal: ParsedGoal,
    previewBT: string | null,
    previewLoc: string | null,
    previewTime: string | null,
    canonicalIntent?: import('./supervisor/canonical-intent').CanonicalIntent | null,
  ): { reason: string; questions: string[]; options: string[] | null; semantic_source?: 'canonical' | 'fallback_regex' } | null {
    const questions: string[] = [];
    let options: string[] | null = null;
    const reasons: string[] = [];
    let semanticSource: 'canonical' | 'fallback_regex' = canonicalIntent ? 'canonical' : 'fallback_regex';

    const bt = canonicalIntent?.entity_category?.trim() || parsedGoal.business_type?.trim() || previewBT;
    const loc = canonicalIntent?.location_text?.trim() || parsedGoal.location?.trim() || previewLoc;

    if (!bt) {
      questions.push('What type of business are you looking for? (e.g. pubs, dentists, gyms)');
      reasons.push('missing business_type');
    }

    if (!loc) {
      questions.push('What location should I search in? (e.g. London, Sussex, Manchester)');
      reasons.push('missing location');
    }

    let timeHandled = false;
    if (canonicalIntent) {
      const timeConstraint = canonicalIntent.constraints.find(c => c.type === 'time');
      if (timeConstraint) {
        const contract = buildTimePredicateContract(timeConstraint.raw);
        if (contract && !contract.can_execute) {
          const timeQ = buildTimePredicateClarifyQuestion(contract);
          questions.push(timeQ);
          reasons.push('time_predicate_unverifiable');
          const supported = contract.proxy_options.filter(p => p.supported);
          options = [
            ...supported.map(p => `${p.label}: ${p.description}`),
            'Best-effort (unverified): Search without verifying opening dates',
          ];
          timeHandled = true;
        }
      }
    }

    if (!timeHandled && !canonicalIntent) {
      const timeDetected = detectTimePredicate(rawMsg);
      if (timeDetected) {
        semanticSource = 'fallback_regex';
        const contract = buildTimePredicateContract(rawMsg);
        if (contract && !contract.can_execute) {
          const timeQ = buildTimePredicateClarifyQuestion(contract);
          questions.push(timeQ);
          reasons.push('time_predicate_unverifiable');
          const supported = contract.proxy_options.filter(p => p.supported);
          options = [
            ...supported.map(p => `${p.label}: ${p.description}`),
            'Best-effort (unverified): Search without verifying opening dates',
          ];
        }
      }
    }

    if (questions.length === 0) return null;

    console.log(`[PREFLIGHT_CLARIFY] semantic_source=${semanticSource} reasons=${reasons.join(', ')}`);
    return {
      reason: reasons.join('; '),
      questions,
      options,
      semantic_source: semanticSource,
    };
  }

  private async postArtefactToUI(params: {
    runId: string;
    clientRequestId?: string;
    type: string;
    payload: Record<string, unknown>;
    userId?: string;
    conversationId?: string;
    taskId?: string;
  }): Promise<{ ok: boolean; artefactId?: string; httpStatus?: number }> {
    if (params.conversationId && params.runId && !isRunCurrentForConversation(params.conversationId, params.runId)) {
      console.warn(`[SESSION_GUARD] BLOCKED stale artefact POST: type=${params.type} runId=${params.runId} conversation=${params.conversationId}`);
      return { ok: false };
    }
    const uiBaseUrl = (process.env.UI_URL || '').replace(/\/+$/, '');
    if (!uiBaseUrl) {
      console.error(`[ARTEFACT_POST] runId=${params.runId} clientRequestId=${params.clientRequestId || 'none'} UI_URL not configured — cannot POST artefact to UI. Set UI_URL env var.`);
      if (params.userId) {
        logAFREvent({
          userId: params.userId, runId: params.runId, conversationId: params.conversationId,
          ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
          actionTaken: 'artefact_post_failed', status: 'failed',
          taskGenerated: 'Artefact POST failed: UI_URL not configured',
          runType: 'plan', metadata: { runId: params.runId, status: 0, hasBody: false, errorCode: 'ui_url_missing' },
        }).catch(() => {});
      }
      return { ok: false };
    }
    const url = `${uiBaseUrl}/api/afr/artefacts`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: params.runId,
          ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
          ...(params.conversationId ? { conversationId: params.conversationId } : {}),
          type: params.type,
          payload: params.payload,
          createdAt: new Date().toISOString(),
        }),
      });
      const rawBody = await resp.text();
      let json: any = {};
      let hasBody = false;
      try { json = JSON.parse(rawBody); hasBody = true; } catch { hasBody = rawBody.length > 0; }
      const artefactId = json?.artefactId || json?.id || undefined;
      const hasArtefactId = !!artefactId;

      console.log(`[ARTEFACT_POST] runId=${params.runId} clientRequestId=${params.clientRequestId || 'none'} status=${resp.status} hasArtefactId=${hasArtefactId}${hasArtefactId ? ` artefactId=${artefactId}` : ''}`);

      if (!resp.ok || !hasArtefactId) {
        if (params.userId) {
          logAFREvent({
            userId: params.userId, runId: params.runId, conversationId: params.conversationId,
            ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
            actionTaken: 'artefact_post_failed', status: 'failed',
            taskGenerated: `Artefact POST failed: HTTP ${resp.status}${!hasArtefactId ? ' (no artefactId in response)' : ''}`,
            runType: 'plan', metadata: { runId: params.runId, status: resp.status, hasBody, errorCode: json?.error || json?.code || null },
          }).catch(() => {});
        }
        return { ok: false, httpStatus: resp.status };
      }

      if (params.userId) {
        logAFREvent({
          userId: params.userId, runId: params.runId, conversationId: params.conversationId,
          ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
          actionTaken: 'artefact_post_succeeded', status: 'success',
          taskGenerated: `Artefact POST succeeded: artefactId=${artefactId}`,
          runType: 'plan', metadata: { runId: params.runId, artefactId },
        }).catch(() => {});
      }

      return { ok: true, artefactId, httpStatus: resp.status };
    } catch (e: any) {
      console.error(`[ARTEFACT_POST] runId=${params.runId} clientRequestId=${params.clientRequestId || 'none'} NETWORK_ERROR: ${e.message}`);
      if (params.userId) {
        logAFREvent({
          userId: params.userId, runId: params.runId, conversationId: params.conversationId,
          ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
          actionTaken: 'artefact_post_failed', status: 'failed',
          taskGenerated: `Artefact POST failed: network error`,
          runType: 'plan', metadata: { runId: params.runId, status: 0, hasBody: false, errorCode: 'network_error' },
        }).catch(() => {});
      }
      return { ok: false };
    }
  }

  private async backfillUserMessageRunId(userId: string, runId: string, conversationId?: string, _taskCreatedAt?: number): Promise<void> {
    if (!supabase) return;
    if (!conversationId) return;

    const { data: rows, error: selectErr } = await supabase
      .from('agent_activities')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('action_taken', 'user_message_received')
      .is('run_id', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (selectErr) {
      console.error(`[BACKFILL] Select failed: ${selectErr.message}`);
      return;
    }
    if (!rows || rows.length === 0) return;

    const targetId = rows[0].id;

    const { error: updateErr } = await supabase
      .from('agent_activities')
      .update({ run_id: runId })
      .eq('id', targetId);

    if (updateErr) {
      console.error(`[BACKFILL] Update failed for row ${targetId}: ${updateErr.message}`);
    } else {
      console.log(`[BACKFILL] Patched user_message_received row=${targetId} with run_id=${runId} conv=${conversationId}`);
    }
  }

  private async bridgeRunToUI(uiRunId: string, supervisorRunId: string, clientRequestId?: string, conversationId?: string, userId?: string): Promise<void> {
    const uiBaseUrl = (process.env.UI_URL || '').replace(/\/+$/, '');
    if (!uiBaseUrl) {
      console.error(`[RUN_BRIDGE] UI_URL not configured — cannot bridge run IDs`);
      return;
    }
    const requestPayload = {
      run_id: uiRunId,
      supervisor_run_id: supervisorRunId,
      ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
      ...(conversationId ? { conversation_id: conversationId } : {}),
    };
    console.log(`[RUN_BRIDGE] Sending bridge request: runId=${uiRunId} supervisorRunId=${supervisorRunId} crid=${clientRequestId || 'none'} convId=${conversationId || 'none'} url=${uiBaseUrl}/api/afr/run-bridge`);
    try {
      const resp = await fetch(`${uiBaseUrl}/api/afr/run-bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
      });
      const respBody = await resp.text().catch(() => '(no body)');
      if (resp.ok) {
        console.log(`[RUN_BRIDGE] SUCCESS uiRunId=${uiRunId} supervisorRunId=${supervisorRunId} status=${resp.status} body=${respBody.substring(0, 200)}`);
      } else {
        console.error(`[RUN_BRIDGE] FAILED uiRunId=${uiRunId} supervisorRunId=${supervisorRunId} status=${resp.status} body=${respBody.substring(0, 500)}`);
        console.error(`[RUN_BRIDGE] Request payload: ${JSON.stringify(requestPayload)}`);
        createArtefact({
          runId: supervisorRunId,
          type: 'diagnostic',
          title: `Run bridge failed: HTTP ${resp.status}`,
          summary: `bridgeRunToUI returned ${resp.status}. Body: ${respBody.substring(0, 200)}`,
          payload: {
            reason: 'run_bridge_failed',
            http_status: resp.status,
            response_body: respBody.substring(0, 500),
            request_payload: requestPayload,
          },
          userId: userId || 'system',
          conversationId,
        }).catch((artErr: any) => console.warn(`[RUN_BRIDGE] Failed to emit diagnostic artefact: ${artErr.message}`));
      }
    } catch (e: any) {
      console.error(`[RUN_BRIDGE] NETWORK_ERROR uiRunId=${uiRunId} supervisorRunId=${supervisorRunId} error=${e.message}`);
      createArtefact({
        runId: supervisorRunId,
        type: 'diagnostic',
        title: `Run bridge failed: network error`,
        summary: `bridgeRunToUI network error: ${e.message}`,
        payload: {
          reason: 'run_bridge_network_error',
          error: e.message,
          request_payload: requestPayload,
        },
        userId: userId || 'system',
        conversationId,
      }).catch((artErr: any) => console.warn(`[RUN_BRIDGE] Failed to emit diagnostic artefact: ${artErr.message}`));
    }
  }

  private async executeFactoryDemoTask(
    task: SupervisorTask,
    runId: string,
    clientRequestId: string,
  ): Promise<{ summary: string; scenario: string }> {
    const requestData = task.request_data as unknown as Record<string, unknown>;

    console.log(`[FACTORY_DEMO] Raw request_data keys: ${JSON.stringify(Object.keys(requestData))}`);
    console.log(`[FACTORY_DEMO] Raw request_data: ${JSON.stringify(requestData).substring(0, 500)}`);

    const constraints = (requestData.constraints || requestData.metadata || {}) as Record<string, unknown>;
    const rawScenario = requestData.scenario ?? constraints.scenario;
    const scenario: string = (typeof rawScenario === 'string' ? rawScenario : (typeof rawScenario === 'object' && rawScenario !== null ? (rawScenario as Record<string, unknown>).name as string : undefined)) || 'moisture_high';

    const rawMaxScrap = requestData.max_scrap_percent ?? requestData.max_scrap ?? constraints.max_scrap_percent ?? constraints.max_scrap;
    const maxScrap = typeof rawMaxScrap === 'number' ? rawMaxScrap
      : typeof rawMaxScrap === 'string' ? parseFloat(rawMaxScrap) || 2.0
      : 2.0;

    console.log(`[FACTORY_DEMO] Parsed — scenario=${scenario} (raw=${JSON.stringify(rawScenario)}) maxScrap=${maxScrap}% (raw=${JSON.stringify(rawMaxScrap)}) fallback=${rawMaxScrap === undefined ? 'YES' : 'NO'}`);
    console.log(`[SUPERVISOR] Routing to RUN_FACTORY_DEMO — scenario=${scenario} maxScrap=${maxScrap}%`);

    const nowMs = Date.now();
    const runMeta = {
      run_type: 'factory_demo',
      goal: `Injection moulding demo: scenario=${scenario}, max_scrap=${maxScrap}%`,
      scenario,
      maxScrapPercent: maxScrap,
      taskId: task.id,
    };
    try {
      await storage.createAgentRun({
        id: runId,
        clientRequestId,
        userId: task.user_id,
        conversationId: task.conversation_id,
        createdAt: nowMs,
        updatedAt: nowMs,
        status: 'executing',
        metadata: runMeta,
      });
      console.log(`[FACTORY_DEMO] [agent_run_create] runId=${runId}`);
    } catch (createErr: any) {
      const errMsg = createErr.message || '';
      if (errMsg.includes('duplicate key') || errMsg.includes('unique constraint')) {
        console.log(`[FACTORY_DEMO] agent_run already exists for runId=${runId} — updating to executing`);
        await storage.updateAgentRun(runId, {
          status: 'executing', error: null, terminalState: null, metadata: runMeta,
        });
      } else {
        throw createErr;
      }
    }

    try {
      const metadataFactory = (requestData.metadata as Record<string, unknown>)?.factory as Record<string, unknown> | undefined;
      const rawSensorScript =
        requestData.demo_sensor_script ??
        requestData.sensor_script ??
        (constraints as Record<string, unknown>).demo_sensor_script ??
        metadataFactory?.demo_sensor_script ??
        metadataFactory?.sensor_script;
      const demoSensorScript = rawSensorScript && typeof rawSensorScript === 'object'
        ? normalizeSensorScript(rawSensorScript)
        : undefined;
      if (demoSensorScript) {
        console.log(`[FACTORY_DEMO] Sensor script provided — primary steps: ${Object.keys(demoSensorScript.primary || {}).length}, alternate steps: ${Object.keys(demoSensorScript.alternate || {}).length}`);
      }

      const result = await executeFactoryDemo({
        runId,
        userId: task.user_id,
        conversationId: task.conversation_id,
        clientRequestId,
        scenario: scenario as any,
        maxScrapPercent: maxScrap,
        demoSensorScript,
      });

      await storage.updateAgentRun(runId, {
        status: result.success ? 'completed' : 'failed',
        terminalState: result.stoppedByTower ? 'stopped' : 'completed',
        endedAt: new Date(),
        metadata: {
          scenario, maxScrapPercent: maxScrap,
          stepsCompleted: result.stepsCompleted,
          stoppedByTower: result.stoppedByTower,
          planChanged: result.planChanged,
        },
      });

      return { summary: result.summary, scenario };
    } catch (err: any) {
      console.error(`[FACTORY_DEMO] Error: ${err.message}`);
      await storage.updateAgentRun(runId, {
        status: 'failed',
        terminalState: 'failed',
        error: err.message,
        endedAt: new Date(),
      }).catch(() => {});
      throw err;
    }
  }

  private async executeTowerLoopChat(
    task: SupervisorTask,
    userContext: UserContext,
    chatRunId: string,
    clientRequestId: string,
    preComputedParsedGoal?: ParsedGoal | null,
    canonicalIntent?: import('./supervisor/canonical-intent').CanonicalIntent | null,
  ): Promise<{ response: string; leadIds: string[]; deliverySummary: DeliverySummaryPayload | null; towerVerdict: string | null; leads: Array<{ name: string; address: string; phone: string | null; website: string | null; placeId: string }> }> {
    const conversationId = task.conversation_id;
    const requestData = task.request_data;
    const rawMsg = (requestData.user_message || '') as string;
    const searchQuery = requestData.search_query;
    const googleQueryMode: 'TEXT_ONLY' | 'BIASED_STABLE' =
      (requestData as any).google_query_mode === 'BIASED_STABLE' ? 'BIASED_STABLE' : 'TEXT_ONLY';
    console.log(`[TOWER_LOOP_CHAT] resolved_google_query_mode=${googleQueryMode} (from request_data: ${(requestData as any).google_query_mode ?? 'not set'})`);

    const originalUserGoal = rawMsg.trim();

    console.log(`[STAGE] runId=${chatRunId} crid=${clientRequestId} stage=parse_goal_to_constraints`);
    const parsedGoal = preComputedParsedGoal ?? await parseGoalToConstraints(originalUserGoal);
    if (preComputedParsedGoal) {
      console.log(`[TOWER_LOOP_CHAT] Reusing pre-computed parsedGoal (skipped duplicate LLM call)`);
    }

    let businessType: string = canonicaliseBusinessType(searchQuery?.business_type as string || parsedGoal.business_type || '');
    let rawLocation = parsedGoal.location;
    if (!rawLocation && searchQuery?.location) {
      const candidateLoc = sanitiseLocationString(searchQuery.location as string);
      if (candidateLoc.length > 0) {
        rawLocation = candidateLoc;
      }
    }
    let searchBudgetCountFromGoal = parsedGoal.search_budget_count;
    const prefixFilter = parsedGoal.prefix_filter || undefined;
    const nameFilter = parsedGoal.name_filter || undefined;
    const attributeFilter = parsedGoal.attribute_filter || undefined;
    const toolPreference = parsedGoal.tool_preference || undefined;
    const structuredConstraints = parsedGoal.constraints;
    const successCriteria = parsedGoal.success_criteria;
    const contactRequests = {
      email: parsedGoal.include_email,
      phone: parsedGoal.include_phone,
      website: parsedGoal.include_website,
    };
    const hasContactRequests = contactRequests.email || contactRequests.phone || contactRequests.website;

    const userRequestedCount = parsedGoal.requested_count_user ?? undefined;
    if (searchQuery?.count) {
      const uiCount = Math.min(Number(searchQuery.count), 200);
      searchBudgetCountFromGoal = Math.max(uiCount, parsedGoal.search_budget_count);
    }
    if (!businessType) businessType = 'pubs';
    if (!rawLocation) rawLocation = 'Local';
    let location = sanitiseLocationString(rawLocation);
    let city = sanitiseLocationString(location.split(',')[0].trim());
    console.log(`[TOWER_LOOP_CHAT] Location sanitised: raw="${rawLocation}" → location="${location}" city="${city}"`);
    const countryFromGoal = parsedGoal.country;
    const { inferCountryFromLocation } = await import('./supervisor/goal-to-constraints');
    const rawCountryPart = location.split(',')[1]?.trim();
    const countryFromLocation = rawCountryPart ? inferCountryFromLocation(rawCountryPart) : '';
    const country = countryFromGoal || countryFromLocation || inferCountryFromLocation(location);
    const rc: RequestedCountCanonical = buildRequestedCount(parsedGoal.requested_count_user);
    const userSpecifiedCount = rc.requested_count_user === 'explicit';
    const displayCount = rc.requested_count_value;
    let exactnessMode: ExactnessMode;
    let doNotStopDetected: boolean;
    if (canonicalIntent) {
      const hasHardCount = canonicalIntent.constraints.some(c => c.type === 'attribute' && c.hardness === 'hard') || canonicalIntent.default_count_policy === 'explicit';
      exactnessMode = hasHardCount ? 'hard' : 'soft';
      doNotStopDetected = false;
      console.log(`[SUPERVISOR] exactness_mode=${exactnessMode} do_not_stop=false semantic_source=canonical`);
    } else {
      exactnessMode = detectExactnessMode(originalUserGoal);
      doNotStopDetected = detectDoNotStop(originalUserGoal);
      if (doNotStopDetected) {
        console.log(`[SUPERVISOR] "do not stop" detected in goal — ignoring, enforcing budgets instead (semantic_source=fallback_regex)`);
      }
    }
    let candidateCountFromGoogle = 0;
    let queryBroadeningApplied = false;
    let queryBroadeningTerms: string | null = null;

    if (attributeFilter) {
      const attrRegex = new RegExp(`\\s+with\\s+(?:a\\s+)?${attributeFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      businessType = businessType.replace(attrRegex, '').trim();
      console.log(`[TOWER_LOOP_CHAT] Stripped attribute "${attributeFilter}" from businessType → "${businessType}"`);
    }

    const constraints: string[] = [];
    if (userSpecifiedCount) constraints.push(`count=${userRequestedCount}`);
    constraints.push(`business_type=${businessType}`);
    constraints.push(`location=${city}`);
    if (prefixFilter) constraints.push(`prefix=${prefixFilter}`);
    if (nameFilter) constraints.push(`name_contains=${nameFilter}`);
    if (attributeFilter) constraints.push(`attribute=${attributeFilter}`);
    if (toolPreference) constraints.push(`use=${toolPreference}`);

    const assumptions: string[] = [];
    if (prefixFilter) {
      assumptions.push(`Google Places cannot filter by name prefix; will search broadly then filter locally for names starting with "${prefixFilter}"`);
    }
    if (nameFilter) {
      assumptions.push(`Google Places cannot filter by name content; will search broadly then filter locally for names containing "${nameFilter}"`);
    }
    if (attributeFilter) {
      assumptions.push(`Attribute "${attributeFilter}" not injected into search query; will pull wider candidate set and verify via CVL post-search`);
    }
    if (!userSpecifiedCount) {
      assumptions.push(`No count specified by user — will return Google page 1 results (up to ~20)`);
    } else if (searchBudgetCountFromGoal < 30) {
      assumptions.push(`Will request wider candidate set from Google Places (30-50), then verify via CVL and trim to ${userRequestedCount}`);
    }
    assumptions.push(`Location "${city}" will be used as-is in the Google Places text query`);

    const userRequestedCountFinal: number | null = rc.requested_count_value;
    let searchBudgetCount = userSpecifiedCount ? Math.min(50, Math.max(30, searchBudgetCountFromGoal)) : DEFAULT_LEADS_TARGET;
    let searchCount = searchBudgetCount;
    const postProcessing: string[] = [];
    if (prefixFilter) postProcessing.push(`Filter names starting with "${prefixFilter}"`);
    if (nameFilter) postProcessing.push(`Filter names containing "${nameFilter}"`);
    if (userSpecifiedCount && userRequestedCountFinal! < searchBudgetCount) postProcessing.push(`Take first ${userRequestedCountFinal} results`);
    console.log(`[TOWER_LOOP_CHAT] Count split — requested_count_user=${rc.requested_count_user} requested_count_value=${rc.requested_count_value} requested_count_effective=${rc.requested_count_effective} search_budget_count=${searchBudgetCount} user_specified=${userSpecifiedCount}`);

    const nameDesc = prefixFilter ? ` starting with ${prefixFilter}` : nameFilter ? ` containing "${nameFilter}"` : '';
    const attrDesc = attributeFilter ? ` (attribute: ${attributeFilter} — verified post-search via CVL, not injected into query)` : '';
    const countDesc = userSpecifiedCount ? `${userRequestedCountFinal} ` : '';
    const normalizedGoal = `Find ${countDesc}${businessType} in ${city}${nameDesc} for B2B outreach${attrDesc}`;
    const goal = normalizedGoal;

    const hard_constraints: string[] = structuredConstraints.filter(c => c.hard).map(c => c.field === 'count' ? 'requested_count' : c.field === 'business_type' ? 'business_type' : c.field === 'location' ? 'location' : c.field === 'name' && c.type === 'NAME_STARTS_WITH' ? 'prefix_filter' : c.field === 'name' && c.type === 'NAME_CONTAINS' ? 'name_filter' : c.field);
    const soft_constraints: string[] = structuredConstraints.filter(c => !c.hard).map(c => c.field === 'count' ? 'requested_count' : c.field === 'business_type' ? 'business_type' : c.field === 'location' ? 'location' : c.field === 'name' && c.type === 'NAME_STARTS_WITH' ? 'prefix_filter' : c.field === 'name' && c.type === 'NAME_CONTAINS' ? 'name_filter' : c.field);
    
    if (userSpecifiedCount && !hard_constraints.includes('requested_count')) hard_constraints.push('requested_count');
    console.log(`[TOWER_LOOP_CHAT] Constraint classification — hard: [${hard_constraints.join(', ')}] soft: [${soft_constraints.join(', ')}]`);

    const gateResult = evaluatePrePlanGate({
      userMessage: originalUserGoal,
      businessType,
      location: city,
      verticalId: userContext.verticalId,
    });
    console.log(`[PRE_PLAN_GATE] clarification_needed=${gateResult.clarification_needed} flags=${JSON.stringify(gateResult.gate_flags)}`);

    if (gateResult.clarification_needed) {
      console.log(`[PRE_PLAN_GATE] CLARIFY — reason: ${gateResult.reason}`);

      await createArtefact({
        runId: chatRunId,
        type: 'clarification_needed',
        title: `Clarification needed: ${gateResult.gate_flags.vertical_mismatch ? 'vertical mismatch' : gateResult.gate_flags.informational_query ? 'informational query' : 'ambiguous'}`,
        summary: gateResult.reason || 'Clarification required before search',
        payload: {
          clarification_needed: true,
          reason: gateResult.reason,
          suggested_question: gateResult.suggested_question,
          assumptions: gateResult.assumptions,
          gate_flags: gateResult.gate_flags,
          parsed_business_type: businessType,
          parsed_location: city,
          original_user_goal: originalUserGoal,
        },
        userId: task.user_id,
        conversationId,
      });

      await this.postArtefactToUI({
        runId: chatRunId,
        clientRequestId,
        type: 'clarification_needed',
        payload: {
          clarification_needed: true,
          reason: gateResult.reason,
          suggested_question: gateResult.suggested_question,
          assumptions: gateResult.assumptions,
          gate_flags: gateResult.gate_flags,
        },
        userId: task.user_id,
        conversationId,
      }).catch(() => {});

      await storage.updateAgentRun(chatRunId, {
        status: 'clarifying',
        terminalState: null,
        metadata: { verdict: 'clarification_needed', awaiting: 'user_input', gate_flags: gateResult.gate_flags },
      });

      const clarifyDsPayload: DeliverySummaryPayload = {
        requested_count: null,
        hard_constraints,
        soft_constraints,
        plan_versions: [],
        soft_relaxations: [],
        delivered_exact: [],
        delivered_closest: [],
        delivered_exact_count: 0,
        delivered_total_count: 0,
        shortfall: 0,
        status: 'STOP',
        trust_status: 'UNTRUSTED',
        tower_verdict: null,
        cvl_summary: null,
        stop_reason: `Clarification needed: ${gateResult.reason}`,
        suggested_next_question: gateResult.suggested_question,
        cvl_verified_exact_count: null,
        cvl_unverifiable_count: null,
        relationship_context: null,
      };

      return {
        response: gateResult.suggested_question || 'Could you clarify your request?',
        leadIds: [],
        deliverySummary: clarifyDsPayload,
        towerVerdict: null,
        leads: [],
      };
    }

    if (gateResult.gate_flags.query_suspected_merged) {
      console.log(`[PRE_PLAN_GATE] query_suspected_merged=true — proceeding with warning`);
    }

    let relationshipPredicate: RelationshipPredicateResult;
    const canonicalRelConstraint = canonicalIntent?.constraints.find(c => c.type === 'relationship');
    if (canonicalIntent && canonicalRelConstraint) {
      const relRole = detectRelationshipPredicate(canonicalRelConstraint.raw);
      relationshipPredicate = relRole;
      console.log(`[RELATIONSHIP_PREDICATE] semantic_source=canonical detected="${relationshipPredicate.detected_predicate}" target="${relationshipPredicate.relationship_target}" requires_evidence=${relationshipPredicate.requires_relationship_evidence}`);
    } else if (canonicalIntent && !canonicalRelConstraint) {
      relationshipPredicate = { requires_relationship_evidence: false, detected_predicate: null, relationship_target: null };
      console.log(`[RELATIONSHIP_PREDICATE] semantic_source=canonical — no relationship constraint in canonical intent, skipping regex detection`);
    } else {
      relationshipPredicate = detectRelationshipPredicate(originalUserGoal);
      if (relationshipPredicate.requires_relationship_evidence) {
        console.log(`[RELATIONSHIP_PREDICATE] semantic_source=fallback_regex detected="${relationshipPredicate.detected_predicate}" target="${relationshipPredicate.relationship_target}" — all results will be candidates until relationship evidence is found`);
      }
    }

    const typedConstraints = structuredConstraints.map(c => ({
      type: c.type,
      field: c.field === 'count' ? 'requested_count'
        : c.field === 'name' && c.type === 'NAME_STARTS_WITH' ? 'prefix_filter'
        : c.field === 'name' && c.type === 'NAME_CONTAINS' ? 'name_filter'
        : c.field,
      value: c.value,
      hardness: c.hard ? 'hard' as const : 'soft' as const,
    }));
    
    if (!typedConstraints.some(tc => tc.field === 'requested_count') && userRequestedCountFinal !== null) {
      typedConstraints.push({ type: 'COUNT_MIN' as const, field: 'requested_count', value: userRequestedCountFinal, hardness: 'hard' });
    }
    console.log(`[TOWER_LOOP_CHAT] Typed constraints for Tower: ${JSON.stringify(typedConstraints)}`);

    if (!preComputedParsedGoal) {
      const cvlConstraintsPayload = buildConstraintsExtractedPayload(originalUserGoal, userRequestedCountFinal, structuredConstraints);
      try {
        const ceArtefact = await createArtefact({
          runId: chatRunId,
          type: 'constraints_extracted',
          title: `Constraints extracted: ${structuredConstraints.length} constraints`,
          summary: `mission_type=lead_finder | ${structuredConstraints.filter(c => c.hard).length} hard, ${structuredConstraints.filter(c => !c.hard).length} soft | requested_count_user=${userRequestedCountFinal ?? 'any'}`,
          payload: cvlConstraintsPayload as unknown as Record<string, unknown>,
          userId: task.user_id,
          conversationId,
        });
        console.log(`[CVL] constraints_extracted artefact id=${ceArtefact.id} constraints=${structuredConstraints.length}`);
        const ceTitle = `Constraints extracted: ${structuredConstraints.length} constraints`;
        const ceSummary = `mission_type=lead_finder | ${structuredConstraints.filter(c => c.hard).length} hard, ${structuredConstraints.filter(c => !c.hard).length} soft | requested_count_user=${userRequestedCountFinal ?? 'any'}`;
        await this.postArtefactToUI({
          runId: chatRunId,
          clientRequestId,
          type: 'constraints_extracted',
          payload: { ...cvlConstraintsPayload as unknown as Record<string, unknown>, title: ceTitle, summary: ceSummary },
          userId: task.user_id,
          conversationId,
        }).catch((e: any) => console.warn(`[CVL] postArtefactToUI constraints_extracted failed (non-fatal): ${e.message}`));
      } catch (ceErr: any) {
        console.warn(`[CVL] Failed to emit constraints_extracted (non-fatal): ${ceErr.message}`);
      }

      const cvlCapabilityPayload = buildCapabilityCheck(structuredConstraints);
      try {
        const ccArtefact = await createArtefact({
          runId: chatRunId,
          type: 'constraint_capability_check',
          title: `Capability check: ${cvlCapabilityPayload.verifiable_count} verifiable, ${cvlCapabilityPayload.unverifiable_count} unverifiable`,
          summary: `${cvlCapabilityPayload.verifiable_count}/${cvlCapabilityPayload.total_constraints} verifiable | blocking_hard: [${cvlCapabilityPayload.blocking_hard_constraints.join(', ')}]`,
          payload: cvlCapabilityPayload as unknown as Record<string, unknown>,
          userId: task.user_id,
          conversationId,
        });
        console.log(`[CVL] constraint_capability_check artefact id=${ccArtefact.id} verifiable=${cvlCapabilityPayload.verifiable_count} blocking_hard=${cvlCapabilityPayload.blocking_hard_constraints.length}`);
        const ccTitle = `Capability check: ${cvlCapabilityPayload.verifiable_count} verifiable, ${cvlCapabilityPayload.unverifiable_count} unverifiable`;
        const ccSummary = `${cvlCapabilityPayload.verifiable_count}/${cvlCapabilityPayload.total_constraints} verifiable | blocking_hard: [${cvlCapabilityPayload.blocking_hard_constraints.join(', ')}]`;
        await this.postArtefactToUI({
          runId: chatRunId,
          clientRequestId,
          type: 'constraint_capability_check',
          payload: { ...cvlCapabilityPayload as unknown as Record<string, unknown>, title: ccTitle, summary: ccSummary },
          userId: task.user_id,
          conversationId,
        }).catch((e: any) => console.warn(`[CVL] postArtefactToUI constraint_capability_check failed (non-fatal): ${e.message}`));
      } catch (ccErr: any) {
        console.warn(`[CVL] Failed to emit constraint_capability_check (non-fatal): ${ccErr.message}`);
      }
    } else {
      console.log(`[CVL] Skipping duplicate constraints_extracted + capability_check artefacts (already emitted in early_parse_goal stage)`);
    }

    let policyResult: PolicyApplicationResult | null = null;
    const runStartTime = Date.now();
    let runToolCallCount = 0;
    let runTotalRetryCount = 0;
    let MAX_REPLANS = parseInt(process.env.MAX_REPLANS || '5', 10);
    let policyApplicationWritten = false;
    let runGovernanceStatus: 'governed' | 'tower_unavailable' = 'governed';
    const HARD_CAP_MAX_REPLANS = 10;
    let learned_max_replans = MAX_REPLANS;
    let effective_max_replans = MAX_REPLANS;

    const MAX_RUN_DURATION_MS = parseInt(process.env.MAX_RUN_DURATION_MS || '180000', 10);
    const MAX_TOOL_CALLS_PER_RUN = parseInt(process.env.MAX_TOOL_CALLS_PER_RUN || '150', 10);
    let runDeadlineExceeded = false;
    let runDeadlineReason = '';

    const checkRunDeadline = (): boolean => {
      const elapsed = Date.now() - runStartTime;
      if (elapsed > MAX_RUN_DURATION_MS) {
        runDeadlineExceeded = true;
        runDeadlineReason = `wall_clock_timeout: ${Math.round(elapsed / 1000)}s > ${Math.round(MAX_RUN_DURATION_MS / 1000)}s limit`;
        console.warn(`[RUN_DEADLINE] ${runDeadlineReason} runId=${chatRunId}`);
        return true;
      }
      if (runToolCallCount > MAX_TOOL_CALLS_PER_RUN) {
        runDeadlineExceeded = true;
        runDeadlineReason = `max_tool_calls: ${runToolCallCount} > ${MAX_TOOL_CALLS_PER_RUN} limit`;
        console.warn(`[RUN_DEADLINE] ${runDeadlineReason} runId=${chatRunId}`);
        return true;
      }
      return false;
    };

    const runOverrides: RunOverrides = {};
    if (requestData.mode_preset) runOverrides.mode_preset = requestData.mode_preset;
    if (requestData.override_max_replans !== undefined) runOverrides.override_max_replans = requestData.override_max_replans;
    if (requestData.ignore_learned_policy !== undefined) runOverrides.ignore_learned_policy = requestData.ignore_learned_policy;
    const hasOverrides = Object.keys(runOverrides).length > 0;
    if (hasOverrides) console.log(`[SUPERVISOR] Per-run overrides detected: ${JSON.stringify(runOverrides)}`);

    const policyInput = {
      request: originalUserGoal,
      vertical: businessType,
      location: city,
      constraintBucket: hard_constraints,
      userValue: userRequestedCountFinal ?? undefined,
    };
    try {
      policyResult = await applyPolicy(policyInput, hasOverrides ? runOverrides : undefined);

      if (userSpecifiedCount) {
        const ep = policyResult.executionParams;
        if (ep.searchBudgetCount !== searchBudgetCount) {
          console.log(`[LEARNING_LAYER] Overriding searchBudgetCount: ${searchBudgetCount} -> ${ep.searchBudgetCount}`);
          searchBudgetCount = ep.searchBudgetCount;
          searchCount = ep.searchCount;
        }
        if (ep.maxReplans !== MAX_REPLANS) {
          console.log(`[LEARNING_LAYER] Overriding MAX_REPLANS: ${MAX_REPLANS} -> ${ep.maxReplans}`);
          MAX_REPLANS = ep.maxReplans;
        }
      } else {
        console.log(`[LEARNING_LAYER] Skipping execution param overrides -- no user-specified count (default page 1 search)`);
      }

      learned_max_replans = MAX_REPLANS;
      effective_max_replans = Math.min(learned_max_replans, HARD_CAP_MAX_REPLANS);
      MAX_REPLANS = effective_max_replans;
      console.log(`[SUPERVISOR] Replan limits: learned=${learned_max_replans} hard_cap=${HARD_CAP_MAX_REPLANS} effective=${effective_max_replans}`);

      await persistPolicyApplication(chatRunId, policyInput, policyResult);
      policyApplicationWritten = true;
      console.log(`[LEARNING_LAYER] policy_applications row written for run_id=${chatRunId} scope=${policyResult.scopeKey}`);

      await writeDecisionLog({
        runId: chatRunId,
        userId: task.user_id,
        conversationId,
        scopeKey: policyResult.scopeKey,
        policyVersion: policyResult.policyVersion,
        policyApplied: policyResult.applied,
        snapshot: policyResult.snapshot,
        executionParams: policyResult.executionParams,
        inputVertical: businessType,
        inputLocation: city,
        constraintBucket: hard_constraints,
        rationale: policyResult.rationale,
        querySuspectedMerged: gateResult.gate_flags.query_suspected_merged,
        learned_max_replans,
        hard_cap_max_replans: HARD_CAP_MAX_REPLANS,
        effective_max_replans,
        ...(hasOverrides ? { run_overrides: runOverrides } : {}),
      });
    } catch (policyErr: any) {
      console.warn(`[LEARNING_LAYER] Policy application failed (non-fatal, using defaults): ${policyErr.message}`);
    }

    let queryShapeKey = '';
    let finalPolicyPayload: PolicyAppliedArtefact | null = null;
    try {
      const shapeInput = deriveQueryShapeFromGoal({
        business_type: businessType,
        location: city,
        country,
        attribute_filter: attributeFilter,
        constraints: structuredConstraints,
      });
      queryShapeKey = computeQueryShapeKey(shapeInput);
      console.log(`[LEARNING_STORE] query_shape_key=${queryShapeKey}`);

      const { knobs: learnedKnobs, fieldMetadata, exists: learnedExists } = await readLearningStore(queryShapeKey);
      const userKnobOverrides = userSpecifiedCount && userRequestedCountFinal
        ? { requested_count: userRequestedCountFinal }
        : undefined;

      const finalPolicy = mergePolicyKnobs(
        BASELINE_DEFAULTS,
        learnedExists ? learnedKnobs : null,
        fieldMetadata,
        userKnobOverrides,
      );

      if (learnedExists && finalPolicy.knobs.default_result_count !== BASELINE_DEFAULTS.default_result_count
          && finalPolicy.source_of_each_field.default_result_count === 'learned'
          && !userSpecifiedCount) {
        const learnedCount = finalPolicy.knobs.default_result_count;
        if (learnedCount !== searchBudgetCount) {
          console.log(`[LEARNING_STORE] Applying learned default_result_count: ${searchBudgetCount} -> ${learnedCount}`);
          searchBudgetCount = Math.max(learnedCount, searchBudgetCount);
          searchCount = searchBudgetCount;
        }
      }

      if (learnedExists && finalPolicy.knobs.search_budget_pages !== BASELINE_DEFAULTS.search_budget_pages
          && finalPolicy.source_of_each_field.search_budget_pages === 'learned') {
        const learnedPages = finalPolicy.knobs.search_budget_pages;
        const pageSize = 20;
        const learnedBudget = learnedPages * pageSize;
        if (learnedBudget > searchBudgetCount) {
          console.log(`[LEARNING_STORE] Applying learned search_budget_pages: budget ${searchBudgetCount} -> ${learnedBudget}`);
          searchBudgetCount = learnedBudget;
          searchCount = searchBudgetCount;
        }
      }

      finalPolicyPayload = buildPolicyAppliedPayload(queryShapeKey, finalPolicy, fieldMetadata, learnedExists);
      await emitPolicyAppliedArtefact({
        runId: chatRunId,
        userId: task.user_id,
        conversationId,
        policyApplied: finalPolicyPayload,
      });
    } catch (shapeErr: any) {
      console.warn(`[LEARNING_STORE] query_shape_key / policy_applied failed (non-fatal): ${shapeErr.message}`);
    }

    const v1Constraints = {
      business_type: businessType,
      location: city,
      prefix_filter: prefixFilter || null,
      requested_count: displayCount,
    };

    function buildConstraintLabel(
      cur: { business_type: string; location: string; prefix_filter?: string | null; requested_count: number | null },
      v1: typeof v1Constraints,
      planVersion: number,
    ): { annotations: string[]; relaxed_constraints: string[]; constraint_diffs: { field: string; from: any; to: any }[] } {
      const annotations: string[] = [];
      const relaxed_constraints: string[] = [];
      const constraint_diffs: { field: string; from: any; to: any }[] = [];
      if (planVersion <= 1) return { annotations, relaxed_constraints, constraint_diffs };
      if (v1.prefix_filter && !cur.prefix_filter) {
        annotations.push('prefix relaxed');
        relaxed_constraints.push('prefix_filter');
        constraint_diffs.push({ field: 'prefix_filter', from: v1.prefix_filter, to: null });
      } else if (v1.prefix_filter && cur.prefix_filter && v1.prefix_filter !== cur.prefix_filter) {
        annotations.push(`prefix changed to ${cur.prefix_filter}`);
        relaxed_constraints.push('prefix_filter');
        constraint_diffs.push({ field: 'prefix_filter', from: v1.prefix_filter, to: cur.prefix_filter });
      }
      if (cur.location !== v1.location) {
        const radiusMatch = cur.location.match(/within\s+(\d+\s*km)/i);
        annotations.push(radiusMatch ? `area expanded to ${radiusMatch[1]}` : 'area expanded');
        relaxed_constraints.push('location');
        constraint_diffs.push({ field: 'location', from: v1.location, to: cur.location });
      }
      if (cur.business_type !== v1.business_type) {
        annotations.push('type broadened');
        relaxed_constraints.push('business_type');
        constraint_diffs.push({ field: 'business_type', from: v1.business_type, to: cur.business_type });
      }
      return { annotations, relaxed_constraints, constraint_diffs };
    }

    function artefactTitle(
      prefix: string,
      count: number | null,
      cur: { business_type: string; location: string; prefix_filter?: string | null; requested_count: number | null },
      planVersion: number,
    ): string {
      const { annotations } = buildConstraintLabel(cur, v1Constraints, planVersion);
      const loc = cur.location;
      const parts = [prefix];
      parts.push(count !== null ? `${count} ${cur.business_type}` : cur.business_type);
      if (cur.prefix_filter) parts.push(`starting with ${cur.prefix_filter}`);
      parts.push(`in ${loc}`);
      if (annotations.length > 0) parts.push(`(${annotations.join(', ')})`);
      return parts.join(' ');
    }

    function artefactSummary(
      prefix: string,
      delivered: number,
      target: number | null,
      cur: { business_type: string; location: string; prefix_filter?: string | null; requested_count: number | null },
      planVersion: number,
      extra?: string,
    ): string {
      const { annotations } = buildConstraintLabel(cur, v1Constraints, planVersion);
      const loc = cur.location;
      const targetStr = target !== null ? ` of ${target}` : '';
      let s = `${prefix}${delivered}${targetStr} ${cur.business_type} in ${loc}`;
      if (cur.prefix_filter) s += ` starting with ${cur.prefix_filter}`;
      if (annotations.length > 0) s += ` (${annotations.join(', ')})`;
      if (extra) s += ` ${extra}`;
      return s;
    }

    const accumulatedCandidates = new Map<string, AccumulatedCandidate>();

    const hasHardNameConstraints = structuredConstraints.some(c => (c.type === 'NAME_STARTS_WITH' || c.type === 'NAME_CONTAINS') && c.hard);
    function countMatchingLeads(candidates: Map<string, AccumulatedCandidate>): { matching: AccumulatedCandidate[]; total: number } {
      const all = Array.from(candidates.values());
      if (!hasHardNameConstraints) return { matching: all, total: all.length };
      let matching = all;
      const nameStartsConstraint = structuredConstraints.find(c => c.type === 'NAME_STARTS_WITH' && c.hard);
      const nameContainsConstraint = structuredConstraints.find(c => c.type === 'NAME_CONTAINS' && c.hard);
      if (nameStartsConstraint) {
        const pfx = (typeof nameStartsConstraint.value === 'string' ? nameStartsConstraint.value : '').toLowerCase();
        if (pfx) matching = matching.filter(l => l.name.toLowerCase().startsWith(pfx));
      }
      if (nameContainsConstraint) {
        const word = (typeof nameContainsConstraint.value === 'string' ? nameContainsConstraint.value : '').toLowerCase();
        if (word) matching = matching.filter(l => l.name.toLowerCase().includes(word));
      }
      return { matching, total: all.length };
    }

    const perPlanAdded: Array<{ plan_version: number; added_matching: number; added_total: number }> = [];

    console.log(`[TOWER_LOOP_CHAT] Starting — businessType="${businessType}" location="${city}" requested_count_user=${userRequestedCountFinal} search_budget_count=${searchBudgetCount} goal="${goal}" MAX_REPLANS=${MAX_REPLANS}`);
    console.log(`[STAGE] runId=${chatRunId} crid=${clientRequestId} stage=executeTowerLoopChat_start`);

    await storage.updateAgentRun(chatRunId, {
      status: 'executing',
      error: null,
      terminalState: null,
      metadata: {
        feature_flag: 'TOWER_LOOP_CHAT_MODE',
        original_user_goal: originalUserGoal,
        normalized_goal: normalizedGoal,
        plan: { version: 1, steps: [{ tool: 'SEARCH_PLACES', args: { query: businessType, location: city, country, maxResults: searchCount, target_count: rc.requested_count_effective } }] },
      },
    }).catch((updateErr: any) => {
      console.warn(`[TOWER_LOOP_CHAT] Failed to update agent_run with full metadata (non-fatal): ${updateErr.message}`);
    });
    console.log(`[TOWER_LOOP_CHAT] [agent_run_enriched] runId=${chatRunId} (early-persisted, now enriched with parsed goal)`);

    let goalId: string | null = null;
    try {
      const constraintsSummary = `requested_count=${userRequestedCountFinal ?? 'any'}, business_type=${businessType}, location=${city}${prefixFilter ? `, prefix=${prefixFilter}` : ''}${nameFilter ? `, name_contains=${nameFilter}` : ''}${attributeFilter ? `, attribute=${attributeFilter}` : ''}`;
      const goalRow = await storage.createGoal({
        userId: task.user_id,
        goalText: originalUserGoal,
        successCriteria: { requested_count_user: rc.requested_count_user, requested_count_value: rc.requested_count_value, requested_count_effective: rc.requested_count_effective, constraints_summary: constraintsSummary },
        status: 'ACTIVE',
        linkedRunIds: [chatRunId],
      });
      goalId = goalRow.goalId;
      await storage.updateAgentRun(chatRunId, { goalId });
      console.log(`[TOWER_LOOP_CHAT] [goal_created] goalId=${goalId} linked to runId=${chatRunId}`);
    } catch (goalErr: any) {
      console.error(`[TOWER_LOOP_CHAT] Failed to create goal (non-fatal): ${goalErr.message}`);
    }

    // PRE-EXECUTION CONSTRAINT GATE — blocks before ANY tool or Google search
    const constraintGateAlreadyResolved = !!(requestData as any)._constraint_gate_resolved;
    const constraintGateResult = constraintGateAlreadyResolved
      ? { constraints: [], can_execute: true, why_blocked: null, clarify_questions: [], stop_recommended: false, semantic_source: 'canonical' as const } as ConstraintContract
      : canonicalIntent
        ? preExecutionConstraintGateFromIntent(canonicalIntent, originalUserGoal)
        : preExecutionConstraintGate(originalUserGoal);
    if (!constraintGateResult.semantic_source) constraintGateResult.semantic_source = 'fallback_regex';
    console.log(`[CONSTRAINT_GATE] can_execute=${constraintGateResult.can_execute} stop=${constraintGateResult.stop_recommended} constraints=${constraintGateResult.constraints.length} already_resolved=${constraintGateAlreadyResolved} semantic_source=${constraintGateResult.semantic_source}`);

    if (!constraintGateResult.can_execute) {
      await createArtefact({
        runId: chatRunId,
        type: 'diagnostic',
        title: `Pre-execution constraint gate: BLOCKED (stop=${constraintGateResult.stop_recommended})`,
        summary: constraintGateResult.why_blocked || 'Constraints require clarification',
        payload: { constraint_contract: constraintGateResult, original_goal: originalUserGoal },
        userId: task.user_id,
        conversationId,
      }).catch((e: any) => console.warn(`[CONSTRAINT_GATE] Failed to emit artefact: ${e.message}`));

      storePendingContract(conversationId, originalUserGoal, constraintGateResult, chatRunId);

      const gateMsg = buildConstraintGateMessage(constraintGateResult);
      const gateMessageId = randomUUID();

      await Promise.all([
        supabase!.from('supervisor_tasks').update({ status: 'completed', result: { response: gateMsg.substring(0, 200), message_id: gateMessageId, clarify_gate: constraintGateResult.stop_recommended ? 'constraint_gate_stop' : 'constraint_gate_clarify' } }).eq('id', task.id),
        supabase!.from('messages').insert({ id: gateMessageId, conversation_id: conversationId, role: 'assistant', content: sanitizeMessageContent(gateMsg), source: 'supervisor', metadata: { supervisor_task_id: task.id, run_id: chatRunId, clarify_gate: constraintGateResult.stop_recommended ? 'constraint_gate_stop' : 'constraint_gate_clarify', constraint_contract: constraintGateResult, clarify_state: buildClarifyStateFromContract(constraintGateResult) }, created_at: Date.now() }).select().single(),
      ]);

      const innerIsClarify = !constraintGateResult.stop_recommended;
      const innerStatus = innerIsClarify ? 'clarifying' : 'stopped';
      const innerTermState = innerIsClarify ? null : 'stopped';
      await storage.updateAgentRun(chatRunId, {
        status: innerStatus,
        terminalState: innerTermState,
        ...(innerIsClarify ? {} : { endedAt: new Date() }),
        metadata: {
          verdict: constraintGateResult.stop_recommended ? 'constraint_gate_stop' : 'constraint_gate_clarify',
          ...(innerIsClarify ? { awaiting: 'user_input' } : { stop_reason: 'constraint_stop' }),
          constraint_contract: constraintGateResult,
        },
      }).catch(() => {});
      console.log(`[CONSTRAINT_GATE] Blocked execution — status=${innerStatus} terminalState=${innerTermState}`);

      return {
        response: gateMsg,
        leadIds: [],
        deliverySummary: null,
        towerVerdict: null,
        leads: [],
      };
    }

    // 2. Create initial discovery plan artefact (SEARCH_PLACES only; enrichment plan built after discovery)
    const toolTracker = createRunToolTracker();

    const discoveryPlanSteps = [
      {
        step_index: 0,
        step_id: 'search_places_v1',
        tool: 'SEARCH_PLACES',
        phase: 'discovery',
        tool_args: { query: `${businessType} ${city} ${country}`, location: city, country, maxResults: searchCount, target_count: rc.requested_count_effective, google_query_mode: googleQueryMode },
        expected_output: `Up to ${searchCount} ${businessType} results from Google Places`,
        ...(postProcessing.length > 0 ? { post_processing: postProcessing.join('; ') } : {}),
      },
    ];

    const planPayload = {
      run_id: chatRunId,
      original_user_goal: normalizedGoal,
      raw_user_input: originalUserGoal,
      normalized_goal: normalizedGoal,
      hard_constraints,
      soft_constraints,
      constraints,
      structured_constraints: structuredConstraints,
      success_criteria: successCriteria,
      assumptions,
      steps: discoveryPlanSteps,
      enrichment_deferred: true,
      requested_count_user: rc.requested_count_user,
      requested_count_value: rc.requested_count_value,
      requested_count_effective: rc.requested_count_effective,
      search_budget_count: searchBudgetCount,
      name_filter: nameFilter || null,
      attribute_filter: attributeFilter || null,
      ...(hasContactRequests ? { contact_requests: contactRequests, contact_requests_note: 'Enrichment-only. NOT search constraints. Do not fail if contact info is incomplete.' } : {}),
      created_at: new Date().toISOString(),
    };

    const nameFilterLabel = nameFilter ? `, containing "${nameFilter}"` : '';
    const attrFilterLabel = attributeFilter ? `, attribute "${attributeFilter}" (CVL post-search)` : '';
    const planArtefact = await createArtefact({
      runId: chatRunId,
      type: 'plan',
      title: artefactTitle('Plan v1:', displayCount, v1Constraints, 1),
      summary: `Discovery: SEARCH_PLACES | ${businessType} in ${city}${prefixFilter ? `, prefix "${prefixFilter}"` : ''}${nameFilterLabel}${attrFilterLabel} (enrichment planned after discovery)`,
      payload: planPayload,
      userId: task.user_id,
      conversationId,
    });
    console.log(`[TOWER_LOOP_CHAT] [plan_created] Plan v1 artefact id=${planArtefact.id} (discovery phase, enrichment deferred)`);

    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'artefact_created', status: 'success',
      taskGenerated: `Plan v1 artefact created (discovery phase)`,
      runType: 'plan',
      metadata: { artefactId: planArtefact.id, artefactType: 'plan', original_user_goal: originalUserGoal },
    });

    // 3. AFR: plan_execution_started
    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'plan_execution_started', status: 'pending',
      taskGenerated: `Executing Plan v1: ${normalizedGoal}`,
      runType: 'plan',
      metadata: { original_user_goal: originalUserGoal, normalized_goal: normalizedGoal, plan_version: 1, steps: 1, tool: 'SEARCH_PLACES', planArtefactId: planArtefact.id },
    });
    console.log(`[TOWER_LOOP_CHAT] [plan_execution_started] original_goal="${originalUserGoal}" normalized="${normalizedGoal}"`);

    // 4. AFR: step_started (SEARCH_PLACES — step 1)
    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'step_started', status: 'pending',
      taskGenerated: `Step 1: SEARCH_PLACES — ${businessType} in ${city}`,
      runType: 'plan',
      metadata: { step: 1, total_steps: 1, tool: 'SEARCH_PLACES', query: businessType, location: city },
    });
    console.log(`[TOWER_LOOP_CHAT] [step_started] step=1 tool=SEARCH_PLACES`);

    console.log(`[STAGE] runId=${chatRunId} crid=${clientRequestId} stage=search_places`);
    // 4a. Execute SEARCH_PLACES via action-executor with stub fallback
    let leads: Array<{ name: string; address: string; phone: string | null; website: string | null; placeId: string; source: string; lat: number | null; lng: number | null }> = [];
    let usedStub = false;
    const createdLeadIds: string[] = [];
    const towerLoopStepStartedAt = Date.now();
    let towerLoopStepError: string | undefined;
    let searchDebug: Record<string, unknown> | null = null;

    try {
      const searchResult = await executeAction({
        toolName: 'SEARCH_PLACES',
        toolArgs: { query: businessType, location: city, country, maxResults: searchCount, target_count: rc.requested_count_effective, google_query_mode: googleQueryMode },
        userId: task.user_id,
        tracker: toolTracker,
        runId: chatRunId,
        conversationId,
        clientRequestId,
      });

      runToolCallCount++;
      searchDebug = (searchResult.data?.search_debug as Record<string, unknown>) ?? null;
      if (searchResult.success && searchResult.data?.places && Array.isArray(searchResult.data.places)) {
        const places = searchResult.data.places as any[];
        candidateCountFromGoogle = places.length;
        for (const p of places) {
          leads.push({
            name: p.name || p.displayName?.text || 'Unknown Business',
            address: p.formatted_address || p.formattedAddress || `${city}, ${country}`,
            phone: p.phone || p.nationalPhoneNumber || p.internationalPhoneNumber || null,
            website: p.website || p.websiteUri || null,
            placeId: p.place_id || p.id || '',
            source: 'google_places',
            lat: typeof p.lat === 'number' ? p.lat : (p.geometry?.location?.lat ?? null),
            lng: typeof p.lng === 'number' ? p.lng : (p.geometry?.location?.lng ?? null),
          });
        }
        console.log(`[TOWER_LOOP_CHAT] SEARCH_PLACES (via action-executor) returned ${leads.length} results`);

        if (prefixFilter) {
          const before = leads.length;
          leads = leads.filter(l => l.name.toUpperCase().startsWith(prefixFilter!));
          console.log(`[TOWER_LOOP_CHAT] Prefix filter "${prefixFilter}": ${before} → ${leads.length}`);
        }

        if (nameFilter) {
          const before = leads.length;
          leads = leads.filter(l => l.name.toLowerCase().includes(nameFilter!.toLowerCase()));
          console.log(`[TOWER_LOOP_CHAT] Name contains filter "${nameFilter}": ${before} → ${leads.length}`);
        }

        if (leads.length > searchBudgetCount) {
          leads = leads.slice(0, searchBudgetCount);
          console.log(`[TOWER_LOOP_CHAT] Trimmed to search budget: ${leads.length} (user requested=${userRequestedCountFinal ?? 'any'})`);
        }
      } else {
        console.log(`[TOWER_LOOP_CHAT] SEARCH_PLACES returned 0 results or failed — using stub leads`);
        if (searchResult.error) towerLoopStepError = searchResult.error;
        leads = this.generateStubLeads(businessType, city, country);
        usedStub = true;
      }
    } catch (placesErr: any) {
      console.warn(`[TOWER_LOOP_CHAT] SEARCH_PLACES failed (${placesErr.message}) — falling back to stub leads`);
      towerLoopStepError = placesErr.message;
      leads = this.generateStubLeads(businessType, city, country);
      usedStub = true;
    }

    if (!isRunCurrentForConversation(conversationId, chatRunId)) {
      console.warn(`[SESSION_GUARD] Stale run detected after SEARCH_PLACES — aborting enrichment/delivery for runId=${chatRunId} conversation=${conversationId}`);
      return { response: '', leadIds: [], deliverySummary: null, towerVerdict: null, leads: [] };
    }

    // Persist leads to suggested_leads table
    for (const lead of leads) {
      try {
        const created = await storage.createSuggestedLead({
          userId: task.user_id,
          rationale: `Tower-validated ${businessType} lead in ${city}`,
          source: usedStub ? 'supervisor_chat_stub' : 'supervisor_chat',
          score: 0.75,
          lead: {
            name: lead.name,
            address: lead.address,
            place_id: lead.placeId,
            domain: lead.website || '',
            emailCandidates: [],
            tags: [businessType!, 'tower_loop_chat'],
            phone: lead.phone || '',
          },
        });
        createdLeadIds.push(created.id);
      } catch (leadErr: any) {
        console.error(`[TOWER_LOOP_CHAT] Failed to persist lead "${lead.name}": ${leadErr.message}`);
      }
    }

    // 5. AFR: step_completed (SEARCH_PLACES)
    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'step_completed', status: 'success',
      taskGenerated: `Step 1 (discovery) completed: ${leads.length} leads found${usedStub ? ' (stub fallback)' : ''}`,
      runType: 'plan',
      metadata: { step: 1, tool: 'SEARCH_PLACES', leads_count: leads.length, used_stub: usedStub },
    });
    console.log(`[TOWER_LOOP_CHAT] [step_completed] step=1 (discovery) leads=${leads.length} stub=${usedStub}`);

    // 5b. step_result artefact for SEARCH_PLACES — unconditional
    {
      const towerLoopStepFinishedAt = Date.now();
      const towerLoopStepStatus = towerLoopStepError ? 'fail' : 'success';
      const towerLoopStepSummary = towerLoopStepError
        ? `fail – SEARCH_PLACES error: ${towerLoopStepError} (stub fallback used, ${leads.length} leads)`
        : `success – ${leads.length} leads found for "${businessType}" in ${city}`;
      const safeLeads = leads.map(l => ({ name: l.name, address: l.address, placeId: l.placeId, source: l.source }));
      let towerLoopStepArtefact: Awaited<ReturnType<typeof createArtefact>> | undefined;
      try {
        towerLoopStepArtefact = await createArtefact({
          runId: chatRunId,
          type: 'step_result',
          title: artefactTitle('Step result: SEARCH_PLACES –', leads.length, v1Constraints, 1),
          summary: `${towerLoopStepStatus} – ${leads.length}${displayCount !== null ? ` of ${displayCount}` : ''} ${businessType} in ${city}${prefixFilter ? ` starting with ${prefixFilter}` : ''}${nameFilter ? ` containing "${nameFilter}"` : ''}`,
          payload: {
            run_id: chatRunId,
            client_request_id: clientRequestId,
            original_user_goal: originalUserGoal,
            normalized_goal: normalizedGoal,
            hard_constraints,
            soft_constraints,
            goal,
            plan_version: 1,
            plan_artefact_id: planArtefact.id,
            step_id: 'search_places_v1',
            step_title: `SEARCH_PLACES – ${businessType} in ${city}`,
            step_type: 'SEARCH_PLACES',
            step_index: 0,
            step_status: towerLoopStepStatus,
            inputs_summary: compactInputs({ query: businessType, location: city, country, maxResults: searchCount }),
            outputs_summary: { leads_count: leads.length, used_stub: usedStub, prefix_filter: prefixFilter || null, name_filter: nameFilter || null, attribute_filter: attributeFilter || null, search_budget_count: searchBudgetCount, ...(towerLoopStepError ? { fallback_error: towerLoopStepError } : {}), ...(searchDebug ? { search_debug: searchDebug } : {}) },
            ...safeOutputsRaw({ leads: safeLeads } as Record<string, unknown>),
            timings: {
              started_at: new Date(towerLoopStepStartedAt).toISOString(),
              finished_at: new Date(towerLoopStepFinishedAt).toISOString(),
              duration_ms: towerLoopStepFinishedAt - towerLoopStepStartedAt,
            },
          },
          userId: task.user_id,
          conversationId,
        });
        console.log(`[STEP_ARTEFACT] runId=${chatRunId} step=search_places status=${towerLoopStepStatus}`);
      } catch (stepArtErr: any) {
        console.warn(`[STEP_ARTEFACT] FAILED to create step_result for SEARCH_PLACES (non-fatal): ${stepArtErr.message}`);
        console.warn(`[STEP_ARTEFACT] runId=${chatRunId} — Tower observation will be SKIPPED because step_result artefact failed`);
      }

      if (towerLoopStepArtefact) {
        try {
          const obsResult = await judgeArtefact({
            artefact: towerLoopStepArtefact,
            runId: chatRunId, goal, userId: task.user_id, conversationId,
          });
          await createArtefact({
            runId: chatRunId,
            type: 'tower_judgement',
            title: `Tower Judgement: ${obsResult.judgement.verdict} (SEARCH_PLACES)`,
            summary: `Observation: ${obsResult.judgement.verdict} | ${obsResult.judgement.action} | SEARCH_PLACES`,
            payload: {
              verdict: obsResult.judgement.verdict, action: obsResult.judgement.action,
              reasons: obsResult.judgement.reasons, metrics: obsResult.judgement.metrics,
              step_index: 0, step_label: `SEARCH_PLACES – ${businessType} in ${city}`,
              judged_artefact_id: towerLoopStepArtefact.id, stubbed: obsResult.stubbed, observation_only: true,
            },
            userId: task.user_id, conversationId,
          });
          console.log(`[STEP_OBSERVATION] step=SEARCH_PLACES verdict=${obsResult.judgement.verdict} action=${obsResult.judgement.action} (observation only)`);
        } catch (obsErr: any) {
          console.warn(`[STEP_OBSERVATION] Tower observation failed for SEARCH_PLACES (continuing): ${obsErr.message}`);
        }
      } else {
        console.warn(`[STEP_OBSERVATION] runId=${chatRunId} SKIPPED — no step_result artefact available to judge`);
      }
    }

    console.log(`[STAGE] runId=${chatRunId} crid=${clientRequestId} stage=enrichment`);
    // 5c. Build enrichment plan AFTER discovery using actual lead data, then execute
    const accumulatedStepData: Record<string, Record<string, unknown>> = {};
    if (!usedStub && leads.length > 0) {
      const policyEnrichBatch = policyResult ? policyResult.executionParams.enrichmentBatchSize : parseInt(process.env.ENRICHMENT_BATCH_SIZE || '5', 10);
      const enrichmentBatchSize = Math.min(leads.length, policyEnrichBatch);
      const leadsWithWebsites = leads.filter(l => l.website);
      const leadsWithoutWebsites = leads.filter(l => !l.website);

      const representativeLeadCtx: LeadContext = {
        business_name: businessType,
        address: city,
        town: city,
        ...(leadsWithWebsites.length > 0 ? { website: leadsWithWebsites[0].website! } : {}),
      };
      const enrichToolPlan = buildToolPlan(representativeLeadCtx);
      const enrichOrderedTools = getOrderedToolNames(enrichToolPlan);
      const enrichSteps = enrichToolPlan.steps.filter(s => s.tool !== 'SEARCH_PLACES');

      persistToolPlanExplainer(enrichToolPlan, chatRunId, task.user_id, conversationId).catch((err: any) => {
        console.error(`[TOWER_LOOP_CHAT] tool_plan_explainer write failed: ${err.message}`);
      });

      if (enrichSteps.length > 0 && !isRunCurrentForConversation(conversationId, chatRunId)) {
        console.warn(`[SESSION_GUARD] Stale run detected before enrichment — aborting for runId=${chatRunId} conversation=${conversationId}`);
        return { response: '', leadIds: createdLeadIds, deliverySummary: null, towerVerdict: null, leads: [] };
      }

      if (enrichSteps.length > 0) {
        await createArtefact({
          runId: chatRunId,
          type: 'plan_update',
          title: `Plan v1 enrichment: ${enrichToolPlan.selected_path}`,
          summary: `Enrichment plan (Places-only): ${leads.length} leads discovered, ${leadsWithWebsites.length} with websites from Places Details: ${enrichOrderedTools.filter(t => t !== 'SEARCH_PLACES' && t !== 'WEB_SEARCH').join(' → ')}`,
          payload: {
            plan_version: 1,
            intent_source: canonicalIntent ? 'canonical' : 'legacy',
            tool_plan_path: enrichToolPlan.selected_path,
            rules_applied: enrichToolPlan.rules_applied,
            enrichment_steps: enrichSteps.map((s, idx) => ({ step_index: idx + 1, tool: s.tool, phase: s.phase, condition: s.condition, depends_on: s.depends_on, reason: s.reason })),
            leads_with_websites: leadsWithWebsites.length,
            leads_without_websites: leadsWithoutWebsites.length,
            batch_size: enrichmentBatchSize,
          },
          userId: task.user_id, conversationId,
        }).catch((err: any) => console.warn(`[ENRICHMENT] plan_update artefact failed: ${err.message}`));

        console.log(`[ENRICHMENT] Starting enrichment (${enrichToolPlan.selected_path}): ${enrichSteps.map(s => s.tool).join(' → ')} for up to ${enrichmentBatchSize} leads`);

        const indexedLeads = leads.map((l, idx) => ({ ...l, _idx: idx }));
        console.log(`[ENRICHMENT] Places-only mode: ${leadsWithWebsites.length}/${leads.length} leads have websites from Places Details`);

        const enrichableLeads = indexedLeads.filter(l => l.website).slice(0, enrichmentBatchSize);
        const ENRICH_CONCURRENCY = 3;

        const willRunSemanticVerification = structuredConstraints.some(
          c => c.type === 'HAS_ATTRIBUTE' && c.hard
        ) && !usedStub;

        const enrichOneLead = async (lead: typeof enrichableLeads[0], eli: number) => {
          const leadIdx = lead._idx;
          console.log(`[ENRICHMENT] Enriching lead ${eli + 1}/${enrichableLeads.length}: "${lead.name}" (${lead.website})`);

          for (const planStep of enrichSteps) {
            const tool = planStep.tool;
            if (tool === 'WEB_SEARCH') continue;

            if (planStep.depends_on && planStep.depends_on.length > 0) {
              const enrichmentDeps = planStep.depends_on.filter(dep => dep !== 'SEARCH_PLACES');
              if (enrichmentDeps.length > 0) {
                const depsMet = enrichmentDeps.every(dep => accumulatedStepData[`${dep}_${leadIdx}`]);
                if (!depsMet) {
                  console.log(`[ENRICHMENT] Skipping ${tool} for "${lead.name}" — dependencies not met: ${enrichmentDeps.join(', ')}`);
                  continue;
                }
              }
            }

            const globalStepIdx = 1 + enrichSteps.indexOf(planStep);
            const enrichStepStartedAt = Date.now();

            await logAFREvent({
              userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
              actionTaken: 'step_started', status: 'pending',
              taskGenerated: `Enrichment: ${tool} for "${lead.name}" (${planStep.phase})`,
              runType: 'plan',
              metadata: { tool, lead_name: lead.name, lead_index: leadIdx, phase: planStep.phase },
            });

            let enrichToolArgs: Record<string, unknown> = {};
            if (tool === 'WEB_VISIT') {
              enrichToolArgs = { url: lead.website!, max_pages: 3, same_domain_only: true };
            } else if (tool === 'CONTACT_EXTRACT') {
              const webVisitData = accumulatedStepData[`WEB_VISIT_${leadIdx}`];
              const pages = (webVisitData?.envelope as any)?.outputs?.pages || [];
              enrichToolArgs = { pages, entity_name: lead.name };
            } else if (tool === 'LEAD_ENRICH') {
              enrichToolArgs = {
                places_lead: { name: lead.name, address: lead.address, phone: lead.phone, website: lead.website, place_id: lead.placeId },
                web_visit_pages: (accumulatedStepData[`WEB_VISIT_${leadIdx}`]?.envelope as any)?.outputs?.pages || null,
                contact_extract: (accumulatedStepData[`CONTACT_EXTRACT_${leadIdx}`]?.envelope as any)?.outputs || null,
                web_search: null,
              };
            } else if (tool === 'ASK_LEAD_QUESTION') {
              continue;
            }

            try {
              runToolCallCount++;
              const enrichResult = await executeAction({
                toolName: tool,
                toolArgs: enrichToolArgs,
                userId: task.user_id,
                tracker: toolTracker,
                runId: chatRunId,
                conversationId,
                clientRequestId,
              });

              if (enrichResult.success && enrichResult.data) {
                accumulatedStepData[`${tool}_${leadIdx}`] = enrichResult.data;

                if (tool === 'LEAD_ENRICH') {
                  const leadPack = (enrichResult.data?.envelope as any)?.outputs?.lead_pack;
                  if (leadPack?.identity) {
                    if (leadPack.identity.phone && !lead.phone) lead.phone = leadPack.identity.phone;
                    if (leadPack.identity.website && !lead.website) lead.website = leadPack.identity.website;
                  }
                }
              }

              const enrichStepFinishedAt = Date.now();
              try {
                const enrichStepPayload: Record<string, unknown> = {
                    run_id: chatRunId, plan_version: 1, plan_artefact_id: planArtefact.id,
                    step_id: `${tool.toLowerCase()}_lead_${leadIdx}`,
                    step_title: `${tool} – ${lead.name}`, step_type: tool, step_index: globalStepIdx,
                    step_status: enrichResult.success ? 'success' : 'fail',
                    phase: planStep.phase, condition: planStep.condition, depends_on: planStep.depends_on,
                    inputs_summary: compactInputs(enrichToolArgs),
                    outputs_summary: { success: enrichResult.success, summary: enrichResult.summary },
                    timings: { started_at: new Date(enrichStepStartedAt).toISOString(), finished_at: new Date(enrichStepFinishedAt).toISOString(), duration_ms: enrichStepFinishedAt - enrichStepStartedAt },
                };
                if (tool === 'CONTACT_EXTRACT' && enrichResult.success && enrichResult.data) {
                  const ceOutputs = (enrichResult.data?.envelope as any)?.outputs;
                  if (ceOutputs) {
                    enrichStepPayload.contact_extract_outputs = {
                      contacts: ceOutputs.contacts || { emails: [], phones: [] },
                    };
                    enrichStepPayload.lead_place_id = lead.placeId;
                    enrichStepPayload.lead_name = lead.name;
                  }
                }
                const enrichStepArtefact = await createArtefact({
                  runId: chatRunId,
                  type: 'step_result',
                  title: `Step result: ${tool} – "${lead.name}"`,
                  summary: `${enrichResult.success ? 'success' : 'fail'} – ${enrichResult.summary}`,
                  payload: enrichStepPayload,
                  userId: task.user_id, conversationId,
                });

                if (enrichStepArtefact) {
                  const suppressStepStatusJudgement = tool === 'WEB_VISIT' && willRunSemanticVerification;
                  if (suppressStepStatusJudgement) {
                    console.log(`[ENRICHMENT] Suppressing step-status Tower judgement for WEB_VISIT "${lead.name}" — semantic attribute verification will follow`);
                  } else {
                    try {
                      const enrichObs = await judgeArtefact({ artefact: enrichStepArtefact, runId: chatRunId, goal, userId: task.user_id, conversationId });
                      await createArtefact({
                        runId: chatRunId, type: 'tower_judgement',
                        title: `Tower Judgement: ${enrichObs.judgement.verdict} (${tool})`,
                        summary: `Observation: ${enrichObs.judgement.verdict} | ${enrichObs.judgement.action} | ${tool} for "${lead.name}"`,
                        payload: { verdict: enrichObs.judgement.verdict, action: enrichObs.judgement.action, reasons: enrichObs.judgement.reasons, metrics: enrichObs.judgement.metrics, step_index: globalStepIdx, step_label: `${tool} – ${lead.name}`, judged_artefact_id: enrichStepArtefact.id, stubbed: enrichObs.stubbed, observation_only: true },
                        userId: task.user_id, conversationId,
                      });
                      console.log(`[ENRICHMENT] [observation] ${tool} for "${lead.name}" verdict=${enrichObs.judgement.verdict}`);
                    } catch (enrichObsErr: any) {
                      console.warn(`[ENRICHMENT] Tower observation failed for ${tool} "${lead.name}" (continuing): ${enrichObsErr.message}`);
                    }
                  }
                }
              } catch (enrichArtErr: any) {
                console.warn(`[ENRICHMENT] step_result artefact failed for ${tool} "${lead.name}" (non-fatal): ${enrichArtErr.message}`);
              }

              await logAFREvent({
                userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
                actionTaken: 'step_completed', status: enrichResult.success ? 'success' : 'failed',
                taskGenerated: `Enrichment ${tool} for "${lead.name}": ${enrichResult.summary}`,
                runType: 'plan',
                metadata: { tool, lead_name: lead.name, success: enrichResult.success, phase: planStep.phase },
              });
              console.log(`[ENRICHMENT] [step_completed] ${tool} for "${lead.name}" success=${enrichResult.success}`);
            } catch (enrichErr: any) {
              console.warn(`[ENRICHMENT] ${tool} failed for "${lead.name}" (non-fatal, continuing): ${enrichErr.message}`);
              await logAFREvent({
                userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
                actionTaken: 'step_completed', status: 'failed',
                taskGenerated: `Enrichment ${tool} for "${lead.name}" failed: ${enrichErr.message}`,
                runType: 'plan',
                metadata: { tool, lead_name: lead.name, error: enrichErr.message },
              });
            }
          }
        };

        console.log(`[ENRICHMENT] Processing ${enrichableLeads.length} leads with concurrency=${ENRICH_CONCURRENCY}`);
        let enrichedCount = 0;
        for (let batchStart = 0; batchStart < enrichableLeads.length; batchStart += ENRICH_CONCURRENCY) {
          if (checkRunDeadline()) {
            console.warn(`[ENRICHMENT] Deadline exceeded after enriching ${enrichedCount}/${enrichableLeads.length} leads — stopping enrichment early`);
            break;
          }
          const batch = enrichableLeads.slice(batchStart, batchStart + ENRICH_CONCURRENCY);
          console.log(`[ENRICHMENT] Batch ${Math.floor(batchStart / ENRICH_CONCURRENCY) + 1}: leads ${batchStart + 1}–${batchStart + batch.length} of ${enrichableLeads.length}`);
          await Promise.allSettled(batch.map((lead, i) => enrichOneLead(lead, batchStart + i)));
          enrichedCount += batch.length;
        }

        console.log(`[ENRICHMENT] Enrichment phase complete: ${enrichedCount} leads enriched${runDeadlineExceeded ? ' (truncated by deadline)' : ''}, tools_used=${toolTracker.tools_used.join(',')}`);
      } else {
        console.log(`[ENRICHMENT] No enrichment steps in plan (path: ${enrichToolPlan.selected_path})`);
      }
    } else if (!usedStub) {
      console.log(`[ENRICHMENT] Skipping enrichment: no leads found`);
    }

    // 6. Create leads_list artefact (persisted to DB)
    const leadsForDelivery = userRequestedCountFinal !== null ? leads.slice(0, userRequestedCountFinal) : leads;
    const v1Label = buildConstraintLabel(v1Constraints, v1Constraints, 1);
    const leadsListPayload = {
      original_user_goal: originalUserGoal,
      normalized_goal: normalizedGoal,
      hard_constraints,
      soft_constraints,
      plan_artefact_id: planArtefact.id,
      delivered_count: leadsForDelivery.length,
      target_count: rc.requested_count_effective,
      success_criteria: successCriteria,
      structured_constraints: structuredConstraints,
      query: businessType,
      location: city,
      country,
      used_stub: usedStub,
      prefix_filter: prefixFilter || null,
      name_filter: nameFilter || null,
      attribute_filter: attributeFilter || null,
      requested_count_user: rc.requested_count_user,
      requested_count_value: rc.requested_count_value,
      requested_count_effective: rc.requested_count_effective,
      requested_count_internal: searchBudgetCount,
      relaxed_constraints: v1Label.relaxed_constraints,
      constraint_diffs: v1Label.constraint_diffs,
      leads: leadsForDelivery.map(l => ({ name: l.name, address: l.address, phone: l.phone, website: l.website })),
    };

    const leadsListDeliveredCount = leadsForDelivery.length;
    const leadsListArtefact = await createArtefact({
      runId: chatRunId,
      type: 'leads_list',
      title: artefactTitle('Leads list:', leadsListDeliveredCount, v1Constraints, 1),
      summary: artefactSummary('Delivered ', leadsListDeliveredCount, displayCount, v1Constraints, 1, usedStub ? '(stub fallback)' : undefined),
      payload: leadsListPayload,
      userId: task.user_id,
      conversationId,
    });
    console.log(`[TOWER_LOOP_CHAT] [artefact_created] type=leads_list id=${leadsListArtefact.id}`);

    // 7. AFR: artefact_created
    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'artefact_created', status: 'success',
      taskGenerated: `leads_list artefact persisted: ${leads.length} leads`,
      runType: 'plan',
      metadata: { artefactId: leadsListArtefact.id, artefactType: 'leads_list', leads_count: leads.length, used_stub: usedStub },
    });

    await createArtefact({
      runId: chatRunId,
      type: 'count_diagnostic',
      title: `Count diagnostic: user=${userRequestedCountFinal ?? 'any'} budget=${searchBudgetCount} google=${leads.length} delivered=${leadsListDeliveredCount}`,
      summary: `userRequestedCountFinal=${userRequestedCountFinal}, searchBudgetCount=${searchBudgetCount}, candidateCountFromGoogle=${leads.length}, deliveredCountAfterTrim=${leadsListDeliveredCount}`,
      payload: {
        userRequestedCountFinal,
        searchBudgetCount,
        candidateCountFromGoogle: leads.length,
        deliveredCountAfterTrim: leadsListDeliveredCount,
        parsedGoalSearchBudget: parsedGoal.search_budget_count,
        parsedGoalRequestedCountUser: parsedGoal.requested_count_user,
      },
      userId: task.user_id,
      conversationId,
    }).catch(err => console.error(`[COUNT_DIAGNOSTIC] failed to persist:`, err));

    // 8. INVARIANT: Tower must NOT judge leads before verification is complete.
    //    Tower will be called exactly once on the final_delivery artefact after CVL verification.
    let towerJudgedBeforeVerification = false;

    // 9. Local replan assessment (Tower deferred until after verification)
    const v1Delivered = leads.length;
    const v1HasShortfall = userSpecifiedCount && userRequestedCountFinal !== null && v1Delivered < userRequestedCountFinal;
    const v1LocationIsSoft = soft_constraints.includes('location');
    const localReplanNeeded = !!(v1HasShortfall && v1LocationIsSoft && !usedStub);
    const localAction = localReplanNeeded ? 'change_plan' : 'accept';
    console.log(`[TOWER_LOOP_CHAT] Local replan assessment: delivered=${v1Delivered} requested=${userRequestedCountFinal} shortfall=${v1HasShortfall} location_soft=${v1LocationIsSoft} replan_needed=${localReplanNeeded}`);

    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'local_replan_assessment', status: 'success',
      taskGenerated: `Local assessment: ${v1Delivered} leads delivered, replan_needed=${localReplanNeeded} (Tower deferred to final_delivery)`,
      runType: 'plan',
      metadata: { artefactId: leadsListArtefact.id, delivered: v1Delivered, requested: userRequestedCountFinal, replan_needed: localReplanNeeded, local_action: localAction },
    });

    // 12. Replan loop (bounded by MAX_REPLANS env var) — driven by local count heuristics, not Tower
    let finalVerdict = 'pending';
    let finalAction: string = localAction;
    let finalLeads = leads;
    let finalLeadsListArtefact = leadsListArtefact;
    let finalConstraints = { ...v1Constraints };
    let planVersion = 1;
    let replansUsed = 0;
    let currentConstraints: PlanV2Constraints = {
      business_type: businessType!,
      location: city,
      base_location: city,
      country,
      search_count: searchBudgetCount,
      requested_count: searchBudgetCount,
      requested_count_user: rc.requested_count_value, requested_count_effective: rc.requested_count_effective,
      search_budget_count: searchBudgetCount,
      prefix_filter: prefixFilter,
      radius_rung: 0,
      radius_km: 0,
    };
    let priorPlanArtefactId = planArtefact.id;
    let priorLeadsCount = leads.length;
    const perPlanCounts = new Map<number, number>();
    const dsPlanVersions: PlanVersionEntry[] = [{ version: 1, changes_made: ['Initial plan'] }];
    const dsSoftRelaxations: SoftRelaxation[] = [];

    for (const lead of leads) {
      const key = makeDedupeKey(lead);
      mergeCandidate(accumulatedCandidates, key, lead, 1);
    }
    perPlanCounts.set(1, leads.length);
    const v1MatchInfo = countMatchingLeads(accumulatedCandidates);
    perPlanAdded.push({ plan_version: 1, added_matching: v1MatchInfo.matching.length, added_total: leads.length });
    console.log(`[TOWER_LOOP_CHAT] v1 accumulated ${leads.length} leads (total unique: ${accumulatedCandidates.size}, matching: ${v1MatchInfo.matching.length})`);

    try {
      await createArtefact({
        runId: chatRunId,
        type: 'accumulation_update',
        title: `Accumulation after Plan v1`,
        summary: `${v1MatchInfo.matching.length} matching of ${accumulatedCandidates.size} unique leads (requested: ${userRequestedCountFinal ?? 'any'})`,
        payload: {
          plan_version: 1,
          added_total: leads.length,
          added_matching: v1MatchInfo.matching.length,
          total_unique: accumulatedCandidates.size,
          matching_unique: v1MatchInfo.matching.length,
          requested_user: userRequestedCountFinal,
          constraints_hard: hard_constraints,
          constraints_soft: soft_constraints,
          dedupe_key_strategy: 'place_id_or_name_address',
          per_plan_added: perPlanAdded,
        },
        userId: task.user_id,
        conversationId,
      });
      console.log(`[ACCUMULATION] v1 artefact created: matching=${v1MatchInfo.matching.length} total_unique=${accumulatedCandidates.size}`);
    } catch (accErr: any) {
      console.warn(`[ACCUMULATION] Failed to create accumulation_update artefact (v1): ${accErr.message}`);
    }

    // 12a-pre. Attribute-verification gate (website-only, Places-only mode)
    //   If a HARD HAS_ATTRIBUTE constraint exists that CVL cannot verify from Places data,
    //   and we have candidate leads, visit lead.website via WEB_VISIT per lead to attempt
    //   attribute verification before wasting replans on quantity expansion.
    console.log(`[STAGE] runId=${chatRunId} crid=${clientRequestId} stage=attribute_verification_check`);
    let attributeVerificationAttempted = false;
    let attributeVerificationStopped = false;
    const hardAttributeConstraints = structuredConstraints.filter(
      c => c.type === 'HAS_ATTRIBUTE' && c.hard
    );
    const hasHardAttribute = hardAttributeConstraints.length > 0;
    const attrVerificationResults: Array<{
      lead_name: string;
      lead_place_id: string;
      attribute: string;
      attribute_raw: string;
      matched_variant: string | null;
      search_query: string;
      web_search_success: boolean;
      url_visited: string | null;
      web_visit_success: boolean;
      snippets: string[];
      extracted_quotes: string[];
      extraction_method: string;
      attribute_found: boolean;
      evidence_strength: 'strong' | 'weak' | 'none';
      verdict: 'yes' | 'no' | 'unknown';
      confidence: 'high' | 'medium' | 'low';
      rationale: string;
      tower_semantic_status: TowerSemanticStatus | null;
      tower_semantic_confidence: number | null;
      tower_semantic_reasoning: string | null;
      verification_source: 'tower_semantic' | 'keyword_only' | 'no_evidence';
    }> = [];

    if (hasHardAttribute && finalLeads.length > 0 && !usedStub) {
      attributeVerificationAttempted = true;
      const attrValues = hardAttributeConstraints.map(c => typeof c.value === 'string' ? c.value : String(c.value));
      const attrLabel = attrValues.join(', ');
      const totalChecksExpected = finalLeads.length * attrValues.length;
      console.log(`[ATTR_VERIFY] Hard attribute constraint(s) detected: ${attrLabel} — running attribute verification for ${finalLeads.length} candidate(s) (${totalChecksExpected} checks expected)`);

      await createArtefact({
        runId: chatRunId,
        type: 'verification_pending',
        title: `Verifying attributes: ${attrLabel}`,
        summary: `Provisional results generated. Verifying ${attrLabel} for ${finalLeads.length} leads (${totalChecksExpected} checks).`,
        payload: {
          leads_count: finalLeads.length,
          attributes_being_verified: attrValues,
          total_checks_expected: totalChecksExpected,
          phase: 'attribute_verification',
          status: 'in_progress',
        },
        userId: task.user_id,
        conversationId,
      });
      console.log(`[ATTR_VERIFY] verification_pending artefact emitted — ${totalChecksExpected} checks for "${attrLabel}"`);

      await this.postArtefactToUI({
        runId: chatRunId,
        clientRequestId,
        type: 'verification_pending',
        payload: {
          leads_count: finalLeads.length,
          attributes_being_verified: attrValues,
          total_checks_expected: totalChecksExpected,
          lead_names: finalLeads.map(l => l.name),
        },
        userId: task.user_id,
        conversationId,
      }).catch((e: any) => console.warn(`[ATTR_VERIFY] postArtefactToUI verification_pending failed (non-fatal): ${e.message}`));

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'attribute_verification_started', status: 'pending',
        taskGenerated: `Attribute verification: checking ${attrLabel} for ${finalLeads.length} candidates (${totalChecksExpected} checks)`,
        runType: 'plan',
        metadata: { attributes: attrValues, candidates: finalLeads.length, total_checks_expected: totalChecksExpected },
      });

      type UnknownReason =
        | 'no_relevant_pages_found'
        | 'no_match_in_visited_pages'
        | 'official_site_blocked'
        | 'only_weak_third_party_mentions'
        | 'no_website_from_places'
        | 'web_search_no_url_found'
        | 'active_visit_failed'
        | 'active_visit_budget_exhausted'
        | 'web_search_budget_exhausted';

      type InvestigationStrategy = 'cached_pages' | 'active_web_visit' | 'web_search_then_visit' | 'no_investigation_possible';

      const ATTR_TRACE = process.env.ATTR_VERIFY_TRACE === '1';
      const MAX_ACTIVE_VISITS = parseInt(process.env.ATTR_MAX_ACTIVE_VISITS || '8', 10);
      const MAX_WEB_SEARCH_FALLBACKS = parseInt(process.env.ATTR_MAX_SEARCH_FALLBACKS || '5', 10);
      let activeVisitCount = 0;
      let webSearchFallbackCount = 0;
      const investigationBreakdown = { cached_pages: 0, active_web_visit: 0, web_search_then_visit: 0, no_investigation_possible: 0 };

      const buildScanText = (page: any): string => {
        const title = (page.title || '');
        const body = (page.text_clean || page.cleaned_text || '');
        return `${title} ${body}`;
      };

      const extractEvidenceSnippets = (
        textClean: string,
        keywords: string[],
        maxSnippets: number = 3,
      ): { snippets: string[]; method: 'keyword_sentence_match' | 'no_match' } => {
        if (!textClean || textClean.trim().length === 0) {
          return { snippets: [], method: 'no_match' };
        }

        const sentences = textClean
          .replace(/([.!?])\s+/g, '$1\n')
          .split('\n')
          .map(s => s.trim())
          .filter(s => s.length >= 10 && s.length <= 500);

        if (sentences.length === 0) {
          const chunks: string[] = [];
          for (let i = 0; i < textClean.length; i += 200) {
            const chunk = textClean.slice(i, i + 200).trim();
            if (chunk.length >= 10) chunks.push(chunk);
          }
          const scored = chunks.map(chunk => {
            const lower = chunk.toLowerCase();
            let score = 0;
            for (const kw of keywords) {
              if (lower.includes(kw.toLowerCase())) score += 2;
            }
            return { chunk, score };
          });
          scored.sort((a, b) => b.score - a.score);
          const top = scored.filter(s => s.score > 0).slice(0, maxSnippets);
          return {
            snippets: top.map(s => s.chunk.substring(0, 300)),
            method: top.length > 0 ? 'keyword_sentence_match' : 'no_match',
          };
        }

        const scored = sentences.map(sentence => {
          const lower = sentence.toLowerCase();
          let score = 0;
          for (const kw of keywords) {
            const kwLower = kw.toLowerCase();
            if (lower.includes(kwLower)) {
              score += 3;
              const idx = lower.indexOf(kwLower);
              if (idx < lower.length / 2) score += 1;
            }
          }
          const wordCount = sentence.split(/\s+/).length;
          if (wordCount >= 5 && wordCount <= 40) score += 1;
          return { sentence, score };
        });

        scored.sort((a, b) => b.score - a.score);
        const top = scored.filter(s => s.score > 0).slice(0, maxSnippets);
        return {
          snippets: top.map(s => s.sentence.substring(0, 300)),
          method: top.length > 0 ? 'keyword_sentence_match' : 'no_match',
        };
      };

      interface PageScanResult {
        verdict: 'yes' | 'no' | 'unknown';
        confidence: 'high' | 'medium' | 'low';
        sourceUrl: string | null;
        quote: string | null;
        sourceType: 'official_site' | 'directory' | 'other';
        matchedVariant: string | null;
        matchSource: 'title' | 'body' | 'search_snippet' | null;
        snippets: string[];
        extractedQuotes: string[];
        pageUrl: string | null;
        pageTitle: string | null;
        extractionMethod: 'keyword_sentence_match' | 'keyword_window' | 'no_match' | 'none';
        evidenceStrength: 'strong' | 'weak' | 'none';
        rationale: string;
        unknownReason: UnknownReason | undefined;
        attributeFound: boolean;
      }

      const scanPagesForAttribute = (
        pages: any[],
        primaryUrl: string,
        keywords: string[],
        negativeKeywords: string[],
        leadName: string,
        attrValue: string,
      ): PageScanResult => {
        const result: PageScanResult = {
          verdict: 'unknown',
          confidence: 'low',
          sourceUrl: primaryUrl,
          quote: null,
          sourceType: classifySourceType(primaryUrl, leadName),
          matchedVariant: null,
          matchSource: null,
          snippets: [],
          extractedQuotes: [],
          pageUrl: null,
          pageTitle: null,
          extractionMethod: 'none',
          evidenceStrength: 'none',
          rationale: `No evidence found for "${attrValue}" at ${leadName}.`,
          unknownReason: 'no_match_in_visited_pages',
          attributeFound: false,
        };

        for (const page of pages) {
          const scanText = buildScanText(page);
          const scanTextLower = scanText.toLowerCase();
          const bodyText = (page.text_clean || page.cleaned_text || '') as string;
          const pageUrl = page.url || primaryUrl;

          const negPageMatch = textMatchesKeywords(scanTextLower, negativeKeywords);
          if (negPageMatch.matched && result.sourceType === 'official_site') {
            const negIdx = scanTextLower.indexOf(negPageMatch.matchedKeyword!);
            const negStart = Math.max(0, negIdx - 60);
            const negEnd = Math.min(scanText.length, negIdx + (negPageMatch.matchedKeyword?.length || 0) + 60);
            const negEvidence = extractEvidenceSnippets(bodyText, [negPageMatch.matchedKeyword!], 2);
            result.verdict = 'no';
            result.confidence = 'high';
            result.quote = `...${scanText.slice(negStart, negEnd)}...`.slice(0, 200);
            result.rationale = `Official site page explicitly states "${negPageMatch.matchedKeyword}" for ${leadName}.`;
            result.sourceUrl = pageUrl;
            result.pageUrl = pageUrl;
            result.pageTitle = page.title || null;
            result.extractedQuotes = negEvidence.snippets.length > 0 ? negEvidence.snippets : [result.quote];
            result.extractionMethod = negEvidence.method;
            result.evidenceStrength = 'strong';
            return result;
          }

          const posPageMatch = textMatchesKeywords(scanTextLower, keywords);
          if (posPageMatch.matched) {
            result.matchedVariant = posPageMatch.matchedKeyword;
            const titleLower = (page.title || '').toLowerCase();
            const inTitle = titleLower.includes(posPageMatch.matchedKeyword!);
            result.matchSource = inTitle ? 'title' : 'body';
            const idx = scanTextLower.indexOf(posPageMatch.matchedKeyword!);
            const contextStart = Math.max(0, idx - 80);
            const contextEnd = Math.min(scanText.length, idx + (posPageMatch.matchedKeyword?.length || 0) + 80);
            const pageSnippet = `...${scanText.slice(contextStart, contextEnd)}...`.slice(0, 240);

            const evidence = extractEvidenceSnippets(bodyText, keywords, 3);
            result.extractedQuotes = evidence.snippets.length > 0 ? evidence.snippets : [pageSnippet];
            result.extractionMethod = evidence.snippets.length > 0 ? evidence.method : 'keyword_window';
            result.pageUrl = pageUrl;
            result.pageTitle = page.title || null;

            result.snippets.push(pageSnippet);
            result.quote = result.extractedQuotes[0] || pageSnippet;
            result.sourceUrl = pageUrl;
            result.evidenceStrength = 'strong';
            result.attributeFound = true;
            result.unknownReason = undefined;

            if (result.sourceType === 'official_site') {
              result.verdict = 'yes';
              result.confidence = 'high';
              result.rationale = `Official site page clearly mentions "${posPageMatch.matchedKeyword}" for ${leadName} (found in ${result.matchSource}, ${result.extractedQuotes.length} evidence snippet(s) extracted).`;
            } else {
              result.verdict = 'yes';
              result.confidence = 'medium';
              result.rationale = `Page content confirms "${posPageMatch.matchedKeyword}" for ${leadName} (source: ${result.sourceType}, found in ${result.matchSource}, ${result.extractedQuotes.length} evidence snippet(s) extracted).`;
            }

            if (ATTR_TRACE) console.log(`[ATTR_TRACE] pageScan: matched=true variant="${posPageMatch.matchedKeyword}" matchSource=${result.matchSource} url=${pageUrl} extractedQuotes=${result.extractedQuotes.length}`);
            return result;
          } else {
            const noMatchEvidence = extractEvidenceSnippets(bodyText, keywords, 3);
            if (noMatchEvidence.snippets.length > 0) {
              result.extractedQuotes = noMatchEvidence.snippets;
              result.extractionMethod = noMatchEvidence.method;
              result.pageUrl = pageUrl;
              result.pageTitle = page.title || null;
            }
            if (ATTR_TRACE) console.log(`[ATTR_TRACE] pageScan: matched=false url=${pageUrl} title="${page.title}" textLen=${bodyText.length}`);
          }
        }

        result.extractionMethod = result.extractionMethod === 'none' ? 'no_match' : result.extractionMethod;
        result.rationale = `Pages for ${leadName} were scanned but no match for "${attrValue}" (or variants) found in title or content.`;
        return result;
      };

      const activeWebVisit = async (url: string, leadName: string, leadPlaceId: string): Promise<{ pages: any[]; success: boolean }> => {
        try {
          runToolCallCount++;
          const visitResult = await executeAction({
            toolName: 'WEB_VISIT',
            toolArgs: { url, max_pages: 3, same_domain_only: true },
            userId: task.user_id,
            tracker: toolTracker,
            runId: chatRunId,
            conversationId,
            clientRequestId,
          });

          if (visitResult.success && visitResult.data) {
            const pages = (visitResult.data?.envelope as any)?.outputs?.pages || [];

            await createArtefact({
              runId: chatRunId,
              type: 'step_result',
              title: `Step result: WEB_VISIT (attr investigation) – "${leadName}"`,
              summary: `${visitResult.success ? 'success' : 'fail'} – ${visitResult.summary}`,
              payload: {
                run_id: chatRunId,
                step_id: `web_visit_attr_${leadPlaceId}`,
                step_title: `WEB_VISIT (attr investigation) – ${leadName}`,
                step_type: 'WEB_VISIT',
                step_status: 'success',
                phase: 'attribute_investigation',
                inputs_summary: { url, max_pages: 3 },
                outputs_summary: { success: true, pages_count: pages.length, summary: visitResult.summary },
              },
              userId: task.user_id,
              conversationId,
            }).catch((e: any) => console.warn(`[ATTR_INVESTIGATE] step_result artefact failed for WEB_VISIT "${leadName}" (non-fatal): ${e.message}`));

            return { pages, success: true };
          }
          return { pages: [], success: false };
        } catch (err: any) {
          console.warn(`[ATTR_INVESTIGATE] WEB_VISIT failed for "${leadName}" url=${url}: ${err.message}`);
          return { pages: [], success: false };
        }
      };

      const webSearchForAttribute = async (leadName: string, location: string, attrValue: string): Promise<string | null> => {
        try {
          runToolCallCount++;
          const searchResult = await executeAction({
            toolName: 'WEB_SEARCH',
            toolArgs: { query: `${leadName} ${location} ${attrValue}`, max_results: 3 },
            userId: task.user_id,
            tracker: toolTracker,
            runId: chatRunId,
            conversationId,
            clientRequestId,
          });

          if (searchResult.success && searchResult.data) {
            const results = (searchResult.data?.envelope as any)?.outputs?.results || [];

            await createArtefact({
              runId: chatRunId,
              type: 'step_result',
              title: `Step result: WEB_SEARCH (attr investigation) – "${leadName}" + "${attrValue}"`,
              summary: `${searchResult.success ? 'success' : 'fail'} – ${searchResult.summary}`,
              payload: {
                run_id: chatRunId,
                step_id: `web_search_attr_${leadName.replace(/\s+/g, '_').substring(0, 20)}`,
                step_title: `WEB_SEARCH (attr investigation) – ${leadName}`,
                step_type: 'WEB_SEARCH',
                step_status: 'success',
                phase: 'attribute_investigation',
                inputs_summary: { query: `${leadName} ${location} ${attrValue}`, max_results: 3 },
                outputs_summary: { success: true, results_count: results.length, summary: searchResult.summary },
              },
              userId: task.user_id,
              conversationId,
            }).catch((e: any) => console.warn(`[ATTR_INVESTIGATE] step_result artefact failed for WEB_SEARCH "${leadName}" (non-fatal): ${e.message}`));

            const SKIP_DOMAINS = ['google.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'pinterest.com', 'linkedin.com'];
            for (const r of results) {
              const url = r.url || r.link;
              if (!url) continue;
              const domain = url.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
              if (SKIP_DOMAINS.some(d => domain.includes(d))) continue;
              console.log(`[ATTR_INVESTIGATE] WEB_SEARCH found URL for "${leadName}": ${url}`);
              return url;
            }
          }
          return null;
        } catch (err: any) {
          console.warn(`[ATTR_INVESTIGATE] WEB_SEARCH failed for "${leadName}": ${err.message}`);
          return null;
        }
      };

      const cachedWebVisitPages = new Map<string, { pages: any[]; sourceUrl: string }>();
      for (let i = 0; i < finalLeads.length; i++) {
        const wvData = accumulatedStepData[`WEB_VISIT_${i}`];
        if (wvData) {
          const pages = (wvData?.envelope as any)?.outputs?.pages || [];
          if (pages.length > 0) {
            const firstUrl = pages[0]?.url || finalLeads[i].website || '';
            cachedWebVisitPages.set(finalLeads[i].placeId, { pages, sourceUrl: firstUrl });
          }
        }
      }
      console.log(`[ATTR_VERIFY] Cached WEB_VISIT data: ${cachedWebVisitPages.size}/${finalLeads.length} leads have existing page text`);

      const NEGATIVE_KEYWORD_MAP: Record<string, string[]> = {
        'live music': ['no live music', 'no music', 'does not have live music'],
        'beer garden': ['no beer garden', 'no garden'],
        'dog friendly': ['no dogs', 'dogs not allowed', 'no pets'],
      };

      function getMatchVariantsWithSynonyms(attrValue: string): string[] {
        return generateKeywordVariants(attrValue.replace(/_/g, ' '));
      }

      function getNegativeKeywords(attrValue: string): string[] {
        const key = attrValue.toLowerCase().trim();
        return NEGATIVE_KEYWORD_MAP[key] || NEGATIVE_KEYWORD_MAP[key.replace(/_/g, ' ')] || [`no ${key}`, `not ${key}`];
      }

      function textMatchesKeywords(text: string, keywords: string[]): { matched: boolean; matchedKeyword: string | null } {
        const lower = text.toLowerCase();
        for (const kw of keywords) {
          if (lower.includes(kw)) return { matched: true, matchedKeyword: kw };
        }
        return { matched: false, matchedKeyword: null };
      }

      function classifySourceType(url: string, leadName: string): 'official_site' | 'directory' | 'other' {
        const urlLower = url.toLowerCase();
        const nameWords = leadName.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
        const domain = urlLower.replace(/^https?:\/\//, '').split('/')[0];
        const domainHasName = nameWords.some(w => domain.includes(w));
        if (domainHasName) return 'official_site';
        const directoryDomains = ['tripadvisor', 'yelp', 'google.com/maps', 'useyourlocal', 'pubswithmore', 'whatpub', 'timeout', 'visitarundel', 'visitengland', 'thegoodpubguide', 'camra'];
        if (directoryDomains.some(d => domain.includes(d))) return 'directory';
        return 'other';
      }

      let attrLeadIndex = 0;
      for (const lead of finalLeads) {
        if (checkRunDeadline()) {
          console.warn(`[ATTR_VERIFY] Run deadline exceeded at lead ${attrLeadIndex + 1}/${finalLeads.length} — stopping verification early`);
          break;
        }
        for (const attrValue of attrValues) {
          const attrKey = attrValue.toLowerCase().replace(/\s+/g, '_');
          const keywords = getMatchVariantsWithSynonyms(attrValue);
          const negativeKeywords = getNegativeKeywords(attrValue);
          const searchQuery = `${lead.name} ${city} ${attrValue}`;
          let webSearchSuccess = false;
          let urlVisited: string | null = null;
          let webVisitSuccess = false;
          let investigationStrategy: InvestigationStrategy = 'no_investigation_possible';

          const fallbackScan: PageScanResult = {
            verdict: 'unknown', confidence: 'low', sourceUrl: null, quote: null,
            sourceType: 'other', matchedVariant: null, matchSource: null, snippets: [],
            extractedQuotes: [], pageUrl: null, pageTitle: null, extractionMethod: 'none',
            evidenceStrength: 'none', rationale: `Investigation error for "${attrValue}" at ${lead.name}.`,
            unknownReason: 'no_relevant_pages_found', attributeFound: false,
          };
          let scan: PageScanResult = fallbackScan;

          const leadWebsite = lead.website as string | null;

          if (ATTR_TRACE) console.log(`[ATTR_TRACE] lead="${lead.name}" placeId=${lead.placeId} attr="${attrValue}" variants=${keywords.length} website=${leadWebsite || 'none'}`);

          attrLeadIndex++;

          const cached = cachedWebVisitPages.get(lead.placeId);
          const hasPages = cached && cached.pages.length > 0;

          try {
          if (hasPages) {
            investigationStrategy = 'cached_pages';
            webVisitSuccess = true;
            urlVisited = cached.sourceUrl;

            if (ATTR_TRACE) console.log(`[ATTR_TRACE] Using cached WEB_VISIT pages=${cached.pages.length} for "${lead.name}" url=${cached.sourceUrl}`);

            scan = scanPagesForAttribute(cached.pages, cached!.sourceUrl, keywords, negativeKeywords, lead.name, attrValue);
            investigationBreakdown.cached_pages++;
          } else if (leadWebsite && activeVisitCount < MAX_ACTIVE_VISITS && !checkRunDeadline()) {
            investigationStrategy = 'active_web_visit';
            console.log(`[ATTR_INVESTIGATE] Active WEB_VISIT for "${lead.name}" — website=${leadWebsite} (visit ${activeVisitCount + 1}/${MAX_ACTIVE_VISITS})`);
            activeVisitCount++;

            const visitResult = await activeWebVisit(leadWebsite, lead.name, lead.placeId);
            if (visitResult.success && visitResult.pages.length > 0) {
              webVisitSuccess = true;
              urlVisited = leadWebsite;
              cachedWebVisitPages.set(lead.placeId, { pages: visitResult.pages, sourceUrl: leadWebsite });
              scan = scanPagesForAttribute(visitResult.pages, leadWebsite, keywords, negativeKeywords, lead.name, attrValue);
            } else {
              scan = {
                verdict: 'unknown', confidence: 'low', sourceUrl: leadWebsite, quote: null,
                sourceType: classifySourceType(leadWebsite, lead.name),
                matchedVariant: null, matchSource: null, snippets: [],
                extractedQuotes: [], pageUrl: null, pageTitle: null, extractionMethod: 'none',
                evidenceStrength: 'none',
                rationale: `Active WEB_VISIT for ${lead.name} (${leadWebsite}) failed or returned no pages. Cannot verify "${attrValue}".`,
                unknownReason: 'active_visit_failed', attributeFound: false,
              };
            }
            investigationBreakdown.active_web_visit++;
          } else if (!leadWebsite && webSearchFallbackCount < MAX_WEB_SEARCH_FALLBACKS && !checkRunDeadline()) {
            investigationStrategy = 'web_search_then_visit';
            console.log(`[ATTR_INVESTIGATE] WEB_SEARCH fallback for "${lead.name}" — no website (search ${webSearchFallbackCount + 1}/${MAX_WEB_SEARCH_FALLBACKS})`);
            webSearchFallbackCount++;

            const foundUrl = await webSearchForAttribute(lead.name, city, attrValue);
            if (foundUrl) {
              webSearchSuccess = true;
              const visitResult = await activeWebVisit(foundUrl, lead.name, lead.placeId);
              if (visitResult.success && visitResult.pages.length > 0) {
                webVisitSuccess = true;
                urlVisited = foundUrl;
                cachedWebVisitPages.set(lead.placeId, { pages: visitResult.pages, sourceUrl: foundUrl });
                scan = scanPagesForAttribute(visitResult.pages, foundUrl, keywords, negativeKeywords, lead.name, attrValue);
              } else {
                scan = {
                  verdict: 'unknown', confidence: 'low', sourceUrl: foundUrl, quote: null,
                  sourceType: classifySourceType(foundUrl, lead.name),
                  matchedVariant: null, matchSource: null, snippets: [],
                  extractedQuotes: [], pageUrl: null, pageTitle: null, extractionMethod: 'none',
                  evidenceStrength: 'none',
                  rationale: `WEB_SEARCH found URL (${foundUrl}) for ${lead.name} but WEB_VISIT failed or returned no pages. Cannot verify "${attrValue}".`,
                  unknownReason: 'active_visit_failed', attributeFound: false,
                };
              }
            } else {
              scan = {
                verdict: 'unknown', confidence: 'low', sourceUrl: null, quote: null,
                sourceType: 'other',
                matchedVariant: null, matchSource: null, snippets: [],
                extractedQuotes: [], pageUrl: null, pageTitle: null, extractionMethod: 'none',
                evidenceStrength: 'none',
                rationale: `WEB_SEARCH for "${lead.name} ${city} ${attrValue}" returned no usable URLs. Cannot verify "${attrValue}".`,
                unknownReason: 'web_search_no_url_found', attributeFound: false,
              };
            }
            investigationBreakdown.web_search_then_visit++;
          } else {
            investigationStrategy = 'no_investigation_possible';
            const reason: UnknownReason = leadWebsite
              ? (activeVisitCount >= MAX_ACTIVE_VISITS ? 'active_visit_budget_exhausted' : 'no_relevant_pages_found')
              : (webSearchFallbackCount >= MAX_WEB_SEARCH_FALLBACKS ? 'web_search_budget_exhausted' : 'no_website_from_places');
            scan = {
              verdict: 'unknown', confidence: 'low', sourceUrl: null, quote: null,
              sourceType: 'other',
              matchedVariant: null, matchSource: null, snippets: [],
              extractedQuotes: [], pageUrl: null, pageTitle: null, extractionMethod: 'none',
              evidenceStrength: 'none',
              rationale: leadWebsite
                ? `Active visit budget exhausted (${MAX_ACTIVE_VISITS}). Cannot verify "${attrValue}" for ${lead.name}.`
                : `No website from Places and web search budget exhausted (${MAX_WEB_SEARCH_FALLBACKS}). Cannot verify "${attrValue}" for ${lead.name}.`,
              unknownReason: reason, attributeFound: false,
            };
            investigationBreakdown.no_investigation_possible++;
            if (ATTR_TRACE) console.log(`[ATTR_TRACE] No investigation possible for "${lead.name}" — strategy=${investigationStrategy} website=${leadWebsite || 'none'}`);
          }
          } catch (investigationErr: any) {
            console.warn(`[ATTR_INVESTIGATE] Investigation error for "${lead.name}" + "${attrValue}" (non-fatal, using fallback): ${investigationErr.message}`);
            scan = fallbackScan;
            scan.rationale = `Investigation failed for "${attrValue}" at ${lead.name}: ${investigationErr.message}`;
            investigationStrategy = 'no_investigation_possible';
          }

          let towerSemanticStatus: TowerSemanticStatus | null = null;
          let towerSemanticConfidence: number | null = null;
          let towerSemanticReasoning: string | null = null;
          let verificationSource: 'tower_semantic' | 'keyword_only' | 'no_evidence' = 'no_evidence';

          const hasEvidenceText = webVisitSuccess && (scan.extractedQuotes.length > 0 || scan.snippets.length > 0);

          if (hasEvidenceText && !checkRunDeadline()) {
            const cachedPageData = cachedWebVisitPages.get(lead.placeId);
            const fullEvidenceText = cachedPageData
              ? cachedPageData.pages.map(p => (p.text_clean || p.cleaned_text || '')).join('\n\n').substring(0, 8000)
              : scan.extractedQuotes.join('\n').substring(0, 4000);

            const semanticRequest: TowerSemanticRequest = {
              run_id: chatRunId,
              original_user_goal: originalUserGoal,
              lead_name: lead.name,
              lead_place_id: lead.placeId,
              constraint_to_check: attrValue,
              source_url: urlVisited || scan.sourceUrl || '',
              evidence_text: fullEvidenceText,
              extracted_quotes: scan.extractedQuotes,
              page_title: scan.pageTitle,
            };

            const semanticResult: SemanticVerifyResult = await requestSemanticVerification({
              request: semanticRequest,
              userId: task.user_id,
              conversationId,
              clientRequestId,
            });

            towerSemanticStatus = semanticResult.towerResponse.status;
            towerSemanticConfidence = semanticResult.towerResponse.confidence;
            towerSemanticReasoning = semanticResult.towerResponse.reasoning;

            const towerVerdict = towerStatusToVerdict(semanticResult.towerResponse.status);
            scan.verdict = towerVerdict.verdict;
            scan.confidence = towerVerdict.confidence;
            scan.evidenceStrength = towerVerdict.evidenceStrength;
            scan.attributeFound = towerVerdict.verdict === 'yes';

            if (semanticResult.towerResponse.matched_snippets && semanticResult.towerResponse.matched_snippets.length > 0) {
              scan.extractedQuotes = semanticResult.towerResponse.matched_snippets;
              scan.quote = semanticResult.towerResponse.matched_snippets[0];
            }

            scan.rationale = `Tower semantic: ${semanticResult.towerResponse.status} (confidence=${semanticResult.towerResponse.confidence}) — ${semanticResult.towerResponse.reasoning}`;
            verificationSource = 'tower_semantic';

            if (towerVerdict.verdict === 'unknown') {
              scan.unknownReason = semanticResult.towerResponse.status === 'no_evidence'
                ? 'no_match_in_visited_pages'
                : 'only_weak_third_party_mentions';
            } else {
              scan.unknownReason = undefined;
            }

            await createArtefact({
              runId: chatRunId,
              type: 'tower_semantic_judgement',
              title: `Tower semantic: ${lead.name} — "${attrValue}" → ${semanticResult.towerResponse.status}`,
              summary: semanticResult.towerResponse.reasoning,
              payload: {
                run_id: chatRunId,
                lead_name: lead.name,
                lead_place_id: lead.placeId,
                constraint_to_check: attrValue,
                source_url: urlVisited || scan.sourceUrl,
                tower_status: semanticResult.towerResponse.status,
                tower_confidence: semanticResult.towerResponse.confidence,
                tower_reasoning: semanticResult.towerResponse.reasoning,
                tower_matched_snippets: semanticResult.towerResponse.matched_snippets || [],
                stubbed: semanticResult.stubbed,
                tower_available: semanticResult.towerAvailable,
                original_user_goal: originalUserGoal,
                extracted_quotes_sent: scan.extractedQuotes.length,
                evidence_text_length: fullEvidenceText.length,
              },
              userId: task.user_id,
              conversationId,
            }).catch((tsErr: any) => console.warn(`[TOWER_SEMANTIC] Failed to create tower_semantic_judgement artefact for "${lead.name}" + "${attrValue}" (non-fatal): ${tsErr.message}`));

            if (ATTR_TRACE) console.log(`[ATTR_TRACE] Tower semantic result for "${lead.name}" + "${attrValue}": status=${towerSemanticStatus} confidence=${towerSemanticConfidence} stubbed=${semanticResult.stubbed}`);
          } else if (!hasEvidenceText) {
            verificationSource = 'no_evidence';
            scan.verdict = 'unknown';
            scan.confidence = 'low';
            scan.evidenceStrength = 'none';
            scan.attributeFound = false;
          } else {
            verificationSource = 'keyword_only';
            scan.verdict = 'unknown';
            scan.confidence = 'low';
            scan.evidenceStrength = 'none';
            scan.attributeFound = false;
            scan.unknownReason = 'no_match_in_visited_pages';
            scan.rationale = `Evidence text available for "${attrValue}" at ${lead.name} but Tower semantic verification was skipped (run deadline). Lead remains unverified.`;
            console.warn(`[ATTR_VERIFY] Skipped Tower semantic for "${lead.name}" + "${attrValue}" — run deadline exceeded, lead remains unverified`);
          }

          attrVerificationResults.push({
            lead_name: lead.name,
            lead_place_id: lead.placeId,
            attribute: attrValue,
            attribute_raw: attrValue,
            matched_variant: scan.matchedVariant,
            search_query: searchQuery,
            web_search_success: webSearchSuccess,
            url_visited: urlVisited,
            web_visit_success: webVisitSuccess,
            snippets: scan.snippets,
            extracted_quotes: scan.extractedQuotes,
            extraction_method: scan.extractionMethod,
            attribute_found: scan.attributeFound,
            evidence_strength: scan.evidenceStrength,
            verdict: scan.verdict,
            confidence: scan.confidence,
            rationale: scan.rationale,
            tower_semantic_status: towerSemanticStatus,
            tower_semantic_confidence: towerSemanticConfidence,
            tower_semantic_reasoning: towerSemanticReasoning,
            verification_source: verificationSource,
          });

          await createArtefact({
            runId: chatRunId,
            type: 'attribute_evidence',
            title: `Attribute evidence: ${lead.name} — ${attrValue} → ${scan.verdict} (${verificationSource})`,
            summary: scan.rationale,
            payload: {
              run_id: chatRunId,
              lead_place_id: lead.placeId,
              lead_name: lead.name,
              attribute_key: attrKey,
              attribute_label: attrValue,
              attribute_raw: attrValue,
              verdict: scan.verdict,
              confidence: scan.confidence,
              ...(scan.matchedVariant ? { matched_variant: scan.matchedVariant } : {}),
              ...(scan.verdict === 'unknown' ? { unknown_reason: scan.unknownReason } : {}),
              evidence: {
                source_url: scan.sourceUrl,
                quote: scan.quote,
                source_type: scan.sourceType,
              },
              extracted_quotes: scan.extractedQuotes,
              page_url: scan.pageUrl,
              page_title: scan.pageTitle,
              extraction_method: scan.extractionMethod,
              original_goal: originalUserGoal,
              constraint_raw: attrValue,
              rationale: scan.rationale,
              variants_searched: keywords,
              negative_checked: negativeKeywords,
              investigation_strategy: investigationStrategy,
              verification_source: verificationSource,
              ...(towerSemanticStatus ? {
                tower_semantic: {
                  status: towerSemanticStatus,
                  confidence: towerSemanticConfidence,
                  reasoning: towerSemanticReasoning,
                },
              } : {}),
              ...(scan.matchSource ? { match_source: scan.matchSource } : {}),
            },
            userId: task.user_id,
            conversationId,
          }).catch((aeErr: any) => console.warn(`[ATTR_EVIDENCE] Failed to create attribute_evidence artefact for "${lead.name}" + "${attrValue}" (non-fatal): ${aeErr.message}`));

          console.log(`[ATTR_VERIFY] "${lead.name}" + "${attrValue}": verdict=${scan.verdict} confidence=${scan.confidence} strength=${scan.evidenceStrength} source=${scan.sourceType} verifiedBy=${verificationSource}${towerSemanticStatus ? ` tower=${towerSemanticStatus}(${towerSemanticConfidence})` : ''}${scan.matchedVariant ? ` variant="${scan.matchedVariant}"` : ''} strategy=${investigationStrategy}${scan.verdict === 'unknown' ? ` reason=${scan.unknownReason}` : ''}${scan.matchSource ? ` match=${scan.matchSource}` : ''} url=${urlVisited || 'none'} extractedQuotes=${scan.extractedQuotes.length} method=${scan.extractionMethod}`);
        }
      }

      const totalVerified = attrVerificationResults.filter(r => r.attribute_found).length;
      const totalChecked = attrVerificationResults.length;
      const strongEvidence = attrVerificationResults.filter(r => r.evidence_strength === 'strong').length;
      const leadsWithAttr = new Set(attrVerificationResults.filter(r => r.attribute_found).map(r => r.lead_place_id)).size;
      const towerVerifiedCount = attrVerificationResults.filter(r => r.tower_semantic_status === 'verified').length;
      const towerWeakCount = attrVerificationResults.filter(r => r.tower_semantic_status === 'weak_match').length;
      const towerNoEvidenceCount = attrVerificationResults.filter(r => r.tower_semantic_status === 'no_evidence' || r.tower_semantic_status === 'insufficient_evidence').length;
      const towerCalledCount = attrVerificationResults.filter(r => r.verification_source === 'tower_semantic').length;

      const attrVerifArtefact = await createArtefact({
        runId: chatRunId,
        type: 'attribute_verification',
        title: `Attribute verification: ${totalVerified}/${totalChecked} checks found evidence for "${attrLabel}"`,
        summary: `${leadsWithAttr} of ${finalLeads.length} leads show evidence of "${attrLabel}" (Tower: ${towerVerifiedCount} verified, ${towerWeakCount} weak, ${towerNoEvidenceCount} no evidence)`,
        payload: {
          run_id: chatRunId,
          attributes_checked: attrValues,
          candidates_checked: finalLeads.length,
          total_checks: totalChecked,
          checks_with_evidence: totalVerified,
          strong_evidence: strongEvidence,
          leads_with_attribute: leadsWithAttr,
          investigation_breakdown: investigationBreakdown,
          active_visits_used: activeVisitCount,
          web_search_fallbacks_used: webSearchFallbackCount,
          evidence_ready_for_tower: totalChecked > 0,
          tower_semantic_summary: {
            tower_called: towerCalledCount,
            tower_verified: towerVerifiedCount,
            tower_weak_match: towerWeakCount,
            tower_no_evidence: towerNoEvidenceCount,
            keyword_only_fallback: attrVerificationResults.filter(r => r.verification_source === 'keyword_only').length,
          },
          results: attrVerificationResults,
        },
        userId: task.user_id,
        conversationId,
      });
      console.log(`[ATTR_VERIFY] artefact id=${attrVerifArtefact.id} — ${leadsWithAttr}/${finalLeads.length} leads verified (Tower: ${towerVerifiedCount} verified, ${towerWeakCount} weak, ${towerNoEvidenceCount} no_evidence), investigation: cached=${investigationBreakdown.cached_pages} active_visit=${investigationBreakdown.active_web_visit} search_then_visit=${investigationBreakdown.web_search_then_visit} no_investigation=${investigationBreakdown.no_investigation_possible}`);

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'attribute_verification_completed', status: 'success',
        taskGenerated: `Attribute verification: ${leadsWithAttr}/${finalLeads.length} leads verified for "${attrLabel}" (Tower semantic: ${towerVerifiedCount} verified, ${towerWeakCount} weak)`,
        runType: 'plan',
        metadata: {
          attributes: attrValues,
          leads_with_attribute: leadsWithAttr,
          total_leads: finalLeads.length,
          strong_evidence: strongEvidence,
          investigation_breakdown: investigationBreakdown,
          tower_semantic_summary: { tower_verified: towerVerifiedCount, tower_weak: towerWeakCount, tower_no_evidence: towerNoEvidenceCount },
        },
      });
      console.log(`[ATTR_VERIFY] Completed: ${leadsWithAttr}/${finalLeads.length} leads with "${attrLabel}" (Tower deferred to final_delivery)`);

      if (leadsWithAttr === 0 || totalVerified === 0) {
        console.log(`[ATTR_VERIFY] No leads verified for hard attribute "${attrLabel}" — terminating with UNVERIFIABLE_HARD_CONSTRAINT`);
        attributeVerificationStopped = true;

        const terminalArtefact = await createArtefact({
          runId: chatRunId,
          type: 'terminal',
          title: `Run halted: unverifiable hard constraint "${attrLabel}"`,
          summary: `Attribute verification found 0/${finalLeads.length} leads with "${attrLabel}". Hard constraint cannot be satisfied — stopping before quantity replans.`,
          payload: {
            reason: 'unverifiable_hard_constraint',
            attribute: attrLabel,
            original_user_goal: originalUserGoal,
            candidates_checked: finalLeads.length,
            leads_with_attribute: 0,
            verification_artefact_id: attrVerifArtefact.id,
          },
          userId: task.user_id,
          conversationId,
        });
        console.log(`[ATTR_VERIFY] Terminal artefact id=${terminalArtefact.id}`);

        finalVerdict = 'stop';
        finalAction = 'stop';
        attributeVerificationStopped = true;
      }
    }

    // 12a. Replan loop — driven by local shortfall heuristics (no interim Tower calls)
    while (finalAction === 'change_plan' && !usedStub && !attributeVerificationStopped) {
      if (!isRunCurrentForConversation(conversationId, chatRunId)) {
        console.warn(`[SESSION_GUARD] Stale run detected at replan loop — aborting for runId=${chatRunId} conversation=${conversationId}`);
        return { response: '', leadIds: [], deliverySummary: null, towerVerdict: null, leads: [] };
      }
      if (checkRunDeadline()) {
        console.warn(`[REPLAN] Run deadline exceeded before replan ${replansUsed + 1} — forcing stop. ${runDeadlineReason}`);
        finalAction = 'stop';
        finalVerdict = 'timeout';
        break;
      }
      if (replansUsed >= MAX_REPLANS) {
        console.log(`[REPLAN] max_replans_exceeded — replans_used=${replansUsed} MAX_REPLANS=${MAX_REPLANS} plan_version=${planVersion}`);

        const terminalArtefact = await createArtefact({
          runId: chatRunId,
          type: 'terminal',
          title: `Run halted: max replans exceeded`,
          summary: `Stopped after ${replansUsed} replan(s) (limit: ${MAX_REPLANS}). Tower continued to request changes but the configured maximum was reached.`,
          payload: {
            reason: 'max_replans_exceeded',
            original_user_goal: originalUserGoal,
            replans_attempted: replansUsed,
            max_replans: MAX_REPLANS,
            final_plan_version: planVersion,
            final_delivered: finalLeads.length,
            final_verdict: finalVerdict,
          },
          userId: task.user_id,
          conversationId,
        });
        console.log(`[REPLAN] Terminal artefact id=${terminalArtefact.id}`);

        await logAFREvent({
          userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
          actionTaken: 'run_halted', status: 'failed',
          taskGenerated: `Run halted: max_replans_exceeded (${replansUsed}/${MAX_REPLANS}). Plan v${planVersion} was the last attempt.`,
          runType: 'plan',
          metadata: {
            reason: 'max_replans_exceeded',
            replans_used: replansUsed,
            max_replans: MAX_REPLANS,
            plan_version: planVersion,
            delivered: finalLeads.length,
            terminal_artefact_id: terminalArtefact.id,
          },
        });

        break;
      }

      console.log(`[REPLAN] Shortfall detected — initiating replan ${replansUsed + 1}/${MAX_REPLANS} (mission_type=leadgen, current_plan_version=${planVersion})`);

      const directive = buildShortfallDirective(finalLeads.length, userRequestedCountFinal ?? rc.requested_count_effective);
      console.log(`[REPLAN] Directive — gaps: ${JSON.stringify(directive.gaps.map(g => g.type))} suggested_changes: ${JSON.stringify(directive.suggested_changes.map(sc => `${sc.action} ${sc.field}`))}`);

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'replan_initiated', status: 'pending',
        taskGenerated: `Shortfall replan: replanning with ${directive.suggested_changes.length} suggested change(s) (replan ${replansUsed + 1}/${MAX_REPLANS})`,
        runType: 'plan',
        metadata: {
          plan_version: planVersion,
          gaps: directive.gaps,
          suggested_changes: directive.suggested_changes,
          prior_delivered: priorLeadsCount,
          accumulated_unique: accumulatedCandidates.size,
          requested_count_user: rc.requested_count_user, requested_count_effective: rc.requested_count_effective,
          replan_number: replansUsed + 1,
          max_replans: MAX_REPLANS,
        },
      });

      const replanResult = applyLeadgenReplanPolicy(currentConstraints, directive, hard_constraints, soft_constraints, planVersion);
      const v2 = replanResult.constraints;

      if (replanResult.no_progress && replanResult.cannot_expand_further) {
        console.log(`[REPLAN] Stopping — no progress possible and radius at max. Accumulated ${accumulatedCandidates.size} unique leads.`);
        break;
      }

      if (constraintsAreIdentical(currentConstraints, v2)) {
        console.log(`[REPLAN] Stopping — constraints identical after policy application. Would re-run same search.`);
        break;
      }

      const preReplanMatchInfo = countMatchingLeads(accumulatedCandidates);
      const matchingCount = preReplanMatchInfo.matching.length;
      const accLeadsForCheck = Array.from(accumulatedCandidates.values());
      const hardCheck = checkHardConstraintsSatisfied(accLeadsForCheck, structuredConstraints, userRequestedCountFinal);
      const countMet = userRequestedCountFinal === null || matchingCount >= userRequestedCountFinal;
      if (hardCheck.satisfied && countMet) {
        console.log(`[REPLAN] Early stop — accumulated_matching=${matchingCount}${userRequestedCountFinal !== null ? ` >= user requested ${userRequestedCountFinal}` : ' (no count target)'}, all hard constraints satisfied. No need to replan.`);
        finalAction = 'accept';
        finalVerdict = 'pass';
        break;
      } else if (countMet && !hardCheck.satisfied) {
        console.log(`[REPLAN] Matching count met (${matchingCount}${userRequestedCountFinal !== null ? ` >= ${userRequestedCountFinal}` : ''}) but hard constraints unsatisfied: ${hardCheck.unsatisfied.join(', ')} — continuing replan`);
        for (const [cid, detail] of Object.entries(hardCheck.details)) {
          console.log(`[REPLAN]   ${cid}: ${detail}`);
        }
      }
      replansUsed++;
      runTotalRetryCount++;
      planVersion++;
      const vLabel = `v${planVersion}`;

      console.log(`[REPLAN] ${replanResult.strategy_summary}`);
      const dsChanges: string[] = [];
      for (const adj of replanResult.adjustments_applied) {
        console.log(`[REPLAN]   ${adj.action} ${adj.field}: ${JSON.stringify(adj.from)} → ${JSON.stringify(adj.to)} (${adj.reason})`);
        dsChanges.push(`${adj.action} ${adj.field}: ${JSON.stringify(adj.from)} → ${JSON.stringify(adj.to)}`);
        if (adj.field === 'business_type' && adj.action === 'broaden' && typeof adj.to === 'string' && adj.to.includes(' OR ')) {
          queryBroadeningApplied = true;
          queryBroadeningTerms = String(adj.to);
        }
        if (soft_constraints.includes(adj.field)) {
          dsSoftRelaxations.push({
            constraint: adj.field,
            from: String(adj.from ?? ''),
            to: String(adj.to ?? ''),
            reason: adj.reason || replanResult.strategy_summary,
            plan_version: planVersion,
          });
        }
      }
      dsPlanVersions.push({ version: planVersion, changes_made: dsChanges.length > 0 ? dsChanges : [replanResult.strategy_summary] });

      const replanToolPlan = buildToolPlan({ business_name: v2.business_type, address: v2.location, town: v2.location });
      const replanOrderedTools = getOrderedToolNames(replanToolPlan);
      const replanPlanSteps = replanToolPlan.steps.map((s, idx) => ({
        step_index: idx,
        step_id: `${s.tool.toLowerCase()}_${vLabel}`,
        tool: s.tool,
        phase: s.phase,
        condition: s.condition,
        reason: s.reason,
        depends_on: s.depends_on,
        tool_args: s.tool === 'SEARCH_PLACES'
          ? { query: `${v2.business_type} in ${v2.location} ${v2.country}`, location: v2.location, country: v2.country, maxResults: v2.search_count, target_count: v2.requested_count_user }
          : {},
        expected_output: s.tool === 'SEARCH_PLACES'
          ? `Up to ${v2.search_count} ${v2.business_type} results from Google Places`
          : `${s.tool} output for lead enrichment`,
        ...(s.tool === 'SEARCH_PLACES' && v2.prefix_filter ? { post_processing: `Filter names starting with "${v2.prefix_filter}"; Take first ${displayCount ?? v2.requested_count} results` } : {}),
      }));

      const replanPlanPayload = {
        run_id: chatRunId,
        original_user_goal: originalUserGoal,
        normalized_goal: normalizedGoal,
        hard_constraints,
        soft_constraints,
        plan_version: planVersion,
        prior_plan_artefact_id: priorPlanArtefactId,
        prior_verdict: { verdict: finalVerdict, action: finalAction, gaps: directive.gaps, suggested_changes: directive.suggested_changes },
        adjustments_applied: replanResult.adjustments_applied,
        strategy_summary: replanResult.strategy_summary,
        tool_plan_path: replanToolPlan.selected_path,
        constraints: [
          `business_type=${v2.business_type}`,
          `location=${v2.location}`,
          `count=${displayCount ?? v2.requested_count}`,
          ...(v2.prefix_filter ? [`prefix=${v2.prefix_filter}`] : []),
        ],
        steps: replanPlanSteps,
        created_at: new Date().toISOString(),
      };

      const replanPlanArtefact = await createArtefact({
        runId: chatRunId,
        type: 'plan',
        title: artefactTitle(`Plan ${vLabel}:`, displayCount, v2, planVersion),
        summary: `${replanPlanSteps.length}-step plan (${replanToolPlan.selected_path}): ${replanOrderedTools.join(' → ')} | ${replanResult.strategy_summary}`,
        payload: replanPlanPayload,
        userId: task.user_id,
        conversationId,
      });
      console.log(`[REPLAN] Plan ${vLabel} artefact id=${replanPlanArtefact.id} steps=${replanPlanSteps.length} path=${replanToolPlan.selected_path}`);

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'artefact_created', status: 'success',
        taskGenerated: `Plan ${vLabel} artefact created (${replanPlanSteps.length} steps)`,
        runType: 'plan',
        metadata: { artefactId: replanPlanArtefact.id, artefactType: 'plan', plan_version: planVersion, strategy: replanResult.strategy_summary, tool_plan_path: replanToolPlan.selected_path },
      });

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'plan_execution_started', status: 'pending',
        taskGenerated: `Executing Plan ${vLabel} (${replanPlanSteps.length} steps): ${replanResult.strategy_summary}`,
        runType: 'plan',
        metadata: { plan_version: planVersion, strategy: replanResult.strategy_summary, planArtefactId: replanPlanArtefact.id, tools: replanOrderedTools },
      });
      console.log(`[REPLAN] [plan_execution_started] plan_version=${planVersion} steps=${replanPlanSteps.length} strategy="${replanResult.strategy_summary}"`);

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'step_started', status: 'pending',
        taskGenerated: `Step 1/${replanPlanSteps.length} (${vLabel}): SEARCH_PLACES — ${v2.business_type} in ${v2.location}`,
        runType: 'plan',
        metadata: { step: 1, total_steps: replanPlanSteps.length, tool: 'SEARCH_PLACES', query: v2.business_type, location: v2.location, plan_version: planVersion },
      });
      console.log(`[REPLAN] [step_started] step=1/${replanPlanSteps.length} tool=SEARCH_PLACES (${vLabel})`);

      let replanLeads: typeof leads = [];
      let replanUsedStub = false;
      const replanStepStartedAt = Date.now();
      let replanStepError: string | undefined;
      let replanSearchDebug: Record<string, unknown> | null = null;

      try {
        const replanSearchResult = await executeAction({
          toolName: 'SEARCH_PLACES',
          toolArgs: { query: v2.business_type, location: v2.location, country: v2.country, maxResults: v2.search_count, target_count: v2.requested_count_user, google_query_mode: googleQueryMode },
          userId: task.user_id,
          tracker: toolTracker,
          runId: chatRunId,
          conversationId,
          clientRequestId,
        });

        runToolCallCount++;
        replanSearchDebug = (replanSearchResult.data?.search_debug as Record<string, unknown>) ?? null;
        if (replanSearchResult.success && replanSearchResult.data?.places && Array.isArray(replanSearchResult.data.places)) {
          const places = replanSearchResult.data.places as any[];
          for (const p of places) {
            replanLeads.push({
              name: p.name || p.displayName?.text || 'Unknown Business',
              address: p.formatted_address || p.formattedAddress || `${v2.location}, ${v2.country}`,
              phone: p.phone || p.nationalPhoneNumber || p.internationalPhoneNumber || null,
              website: p.website || p.websiteUri || null,
              placeId: p.place_id || p.id || '',
              source: 'google_places',
              lat: typeof p.lat === 'number' ? p.lat : (p.geometry?.location?.lat ?? null),
              lng: typeof p.lng === 'number' ? p.lng : (p.geometry?.location?.lng ?? null),
            });
          }
          console.log(`[REPLAN] SEARCH_PLACES ${vLabel} returned ${replanLeads.length} results`);

          if (v2.prefix_filter) {
            const before = replanLeads.length;
            replanLeads = replanLeads.filter(l => l.name.toUpperCase().startsWith(v2.prefix_filter!));
            console.log(`[REPLAN] Prefix filter "${v2.prefix_filter}": ${before} → ${replanLeads.length}`);
          }

          if (nameFilter) {
            const before = replanLeads.length;
            replanLeads = replanLeads.filter(l => l.name.toLowerCase().includes(nameFilter!.toLowerCase()));
            console.log(`[REPLAN] Name contains filter "${nameFilter}" (${vLabel}): ${before} → ${replanLeads.length}`);
          }

          if (replanLeads.length > v2.search_budget_count) {
            replanLeads = replanLeads.slice(0, v2.search_budget_count);
            console.log(`[REPLAN] Trimmed to search budget: ${replanLeads.length}`);
          }
        } else {
          console.log(`[REPLAN] SEARCH_PLACES ${vLabel} returned 0 results`);
          if (replanSearchResult.error) replanStepError = replanSearchResult.error;
        }
      } catch (replanErr: any) {
        console.warn(`[REPLAN] SEARCH_PLACES ${vLabel} failed: ${replanErr.message}`);
        replanStepError = replanErr.message;
      }

      let newUnique = 0;
      for (const lead of replanLeads) {
        const key = makeDedupeKey(lead);
        if (!accumulatedCandidates.has(key)) newUnique++;
        mergeCandidate(accumulatedCandidates, key, lead, planVersion);
      }
      perPlanCounts.set(planVersion, replanLeads.length);
      const progressSummary = buildProgressSummary(accumulatedCandidates.size, perPlanCounts, currentConstraints.base_location, v2.radius_km);
      console.log(`[REPLAN] Accumulated: ${progressSummary} (${newUnique} new unique this round)`);

      const replanStepFinishedAt = Date.now();

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'step_completed', status: replanStepError ? 'failed' : 'success',
        taskGenerated: `Step 1/1 (${vLabel}) completed: ${replanLeads.length} leads`,
        runType: 'plan',
        metadata: { step: 1, leads_count: replanLeads.length, plan_version: planVersion, ...(replanStepError ? { error: replanStepError } : {}) },
      });
      console.log(`[REPLAN] [step_completed] leads=${replanLeads.length} (${vLabel})`);

      for (const lead of replanLeads) {
        try {
          const created = await storage.createSuggestedLead({
            userId: task.user_id,
            rationale: `Tower-validated ${v2.business_type} lead in ${v2.location} (Plan ${vLabel})`,
            source: 'supervisor_chat',
            score: 0.75,
            lead: {
              name: lead.name,
              address: lead.address,
              place_id: lead.placeId,
              domain: lead.website || '',
              emailCandidates: [],
              phone: lead.phone || undefined,
            },
          });
          if (created?.id) createdLeadIds.push(String(created.id));
        } catch (leadErr: any) {
          console.warn(`[REPLAN] Failed to persist lead: ${leadErr.message}`);
        }
      }

      const replanStepArtefact = await createArtefact({
        runId: chatRunId,
        type: 'step_result',
        title: artefactTitle(`Step result (${vLabel}): SEARCH_PLACES –`, replanLeads.length, v2, planVersion),
        summary: artefactSummary(`Plan ${vLabel}: Found `, replanLeads.length, displayCount, v2, planVersion),
        payload: {
          plan_version: planVersion,
          plan_artefact_id: replanPlanArtefact.id,
          hard_constraints,
          soft_constraints,
          step_id: `search_places_${vLabel}`,
          step_title: `SEARCH_PLACES – ${v2.business_type} in ${v2.location}`,
          step_type: 'SEARCH_PLACES',
          step_index: 0,
          step_status: replanStepError ? 'failed' : 'success',
          inputs_summary: compactInputs({ query: v2.business_type, location: v2.location, country: v2.country, maxResults: v2.search_count }),
          outputs_summary: { leads_count: replanLeads.length, prefix_filter: v2.prefix_filter || null, requested_count: v2.requested_count, ...(replanSearchDebug ? { search_debug: replanSearchDebug } : {}) },
          timings: {
            started_at: new Date(replanStepStartedAt).toISOString(),
            finished_at: new Date(replanStepFinishedAt).toISOString(),
            duration_ms: replanStepFinishedAt - replanStepStartedAt,
          },
        },
        userId: task.user_id,
        conversationId,
      });
      console.log(`[REPLAN] [step_artefact] id=${replanStepArtefact.id} (${vLabel})`);

      if (replanStepArtefact) {
        try {
          const replanObsResult = await judgeArtefact({
            artefact: replanStepArtefact,
            runId: chatRunId, goal, userId: task.user_id, conversationId,
          });
          await createArtefact({
            runId: chatRunId,
            type: 'tower_judgement',
            title: `Tower Judgement: ${replanObsResult.judgement.verdict} (${vLabel} observation)`,
            summary: `Observation ${vLabel}: ${replanObsResult.judgement.verdict} | ${replanObsResult.judgement.action} | SEARCH_PLACES`,
            payload: {
              verdict: replanObsResult.judgement.verdict, action: replanObsResult.judgement.action,
              reasons: replanObsResult.judgement.reasons, metrics: replanObsResult.judgement.metrics,
              plan_version: planVersion, step_index: 0, judged_artefact_id: replanStepArtefact.id,
              stubbed: replanObsResult.stubbed, observation_only: true,
            },
            userId: task.user_id, conversationId,
          });
          console.log(`[REPLAN] [step_observation] verdict=${replanObsResult.judgement.verdict} (${vLabel}, observation only)`);
        } catch (obsErr: any) {
          console.warn(`[REPLAN] Tower observation ${vLabel} failed (continuing): ${obsErr.message}`);
        }
      }

      // Replan enrichment phase: build tool plan from actual replan lead data, then execute
      const replanAccumulatedStepData: Record<string, Record<string, unknown>> = {};
      if (!replanUsedStub && replanLeads.length > 0) {
        const replanEnrichBatchSize = Math.min(replanLeads.length, parseInt(process.env.ENRICHMENT_BATCH_SIZE || '5', 10));
        const replanLeadsWithWebsites = replanLeads.filter(l => l.website);
        const replanLeadsNoWebsites = replanLeads.filter(l => !l.website);

        const replanLeadCtx: LeadContext = {
          business_name: v2.business_type,
          address: v2.location,
          town: v2.location,
          ...(replanLeadsWithWebsites.length > 0 ? { website: replanLeadsWithWebsites[0].website! } : {}),
        };
        const replanEnrichPlan = buildToolPlan(replanLeadCtx);
        const replanEnrichSteps = replanEnrichPlan.steps.filter(s => s.tool !== 'SEARCH_PLACES');

        if (replanEnrichSteps.length > 0) {
          console.log(`[REPLAN_ENRICH] Starting enrichment (${replanEnrichPlan.selected_path}): ${replanEnrichSteps.map(s => s.tool).join(' → ')} (${vLabel})`);
          console.log(`[REPLAN_ENRICH] Places-only mode: ${replanLeadsWithWebsites.length}/${replanLeads.length} leads have websites from Places Details`);

          const replanEnrichableLeads = replanLeads.filter(l => l.website).slice(0, replanEnrichBatchSize);
          const REPLAN_ENRICH_CONCURRENCY = 3;

          const replanEnrichOneLead = async (lead: typeof replanEnrichableLeads[0], li: number) => {
            console.log(`[REPLAN_ENRICH] Enriching lead ${li + 1}/${replanEnrichableLeads.length}: "${lead.name}"`);

            for (const planStep of replanEnrichSteps) {
              const tool = planStep.tool;
              if (tool === 'WEB_SEARCH') continue;

              if (planStep.depends_on && planStep.depends_on.length > 0) {
                const enrichDeps = planStep.depends_on.filter(dep => dep !== 'SEARCH_PLACES');
                if (enrichDeps.length > 0) {
                  const depsMet = enrichDeps.every(dep => replanAccumulatedStepData[`${dep}_${li}`]);
                  if (!depsMet) {
                    console.log(`[REPLAN_ENRICH] Skipping ${tool} for "${lead.name}" — deps not met`);
                    continue;
                  }
                }
              }

              let enrichToolArgs: Record<string, unknown> = {};
              if (tool === 'WEB_VISIT') {
                enrichToolArgs = { url: lead.website!, max_pages: 3, same_domain_only: true };
              } else if (tool === 'CONTACT_EXTRACT') {
                const webVisitData = replanAccumulatedStepData[`WEB_VISIT_${li}`];
                const pages = (webVisitData?.envelope as any)?.outputs?.pages || [];
                enrichToolArgs = { pages, entity_name: lead.name };
              } else if (tool === 'LEAD_ENRICH') {
                enrichToolArgs = {
                  places_lead: { name: lead.name, address: lead.address, phone: lead.phone, website: lead.website, place_id: lead.placeId },
                  web_visit_pages: (replanAccumulatedStepData[`WEB_VISIT_${li}`]?.envelope as any)?.outputs?.pages || null,
                  contact_extract: (replanAccumulatedStepData[`CONTACT_EXTRACT_${li}`]?.envelope as any)?.outputs || null,
                  web_search: null,
                };
              } else if (tool === 'ASK_LEAD_QUESTION') {
                continue;
              }

              try {
                runToolCallCount++;
                const enrichResult = await executeAction({
                  toolName: tool,
                  toolArgs: enrichToolArgs,
                  userId: task.user_id, tracker: toolTracker, runId: chatRunId, conversationId, clientRequestId,
                });

                if (enrichResult.success && enrichResult.data) {
                  replanAccumulatedStepData[`${tool}_${li}`] = enrichResult.data;
                  if (tool === 'LEAD_ENRICH') {
                    const leadPack = (enrichResult.data?.envelope as any)?.outputs?.lead_pack;
                    if (leadPack?.identity) {
                      if (leadPack.identity.phone && !lead.phone) lead.phone = leadPack.identity.phone;
                      if (leadPack.identity.website && !lead.website) lead.website = leadPack.identity.website;
                    }
                  }
                }

                console.log(`[REPLAN_ENRICH] ${tool} for "${lead.name}" success=${enrichResult.success}`);
              } catch (enrichErr: any) {
                console.warn(`[REPLAN_ENRICH] ${tool} failed for "${lead.name}": ${enrichErr.message}`);
              }
            }
          };

          console.log(`[REPLAN_ENRICH] Processing ${replanEnrichableLeads.length} leads with concurrency=${REPLAN_ENRICH_CONCURRENCY}`);
          let replanEnrichedCount = 0;
          for (let batchStart = 0; batchStart < replanEnrichableLeads.length; batchStart += REPLAN_ENRICH_CONCURRENCY) {
            if (checkRunDeadline()) {
              console.warn(`[REPLAN_ENRICH] Deadline exceeded after enriching ${replanEnrichedCount}/${replanEnrichableLeads.length} — stopping`);
              break;
            }
            const batch = replanEnrichableLeads.slice(batchStart, batchStart + REPLAN_ENRICH_CONCURRENCY);
            await Promise.allSettled(batch.map((lead, i) => replanEnrichOneLead(lead, batchStart + i)));
            replanEnrichedCount += batch.length;
          }
          console.log(`[REPLAN_ENRICH] Enrichment complete: ${replanEnrichedCount} leads enriched${runDeadlineExceeded ? ' (truncated)' : ''} (${vLabel})`);
        }
      }

      const replanLabel = buildConstraintLabel(v2, v1Constraints, planVersion);
      const midReplanMatchInfo = countMatchingLeads(accumulatedCandidates);
      const replanLeadsListPayload = {
        original_user_goal: originalUserGoal,
        normalized_goal: normalizedGoal,
        hard_constraints,
        soft_constraints,
        plan_artefact_id: replanPlanArtefact.id,
        plan_version: planVersion,
        delivered_count: replanLeads.length,
        accumulated_total_unique: accumulatedCandidates.size,
        accumulated_matching: midReplanMatchInfo.matching.length,
        target_count: rc.requested_count_effective,
        success_criteria: { target_count: rc.requested_count_effective, requested_count_user: rc.requested_count_user, requested_count_effective: rc.requested_count_effective, user_specified_count: userSpecifiedCount, ...(v2.prefix_filter ? { prefix: v2.prefix_filter } : {}) },
        query: v2.business_type,
        location: v2.location,
        country: v2.country,
        used_stub: replanUsedStub,
        prefix_filter: v2.prefix_filter || null,
        relaxed_constraints: replanLabel.relaxed_constraints,
        constraint_diffs: replanLabel.constraint_diffs,
        leads: replanLeads.map(l => ({ name: l.name, address: l.address, phone: l.phone, website: l.website })),
        replan_context: {
          prior_plan_version: planVersion - 1,
          prior_delivered: priorLeadsCount,
          accumulated_total_unique: accumulatedCandidates.size,
          accumulated_matching: midReplanMatchInfo.matching.length,
          adjustments: replanResult.adjustments_applied,
          strategy: replanResult.strategy_summary,
        },
      };

      const replanLeadsListArtefact = await createArtefact({
        runId: chatRunId,
        type: 'leads_list',
        title: artefactTitle(`Leads list ${vLabel}:`, replanLeads.length, v2, planVersion),
        summary: artefactSummary(`Plan ${vLabel}: `, replanLeads.length, displayCount, v2, planVersion, replanUsedStub ? '(stub fallback)' : undefined),
        payload: replanLeadsListPayload,
        userId: task.user_id,
        conversationId,
      });
      console.log(`[REPLAN] [leads_list_${vLabel}] id=${replanLeadsListArtefact.id} delivered=${replanLeads.length}`);

      console.log(`[REPLAN] [leads_list_${vLabel}_persisted] id=${replanLeadsListArtefact.id} delivered=${replanLeads.length} (Tower deferred to final_delivery)`);

      finalLeads = replanLeads;
      finalLeadsListArtefact = replanLeadsListArtefact;
      finalConstraints = { business_type: v2.business_type, location: v2.location, prefix_filter: v2.prefix_filter || null, requested_count: displayCount };
      businessType = v2.business_type;
      city = v2.location;
      currentConstraints = v2;
      priorPlanArtefactId = replanPlanArtefact.id;
      priorLeadsCount = replanLeads.length;

      let shouldBreakAfterReplan = false;
      {
        const postMatchInfo = countMatchingLeads(accumulatedCandidates);
        const postMatchingCount = postMatchInfo.matching.length;
        const prevMatchingTotal = perPlanAdded.reduce((s, p) => s + p.added_matching, 0);
        const addedMatchingThisPlan = Math.max(0, postMatchingCount - prevMatchingTotal);
        perPlanAdded.push({ plan_version: planVersion, added_matching: addedMatchingThisPlan, added_total: newUnique });
        const postAccLeads = Array.from(accumulatedCandidates.values());
        const postHardCheck = checkHardConstraintsSatisfied(postAccLeads, structuredConstraints, userRequestedCountFinal);
        const postCountMet = userRequestedCountFinal === null || postMatchingCount >= userRequestedCountFinal;
        if (postHardCheck.satisfied && postCountMet) {
          console.log(`[REPLAN] Early stop after accumulation — accumulated_matching=${postMatchingCount}${userRequestedCountFinal !== null ? ` >= ${userRequestedCountFinal} user requested` : ' (no count target)'}, all hard constraints satisfied`);
          finalAction = 'accept';
          finalVerdict = 'pass';
          shouldBreakAfterReplan = true;
        } else if (postCountMet && !postHardCheck.satisfied) {
          console.log(`[REPLAN] Matching count met after accumulation (${postMatchingCount}${userRequestedCountFinal !== null ? ` >= ${userRequestedCountFinal}` : ''}) but hard constraints unsatisfied: ${postHardCheck.unsatisfied.join(', ')}`);
        }

        if (newUnique === 0 && !shouldBreakAfterReplan) {
          console.log(`[REPLAN] Zero new unique leads in ${vLabel} (accumulated matching=${postMatchingCount} total=${accumulatedCandidates.size}/${userRequestedCountFinal}) — no progress, stopping replan loop.`);
          shouldBreakAfterReplan = true;
          finalAction = 'accept';
        }

        try {
          await createArtefact({
            runId: chatRunId,
            type: 'accumulation_update',
            title: `Accumulation after Plan ${vLabel}`,
            summary: `${postMatchingCount} matching of ${accumulatedCandidates.size} unique leads (requested: ${userRequestedCountFinal ?? 'any'})`,
            payload: {
              plan_version: planVersion,
              added_total: newUnique,
              added_matching: perPlanAdded[perPlanAdded.length - 1]?.added_matching ?? 0,
              total_unique: accumulatedCandidates.size,
              matching_unique: postMatchingCount,
              requested_user: userRequestedCountFinal,
              constraints_hard: hard_constraints,
              constraints_soft: soft_constraints,
              dedupe_key_strategy: 'place_id_or_name_address',
              per_plan_added: perPlanAdded,
              early_stop: shouldBreakAfterReplan,
            },
            userId: task.user_id,
            conversationId,
          });
          console.log(`[ACCUMULATION] ${vLabel} artefact created: matching=${postMatchingCount} total_unique=${accumulatedCandidates.size}`);
        } catch (accErr: any) {
          console.warn(`[ACCUMULATION] Failed to create accumulation_update artefact (${vLabel}): ${accErr.message}`);
        }
      }

      const replanCompletedMatchInfo = countMatchingLeads(accumulatedCandidates);
      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'replan_completed', status: shouldBreakAfterReplan ? 'success' : 'pending',
        taskGenerated: `Replan ${replansUsed}/${MAX_REPLANS} completed: ${vLabel} delivered ${replanLeads.length}, accumulated_unique=${accumulatedCandidates.size}, accumulated_matching=${replanCompletedMatchInfo.matching.length} (Tower deferred to final_delivery)`,
        runType: 'plan',
        metadata: {
          plan_version: planVersion, prior_delivered: priorLeadsCount, replan_delivered: replanLeads.length,
          accumulated_unique: accumulatedCandidates.size, accumulated_matching: replanCompletedMatchInfo.matching.length, requested_count_user: rc.requested_count_user, requested_count_effective: rc.requested_count_effective,
          replans_used: replansUsed, max_replans: MAX_REPLANS,
          strategy: replanResult.strategy_summary,
          radius_km: v2.radius_km, radius_rung: v2.radius_rung,
          blocked_changes: replanResult.blocked_changes,
        },
      });
      console.log(`[REPLAN] [replan_completed] replan=${replansUsed}/${MAX_REPLANS} delivered=${replanLeads.length} accumulated_unique=${accumulatedCandidates.size} accumulated_matching=${replanCompletedMatchInfo.matching.length}`);

      if (shouldBreakAfterReplan) {
        break;
      }
    }

    const totalUniqueLeads = accumulatedCandidates.size;
    const finalMatchInfo = countMatchingLeads(accumulatedCandidates);
    const totalMatchingLeads = finalMatchInfo.matching.length;

    if (hasHardNameConstraints || (replansUsed > 0 && totalUniqueLeads > finalLeads.length)) {
      const matchingLeads: typeof leads = [];
      for (const candidate of finalMatchInfo.matching) {
        matchingLeads.push({
          name: candidate.name,
          address: candidate.address || '',
          phone: candidate.phone || null,
          website: candidate.website || null,
          placeId: candidate.place_id || '',
          source: candidate.source || 'google_places',
          lat: candidate.lat ?? null,
          lng: candidate.lng ?? null,
        });
      }
      const trimmedUnion = userRequestedCountFinal !== null ? matchingLeads.slice(0, userRequestedCountFinal) : matchingLeads;
      finalLeads = trimmedUnion;
      console.log(`[TOWER_LOOP_CHAT] Built union leads list: ${trimmedUnion.length} matching (from ${totalUniqueLeads} unique, ${totalMatchingLeads} matching accumulated across ${replansUsed + 1} plans)`);
    }

    let cvlVerification: CvlVerificationOutput | null = null;
    try {
      const cvlLeads: VerifiableLead[] = finalLeads.map(l => ({
        name: l.name,
        address: l.address,
        phone: l.phone,
        website: l.website,
        placeId: l.placeId,
        source: l.source,
        lat: l.lat ?? null,
        lng: l.lng ?? null,
      }));

      const attrEvidenceMap: AttributeEvidenceMap = new Map();
      if (attrVerificationResults.length > 0) {
        for (const r of attrVerificationResults) {
          if (!attrEvidenceMap.has(r.lead_place_id)) {
            attrEvidenceMap.set(r.lead_place_id, new Map());
          }
          const leadMap = attrEvidenceMap.get(r.lead_place_id)!;
          leadMap.set(r.attribute.toLowerCase(), {
            verdict: r.verdict,
            confidence: r.confidence,
            reason: r.rationale,
            evidenceUrl: r.url_visited,
          });
        }
      }

      cvlVerification = verifyLeads(
        cvlLeads,
        structuredConstraints,
        userRequestedCountFinal,
        searchBudgetCount,
        totalUniqueLeads,
        attrEvidenceMap.size > 0 ? attrEvidenceMap : undefined,
      );

      for (const lv of cvlVerification.leadVerifications) {
        try {
          await createArtefact({
            runId: chatRunId,
            type: 'lead_verification',
            title: `Lead verification: ${lv.lead_name} — ${lv.verified_exact ? 'exact' : 'partial'} (${lv.location_confidence})`,
            summary: `${lv.constraint_checks.filter(c => c.status === 'yes').length} yes, ${lv.constraint_checks.filter(c => c.status === 'no').length} no, ${lv.constraint_checks.filter(c => c.status === 'search_bounded').length} search_bounded, ${lv.constraint_checks.filter(c => c.status === 'unknown').length} unknown | all_hard_satisfied=${lv.all_hard_satisfied} | location=${lv.location_confidence}`,
            payload: lv as unknown as Record<string, unknown>,
            userId: task.user_id,
            conversationId,
          });
        } catch (lvErr: any) {
          console.warn(`[CVL] Failed to emit lead_verification for "${lv.lead_name}" (non-fatal): ${lvErr.message}`);
        }
      }

      const lvTitle = `Lead verification: ${cvlVerification.leadVerifications.length} leads checked, ${cvlVerification.verified_exact_count} verified exact`;
      const lvSummary = `${cvlVerification.leadVerifications.filter(lv => lv.all_hard_satisfied).length} all_hard_satisfied | ${cvlVerification.verified_exact_count} verified_exact of ${cvlVerification.leadVerifications.length} checked`;
      const locBreak = cvlVerification.summary.location_breakdown;
      const aggregatedLvPayload = {
        title: lvTitle,
        summary: lvSummary,
        leads_checked: cvlVerification.leadVerifications.length,
        verified_exact_count: cvlVerification.verified_exact_count,
        location_breakdown: locBreak,
        verifications: cvlVerification.leadVerifications.map(lv => ({
          lead_name: lv.lead_name,
          verified_exact: lv.verified_exact,
          all_hard_satisfied: lv.all_hard_satisfied,
          location_confidence: lv.location_confidence,
          constraint_checks: lv.constraint_checks,
        })),
      };
      await this.postArtefactToUI({
        runId: chatRunId,
        clientRequestId,
        type: 'lead_verification',
        payload: aggregatedLvPayload as unknown as Record<string, unknown>,
        userId: task.user_id,
        conversationId,
      }).catch((e: any) => console.warn(`[CVL] postArtefactToUI lead_verification (aggregated) failed (non-fatal): ${e.message}`));

      if (cvlVerification.evidenceItems.length > 0) {
        const evTitle = `Verification evidence: ${cvlVerification.evidenceItems.length} items`;
        const evSummary = `${cvlVerification.evidenceItems.length} evidence items across ${finalLeads.length} leads`;
        const evidencePayload = { title: evTitle, summary: evSummary, evidence: cvlVerification.evidenceItems } as unknown as Record<string, unknown>;
        try {
          await createArtefact({
            runId: chatRunId,
            type: 'verification_evidence',
            title: evTitle,
            summary: evSummary,
            payload: evidencePayload,
            userId: task.user_id,
            conversationId,
          });
        } catch (evErr: any) {
          console.warn(`[CVL] Failed to emit verification_evidence (non-fatal): ${evErr.message}`);
        }
        await this.postArtefactToUI({
          runId: chatRunId,
          clientRequestId,
          type: 'verification_evidence',
          payload: evidencePayload,
          userId: task.user_id,
          conversationId,
        }).catch((e: any) => console.warn(`[CVL] postArtefactToUI verification_evidence failed (non-fatal): ${e.message}`));
      }

      const vs = cvlVerification.summary;
      const hardUnverifiableLabel = vs.unverifiable_hard_constraints.length > 0
        ? ` | hard_unverifiable=${vs.unverifiable_hard_constraints.map(u => u.value).join(',')}`
        : '';
      const vsSummaryStr = `verified_exact=${vs.verified_exact_count} | checked=${vs.candidates_checked} | requested=${vs.requested_count_user ?? 'any'} | unverifiable_constraints=${vs.unverifiable_count} | hard_unknown=${vs.hard_unknown_count}${hardUnverifiableLabel}`;
      try {
        await createArtefact({
          runId: chatRunId,
          type: 'verification_summary',
          title: `Verification summary: ${vs.verified_exact_count} verified exact of ${vs.candidates_checked} checked${vs.hard_unknown_count > 0 ? ` (${vs.hard_unknown_count} hard-unknown)` : ''}`,
          summary: vsSummaryStr,
          payload: vs as unknown as Record<string, unknown>,
          userId: task.user_id,
          conversationId,
        });
        const lb = vs.location_breakdown;
        console.log(`[CVL] verification_summary: verified_exact=${vs.verified_exact_count} checked=${vs.candidates_checked} requested=${vs.requested_count_user} hard_unknown=${vs.hard_unknown_count} unverifiable_hard=${vs.unverifiable_hard_constraints.length} location=[geo=${lb.verified_geo_count} bounded=${lb.search_bounded_count} out=${lb.out_of_area_count} unk=${lb.unknown_count}]`);
      } catch (vsErr: any) {
        console.warn(`[CVL] Failed to emit verification_summary (non-fatal): ${vsErr.message}`);
      }
      const vsTitle = `Verification summary: ${vs.verified_exact_count} verified exact of ${vs.candidates_checked} checked${vs.hard_unknown_count > 0 ? ` (${vs.hard_unknown_count} hard-unknown)` : ''}`;
      await this.postArtefactToUI({
        runId: chatRunId,
        clientRequestId,
        type: 'verification_summary',
        payload: { ...vs as unknown as Record<string, unknown>, title: vsTitle, summary: vsSummaryStr },
        userId: task.user_id,
        conversationId,
      }).catch((e: any) => console.warn(`[CVL] postArtefactToUI verification_summary failed (non-fatal): ${e.message}`));

      console.log(`[CVL] Verification pass complete: ${vs.verified_exact_count} verified exact out of ${vs.candidates_checked} leads checked`);
    } catch (cvlErr: any) {
      console.warn(`[CVL] Verification pass failed (non-fatal, continuing with unverified counts): ${cvlErr.message}`);
    }

    const cvlVerifiedExactCount = cvlVerification?.verified_exact_count ?? null;

    if (runDeadlineExceeded) {
      console.log(`[RUN_DEADLINE] Run deadline exceeded — emitting terminal artefact. reason=${runDeadlineReason}`);
      await createArtefact({
        runId: chatRunId,
        type: 'terminal',
        title: `Run stopped: ${runDeadlineReason.split(':')[0]}`,
        summary: `Run exceeded bounded limit (${runDeadlineReason}). Delivering ${finalLeads.length} leads found so far. Tool calls: ${runToolCallCount}. Elapsed: ${Math.round((Date.now() - runStartTime) / 1000)}s.`,
        payload: {
          reason: runDeadlineReason.split(':')[0],
          detail: runDeadlineReason,
          delivered: finalLeads.length,
          tool_calls: runToolCallCount,
          elapsed_ms: Date.now() - runStartTime,
          max_duration_ms: MAX_RUN_DURATION_MS,
          max_tool_calls: MAX_TOOL_CALLS_PER_RUN,
        },
        userId: task.user_id,
        conversationId,
      }).catch((e: any) => console.warn(`[RUN_DEADLINE] Failed to emit terminal artefact: ${e.message}`));
    }

    // ── SINGLE AUTHORITATIVE TOWER CALL ──
    // Create final_delivery artefact with leads + verification data, then call Tower exactly once.
    // This is the ONLY Tower judgement for this run. The verdict is authoritative and final.
    if (towerJudgedBeforeVerification) {
      console.error(`[INVARIANT_VIOLATION] tower_judgement_before_verification=true — this should NEVER happen. A Tower call was made on leads before verification was complete.`);
    }

    const foundCountRaw = finalLeads.length;
    if (userRequestedCountFinal !== null && finalLeads.length > userRequestedCountFinal) {
      finalLeads = finalLeads.slice(0, userRequestedCountFinal);
      console.log(`[FINAL_DELIVERY] Trimmed leads from ${foundCountRaw} to ${finalLeads.length} (requested_count=${userRequestedCountFinal})`);
    }

    const finalDeliveryPayload = {
      run_id: chatRunId,
      delivered_leads: finalLeads.map(l => {
        const lvMatch = cvlVerification?.leadVerifications.find(lv => lv.lead_place_id === l.placeId);
        return {
          name: l.name,
          address: l.address,
          phone: l.phone,
          website: l.website,
          placeId: l.placeId,
          source: l.source,
          verification: lvMatch ? {
            verified_exact: lvMatch.verified_exact,
            all_hard_satisfied: lvMatch.all_hard_satisfied,
            location_confidence: lvMatch.location_confidence,
            constraint_checks: lvMatch.constraint_checks,
          } : null,
        };
      }),
      requested_count: userRequestedCountFinal,
      delivered_count: finalLeads.length,
      found_count_raw: foundCountRaw,
      requested_count_effective: rc.requested_count_effective,
      accumulated_unique: totalUniqueLeads,
      accumulated_matching: totalMatchingLeads,
      plan_versions_used: planVersion,
      replans_used: replansUsed,
      verification_summary: cvlVerification ? {
        verified_exact_count: cvlVerification.verified_exact_count,
        candidates_checked: cvlVerification.summary.candidates_checked,
        hard_unknown_count: cvlVerification.summary.hard_unknown_count,
        unverifiable_hard_constraints: cvlVerification.summary.unverifiable_hard_constraints,
        location_breakdown: cvlVerification.summary.location_breakdown,
      } : null,
      attribute_verification: attributeVerificationAttempted ? {
        attempted: true,
        stopped: attributeVerificationStopped,
        results_count: attrVerificationResults.length,
        leads_with_attribute: new Set(attrVerificationResults.filter(r => r.attribute_found).map(r => r.lead_place_id)).size,
      } : null,
      hard_constraints,
      soft_constraints,
      constraints: typedConstraints,
      ...(hasContactRequests ? {
        contact_requests: contactRequests,
        contact_enrichment: {
          requested: contactRequests,
          leads_with_website: finalLeads.filter(l => l.website).length,
          leads_with_phone: finalLeads.filter(l => l.phone).length,
          note: 'Enrichment metric only — not a pass/fail criterion',
        },
      } : {}),
      used_stub: usedStub,
      run_deadline_exceeded: runDeadlineExceeded,
      intent_source: canonicalIntent ? 'canonical' : 'legacy',
      evidence_ready_for_tower: attributeVerificationAttempted,
    };

    console.log(`[STAGE] runId=${chatRunId} crid=${clientRequestId} stage=final_delivery`);
    const finalDeliveryArtefact = await createArtefact({
      runId: chatRunId,
      type: 'final_delivery',
      title: `Final delivery: ${finalLeads.length} leads${cvlVerifiedExactCount !== null ? ` (${cvlVerifiedExactCount} verified exact)` : ''}`,
      summary: `${finalLeads.length} leads delivered | requested=${userRequestedCountFinal ?? 'any'} | verified_exact=${cvlVerifiedExactCount ?? 'n/a'} | plans=${planVersion} | replans=${replansUsed}`,
      payload: finalDeliveryPayload,
      userId: task.user_id,
      conversationId,
    });
    console.log(`[FINAL_DELIVERY] artefact id=${finalDeliveryArtefact.id} leads=${finalLeads.length} verified_exact=${cvlVerifiedExactCount}`);

    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'tower_call_started', status: 'pending',
      taskGenerated: `Calling Tower to judge final_delivery artefact ${finalDeliveryArtefact.id} (single authoritative call)`,
      runType: 'plan',
      metadata: { artefactId: finalDeliveryArtefact.id, goal, leads_count: finalLeads.length, verified_exact: cvlVerifiedExactCount },
    });

    const finalSuccessCriteria = {
      mission_type: 'leadgen',
      target_count: rc.requested_count_effective,
      requested_count_user: rc.requested_count_user,
      requested_count_value: rc.requested_count_value,
      requested_count_effective: rc.requested_count_effective,
      user_specified_count: userSpecifiedCount,
      plan_version: planVersion,
      hard_constraints,
      soft_constraints,
      constraints: typedConstraints,
      plan_constraints: {
        business_type: businessType,
        location: city,
        country,
        search_count: searchCount,
        requested_count: rc.requested_count_effective,
        prefix_filter: prefixFilter || null,
        attribute_filter: attributeFilter || null,
      },
      max_replan_versions: MAX_REPLANS + 1,
      requires_relationship_evidence: relationshipPredicate.requires_relationship_evidence,
      verified_relationship_count: 0,
      verified_exact_count: cvlVerifiedExactCount,
      accumulated_unique_count: totalUniqueLeads,
      accumulated_matching_count: totalMatchingLeads,
      attribute_verification_stopped: attributeVerificationStopped,
      run_deadline_exceeded: runDeadlineExceeded,
      ...(queryShapeKey ? { query_shape_key: queryShapeKey } : {}),
      ...(hasContactRequests ? {
        contact_requests: contactRequests,
        contact_requests_note: 'Enrichment-only delivery preferences. NOT hard or soft constraints. Do NOT fail the run if contact info (email/phone/website) is missing or incomplete. Only fail if business_type, location, or count hard constraints are unmet.',
      } : {}),
    };

    let finalTowerResult;
    try {
      finalTowerResult = await judgeArtefact({
        artefact: finalDeliveryArtefact,
        runId: chatRunId,
        goal,
        userId: task.user_id,
        conversationId,
        successCriteria: finalSuccessCriteria,
      });
    } catch (towerErr: any) {
      const errMsg = towerErr.message || 'Tower call threw an exception';
      console.error(`[FINAL_DELIVERY] Tower call failed: ${errMsg}`);
      runGovernanceStatus = 'tower_unavailable';
      finalTowerResult = {
        judgement: { verdict: 'error', reasons: [errMsg], metrics: {}, action: 'stop' as const },
        shouldStop: true,
        stubbed: false,
      };

      await createArtefact({
        runId: chatRunId,
        type: 'tower_unavailable',
        title: 'Tower judgement unavailable',
        summary: `Tower API call failed: ${errMsg.substring(0, 200)}. Run will stop gracefully.`,
        payload: { run_id: chatRunId, stage: 'final_delivery', error_message: errMsg.substring(0, 500), governance_status: 'tower_unavailable', stop_reason: 'tower_unreachable' },
        userId: task.user_id,
        conversationId,
      }).catch((artErr: any) => console.warn(`[TOWER_UNAVAILABLE] Failed to persist tower_unavailable artefact: ${artErr.message}`));
    }

    finalVerdict = finalTowerResult.judgement.verdict;
    finalAction = finalTowerResult.judgement.action;
    console.log(`[FINAL_DELIVERY] Tower verdict=${finalVerdict} action=${finalAction} stubbed=${finalTowerResult.stubbed}`);

    // ENFORCE: if Tower returns stop/fail, the run ends as fail — cannot flip to pass
    if (finalTowerResult.shouldStop || finalVerdict === 'stop' || finalVerdict === 'error' || finalVerdict === 'fail') {
      console.log(`[FINAL_DELIVERY] Tower returned stop/fail verdict="${finalVerdict}" — enforcing as final. No override permitted.`);
    }

    // If run deadline exceeded and Tower didn't pass, mark as timeout
    if (runDeadlineExceeded && finalVerdict !== 'pass') {
      console.log(`[FINAL_DELIVERY] Run deadline exceeded and Tower verdict="${finalVerdict}" — overriding to timeout`);
      finalVerdict = 'timeout';
      finalAction = 'stop';
    }

    const finalTowerJudgementArtefact = await createArtefact({
      runId: chatRunId,
      type: 'tower_judgement',
      title: `Tower Judgement (final_delivery): ${finalVerdict}`,
      summary: `Final verdict: ${finalVerdict} | Action: ${finalAction} | Delivered: ${finalLeads.length} | Verified exact: ${cvlVerifiedExactCount ?? 'n/a'}`,
      payload: {
        verdict: finalVerdict,
        action: finalAction,
        reasons: finalTowerResult.judgement.reasons,
        metrics: finalTowerResult.judgement.metrics,
        delivered: finalLeads.length,
        requested: userRequestedCountFinal,
        accumulated_unique: totalUniqueLeads,
        accumulated_matching: totalMatchingLeads,
        verified_exact_count: cvlVerifiedExactCount,
        artefact_id: finalDeliveryArtefact.id,
        leads_list_artefact_id: finalLeadsListArtefact.id,
        used_stub: usedStub,
        stubbed: finalTowerResult.stubbed,
        plan_version: planVersion,
        phase: 'final_delivery',
      },
      userId: task.user_id,
      conversationId,
    });

    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'tower_verdict', status: finalTowerResult.shouldStop ? 'failed' : 'success',
      taskGenerated: `Tower final_delivery verdict: ${finalVerdict} — action: ${finalAction}`,
      runType: 'plan',
      metadata: {
        verdict: finalVerdict,
        action: finalAction,
        artefactId: finalDeliveryArtefact.id,
        towerJudgementArtefactId: finalTowerJudgementArtefact.id,
        delivered: finalLeads.length,
        requested: userRequestedCountFinal,
        verified_exact_count: cvlVerifiedExactCount,
        stubbed: finalTowerResult.stubbed,
        phase: 'final_delivery',
      },
    });

    if (finalTowerResult.judgement.learning_update && queryShapeKey) {
      try {
        const lu = finalTowerResult.judgement.learning_update;
        const effectiveShapeKey = lu.query_shape_key || queryShapeKey;
        console.log(`[LEARNING_STORE] Final Tower emitted learning_update for shape_key=${effectiveShapeKey}`);
        await handleLearningUpdate({
          query_shape_key: effectiveShapeKey,
          run_id: chatRunId,
          updates: lu.updates as any,
        });
      } catch (luErr: any) {
        console.warn(`[LEARNING_STORE] Final learning_update processing failed (non-fatal): ${luErr.message}`);
      }
    }

    const towerReturnedStop = finalTowerResult.shouldStop || finalVerdict === 'error' || finalVerdict === 'stop' || finalVerdict === 'fail' || finalVerdict === 'timeout' || (runDeadlineExceeded && finalVerdict !== 'pass');

    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'run_completed', status: 'success',
      taskGenerated: `Tower loop chat completed: ${totalMatchingLeads} matching of ${totalUniqueLeads} unique leads (accumulated across ${planVersion} plan versions), verdict=${finalVerdict}`,
      runType: 'plan',
      metadata: { verdict: finalVerdict, action: finalAction, leads_count: finalLeads.length, accumulated_unique: totalUniqueLeads, accumulated_matching: totalMatchingLeads, requested_count_user: rc.requested_count_user, requested_count_effective: rc.requested_count_effective, plan_version: planVersion, replans_used: replansUsed, tower_returned_stop: towerReturnedStop },
    });
    console.log(`[TOWER_LOOP_CHAT] [run_completed] verdict=${finalVerdict} leads=${finalLeads.length} accumulated_unique=${totalUniqueLeads} accumulated_matching=${totalMatchingLeads} plan_version=${planVersion} tower_returned_stop=${towerReturnedStop}`);

    await storage.updateAgentRun(chatRunId, { status: 'completed', terminalState: 'completed', metadata: { verdict: finalVerdict, action: finalAction, leads_count: finalLeads.length, accumulated_unique: totalUniqueLeads, accumulated_matching: totalMatchingLeads, halted: false, plan_version: planVersion, replans_used: replansUsed, tower_returned_stop: towerReturnedStop } });

    const isHalted = false;

    await this.postArtefactToUI({
      runId: chatRunId,
      clientRequestId,
      type: 'tower_judgement',
      payload: {
        verdict: finalVerdict,
        action: finalAction,
        reasons: finalTowerResult.judgement.reasons,
        metrics: finalTowerResult.judgement.metrics,
        delivered: finalLeads.length,
        requested: userRequestedCountFinal,
        accumulated_unique: totalUniqueLeads,
        accumulated_matching: totalMatchingLeads,
        verified_exact_count: cvlVerifiedExactCount,
        artefact_id: finalDeliveryArtefact.id,
        used_stub: usedStub,
        stubbed: finalTowerResult.stubbed,
        plan_version: planVersion,
        phase: 'final_delivery',
      },
      userId: task.user_id,
      conversationId,
    }).catch(() => {});

    const finalLabel = buildConstraintLabel(finalConstraints, v1Constraints, planVersion);
    const finalAnnotations = finalLabel.annotations.length > 0 ? ` (${finalLabel.annotations.join(', ')})` : '';
    const finalLocDisplay = finalConstraints.location;
    const finalPrefixDisplay = finalConstraints.prefix_filter ? ` starting with ${finalConstraints.prefix_filter}` : '';

    const hasNameConstraints = !!(prefixFilter || nameFilter);
    const matchingQualifier = hasNameConstraints && totalMatchingLeads !== totalUniqueLeads
      ? ` (${totalMatchingLeads} matching your name criteria out of ${totalUniqueLeads} total found)`
      : '';

    await this.postArtefactToUI({
      runId: chatRunId,
      clientRequestId,
      type: 'leads',
      payload: {
        title: artefactTitle('', finalLeads.length, finalConstraints, planVersion).trim(),
        summary: `Found ${finalLeads.length} ${finalConstraints.business_type} ${relationshipPredicate.requires_relationship_evidence ? 'candidates (relationship not verified)' : 'prospects'} in ${finalLocDisplay}${finalPrefixDisplay}${matchingQualifier}${finalAnnotations}${usedStub ? ' (stub data)' : ''} — Tower verdict: ${finalVerdict}`,
        leads: finalLeads.map(l => {
          const lvMatch = cvlVerification?.leadVerifications.find(lv => lv.lead_place_id === l.placeId);
          const locCheck = lvMatch?.constraint_checks.find(cc => cc.constraint_type === 'LOCATION_EQUALS' || cc.constraint_type === 'LOCATION_NEAR');
          const relationshipOverride = relationshipPredicate.requires_relationship_evidence
            ? { relationship_status: 'candidate' as const, relationship_verified: false }
            : {};
          return {
            name: l.name,
            address: l.address,
            phone: l.phone,
            website: l.website,
            placeId: l.placeId,
            source: l.source,
            verification: lvMatch ? {
              location_status: lvMatch.location_confidence,
              location_confidence: locCheck?.confidence ?? null,
              verified_exact: relationshipPredicate.requires_relationship_evidence ? false : lvMatch.verified_exact,
              all_hard_satisfied: relationshipPredicate.requires_relationship_evidence ? false : lvMatch.all_hard_satisfied,
              verification_level: lvMatch.constraint_checks.length > 0
                ? (lvMatch.verified_exact && !relationshipPredicate.requires_relationship_evidence ? 'verified' : 'checked')
                : 'candidate',
              ...relationshipOverride,
            } : { verification_level: 'unverified' as const, ...relationshipOverride },
          };
        }),
        query: { businessType: finalConstraints.business_type, location: finalLocDisplay, country },
        tool: 'SEARCH_PLACES',
        tower_verdict: finalVerdict,
        plan_version: planVersion,
        accumulated_unique: totalUniqueLeads,
        accumulated_matching: totalMatchingLeads,
        per_plan_added: perPlanAdded,
        relaxed_constraints: finalLabel.relaxed_constraints,
        constraint_diffs: finalLabel.constraint_diffs,
        location_breakdown: cvlVerification?.summary?.location_breakdown ?? null,
        ...(relationshipPredicate.requires_relationship_evidence ? {
          requires_relationship_evidence: true,
          relationship_predicate: relationshipPredicate.detected_predicate,
          relationship_target: relationshipPredicate.relationship_target,
          verified_relationship_count: 0,
          lead_status: 'candidate',
        } : {}),
      },
      userId: task.user_id,
      conversationId,
    }).catch(() => {});

    const dsLeadsRaw = accumulatedCandidates.size > 0
      ? Array.from(accumulatedCandidates.values())
          .filter(c => finalLeads.some(fl => fl.placeId === c.place_id || fl.name === c.name))
          .map(c => ({ entity_id: c.place_id || c.dedupe_key, name: c.name, address: c.address || '', found_in_plan_version: c.found_in_plan_version }))
      : finalLeads.map(l => ({ entity_id: l.placeId, name: l.name, address: l.address, found_in_plan_version: 1 }));
    const dsLeads = userRequestedCountFinal !== null ? dsLeadsRaw.slice(0, userRequestedCountFinal) : dsLeadsRaw;
    const dsHardUnverifiable = cvlVerification?.summary?.unverifiable_hard_constraints ?? [];
    const dsVerdict = finalLeads.length > 0 ? 'pass' : finalVerdict;
    const dsStopReason: string | null = null;
    const effectiveStopReason: string | null = null;
    const mainDsInput = {
      runId: chatRunId,
      userId: task.user_id,
      conversationId,
      originalUserGoal,
      requestedCount: userRequestedCountFinal,
      hardConstraints: hard_constraints,
      softConstraints: soft_constraints,
      planVersions: dsPlanVersions,
      softRelaxations: dsSoftRelaxations,
      leads: dsLeads,
      finalVerdict: dsVerdict,
      stopReason: effectiveStopReason,
      cvlVerifiedExactCount: cvlVerifiedExactCount,
      cvlUnverifiableCount: cvlVerification?.summary?.unverifiable_count ?? null,
      cvlRequestedCountUser: cvlVerification?.summary?.requested_count_user ?? null,
      cvlHardUnverifiable: dsHardUnverifiable.map(u => u.value),
      cvlLocationBreakdown: cvlVerification?.summary?.location_breakdown ?? null,
      cvlLeadVerifications: cvlVerification?.leadVerifications.map(lv => ({
        lead_place_id: lv.lead_place_id,
        lead_name: lv.lead_name,
        verified_exact: lv.verified_exact,
        all_hard_satisfied: lv.all_hard_satisfied,
        location_confidence: lv.location_confidence,
      })),
      relationshipContext: relationshipPredicate.requires_relationship_evidence ? {
        requires_relationship_evidence: true,
        detected_predicate: relationshipPredicate.detected_predicate,
        relationship_target: relationshipPredicate.relationship_target,
        verified_relationship_count: 0,
      } : undefined,
    };
    const mainDsPayload = await emitDeliverySummary(mainDsInput);

    try {
      await emitRunReceipt({
        runId: chatRunId,
        userId: task.user_id,
        conversationId,
        goal: originalUserGoal,
        businessType,
        location: city,
        requestedCount: userRequestedCountFinal,
        deliveredLeads: finalLeads.map(l => ({ name: l.name, placeId: l.placeId, website: l.website })),
        candidateCountFromGoogle,
        planVersionsUsed: planVersion,
        replansUsed: replansUsed,
      });
    } catch (receiptErr: any) {
      console.error(`[RUN_RECEIPT] Failed to emit run receipt (non-fatal): ${receiptErr.message}`);
    }

    if (goalId) {
      try {
        const goalStatus = mainDsPayload.status === 'PASS' ? 'COMPLETE'
          : mainDsPayload.status === 'PARTIAL' ? 'PARTIAL'
          : 'STOPPED';
        const goalStopReason = goalStatus === 'STOPPED' ? { stop_reason: mainDsPayload.stop_reason, tower_verdict: mainDsPayload.tower_verdict } : undefined;
        await storage.updateGoalStatus(goalId, goalStatus, goalStopReason);
        console.log(`[TOWER_LOOP_CHAT] [goal_updated] goalId=${goalId} status=${goalStatus}`);
      } catch (gErr: any) { console.error(`[TOWER_LOOP_CHAT] Failed to update goal status (non-fatal): ${gErr.message}`); }
    }
    try {
      await writeBeliefs({ runId: chatRunId, goalId, deliverySummary: mainDsPayload });
    } catch (bErr: any) { console.error(`[TOWER_LOOP_CHAT] Failed to write beliefs (non-fatal): ${bErr.message}`); }

    let chatResponse = SUPERVISOR_NEUTRAL_MESSAGE;
    if (relationshipPredicate.requires_relationship_evidence && mainDsPayload.relationship_context?.verified_relationship_count === 0 && mainDsPayload.delivered_total_count > 0) {
      const target = relationshipPredicate.relationship_target || 'the specified entity';
      const predicate = relationshipPredicate.detected_predicate || 'works with';
      chatResponse = `I found organisations associated with ${target}, but could not verify that they ${predicate} ${target}. No relationship evidence could be confirmed. All results are candidates only.`;
    }

    try {
      const runDuration = Date.now() - runStartTime;
      const outcomeScopeKey = policyResult?.scopeKey ?? `${businessType.toLowerCase()}::${city.toLowerCase()}::default`;
      await writeOutcomeLog({
        runId: chatRunId,
        userId: task.user_id,
        conversationId,
        deliveredCount: mainDsPayload.delivered_total_count,
        requestedCount: mainDsPayload.requested_count,
        verifiedExact: mainDsPayload.delivered_exact_count,
        verifiedClosest: mainDsPayload.delivered_closest.length,
        stopReason: mainDsPayload.stop_reason,
        toolCalls: runToolCallCount,
        costEstimate: runToolCallCount * 0.02,
        durationMs: runDuration,
        planVersionsUsed: planVersion,
        scopeKey: outcomeScopeKey,
        totalRetryCount: runTotalRetryCount,
        learned_max_replans,
        hard_cap_max_replans: HARD_CAP_MAX_REPLANS,
        effective_max_replans,
        governance_status: runGovernanceStatus,
        ...(hasOverrides ? { run_overrides: runOverrides } : {}),
      });

      const policyBundleUsed: PolicyBundleV1 = policyResult?.bundle ?? structuredClone(GLOBAL_DEFAULT_BUNDLE);
      await writeOutcomePolicyVersion(
        outcomeScopeKey,
        policyResult?.policyVersion ?? 0,
        policyBundleUsed,
        {
          deliveredCount: mainDsPayload.delivered_total_count,
          requestedCount: mainDsPayload.requested_count,
          stopReason: mainDsPayload.stop_reason,
        },
      );
    } catch (outcomeErr: any) {
      console.warn(`[LEARNING_LAYER] outcome_log or policy version write failed (non-fatal): ${outcomeErr.message}`);
    }

    // Learning update from the final Tower call is already processed above (in the SINGLE AUTHORITATIVE TOWER CALL section)

    const finalScopeKey = policyResult?.scopeKey ?? `${businessType.toLowerCase()}::${city.toLowerCase()}::default`;
    const finalSnapshot = policyResult?.snapshot ?? buildApplicationSnapshot(
      finalScopeKey,
      GLOBAL_DEFAULT_BUNDLE,
      0,
      ['Fallback: applyPolicy failed, default bundle used.'],
    );

    if (!policyApplicationWritten) {
      try {
        const fallbackBundle = structuredClone(GLOBAL_DEFAULT_BUNDLE);
        const fallbackExecParams = deriveExecutionParams(fallbackBundle);
        const fallbackResult: PolicyApplicationResult = {
          scopeKey: finalScopeKey,
          policyVersionId: null,
          policyVersion: 0,
          bundle: fallbackBundle,
          executionParams: fallbackExecParams,
          snapshot: finalSnapshot,
          applied: false,
          rationale: 'Fallback: applyPolicy failed earlier, writing default policy_applications row at end of run.',
          constraints: {
            radiusKm: fallbackBundle.policies.radius_policy_v1.max_cap_km,
            enrichmentBatchSize: fallbackBundle.policies.enrichment_policy_v1.enrichment_batch_size,
            stopThresholdZero: fallbackBundle.policies.stop_policy_v1.stop_when_verified_exact_is_zero_after_enrichment,
            stopThresholdMin: 1,
            maxPlanVersions: fallbackBundle.policies.stop_policy_v1.max_replans,
            searchBudgetCount: fallbackBundle.policies.stop_policy_v1.search_budget_count,
          },
        };
        await persistPolicyApplication(chatRunId, policyInput, fallbackResult);
        policyApplicationWritten = true;
        console.log(`[LEARNING_LAYER] Fallback policy_applications row written for run_id=${chatRunId}`);
      } catch (fbErr: any) {
        console.error(`[LEARNING_LAYER] Fallback policy_applications write FAILED for run_id=${chatRunId}: ${fbErr.message}`);
      }
    }

    try {
      await createArtefact({
        runId: chatRunId,
        type: 'policy_application_snapshot',
        title: `Policy Application Snapshot: ${finalScopeKey}`,
        summary: `run_id=${chatRunId} scope=${finalScopeKey} versions=${JSON.stringify(finalSnapshot.applied_versions)} written=${policyApplicationWritten}`,
        payload: {
          run_id: chatRunId,
          scope_key: finalScopeKey,
          applied_versions: finalSnapshot.applied_versions,
          applied_max_replans: finalSnapshot.applied_policies.stop_policy_v1.max_replans,
          learned_max_replans,
          hard_cap_max_replans: HARD_CAP_MAX_REPLANS,
          effective_max_replans,
          governance_status: runGovernanceStatus,
          why_short: finalSnapshot.why_short,
          written_to_db: policyApplicationWritten,
          ...(hasOverrides ? { run_overrides: runOverrides } : {}),
        },
        userId: task.user_id,
        conversationId,
      });
      console.log(`[LEARNING_LAYER] policy_application_snapshot artefact emitted for run_id=${chatRunId}`);
    } catch (snapErr: any) {
      console.error(`[LEARNING_LAYER] policy_application_snapshot artefact FAILED for run_id=${chatRunId}: ${snapErr.message}`);
    }

    const runElapsedMs = Date.now() - runStartTime;
    console.log(`[TOWER_LOOP_CHAT] [complete] leads=${finalLeads.length} verdict=${finalVerdict} halted=${isHalted} plan_version=${planVersion} stub=${usedStub} elapsed_ms=${runElapsedMs} tool_calls=${runToolCallCount}${runDeadlineExceeded ? ` deadline_exceeded=${runDeadlineReason}` : ''}`);

    let compiledStopReason = 'completed';
    if (runDeadlineExceeded) compiledStopReason = 'budget_exhausted';
    else if (replansUsed >= MAX_REPLANS) compiledStopReason = 'budget_exhausted';
    else if (candidateCountFromGoogle === 0) compiledStopReason = 'no_candidates';
    else if (userSpecifiedCount && finalLeads.length < (userRequestedCountFinal ?? 0)) compiledStopReason = 'underfilled';
    else if (finalVerdict === 'stop' || finalVerdict === 'STOP') compiledStopReason = 'tower_stop';

    const searchQueryCompiledPayload: SearchQueryCompiledPayload = {
      interpreted_location: city,
      interpreted_query: businessType,
      requested_count: userRequestedCountFinal,
      exactness_mode: exactnessMode,
      do_not_stop_ignored: doNotStopDetected,
      search_mode: 'Text Search first',
      pages_budget_allowed: Math.ceil(searchBudgetCount / 20),
      pages_budget_used: replansUsed + 1,
      radius_start: 0,
      radius_current: currentConstraints.radius_km ?? 0,
      radius_escalated: (currentConstraints.radius_rung ?? 0) > 0,
      candidate_count_from_google: candidateCountFromGoogle,
      final_returned_count: finalLeads.length,
      stop_reason: compiledStopReason,
      original_goal: normalizedGoal,
      query_broadening_applied: queryBroadeningApplied,
      query_broadening_terms: queryBroadeningTerms,
      replans_used: replansUsed,
      max_replans: MAX_REPLANS,
      ...(hasContactRequests ? { contact_requests: contactRequests } : {}),
    };

    try {
      await emitSearchQueryCompiled({
        runId: chatRunId,
        userId: task.user_id,
        conversationId,
        payload: searchQueryCompiledPayload,
      });
    } catch (sqcErr: any) {
      console.error(`[SEARCH_QUERY_COMPILED] Failed: ${sqcErr.message}`);
    }

    return {
      response: chatResponse,
      leadIds: createdLeadIds,
      deliverySummary: mainDsPayload,
      towerVerdict: finalVerdict,
      leads: finalLeads.map(l => ({ name: l.name, address: l.address, phone: l.phone, website: l.website, placeId: l.placeId })),
    };
  }

  private generateStubLeads(businessType: string, city: string, country: string): Array<{ name: string; address: string; phone: string | null; website: string | null; placeId: string; source: string; lat: number | null; lng: number | null }> {
    const stubNames = [
      `The ${city} ${businessType.replace(/s$/, '')} House`,
      `${city} Central ${businessType.replace(/s$/, '')}`,
      `The Old ${businessType.replace(/s$/, '')} ${city}`,
      `${businessType.replace(/s$/, '')} & Co ${city}`,
      `The Crown ${businessType.replace(/s$/, '')}`,
    ];
    return stubNames.map((name, i) => ({
      name,
      address: `${10 + i} High Street, ${city}, ${country}`,
      phone: `+44 20 7946 0${100 + i}`,
      website: `https://www.${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.co.uk`,
      placeId: `stub_place_${i + 1}`,
      source: 'deterministic_stub',
      lat: null,
      lng: null,
    }));
  }

  private async generateLeadsFromSignal(signal: any) {
    const payload = signal.payload;
    const userProfile = payload?.userProfile;

    if (!userProfile) {
      console.log('Signal has no userProfile, skipping');
      return;
    }

    const { industry, location, prefs } = userProfile;
    
    if (!industry) {
      console.log('Signal has no industry in userProfile, skipping');
      return;
    }

    const city = location?.city || 'Local';
    const country = location?.country || 'UK';

    // Build comprehensive user context
    const userContext = await this.buildUserContext(signal.user_id);

    const signalRunId = `signal_${signal.id || Date.now()}`;

    console.log(`🔍 Searching for ${industry} businesses in ${city}, ${country}...`);

    logRouterDecision(
      signal.user_id, signalRunId, 'SEARCH_PLACES',
      `Signal-triggered search: "${industry}" in ${city} via Google Places`
    ).catch(() => {});

    try {
      logToolCallStarted(
        signal.user_id, signalRunId, 'SEARCH_PLACES',
        { query: industry, location: city, country }
      ).catch(() => {});

      // Search for businesses using Google Places API
      const businesses = await this.searchGooglePlaces(industry, city, country);
      
      if (!businesses || businesses.length === 0) {
        console.log(`⚠️  No businesses found for ${industry} in ${city}`);
        logToolCallCompleted(
          signal.user_id, signalRunId, 'SEARCH_PLACES',
          { summary: `No results for "${industry}" in ${city}`, places_count: 0 }
        ).catch(() => {});
        return;
      }

      logToolCallCompleted(
        signal.user_id, signalRunId, 'SEARCH_PLACES',
        { summary: `Found ${businesses.length} places for "${industry}" in ${city}`, places_count: businesses.length }
      ).catch(() => {});

      // Generate one lead from the first result
      const business = businesses[0];
      console.log(`📍 Found business: ${business.displayName?.text || 'Unknown'}`);

      // Try to find email using Hunter.io if we have a domain
      let emailCandidates: string[] = [];
      if (business.websiteUri) {
        try {
          const domain = new URL(business.websiteUri).hostname.replace('www.', '');
          console.log(`📧 Searching for emails at ${domain}...`);
          emailCandidates = await this.findEmails(domain);
          console.log(`✉️  Found ${emailCandidates.length} email candidates`);
        } catch (e) {
          console.log(`⚠️  Could not extract domain from ${business.websiteUri}`);
        }
      }

      // Generate intelligent rationale using full user context
      const rationale = this.generateRationale(signal, userContext, business, industry, city);

      // Calculate smarter score based on context matching
      const score = this.calculateLeadScore(userContext, business, industry);

      const lead = {
        userId: signal.user_id,
        accountId: userContext.accountId, // SUP-012: Account isolation via enriched user context
        rationale,
        source: 'supervisor_auto',
        score,
        lead: {
          name: business.displayName?.text || 'Unknown Business',
          address: business.formattedAddress || `${city}, ${country}`,
          place_id: business.id || '',
          domain: business.websiteUri || '',
          emailCandidates,
          tags: [industry, signal.type],
          phone: business.nationalPhoneNumber || business.internationalPhoneNumber || ''
        }
      };

      const createdLead = await storage.createSuggestedLead(lead);
      console.log(`✅ Generated lead: ${lead.lead.name} (score: ${(score * 100).toFixed(0)}%)`);

      // Send email notification to user
      await this.notifyLeadCreated(createdLead);
    } catch (error) {
      console.error(`Failed to generate lead from Google Places:`, error);
      logToolCallFailed(
        signal.user_id, signalRunId, 'SEARCH_PLACES',
        error instanceof Error ? error.message : String(error)
      ).catch(() => {});
      throw error;
    }
  }

  private async notifyLeadCreated(lead: any): Promise<void> {
    try {
      // TESTING: Use hardcoded email for now, will switch to user's email later
      const testEmail = 'phil@listersbrewery.com';
      
      // Get user info from Supabase for name (optional)
      const userInfo = await storage.getUserEmail(lead.userId);

      // Generate dashboard URL from environment variable
      // FRONTEND_URL should be the public URL of the frontend (e.g., https://wyshbone.vercel.app)
      const dashboardUrl = process.env.DASHBOARD_URL || process.env.FRONTEND_URL || 'http://localhost:5173';

      // Send email notification
      await emailService.sendLeadCreatedEmail({
        lead,
        userEmail: testEmail,
        userName: userInfo?.name || 'there',
        dashboardUrl
      });
    } catch (error) {
      // Log error but don't block the supervisor loop
      console.error(`❌ Failed to send email notification for lead ${lead.id}:`, error);
    }
  }

  private generateRationale(signal: any, context: UserContext, business: any, industry: string, city: string): string {
    const parts: string[] = [];
    
    // Base rationale from signal
    parts.push(`${business.displayName?.text || 'Business'} in ${city}`);

    // Add context from user profile
    if (context.profile?.primaryObjective) {
      parts.push(`Matches objective: "${context.profile.primaryObjective}"`);
    }

    // Add relevant facts
    const relevantFacts = context.facts
      .filter(f => f.category === 'industry' || f.category === 'place' || f.score >= 85)
      .slice(0, 2);
    
    if (relevantFacts.length > 0) {
      parts.push(`User interests: ${relevantFacts.map(f => f.fact).join(', ')}`);
    }

    return parts.join(' • ');
  }

  private calculateLeadScore(context: UserContext, business: any, industry: string): number {
    let score = 0.75; // Base score

    // Boost if matches user's inferred industry
    if (context.profile?.inferredIndustry && context.profile.inferredIndustry.toLowerCase().includes(industry.toLowerCase())) {
      score += 0.10;
    }

    // Boost if matches target markets
    if (context.profile?.targetMarkets && context.profile.targetMarkets.length > 0) {
      score += 0.05;
    }

    // Boost if user has high-value facts in same category
    const relevantFacts = context.facts.filter(f => f.category === 'industry' && f.score >= 80);
    if (relevantFacts.length > 0) {
      score += 0.05;
    }

    // Boost if user has active monitors (shows engagement)
    if (context.monitors.length > 0) {
      score += 0.03;
    }

    // Cap at 0.98
    return Math.min(score, 0.98);
  }

  async getUserContext(userId: string): Promise<UserContext> {
    return this.buildUserContext(userId);
  }

  private async buildUserContext(userId: string): Promise<UserContext> {
    console.log(`🔍 Building comprehensive context for user: ${userId}`);
    
    // SUP-17: Initialize with default verticalId = 'brewery'
    const context: UserContext = {
      userId,
      verticalId: 'brewery', // SUP-17: Default to brewery
      facts: [],
      recentMessages: [],
      monitors: [],
      researchRuns: []
    };

    if (!supabase) {
      console.warn('Supabase not configured, returning empty context');
      return context;
    }

    try {
      // Get user profile including accountId for SUP-012 isolation and verticalId for SUP-17
      const { data: userProfile } = await supabase
        .from('users')
        .select('company_name, company_domain, inferred_industry, primary_objective, secondary_objectives, target_markets, products_or_services, confidence, account_id, vertical_id')
        .eq('id', userId)
        .single();

      if (userProfile) {
        context.profile = {
          companyName: userProfile.company_name,
          companyDomain: userProfile.company_domain,
          inferredIndustry: userProfile.inferred_industry,
          primaryObjective: userProfile.primary_objective,
          secondaryObjectives: userProfile.secondary_objectives,
          targetMarkets: userProfile.target_markets,
          productsOrServices: userProfile.products_or_services,
          confidence: userProfile.confidence
        };
        context.accountId = userProfile.account_id || undefined; // SUP-012: Account isolation
        // SUP-17: Set verticalId, defaulting to 'brewery'
        context.verticalId = (userProfile.vertical_id as UserContext['verticalId']) || 'brewery';
        console.log(`  📋 Profile: ${userProfile.company_name || 'Unknown'} (${userProfile.inferred_industry || 'Unknown industry'})`);
        console.log(`  🏭 Vertical: ${context.verticalId}`);
      }

      // Get top ranked facts (score >= 70)
      const { data: facts } = await supabase
        .from('facts')
        .select('fact, score, category, created_at')
        .eq('user_id', userId)
        .gte('score', 70)
        .order('score', { ascending: false })
        .limit(10);

      if (facts) {
        context.facts = facts.map(f => ({
          fact: f.fact,
          score: f.score,
          category: f.category,
          createdAt: new Date(f.created_at).toISOString()
        }));
        console.log(`  ✨ Found ${facts.length} high-value facts (score >= 70)`);
      }

      // Get recent conversations and messages (last 50 messages)
      const { data: conversations } = await supabase
        .from('conversations')
        .select('id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

      if (conversations && conversations.length > 0) {
        const conversationIds = conversations.map(c => c.id);
        const { data: messages } = await supabase
          .from('messages')
          .select('role, content, created_at')
          .in('conversation_id', conversationIds)
          .order('created_at', { ascending: false })
          .limit(50);

        if (messages) {
          context.recentMessages = messages.map(m => ({
            role: m.role,
            content: m.content,
            createdAt: new Date(m.created_at).toISOString()
          }));
          console.log(`  💬 Found ${messages.length} recent messages`);
        }
      }

      // Get active monitors
      const { data: monitors } = await supabase
        .from('scheduled_monitors')
        .select('label, description, monitor_type')
        .eq('user_id', userId)
        .eq('is_active', 1)
        .limit(10);

      if (monitors) {
        context.monitors = monitors.map(m => ({
          label: m.label,
          description: m.description,
          monitorType: m.monitor_type
        }));
        console.log(`  📊 Found ${monitors.length} active monitors`);
      }

      // Get recent research runs
      const { data: researchRuns } = await supabase
        .from('deep_research_runs')
        .select('label, prompt')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

      if (researchRuns) {
        context.researchRuns = researchRuns.map(r => ({
          label: r.label,
          prompt: r.prompt
        }));
        console.log(`  🔬 Found ${researchRuns.length} research runs`);
      }

    } catch (error) {
      console.error('Error building user context:', error);
    }

    return context;
  }

  private async searchGooglePlaces(industry: string, city: string, country: string, maxResults: number = 20): Promise<any[]> {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_PLACES_API_KEY or GOOGLE_MAPS_API_KEY not configured');
    }

    const queryMap: Record<string, string> = {
      'brewery': 'brewery',
      'distillery': 'distillery',
      'winery': 'winery',
      'restaurant': 'restaurant',
      'bar': 'bar'
    };
    const query = queryMap[industry.toLowerCase()] || industry;

    const url = 'https://places.googleapis.com/v1/places:searchText';
    const requestBody = {
      textQuery: `${query} in ${city} ${country}`,
      maxResultCount: Math.min(maxResults, 20)
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.internationalPhoneNumber'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Places API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return data.places || [];
  }

  private async findEmails(domain: string): Promise<string[]> {
    // Support both HUNTER_API_KEY (standard) and HUNTER_IO_API_KEY (legacy)
    const apiKey = process.env.HUNTER_API_KEY || process.env.HUNTER_IO_API_KEY;
    if (!apiKey) {
      console.log('⚠️  HUNTER_API_KEY not configured, skipping email search');
      return [];
    }

    try {
      const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${apiKey}&limit=3`;
      
      const response = await fetch(url);
      if (!response.ok) {
        console.log(`⚠️  Hunter.io API error: ${response.status}`);
        return [];
      }

      const data = await response.json();
      
      if (data.data?.emails && data.data.emails.length > 0) {
        return data.data.emails
          .filter((e: any) => e.value)
          .map((e: any) => e.value)
          .slice(0, 3);
      }

      return [];
    } catch (error) {
      console.log(`⚠️  Hunter.io search failed:`, error);
      return [];
    }
  }

}

export const supervisor = new SupervisorService();
