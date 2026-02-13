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
import { executeAction, type ActionResult as LoopActionResult } from './supervisor/action-executor';
import { generateJobId } from './supervisor/jobs';
import { redactRecord, safeOutputsRaw, compactInputs } from './supervisor/plan-executor';
import { judgeArtefact } from './supervisor/tower-artefact-judge';
import { extractChangePlanDirective, applyLeadgenReplanPolicy, type PlanV2Constraints } from './supervisor/replan-policy';

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
  private batchSize: number = 50; // Process up to 50 signals per poll
  private missingTableWarned: boolean = false;
  private startupRecoveryDone: boolean = false;
  private static readonly STALE_TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly MAX_RECOVERY_ATTEMPTS = 3;

  async start() {
    if (this.isRunning) {
      console.log('Supervisor already running');
      return;
    }

    this.isRunning = true;
    console.log('🤖 Supervisor service started - monitoring for new signals...');

    await this.recoverOrphanedTasks();
    await this.poll();
  }

  stop() {
    this.isRunning = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    console.log('Supervisor service stopped');
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
        // Numeric comparison for bigint IDs
        const signalId = BigInt(signal.id);
        const checkpointId = BigInt(checkpoint.id);
        return signalId > checkpointId;
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
        .eq('status', 'processing')
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

      console.log(`[RECOVERY] Found ${stuckTasks.length} orphaned task(s) in 'processing' state — evaluating for requeue`);

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

  private async sweepStaleTasks(): Promise<void> {
    if (!supabase) return;

    try {
      const cutoffEpoch = Date.now() - SupervisorService.STALE_TASK_TIMEOUT_MS;

      const { data: staleTasks, error } = await supabase
        .from('supervisor_tasks')
        .select('id, user_id, conversation_id, request_data, created_at, status, run_id, client_request_id')
        .eq('status', 'processing')
        .lt('created_at', cutoffEpoch)
        .limit(20);

      if (error) {
        if (error.code === 'PGRST205') return;
        console.error(`[STALE_SWEEP] Failed to query stale tasks: ${error.message}`);
        return;
      }

      if (!staleTasks || staleTasks.length === 0) return;

      console.log(`[STALE_SWEEP] Found ${staleTasks.length} stale task(s) processing for >${SupervisorService.STALE_TASK_TIMEOUT_MS / 1000}s`);

      for (const task of staleTasks) {
        try {
          await this.evaluateAndRecoverTask(task, 'stale_sweep');
        } catch (err: any) {
          console.error(`[STALE_SWEEP] Task ${task.id}: unexpected error — ${err.message}`);
        }
      }
    } catch (err: any) {
      console.error(`[STALE_SWEEP] Sweep failed (non-fatal): ${err.message}`);
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
          terminalState: 'recovery_exhausted',
          error: `Task failed after ${SupervisorService.MAX_RECOVERY_ATTEMPTS} recovery attempts`,
          endedAt: new Date(),
          metadata: { ...existingMetadata, recovery_attempts: attempts, recovery_exhausted: true },
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

    const { data: tasks, error } = await supabase
      .from('supervisor_tasks')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(10);

    if (error) {
      // PGRST205 = table not found - likely migration hasn't been run yet
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

    if (!tasks || tasks.length === 0) {
      return;
    }

    console.log(`💬 Found ${tasks.length} pending chat task(s)`);

    // Process each task
    for (const task of tasks) {
      try {
        await this.processChatTask(task as SupervisorTask);
      } catch (error) {
        console.error(`Failed to process task ${task.id}:`, error);
        // Mark task as failed
        await supabase
          .from('supervisor_tasks')
          .update({
            status: 'failed',
            error: error instanceof Error ? error.message : String(error)
            // processed_at omitted - uses database DEFAULT
          })
          .eq('id', task.id);
      }
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

    const jobId = uiRunId;
    console.log(`[ID_MAP] jobId=${jobId} uiRunId=${uiRunId} crid=${clientRequestId} taskId=${task.id} entry=processChatTask`);
    console.log(`[SUPERVISOR] Processing chat task ${task.id} (${task.task_type}) jobId=${jobId} uiRunId=${uiRunId} clientRequestId=${clientRequestId}`);

    this.bridgeRunToUI(uiRunId, jobId, clientRequestId).catch((e: any) =>
      console.error(`[RUN_BRIDGE] bridgeRunToUI failed: ${e.message}`)
    );

    logMissionReceived(
      task.user_id, jobId, task.id, task.task_type, task.conversation_id
    ).catch(() => {});

    // Mark as processing - with concurrency guard
    const { data: updateResult, error: updateError } = await supabase
      .from('supervisor_tasks')
      .update({ status: 'processing' })
      .eq('id', task.id)
      .eq('status', 'pending') // Only update if still pending
      .select();

    if (updateError || !updateResult || updateResult.length === 0) {
      // Task already being processed or failed to update
      console.log(`⏭️  Task ${task.id} already processing or unavailable`);
      return;
    }

    const userContext = await this.buildUserContext(task.user_id);
    const rawMsg = String(requestData.user_message || '');

    console.log(`[SUPERVISOR] Executing task ${task.id} — message="${rawMsg.substring(0, 80)}"`);
    logAFREvent({
      userId: task.user_id, runId: jobId, conversationId: task.conversation_id,
      clientRequestId,
      actionTaken: 'task_execution_started', status: 'pending',
      taskGenerated: `Executing: "${rawMsg.substring(0, 60)}"`,
      runType: 'plan',
      metadata: { taskId: task.id, task_type: task.task_type },
    }).catch(() => {});

    const towerResult = await this.executeTowerLoopChat(task, userContext, jobId, clientRequestId);
    const response = towerResult.response;
    const leadIds = towerResult.leadIds;
    const capabilities = ['lead_generation', 'tower_validated'];

    const messageId = randomUUID();
    const { data: newMessage, error: messageError } = await supabase
      .from('messages')
      .insert({
        id: messageId,
        conversation_id: task.conversation_id,
        role: 'assistant',
        content: response,
        source: 'supervisor',
        metadata: {
          supervisor_task_id: task.id,
          capabilities,
          lead_ids: leadIds
        },
        created_at: Date.now()
      })
      .select()
      .single();

    if (messageError) {
      throw new Error(`Failed to write message: ${messageError.message}`);
    }

    console.log(`✅ Supervisor response posted to conversation ${task.conversation_id}`);

    await supabase
      .from('supervisor_tasks')
      .update({
        status: 'completed',
        result: {
          message_id: newMessage.id,
          lead_ids: leadIds,
          capabilities_used: capabilities
        }
      })
      .eq('id', task.id);
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

  private async postArtefactToUI(params: {
    runId: string;
    clientRequestId?: string;
    type: string;
    payload: Record<string, unknown>;
    userId?: string;
    conversationId?: string;
  }): Promise<{ ok: boolean; artefactId?: string; httpStatus?: number }> {
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

  private async bridgeRunToUI(uiRunId: string, supervisorRunId: string, clientRequestId?: string): Promise<void> {
    const uiBaseUrl = (process.env.UI_URL || '').replace(/\/+$/, '');
    if (!uiBaseUrl) {
      console.error(`[RUN_BRIDGE] UI_URL not configured — cannot bridge run IDs`);
      return;
    }
    try {
      const resp = await fetch(`${uiBaseUrl}/api/afr/run-bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: uiRunId,
          supervisorRunId,
          ...(clientRequestId ? { clientRequestId } : {}),
        }),
      });
      console.log(`[RUN_BRIDGE] uiRunId=${uiRunId} supervisorRunId=${supervisorRunId} status=${resp.status}`);
    } catch (e: any) {
      console.error(`[RUN_BRIDGE] uiRunId=${uiRunId} supervisorRunId=${supervisorRunId} NETWORK_ERROR: ${e.message}`);
    }
  }

  private async executeTowerLoopChat(
    task: SupervisorTask,
    userContext: UserContext,
    chatRunId: string,
    clientRequestId: string,
  ): Promise<{ response: string; leadIds: string[] }> {
    const conversationId = task.conversation_id;
    const requestData = task.request_data;
    const rawMsg = (requestData.user_message || '') as string;
    const searchQuery = requestData.search_query;

    const originalUserGoal = rawMsg.trim();

    let businessType = searchQuery?.business_type as string | undefined;
    let location = (searchQuery?.location as string) || '';
    let requestedCount = 20;
    let prefixFilter: string | undefined;
    let toolPreference: string | undefined;

    const userCountMatch = rawMsg.match(/\bfind\s+(\d+)\s+/i);
    const userRequestedCount = userCountMatch ? Math.min(parseInt(userCountMatch[1], 10), 200) : undefined;

    if (rawMsg) {
      const msg = rawMsg.trim();

      const prefixMatch = msg.match(/\b(?:begin|start|starting)\s+with\s+([A-Za-z])\b/i);
      if (prefixMatch) prefixFilter = prefixMatch[1].toUpperCase();

      const toolMatch = msg.match(/\bwith\s+(google\s+places?\s+search|google\s+places?|google\s+maps?)\b/i);
      if (toolMatch) toolPreference = 'GOOGLE_PLACES';

      const inMatch = msg.match(/\bin\s+([A-Z][a-zA-Z\s,]+?)(?:\s+(?:that|who|which|with|using)\b|$)/i);
      if (!location && inMatch) {
        location = inMatch[1].trim().replace(/,\s*$/, '');
      }

      if (!businessType) {
        const numTypeMatch = msg.match(/\bfind\s+(\d+)\s+([a-zA-Z\s]+?)(?:\s+in\b)/i);
        if (numTypeMatch) {
          requestedCount = Math.min(parseInt(numTypeMatch[1], 10), 200);
          businessType = numTypeMatch[2].trim() || undefined;
        } else {
          const typeMatch = msg.match(/\bfind\s+([a-zA-Z\s]+?)(?:\s+in\b)/i);
          if (typeMatch) {
            businessType = typeMatch[1].trim().replace(/^\d+\s*/, '') || undefined;
            const numMatch = typeMatch[1].match(/^(\d+)\s+/);
            if (numMatch) requestedCount = Math.min(parseInt(numMatch[1], 10), 200);
          }
        }
      }
    }
    if (searchQuery?.count) requestedCount = Math.min(Number(searchQuery.count), 200);
    if (!businessType) businessType = 'pubs';
    if (!location) location = 'Local';
    let city = location.split(',')[0].trim();
    const country = location.split(',')[1]?.trim() || 'UK';
    const displayCount = userRequestedCount ?? requestedCount;

    const constraints: string[] = [];
    constraints.push(`count=${requestedCount}`);
    constraints.push(`business_type=${businessType}`);
    constraints.push(`location=${city}`);
    if (prefixFilter) constraints.push(`prefix=${prefixFilter}`);
    if (toolPreference) constraints.push(`use=${toolPreference}`);

    const assumptions: string[] = [];
    if (prefixFilter) {
      assumptions.push(`Google Places cannot filter by name prefix; will search broadly then filter locally for names starting with "${prefixFilter}"`);
    }
    if (requestedCount < 20) {
      assumptions.push(`Will request up to 20 results from Google Places, then trim to ${requestedCount} after any local filtering`);
    }
    assumptions.push(`Location "${city}" will be used as-is in the Google Places text query`);

    const searchCount = Math.max(requestedCount, 20);
    const postProcessing: string[] = [];
    if (prefixFilter) postProcessing.push(`Filter names starting with "${prefixFilter}"`);
    if (requestedCount < 20 || prefixFilter) postProcessing.push(`Take first ${requestedCount} results`);

    const normalizedGoal = `Find ${requestedCount} ${businessType} in ${city}${prefixFilter ? ` starting with ${prefixFilter}` : ''} for B2B outreach`;
    const goal = normalizedGoal;

    const hardKeywords = /\b(must|only|exactly|strict|strictly|no\s+other|within)\b/i;
    const locationHardKeywords = /\bin\s+\w+\s+only\b/i;
    const userMsgLower = originalUserGoal.toLowerCase();
    const hasHardSignal = hardKeywords.test(userMsgLower) || locationHardKeywords.test(originalUserGoal);

    const hard_constraints: string[] = ['business_type', 'requested_count'];
    const soft_constraints: string[] = [];

    if (hasHardSignal) {
      if (/\b(only|within)\b/i.test(userMsgLower) && city) hard_constraints.push('location');
      else soft_constraints.push('location');

      if (/\b(must|only|exactly|strict|strictly)\b/i.test(userMsgLower) && prefixFilter) hard_constraints.push('prefix_filter');
      else if (prefixFilter) soft_constraints.push('prefix_filter');
    } else {
      soft_constraints.push('location');
      if (prefixFilter) soft_constraints.push('prefix_filter');
    }
    console.log(`[TOWER_LOOP_CHAT] Constraint classification — hard: [${hard_constraints.join(', ')}] soft: [${soft_constraints.join(', ')}]`);

    const v1Constraints = {
      business_type: businessType,
      location: city,
      prefix_filter: prefixFilter || null,
      requested_count: displayCount,
    };

    function buildConstraintLabel(
      cur: { business_type: string; location: string; prefix_filter?: string | null; requested_count: number },
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
      count: number,
      cur: { business_type: string; location: string; prefix_filter?: string | null; requested_count: number },
      planVersion: number,
    ): string {
      const { annotations } = buildConstraintLabel(cur, v1Constraints, planVersion);
      const loc = cur.location;
      const parts = [prefix];
      parts.push(`${count} ${cur.business_type}`);
      if (cur.prefix_filter) parts.push(`starting with ${cur.prefix_filter}`);
      parts.push(`in ${loc}`);
      if (annotations.length > 0) parts.push(`(${annotations.join(', ')})`);
      return parts.join(' ');
    }

    function artefactSummary(
      prefix: string,
      delivered: number,
      target: number,
      cur: { business_type: string; location: string; prefix_filter?: string | null; requested_count: number },
      planVersion: number,
      extra?: string,
    ): string {
      const { annotations } = buildConstraintLabel(cur, v1Constraints, planVersion);
      const loc = cur.location;
      let s = `${prefix}${delivered} of ${target} ${cur.business_type} in ${loc}`;
      if (cur.prefix_filter) s += ` starting with ${cur.prefix_filter}`;
      if (annotations.length > 0) s += ` (${annotations.join(', ')})`;
      if (extra) s += ` ${extra}`;
      return s;
    }

    const MAX_REPLANS = parseInt(process.env.MAX_REPLANS || '1', 10);
    console.log(`[TOWER_LOOP_CHAT] Starting — businessType="${businessType}" location="${city}" count=${requestedCount} userCount=${displayCount} goal="${goal}" MAX_REPLANS=${MAX_REPLANS}`);

    // 1. Create agent_run row (upsert — handles retries with same run_id/client_request_id)
    const nowMs = Date.now();
    try {
      await storage.createAgentRun({
        id: chatRunId,
        clientRequestId,
        userId: task.user_id,
        createdAt: nowMs,
        updatedAt: nowMs,
        status: 'executing',
        metadata: {
          feature_flag: 'TOWER_LOOP_CHAT_MODE',
          original_user_goal: originalUserGoal,
          normalized_goal: normalizedGoal,
          plan: { version: 1, steps: [{ tool: 'SEARCH_PLACES', args: { query: businessType, location: city, country, maxResults: searchCount } }] },
        },
      });
      console.log(`[TOWER_LOOP_CHAT] [agent_run_create] runId=${chatRunId}`);
    } catch (createErr: any) {
      const errMsg = createErr.message || '';
      if (errMsg.includes('duplicate key') || errMsg.includes('unique constraint')) {
        const isPkeyConflict = errMsg.includes('agent_runs_pkey');
        const isCridConflict = errMsg.includes('client_request_id');
        console.log(`[TOWER_LOOP_CHAT] agent_run duplicate: pkey=${isPkeyConflict} crid=${isCridConflict} runId=${chatRunId} crid=${clientRequestId}`);

        const retryMeta = {
          feature_flag: 'TOWER_LOOP_CHAT_MODE',
          retry_reuse: true,
          original_user_goal: originalUserGoal,
          normalized_goal: normalizedGoal,
          plan: { version: 1, steps: [{ tool: 'SEARCH_PLACES', args: { query: businessType, location: city, country, maxResults: searchCount } }] },
        };

        if (isPkeyConflict) {
          await storage.updateAgentRun(chatRunId, {
            status: 'executing', error: null, terminalState: null, metadata: retryMeta,
          });
        } else if (isCridConflict && supabase) {
          const { data: existingRun } = await supabase
            .from('agent_runs')
            .select('id')
            .eq('client_request_id', clientRequestId)
            .maybeSingle();
          
          if (existingRun) {
            console.log(`[TOWER_LOOP_CHAT] Reusing existing agent_run ${existingRun.id} for crid=${clientRequestId}`);
            chatRunId = existingRun.id;
            await storage.updateAgentRun(existingRun.id, {
              status: 'executing', error: null, terminalState: null,
              metadata: { ...retryMeta, original_run_id: task.request_data.run_id },
            });
          } else {
            console.error(`[TOWER_LOOP_CHAT] crid conflict but no existing run found — cannot proceed`);
            throw createErr;
          }
        } else {
          await storage.updateAgentRun(chatRunId, {
            status: 'executing', error: null, terminalState: null, metadata: retryMeta,
          });
        }
      } else {
        throw createErr;
      }
    }

    // 2. Create Plan v1 artefact BEFORE any tool execution
    const planSteps = [
      {
        step_index: 0,
        step_id: 'search_places_v1',
        tool: 'SEARCH_PLACES',
        tool_args: { query: `${businessType} in ${city} ${country}`, location: city, country, maxResults: searchCount },
        expected_output: `Up to ${searchCount} ${businessType} results from Google Places`,
        ...(postProcessing.length > 0 ? { post_processing: postProcessing.join('; ') } : {}),
      },
    ];

    const planPayload = {
      run_id: chatRunId,
      original_user_goal: originalUserGoal,
      normalized_goal: normalizedGoal,
      hard_constraints,
      soft_constraints,
      constraints,
      assumptions,
      steps: planSteps,
      created_at: new Date().toISOString(),
    };

    const planArtefact = await createArtefact({
      runId: chatRunId,
      type: 'plan',
      title: artefactTitle('Plan v1:', displayCount, v1Constraints, 1),
      summary: `Search ${displayCount} ${businessType} in ${city} via Google Places${prefixFilter ? `, filter prefix "${prefixFilter}"` : ''}`,
      payload: planPayload,
      userId: task.user_id,
      conversationId,
    });
    console.log(`[TOWER_LOOP_CHAT] [plan_created] Plan v1 artefact id=${planArtefact.id}`);

    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'artefact_created', status: 'success',
      taskGenerated: `Plan v1 artefact created`,
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

    // 4. AFR: step_started
    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'step_started', status: 'pending',
      taskGenerated: `Step 1/1: SEARCH_PLACES — ${businessType} in ${city}`,
      runType: 'plan',
      metadata: { step: 1, total_steps: 1, tool: 'SEARCH_PLACES', query: businessType, location: city },
    });
    console.log(`[TOWER_LOOP_CHAT] [step_started] step=1 tool=SEARCH_PLACES`);

    // 4. Execute SEARCH_PLACES (Google Places) with stub fallback
    let leads: Array<{ name: string; address: string; phone: string | null; website: string | null; placeId: string; source: string }> = [];
    let usedStub = false;
    const createdLeadIds: string[] = [];
    const towerLoopStepStartedAt = Date.now();
    let towerLoopStepError: string | undefined;

    try {
      const businesses = await this.searchGooglePlaces(businessType, city, country, searchCount);
      if (businesses && businesses.length > 0) {
        for (const biz of businesses) {
          leads.push({
            name: biz.displayName?.text || 'Unknown Business',
            address: biz.formattedAddress || `${city}, ${country}`,
            phone: biz.nationalPhoneNumber || biz.internationalPhoneNumber || null,
            website: biz.websiteUri || null,
            placeId: biz.id || '',
            source: 'google_places',
          });
        }
        console.log(`[TOWER_LOOP_CHAT] Google Places returned ${leads.length} results`);

        if (prefixFilter) {
          const before = leads.length;
          leads = leads.filter(l => l.name.toUpperCase().startsWith(prefixFilter!));
          console.log(`[TOWER_LOOP_CHAT] Prefix filter "${prefixFilter}": ${before} → ${leads.length}`);
        }

        if (leads.length > requestedCount) {
          leads = leads.slice(0, requestedCount);
          console.log(`[TOWER_LOOP_CHAT] Trimmed to requested count: ${leads.length}`);
        }
      } else {
        console.log(`[TOWER_LOOP_CHAT] Google Places returned 0 results — using stub leads`);
        leads = this.generateStubLeads(businessType, city, country);
        usedStub = true;
      }
    } catch (placesErr: any) {
      console.warn(`[TOWER_LOOP_CHAT] Google Places failed (${placesErr.message}) — falling back to stub leads`);
      towerLoopStepError = placesErr.message;
      leads = this.generateStubLeads(businessType, city, country);
      usedStub = true;
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

    // 5. AFR: step_completed
    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'step_completed', status: 'success',
      taskGenerated: `Step 1/1 completed: ${leads.length} leads found${usedStub ? ' (stub fallback)' : ''}`,
      runType: 'plan',
      metadata: { step: 1, tool: 'SEARCH_PLACES', leads_count: leads.length, used_stub: usedStub },
    });
    console.log(`[TOWER_LOOP_CHAT] [step_completed] leads=${leads.length} stub=${usedStub}`);

    // 5b. step_result artefact (tower loop chat) — unconditional
    {
      const towerLoopStepFinishedAt = Date.now();
      const towerLoopStepStatus = towerLoopStepError ? 'fail' : 'success';
      const towerLoopStepSummary = towerLoopStepError
        ? `fail – Google Places error: ${towerLoopStepError} (stub fallback used, ${leads.length} leads)`
        : `success – ${leads.length} leads found for "${businessType}" in ${city}`;
      const safeLeads = leads.map(l => ({ name: l.name, address: l.address, placeId: l.placeId, source: l.source }));
      let towerLoopStepArtefact: Awaited<ReturnType<typeof createArtefact>> | undefined;
      try {
        towerLoopStepArtefact = await createArtefact({
          runId: chatRunId,
          type: 'step_result',
          title: artefactTitle('Step result: SEARCH_PLACES –', leads.length, v1Constraints, 1),
          summary: `${towerLoopStepStatus} – ${leads.length} of ${displayCount} ${businessType} in ${city}${prefixFilter ? ` starting with ${prefixFilter}` : ''}`,
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
            outputs_summary: { leads_count: leads.length, used_stub: usedStub, prefix_filter: prefixFilter || null, requested_count: requestedCount, ...(towerLoopStepError ? { fallback_error: towerLoopStepError } : {}) },
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
        console.log(`[STEP_ARTEFACT] runId=${chatRunId} step=chat_tower_loop_search_places status=${towerLoopStepStatus}`);
      } catch (stepArtErr: any) {
        console.warn(`[STEP_ARTEFACT] FAILED to create step_result for tower_loop_chat (non-fatal): ${stepArtErr.message}`);
        console.warn(`[STEP_ARTEFACT] runId=${chatRunId} — Tower observation will be SKIPPED because step_result artefact failed`);
      }

      // Step-level judgement (observation only)
      if (towerLoopStepArtefact) {
        try {
          const obsResult = await judgeArtefact({
            artefact: towerLoopStepArtefact,
            runId: chatRunId, goal, userId: task.user_id, conversationId,
          });
          await createArtefact({
            runId: chatRunId,
            type: 'tower_judgement',
            title: `Tower Judgement: ${obsResult.judgement.verdict} (tower loop chat)`,
            summary: `Observation: ${obsResult.judgement.verdict} | ${obsResult.judgement.action} | SEARCH_PLACES`,
            payload: {
              verdict: obsResult.judgement.verdict, action: obsResult.judgement.action,
              reasons: obsResult.judgement.reasons, metrics: obsResult.judgement.metrics,
              step_index: 0, step_label: `SEARCH_PLACES – ${businessType} in ${city}`,
              judged_artefact_id: towerLoopStepArtefact.id, stubbed: obsResult.stubbed, observation_only: true,
            },
            userId: task.user_id, conversationId,
          });
          console.log(`[STEP_OBSERVATION] step=tower_loop_chat verdict=${obsResult.judgement.verdict} action=${obsResult.judgement.action} (observation only, no branching)`);
        } catch (obsErr: any) {
          console.warn(`[STEP_OBSERVATION] Tower observation failed for tower loop chat (continuing): ${obsErr.message}`);
          console.warn(`[STEP_OBSERVATION] runId=${chatRunId} stepArtefactId=${towerLoopStepArtefact.id} — observation artefact NOT created`);
        }
      } else {
        console.warn(`[STEP_OBSERVATION] runId=${chatRunId} SKIPPED — no step_result artefact available to judge`);
      }
    }

    // 6. Create leads_list artefact (persisted to DB)
    const v1Label = buildConstraintLabel(v1Constraints, v1Constraints, 1);
    const leadsListPayload = {
      original_user_goal: originalUserGoal,
      normalized_goal: normalizedGoal,
      hard_constraints,
      soft_constraints,
      plan_artefact_id: planArtefact.id,
      delivered_count: leads.length,
      target_count: displayCount,
      success_criteria: { target_count: displayCount, ...(prefixFilter ? { prefix: prefixFilter } : {}) },
      query: businessType,
      location: city,
      country,
      used_stub: usedStub,
      prefix_filter: prefixFilter || null,
      relaxed_constraints: v1Label.relaxed_constraints,
      constraint_diffs: v1Label.constraint_diffs,
      leads: leads.map(l => ({ name: l.name, address: l.address, phone: l.phone, website: l.website })),
    };

    const leadsListArtefact = await createArtefact({
      runId: chatRunId,
      type: 'leads_list',
      title: artefactTitle('Leads list:', leads.length, v1Constraints, 1),
      summary: artefactSummary('Delivered ', leads.length, displayCount, v1Constraints, 1, usedStub ? '(stub fallback)' : undefined),
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

    // 8. AFR: tower_call_started
    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'tower_call_started', status: 'pending',
      taskGenerated: `Calling Tower to judge leads_list artefact ${leadsListArtefact.id}`,
      runType: 'plan',
      metadata: { artefactId: leadsListArtefact.id, goal },
    });
    console.log(`[TOWER_LOOP_CHAT] [tower_call_started] artefactId=${leadsListArtefact.id}`);

    // 9. Call Tower via judgeArtefact (persists tower_judgements row + emits tower_judgement AFR)
    let towerResult;
    try {
      towerResult = await judgeArtefact({
        artefact: leadsListArtefact,
        runId: chatRunId,
        goal,
        userId: task.user_id,
        conversationId,
        successCriteria: {
          mission_type: 'leadgen',
          target_count: requestedCount,
          ...(prefixFilter ? { prefix: prefixFilter } : {}),
          plan_version: 1,
          hard_constraints,
          soft_constraints,
          plan_constraints: {
            business_type: businessType,
            location: city,
            country,
            search_count: searchCount,
            requested_count: requestedCount,
            prefix_filter: prefixFilter || null,
          },
          max_replan_versions: 2,
        },
      });
    } catch (towerErr: any) {
      const errMsg = towerErr.message || 'Tower call threw an exception';
      console.error(`[TOWER_LOOP_CHAT] Tower call failed: ${errMsg}`);

      const errorJudgementArtefact = await createArtefact({
        runId: chatRunId,
        type: 'tower_judgement',
        title: `Tower Judgement: error`,
        summary: `Tower unreachable/failed: ${errMsg}`,
        payload: { verdict: 'error', action: 'stop', reasons: [errMsg], metrics: {}, delivered: leads.length, requested: requestedCount, error: errMsg },
        userId: task.user_id,
        conversationId,
      });

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'tower_verdict', status: 'failed',
        taskGenerated: `Tower error: ${errMsg}`,
        runType: 'plan',
        metadata: { artefactId: leadsListArtefact.id, verdict: 'error', error: errMsg, towerJudgementArtefactId: errorJudgementArtefact.id },
      });

      await this.postArtefactToUI({
        runId: chatRunId,
        clientRequestId,
        type: 'tower_judgement',
        payload: {
          verdict: 'error',
          action: 'stop',
          reasons: [errMsg],
          metrics: {},
          delivered: leads.length,
          requested: requestedCount,
          error: errMsg,
        },
        userId: task.user_id,
        conversationId,
      }).catch(() => {});

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'run_stopped', status: 'failed',
        taskGenerated: `Tower error — run stopped`,
        runType: 'plan', metadata: { verdict: 'error', error: errMsg, leads_count: leads.length },
      });

      await storage.updateAgentRun(chatRunId, { status: 'completed', terminalState: 'stopped', metadata: { verdict: 'error', error: errMsg, leads_count: leads.length } });

      const errorResponse = `I found ${leads.length} ${businessType!} prospects in ${city}, but Tower validation was unavailable. You can still view the results in your [dashboard](/leads).`;
      console.log(`[TOWER_LOOP_CHAT] [complete] leads=${leads.length} verdict=error (Tower unavailable)`);
      return { response: errorResponse, leadIds: createdLeadIds };
    }

    const verdict = towerResult.judgement.verdict;
    const action = towerResult.judgement.action;
    console.log(`[TOWER_LOOP_CHAT] [tower_judgement] verdict=${verdict} action=${action} stubbed=${towerResult.stubbed}`);

    // 10. Create tower_judgement artefact (for UI display)
    const towerJudgementArtefact = await createArtefact({
      runId: chatRunId,
      type: 'tower_judgement',
      title: `Tower Judgement: ${verdict}`,
      summary: `Verdict: ${verdict} | Action: ${action} | Delivered: ${leads.length} of ${displayCount}`,
      payload: {
        verdict,
        action,
        reasons: towerResult.judgement.reasons,
        metrics: towerResult.judgement.metrics,
        delivered: leads.length,
        requested: requestedCount,
        artefact_id: leadsListArtefact.id,
        used_stub: usedStub,
      },
      userId: task.user_id,
      conversationId,
    });
    console.log(`[TOWER_LOOP_CHAT] [tower_judgement_artefact] id=${towerJudgementArtefact.id}`);

    // 11. AFR: tower_verdict
    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'tower_verdict', status: towerResult.shouldStop ? 'failed' : 'success',
      taskGenerated: `Tower verdict: ${verdict} — action: ${action}`,
      runType: 'plan',
      metadata: {
        verdict,
        action,
        artefactId: leadsListArtefact.id,
        towerJudgementArtefactId: towerJudgementArtefact.id,
        delivered: leads.length,
        requested: requestedCount,
        reasons: towerResult.judgement.reasons,
        stubbed: towerResult.stubbed,
      },
    });
    console.log(`[TOWER_LOOP_CHAT] [tower_verdict] verdict=${verdict}`);

    // 12. Replan loop (bounded by MAX_REPLANS env var)
    let finalVerdict = verdict;
    let finalAction = action;
    let finalLeads = leads;
    let finalLeadsListArtefact = leadsListArtefact;
    let finalTowerResult = towerResult;
    let finalConstraints = { ...v1Constraints };
    let planVersion = 1;
    let replansUsed = 0;
    let currentConstraints: PlanV2Constraints = {
      business_type: businessType!,
      location: city,
      country,
      search_count: searchCount,
      requested_count: requestedCount,
      prefix_filter: prefixFilter,
    };
    let priorPlanArtefactId = planArtefact.id;
    let priorLeadsCount = leads.length;

    while (finalAction === 'change_plan' && !usedStub) {
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

      console.log(`[REPLAN] Tower returned change_plan — initiating replan ${replansUsed + 1}/${MAX_REPLANS} (mission_type=leadgen, current_plan_version=${planVersion})`);

      const directive = extractChangePlanDirective(finalTowerResult.judgement);
      console.log(`[REPLAN] Directive — gaps: ${JSON.stringify(directive.gaps.map(g => g.type))} suggested_changes: ${JSON.stringify(directive.suggested_changes.map(sc => `${sc.action} ${sc.field}`))}`);

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'replan_initiated', status: 'pending',
        taskGenerated: `Tower change_plan: replanning with ${directive.suggested_changes.length} suggested change(s) (replan ${replansUsed + 1}/${MAX_REPLANS})`,
        runType: 'plan',
        metadata: {
          plan_version: planVersion,
          gaps: directive.gaps,
          suggested_changes: directive.suggested_changes,
          prior_delivered: priorLeadsCount,
          requested: currentConstraints.requested_count,
          replan_number: replansUsed + 1,
          max_replans: MAX_REPLANS,
        },
      });

      const replanResult = applyLeadgenReplanPolicy(currentConstraints, directive);
      const v2 = replanResult.constraints;
      replansUsed++;
      planVersion++;
      const vLabel = `v${planVersion}`;

      console.log(`[REPLAN] ${replanResult.strategy_summary}`);
      for (const adj of replanResult.adjustments_applied) {
        console.log(`[REPLAN]   ${adj.action} ${adj.field}: ${JSON.stringify(adj.from)} → ${JSON.stringify(adj.to)} (${adj.reason})`);
      }

      const replanPlanSteps = [
        {
          step_index: 0,
          step_id: `search_places_${vLabel}`,
          tool: 'SEARCH_PLACES',
          tool_args: { query: `${v2.business_type} in ${v2.location} ${v2.country}`, location: v2.location, country: v2.country, maxResults: v2.search_count },
          expected_output: `Up to ${v2.search_count} ${v2.business_type} results from Google Places`,
          ...(v2.prefix_filter ? { post_processing: `Filter names starting with "${v2.prefix_filter}"; Take first ${v2.requested_count} results` } : (v2.requested_count < v2.search_count ? { post_processing: `Take first ${v2.requested_count} results` } : {})),
        },
      ];

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
        constraints: [
          `business_type=${v2.business_type}`,
          `location=${v2.location}`,
          `count=${v2.requested_count}`,
          ...(v2.prefix_filter ? [`prefix=${v2.prefix_filter}`] : []),
        ],
        steps: replanPlanSteps,
        created_at: new Date().toISOString(),
      };

      const replanPlanArtefact = await createArtefact({
        runId: chatRunId,
        type: 'plan',
        title: artefactTitle(`Plan ${vLabel}:`, v2.requested_count, v2, planVersion),
        summary: `${replanResult.strategy_summary} — re-searching ${v2.business_type} in ${v2.location}`,
        payload: replanPlanPayload,
        userId: task.user_id,
        conversationId,
      });
      console.log(`[REPLAN] Plan ${vLabel} artefact id=${replanPlanArtefact.id}`);

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'artefact_created', status: 'success',
        taskGenerated: `Plan ${vLabel} artefact created`,
        runType: 'plan',
        metadata: { artefactId: replanPlanArtefact.id, artefactType: 'plan', plan_version: planVersion, strategy: replanResult.strategy_summary },
      });

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'plan_execution_started', status: 'pending',
        taskGenerated: `Executing Plan ${vLabel}: ${replanResult.strategy_summary}`,
        runType: 'plan',
        metadata: { plan_version: planVersion, strategy: replanResult.strategy_summary, planArtefactId: replanPlanArtefact.id },
      });
      console.log(`[REPLAN] [plan_execution_started] plan_version=${planVersion} strategy="${replanResult.strategy_summary}"`);

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'step_started', status: 'pending',
        taskGenerated: `Step 1/1 (${vLabel}): SEARCH_PLACES — ${v2.business_type} in ${v2.location}`,
        runType: 'plan',
        metadata: { step: 1, total_steps: 1, tool: 'SEARCH_PLACES', query: v2.business_type, location: v2.location, plan_version: planVersion },
      });
      console.log(`[REPLAN] [step_started] step=1 tool=SEARCH_PLACES (${vLabel})`);

      let replanLeads: typeof leads = [];
      let replanUsedStub = false;
      const replanStepStartedAt = Date.now();
      let replanStepError: string | undefined;

      try {
        const replanBusinesses = await this.searchGooglePlaces(v2.business_type, v2.location, v2.country, v2.search_count);
        if (replanBusinesses && replanBusinesses.length > 0) {
          for (const biz of replanBusinesses) {
            replanLeads.push({
              name: biz.displayName?.text || 'Unknown Business',
              address: biz.formattedAddress || `${v2.location}, ${v2.country}`,
              phone: biz.nationalPhoneNumber || biz.internationalPhoneNumber || null,
              website: biz.websiteUri || null,
              placeId: biz.id || '',
              source: 'google_places',
            });
          }
          console.log(`[REPLAN] Google Places ${vLabel} returned ${replanLeads.length} results`);

          if (v2.prefix_filter) {
            const before = replanLeads.length;
            replanLeads = replanLeads.filter(l => l.name.toUpperCase().startsWith(v2.prefix_filter!));
            console.log(`[REPLAN] Prefix filter "${v2.prefix_filter}": ${before} → ${replanLeads.length}`);
          }

          if (replanLeads.length > v2.requested_count) {
            replanLeads = replanLeads.slice(0, v2.requested_count);
            console.log(`[REPLAN] Trimmed to requested count: ${replanLeads.length}`);
          }
        } else {
          console.log(`[REPLAN] Google Places ${vLabel} returned 0 results`);
        }
      } catch (replanErr: any) {
        console.warn(`[REPLAN] Google Places ${vLabel} failed: ${replanErr.message}`);
        replanStepError = replanErr.message;
      }

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
        summary: artefactSummary(`Plan ${vLabel}: Found `, replanLeads.length, v2.requested_count, v2, planVersion),
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
          outputs_summary: { leads_count: replanLeads.length, prefix_filter: v2.prefix_filter || null, requested_count: v2.requested_count },
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

      const replanLabel = buildConstraintLabel(v2, v1Constraints, planVersion);
      const replanLeadsListPayload = {
        original_user_goal: originalUserGoal,
        normalized_goal: normalizedGoal,
        hard_constraints,
        soft_constraints,
        plan_artefact_id: replanPlanArtefact.id,
        plan_version: planVersion,
        delivered_count: replanLeads.length,
        target_count: v2.requested_count,
        success_criteria: { target_count: v2.requested_count, ...(v2.prefix_filter ? { prefix: v2.prefix_filter } : {}) },
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
          adjustments: replanResult.adjustments_applied,
          strategy: replanResult.strategy_summary,
        },
      };

      const replanLeadsListArtefact = await createArtefact({
        runId: chatRunId,
        type: 'leads_list',
        title: artefactTitle(`Leads list ${vLabel}:`, replanLeads.length, v2, planVersion),
        summary: artefactSummary(`Plan ${vLabel}: `, replanLeads.length, v2.requested_count, v2, planVersion, replanUsedStub ? '(stub fallback)' : undefined),
        payload: replanLeadsListPayload,
        userId: task.user_id,
        conversationId,
      });
      console.log(`[REPLAN] [leads_list_${vLabel}] id=${replanLeadsListArtefact.id} delivered=${replanLeads.length}`);

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'tower_call_started', status: 'pending',
        taskGenerated: `Calling Tower to judge ${vLabel} leads_list artefact ${replanLeadsListArtefact.id}`,
        runType: 'plan',
        metadata: { artefactId: replanLeadsListArtefact.id, goal, plan_version: planVersion },
      });
      console.log(`[REPLAN] [tower_call_started] artefactId=${replanLeadsListArtefact.id} (${vLabel})`);

      let replanTowerResult;
      try {
        replanTowerResult = await judgeArtefact({
          artefact: replanLeadsListArtefact,
          runId: chatRunId,
          goal,
          userId: task.user_id,
          conversationId,
          successCriteria: {
            mission_type: 'leadgen',
            target_count: v2.requested_count,
            ...(v2.prefix_filter ? { prefix: v2.prefix_filter } : {}),
            plan_version: planVersion,
            hard_constraints,
            soft_constraints,
            plan_constraints: {
              business_type: v2.business_type,
              location: v2.location,
              country: v2.country,
              search_count: v2.search_count,
              requested_count: v2.requested_count,
              prefix_filter: v2.prefix_filter || null,
            },
            max_replan_versions: MAX_REPLANS + 1,
          },
        });
      } catch (replanTowerErr: any) {
        console.error(`[REPLAN] Tower ${vLabel} call failed: ${replanTowerErr.message}`);
        replanTowerResult = {
          judgement: { verdict: 'error', reasons: [replanTowerErr.message], metrics: {}, action: 'stop' as const },
          shouldStop: true,
          stubbed: false,
        };
      }

      const replanVerdict = replanTowerResult.judgement.verdict;
      const replanAction = replanTowerResult.judgement.action;
      console.log(`[REPLAN] [tower_judgement] verdict=${replanVerdict} action=${replanAction} (${vLabel})`);

      const replanTowerJudgementArtefact = await createArtefact({
        runId: chatRunId,
        type: 'tower_judgement',
        title: `Tower Judgement ${vLabel}: ${replanVerdict}`,
        summary: `${vLabel} Verdict: ${replanVerdict} | Action: ${replanAction} | Delivered: ${replanLeads.length} of ${v2.requested_count}`,
        payload: {
          verdict: replanVerdict, action: replanAction,
          reasons: replanTowerResult.judgement.reasons, metrics: replanTowerResult.judgement.metrics,
          plan_version: planVersion, delivered: replanLeads.length, requested: v2.requested_count,
          artefact_id: replanLeadsListArtefact.id, stubbed: replanTowerResult.stubbed,
        },
        userId: task.user_id,
        conversationId,
      });

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'tower_verdict', status: replanTowerResult.shouldStop ? 'failed' : 'success',
        taskGenerated: `Tower ${vLabel} verdict: ${replanVerdict} — action: ${replanAction}`,
        runType: 'plan',
        metadata: {
          plan_version: planVersion, verdict: replanVerdict, action: replanAction,
          artefactId: replanLeadsListArtefact.id, towerJudgementArtefactId: replanTowerJudgementArtefact.id,
          delivered: replanLeads.length, requested: v2.requested_count,
          stubbed: replanTowerResult.stubbed,
        },
      });
      console.log(`[REPLAN] [tower_verdict] verdict=${replanVerdict} (${vLabel})`);

      finalVerdict = replanVerdict;
      finalAction = replanAction;
      finalLeads = replanLeads;
      finalLeadsListArtefact = replanLeadsListArtefact;
      finalTowerResult = replanTowerResult;
      finalConstraints = { business_type: v2.business_type, location: v2.location, prefix_filter: v2.prefix_filter || null, requested_count: v2.requested_count };
      businessType = v2.business_type;
      city = v2.location;
      prefixFilter = v2.prefix_filter;
      currentConstraints = v2;
      priorPlanArtefactId = replanPlanArtefact.id;
      priorLeadsCount = replanLeads.length;

      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'replan_completed', status: replanTowerResult.shouldStop ? 'failed' : 'success',
        taskGenerated: `Replan ${replansUsed}/${MAX_REPLANS} completed: ${vLabel} delivered ${replanLeads.length}, verdict=${replanVerdict}`,
        runType: 'plan',
        metadata: {
          plan_version: planVersion, prior_delivered: priorLeadsCount, replan_delivered: replanLeads.length,
          replan_verdict: replanVerdict, replan_action: replanAction,
          replans_used: replansUsed, max_replans: MAX_REPLANS,
          strategy: replanResult.strategy_summary,
        },
      });
      console.log(`[REPLAN] [replan_completed] replan=${replansUsed}/${MAX_REPLANS} delivered=${replanLeads.length} verdict=${replanVerdict}`);
    }

    const isHalted = finalTowerResult.shouldStop || finalVerdict === 'error' || finalVerdict === 'fail';
    if (isHalted) {
      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'run_halted', status: 'failed',
        taskGenerated: `Tower loop chat halted: verdict=${finalVerdict} action=${finalAction} plan_version=${planVersion}`,
        runType: 'plan',
        metadata: { verdict: finalVerdict, action: finalAction, leads_count: finalLeads.length, requested: requestedCount, plan_version: planVersion },
      });
      console.log(`[TOWER_LOOP_CHAT] [run_halted] verdict=${finalVerdict} plan_version=${planVersion}`);

      await storage.updateAgentRun(chatRunId, { status: 'completed', terminalState: 'stopped', metadata: { verdict: finalVerdict, action: finalAction, leads_count: finalLeads.length, halted: true, plan_version: planVersion } });
    } else {
      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'run_completed', status: 'success',
        taskGenerated: `Tower loop chat completed: ${finalLeads.length} leads, verdict=${finalVerdict} plan_version=${planVersion}`,
        runType: 'plan',
        metadata: { verdict: finalVerdict, action: finalAction, leads_count: finalLeads.length, requested: requestedCount, plan_version: planVersion },
      });
      console.log(`[TOWER_LOOP_CHAT] [run_completed] verdict=${finalVerdict} leads=${finalLeads.length} plan_version=${planVersion}`);

      await storage.updateAgentRun(chatRunId, { status: 'completed', terminalState: 'completed', metadata: { verdict: finalVerdict, action: finalAction, leads_count: finalLeads.length, halted: false, plan_version: planVersion } });
    }

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
        requested: requestedCount,
        artefact_id: finalLeadsListArtefact.id,
        used_stub: usedStub,
        stubbed: finalTowerResult.stubbed,
        plan_version: planVersion,
      },
      userId: task.user_id,
      conversationId,
    }).catch(() => {});

    const finalLabel = buildConstraintLabel(finalConstraints, v1Constraints, planVersion);
    const finalAnnotations = finalLabel.annotations.length > 0 ? ` (${finalLabel.annotations.join(', ')})` : '';
    const finalLocDisplay = finalConstraints.location;
    const finalPrefixDisplay = finalConstraints.prefix_filter ? ` starting with ${finalConstraints.prefix_filter}` : '';

    await this.postArtefactToUI({
      runId: chatRunId,
      clientRequestId,
      type: 'leads',
      payload: {
        title: artefactTitle('', finalLeads.length, finalConstraints, planVersion).trim(),
        summary: `Found ${finalLeads.length} ${finalConstraints.business_type} prospects in ${finalLocDisplay}${finalPrefixDisplay}${finalAnnotations}${usedStub ? ' (stub data)' : ''} — Tower verdict: ${finalVerdict}`,
        leads: finalLeads.map(l => ({ name: l.name, address: l.address, phone: l.phone, website: l.website, placeId: l.placeId, source: l.source })),
        query: { businessType: finalConstraints.business_type, location: finalLocDisplay, country },
        tool: 'SEARCH_PLACES',
        tower_verdict: finalVerdict,
        plan_version: planVersion,
        relaxed_constraints: finalLabel.relaxed_constraints,
        constraint_diffs: finalLabel.constraint_diffs,
      },
      userId: task.user_id,
      conversationId,
    }).catch(() => {});

    const chatResponse = isHalted
      ? `I found ${finalLeads.length} ${finalConstraints.business_type} prospects in ${finalLocDisplay}${finalAnnotations}${planVersion > 1 ? ` after adjusting the search plan` : ''}, but the results didn't fully meet quality criteria (Tower verdict: ${finalVerdict}). You can still view what was found in your results. Would you like me to try a different search?`
      : `I found ${finalLeads.length} ${finalConstraints.business_type} prospects in ${finalLocDisplay}${finalAnnotations}${planVersion > 1 ? ` (adjusted search plan)` : ''}, validated by our quality system. View your results in the [dashboard](/leads) to see detailed profiles and contact information.`;

    console.log(`[TOWER_LOOP_CHAT] [complete] leads=${finalLeads.length} verdict=${finalVerdict} halted=${isHalted} plan_version=${planVersion} stub=${usedStub}`);

    return { response: chatResponse, leadIds: createdLeadIds };
  }

  private generateStubLeads(businessType: string, city: string, country: string): Array<{ name: string; address: string; phone: string | null; website: string | null; placeId: string; source: string }> {
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
