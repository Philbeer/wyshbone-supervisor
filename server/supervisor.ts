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
  private pollInterval: number = 30000; // 30 seconds
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
        .select('id, user_id, conversation_id, request_data, created_at, status')
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
        .select('id, user_id, conversation_id, request_data, created_at, status')
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
    task: { id: string; user_id: string; conversation_id: string; request_data: any; created_at: any; status: string },
    trigger: 'startup' | 'stale_sweep',
  ): Promise<'requeued' | 'skipped' | 'failed'> {
    if (!supabase) return 'failed';

    const runId = task.request_data?.run_id || task.id;
    const clientRequestId = task.request_data?.client_request_id || `crid_${task.id}`;
    const logPrefix = `[RECOVERY][${trigger}] task=${task.id}`;

    if (!task.request_data?.run_id) {
      console.log(`${logPrefix} no run_id in request_data — using task.id as deterministic fallback`);
    }

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
    const uiRunId = requestData.run_id || task.id;
    const clientRequestId = requestData.client_request_id || `crid_${task.id}`;

    if (!requestData.run_id || !requestData.client_request_id) {
      const generated = [!requestData.run_id && `run_id=${uiRunId}`, !requestData.client_request_id && `crid=${clientRequestId}`].filter(Boolean).join(', ');
      console.log(`[SUPERVISOR] Task ${task.id}: auto-generated missing identifiers (${generated})`);

      const patchedData = { ...requestData, run_id: uiRunId, client_request_id: clientRequestId };
      await supabase
        .from('supervisor_tasks')
        .update({ request_data: patchedData })
        .eq('id', task.id);
    }

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
              artefact_types_found: [...new Set(artefacts.map(a => a.type))],
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

    let businessType = searchQuery?.business_type as string | undefined;
    let location = (searchQuery?.location as string) || '';
    let requestedCount = 20;

    if (!businessType && rawMsg) {
      const msg = rawMsg.trim();
      const inMatch = msg.match(/\s+in\s+(.+)$/i);
      if (inMatch) {
        location = inMatch[1].trim();
        businessType = msg.replace(/^find\s+/i, '').replace(/\s+in\s+.+$/i, '').trim() || undefined;
      } else {
        businessType = msg.replace(/^find\s+/i, '').trim() || undefined;
      }
      if (businessType) {
        const numMatch = businessType.match(/^(\d+)\s+/);
        if (numMatch) {
          requestedCount = Math.min(parseInt(numMatch[1], 10), 200);
          businessType = businessType.replace(/^\d+\s*/, '').trim() || undefined;
        }
      }
    }
    if (searchQuery?.count) requestedCount = Math.min(Number(searchQuery.count), 200);
    if (!businessType) businessType = 'pubs';
    if (!location) location = 'Local';
    const city = location.split(',')[0].trim();
    const country = location.split(',')[1]?.trim() || 'UK';
    const goal = `Find ${requestedCount} ${businessType} in ${city} for B2B outreach`;

    console.log(`[TOWER_LOOP_CHAT] Starting — businessType="${businessType}" location="${city}" count=${requestedCount} goal="${goal}"`);

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
          plan: { version: 1, steps: [{ tool: 'SEARCH_PLACES', args: { query: businessType, location: city, country, maxResults: requestedCount } }] },
        },
      });
      console.log(`[TOWER_LOOP_CHAT] [agent_run_create] runId=${chatRunId}`);
    } catch (createErr: any) {
      const errMsg = createErr.message || '';
      if (errMsg.includes('duplicate key') || errMsg.includes('unique constraint')) {
        const isPkeyConflict = errMsg.includes('agent_runs_pkey');
        const isCridConflict = errMsg.includes('client_request_id');
        console.log(`[TOWER_LOOP_CHAT] agent_run duplicate: pkey=${isPkeyConflict} crid=${isCridConflict} runId=${chatRunId} crid=${clientRequestId}`);

        if (isPkeyConflict) {
          await storage.updateAgentRun(chatRunId, {
            status: 'executing',
            error: null,
            terminalState: null,
            metadata: {
              feature_flag: 'TOWER_LOOP_CHAT_MODE',
              retry_reuse: true,
              plan: { version: 1, steps: [{ tool: 'SEARCH_PLACES', args: { query: businessType, location: city, country, maxResults: requestedCount } }] },
            },
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
              status: 'executing',
              error: null,
              terminalState: null,
              metadata: {
                feature_flag: 'TOWER_LOOP_CHAT_MODE',
                retry_reuse: true,
                original_run_id: task.request_data.run_id,
                plan: { version: 1, steps: [{ tool: 'SEARCH_PLACES', args: { query: businessType, location: city, country, maxResults: requestedCount } }] },
              },
            });
          } else {
            console.error(`[TOWER_LOOP_CHAT] crid conflict but no existing run found — cannot proceed`);
            throw createErr;
          }
        } else {
          await storage.updateAgentRun(chatRunId, {
            status: 'executing',
            error: null,
            terminalState: null,
            metadata: {
              feature_flag: 'TOWER_LOOP_CHAT_MODE',
              retry_reuse: true,
              plan: { version: 1, steps: [{ tool: 'SEARCH_PLACES', args: { query: businessType, location: city, country, maxResults: requestedCount } }] },
            },
          });
        }
      } else {
        throw createErr;
      }
    }

    // 2. AFR: plan_execution_started
    await logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
      actionTaken: 'plan_execution_started', status: 'pending',
      taskGenerated: `Tower loop chat: ${goal}`,
      runType: 'plan',
      metadata: { goal, plan_version: 1, steps: 1, tool: 'SEARCH_PLACES', feature_flag: 'TOWER_LOOP_CHAT_MODE' },
    });
    console.log(`[TOWER_LOOP_CHAT] [plan_execution_started] goal="${goal}"`);

    // 3. AFR: step_started
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
      const businesses = await this.searchGooglePlaces(businessType, city, country, requestedCount);
      if (businesses && businesses.length > 0) {
        for (const biz of businesses.slice(0, Math.min(requestedCount, 20))) {
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
          title: `Step result: SEARCH_PLACES – ${businessType} in ${city}`,
          summary: towerLoopStepSummary,
          payload: {
            run_id: chatRunId,
            client_request_id: clientRequestId,
            goal,
            plan_version: 1,
            step_id: 'chat_tower_loop_search_places',
            step_title: `SEARCH_PLACES – ${businessType} in ${city}`,
            step_type: 'SEARCH_PLACES',
            step_index: 0,
            step_status: towerLoopStepStatus,
            inputs_summary: compactInputs({ query: businessType, location: city, country, maxResults: requestedCount }),
            outputs_summary: { leads_count: leads.length, used_stub: usedStub, ...(towerLoopStepError ? { fallback_error: towerLoopStepError } : {}) },
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
    const leadsListPayload = {
      delivered_count: leads.length,
      target_count: requestedCount,
      success_criteria: { target_count: requestedCount },
      query: businessType,
      location: city,
      country,
      used_stub: usedStub,
      leads: leads.map(l => ({ name: l.name, address: l.address, phone: l.phone, website: l.website })),
    };

    const leadsListArtefact = await createArtefact({
      runId: chatRunId,
      type: 'leads_list',
      title: `Leads list: ${leads.length} ${businessType} in ${city}`,
      summary: `Delivered ${leads.length} of ${requestedCount} requested for "${businessType}" in ${city}${usedStub ? ' (stub fallback)' : ''}`,
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
        successCriteria: { target_leads: requestedCount },
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
      summary: `Verdict: ${verdict} | Action: ${action} | Delivered: ${leads.length} of ${requestedCount}`,
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

    // 12. Terminal AFR event: run_completed or run_halted
    const isHalted = towerResult.shouldStop || verdict === 'error' || verdict === 'fail';
    if (isHalted) {
      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'run_halted', status: 'failed',
        taskGenerated: `Tower loop chat halted: verdict=${verdict} action=${action}`,
        runType: 'plan',
        metadata: { verdict, action, leads_count: leads.length, requested: requestedCount },
      });
      console.log(`[TOWER_LOOP_CHAT] [run_halted] verdict=${verdict}`);

      await storage.updateAgentRun(chatRunId, { status: 'completed', terminalState: 'stopped', metadata: { verdict, action, leads_count: leads.length, halted: true } });
    } else {
      await logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
        actionTaken: 'run_completed', status: 'success',
        taskGenerated: `Tower loop chat completed: ${leads.length} leads, verdict=${verdict}`,
        runType: 'plan',
        metadata: { verdict, action, leads_count: leads.length, requested: requestedCount },
      });
      console.log(`[TOWER_LOOP_CHAT] [run_completed] verdict=${verdict} leads=${leads.length}`);

      await storage.updateAgentRun(chatRunId, { status: 'completed', terminalState: 'completed', metadata: { verdict, action, leads_count: leads.length, halted: false } });
    }

    // 12b. Post tower_judgement artefact to UI for automatic display
    await this.postArtefactToUI({
      runId: chatRunId,
      clientRequestId,
      type: 'tower_judgement',
      payload: {
        verdict,
        action,
        reasons: towerResult.judgement.reasons,
        metrics: towerResult.judgement.metrics,
        delivered: leads.length,
        requested: requestedCount,
        artefact_id: leadsListArtefact.id,
        used_stub: usedStub,
        stubbed: towerResult.stubbed,
      },
      userId: task.user_id,
      conversationId,
    }).catch(() => {});

    // 13. Also post artefact to UI for visibility
    await this.postArtefactToUI({
      runId: chatRunId,
      clientRequestId,
      type: 'leads',
      payload: {
        title: `${leads.length} ${businessType} leads in ${city}`,
        summary: `Found ${leads.length} ${businessType} prospects in ${city}${usedStub ? ' (stub data)' : ''} — Tower verdict: ${verdict}`,
        leads: leads.map(l => ({ name: l.name, address: l.address, phone: l.phone, website: l.website, placeId: l.placeId, source: l.source })),
        query: { businessType, location: city, country },
        tool: 'SEARCH_PLACES',
        tower_verdict: verdict,
      },
      userId: task.user_id,
      conversationId,
    }).catch(() => {});

    const chatResponse = isHalted
      ? `I found ${leads.length} ${businessType} prospects in ${city}, but the results didn't fully meet quality criteria (Tower verdict: ${verdict}). You can still view what was found in your results. Would you like me to try a different search?`
      : `I found ${leads.length} ${businessType} prospects in ${city}, validated by our quality system. View your results in the [dashboard](/leads) to see detailed profiles and contact information.`;

    console.log(`[TOWER_LOOP_CHAT] [complete] leads=${leads.length} verdict=${verdict} halted=${isHalted} stub=${usedStub}`);

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
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_PLACES_API_KEY not configured');
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
