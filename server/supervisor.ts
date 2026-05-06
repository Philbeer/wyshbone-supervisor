import { supabase } from './supabase';
import { storage } from './storage';
import { emailService } from './notifications/email-service';
import type { SupervisorTask, SupervisorMessage, TaskResult } from './types/supervisor-chat';
import { randomUUID } from 'crypto';
import { monitorGoalsOnce, publishGoalMonitorEvents } from './goal-monitoring';
import { logAFREvent, logMissionReceived, logRunCompleted, logRouterDecision, logToolCallStarted, logToolCallCompleted, logToolCallFailed } from './supervisor/afr-logger';
import { createResearchProvider } from './supervisor/research-provider';
import { createArtefact } from './supervisor/artefacts';
import { executeAction, createRunToolTracker, type ActionResult as LoopActionResult } from './supervisor/action-executor';
import { generateJobId } from './supervisor/jobs';
import { redactRecord, safeOutputsRaw, compactInputs } from './supervisor/plan-executor';
import { judgeArtefact } from './supervisor/tower-artefact-judge';
import { parseGoalToConstraints, buildRequestedCount, DEFAULT_LEADS_TARGET, sanitiseLocationString, type ParsedGoal, type StructuredConstraint, type RequestedCountCanonical } from './supervisor/goal-to-constraints';
import { RADIUS_LADDER_KM, makeDedupeKey, mergeCandidate, type AccumulatedCandidate } from './supervisor/shared-constants';
import { emitDeliverySummary, type PlanVersionEntry, type SoftRelaxation, type DeliverySummaryPayload, type MatchEvidenceItem, type MatchBasisItem, type SupportingEvidenceItem } from './supervisor/delivery-summary';
import { executeFactoryDemo } from './supervisor/factory-demo';
import { normalizeSensorScript } from './supervisor/factory-sim';
import { buildConstraintsExtractedPayload, buildCapabilityCheck } from './supervisor/cvl';
import { runIntentExtractorShadow, getIntentExtractorMode, emitProbe, neutraliseClarifyIfNeeded } from './supervisor/intent-shadow';
import { extractStructuredMission, getMissionExtractorMode } from './supervisor/mission-extractor';
import { checkMissionCompleteness, logCompletenessToAFR, type CompletenessCheckResult } from './supervisor/mission-completeness-check';
import { logMissionShadow, buildMissionDiagnosticPayload, missionToParsedGoal, buildHandoffDiagnostic, type HandoffDiagnostic } from './supervisor/mission-bridge';
import { buildMissionPlan, logMissionPlan, persistMissionPlan, type MissionPlan } from './supervisor/mission-planner';
import { executeMissionDrivenPlan, executeMissionWithReloop, type MissionExecutionContext, type MissionExecutionResult } from './supervisor/mission-executor';
import { buildConversationContextString, canonicalIntentToPreviewFields, canonicalIntentToParsedGoal } from './supervisor/intent-bridge';
import { preExecutionConstraintGate, preExecutionConstraintGateFromIntent, resolveFollowUp, storePendingContract, getPendingContract, clearPendingContract, buildConstraintGateMessage, detectNoProxySignal, detectMustBeCertain, applyCertaintyGate, type ConstraintContract, type AttributeClassification } from './supervisor/constraint-gate';
import { detectTimePredicate, buildClarifyQuestion as buildTimePredicateClarifyQuestion, buildTimePredicateContract } from './supervisor/time-predicate';
import { recordBenchmarkRun, type BenchmarkRunInput } from './evaluator/benchmarkLogger';
import type { RunContext, PlanHistoryEntry } from './evaluator/classifyRunFailure';
import { BENCHMARK_QUERIES, getBenchmarkQueryId } from '../config/benchmarkQueries';
import { executeRefine, type RefineLead } from './supervisor/refine-executor';
import { attemptRescueLLM, logRescueEvent, updateRescueSuccess, type RescueResult } from './supervisor/rescue-llm';

const SUPERVISOR_NEUTRAL_MESSAGE = 'Run complete. Results are available.';

