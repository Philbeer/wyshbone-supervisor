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
  private missingTableWarned: boolean = false; // Track if we've warned about missing table

  async start() {
    if (this.isRunning) {
      console.log('Supervisor already running');
      return;
    }

    this.isRunning = true;
    console.log('🤖 Supervisor service started - monitoring for new signals...');
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

      const towerDuringRun = process.env.ENABLE_TOWER_DURING_RUN === 'true';
      const tasks: Promise<void>[] = [
        this.processNewSignals(),
        this.processSupervisorTasks(),
        this.monitorGoals(),
      ];
      if (!towerDuringRun) {
        tasks.push(this.backfillTowerJudgements());
      } else {
        console.log('[SUPERVISOR] ENABLE_TOWER_DURING_RUN=true — backfill poller disabled (Tower judgement is synchronous)');
      }
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

  private async processSupervisorTasks() {
    if (!supabase) return;
    
    // Fetch pending supervisor tasks from Supabase
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
    const uiRunId = requestData.run_id;
    const clientRequestId = requestData.client_request_id;

    if (!uiRunId || !clientRequestId) {
      const missing = [!uiRunId && 'run_id', !clientRequestId && 'client_request_id'].filter(Boolean).join(', ');
      console.error(`[SUPERVISOR] Task ${task.id}: missing required identifiers (${missing}) in request_data — aborting`);
      logAFREvent({
        userId: task.user_id, runId: uiRunId || 'unknown', conversationId: task.conversation_id,
        actionTaken: 'artefact_post_failed', status: 'failed',
        taskGenerated: `Artefact POST aborted: missing identifiers (${missing})`,
        runType: 'plan', metadata: { taskId: task.id, errorCode: 'missing_identifiers', missing },
      }).catch(() => {});
      await supabase
        .from('supervisor_tasks')
        .update({ status: 'failed', error: `Missing required identifiers: ${missing}` })
        .eq('id', task.id);
      return;
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

    await this.ensureTowerJudgement(jobId, clientRequestId, task.user_id, task.conversation_id);

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

  private async ensureTowerJudgement(
    runId: string,
    clientRequestId: string,
    userId: string,
    conversationId: string,
  ): Promise<void> {
    try {
      const artefacts = await storage.getArtefactsByRunId(runId);
      const hasTowerJudgement = artefacts.some(a => a.type === 'tower_judgement');

      if (hasTowerJudgement) {
        console.log(`[TOWER_SAFETY] runId=${runId} tower_judgement already exists — skipping safety net`);
        return;
      }

      const leadsListArtefact = artefacts
        .filter(a => a.type === 'leads_list')
        .sort((a, b) => {
          const ta = typeof a.createdAt === 'number' ? a.createdAt : new Date(String(a.createdAt)).getTime();
          const tb = typeof b.createdAt === 'number' ? b.createdAt : new Date(String(b.createdAt)).getTime();
          return tb - ta;
        })[0];

      if (!leadsListArtefact) {
        console.log(`[TOWER_SAFETY] runId=${runId} no leads_list artefact found — nothing to judge`);
        return;
      }

      console.log(`[TOWER_SAFETY] runId=${runId} NO tower_judgement found — triggering safety net judgement on leads_list=${leadsListArtefact.id}`);

      const payload = (leadsListArtefact.payloadJson as Record<string, unknown>) || {};
      const delivered = payload.delivered_count ?? 0;
      const requested = payload.target_count ?? 0;
      const query = payload.query ?? 'unknown';
      const location = payload.location ?? 'unknown';
      const goal = `Find ${requested} ${query} in ${location}`;

      await logAFREvent({
        userId, runId, conversationId, clientRequestId,
        actionTaken: 'tower_call_started', status: 'pending',
        taskGenerated: `[Safety net] Calling Tower to judge leads_list artefact ${leadsListArtefact.id}`,
        runType: 'plan',
        metadata: { artefactId: leadsListArtefact.id, goal, safety_net: true },
      });

      let towerResult;
      try {
        towerResult = await judgeArtefact({
          artefact: leadsListArtefact,
          runId,
          goal,
          userId,
          conversationId,
          successCriteria: { target_leads: requested },
        });
      } catch (towerErr: any) {
        const errMsg = towerErr.message || 'Tower call failed';
        console.error(`[TOWER_SAFETY] Tower call failed: ${errMsg}`);

        const errorArtefact = await createArtefact({
          runId,
          type: 'tower_judgement',
          title: `Tower Judgement: error`,
          summary: `[Safety net] Tower unreachable/failed: ${errMsg}`,
          payload: { verdict: 'error', action: 'stop', reasons: [errMsg], metrics: {}, delivered, requested, error: errMsg, safety_net: true },
          userId,
          conversationId,
        });

        await this.postArtefactToUI({
          runId, clientRequestId,
          type: 'tower_judgement',
          payload: { verdict: 'error', action: 'stop', reasons: [errMsg], metrics: {}, delivered, requested, error: errMsg, safety_net: true },
          userId, conversationId,
        }).catch(() => {});

        await logAFREvent({
          userId, runId, conversationId, clientRequestId,
          actionTaken: 'tower_verdict', status: 'failed',
          taskGenerated: `[Safety net] Tower error: ${errMsg}`,
          runType: 'plan',
          metadata: { artefactId: leadsListArtefact.id, verdict: 'error', error: errMsg, towerJudgementArtefactId: errorArtefact.id, safety_net: true },
        });

        return;
      }

      const verdict = towerResult.judgement.verdict;
      const action = towerResult.judgement.action;
      console.log(`[TOWER_SAFETY] verdict=${verdict} action=${action} stubbed=${towerResult.stubbed}`);

      const towerJudgementArtefact = await createArtefact({
        runId,
        type: 'tower_judgement',
        title: `Tower Judgement: ${verdict}`,
        summary: `[Safety net] Verdict: ${verdict} | Action: ${action} | Delivered: ${delivered} of ${requested}`,
        payload: {
          verdict, action,
          reasons: towerResult.judgement.reasons,
          metrics: towerResult.judgement.metrics,
          delivered, requested,
          artefact_id: leadsListArtefact.id,
          stubbed: towerResult.stubbed,
          safety_net: true,
        },
        userId,
        conversationId,
      });

      await this.postArtefactToUI({
        runId, clientRequestId,
        type: 'tower_judgement',
        payload: {
          verdict, action,
          reasons: towerResult.judgement.reasons,
          metrics: towerResult.judgement.metrics,
          delivered, requested,
          artefact_id: leadsListArtefact.id,
          stubbed: towerResult.stubbed,
          safety_net: true,
        },
        userId, conversationId,
      }).catch(() => {});

      await logAFREvent({
        userId, runId, conversationId, clientRequestId,
        actionTaken: 'tower_verdict', status: towerResult.shouldStop ? 'failed' : 'success',
        taskGenerated: `[Safety net] Tower verdict: ${verdict} — action: ${action}`,
        runType: 'plan',
        metadata: {
          verdict, action,
          artefactId: leadsListArtefact.id,
          towerJudgementArtefactId: towerJudgementArtefact.id,
          delivered, requested,
          reasons: towerResult.judgement.reasons,
          stubbed: towerResult.stubbed,
          safety_net: true,
        },
      });

      console.log(`[TOWER_SAFETY] runId=${runId} safety net complete — tower_judgement=${towerJudgementArtefact.id} verdict=${verdict}`);
    } catch (err: any) {
      console.error(`[TOWER_SAFETY] runId=${runId} safety net failed (non-fatal): ${err.message}`);
    }
  }

  private async backfillTowerJudgements(): Promise<void> {
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
            .select('id, run_id, type, title, summary, payload_json, created_at')
            .eq('run_id', run.id);

          if (artErr || !artefacts) continue;

          const hasLeadsList = artefacts.some(a => a.type === 'leads_list');
          const hasTowerJudgement = artefacts.some(a => a.type === 'tower_judgement');
          const hasStepResult = artefacts.some(a => a.type === 'step_result');

          if (!hasLeadsList || hasTowerJudgement) continue;

          const leadsListArt = artefacts.find(a => a.type === 'leads_list')!;
          const payload = leadsListArt.payload_json || {};

          let leadsCount = 0;
          let query = 'businesses';
          let location = 'unknown';

          if (Array.isArray(payload)) {
            leadsCount = payload.length;
          } else if (typeof payload === 'object') {
            leadsCount = payload.delivered_count ?? payload.leads?.length ?? Object.keys(payload).filter(k => /^\d+$/.test(k)).length;
            query = payload.query || 'businesses';
            location = payload.location || 'unknown';
          }

          if (typeof leadsListArt.title === 'string') {
            const titleMatch = leadsListArt.title.match(/(\d+)\s+(.+?)\s+(?:in|businesses?\s+in)\s+(.+)/i);
            if (titleMatch) {
              leadsCount = leadsCount || parseInt(titleMatch[1], 10);
              query = query === 'businesses' ? titleMatch[2] : query;
              location = location === 'unknown' ? titleMatch[3] : location;
            }
          }

          const userMessage = run.metadata?.userMessagePreview || `Find ${query} in ${location}`;
          const goal = `Find ${query} in ${location} for B2B outreach`;

          // Backfill step_result if missing (for runs created by external UI backend)
          if (!hasStepResult) {
            try {
              const stepResultId = randomUUID();
              const stepStatus = leadsCount > 0 ? 'success' : 'fail';
              const stepSummary = leadsCount > 0
                ? `success – found ${leadsCount} ${query} in ${location}`
                : `fail – 0 results for ${query} in ${location}`;
              const { error: stepInsertErr } = await supabase.from('artefacts').insert({
                id: stepResultId,
                run_id: run.id,
                type: 'step_result',
                title: `Step result: SEARCH_PLACES – ${query} in ${location}`,
                summary: stepSummary,
                payload_json: {
                  run_id: run.id,
                  client_request_id: run.client_request_id || null,
                  goal,
                  plan_version: 1,
                  step_id: 'backfill_search_places',
                  step_title: `SEARCH_PLACES – ${query} in ${location}`,
                  step_type: 'SEARCH_PLACES',
                  step_index: 0,
                  step_status: stepStatus,
                  inputs_summary: { query, location },
                  outputs_summary: { leads_count: leadsCount },
                  backfill: true,
                },
              });

              if (stepInsertErr) {
                console.warn(`[TOWER_BACKFILL] runId=${run.id} failed to insert step_result: ${stepInsertErr.message}`);
              } else {
                console.log(`[TOWER_BACKFILL] runId=${run.id} step_result backfilled — status=${stepStatus} leads=${leadsCount}`);

                // Observation Tower judgement on the backfilled step_result
                try {
                  const stepArtefactForJudge = {
                    id: stepResultId,
                    runId: run.id,
                    type: 'step_result' as const,
                    title: `Step result: SEARCH_PLACES – ${query} in ${location}`,
                    summary: stepSummary,
                    payloadJson: { run_id: run.id, goal, step_type: 'SEARCH_PLACES', step_status: stepStatus, leads_count: leadsCount },
                    createdAt: new Date(),
                  };
                  const obsResult = await judgeArtefact({
                    artefact: stepArtefactForJudge,
                    runId: run.id, goal, userId: run.user_id,
                  });
                  const obsId = randomUUID();
                  const { error: obsInsertErr } = await supabase.from('artefacts').insert({
                    id: obsId,
                    run_id: run.id,
                    type: 'tower_judgement',
                    title: `Tower Judgement: ${obsResult.judgement.verdict} (step observation)`,
                    summary: `Observation: ${obsResult.judgement.verdict} | ${obsResult.judgement.action} | SEARCH_PLACES`,
                    payload_json: {
                      verdict: obsResult.judgement.verdict, action: obsResult.judgement.action,
                      reasons: obsResult.judgement.reasons, metrics: obsResult.judgement.metrics,
                      step_index: 0, step_label: `SEARCH_PLACES – ${query} in ${location}`,
                      judged_artefact_id: stepResultId, stubbed: obsResult.stubbed,
                      observation_only: true, backfill: true,
                    },
                  });
                  if (obsInsertErr) {
                    console.warn(`[TOWER_BACKFILL] runId=${run.id} failed to insert observation tower_judgement: ${obsInsertErr.message}`);
                  } else {
                    console.log(`[STEP_OBSERVATION] [backfill] runId=${run.id} verdict=${obsResult.judgement.verdict} action=${obsResult.judgement.action} (observation only)`);
                  }
                } catch (obsErr: any) {
                  console.warn(`[STEP_OBSERVATION] [backfill] runId=${run.id} Tower observation failed (continuing): ${obsErr.message}`);
                }
              }
            } catch (stepErr: any) {
              console.warn(`[TOWER_BACKFILL] runId=${run.id} step_result backfill failed (non-fatal): ${stepErr.message}`);
            }
          }

          console.log(`[TOWER_BACKFILL] runId=${run.id} found leads_list but no tower_judgement — triggering backfill (${leadsCount} leads)`);

          const artefactForJudge = {
            id: leadsListArt.id,
            runId: run.id,
            type: 'leads_list' as const,
            title: leadsListArt.title || '',
            summary: leadsListArt.summary || null,
            payloadJson: payload,
            createdAt: typeof leadsListArt.created_at === 'string' ? new Date(leadsListArt.created_at).getTime() : leadsListArt.created_at,
          };

          let towerResult;
          try {
            towerResult = await judgeArtefact({
              artefact: artefactForJudge,
              runId: run.id,
              goal,
              userId: run.user_id,
              successCriteria: { target_leads: leadsCount },
            });
          } catch (towerErr: any) {
            console.error(`[TOWER_BACKFILL] runId=${run.id} Tower call failed: ${towerErr.message}`);
            const { error: insertErr } = await supabase.from('artefacts').insert({
              id: randomUUID(),
              run_id: run.id,
              type: 'tower_judgement',
              title: 'Tower Judgement: error',
              summary: `Tower unreachable: ${towerErr.message}`,
              payload_json: { verdict: 'error', action: 'stop', reasons: [towerErr.message], metrics: {}, delivered: leadsCount, error: towerErr.message, backfill: true },
            });
            if (insertErr) console.error(`[TOWER_BACKFILL] runId=${run.id} failed to insert error artefact: ${insertErr.message}`);
            continue;
          }

          const verdict = towerResult.judgement.verdict;
          const action = towerResult.judgement.action;

          const { error: insertErr } = await supabase.from('artefacts').insert({
            id: randomUUID(),
            run_id: run.id,
            type: 'tower_judgement',
            title: `Tower Judgement: ${verdict}`,
            summary: `Verdict: ${verdict} | Action: ${action} | Leads: ${leadsCount}`,
            payload_json: {
              verdict,
              action,
              reasons: towerResult.judgement.reasons,
              metrics: towerResult.judgement.metrics,
              delivered: leadsCount,
              artefact_id: leadsListArt.id,
              stubbed: towerResult.stubbed,
              backfill: true,
            },
          });

          if (insertErr) {
            console.error(`[TOWER_BACKFILL] runId=${run.id} failed to insert tower_judgement: ${insertErr.message}`);
            continue;
          }

          console.log(`[TOWER_BACKFILL] runId=${run.id} tower_judgement created — verdict=${verdict} action=${action}`);

          await logAFREvent({
            userId: run.user_id, runId: run.id,
            clientRequestId: run.client_request_id,
            actionTaken: 'tower_verdict', status: towerResult.shouldStop ? 'failed' : 'success',
            taskGenerated: `[Backfill] Tower verdict: ${verdict} — action: ${action}`,
            runType: 'plan',
            metadata: { verdict, action, leadsCount, artefactId: leadsListArt.id, stubbed: towerResult.stubbed, backfill: true },
          }).catch(() => {});
        } catch (runErr: any) {
          console.error(`[TOWER_BACKFILL] runId=${run.id} failed (non-fatal): ${runErr.message}`);
        }
      }
    } catch (err: any) {
      console.error(`[TOWER_BACKFILL] Poller error (non-fatal): ${err.message}`);
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

    // 1. Create agent_run row
    const nowMs = Date.now();
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
        console.warn(`[STEP_ARTEFACT] Failed to create step_result for tower_loop_chat (non-fatal): ${stepArtErr.message}`);
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
        }
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