const _benchmarkQueriesLower = new Set(BENCHMARK_QUERIES.map(q => q.toLowerCase().trim()));
function isBenchmarkQuery(query: string): boolean {
  return _benchmarkQueriesLower.has(query.toLowerCase().trim());
}

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
  // Block conversational preamble that LLMs generate as "helpful" ack messages
  const PREAMBLE_RE = /I'd be happy to|I would be happy to|Could you tell me what|what type of businesses|what kind of businesses|Let me help you find|I can help you|I'll help you find/i;
  if (PREAMBLE_RE.test(msg)) {
    console.warn(`[SUPERVISOR_MSG_GUARD] Blocked conversational preamble: "${msg.substring(0, 120)}…"`);
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
  recentSearches?: Array<{
    query: string;
    delivered: number;
    verdict: string;
    created: string;
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
  private static readonly STALE_TASK_TIMEOUT_MS = parseInt(process.env.STALE_TASK_TIMEOUT_MS || String(4 * 60 * 1000), 10); // 4 minutes default (configurable). Website evidence runs take 2-3 min.
  private static readonly MAX_RECOVERY_ATTEMPTS = 3;
  private lastNoTasksLogAt: number = 0;
  // In-flight task registry — prevents re-queuing tasks already executing and enables
  // timeout enforcement without blocking the poll loop.
  private _inFlightTasks: Map<string, { startedAt: number }> = new Map();
  // Hard outer timeout for the entire processChatTask call (covers LLM extraction +
  // mission execution + reloop). Must be > RUN_EXECUTION_TIMEOUT_MS (5 min) +
  // pre-execution overhead. Set to 12 minutes.
  private static readonly TASK_HARD_TIMEOUT_MS = 12 * 60 * 1000;

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
        this.wakeGoals(),  // 6.1: Sleep/wake goal scheduler
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
      const orphanThresholdMs = Math.max(parseInt(process.env.RUN_EXECUTION_TIMEOUT_MS || process.env.MAX_RUN_DURATION_MS || '120000', 10) + 60_000, 180_000);
      const staleThreshold = new Date(Date.now() - orphanThresholdMs).toISOString();
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
            terminalState: 'failed',
            error: 'Run was interrupted by a server restart and could not be recovered',
            endedAt: new Date(),
            metadata: { ...existingMeta, orphan_recovered: true, orphan_reason: 'server_restart', timed_out: true, recovered_at: new Date().toISOString() },
          });
          console.log(`[RECOVERY_RUNS] Marked agent_run ${run.id} as failed (server_restart_orphan)`);
          if (supabase) {
            await supabase
              .from('loop_state')
              .update({ status: 'circuit_broken', completed_at: new Date().toISOString() })
              .eq('run_id', run.id)
              .eq('status', 'active')
              .then(() => console.log(`[RECOVERY_RUNS] Closed active loop_state rows for run ${run.id}`))
              .catch((e: any) => console.warn(`[RECOVERY_RUNS] Failed to close loop_state rows for run ${run.id}: ${e.message}`));
          }
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

      // Collect run IDs that are actively queued OR actively executing (non-blocking).
      // These must not be swept — they are legitimately in-progress.
      const activeRunIds = new Set<string>();
      for (const t of this.pendingClaimedQueue) {
        const rid = t.run_id || t.request_data?.run_id;
        if (rid) activeRunIds.add(rid);
      }
      // Also protect tasks currently in-flight (launched non-blocking)
      Array.from(this._inFlightTasks.keys()).forEach(taskId => activeRunIds.add(taskId));

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
      const orphanThresholdMs = Math.max(parseInt(process.env.RUN_EXECUTION_TIMEOUT_MS || process.env.MAX_RUN_DURATION_MS || '120000', 10) + 60_000, 180_000);
      const staleThreshold = new Date(Date.now() - orphanThresholdMs).toISOString();
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
            terminalState: 'failed',
            error: 'Run was orphaned — no active processing detected after timeout',
            endedAt: new Date(),
            metadata: { ...existingMeta, orphan_recovered: true, orphan_reason: 'stale_sweep', timed_out: true, recovered_at: new Date().toISOString() },
          });
          console.log(`[STALE_SWEEP] Marked orphaned agent_run ${run.id} as failed`);
          if (supabase) {
            await supabase
              .from('loop_state')
              .update({ status: 'circuit_broken', completed_at: new Date().toISOString() })
              .eq('run_id', run.id)
              .eq('status', 'active')
              .then(() => console.log(`[RECOVERY_RUNS] Closed active loop_state rows for run ${run.id}`))
              .catch((e: any) => console.warn(`[RECOVERY_RUNS] Failed to close loop_state rows for run ${run.id}: ${e.message}`));
          }
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

    if (agentRun && agentRun.status === 'timed_out') {
      console.log(`${logPrefix} runId=${runId} is timed_out — fully terminal, skipping recovery`);
      await supabase
        .from('supervisor_tasks')
        .update({ status: 'failed', result: { recovered: false, trigger, note: 'Run timed out — not recoverable' } })
        .eq('id', task.id);

      logAFREvent({
        userId: task.user_id, runId, clientRequestId,
        conversationId: task.conversation_id,
        actionTaken: 'task_recovery_skipped', status: 'failed',
        taskGenerated: `Task not recoverable — agent_run timed out`,
        runType: 'plan',
        metadata: { taskId: task.id, trigger, agentRunStatus: 'timed_out' },
      }).catch(() => {});

      return 'skipped';
    }

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
          resume_from_loop_state: true,
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

    console.log(`[TASK_PROCESS] Dispatching ${tasksToProcess.length} claimed task(s) (non-blocking) in-flight=${this._inFlightTasks.size}`);

    for (const task of tasksToProcess) {
      if (this._inFlightTasks.has(task.id)) {
        console.log(`[TASK_PROCESS] Skipping task ${task.id} — already in-flight`);
        continue;
      }

      this._inFlightTasks.set(task.id, { startedAt: Date.now() });
      console.log(`[TASK_PROCESS] Launching task ${task.id} non-blocking (in-flight=${this._inFlightTasks.size})`);

      // Fire non-blocking — the poll loop must never await a mission execution.
      // A hard outer timeout prevents a single stuck run from occupying the slot forever.
      const hardTimeoutMs = SupervisorService.TASK_HARD_TIMEOUT_MS;
      const taskId = task.id;
      const runThis = async () => {
        const timeoutHandle = setTimeout(async () => {
          console.error(`[TASK_HARD_TIMEOUT] task=${taskId} exceeded ${hardTimeoutMs / 1000}s — aborting and marking failed`);
          this._inFlightTasks.delete(taskId);
          if (!supabase) return;
          await supabase
            .from('supervisor_tasks')
            .update({ status: 'failed', error: `Task exceeded hard timeout of ${hardTimeoutMs / 1000}s` })
            .eq('id', taskId)
            .eq('status', 'processing');
          const taskRunId = task.run_id || task.request_data?.run_id || taskId;
          await storage.updateAgentRun(taskRunId, {
            status: 'failed',
            terminalState: 'failed',
            error: `Hard task timeout after ${hardTimeoutMs / 1000}s`,
            endedAt: new Date(),
            metadata: { timed_out: true, timeout_reason: 'task_hard_timeout', timeout_ms: hardTimeoutMs },
          }).catch(() => {});
        }, hardTimeoutMs);

        try {
          await this.processChatTask(task as SupervisorTask);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`Failed to process task ${taskId}:`, error);
          const taskRunId = task.run_id || task.request_data?.run_id || taskId;
          createArtefact({
            runId: taskRunId,
            type: 'diagnostic',
            title: 'Run failed: unhandled exception in processChatTask',
            summary: `Error: ${errMsg.substring(0, 200)}`,
            payload: { reason: 'unhandled_exception', error: errMsg, taskId },
            userId: task.user_id,
            conversationId: task.conversation_id,
          }).catch((e: any) => console.warn(`[PROCESS_TASK] Failed to emit diagnostic artefact: ${e.message}`));
          if (supabase) {
            await supabase
              .from('supervisor_tasks')
              .update({ status: 'failed', error: errMsg })
              .eq('id', taskId);
          }
        } finally {
          clearTimeout(timeoutHandle);
          this._inFlightTasks.delete(taskId);
          console.log(`[TASK_PROCESS] Task ${taskId} completed/failed — in-flight=${this._inFlightTasks.size}`);
        }
      };

      // Intentionally not awaited — allows the poll loop to dispatch multiple
      // tasks concurrently and return immediately.
      runThis().catch((e: any) => {
        console.error(`[TASK_PROCESS] Unexpected top-level error for task ${taskId}: ${e.message}`);
        this._inFlightTasks.delete(taskId);
      });
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

  // ─── CREATE MONITOR EXECUTOR ─────────────────────────────────────────────────
  // Handles create_monitor tasks: creates a scheduled monitor from an existing
  // completed search run. Does NOT run a new search.
  private async handleCreateMonitor(
    task: SupervisorTask,
    jobId: string,
    clientRequestId: string,
  ): Promise<void> {
    if (!supabase) return;

    const rd = task.request_data as any;
    const userMessage = String(rd.user_message || '').trim();
    const conversationId = task.conversation_id;

    console.log(`[CREATE_MONITOR] runId=${jobId} conversation=${conversationId} msg="${userMessage.slice(0, 80)}"`);

    try {
      // 1. Look up the explicit source run provided by the UI
      const sourceRunId: string = String(rd.source_run_id || '').trim();
      if (!sourceRunId) {
        const noRunMsg = "I couldn't find that search to monitor — the run may have been deleted or it doesn't belong to you.";
        const messageId = randomUUID();
        await Promise.all([
          supabase.from('messages').insert({
            id: messageId,
            conversation_id: conversationId,
            role: 'assistant',
            content: noRunMsg,
            source: 'supervisor',
            metadata: { supervisor_task_id: task.id, run_id: jobId, create_monitor_failed: true },
            created_at: Date.now(),
          }),
          supabase.from('supervisor_tasks').update({ status: 'completed', result: { message_id: messageId, monitor_created: false } }).eq('id', task.id),
          storage.updateAgentRun(jobId, { status: 'completed', terminalState: 'completed', endedAt: new Date(), metadata: { verdict: 'no_source_run_id' } }).catch(() => {}),
        ]);
        return;
      }

      // TODO(identity): user_id guard removed because demo mode has two
      // identity representations for the same user — "demo-user" literal in
      // supervisor_tasks (from auth fallback) and a real UUID in agent_runs
      // (from URL-param auth). Unifying them is a non-trivial refactor.
      // Acceptable for now because source_run_id is a non-guessable UUID
      // written by the supervisor onto a conversation-scoped message; possession
      // of source_run_id implies authorisation. Restore guard once demo
      // identity is unified.
      const { data: sourceRun, error: runError } = await supabase
        .from('agent_runs')
        .select('id, metadata')
        .eq('id', sourceRunId)
        .maybeSingle();

      if (runError) {
        console.error(`[CREATE_MONITOR] Failed to query run: ${runError.message}`);
        throw new Error('Could not look up the source search run');
      }

      if (!sourceRun) {
        const noRunMsg = "I couldn't find that search to monitor — the run may have been deleted or it doesn't belong to you.";
        const messageId = randomUUID();
        await Promise.all([
          supabase.from('messages').insert({
            id: messageId,
            conversation_id: conversationId,
            role: 'assistant',
            content: noRunMsg,
            source: 'supervisor',
            metadata: { supervisor_task_id: task.id, run_id: jobId, create_monitor_failed: true },
            created_at: Date.now(),
          }),
          supabase.from('supervisor_tasks').update({ status: 'completed', result: { message_id: messageId, monitor_created: false } }).eq('id', task.id),
          storage.updateAgentRun(jobId, { status: 'completed', terminalState: 'completed', endedAt: new Date(), metadata: { verdict: 'source_run_not_found' } }).catch(() => {}),
        ]);
        return;
      }

      // 2. Fetch mission_extraction artefact from the source run
      let missionConfig: any = null;

      const { data: missionArtefacts } = await supabase
        .from('artefacts')
        .select('payload_json')
        .eq('run_id', sourceRunId)
        .eq('type', 'mission_extraction')
        .limit(1);

      if (missionArtefacts && missionArtefacts.length > 0) {
        const payload = missionArtefacts[0].payload_json;
        const mission = payload?.layers?.pass2_structured_mission || payload?.pass2_structured_mission;
        if (mission && mission.entity_category) {
          missionConfig = mission;
        }
      }

      if (!missionConfig) {
        // Fallback: try delivery_summary artefact on the same source run
        const { data: deliveryArts } = await supabase
          .from('artefacts')
          .select('payload_json')
          .eq('run_id', sourceRunId)
          .eq('type', 'delivery_summary')
          .limit(1);

        if (deliveryArts && deliveryArts.length > 0) {
          const dp = deliveryArts[0].payload_json;
          if (dp?.original_user_goal) {
            missionConfig = {
              entity_category: dp.business_type || dp.original_user_goal,
              location_text: dp.location || null,
              constraints: dp.structured_constraints || [],
            };
          }
        }
      }

      if (!missionConfig) {
        const noRunMsg = "I couldn't find that search to monitor — the run may have been deleted or it doesn't belong to you.";
        const messageId = randomUUID();
        await Promise.all([
          supabase.from('messages').insert({
            id: messageId,
            conversation_id: conversationId,
            role: 'assistant',
            content: noRunMsg,
            source: 'supervisor',
            metadata: { supervisor_task_id: task.id, run_id: jobId, create_monitor_failed: true },
            created_at: Date.now(),
          }),
          supabase.from('supervisor_tasks').update({ status: 'completed', result: { message_id: messageId, monitor_created: false } }).eq('id', task.id),
          storage.updateAgentRun(jobId, { status: 'completed', terminalState: 'completed', endedAt: new Date(), metadata: { verdict: 'no_mission_config' } }).catch(() => {}),
        ]);
        return;
      }

      // 3. Parse schedule from structured request_data (UI buttons), not parsed from prose.
      // Valid values: 'once' | 'hourly' | 'daily' | 'weekly'
      const requestedSchedule = String(rd.schedule || '').toLowerCase().trim();
      const validSchedules = ['once', 'hourly', 'daily', 'weekly'];
      if (!validSchedules.includes(requestedSchedule)) {
        throw new Error(`Monitor requires an explicit schedule. Use the schedule buttons in the search results.`);
      }
      const schedule = requestedSchedule;

      const entity = missionConfig.entity_category || 'businesses';
      const location = missionConfig.location_text || 'unknown location';
      const label = `${entity} in ${location}`;

      // 4. Compute next_wake_at
      const intervals: Record<string, number> = {
        once: 0,         // 'once' fires immediately on next wake-scheduler pass
        hourly: 3_600_000,
        daily: 86_400_000,
        weekly: 604_800_000,
      };
      const nextWakeAt = new Date(Date.now() + (intervals[schedule] || intervals.weekly)).toISOString();

      // 5. Get baseline entity names from the source run's delivery
      let baselineNames: string[] = [];
      try {
        const { data: deliveryArts } = await supabase
          .from('artefacts')
          .select('payload_json')
          .eq('run_id', sourceRunId)
          .in('type', ['final_delivery', 'combined_delivery', 'leads_list'])
          .order('created_at', { ascending: false })
          .limit(1);

        if (deliveryArts && deliveryArts.length > 0) {
          const leads = deliveryArts[0].payload_json?.leads || [];
          baselineNames = leads.map((l: any) => l.name).filter(Boolean);
        }
      } catch (e: any) {
        console.warn(`[CREATE_MONITOR] Failed to get baseline names: ${e.message}`);
      }

      // 6. Insert the monitor
      const monitorId = randomUUID();
      const { error: insertError } = await supabase.from('scheduled_monitors').insert({
        id: monitorId,
        user_id: task.user_id,
        conversation_id: conversationId,
        label: label,
        description: `Monitor for ${entity} in ${location} (${schedule})`,
        schedule: schedule,
        schedule_time: '09:00',
        monitor_type: 'lead_search',
        config: {
          original_goal: `find ${entity} in ${location}`,
          business_type: entity,
          location: location,
          country: missionConfig.country || 'UK',
          constraints: (missionConfig.constraints || []).map((c: any) => ({
            type: c.type || 'entity_discovery',
            field: c.field || 'name',
            operator: c.operator || 'equals',
            value: c.value || entity,
          })),
          mission_mode: 'monitor',
          source_run_id: sourceRunId,
          auto_deactivate_after_first_run: schedule === 'once',
        },
        is_active: 1,
        status: 'active',
        last_run_at: Date.now(),
        last_run_id: sourceRunId,
        next_wake_at: nextWakeAt,
        baseline_entity_names: JSON.stringify(baselineNames),
        consecutive_empty_wakes: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      if (insertError) {
        console.error(`[CREATE_MONITOR] Insert failed: ${insertError.message}`);
        throw new Error(`Failed to create monitor: ${insertError.message}`);
      }

      console.log(`[CREATE_MONITOR] Created monitor ${monitorId}: "${label}" schedule=${schedule} baseline=${baselineNames.length} entities`);

      // 7. Reply to user
      const confirmMsg = `I've set up a ${schedule} monitor for "${label}". I'll check for new results and let you know when I find something. The next check is scheduled for ${new Date(nextWakeAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} at 9:00 AM.`;
      const messageId = randomUUID();

      await Promise.all([
        supabase.from('messages').insert({
          id: messageId,
          conversation_id: conversationId,
          role: 'assistant',
          content: confirmMsg,
          source: 'supervisor',
          metadata: {
            supervisor_task_id: task.id,
            run_id: jobId,
            monitor_created: true,
            monitor_id: monitorId,
            schedule: schedule,
            label: label,
            baseline_count: baselineNames.length,
          },
          created_at: Date.now(),
        }),
        supabase.from('supervisor_tasks').update({
          status: 'completed',
          result: { message_id: messageId, monitor_id: monitorId, monitor_created: true },
        }).eq('id', task.id),
        storage.updateAgentRun(jobId, {
          status: 'completed',
          terminalState: 'completed',
          endedAt: new Date(),
          metadata: { verdict: 'monitor_created', monitor_id: monitorId, schedule, label },
        }).catch(() => {}),
      ]);

      console.log(`[CREATE_MONITOR] Done — monitor=${monitorId} task=${task.id}`);
    } catch (err: any) {
      console.error(`[CREATE_MONITOR] Failed: ${err.message}`);
      const errMsg = `Sorry, I couldn't set up the monitor: ${err.message}. Try running a search first, then ask me to monitor it.`;
      const messageId = randomUUID();
      await Promise.all([
        supabase.from('messages').insert({
          id: messageId,
          conversation_id: conversationId,
          role: 'assistant',
          content: errMsg,
          source: 'supervisor',
          metadata: { supervisor_task_id: task.id, run_id: jobId, create_monitor_error: err.message },
          created_at: Date.now(),
        }),
        supabase.from('supervisor_tasks').update({ status: 'failed', result: { message_id: messageId } }).eq('id', task.id),
        storage.updateAgentRun(jobId, { status: 'failed', terminalState: 'failed', endedAt: new Date(), error: err.message }).catch(() => {}),
      ]).catch(() => {});
    }
  }

  // ─── REFINE EXECUTOR ─────────────────────────────────────────────────────────
  // Handles refine_results tasks: filters cached web-page artefacts from the
  // source run by a new keyword constraint. No LLM calls — pure text matching.
  private async handleRefineResults(
    task: SupervisorTask,
    jobId: string,
    clientRequestId: string,
  ): Promise<void> {
    if (!supabase) return;

    const rd = task.request_data as any;
    const sourceRunId: string = rd.source_run_id ?? '';
    const leads: RefineLead[] = Array.isArray(rd.leads) ? rd.leads : [];
    const constraint: string = String(rd.new_constraint || rd.user_message || '').trim();

    console.log(`[REFINE_HANDLER] runId=${jobId} source_run_id="${sourceRunId}" constraint="${constraint}" leads=${leads.length}`);
    console.log(`[REFINE_HANDLER] request_data keys=[${Object.keys(rd).join(', ')}] source_run_id_raw=${JSON.stringify(rd.source_run_id)}`);

    let refineResult: Awaited<ReturnType<typeof executeRefine>>;
    try {
      refineResult = await executeRefine(
        sourceRunId,
        leads,
        constraint,
        jobId,
        task.user_id,
        task.conversation_id,
      );
    } catch (err: any) {
      console.error(`[REFINE_HANDLER] executeRefine threw: ${err.message}`);
      const errMsgId = randomUUID();
      await Promise.all([
        supabase.from('messages').insert({
          id: errMsgId,
          conversation_id: task.conversation_id,
          role: 'assistant',
          content: 'Something went wrong while refining the results. Please try again.',
          source: 'supervisor',
          metadata: { supervisor_task_id: task.id, run_id: jobId, run_error: true },
          created_at: Date.now(),
        }),
        supabase.from('supervisor_tasks').update({ status: 'failed', result: { message_id: errMsgId } }).eq('id', task.id),
        storage.updateAgentRun(jobId, { status: 'failed', terminalState: null, endedAt: new Date(), error: err.message.substring(0, 300) }).catch(() => {}),
      ]).catch(() => {});
      return;
    }

    const { message, matchingLeads, noCachedPages, liveFetched } = refineResult;
    const messageId = randomUUID();

    // Build metadata — if we have matches, surface them as leads so the UI
    // can render them as lead cards using the same format as a normal run.
    const msgMetadata: Record<string, unknown> = {
      supervisor_task_id: task.id,
      run_id: jobId,
      source_run_id: sourceRunId,
      classifier: 'refine',
      capabilities: ['refine_results'],
      refine_constraint: constraint,
      total_checked: refineResult.totalChecked,
      matches: matchingLeads.length,
      no_cached_pages: noCachedPages,
      live_fetched: liveFetched,
    };

    if (matchingLeads.length > 0) {
      msgMetadata['leads'] = matchingLeads;
      msgMetadata['run_lane'] = true;
      msgMetadata['status'] = 'PASS';
      msgMetadata['final_verdict'] = 'PASS';
      msgMetadata['trust_status'] = 'UNVERIFIED';
    }

    const taskStatus = 'completed';
    await Promise.all([
      supabase.from('supervisor_tasks').update({
        status: taskStatus,
        result: {
          message_id: messageId,
          run_id: jobId,
          source_run_id: sourceRunId,
          matches: matchingLeads.length,
          total_checked: refineResult.totalChecked,
        },
      }).eq('id', task.id),

      supabase.from('messages').insert({
        id: messageId,
        conversation_id: task.conversation_id,
        role: 'assistant',
        content: message,
        source: 'supervisor',
        metadata: msgMetadata,
        created_at: Date.now(),
      }),

      storage.updateAgentRun(jobId, {
        status: 'completed',
        terminalState: (refineResult as any).deliverySummary?.status === 'STOP' ? 'stopped' : (refineResult as any).deliverySummary?.status === 'ERROR' ? 'failed' : 'completed',
        endedAt: new Date(),
        metadata: {
          verdict: liveFetched ? 'refine_live_fetched' : noCachedPages ? 'refine_no_cache' : 'refine_completed',
          matches: matchingLeads.length,
          total_checked: refineResult.totalChecked,
        },
      }).catch(() => {}),
    ]).catch((err: any) => {
      console.error(`[REFINE_HANDLER] Final write failed: ${err.message}`);
    });

    console.log(`[REFINE_HANDLER] Done runId=${jobId} task=${task.id} matches=${matchingLeads.length}/${refineResult.totalChecked}`);

    if (process.env.CONVERSATION_STATE_ENABLED === 'true') {
      try {
        const { updateConversationPhase } = await import('./supervisor/conversation-state');
        updateConversationPhase(task.conversation_id, 'reviewing');
      } catch (e: any) {}
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

    console.log(`[ID_MAP] jobId=${jobId} uiRunId=${uiRunId} crid=${clientRequestId} taskId=${task.id} entry=processChatTask`);
    console.log(`[SUPERVISOR] Processing chat task ${task.id} (${task.task_type}) jobId=${jobId} uiRunId=${uiRunId} clientRequestId=${clientRequestId}`);

    const STRIP_CHAT_TELEMETRY = (process.env.STRIP_CHAT_TELEMETRY || 'true').toLowerCase() === 'true';

    if (!STRIP_CHAT_TELEMETRY) {
      await emitProbe('intent_extractor_probe', task.user_id, jobId, task.conversation_id, {
        run_id: jobId,
        conversation_id: task.conversation_id ?? null,
        user_id: task.user_id,
        raw_msg: userInput,
        intent_extractor_mode: getIntentExtractorMode(),
        ts: Date.now(),
      });
    }

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

    const _bridgePromise = this.bridgeRunToUI(uiRunId, jobId, clientRequestId, task.conversation_id, task.user_id).catch((e: any) =>
      console.error(`[RUN_BRIDGE] bridgeRunToUI failed: ${e.message}`)
    );

    if (!STRIP_CHAT_TELEMETRY) {
      logMissionReceived(
        task.user_id, jobId, task.id, task.task_type, task.conversation_id
      ).catch(() => {});
    }

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

    // ═══ EARLY ROUTING: refine_results ═══
    // Bypass the full LLM pipeline — filter existing cached web pages by keyword
    if ((task.task_type as string) === 'refine_results') {
      await this.handleRefineResults(task, jobId, clientRequestId);
      return;
    }
    if ((task.task_type as string) === 'create_monitor') {
      await this.handleCreateMonitor(task, jobId, clientRequestId);
      return;
    }

    // Win 1: fast-path obvious chat without running the router or building heavy context
    {
      const rawMsgForFastPath = String(requestData.user_message || '');
      const { isObviousChat } = await import('./supervisor/chat-fast-path');
      if (isObviousChat(rawMsgForFastPath)) {
        console.log(`[FAST_PATH] Obvious chat detected: "${rawMsgForFastPath.substring(0, 40)}" — bypassing router`);

        await _bridgePromise;

        // Minimal conversation history for chat handler
        let fastPathHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        if (task.conversation_id && supabase) {
          const { data: fpMsgs } = await supabase
            .from('messages')
            .select('role, content')
            .eq('conversation_id', task.conversation_id)
            .order('created_at', { ascending: false })
            .limit(8);
          if (fpMsgs) {
            fastPathHistory = fpMsgs.reverse().map((m: any) => ({
              role: m.role as 'user' | 'assistant',
              content: String(m.content || ''),
            }));
          }
        }

        const { handleChat } = await import('./supervisor/chat-handler');
        const chatResult = await handleChat({
          conversationId: task.conversation_id,
          userId: task.user_id,
          rawMessage: rawMsgForFastPath,
          jobId,
          taskId: task.id,
          conversationHistory: fastPathHistory,
          urlContent: null,
          previousResultsSummary: null,
        });

        if (supabase) {
          await supabase.from('supervisor_tasks').update({
            status: 'completed',
            result: { message_id: chatResult.messageId, router: 'chat', handler: 'chat_fast_path' },
          }).eq('id', task.id);
        }

        await storage.updateAgentRun(jobId, {
          status: 'completed', terminalState: 'completed', endedAt: new Date(),
          metadata: { verdict: 'chat_fast_path' },
        }).catch(() => {});

        this.postArtefactToUI({
          runId: jobId,
          clientRequestId,
          type: 'diagnostic',
          payload: {
            status: 'CHAT',
            leads: [],
            message: chatResult.response,
            router_verdict: 'chat_fast_path',
            run_complete: true,
          },
          userId: task.user_id,
          conversationId: task.conversation_id,
        }).catch((err: any) => {
          console.error(`[FAST_PATH] CRITICAL: Failed to signal UI run is complete: ${err.message}`);
        });

        taskExecutionStartedEmitted = true;
        await emitTaskExecutionCompleted('chat_fast_path');
        return;
      }
    }

    console.log(`[STAGE] runId=${jobId} crid=${clientRequestId} stage=build_user_context`);
    const userContextPromise = this.buildUserContext(task.user_id);
    let rawMsg = String(requestData.user_message || '');

    const missionQueryId: string | null = (requestData as any).query_id || getBenchmarkQueryId(rawMsg.trim()) || null;
    if (missionQueryId) {
      console.log(`[MISSION_EXEC] benchmark run detected — query_id=${missionQueryId}`);
    }
    console.log('[QID-TRACE]', 'step1:processChatTask_computed', missionQueryId);

    let effectiveMsg = rawMsg;
    let _routerHandledSearch = false;

    // ═══ CONVERSATION ROUTER (replaces classifier → gate → clarify chain) ═══
    if (process.env.CONVERSATION_ROUTER_DISABLED !== 'true') {
      // Ensure bridge completes before router sends artefacts
      await _bridgePromise;
      try {
        const { routeConversation } = await import('./supervisor/conversation-router');
        const { classifyTurn } = await import('./supervisor/conversation-turn-classifier');

        // Load conversation history
        let routerHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        if (task.conversation_id && supabase) {
          const { data: msgs } = await supabase
            .from('messages')
            .select('role, content')
            .eq('conversation_id', task.conversation_id)
            .order('created_at', { ascending: false })
            .limit(15);
          if (msgs) {
            routerHistory = msgs.reverse().map((m: any) => ({
              role: m.role as 'user' | 'assistant',
              content: String(m.content || ''),
            }));
          }
        }

        // Load previous results context
        let routerPreviousResults = { exists: false, count: 0, entityType: null as string | null, location: null as string | null, lastSearchRunId: null as string | null };
        if (task.conversation_id) {
          try {
            const { getConversationContext } = await import('./supervisor/conversation-context');
            const ctx = await getConversationContext(task.conversation_id);
            if (ctx.leads.length > 0) {
              routerPreviousResults = {
                exists: true,
                count: ctx.leads.length,
                entityType: ctx.entityType || null,
                location: ctx.location || null,
                lastSearchRunId: ctx.lastDeliveryRunId || null,
              };
            }
          } catch (ctxErr: any) {
            console.warn(`[ROUTER] Context load failed (non-fatal): ${ctxErr.message}`);
          }
        }

        // Stage 1: analyse the conversational turn (context only, no route awareness)
        const turnAnalysis = await classifyTurn({
          currentMessage: rawMsg,
          conversationHistory: routerHistory,
          previousResultsExist: routerPreviousResults.exists,
        });

        const routerInput = {
          currentMessage: rawMsg,
          conversationHistory: routerHistory,
          previousResults: routerPreviousResults,
          urlContent: (requestData as any).url_content || null,
          userSearchHistory: null,
          turnAnalysis,
        };

        // Stage 2: router uses turn analysis as authoritative context
        const decision = await routeConversation(routerInput);

        // Log the decision as an artefact (skipped for non-SEARCH routes when telemetry is stripped)
        if (decision.route === 'SEARCH' || !STRIP_CHAT_TELEMETRY) {
          createArtefact({
            runId: jobId,
            type: 'diagnostic',
            title: `Router: ${decision.route} (${decision.confidence.toFixed(2)})`,
            summary: decision.reasoning,
            payload: { ...decision as any, diagnostic_type: 'conversation_router' },
            userId: task.user_id,
            conversationId: task.conversation_id,
          }).catch(() => {});
        }

        // === HANDLE CHAT ===
        if (decision.route === 'CHAT') {
          try {
            const { handleChat } = await import('./supervisor/chat-handler');

            // Build a summary of previous results if they exist
            let previousResultsSummary: string | null = null;
            if (routerPreviousResults.exists) {
              try {
                const { getConversationContext } = await import('./supervisor/conversation-context');
                const ctx = await getConversationContext(task.conversation_id);
                if (ctx.leads.length > 0) {
                  previousResultsSummary = ctx.leads
                    .map((l) => {
                      const parts = [`${l.index}. ${l.name}`, l.address];
                      if (l.website) parts.push(`Website: ${l.website}`);
                      return parts.join(' | ');
                    })
                    .join('\n');
                }
              } catch (ctxErr: any) {
                console.warn(`[CHAT] Context load for chat failed (non-fatal): ${ctxErr.message}`);
              }
            }

            const chatResult = await handleChat({
              conversationId: task.conversation_id,
              userId: task.user_id,
              rawMessage: rawMsg,
              jobId,
              taskId: task.id,
              conversationHistory: routerHistory,
              urlContent: (requestData as any).url_content || null,
              previousResultsSummary,
            });

            // Mark task complete
            if (supabase) {
              await supabase.from('supervisor_tasks').update({
                status: 'completed',
                result: { message_id: chatResult.messageId, router: 'chat', handler: 'chat_handler' },
              }).eq('id', task.id);
            }

            await storage.updateAgentRun(jobId, {
              status: 'completed', terminalState: 'completed', endedAt: new Date(),
              metadata: { verdict: 'chat_handler', router: decision },
            }).catch(() => {});

            console.log(`[ROUTER] Handled as CHAT via chat-handler — done`);

            this.postArtefactToUI({
              runId: jobId,
              clientRequestId,
              type: 'diagnostic',
              payload: {
                status: 'CHAT',
                leads: [],
                message: chatResult.response,
                router_verdict: 'chat',
                run_complete: true,
              },
              userId: task.user_id,
              conversationId: task.conversation_id,
            }).catch((err: any) => {
              console.error(`[ROUTER] CRITICAL: Failed to signal UI that run is complete: ${err.message}`);
            });

            taskExecutionStartedEmitted = true;
            await emitTaskExecutionCompleted('chat_handler');
            return;
          } catch (chatErr: any) {
            console.error(`[CHAT] Chat handler failed: ${chatErr.message} — falling back to router response`);
            if (decision.chat_response) {
              const messageId = randomUUID();
              await Promise.all([
                supabase!.from('supervisor_tasks').update({
                  status: 'completed',
                  result: { response: decision.chat_response.substring(0, 200), message_id: messageId, router: 'chat', fallback: true },
                }).eq('id', task.id),
                supabase!.from('messages').insert({
                  id: messageId,
                  conversation_id: task.conversation_id,
                  role: 'assistant',
                  content: decision.chat_response,
                  source: 'supervisor',
                  metadata: { supervisor_task_id: task.id, run_id: jobId, router_decision: decision, chat_handler_fallback: true },
                  created_at: Date.now(),
                }),
              ]);
              await storage.updateAgentRun(jobId, {
                status: 'completed', terminalState: 'completed', endedAt: new Date(),
                metadata: { verdict: 'router_chat_fallback', router: decision },
              }).catch(() => {});
              this.postArtefactToUI({
                runId: jobId, clientRequestId,
                type: 'diagnostic',
                payload: { status: 'CHAT', leads: [], message: decision.chat_response, router_verdict: 'chat', run_complete: true },
                userId: task.user_id, conversationId: task.conversation_id,
              }).catch(() => {});
              taskExecutionStartedEmitted = true;
              await emitTaskExecutionCompleted('router_chat_fallback');
              return;
            }
          }
        }

        // === HANDLE CLARIFY ===
        if (decision.route === 'CLARIFY' && decision.clarify_question) {
          const messageId = randomUUID();
          await Promise.all([
            supabase!.from('supervisor_tasks').update({
              status: 'completed',
              result: { response: decision.clarify_question.substring(0, 200), message_id: messageId, router: 'clarify' },
            }).eq('id', task.id),
            supabase!.from('messages').insert({
              id: messageId,
              conversation_id: task.conversation_id,
              role: 'assistant',
              content: decision.clarify_question,
              source: 'supervisor',
              metadata: {
                supervisor_task_id: task.id, run_id: jobId,
                router_decision: decision,
                clarify_gate: 'conversation_router',
                smart_clarify: true,
                mode: 'clarify',
              },
              created_at: Date.now(),
            }),
          ]);
          await storage.updateAgentRun(jobId, {
            status: 'completed', terminalState: 'completed',
            endedAt: new Date(),
            metadata: { verdict: 'router_clarify', router: decision, awaiting: 'user_input', original_message: rawMsg },
          }).catch(() => {});
          console.log(`[ROUTER] Handled as CLARIFY: "${decision.clarify_question.substring(0, 80)}"`);
          // Signal UI poller to stop
          const _clarifyUiResult = await this.postArtefactToUI({
            runId: jobId,
            clientRequestId,
            type: 'diagnostic',
            payload: {
              status: 'CLARIFY',
              leads: [],
              message: decision.clarify_question,
              router_verdict: 'clarify',
              run_complete: true,
            },
            userId: task.user_id,
            conversationId: task.conversation_id,
          }).catch((err: any) => {
            console.error(`[ROUTER] CRITICAL: Failed to signal UI that run is complete: ${err.message}`);
            return null;
          });
          if (!_clarifyUiResult) {
            console.error(`[ROUTER] UI may hang — run_complete signal failed for runId=${jobId}`);
          }
          taskExecutionStartedEmitted = true;
          await emitTaskExecutionCompleted('router_clarify');
          return;
        }

        // === HANDLE DISCUSS ===
        if (decision.route === 'DISCUSS') {
          try {
            const { handleResultDiscussion } = await import('./supervisor/result-discussion');
            const result = await handleResultDiscussion({
              conversationId: task.conversation_id,
              userId: task.user_id,
              rawMessage: rawMsg,
              jobId,
              taskId: task.id,
            });
            if (supabase) {
              await supabase.from('supervisor_tasks').update({
                status: 'completed',
                result: { message_id: result.messageId, router: 'discuss' },
              }).eq('id', task.id);
            }
            await storage.updateAgentRun(jobId, {
              status: 'completed', terminalState: 'completed', endedAt: new Date(),
              metadata: { verdict: 'router_discuss', router: decision },
            }).catch(() => {});
            console.log(`[ROUTER] Handled as DISCUSS — done`);
            // Signal UI poller to stop
            this.postArtefactToUI({
              runId: jobId,
              clientRequestId,
              type: 'diagnostic',
              payload: {
                status: 'DISCUSS',
                leads: [],
                message: 'Discussion complete',
                router_verdict: 'discuss',
                run_complete: true,
              },
              userId: task.user_id,
              conversationId: task.conversation_id,
            }).catch(() => {});
            taskExecutionStartedEmitted = true;
            await emitTaskExecutionCompleted('router_discuss');
            return;
          } catch (discussErr: any) {
            console.warn(`[ROUTER] DISCUSS handler failed: ${discussErr.message} — falling through to pipeline`);
          }
        }

        // === HANDLE ITERATE ===
        if (decision.route === 'ITERATE' && decision.entity && decision.location) {
          // Rewrite rawMsg to the full iterated query, then fall through to the search pipeline
          const constraintStr = decision.constraints.length > 0 ? ' ' + decision.constraints.join(' ') : '';
          rawMsg = `find ${decision.entity} in ${decision.location}${constraintStr}`;
          effectiveMsg = rawMsg;
          console.log(`[ROUTER] ITERATE — rewritten to: "${rawMsg}"`);
          // Fall through to mission extraction below
          _routerHandledSearch = true;
        }

        // === HANDLE SEARCH ===
        if (decision.route === 'SEARCH' && decision.entity && decision.location) {
          // Rewrite rawMsg to a clean search query, then fall through to mission extraction
          const constraintStr = decision.constraints.length > 0 ? ' ' + decision.constraints.join(' ') : '';
          rawMsg = `find ${decision.entity} in ${decision.location}${constraintStr}`;
          effectiveMsg = rawMsg;
          console.log(`[ROUTER] SEARCH — using: "${rawMsg}"`);
          // Fall through to mission extraction below
          _routerHandledSearch = true;
        }

        // For SEARCH, ITERATE, and failed DISCUSS: skip the old classifier/gate chain
        // and jump straight to mission extraction. The old code below this block
        // will still run but the message is now clean and well-formed.

      } catch (routerErr: any) {
        console.error(`[ROUTER] Router failed (${routerErr.message}) — falling through to existing pipeline`);
        // If the router fails entirely, the existing pipeline runs as before
      }
    }
    // ═══ END CONVERSATION ROUTER ═══

    // Await user context — has been running concurrently with the router pipeline
    const userContext = await userContextPromise;

    if (_routerHandledSearch) {
      console.log(`[ROUTER_BYPASS] Router handled SEARCH/ITERATE — skipping classifier, state, shadow, vague resolver, constraint gate, smart clarify. Proceeding directly to mission extraction with: "${effectiveMsg.substring(0, 100)}"`);
    }

    // ═══ MESSAGE CLASSIFIER ═══
    // Fast classification to avoid burning 20+ LLM calls on "hi" or "thanks"
    let isClarifyResponse = !!(requestData.clarify_answer || requestData.continuation_of_run || requestData._constraint_gate_resolved);

    let classifiedMessageClass: string = 'search'; // default

    if (!isClarifyResponse && !missionQueryId && !_routerHandledSearch) {
      console.log('[MESSAGE_CLASSIFIER] Still running as secondary check (router is primary)');
      const { classifyMessage: classifyMsg } = await import('./supervisor/message-classifier');
      const classification = classifyMsg(rawMsg);
      classifiedMessageClass = classification.messageClass;
      console.log(`[MESSAGE_CLASSIFIER] class=${classification.messageClass} confidence=${classification.confidence} reason=${classification.reason} msg="${rawMsg.substring(0, 60)}"`);

      if (classification.messageClass === 'chat' && process.env.CONVERSATION_ROUTER_ENABLED !== 'true') {
        // Respond conversationally without running the pipeline
        const chatResponses = [
          "Hey! Tell me what kind of businesses you're looking for and where — for example, 'find web design agencies in Brighton' or 'search for accountants in Kent'.",
          "Hi there! I can find businesses, leads, and prospects for you. Just tell me what you need and where.",
          "Hello! Ready to search. What type of businesses are you looking for, and in which area?",
        ];
        const chatResponse = chatResponses[Math.floor(Math.random() * chatResponses.length)];
        const messageId = randomUUID();

        await Promise.all([
          supabase!.from('supervisor_tasks').update({
            status: 'completed',
            result: { response: chatResponse.substring(0, 200), message_id: messageId, classifier: 'chat' },
          }).eq('id', task.id),
          supabase!.from('messages').insert({
            id: messageId,
            conversation_id: task.conversation_id,
            role: 'assistant',
            content: chatResponse,
            source: 'supervisor',
            metadata: { supervisor_task_id: task.id, run_id: jobId, classifier: 'chat', classification },
            created_at: Date.now(),
          }).select().single(),
        ]);

        await storage.updateAgentRun(jobId, {
          status: 'completed',
          terminalState: (classification as any).deliverySummary?.status === 'STOP' ? 'stopped' : (classification as any).deliverySummary?.status === 'ERROR' ? 'failed' : 'completed',
          endedAt: new Date(),
          metadata: { verdict: 'chat_classified', classifier: classification },
        }).catch(() => {});

        console.log(`[MESSAGE_CLASSIFIER] Handled as chat — no pipeline triggered. runId=${jobId}`);
        await emitTaskExecutionCompleted('chat_classified');
        return;
      }

      if (classification.messageClass === 'monitor_request') {
        console.log(`[MESSAGE_CLASSIFIER] Monitor request detected — routing to handleCreateMonitor`);
        await this.handleCreateMonitor(task, jobId, clientRequestId);
        await emitTaskExecutionCompleted('monitor_classified');
        return;
      }

      if (classification.messageClass === 'followup' && task.conversation_id) {
        try {
          const { getConversationContext, resolveLeadReference } = await import('./supervisor/conversation-context');
          const ctx = await getConversationContext(task.conversation_id);
          if (ctx.leads.length > 0) {
            console.log(`[CONVERSATION_CONTEXT] Loaded ${ctx.leads.length} leads from last delivery in conversation ${task.conversation_id}`);
            (requestData as any)._conversation_context = ctx;

            // DIRECT RESULT DISCUSSION: If we have leads and the message is a followup,
            // handle it immediately without going through the full pipeline.
            // This is the "fast path" for "tell me about the first one" etc.
            try {
              const { handleResultDiscussion } = await import('./supervisor/result-discussion');
              const result = await handleResultDiscussion({
                conversationId: task.conversation_id,
                userId: task.user_id,
                rawMessage: rawMsg,
                jobId,
                taskId: task.id,
              });

              if (supabase) {
                await supabase.from('supervisor_tasks').update({
                  status: 'completed',
                  result: { message_id: result.messageId, conversation_phase: 'reviewing', referenced_lead: result.referencedLead },
                }).eq('id', task.id);
              }

              await storage.updateAgentRun(jobId, {
                status: 'completed',
                terminalState: 'completed',
                endedAt: new Date(),
                metadata: { verdict: 'result_discussion', conversation_phase: 'reviewing' },
              }).catch(() => {});

              console.log(`[FOLLOWUP_FAST_PATH] Handled followup as result discussion — ${ctx.leads.length} leads, referenced=${result.referencedLead?.name || 'none'}`);
              await emitTaskExecutionCompleted('result_discussion_fast_path');
              return;
            } catch (discussErr: any) {
              console.warn(`[FOLLOWUP_FAST_PATH] Result discussion failed (falling through to pipeline): ${discussErr.message}`);
              // Fall through to normal pipeline
            }
          }
        } catch (ctxErr: any) {
          console.warn(`[CONVERSATION_CONTEXT] Failed to load context (non-fatal): ${ctxErr.message}`);
        }
      }
      if (classification.messageClass !== 'search') {
        console.log(`[MESSAGE_CLASSIFIER] Non-search class "${classification.messageClass}" — proceeding to pipeline`);
      }
    }

    // ═══ CONVERSATION STATE ═══
    const CONV_STATE_ENABLED = process.env.CONVERSATION_STATE_ENABLED === 'true' && !_routerHandledSearch;
    let convState: any = null;
    let suggestedPhase: string = 'idle';

    if (CONV_STATE_ENABLED) {
      try {
        const { getConversationState, suggestPhase } = await import('./supervisor/conversation-state');

        convState = getConversationState(task.conversation_id);

        // Warm up lastDelivery from DB if the in-memory state is missing it
        if (convState && !convState.lastDelivery && task.conversation_id) {
          try {
            const { getConversationContext } = await import('./supervisor/conversation-context');
            const ctx = await getConversationContext(task.conversation_id);
            if (ctx.leads.length > 0 && ctx.lastDeliveryRunId) {
              const { setLastDelivery: setLD } = await import('./supervisor/conversation-state');
              setLD(task.conversation_id, {
                runId: ctx.lastDeliveryRunId,
                leadCount: ctx.leads.length,
                entityType: '',
                location: '',
                missionConfig: null,
              });
              // Reload the state after the warmup
              convState = getConversationState(task.conversation_id);
              console.log(`[CONV_STATE_WARMUP] Recovered lastDelivery from DB: ${ctx.leads.length} leads, runId=${ctx.lastDeliveryRunId}`);
            } else {
              console.log(`[CONV_STATE_WARMUP] No leads in DB for conversation — lastDelivery stays null`);
            }
          } catch (warmupErr: any) {
            console.warn(`[CONV_STATE_WARMUP] Failed (non-fatal): ${warmupErr.message}`);
          }
        }

        const hasLastDelivery = !!convState.lastDelivery;
        const timeSinceLastActivity = Date.now() - convState.lastActivityAt;

        suggestedPhase = suggestPhase({
          messageClass: isClarifyResponse ? 'clarify_response' : classifiedMessageClass,
          currentPhase: convState.phase,
          hasLastDelivery,
          hasPendingContract: false,
          timeSinceLastActivity,
          rawMessage: rawMsg,
        });

        if (suggestedPhase !== convState.phase) {
          const { updateConversationPhase } = await import('./supervisor/conversation-state');
          updateConversationPhase(task.conversation_id, suggestedPhase);
        }

        console.log(`[CONV_STATE] conversation=${task.conversation_id.slice(0, 8)} phase=${suggestedPhase} lastDelivery=${hasLastDelivery} turn=${convState.turnCount} msg="${rawMsg.slice(0, 40)}"`);
        // Extra diagnostic logging
        console.log(`[CONV_STATE_DEBUG] classifiedMessageClass=${isClarifyResponse ? 'clarify_response' : classifiedMessageClass} currentPhase=${convState.phase} hasLastDelivery=${hasLastDelivery} lastDeliveryRunId=${convState.lastDelivery?.runId?.slice(0,12) || 'null'} isClarifyResponse=${isClarifyResponse}`);
      } catch (stateErr: any) {
        console.warn(`[CONV_STATE] State loading failed (non-fatal): ${stateErr.message}`);
      }
    }

    // ═══ STATE-AWARE ROUTING ═══
    if (CONV_STATE_ENABLED && convState) {

      // REVIEWING: User is discussing delivered results
      if (suggestedPhase === 'reviewing' && !isClarifyResponse) {
        try {
          const { handleResultDiscussion } = await import('./supervisor/result-discussion');
          const result = await handleResultDiscussion({
            conversationId: task.conversation_id,
            userId: task.user_id,
            rawMessage: rawMsg,
            jobId,
            taskId: task.id,
          });

          // Mark task complete
          if (supabase) {
            await supabase.from('supervisor_tasks').update({
              status: 'completed',
              result: { message_id: result.messageId, conversation_phase: 'reviewing', referenced_lead: result.referencedLead },
            }).eq('id', task.id);
          }

          await storage.updateAgentRun(jobId, {
            status: 'completed',
            terminalState: 'completed',
            endedAt: new Date(),
            metadata: { verdict: 'result_discussion', conversation_phase: 'reviewing' },
          }).catch(() => {});

          console.log(`[CONV_STATE] Handled as result discussion`);
          await emitTaskExecutionCompleted('result_discussion');
          return;
        } catch (err: any) {
          console.warn(`[CONV_STATE] Result discussion failed: ${err.message}`);
          // Don't fall through silently — tell the user we didn't follow that
          const fallbackMsg = "I'm not sure I understood that. You can ask about a specific result by number (e.g. 'tell me about #3'), ask me to refine the results (e.g. 'which have a website?'), or start a new search.";
          const fallbackMsgId = randomUUID();
          if (supabase) {
            await Promise.all([
              supabase.from('messages').insert({
                id: fallbackMsgId,
                conversation_id: task.conversation_id,
                role: 'assistant',
                content: fallbackMsg,
                source: 'supervisor',
                metadata: { supervisor_task_id: task.id, run_id: jobId, conversation_phase: 'reviewing', fallback: true },
                created_at: Date.now(),
              }),
              supabase.from('supervisor_tasks').update({
                status: 'completed',
                result: { message_id: fallbackMsgId, fallback: true },
              }).eq('id', task.id),
            ]);
          }
          await storage.updateAgentRun(jobId, { status: 'completed', terminalState: 'completed', endedAt: new Date(), metadata: { verdict: 'review_fallback' } }).catch(() => {});
          await emitTaskExecutionCompleted('review_fallback');
          return;
        }
      }

      // ITERATING: User wants to modify previous search
      if (suggestedPhase === 'iterating' && convState.lastDelivery && !isClarifyResponse) {
        let iterationMatched = false;
        try {
          const { buildIteratedQuery } = await import('./supervisor/search-iteration');
          const iteration = buildIteratedQuery(rawMsg, convState.lastDelivery, convState.accumulatedContext);

          if (iteration) {
            iterationMatched = true;
            console.log(`[CONV_STATE] Search iteration: ${iteration.changeDescription} → "${iteration.modifiedMessage}"`);
            // Rewrite the message with the iterated query, then fall through to normal pipeline
            rawMsg = iteration.modifiedMessage;
            // Update phase
            const { updateConversationPhase } = await import('./supervisor/conversation-state');
            updateConversationPhase(task.conversation_id, 'executing');
          }
          // Fall through to normal pipeline with modified (or original) message
        } catch (err: any) {
          console.warn(`[CONV_STATE] Search iteration failed (falling through): ${err.message}`);
        }

        // If we suggested 'iterating' but couldn't parse the modification,
        // don't silently fall through — ask the user to clarify
        if (!iterationMatched) {
          const prevEntity = convState.lastDelivery.entityType || 'the same type';
          const prevLocation = convState.lastDelivery.location || 'the same area';
          const iterFallbackMsg = `I can see you want to modify your previous search for ${prevEntity} in ${prevLocation}, but I'm not sure what to change. You can say things like "now try Brighton" (change location), "find accountants instead" (change business type), or just tell me exactly what you'd like to search for.`;
          const iterFallbackId = randomUUID();
          if (supabase) {
            await Promise.all([
              supabase.from('messages').insert({
                id: iterFallbackId,
                conversation_id: task.conversation_id,
                role: 'assistant',
                content: iterFallbackMsg,
                source: 'supervisor',
                metadata: { supervisor_task_id: task.id, run_id: jobId, conversation_phase: 'iterating', fallback: true },
                created_at: Date.now(),
              }),
              supabase.from('supervisor_tasks').update({
                status: 'completed',
                result: { message_id: iterFallbackId, fallback: true },
              }).eq('id', task.id),
            ]);
          }
          await storage.updateAgentRun(jobId, { status: 'completed', terminalState: 'completed', endedAt: new Date(), metadata: { verdict: 'iteration_fallback' } }).catch(() => {});
          await emitTaskExecutionCompleted('iteration_fallback');
          return;
        }
      }
    }

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
          .limit(10);
        if (recentMsgs && recentMsgs.length > 0) {
          const reversed = recentMsgs.reverse() as Array<{ role: string; content: string }>;
          conversationContextStr = buildConversationContextString(reversed, 10);
        }
      } catch (ctxErr: any) {
        console.warn(`[INTENT_EXTRACTOR_SHADOW] conversation context fetch failed (non-fatal): ${ctxErr.message}`);
      }
    }

    // If the UI passed URL content in request_data, append it to conversation context
    const uiUrlContent = (requestData as any).url_content;
    if (uiUrlContent && typeof uiUrlContent === 'string' && uiUrlContent.length > 0) {
      conversationContextStr = (conversationContextStr || '') + '\n\nURL CONTENT (fetched by UI):\n' + uiUrlContent.slice(0, 5000);
      console.log(`[URL_CONTEXT] Appended ${uiUrlContent.length} chars of UI-fetched URL content to conversation context`);
    }

    // Append cross-session search history to context
    if (userContext.recentSearches && userContext.recentSearches.length > 0) {
      const searches = userContext.recentSearches;
      const mostRecent = searches[0]; // Already sorted by created_at DESC
      const older = searches.slice(1);
      
      let historyBlock = `\n\nUser's recent search history (from previous sessions):`;
      historyBlock += `\nMOST RECENT SEARCH (use this if user says "same again", "find more", "find some", etc.):`;
      historyBlock += `\n  >>> "${mostRecent.query}" → ${mostRecent.delivered} results (${mostRecent.verdict}, ${mostRecent.created})`;
      
      if (older.length > 0) {
        historyBlock += `\nOlder searches:`;
        for (const s of older) {
          historyBlock += `\n  - "${s.query}" → ${s.delivered} results (${s.verdict}, ${s.created})`;
        }
      }
      
      historyBlock += `\n\nINSTRUCTIONS FOR HANDLING VAGUE REFERENCES TO PAST SEARCHES:`;
      historyBlock += `\n1. If the user clearly references one search (e.g. "find more pubs" or "chemists in Brighton"), use that.`;
      historyBlock += `\n2. If the user is vague (e.g. "find some in X", "same again", "try that in Y") AND the last 2-3 searches were ALL the same type, use the MOST RECENT search as the template.`;
      historyBlock += `\n3. If the user is vague AND recent searches are DIFFERENT types (e.g. one was chemists, another was pubs), set clarification_needed=true and clarification_question to something like "I can see you recently searched for chemists in Littlehampton and pubs in Arundel. Which type would you like me to find in [location]?"`;
      historyBlock += `\n4. Do NOT default to a generic business type. Always use the search history to inform your interpretation.`;
      
      conversationContextStr = (conversationContextStr || '') + historyBlock;
    }

    // ── Cross-session vague reference resolver ──
    // If the user's message is short/vague AND we have recent search history,
    // rewrite the query to include the most recent search context explicitly.
    // This is more reliable than hoping the LLM reads embedded instructions.
    if (!_routerHandledSearch) {
      effectiveMsg = rawMsg;
      if (userContext.recentSearches && userContext.recentSearches.length > 0) {
        const msgLower = rawMsg.toLowerCase().trim();
        console.log(`[CROSS_SESSION_DEBUG] rawMsg="${rawMsg}" recentSearches=${userContext.recentSearches?.length ?? 0}`);
        const vaguePatterns = [
          /^(now\s+)?find\s+(some|more|them)\s+(in|near|around)\s+/i,
          /^(same|that)\s+(search|again|one)\s+(in|for|but)\s+/i,
          /^(try|do)\s+(that|this|the same|it)\s+(in|for|near)\s+/i,
          /^(more|some)\s+(in|near|around)\s+/i,
          /^find\s+(some|more)\s+in\s+/i,
        ];
        const isVague = vaguePatterns.some(p => p.test(msgLower));

        if (isVague) {
          const mostRecent = userContext.recentSearches[0];
          // Extract location from the vague message
          const locationMatch = msgLower.match(/(?:in|near|around)\s+(.+?)[\s.!?]*$/i);
          const newLocation = locationMatch ? locationMatch[1].trim() : null;

          if (newLocation && mostRecent.query) {
            // Try to extract the entity type from the most recent search
            // e.g. "find shoe shops in London" → "shoe shops"
            const entityMatch = mostRecent.query.match(/(?:find\s+)?(.+?)\s+(?:in|near|around)\s+/i);
            const entityType = entityMatch ? entityMatch[1].trim() : mostRecent.query;

            effectiveMsg = `find ${entityType} in ${newLocation}`;
            console.log(`[CROSS_SESSION] Vague reference resolved: "${rawMsg}" → "${effectiveMsg}" (based on most recent search: "${mostRecent.query}")`);
          }
        }
      } // end of recentSearches check
    } else {
      console.log(`[ROUTER_BYPASS] Skipping cross-session vague resolver — router already resolved query to: "${effectiveMsg}"`);
    }

    let shadowResult: { ran: boolean; extraction: any; error: string | null } = { ran: false, extraction: null, error: null };
    let shadowProbeError: string | null = null;
    if (!_routerHandledSearch) {
      try {
        shadowResult = await runIntentExtractorShadow(effectiveMsg, jobId, task.user_id, task.conversation_id, conversationContextStr);
      } catch (e: any) {
        shadowProbeError = e.message;
        console.warn(`[INTENT_EXTRACTOR_SHADOW] top-level error (non-fatal): ${e.message}`);
      }
    } else {
      console.log(`[ROUTER_BYPASS] Skipping intent extractor shadow — router already classified`);
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

    // INTENT_FIX: On clarification continuations, rawMsg is the clarification answer
    // (e.g., "sussex"), not the full original query. Mission extraction on this produces
    // intentNarrative = null because the LLM cannot extract a complete intent from one word.
    // The rawMsg restoration at the constraint_gate block (further down) happens AFTER
    // mission extraction already ran, so we fix it here before extraction starts.
    if (!_routerHandledSearch) {
      if (isClarifyResponse && task.conversation_id) {
        // For constraint_gate continuations: peek at the pending contract (non-destructive —
        // getPendingContract only deletes on TTL expiry, not on every read).
        const earlyPending = getPendingContract(task.conversation_id);
        if (earlyPending?.originalMessage && earlyPending.originalMessage !== rawMsg) {
          console.log(`[INTENT_FIX] Restoring rawMsg for mission extraction from pending contract: "${earlyPending.originalMessage.substring(0, 80)}" (was: "${rawMsg.substring(0, 40)}")`);
          rawMsg = earlyPending.originalMessage;
        } else if (((requestData as any).original_user_message || (requestData as any).original_message) && String((requestData as any).original_user_message || (requestData as any).original_message) !== rawMsg) {
          // Client may send original_user_message or original_message in request_data for clarify continuations
          const origMsg = String((requestData as any).original_user_message || (requestData as any).original_message);
          if (origMsg.length > rawMsg.length) {
            console.log(`[INTENT_FIX] Restoring rawMsg for mission extraction from requestData.original_message: "${origMsg.substring(0, 80)}" (was: "${rawMsg.substring(0, 40)}")`);
            rawMsg = origMsg;
          }
        }
      }
    }

    let missionResult: Awaited<ReturnType<typeof extractStructuredMission>> | null = null;
    const missionMode = getMissionExtractorMode();

    if (missionMode !== 'off') {
      try {
        missionResult = await extractStructuredMission(effectiveMsg, conversationContextStr, {
          runId: jobId,
          userId: task.user_id,
          conversationId: task.conversation_id,
        });
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

        if (missionResult.ok && missionResult.mission) {
          try {
            const completenessResult = checkMissionCompleteness(
              rawMsg,
              missionResult.trace.pass1_semantic_interpretation,
              missionResult.mission,
            );

            logCompletenessToAFR(
              completenessResult,
              task.user_id,
              jobId,
              task.conversation_id,
            ).catch((e: any) => console.warn(`[COMPLETENESS_CHECK] AFR log failed (non-fatal): ${e.message}`));

            if (!completenessResult.ok) {
              const droppedSummary = completenessResult.dropped_concepts
                .map((d) => `${d.severity}:${d.category}:"${d.matched_phrase}"`)
                .join(', ');
              console.warn(
                `[COMPLETENESS_CHECK] runId=${jobId} DROPPED CONCEPTS: ${droppedSummary} ` +
                `action=${completenessResult.recommended_action}`
              );

              createArtefact({
                runId: jobId,
                type: 'mission_completeness_check',
                title: `Completeness check: ${completenessResult.dropped_concepts.length} dropped concept(s) — ${completenessResult.recommended_action}`,
                summary: `ok=false action=${completenessResult.recommended_action} dropped=${completenessResult.dropped_concepts.length} warnings=${completenessResult.warnings.length}`,
                payload: completenessResult as unknown as Record<string, unknown>,
                userId: task.user_id,
                conversationId: task.conversation_id,
              }).catch((e: any) => console.warn(`[COMPLETENESS_CHECK] Artefact creation failed (non-fatal): ${e.message}`));

              this.postArtefactToUI({
                runId: jobId,
                clientRequestId,
                type: 'diagnostic',
                payload: {
                  ...completenessResult as unknown as Record<string, unknown>,
                  title: 'Mission completeness audit',
                  diagnostic_type: 'mission_completeness_check',
                },
                userId: task.user_id,
                conversationId: task.conversation_id,
              }).catch(() => {});

              if (completenessResult.recommended_action === 'block') {
                console.error(
                  `[COMPLETENESS_CHECK] runId=${jobId} BLOCKING — hard meaning dropped from mission. ` +
                  `Invalidating mission result to force fallback.`
                );
                missionResult = {
                  ...missionResult,
                  ok: false,
                  mission: null,
                  trace: {
                    ...missionResult.trace,
                    failure_stage: 'pass2_schema_validation',
                    validation_result: {
                      ok: false,
                      mission: null,
                      errors: completenessResult.dropped_concepts
                        .filter((d) => d.severity === 'hard')
                        .map(
                          (d) =>
                            `Completeness block: ${d.category} meaning "${d.matched_phrase}" detected in ${d.source} but no ${d.expected_constraint_type} constraint in mission`,
                        ),
                    },
                  },
                };
              }
            } else {
              console.log(`[COMPLETENESS_CHECK] runId=${jobId} PASSED — no dropped concepts`);
            }
          } catch (checkErr: any) {
            console.warn(`[COMPLETENESS_CHECK] Check failed (non-fatal): ${checkErr.message}`);
          }
        }
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

    // Deterministic searchability check: if the mission already has entity_category + location_text +
    // at least one constraint, there is enough content to execute a search regardless of what the LLM
    // sets for clarification_needed. The LLM flag is treated as a suggestion, not a gate, when the
    // structured mission is actionable. This eliminates non-deterministic clarification halts.
    const _clarifyGateEntity = missionResult?.mission?.entity_category?.trim() ?? '';
    const _clarifyGateLocation = missionResult?.mission?.location_text?.trim() ?? '';
    const _clarifyGateConstraintCount = missionResult?.mission?.constraints?.length ?? 0;
    const _missionHasEnoughToSearch =
      missionResult?.ok === true &&
      !!missionResult.mission &&
      !!_clarifyGateEntity &&
      !!_clarifyGateLocation &&
      _clarifyGateConstraintCount > 0;

    let earlyParsedGoal: ParsedGoal | null = null;
    let intentSource: 'mission' | 'canonical' | 'legacy' = 'legacy';
    let legacyFallbackReason: string | null = null;
    let activeMissionPlan: MissionPlan | null = null;
    let useMissionExecution = false;

    const canonicalValid = shadowResult.ran && shadowResult.extraction?.validation?.ok && shadowResult.extraction.validation.intent;
    const canonicalIntent = canonicalValid
      ? neutraliseClarifyIfNeeded(shadowResult.extraction!.validation.intent!)
      : null;

    try {

    if (missionMode === 'active' && missionResult?.ok && missionResult.mission) {
      try {
        console.log(`[STAGE] runId=${jobId} crid=${clientRequestId} stage=early_parse_goal source=mission_active`);
        earlyParsedGoal = missionToParsedGoal(missionResult.mission, rawMsg.trim());
        intentSource = 'mission';
        console.log(`[INTENT_SOURCE] mission_active — bt=${earlyParsedGoal.business_type} loc=${earlyParsedGoal.location} count=${earlyParsedGoal.requested_count_user} constraints=${earlyParsedGoal.constraints.length}`);

        const handoffDiag = buildHandoffDiagnostic(missionResult.mission, earlyParsedGoal.constraints);
        if (handoffDiag.downgrade_count > 0) {
          console.warn(
            `[HANDOFF_DIAGNOSTIC] runId=${jobId} DOWNGRADES DETECTED: ${handoffDiag.downgrade_count} — ` +
            handoffDiag.downgrades.map(d => `${d.reason}: ${d.detail}`).join('; ')
          );
        } else {
          console.log(`[HANDOFF_DIAGNOSTIC] runId=${jobId} fidelity=${handoffDiag.mapping_fidelity} — no downgrades`);
        }

        createArtefact({
          runId: jobId,
          type: 'mission_handoff_diagnostic',
          title: `Handoff: ${handoffDiag.mapping_fidelity} fidelity — ${handoffDiag.canonical_constraints.length} canonical → ${handoffDiag.mapped_constraints.length} mapped` +
            (handoffDiag.downgrade_count > 0 ? ` (${handoffDiag.downgrade_count} downgrade(s))` : ''),
          summary: `fidelity=${handoffDiag.mapping_fidelity} canonical=${handoffDiag.canonical_constraints.length} mapped=${handoffDiag.mapped_constraints.length} downgrades=${handoffDiag.downgrade_count}`,
          payload: handoffDiag as unknown as Record<string, unknown>,
          userId: task.user_id,
          conversationId: task.conversation_id,
        }).catch((e: any) => console.warn(`[HANDOFF_DIAGNOSTIC] Artefact creation failed (non-fatal): ${e.message}`));

        this.postArtefactToUI({
          runId: jobId,
          clientRequestId,
          type: 'diagnostic',
          payload: {
            ...handoffDiag as unknown as Record<string, unknown>,
            title: 'Mission handoff diagnostic',
            diagnostic_type: 'mission_handoff_diagnostic',
          },
          userId: task.user_id,
          conversationId: task.conversation_id,
        }).catch(() => {});

        try {
          const missionPlan = buildMissionPlan(missionResult.mission!);
          logMissionPlan(missionPlan, jobId);

          activeMissionPlan = missionPlan;
          useMissionExecution = true;
          console.log(`[MISSION_EXEC_FLAG] runId=${jobId} useMissionExecution=true strategy=${missionPlan.strategy} tools=${missionPlan.tool_sequence.join(',')}`);

          persistMissionPlan(missionPlan, jobId, task.user_id, task.conversation_id).catch(
            (e: any) => console.warn(`[MISSION_PLANNER] Artefact persist failed (non-fatal): ${e.message}`)
          );

          this.postArtefactToUI({
            runId: jobId,
            clientRequestId,
            type: 'diagnostic',
            payload: {
              ...missionPlan as unknown as Record<string, unknown>,
              title: 'Stage 2 mission plan',
              diagnostic_type: 'mission_plan',
            },
            userId: task.user_id,
            conversationId: task.conversation_id,
          }).catch(() => {});
        } catch (planErr: any) {
          const bt = missionResult?.mission?.entity_category ?? 'unknown';
          const loc = missionResult?.mission?.location_text ?? 'unknown';
          const constraintSummary = missionResult?.mission?.constraints?.map(c => `${c.type}(${c.field}="${c.value}")`).join(', ') ?? 'none';
          console.warn(`[PLAN_BUILD_FAIL] bt="${bt}" location="${loc}" constraints=[${constraintSummary}] error="${planErr.message}"`);
          useMissionExecution = false;
          activeMissionPlan = null;
          legacyFallbackReason = `plan_build_failed: ${planErr.message?.substring(0, 100)}`;
        }
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
      previewBT = null;
      previewLoc = null;
      previewCount = null;
      previewTime = null;
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

    let pendingConstraint = getPendingContract(task.conversation_id);

    if (!pendingConstraint && supabase) {
      try {
        const { data: clarifyingRuns } = await supabase.from('agent_runs')
          .select('id, status, metadata')
          .eq('conversation_id', task.conversation_id)
          .eq('status', 'clarifying')
          .order('created_at', { ascending: false })
          .limit(1);

        const existingRun = clarifyingRuns?.[0];
        if (
          existingRun &&
          existingRun.metadata?.verdict === 'constraint_gate_clarify' &&
          existingRun.metadata?.constraint_contract
        ) {
          let recoveredOriginal = existingRun.metadata.original_message || '';
          if (!recoveredOriginal) {
            const { data: userMsgs } = await supabase.from('messages')
              .select('content')
              .eq('conversation_id', task.conversation_id)
              .eq('role', 'user')
              .order('created_at', { ascending: true })
              .limit(1);
            recoveredOriginal = userMsgs?.[0]?.content || '';
          }

          if (recoveredOriginal) {
            const recoveredRunId = existingRun.id;
            console.log(`[CONSTRAINT_GATE] Recovered pending contract from DB — in-memory contract lost (server restart?) originalRunId=${recoveredRunId} currentJobId=${jobId}`);
            if (recoveredRunId !== jobId) {
              console.log(`[CONSTRAINT_GATE] Reusing original runId=${recoveredRunId} (was ${jobId})`);
              jobId = recoveredRunId;
            }
            storePendingContract(task.conversation_id, recoveredOriginal, existingRun.metadata.constraint_contract, recoveredRunId);
            pendingConstraint = getPendingContract(task.conversation_id);
          }
        }
      } catch (e: any) {
        console.warn(`[CONSTRAINT_GATE] Failed to recover pending contract from DB (non-fatal): ${e.message}`);
      }
    }

    // ═══ MINIMUM VIABILITY GUARD ═══
    // If the message is extremely short (< 4 chars) or is a common filler word,
    // don't waste an LLM call on mission extraction — just ask what they want.
    const FILLER_WORDS = /^(any|all|yes|no|ok|sure|yep|nah|nope|hmm|um|eh|lol|k|y|n)\s*[.!?]*$/i;
    if (!isClarifyResponse && !missionQueryId && (rawMsg.trim().length < 4 || FILLER_WORDS.test(rawMsg.trim()))) {
      // Check: is there a pending contract? If so, these short answers ARE clarify responses
      // and should flow through. But if there's no pending contract, they're just noise.
      if (!pendingConstraint) {
        const viabilityMsg = "I didn't quite catch that. What would you like me to search for? Try something like 'find accountants in Kent' or 'search for web design agencies in Brighton'.";
        const viabilityMsgId = randomUUID();

        await Promise.all([
          supabase!.from('supervisor_tasks').update({
            status: 'completed',
            result: { response: viabilityMsg.substring(0, 200), message_id: viabilityMsgId, classifier: 'minimum_viability_guard' },
          }).eq('id', task.id),
          supabase!.from('messages').insert({
            id: viabilityMsgId,
            conversation_id: task.conversation_id,
            role: 'assistant',
            content: viabilityMsg,
            source: 'supervisor',
            metadata: { supervisor_task_id: task.id, run_id: jobId, minimum_viability_guard: true },
            created_at: Date.now(),
          }),
        ]);

        await storage.updateAgentRun(jobId, {
          status: 'completed',
          terminalState: 'completed',
          endedAt: new Date(),
          metadata: { verdict: 'minimum_viability_guard', raw_message: rawMsg },
        }).catch(() => {});

        console.log(`[VIABILITY_GUARD] Blocked ultra-short/filler message: "${rawMsg}" — asked for clarification`);
        await emitTaskExecutionCompleted('minimum_viability_guard');
        return;
      }
    }

    if (pendingConstraint) {
      console.log(`[CONSTRAINT_GATE] Follow-up detected for conversation=${task.conversation_id} — resolving constraint contract`);
      let resolvedContract = resolveFollowUp(pendingConstraint.contract, rawMsg);

      if (!resolvedContract.can_execute && !resolvedContract.stop_recommended) {
        const hasUnresolvedRelationship = resolvedContract.constraints.some(
          c => c.type === 'relationship_predicate' && !c.can_execute
        );
        const missionDroppedConstraints = missionResult?.ok && missionResult.mission &&
          missionResult.mission.constraints.length === 0;
        const followUpLooksLikeSkip = /\b(?:skip|all\s+results?|don'?t\s+(?:worry|bother|need)|without|ignore|remove|drop)\b/i.test(rawMsg);

        if (hasUnresolvedRelationship && (missionDroppedConstraints || followUpLooksLikeSkip)) {
          console.log(`[CONSTRAINT_GATE] Mission/follow-up indicates relationship constraint should be dropped — auto-resolving as skip_if_uncertain (mission_dropped=${!!missionDroppedConstraints} followup_skip=${followUpLooksLikeSkip})`);
          resolvedContract = {
            ...resolvedContract,
            can_execute: true,
            why_blocked: null,
            clarify_questions: [],
            constraints: resolvedContract.constraints.map(c => {
              if (c.type === 'relationship_predicate' && !c.can_execute) {
                return { ...c, can_execute: true, why_blocked: '', chosen_relationship_strategy: 'skip_if_uncertain' as const };
              }
              return c;
            }),
          };
        }
      }

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

        await storage.updateAgentRun(jobId, { status: 'clarifying', terminalState: null, metadata: { verdict: 'constraint_gate_clarify', awaiting: 'user_input', constraint_contract: resolvedContract, original_message: pendingConstraint.originalMessage } }).catch(() => {});
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


    if (_routerHandledSearch) {
      console.log(`[ROUTER_BYPASS] Skipping constraint gate + smart clarify — router confirmed searchable`);
    } else {
    console.log(`[STAGE] runId=${jobId} crid=${clientRequestId} stage=constraint_gate`);
    // OUTER CONSTRAINT GATE — runs BEFORE executeTowerLoopChat
    const outerGateMsg = String((task.request_data as any).user_message || '').trim();
    const outerGateAlreadyResolved = !!(task.request_data as any)._constraint_gate_resolved;
    if (!outerGateAlreadyResolved && outerGateMsg.length > 0) {
      const noProxySource = outerGateMsg;
      const noProxyFromOriginal = detectNoProxySignal(noProxySource);
      const mustBeCertainFromOriginal = detectMustBeCertain(noProxySource);
      let outerGateResult = await (canonicalIntent
        ? preExecutionConstraintGateFromIntent(canonicalIntent, outerGateMsg)
        : preExecutionConstraintGate(outerGateMsg));
      if (!outerGateResult.semantic_source) outerGateResult.semantic_source = 'fallback_regex';

      if (mustBeCertainFromOriginal && !outerGateResult.stop_recommended && outerGateResult.constraints.length > 0) {
        for (const c of outerGateResult.constraints) {
          c.must_be_certain = true;
        }
        outerGateResult = applyCertaintyGate(outerGateResult);
        console.log(`[CONSTRAINT_GATE_OUTER] must-be-certain signal detected from original request "${noProxySource.substring(0, 60)}" — applying certainty gate`);
      }

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

      // Pass 3 is the sole authority on clarification — if it cleared the query,
      // override any non-stop clarify block (e.g. relationship predicates that Pass 3
      // correctly identified as commercial context rather than constraints).
      if (!outerGateResult.can_execute && (!outerGateResult.stop_recommended || missionQueryId)) {
        // If the structured mission has entity + location + constraint, it is searchable regardless
        // of what the constraint gate says about can_execute. Relationship predicates flagging
        // can_execute=false with stop_recommended=false should never halt a search that has
        // enough content to execute. _missionHasEnoughToSearch is evaluated earlier in this fn.
        if (!outerGateResult.can_execute && _missionHasEnoughToSearch) {
          console.log('[OUTER-GATE] Suppressed — mission has enough to search:', {
            entity_category: _clarifyGateEntity,
            location_text: _clarifyGateLocation,
            constraintCount: _clarifyGateConstraintCount,
            blocked_types: outerGateResult.constraints.map((c: any) => c.type),
          });
          outerGateResult = { ...outerGateResult, can_execute: true, why_blocked: null, clarify_questions: [] };
        }
        if (missionQueryId && !outerGateResult.can_execute) {
          console.log(`[CONSTRAINT_GATE_OUTER] benchmark run (query_id=${missionQueryId}) — bypassing constraint gate (stop=${outerGateResult.stop_recommended}), forcing execution`);
          outerGateResult = { ...outerGateResult, can_execute: true, why_blocked: null, clarify_questions: [] };
        }
      }

      console.log(`[CONSTRAINT_GATE_OUTER] can_execute=${outerGateResult.can_execute} stop=${outerGateResult.stop_recommended} constraints=${outerGateResult.constraints.length} msg="${outerGateMsg.substring(0, 80)}"`);

      if (!outerGateResult.can_execute) {
        await createArtefact({
          runId: jobId,
          type: 'diagnostic',
          title: `Pre-execution constraint gate (outer): BLOCKED (stop=${outerGateResult.stop_recommended})`,
          summary: outerGateResult.why_blocked || 'Constraints require clarification',
          payload: { constraint_contract: outerGateResult, original_goal: outerGateMsg },
          userId: task.user_id,
          conversationId: task.conversation_id,
        }).catch((e: any) => console.warn(`[CONSTRAINT_GATE_OUTER] Failed to emit artefact: ${e.message}`));

        storePendingContract(task.conversation_id, outerGateMsg, outerGateResult, jobId);

        // Smart clarification: generate context-aware message instead of canned question
        let outerGateClarifyMsg: string;
        if (process.env.SMART_CLARIFY_ENABLED === 'true' && !outerGateResult.stop_recommended) {
          try {
            const { generateSmartClarification } = await import('./supervisor/smart-clarify');
            const smartResult = await generateSmartClarification({
              userMessage: rawMsg,
              conversationContext: conversationContextStr ?? null,
              partialMission: missionResult?.mission ?? null,
              missingFields: outerGateResult.constraints
                .filter((c: any) => !c.can_execute)
                .map((c: any) => c.type),
              urlContent: (requestData as any).url_content ?? null,
              userProfile: userContext?.profile ?? null,
            });
            outerGateClarifyMsg = smartResult.clarification_message;

            (outerGateResult as any)._inferred_context = smartResult.inferred_context;
            if (smartResult.proposed_query) {
              (outerGateResult as any)._proposed_query = smartResult.proposed_query;
            }

            console.log(`[SMART_CLARIFY] Used smart clarification for runId=${jobId}: "${outerGateClarifyMsg.slice(0, 80)}"`);

            if (CONV_STATE_ENABLED) {
              try {
                const { updateConversationPhase } = await import('./supervisor/conversation-state');
                updateConversationPhase(task.conversation_id, 'exploring', {
                  accumulatedContext: {
                    originalUserMessage: rawMsg,
                    ...(smartResult.inferred_context?.product_description ? { productDescription: smartResult.inferred_context.product_description } : {}),
                    ...(smartResult.inferred_context?.suggested_sectors ? { suggestedSectors: smartResult.inferred_context.suggested_sectors } : {}),
                  },
                });
              } catch (e: any) {}
            }
          } catch (smartErr: any) {
            console.warn(`[SMART_CLARIFY] Failed (using canned fallback): ${smartErr.message}`);
            outerGateClarifyMsg = buildConstraintGateMessage(outerGateResult);
          }
        } else {
          outerGateClarifyMsg = buildConstraintGateMessage(outerGateResult);
        }
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
            original_message: outerGateMsg,
          },
        }).catch(() => {});
        console.log(`[CONSTRAINT_GATE_OUTER] BLOCKED — status=${outerStatus} terminalState=${outerTermState}`);
        await emitTaskExecutionCompleted('outer_constraint_gate', { stop: outerGateResult.stop_recommended });
        return;
      }
    }

    // Smart clarification trigger 2: mission quality check
    // Even if constraint gate says can_execute=true, if the mission is thin/vague,
    // the smart clarification should fire to help the user refine their query.
    // This produces the rich mission intent card and better search results.
    if (
      process.env.SMART_CLARIFY_ENABLED === 'true' &&
      useMissionExecution &&
      missionResult?.ok &&
      missionResult.mission
    ) {
      const mission = missionResult.mission;
      const hasKeyDiscriminator = !!(mission.key_discriminator && mission.key_discriminator.trim().length > 10);
      const hasExcludingCriteria = !!(mission.excluding_criteria && mission.excluding_criteria.trim().length > 5);
      const hasEntityDescription = !!(mission.entity_description && mission.entity_description.trim().length > 20);

      // Mission is "thin" if it's missing the rich fields that power the intent card
      const isThinMission = !hasKeyDiscriminator && !hasExcludingCriteria && !hasEntityDescription;

      // Also check: did the user provide a URL? URL queries are almost always complex enough
      // to benefit from smart clarification
      const hasUrl = /https?:\/\//.test(rawMsg);

      // Also check: is the entity_category very generic?
      const genericEntityPatterns = /^(businesses|companies|organisations|organizations|leads|prospects|firms|entities)\b/i;
      const isGenericEntity = genericEntityPatterns.test(mission.entity_category || '');

      const shouldSmartClarify = isThinMission && (hasUrl || isGenericEntity);

      if (shouldSmartClarify) {
        console.log(`[SMART_CLARIFY_QUALITY] Thin mission detected — triggering smart clarification despite can_execute=true. entity="${mission.entity_category}" hasKeyDisc=${hasKeyDiscriminator} hasExcl=${hasExcludingCriteria} hasDesc=${hasEntityDescription} hasUrl=${hasUrl} isGeneric=${isGenericEntity}`);

        try {
          const { generateSmartClarification } = await import('./supervisor/smart-clarify');
          const smartResult = await generateSmartClarification({
            userMessage: rawMsg,
            conversationContext: conversationContextStr ?? null,
            partialMission: missionResult.mission,
            missingFields: ['specificity'],
            urlContent: (requestData as any).url_content ?? null,
            userProfile: userContext?.profile ?? null,
          });

          // Store as pending contract so the follow-up flows through existing system
          const thinMissionContract = {
            can_execute: false,
            stop_recommended: false,
            why_blocked: 'Mission is too vague for good results — asking for clarification',
            clarify_questions: [smartResult.clarification_message],
            constraints: earlyParsedGoal?.constraints || [],
            _inferred_context: smartResult.inferred_context,
            _proposed_query: smartResult.proposed_query,
          };

          storePendingContract(task.conversation_id, rawMsg, thinMissionContract as any, jobId);

          const clarifyMsg = sanitizeMessageContent(smartResult.clarification_message);
          const messageId = randomUUID();

          await Promise.all([
            supabase!.from('supervisor_tasks').update({
              status: 'completed',
              result: { response: clarifyMsg.substring(0, 200), message_id: messageId, clarify_gate: 'smart_clarify_quality' },
            }).eq('id', task.id),
            supabase!.from('messages').insert({
              id: messageId,
              conversation_id: task.conversation_id,
              role: 'assistant',
              content: clarifyMsg,
              source: 'supervisor',
              metadata: {
                supervisor_task_id: task.id,
                run_id: jobId,
                clarify_gate: 'smart_clarify_quality',
                smart_clarify: true,
                inferred_context: smartResult.inferred_context,
                mode: 'clarify',
              },
              created_at: Date.now(),
            }),
          ]);

          await storage.updateAgentRun(jobId, {
            status: 'clarifying',
            terminalState: null,
            metadata: {
              verdict: 'smart_clarify_quality',
              original_message: rawMsg,
              constraint_contract: thinMissionContract,
              thin_mission: true,
              entity_category: mission.entity_category,
            },
          }).catch(() => {});

          console.log(`[SMART_CLARIFY_QUALITY] Asked for clarification: "${clarifyMsg.slice(0, 80)}" runId=${jobId}`);
          await emitTaskExecutionCompleted('smart_clarify_quality');

          if (CONV_STATE_ENABLED) {
            try {
              const { updateConversationPhase } = await import('./supervisor/conversation-state');
              updateConversationPhase(task.conversation_id, 'exploring', {
                accumulatedContext: {
                  originalUserMessage: rawMsg,
                  ...(smartResult.inferred_context?.product_description ? { productDescription: smartResult.inferred_context.product_description } : {}),
                  ...(smartResult.inferred_context?.suggested_sectors ? { suggestedSectors: smartResult.inferred_context.suggested_sectors } : {}),
                },
              });
            } catch (e: any) {}
          }
          return;
        } catch (smartErr: any) {
          console.warn(`[SMART_CLARIFY_QUALITY] Failed (proceeding with thin mission): ${smartErr.message}`);
          // Fall through to execute with thin mission — still better than failing
        }
      }
    }
    } // end of else (_routerHandledSearch bypass for constraint gate + smart clarify)

    const executionSource = useMissionExecution && activeMissionPlan && missionResult?.ok && missionResult.mission
      ? 'mission' as const
      : 'legacy' as const;
    console.log(`[STAGE] runId=${jobId} crid=${clientRequestId} stage=execution execution_source=${executionSource}`);
    let towerResult: { response: string; leadIds: string[]; deliverySummary: DeliverySummaryPayload | null; towerVerdict: string | null; leads: Array<{ name: string; address: string; phone: string | null; website: string | null; placeId: string }> };
    let runFailed = false;
    let failureReason = '';
    try {
      if (executionSource === 'mission') {
        console.log(`[STAGE] runId=${jobId} crid=${clientRequestId} stage=executeMissionWithReloop strategy=${activeMissionPlan!.strategy}`);

        // ── 6.2 Crash Recovery: check for resumable loop state ──
        let recoveryCheckpoint: import('./supervisor/reloop/types').ResumeCheckpoint | null = null;
        const crashRecoveryEnabled = (process.env.CRASH_RECOVERY_ENABLED || 'false').toLowerCase() === 'true';

        if (crashRecoveryEnabled) {
          try {
            const { data: existingRunData } = await supabase!
              .from('agent_runs')
              .select('id, status, metadata')
              .eq('id', jobId)
              .maybeSingle();
            const shouldCheckResume = existingRunData?.metadata?.resume_from_loop_state === true;

            if (shouldCheckResume) {
              const { checkForResumableState } = await import('./supervisor/reloop/resume');
              recoveryCheckpoint = await checkForResumableState(jobId);

              if (recoveryCheckpoint) {
                console.log(`[CRASH_RECOVERY] Run ${jobId}: resuming from loop ${recoveryCheckpoint.lastCompletedLoop + 1} phase=${recoveryCheckpoint.resumeFrom} entities=${recoveryCheckpoint.accumulatedEntities.length}`);

                await createArtefact({
                  runId: jobId,
                  type: 'diagnostic',
                  title: `Crash recovery activated for run ${jobId}`,
                  summary: `Resuming from loop ${recoveryCheckpoint.lastCompletedLoop + 1} (${recoveryCheckpoint.resumeFrom}). ${recoveryCheckpoint.accumulatedEntities.length} entities recovered.`,
                  payload: {
                    resume_from: recoveryCheckpoint.resumeFrom,
                    last_completed_loop: recoveryCheckpoint.lastCompletedLoop,
                    accumulated_entities: recoveryCheckpoint.accumulatedEntities.length,
                    executors_tried: recoveryCheckpoint.executorsTriedSoFar,
                  },
                  userId: task.user_id,
                  conversationId: task.conversation_id,
                }).catch(() => {});
              } else {
                console.log(`[CRASH_RECOVERY] Run ${jobId}: no resumable state found, will restart from scratch`);
              }
            }
          } catch (recoveryErr: any) {
            console.warn(`[CRASH_RECOVERY] Run ${jobId}: recovery check failed (non-fatal, proceeding with full restart): ${recoveryErr.message}`);
            recoveryCheckpoint = null;
          }
        }

        const missionCtx: MissionExecutionContext = {
          mission: missionResult!.mission!,
          plan: activeMissionPlan!,
          runId: jobId,
          userId: task.user_id,
          conversationId: task.conversation_id,
          clientRequestId,
          rawUserInput: rawMsg.trim(),
          missionTrace: missionResult!.trace,
          intentNarrative: missionResult!.intentNarrative ?? null,
          queryId: missionQueryId,
          executionPath: (requestData as any).execution_path === 'gpt4o_primary' ? 'gpt4o_primary' : 'gp_cascade',
          checkpoint: recoveryCheckpoint,
        };
        console.log('[QID-TRACE]', 'step2:missionCtx_built', missionCtx.queryId);
        towerResult = await executeMissionWithReloop(missionCtx);
      } else {
      let directExecutionSucceeded = false;

      // ── RESCUE_SKIP guard ────────────────────────────────────────────────────
      // If mission extraction actually succeeded but plan building failed (or
      // missionMode isn't 'active' so useMissionExecution was never set),
      // build a minimal fallback plan inline and execute directly instead of
      // firing the rescue LLM on a perfectly valid query.
      //
      // NOTE: uses entity_category / location_text — the actual StructuredMission
      // field names. The old guard checked business_type / location (wrong) so
      // it never fired. Fixed here.
      if (missionResult?.ok && missionResult.mission?.entity_category && missionResult.mission?.location_text) {
        const _rsBt  = missionResult.mission.entity_category;
        const _rsLoc = missionResult.mission.location_text;
        console.log(`[RESCUE_SKIP] runId=${jobId} — Mission extraction succeeded (bt="${_rsBt}" loc="${_rsLoc}") but useMissionExecution=false (reason=${legacyFallbackReason ?? 'unknown'}). Building inline fallback plan and executing directly.`);
        try {
          // Build a minimal discovery-only plan inline — do NOT re-call
          // buildMissionPlan since that is likely what threw. The inline plan
          // uses discovery_only strategy which is safe for any valid query.
          const fallbackPlan: MissionPlan = {
            strategy: 'discovery_only',
            tool_sequence: ['SEARCH_PLACES'],
            steps: [{
              order: 1,
              tool: 'SEARCH_PLACES',
              purpose: `Discover candidate ${_rsBt} in ${_rsLoc}`,
              driven_by_constraint_indices: [],
            }],
            rules_fired: ['RULE_DISCOVERY'],
            constraint_mappings: [],
            verification_methods: ['none'],
            expected_artefacts: ['search_results'],
            selection_reason: `Rescue-skip fallback plan for "${_rsBt}" in "${_rsLoc}" — bypassing buildMissionPlan (reason: ${legacyFallbackReason ?? 'unknown'})`,
            verification_policy: {
              verification_policy: 'DIRECTORY_VERIFIED',
              reason: 'Discovery-only rescue-skip fallback plan',
            },
            canonical_input: {
              entity_category: missionResult.mission.entity_category,
              location_text: missionResult.mission.location_text,
              mission_mode: missionResult.mission.mission_mode,
              constraints: missionResult.mission.constraints.map((c, i) => ({
                index: i,
                type: c.type,
                field: c.field,
                operator: c.operator,
                value: c.value,
                hardness: c.hardness,
              })),
            },
          };

          // Fix Problem 3: keep activeMissionPlan up-to-date for downstream
          // benchmark records so planGenerated is not falsely logged as false.
          activeMissionPlan = fallbackPlan;

          // Fix Problem 2: emit plan artefact so the UI gets an early signal
          // that execution has started (same as the normal mission path at ~1500).
          persistMissionPlan(fallbackPlan, jobId, task.user_id, task.conversation_id)
            .catch((e: any) => console.warn(`[RESCUE_SKIP] persistMissionPlan failed (non-fatal): ${e.message}`));

          const directCtx: MissionExecutionContext = {
            mission: missionResult.mission,
            plan: fallbackPlan,
            runId: jobId,
            userId: task.user_id,
            conversationId: task.conversation_id,
            clientRequestId,
            rawUserInput: rawMsg.trim(),
            missionTrace: missionResult.trace,
            intentNarrative: missionResult.intentNarrative ?? null,
            queryId: missionQueryId,
            executionPath: (requestData as any).execution_path === 'gpt4o_primary' ? 'gpt4o_primary' : 'gp_cascade',
          };
          towerResult = await executeMissionWithReloop(directCtx);
          directExecutionSucceeded = true;
          console.log(`[RESCUE_SKIP] Direct execution succeeded — ${towerResult.leads.length} leads`);
        } catch (directExecErr: any) {
          console.warn(`[RESCUE_SKIP] Direct execution also failed (${directExecErr.message}), falling through to rescue LLM`);
          activeMissionPlan = null; // revert since execution didn't complete
        }
      }

      if (!directExecutionSucceeded) {
      const legacyReason = legacyFallbackReason ?? 'mission_extraction_failed';
      console.log(`[RESCUE_LLM] runId=${jobId} — mission extraction failed (${legacyReason}). Attempting rescue...`);

      let rescueResult: RescueResult;
      try {
        const recentHistory: Array<{ role: string; content: string }> = [];
        if (task.conversation_id && supabase) {
          try {
            const { data: histMsgs } = await supabase
              .from('messages')
              .select('role, content')
              .eq('conversation_id', task.conversation_id)
              .order('created_at', { ascending: false })
              .limit(6);
            if (histMsgs) {
              for (const m of histMsgs.reverse()) {
                recentHistory.push({ role: m.role, content: String(m.content || '').substring(0, 300) });
              }
            }
          } catch (histErr: any) {
            console.warn(`[RESCUE_LLM] Failed to fetch conversation history: ${histErr.message}`);
          }
        }

        rescueResult = await attemptRescueLLM({
          originalQuery: rawMsg,
          conversationHistory: recentHistory,
          failureReason: legacyReason,
          extractedGoal: earlyParsedGoal,
          canonicalIntent: canonicalIntent,
          userId: task.user_id,
          jobId,
          clientRequestId,
          conversationId: task.conversation_id,
        });
      } catch (rescueErr: any) {
        console.error(`[RESCUE_LLM] attemptRescueLLM threw: ${rescueErr.message}`);
        rescueResult = {
          outcome: 'clarification_needed',
          reasoning: `Rescue LLM threw: ${rescueErr.message}`,
          clarificationQuestion: "I want to make sure I find exactly the right leads for you. Could you tell me a bit more about what you're looking for — specifically, what type of business and where?",
          missingFields: ['business_type', 'location'],
        };
      }

      logRescueEvent({
        outcome: rescueResult.outcome,
        reasoning: rescueResult.reasoning,
        originalQuery: rawMsg,
        failureReason: legacyReason,
        rewrittenMission: rescueResult.rewrittenMission,
        clarificationQuestion: rescueResult.clarificationQuestion,
        missingFields: rescueResult.missingFields,
        confidence: rescueResult.confidence,
        userId: task.user_id,
        conversationId: task.conversation_id,
        runId: jobId,
        partialExtraction: earlyParsedGoal,
      }).catch((logErr: any) => console.warn(`[RESCUE_LLM] logRescueEvent failed: ${logErr.message}`));

      createArtefact({
        runId: jobId,
        type: 'rescue_llm',
        title: `Rescue LLM: ${rescueResult.outcome}`,
        summary: rescueResult.reasoning,
        payload: {
          outcome: rescueResult.outcome,
          reasoning: rescueResult.reasoning,
          rewritten_mission: rescueResult.rewrittenMission ?? null,
          clarification_question: rescueResult.clarificationQuestion ?? null,
          confidence: rescueResult.confidence ?? null,
          failure_reason: legacyReason,
          original_query: rawMsg,
        },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch(() => {});

      if (rescueResult.outcome === 'self_healed' && rescueResult.rewrittenMission) {
        console.log(`[RESCUE_LLM] Self-healed! bt="${rescueResult.rewrittenMission.business_type}" loc="${rescueResult.rewrittenMission.location}"`);
        const rewrittenQuery = `find ${rescueResult.rewrittenMission.business_type} in ${rescueResult.rewrittenMission.location}${rescueResult.rewrittenMission.criteria ? ' ' + rescueResult.rewrittenMission.criteria : ''}`;

        try {
          const rescuedMission = await extractStructuredMission(rewrittenQuery, conversationContextStr);
          if (rescuedMission.ok && rescuedMission.mission) {
            const rescuedPlan = buildMissionPlan(rescuedMission.mission);
            logMissionPlan(rescuedPlan, jobId);
            const rescuedCtx: MissionExecutionContext = {
              mission: rescuedMission.mission,
              plan: rescuedPlan,
              runId: jobId,
              userId: task.user_id,
              conversationId: task.conversation_id,
              clientRequestId,
              rawUserInput: rawMsg,
              missionTrace: rescuedMission.trace,
              intentNarrative: rescuedMission.intentNarrative,
              queryId: missionQueryId,
            };
            towerResult = await executeMissionWithReloop(rescuedCtx);
            const rescueSucceeded = towerResult && towerResult.leads && towerResult.leads.length > 0;
            updateRescueSuccess(jobId, rescueSucceeded, towerResult?.leads?.length ?? 0).catch(() => {});
            console.log(`[RESCUE_LLM] Self-heal complete: ${towerResult.leads.length} leads`);
          } else {
            throw new Error(`Re-extraction failed: ${rescuedMission.trace.failure_stage}`);
          }
        } catch (reExecErr: any) {
          console.error(`[RESCUE_LLM] Self-heal execution failed: ${reExecErr.message}`);
          updateRescueSuccess(jobId, false, 0).catch(() => {});
          const fallbackQ = "I want to make sure I find exactly the right leads for you. Could you tell me a bit more about what you're looking for — specifically, what type of business and where?";
          const messageId = randomUUID();
          await Promise.all([
            supabase!.from('supervisor_tasks').update({ status: 'completed', result: { response: fallbackQ.substring(0, 200), message_id: messageId, rescue_llm: 'self_heal_failed' } }).eq('id', task.id),
            supabase!.from('messages').insert({ id: messageId, conversation_id: task.conversation_id, role: 'assistant', content: sanitizeSupervisorMessage(fallbackQ), source: 'supervisor', metadata: { supervisor_task_id: task.id, run_id: jobId, rescue_llm: 'self_heal_failed', clarify_gate: 'rescue_llm', mode: 'clarify' }, created_at: Date.now() }).select().single(),
          ]);
          // Send a friendly message so the user isn't left hanging
          const rescueFailMsg = "I had trouble processing that request. Could you try rephrasing it? For example, instead of modifying the previous search, try a fresh search like 'find plumbers in central London'.";
          const rescueFailMsgId = randomUUID();
          if (supabase) {
            await supabase.from('messages').insert({
              id: rescueFailMsgId,
              conversation_id: task.conversation_id,
              role: 'assistant',
              content: rescueFailMsg,
              source: 'supervisor',
              metadata: { supervisor_task_id: task.id, run_id: jobId, rescue_self_heal_failed: true },
              created_at: Date.now(),
            }).then(() => undefined, (e: any) => console.warn(`[RESCUE] Failed to insert fallback message: ${e.message}`));

            await supabase.from('supervisor_tasks').update({
              status: 'completed',
              result: { message_id: rescueFailMsgId, rescue_self_heal_failed: true },
            }).eq('id', task.id).then(() => undefined, () => {});
          }
          await storage.updateAgentRun(jobId, { status: 'completed', terminalState: 'completed', endedAt: new Date(), metadata: { verdict: 'rescue_self_heal_failed', rescue_exhausted: true } }).catch(() => {});
          await emitTaskExecutionCompleted('rescue_self_heal_failed');
          return;
        }
      } else {
        console.log(`[RESCUE_LLM] Needs clarification: ${rescueResult.clarificationQuestion}`);
        const messageId = randomUUID();
        const clarifyContent = rescueResult.clarificationQuestion || "I want to make sure I find exactly the right leads for you. Could you tell me a bit more about what you're looking for — specifically, what type of business and where?";
        await Promise.all([
          supabase!.from('supervisor_tasks').update({ status: 'completed', result: { response: clarifyContent.substring(0, 200), message_id: messageId, rescue_llm: 'clarification_needed' } }).eq('id', task.id),
          supabase!.from('messages').insert({ id: messageId, conversation_id: task.conversation_id, role: 'assistant', content: sanitizeSupervisorMessage(clarifyContent), source: 'supervisor', metadata: { supervisor_task_id: task.id, run_id: jobId, rescue_llm: 'clarification_needed', rescue_reasoning: rescueResult.reasoning, clarify_gate: 'rescue_llm', mode: 'clarify' }, created_at: Date.now() }).select().single(),
        ]);
        await storage.updateAgentRun(jobId, { status: 'clarifying', terminalState: null, metadata: { verdict: 'rescue_clarification', awaiting: 'user_input', original_message: rawMsg } }).catch(() => {});
        await emitTaskExecutionCompleted('rescue_clarification');
        return;
      }
      } // end if (!directExecutionSucceeded)
    }
    } catch (execErr: any) {
      runFailed = true;
      failureReason = execErr.message || String(execErr);
      console.error(`[EXECUTION] ${executionSource} execution failed for runId=${jobId}: ${failureReason}`);
      await storage.updateAgentRun(jobId, {
        status: 'failed',
        terminalState: 'failed',
        error: failureReason,
        endedAt: new Date(),
      }).catch((updateErr: any) => {
        console.warn(`[EXECUTION] Failed to mark agent_run as failed (run may not exist yet): ${updateErr.message}`);
      });

      createArtefact({
        runId: jobId,
        type: 'diagnostic',
        title: `Run failed: ${executionSource} execution threw`,
        summary: `Error: ${failureReason.substring(0, 200)}`,
        payload: { reason: 'execution_error', error: failureReason, taskId: task.id, execution_source: executionSource },
        userId: task.user_id,
        conversationId: task.conversation_id,
      }).catch((e: any) => console.warn(`[EXECUTION] Failed to emit diagnostic artefact: ${e.message}`));

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

        const nowMs = Date.now();
        const nextWakeIso = new Date(nowMs + (scheduleType === 'weekly' ? 7 * 24 * 3600000 : 24 * 3600000)).toISOString();

        const { data: monitorData, error: monitorError } = await supabase!
          .from('scheduled_monitors')
          .insert({
            user_id: task.user_id,
            label: monitorLabel,
            description: monitorDescription,
            monitor_type: 'lead_search',
            schedule: scheduleType,
            is_active: 1,
            conversation_id: task.conversation_id,
            config: {
              original_goal: rawMsg.trim(),
              business_type: earlyParsedGoal.business_type,
              location: earlyParsedGoal.location,
              country: earlyParsedGoal.country,
              constraints: (earlyParsedGoal.constraints ?? []).map(c => ({ type: c.type, field: c.field, operator: c.operator, value: c.value })),
              mission_mode: missionModeResolved,
              source_run_id: jobId,
              conversation_id: task.conversation_id,
            },
            created_at: nowMs,
            updated_at: nowMs,
            next_wake_at: nextWakeIso,
            next_run_at: nowMs + (scheduleType === 'weekly' ? 7 * 24 * 3600000 : 24 * 3600000),
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

    // Build natural response instead of generic "Run complete" message
    const { buildNaturalResponse } = await import('./supervisor/response-builder');
    const ds = towerResult.deliverySummary;
    let response: string;
    try {
      response = await buildNaturalResponse({
        businessType: earlyParsedGoal?.business_type ?? missionResult?.mission?.entity_category ?? 'results',
        location: earlyParsedGoal?.location ?? missionResult?.mission?.location_text ?? '',
        requestedCount: ds?.requested_count ?? earlyParsedGoal?.requested_count ?? null,
        deliveredCount: ds?.delivered_total_count ?? towerResult.leads.length,
        verifiedCount: ds?.cvl_verified_exact_count ?? ds?.delivered_exact_count ?? 0,
        towerVerdict: towerResult.towerVerdict ?? ds?.tower_verdict ?? null,
        runFailed,
        failureReason,
        circuitBreakerFired: ds?.delivery_note?.includes('circuit') ?? false,
        loopsUsed: ds?.plan_versions?.length ?? 1,
        executorsUsed: ds?.plan_versions?.map((pv: any) => pv.changes_made?.[0] ?? 'search').filter(Boolean) ?? ['search'],
        monitorCreated,
        deliveryNote: ds?.delivery_note ?? null,
        loopSummaries: (() => {
          const chainSummary = (missionExecResult as any)?.deliverySummary?.loop_summaries
            ?? (missionExecResult as any)?.loopSummaries
            ?? null;
          if (Array.isArray(chainSummary) && chainSummary.length > 1) {
            return chainSummary.map((s: any) => ({
              executor: s.executor_type ?? s.executor ?? '',
              found: s.entities_found ?? s.found ?? 0,
              verdict: s.verdict ?? '',
            }));
          }
          return null;
        })(),
        scarcityType: (() => {
          const ds = missionExecResult?.deliverySummary;
          const delivered = ds?.delivered_total_count ?? towerResult.leads.length;
          const requested = requestedCount ?? 0;
          const cb = (missionExecResult as any)?.circuitBreakerFired === true;
          const towerPass = (towerResult.towerVerdict ?? '').toUpperCase() === 'PASS';

          if (delivered === 0 && !cb) return 'B'; // zero results, no batch limit hit → real scarcity
          if (cb) return 'A';                     // hit loop/batch limit → more may exist
          if (requested > 0 && towerPass && delivered > 0 && delivered < requested * 0.6) return 'B'; // significant shortfall despite passing tower
          if (delivered === 0) return 'C';        // zero results after CB somehow — capability issue
          return null;                            // full or near-full delivery, no classification needed
        })(),
        scarcityNote: null,
      });
    } catch (respErr: any) {
      console.warn(`[RESPONSE_BUILDER] Failed (non-fatal), using neutral message: ${respErr.message}`);
      // response already set by buildNaturalResponse above — do not overwrite
      // Strip any LLM-generated conversational preamble that leaked through
      if (/I'd be happy to|I would be happy to|Could you tell me|what type of businesses|what kind of businesses/i.test(response)) {
        console.warn(`[SUPERVISOR_MSG_GUARD] Blocked conversational preamble in response: "${response.substring(0, 120)}"`);
        response = SUPERVISOR_NEUTRAL_MESSAGE;
      }
    }

    // Override response if API billing errors caused empty results
    const { getLastBillingError, clearBillingError } = await import('./supervisor/api-error-detector');
    const billingError = getLastBillingError();
    if (billingError && towerResult.leads.length === 0) {
      const providerName = billingError.provider === 'openai' ? 'OpenAI' : 'Anthropic';
      console.error(`[SUPERVISOR] Overriding response — billing error detected: ${billingError.message}`);
      response = `⚠️ I couldn't verify any results because the ${providerName} API returned an error (${billingError.status}). This is likely a billing/credits issue, not a search quality problem. Please check your API credits and try again.`;
      clearBillingError();
    }

    if (monitorCreated && !response.includes('monitoring')) {
      const monitorNote = missionModeResolved === 'alert_on_change'
        ? `\n\nI've also set up ongoing monitoring for this. I'll alert you when there are changes or new results.`
        : `\n\nI've also set up ongoing monitoring for this search. I'll check periodically and let you know about new results.`;
      response = sanitizeSupervisorMessage(response + monitorNote);
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
          trust_status: towerResult.deliverySummary?.trust_status ?? (runFailed ? 'UNTRUSTED' : 'UNVERIFIED'), // PHASE_3: no more TRUSTED
          ...(towerResult.deliverySummary ? { deliverySummary: towerResult.deliverySummary } : {}),
          ...(towerResult.towerVerdict ? { towerVerdict: towerResult.towerVerdict } : {}),
          ...(towerResult.leads.length > 0 ? { leads: towerResult.leads } : {}),
          ...(runFailed ? { run_failed: true, failure_reason: failureReason } : {}),
          ...(!runFailed && towerResult.leads.length > 0 ? {
            actions: {
              monitor_setup: {
                run_id: jobId,
                source_run_id: jobId,
              },
            },
          } : {}),
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

    // Update conversation state to reviewing after successful delivery
    if (CONV_STATE_ENABLED && !runFailed) {
      try {
        const { updateConversationPhase, setLastDelivery } = await import('./supervisor/conversation-state');

        setLastDelivery(task.conversation_id, {
          runId: jobId,
          leadCount: towerResult.deliverySummary?.delivered_total_count ?? towerResult.leads.length ?? 0,
          entityType: missionResult?.mission?.entity_category || earlyParsedGoal?.business_type || '',
          location: missionResult?.mission?.location_text || earlyParsedGoal?.location || '',
          missionConfig: missionResult?.mission || null,
        });

        updateConversationPhase(task.conversation_id, 'reviewing');
        console.log(`[CONV_STATE] Delivery complete — now in reviewing phase`);
      } catch (stateErr: any) {
        console.warn(`[CONV_STATE] Failed to update state after delivery (non-fatal): ${stateErr.message}`);
      }
    }

    try {
      const ds = towerResult.deliverySummary;
      const benchmarkRunContext: RunContext = {
        missionParsed: !!(missionResult?.ok && missionResult.mission),
        constraintsValid: !!(missionResult?.ok && missionResult.mission && Array.isArray(missionResult.mission.constraints)),
        planGenerated: !!activeMissionPlan,
        planEmpty: !!activeMissionPlan && (activeMissionPlan.tool_sequence?.length ?? 0) === 0,
        candidatePoolSize: ds?.delivered_total_count ?? leadIds.length,
        requestedCount: ds?.requested_count ?? earlyParsedGoal?.requested_count ?? 10,
        crawlerFailed: false,
        crawlerReturnedEmpty: false,
        pagesFetched: (ds?.delivered_total_count ?? 0) > 0,
        evidenceItemCount: ds?.cvl_verified_exact_count ?? ds?.delivered_exact_count ?? 0,
        evidenceHasQuotes: (ds?.cvl_verified_exact_count ?? 0) > 0,
        towerRejectedStrongEvidence: ds?.status === 'STOP' && (ds?.cvl_verified_exact_count ?? 0) > 0,
      };
      const benchmarkPlanHistory: PlanHistoryEntry[] = (ds?.plan_versions ?? []).map((pv: any) => ({
        version: pv.version,
        strategyId: activeMissionPlan?.strategy ?? undefined,
        radiusKm: undefined,
        queryText: undefined,
      }));
      const benchmarkInput: BenchmarkRunInput = {
        runId: jobId,
        query: rawMsg.trim().substring(0, 500),
        requestedCount: ds?.requested_count ?? earlyParsedGoal?.requested_count ?? 10,
        deliveredCount: ds?.delivered_total_count ?? leadIds.length,
        verifiedCount: ds?.cvl_verified_exact_count ?? ds?.delivered_exact_count ?? 0,
        towerVerdict: towerResult.towerVerdict ?? ds?.tower_verdict ?? null,
        replansTriggered: Math.max(0, (ds?.plan_versions?.length ?? 1) - 1),
        runContext: benchmarkRunContext,
        planHistory: benchmarkPlanHistory,
        uiVerdict: dsStatus,
        notes: runFailed ? `Run failed: ${failureReason.substring(0, 200)}` : undefined,
      };
      recordBenchmarkRun(benchmarkInput);
    } catch (benchErr: any) {
      console.warn(`[BENCHMARK] Failed to record benchmark run (non-fatal): ${benchErr.message}`);
    }


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
      }).eq('id', task.id).then(() => undefined, () => {});

      await emitTaskExecutionCompleted('run_error', { error: errMsg.substring(0, 200) });
      throw topLevelErr;
    }
  }

  // ensureTowerJudgement: REMOVED — inline observation is mandatory. No safety nets.

  private async wakeGoals(): Promise<void> {
    try {
      const { checkAndWakeGoals } = await import('./supervisor/sleep-wake/index');
      await checkAndWakeGoals();
    } catch (error: any) {
      // Never let wake failures crash the poll loop
      console.error(`[SLEEP_WAKE] Wake check failed (non-fatal): ${error.message}`);
    }
  }

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
      // Get user info from Supabase for email and name
      const userInfo = await storage.getUserEmail(lead.userId);

      if (!userInfo?.email) {
        console.log(`[SUPERVISOR] notifyLeadCreated: no email for userId=${lead.userId} — skipping notification`);
        return;
      }

      // Generate dashboard URL from environment variable
      // FRONTEND_URL should be the public URL of the frontend (e.g., https://wyshbone.vercel.app)
      const dashboardUrl = process.env.DASHBOARD_URL || process.env.FRONTEND_URL || 'http://localhost:5173';

      // Send email notification
      await emailService.sendLeadCreatedEmail({
        lead,
        userEmail: userInfo.email,
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

    // ── Cross-session memory: recent search history ──
    // NOTE: agent_runs has no goal_summary column — the query text lives in
    // the mission_extraction artefact's payload_json.raw_user_input field.
    let recentSearches: Array<{ query: string; delivered: number; verdict: string; created: string }> = [];
    try {
      if (supabase) {
        // Join agent_runs with artefacts to get the search query from mission_extraction
        const { data: recentRuns } = await supabase
          .from('agent_runs')
          .select('id, status, terminal_state, created_at')
          .eq('user_id', userId)
          .in('status', ['completed'])
          .order('created_at', { ascending: false })
          .limit(10);

        if (recentRuns && recentRuns.length > 0) {
          const runIds = recentRuns.map((r: any) => r.id);
          
          // Fetch mission_extraction artefacts to get the actual query text
          const { data: missionArtefacts } = await supabase
            .from('artefacts')
            .select('run_id, payload_json')
            .in('run_id', runIds)
            .eq('type', 'mission_extraction')
            .order('created_at', { ascending: false });

          // Fetch delivery_summary artefacts to get delivered count and verdict
          const { data: deliveryArtefacts } = await supabase
            .from('artefacts')
            .select('run_id, payload_json')
            .in('run_id', runIds)
            .eq('type', 'delivery_summary')
            .order('created_at', { ascending: false });

          // Build lookup maps
          const missionByRunId = new Map<string, any>();
          for (const ma of (missionArtefacts || [])) {
            if (!missionByRunId.has(ma.run_id)) {
              const p = typeof ma.payload_json === 'string' ? (() => { try { return JSON.parse(ma.payload_json); } catch { return null; } })() : ma.payload_json;
              missionByRunId.set(ma.run_id, p);
            }
          }
          
          const deliveryByRunId = new Map<string, any>();
          for (const da of (deliveryArtefacts || [])) {
            if (!deliveryByRunId.has(da.run_id)) {
              const p = typeof da.payload_json === 'string' ? (() => { try { return JSON.parse(da.payload_json); } catch { return null; } })() : da.payload_json;
              deliveryByRunId.set(da.run_id, p);
            }
          }

          recentSearches = recentRuns
            .map((r: any) => {
              const mission = missionByRunId.get(r.id);
              const delivery = deliveryByRunId.get(r.id);
              
              // Extract query from mission_extraction payload
              const rawInput = mission?.layers?.raw_user_input 
                || mission?.raw_user_input 
                || mission?.user_input 
                || '';
              
              // Extract delivered count from delivery_summary
              const deliveredCount = delivery?.exact ?? delivery?.delivered_count ?? delivery?.total ?? 0;
              const verdict = delivery?.tower_verdict ?? delivery?.status ?? r.terminal_state ?? 'unknown';
              
              return {
                query: rawInput,
                delivered: deliveredCount,
                verdict: String(verdict).toLowerCase(),
                created: r.created_at ? new Date(typeof r.created_at === 'number' ? r.created_at : r.created_at).toISOString().split('T')[0] : 'unknown',
              };
            })
            .filter(s => s.query && s.query.length > 3) // Only include runs with actual queries
            .slice(0, 5);
        }
      }
      console.log(`  🔄 Found ${recentSearches.length} recent searches for cross-session context`);
    } catch (err: any) {
      console.warn(`  ⚠️ Cross-session memory fetch failed (non-fatal): ${err.message}`);
    }

    context.recentSearches = recentSearches;

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
