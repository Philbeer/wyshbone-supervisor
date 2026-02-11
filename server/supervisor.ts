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

      // Process signals, chat tasks, and goal monitoring in parallel
      await Promise.all([
        this.processNewSignals(),
        this.processSupervisorTasks(),
        this.monitorGoals()
      ]);
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

    // Build user context for intelligent response
    const userContext = await this.buildUserContext(task.user_id);

    // Fetch conversation context with error handling
    const { data: messages, error: messagesError } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', task.conversation_id)
      .order('created_at', { ascending: true })
      .limit(50);

    if (messagesError) {
      throw new Error(`Failed to fetch conversation messages: ${messagesError.message}`);
    }

    const conversationContext = messages?.map(m => ({
      role: m.role,
      content: m.content,
      created_at: m.created_at
    })) || [];

    const userMessage = (requestData.user_message || '').toLowerCase().trim();
    let effectiveTaskType = task.task_type;

    const LEAD_FIND_KEYWORDS = /\b(find|search|look\s*for|get|discover|locate)\b/i;
    const VENUE_KEYWORDS = /\b(pubs?|bars?|breweries|brewery|taverns?|inns?|gastropubs?|freehouse|free\s+house|public\s+house|venues?|nightclubs?|clubs?|restaurants?|cafes?|coffee\s+shops?|hotels?|b&bs?|guest\s*houses?)\b/i;
    const LOCATION_KEYWORDS = /\b(in|near|around|across|within|throughout)\s+[A-Z]/i;
    const DEEP_RESEARCH_KEYWORDS = /\b(research|investigate|analy[sz]e|summari[sz]e|summary|overview|report|sources|articles?|history|guide|best[- ]of\s+list)\b/i;
    const deepResearchOptInOnly = process.env.DEEP_RESEARCH_OPT_IN_ONLY !== 'false';

    const rawMsg = requestData.user_message || '';
    const hasLeadIntent = LEAD_FIND_KEYWORDS.test(rawMsg);
    const hasVenueType = VENUE_KEYWORDS.test(rawMsg);
    const hasLocation = LOCATION_KEYWORDS.test(rawMsg);
    const hasResearchKeyword = DEEP_RESEARCH_KEYWORDS.test(rawMsg);

    const locationExtract = rawMsg.match(/\b(?:in|near|around|across|within|throughout)\s+([A-Z][A-Za-z\s,]+)/i);
    const parsedLocation = locationExtract ? locationExtract[1].trim().replace(/[,\s]+$/, '') : null;
    let routeRequestedCount = 0;
    const routeCountMatch = rawMsg.match(/\b(\d+)\s+/);
    if (routeCountMatch) {
      routeRequestedCount = Math.min(parseInt(routeCountMatch[1], 10), 200);
    }

    const matchedKeywords: string[] = [];
    if (hasLeadIntent) matchedKeywords.push('lead_verb');
    if (hasVenueType) matchedKeywords.push('venue_type');
    if (hasLocation) matchedKeywords.push('location');
    if (hasResearchKeyword) {
      const researchMatch = rawMsg.match(DEEP_RESEARCH_KEYWORDS);
      if (researchMatch) matchedKeywords.push(`research:${researchMatch[0].toLowerCase()}`);
    }

    let chosenTool: string;
    let routeReason: string;
    let routeIntent: string;

    if (hasLeadIntent && hasVenueType && hasLocation) {
      chosenTool = 'SEARCH_PLACES';
      routeIntent = 'lead_find';
      if (effectiveTaskType !== 'generate_leads' && effectiveTaskType !== 'find_prospects') {
        routeReason = `lead_find: venue+location detected, override from ${effectiveTaskType}`;
        console.log(`[ROUTE_DECISION] intent=lead_find tool=SEARCH_PLACES reason="pubs+location" override_from="${effectiveTaskType}" message="${rawMsg.substring(0, 80)}"`);
        effectiveTaskType = 'generate_leads';
      } else {
        routeReason = `lead_find: venue+location detected, task_type=${effectiveTaskType}`;
        console.log(`[ROUTE_DECISION] intent=lead_find tool=SEARCH_PLACES reason="pubs+location" task_type="${effectiveTaskType}" message="${rawMsg.substring(0, 80)}"`);
      }
    } else if (effectiveTaskType === 'deep_research' && (!deepResearchOptInOnly || hasResearchKeyword)) {
      chosenTool = 'DEEP_RESEARCH';
      routeIntent = 'deep_research';
      routeReason = `deep_research: explicit research keyword detected`;
      console.log(`[ROUTER_SIGNATURE] DEEP_RESEARCH_GUARD_V1_ACTIVE entry=processChatTask optInOnly=${deepResearchOptInOnly} allowed=true`);
      console.log(`[ROUTE_DECISION] intent=deep_research tool=DEEP_RESEARCH reason="explicit_keyword" message="${rawMsg.substring(0, 80)}"`);
    } else if (effectiveTaskType === 'deep_research' && deepResearchOptInOnly && !hasResearchKeyword) {
      chosenTool = 'SEARCH_PLACES';
      routeIntent = 'lead_find';
      routeReason = `deep_research_opt_in_only: no research keywords → forcing SEARCH_PLACES`;
      console.log(`[ROUTER_SIGNATURE] DEEP_RESEARCH_GUARD_V1_ACTIVE entry=processChatTask optInOnly=${deepResearchOptInOnly} allowed=false`);
      console.log(`[DEEP_RESEARCH_GUARD] Blocking deep_research: no explicit research keywords in "${rawMsg.substring(0, 80)}" → routing to SEARCH_PLACES (DEEP_RESEARCH_OPT_IN_ONLY=${deepResearchOptInOnly})`);
      logAFREvent({
        userId: task.user_id, runId: jobId, conversationId: task.conversation_id,
        clientRequestId,
        actionTaken: 'router_override', status: 'success',
        taskGenerated: `Override: DEEP_RESEARCH → SEARCH_PLACES (opt-in gate)`,
        runType: 'plan',
        metadata: {
          original_tool: 'DEEP_RESEARCH',
          forced_tool: 'SEARCH_PLACES',
          reason: 'deep_research_opt_in_only',
          message: rawMsg.substring(0, 200),
        },
      }).catch(() => {});
      effectiveTaskType = 'generate_leads';
    } else {
      chosenTool = effectiveTaskType;
      routeIntent = effectiveTaskType;
      routeReason = `task_type routing (hasLeadIntent=${hasLeadIntent} hasVenueType=${hasVenueType} hasLocation=${hasLocation})`;
      console.log(`[ROUTE_DECISION] intent=${routeIntent} tool=${effectiveTaskType} reason="task_type" hasLeadIntent=${hasLeadIntent} hasVenueType=${hasVenueType} hasLocation=${hasLocation} message="${rawMsg.substring(0, 80)}"`);
    }

    logAFREvent({
      userId: task.user_id, runId: jobId, conversationId: task.conversation_id,
      clientRequestId,
      actionTaken: 'tool_dispatch_decision', status: 'success',
      taskGenerated: `Routing decision: ${chosenTool} for "${rawMsg.substring(0, 60)}"`,
      runType: 'plan',
      metadata: {
        intent: routeIntent,
        requested_count: routeRequestedCount || null,
        parsed_location: parsedLocation,
        chosen_tool: chosenTool,
        reason: routeReason,
        has_lead_intent: hasLeadIntent,
        has_venue_type: hasVenueType,
        has_location: hasLocation,
        matched_keywords: matchedKeywords,
      },
    }).catch(() => {});

    logAFREvent({
      userId: task.user_id, runId: jobId, conversationId: task.conversation_id,
      clientRequestId,
      actionTaken: 'router_decision_detail', status: 'success',
      taskGenerated: `Intent classification: ${routeIntent} → ${chosenTool}`,
      runType: 'plan',
      metadata: {
        intent: routeIntent,
        chosen_tool: chosenTool,
        reason: routeReason,
        matched_keywords: matchedKeywords,
      },
    }).catch(() => {});

    let response: string;
    let leadIds: string[] = [];
    let capabilities: string[] = [];

    const towerLoopChatMode = process.env.TOWER_LOOP_CHAT_MODE === 'true';
    const isLeadFindIntent = chosenTool === 'SEARCH_PLACES' || effectiveTaskType === 'generate_leads' || effectiveTaskType === 'find_prospects' || (hasLeadIntent && hasVenueType && hasLocation);

    if (towerLoopChatMode && isLeadFindIntent) {
      console.log(`[TOWER_LOOP_CHAT] Routing to Tower loop pipeline — flag=TOWER_LOOP_CHAT_MODE task=${task.id} jobId=${jobId}`);
      logAFREvent({
        userId: task.user_id, runId: jobId, conversationId: task.conversation_id,
        clientRequestId,
        actionTaken: 'tower_loop_chat_activated', status: 'success',
        taskGenerated: `TOWER_LOOP_CHAT_MODE active — routing lead_find through Tower pipeline`,
        runType: 'plan',
        metadata: { feature_flag: 'TOWER_LOOP_CHAT_MODE', intent: routeIntent, chosen_tool: chosenTool },
      }).catch(() => {});

      const towerResult = await this.executeTowerLoopChat(task, userContext, jobId, clientRequestId);
      response = towerResult.response;
      leadIds = towerResult.leadIds;
      capabilities = ['lead_generation', 'tower_validated'];
    } else {
      switch (effectiveTaskType) {
        case 'generate_leads':
        case 'find_prospects':
          const result = await this.generateLeadsForChat(task, userContext, conversationContext, jobId, clientRequestId);
          response = result.response;
          leadIds = result.leadIds;
          capabilities = ['lead_generation', 'email_enrichment'];
          break;

        case 'analyze_conversation':
          response = await this.analyzeConversation(task, userContext, conversationContext);
          capabilities = ['conversation_analysis'];
          break;

        case 'provide_insights':
          response = await this.provideInsights(task, userContext);
          capabilities = ['business_insights'];
          break;

        case 'deep_research':
          const drResult = await this.executeDeepResearchForChat(task, jobId, clientRequestId);
          response = drResult.response;
          capabilities = ['deep_research'];
          break;

        default:
          if (hasLeadIntent && hasVenueType && hasLocation) {
            console.log(`[ROUTE_DECISION] tool=SEARCH_PLACES reason="lead_intent+venue+location_fallback" override_from="${effectiveTaskType}"`);
            const fallbackResult = await this.generateLeadsForChat(task, userContext, conversationContext, jobId, clientRequestId);
            response = fallbackResult.response;
            leadIds = fallbackResult.leadIds;
            capabilities = ['lead_generation', 'email_enrichment'];
          } else {
            response = "I'm not sure how to help with that request yet. Let me know if you'd like me to find leads or analyze your conversation!";
            capabilities = [];
          }
      }
    }

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

  private async generateLeadsForChat(
    task: SupervisorTask,
    userContext: UserContext,
    conversationContext: Array<{ role: string; content: string }>,
    chatRunId: string,
    clientRequestId: string
  ): Promise<{ response: string; leadIds: string[] }> {
    const requestData = task.request_data;
    const searchQuery = requestData.search_query;

    const conversationId = task.conversation_id;

    let businessType = searchQuery?.business_type as string | undefined;
    let location = (searchQuery?.location as string) || '';

    let requestedCount = 20;

    if (!businessType && requestData.user_message) {
      const msg = (requestData.user_message as string).trim();
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

      console.log(`[CHAT_LEADS] user_message fallback: parsed businessType="${businessType}" location="${location}" requestedCount=${requestedCount} from "${msg}"`);
    }

    if (searchQuery?.count) {
      requestedCount = Math.min(Number(searchQuery.count), 200);
    }

    requestedCount = Math.min(requestedCount, 200);

    if (!businessType) {
      const missingTitle = `0 leads (no business type specified)`;
      const missingSummary = `SEARCH_PLACES skipped: no business_type in request`;
      const missingPostResult = await this.postArtefactToUI({
        runId: chatRunId,
        clientRequestId,
        type: 'leads',
        payload: {
          title: missingTitle,
          summary: missingSummary,
          leads: [],
          query: { businessType: '', location: location || '', country: '' },
          tool: 'SEARCH_PLACES',
        },
        userId: task.user_id,
        conversationId,
      });

      console.log(`[LEADS_ARTEFACT] uiRunId=${chatRunId} crid=${clientRequestId} count=0 posted=${missingPostResult.ok} status=${missingPostResult.httpStatus ?? 0}`);

      if (missingPostResult.ok) {
        logAFREvent({
          userId: task.user_id, runId: chatRunId, conversationId,
          clientRequestId,
          actionTaken: 'artefact_created', status: 'success',
          taskGenerated: `Artefact created: ${missingTitle}`,
          runType: 'plan', metadata: { artefactType: 'leads', title: missingTitle, artefactId: missingPostResult.artefactId },
        }).catch(() => {});
      }

      logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId,
        clientRequestId,
        actionTaken: 'plan_execution_finished', status: 'skipped',
        taskGenerated: `Chat run skipped: no business type provided`,
        runType: 'plan', metadata: { leads_count: 0, tool: 'SEARCH_PLACES', reason: 'missing_business_type' },
      }).catch(() => {});

      console.log(`[ARTEFACT_COUNT] runId=${chatRunId} artefacts_written=${missingPostResult.ok ? 1 : 0} types=[leads] verdict=SKIPPED reason=missing_business_type`);

      return {
        response: "I'd be happy to find leads for you! Could you tell me what type of businesses you're looking for?",
        leadIds: []
      };
    }

    if (!location) location = 'Local';
    const city = location.split(',')[0].trim();
    const country = location.split(',')[1]?.trim() || 'UK';

    console.log(`🔍 Chat request: ${businessType} in ${city}, ${country}`);
    console.log(`[ROUTE_DECISION] tool=SEARCH_PLACES reason="generateLeadsForChat" businessType="${businessType}" location="${city}" count=${requestedCount}`);

    logRouterDecision(
      task.user_id, chatRunId, 'SEARCH_PLACES',
      `Chat lead generation: searching "${businessType}" in ${city} via Google Places`,
      conversationId
    ).catch(() => {});

    try {
      logToolCallStarted(
        task.user_id, chatRunId, 'SEARCH_PLACES',
        { query: businessType, location: city, country },
        conversationId
      ).catch(() => {});

      // Search for businesses
      const businesses = await this.searchGooglePlaces(businessType, city, country, requestedCount);

      if (!businesses || businesses.length === 0) {
        logToolCallCompleted(
          task.user_id, chatRunId, 'SEARCH_PLACES',
          { summary: `No results for "${businessType}" in ${city}`, places_count: 0 },
          conversationId
        ).catch(() => {});

        const artefactTitle = `0 ${businessType} leads in ${city}`;
        const artefactSummary = `SEARCH_PLACES returned 0 results for "${businessType}" in ${city}, ${country}`;
        const postResult = await this.postArtefactToUI({
          runId: chatRunId,
          clientRequestId,
          type: 'leads',
          payload: {
            title: artefactTitle,
            summary: artefactSummary,
            leads: [],
            query: { businessType, location: city, country },
            tool: 'SEARCH_PLACES',
          },
          userId: task.user_id,
          conversationId,
        });

        console.log(`[LEADS_ARTEFACT] uiRunId=${chatRunId} crid=${clientRequestId} count=0 posted=${postResult.ok} status=${postResult.httpStatus ?? 0}`);

        if (postResult.ok) {
          logAFREvent({
            userId: task.user_id, runId: chatRunId, conversationId,
            clientRequestId,
            actionTaken: 'artefact_created', status: 'success',
            taskGenerated: `Artefact created: ${artefactTitle}`,
            runType: 'plan', metadata: { artefactType: 'leads', title: artefactTitle, artefactId: postResult.artefactId },
          }).catch(() => {});
        }

        const zeroLeadsListArtefact = await createArtefact({
          runId: chatRunId,
          type: 'leads_list',
          title: `Leads list: ${businessType} in ${city}`,
          summary: `Delivered 0 of ${requestedCount} requested for "${businessType}" in ${city} (zero results)`,
          payload: {
            delivered_count: 0,
            target_count: requestedCount,
            success_criteria: { target_count: requestedCount },
            query: businessType,
            location: city,
            country,
          },
          userId: task.user_id,
          conversationId,
        });

        console.log(`[AGENT_LOOP] tool=SEARCH_PLACES target=${requestedCount} delivered=0 (zero_results → Tower)`);

        const zeroToolArgs = { query: businessType, location: city, country, maxResults: requestedCount, target_count: requestedCount };
        if (!getRunState(chatRunId)) {
          initRunState(chatRunId, task.user_id, zeroToolArgs, conversationId, clientRequestId);
        }

        const zeroRerunTool = async (args: Record<string, unknown>): Promise<LoopActionResult> => {
          console.log(`[AGENT_LOOP] Re-running SEARCH_PLACES for zero-results chat with adjusted args`);
          return executeAction({
            toolName: 'SEARCH_PLACES',
            toolArgs: args,
            userId: task.user_id,
            runId: chatRunId,
            conversationId,
            clientRequestId,
          });
        };

        const zeroPayload = (zeroLeadsListArtefact.payloadJson as Record<string, unknown>) || {};
        const zeroReaction = await handleTowerVerdict(
          chatRunId,
          `Find ${requestedCount} ${businessType} in ${city}`,
          { target_leads: requestedCount },
          { ...zeroPayload, delivered_count: 0, target_count: requestedCount, leads_count: 0, artefact_id: zeroLeadsListArtefact.id, artefact_type: 'leads_list' },
          zeroRerunTool,
        );

        const zeroVerdict = zeroReaction.verdict.verdict;
        if (zeroReaction.action === 'stop') {
          console.log(`[CHAT_LEADS] Agent Loop: STOP (zero results) — ${zeroReaction.verdict.rationale}`);
        } else if (zeroReaction.action === 'accept') {
          console.log(`[CHAT_LEADS] Agent Loop: ACCEPT (zero results → Tower approved)`);
        } else {
          console.log(`[CHAT_LEADS] Agent Loop: ${zeroReaction.action} (zero results, planVersion=${zeroReaction.planVersion})`);
        }

        console.log(`[ARTEFACT_COUNT] runId=${chatRunId} artefacts_written=3+ types=[leads,leads_list,tower_judgement,run_summary] verdict=${zeroVerdict}`);

        return {
          response: `I searched for ${businessType} businesses in ${city}, but didn't find any results. Would you like to try a different location or business type?`,
          leadIds: []
        };
      }

      logToolCallCompleted(
        task.user_id, chatRunId, 'SEARCH_PLACES',
        { summary: `Found ${businesses.length} places for "${businessType}" in ${city}`, places_count: businesses.length },
        conversationId
      ).catch(() => {});

      // Generate leads for top 3 businesses
      const leadsToCreate = businesses.slice(0, 3);
      const createdLeads = [];

      for (const business of leadsToCreate) {
        // Find emails
        let emailCandidates: string[] = [];
        if (business.websiteUri) {
          try {
            const domain = new URL(business.websiteUri).hostname.replace('www.', '');
            emailCandidates = await this.findEmails(domain);
          } catch (e) {
            // Skip email finding if domain extraction fails
          }
        }

        const rationale = this.generateRationale(
          { user_id: task.user_id, type: 'chat_request', payload: { searchQuery } },
          userContext,
          business,
          businessType,
          city
        );

        const score = this.calculateLeadScore(userContext, business, businessType);

        const lead = {
          userId: task.user_id,
          rationale,
          source: 'supervisor_chat',
          score,
          lead: {
            name: business.displayName?.text || 'Unknown Business',
            address: business.formattedAddress || `${city}, ${country}`,
            place_id: business.id || '',
            domain: business.websiteUri || '',
            emailCandidates,
            tags: [businessType, 'chat_request'],
            phone: business.nationalPhoneNumber || business.internationalPhoneNumber || ''
          }
        };

        const createdLead = await storage.createSuggestedLead(lead);
        createdLeads.push(createdLead);
      }

      // Format response
      const leadSummaries = createdLeads.map((lead, idx) => {
        const scorePercent = (lead.score * 100).toFixed(0);
        const leadData = lead.lead as any;
        const emails = leadData.emailCandidates?.length > 0
          ? `\n   📧 ${leadData.emailCandidates.join(', ')}`
          : '\n   📧 No email found';
        
        return `${idx + 1}. **${leadData.name}** (${scorePercent}% match)
   📍 ${leadData.address}
   🌐 ${leadData.domain || 'No website'}${emails}
   📞 ${leadData.phone || 'No phone'}`;
      }).join('\n\n');

      const response = `🎯 I found ${createdLeads.length} ${businessType} prospects in ${city}:

${leadSummaries}

💡 **Why these matches:**
${createdLeads[0].rationale}

You can view detailed profiles and contact info in your [dashboard](/leads).`;

      const normalizedLeads = createdLeads.map(l => {
        const ld = l.lead as any;
        return {
          name: ld.name || 'Unknown',
          address: ld.address || '',
          phone: ld.phone || null,
          website: ld.domain || null,
          placeId: ld.place_id || '',
          source: 'google_places' as const,
          score: l.score ?? null,
        };
      });

      const successTitle = `${createdLeads.length} ${businessType} leads in ${city}`;
      const successSummary = `Found ${createdLeads.length} ${businessType} prospects in ${city}`;
      const postResult = await this.postArtefactToUI({
        runId: chatRunId,
        clientRequestId,
        type: 'leads',
        payload: {
          title: successTitle,
          summary: successSummary,
          leads: normalizedLeads,
          query: { businessType, location: city, country },
          tool: 'SEARCH_PLACES',
        },
        userId: task.user_id,
        conversationId,
      });

      console.log(`[LEADS_ARTEFACT] uiRunId=${chatRunId} crid=${clientRequestId} count=${normalizedLeads.length} posted=${postResult.ok} status=${postResult.httpStatus ?? 0}`);

      if (postResult.ok) {
        logAFREvent({
          userId: task.user_id, runId: chatRunId, conversationId,
          clientRequestId,
          actionTaken: 'artefact_created', status: 'success',
          taskGenerated: `Artefact created: ${successTitle}`,
          runType: 'plan', metadata: { artefactType: 'leads', title: successTitle, artefactId: postResult.artefactId },
        }).catch(() => {});
      }

      const deliveredCount = createdLeads.length;
      const agentLoopGoal = `Find ${requestedCount} ${businessType} in ${city}`;

      let artefactTypesWritten = ['leads'];
      let finalVerdict = 'PENDING';

      try {
        const leadsListArtefact = await createArtefact({
          runId: chatRunId,
          type: 'leads_list',
          title: `Leads list: ${businessType} in ${city}`,
          summary: `Delivered ${deliveredCount} of ${requestedCount} requested for "${businessType}" in ${city}`,
          payload: {
            delivered_count: deliveredCount,
            target_count: requestedCount,
            success_criteria: { target_count: requestedCount },
            query: businessType,
            location: city,
            country,
            leads: normalizedLeads,
          },
          userId: task.user_id,
          conversationId,
        });
        artefactTypesWritten.push('leads_list');

        console.log(`[AGENT_LOOP] tool=SEARCH_PLACES target=${requestedCount} delivered=${deliveredCount}`);

        {
          await logAFREvent({
            userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
            actionTaken: 'tower_call_started', status: 'pending',
            taskGenerated: `Calling Tower to judge leads_list artefact ${leadsListArtefact.id}`,
            runType: 'plan',
            metadata: { artefactId: leadsListArtefact.id, goal: agentLoopGoal },
          });
          console.log(`[CHAT_LEADS] [tower_call_started] artefactId=${leadsListArtefact.id}`);

          let towerResult;
          try {
            towerResult = await judgeArtefact({
              artefact: leadsListArtefact,
              runId: chatRunId,
              goal: agentLoopGoal,
              userId: task.user_id,
              conversationId,
              successCriteria: { target_leads: requestedCount },
            });
          } catch (towerErr: any) {
            const errMsg = towerErr.message || 'Tower call threw an exception';
            console.error(`[CHAT_LEADS] Tower call failed: ${errMsg}`);

            const errorJudgementArtefact = await createArtefact({
              runId: chatRunId,
              type: 'tower_judgement',
              title: `Tower Judgement: error`,
              summary: `Tower unreachable/failed: ${errMsg}`,
              payload: { verdict: 'error', action: 'stop', reasons: [errMsg], metrics: {}, delivered: deliveredCount, requested: requestedCount, error: errMsg },
              userId: task.user_id,
              conversationId,
            });
            artefactTypesWritten.push('tower_judgement');

            await this.postArtefactToUI({
              runId: chatRunId,
              clientRequestId,
              type: 'tower_judgement',
              payload: {
                verdict: 'error',
                action: 'stop',
                reasons: [errMsg],
                metrics: {},
                delivered: deliveredCount,
                requested: requestedCount,
                error: errMsg,
              },
              userId: task.user_id,
              conversationId,
            }).catch(() => {});

            await logAFREvent({
              userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
              actionTaken: 'tower_verdict', status: 'failed',
              taskGenerated: `Tower error: ${errMsg}`,
              runType: 'plan',
              metadata: { artefactId: leadsListArtefact.id, verdict: 'error', error: errMsg, towerJudgementArtefactId: errorJudgementArtefact.id },
            });

            await logAFREvent({
              userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
              actionTaken: 'run_stopped', status: 'failed',
              taskGenerated: `Chat run stopped: Tower error — ${errMsg}`,
              runType: 'plan', metadata: { leads_count: deliveredCount, error: errMsg },
            });

            finalVerdict = 'error';
            console.log(`[ARTEFACT_COUNT] runId=${chatRunId} artefacts_written=${artefactTypesWritten.length} types=[${artefactTypesWritten.join(',')}] verdict=${finalVerdict}`);
            return { response, leadIds: createdLeads.map(l => l.id) };
          }

          const verdict = towerResult.judgement.verdict;
          const action = towerResult.judgement.action;
          console.log(`[CHAT_LEADS] [tower_judgement] verdict=${verdict} action=${action} stubbed=${towerResult.stubbed}`);

          const towerJudgementArtefact = await createArtefact({
            runId: chatRunId,
            type: 'tower_judgement',
            title: `Tower Judgement: ${verdict}`,
            summary: `Verdict: ${verdict} | Action: ${action} | Delivered: ${deliveredCount} of ${requestedCount}`,
            payload: {
              verdict,
              action,
              reasons: towerResult.judgement.reasons,
              metrics: towerResult.judgement.metrics,
              delivered: deliveredCount,
              requested: requestedCount,
              artefact_id: leadsListArtefact.id,
              stubbed: towerResult.stubbed,
            },
            userId: task.user_id,
            conversationId,
          });
          artefactTypesWritten.push('tower_judgement');
          console.log(`[CHAT_LEADS] [tower_judgement_artefact] id=${towerJudgementArtefact.id}`);

          await this.postArtefactToUI({
            runId: chatRunId,
            clientRequestId,
            type: 'tower_judgement',
            payload: {
              verdict,
              action,
              reasons: towerResult.judgement.reasons,
              metrics: towerResult.judgement.metrics,
              delivered: deliveredCount,
              requested: requestedCount,
              artefact_id: leadsListArtefact.id,
              stubbed: towerResult.stubbed,
            },
            userId: task.user_id,
            conversationId,
          }).catch(() => {});

          await logAFREvent({
            userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
            actionTaken: 'tower_verdict', status: towerResult.shouldStop ? 'failed' : 'success',
            taskGenerated: `Tower verdict: ${verdict} — action: ${action}`,
            runType: 'plan',
            metadata: {
              verdict, action,
              artefactId: leadsListArtefact.id,
              towerJudgementArtefactId: towerJudgementArtefact.id,
              delivered: deliveredCount, requested: requestedCount,
              reasons: towerResult.judgement.reasons, stubbed: towerResult.stubbed,
            },
          });

          finalVerdict = verdict;

          const isHalted = towerResult.shouldStop || verdict === 'error' || verdict === 'fail';
          if (isHalted) {
            await logAFREvent({
              userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
              actionTaken: 'run_stopped', status: 'failed',
              taskGenerated: `Chat run stopped: Tower ${verdict}`,
              runType: 'plan', metadata: { verdict, action, leads_count: deliveredCount },
            });
            console.log(`[CHAT_LEADS] [run_stopped] verdict=${verdict}`);
          } else {
            await logAFREvent({
              userId: task.user_id, runId: chatRunId, conversationId, clientRequestId,
              actionTaken: 'run_completed', status: 'success',
              taskGenerated: `Chat run completed: ${deliveredCount} leads, verdict=${verdict}`,
              runType: 'plan', metadata: { verdict, action, leads_count: deliveredCount },
            });
            console.log(`[CHAT_LEADS] [run_completed] verdict=${verdict} leads=${deliveredCount}`);
          }
        }
      } catch (agentLoopErr: any) {
        console.error(`[CHAT_LEADS] Agent loop failed (continuing): ${agentLoopErr.message}`);
        finalVerdict = 'AGENT_LOOP_ERROR';

        try {
          await createArtefact({
            runId: chatRunId,
            type: 'run_summary',
            title: `Run Summary: AGENT_LOOP_ERROR`,
            summary: `Agent loop failed: ${agentLoopErr.message}. Delivered ${deliveredCount} of ${requestedCount} requested.`,
            payload: {
              verdict: 'AGENT_LOOP_ERROR',
              delivered: deliveredCount,
              requested: requestedCount,
              query: businessType,
              location: city,
              country,
              error: agentLoopErr.message,
            },
            userId: task.user_id,
            conversationId,
          });
          artefactTypesWritten.push('run_summary');
        } catch (summaryErr: any) {
          console.error(`[CHAT_LEADS] Failed to create run_summary after agent loop error: ${summaryErr.message}`);
        }

        logAFREvent({
          userId: task.user_id, runId: chatRunId, conversationId,
          clientRequestId,
          actionTaken: 'run_stopped', status: 'failed',
          taskGenerated: `Chat run STOPPED: agent loop error — ${agentLoopErr.message}`,
          runType: 'plan', metadata: { leads_count: deliveredCount, tool: 'SEARCH_PLACES', target_count: requestedCount, error: agentLoopErr.message },
        }).catch(() => {});
      }

      console.log(`[ARTEFACT_COUNT] runId=${chatRunId} artefacts_written=${artefactTypesWritten.length} types=[${artefactTypesWritten.join(',')}] verdict=${finalVerdict}`);

      return {
        response,
        leadIds: createdLeads.map(l => l.id)
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('Error generating leads for chat:', error);
      logToolCallFailed(
        task.user_id, chatRunId, 'SEARCH_PLACES',
        errMsg,
        conversationId
      ).catch(() => {});

      const errTitle = `0 ${businessType} leads in ${city} (error)`;
      const errPostResult = await this.postArtefactToUI({
        runId: chatRunId,
        clientRequestId,
        type: 'leads',
        payload: {
          title: errTitle,
          summary: `SEARCH_PLACES failed: ${errMsg}`,
          leads: [],
          query: { businessType, location: city, country },
          tool: 'SEARCH_PLACES',
        },
        userId: task.user_id,
        conversationId,
      });

      console.log(`[LEADS_ARTEFACT] uiRunId=${chatRunId} crid=${clientRequestId} count=0 posted=${errPostResult.ok} status=${errPostResult.httpStatus ?? 0}`);

      if (errPostResult.ok) {
        logAFREvent({
          userId: task.user_id, runId: chatRunId, conversationId,
          clientRequestId,
          actionTaken: 'artefact_created', status: 'success',
          taskGenerated: `Artefact created: ${errTitle}`,
          runType: 'plan', metadata: { artefactType: 'leads', title: errTitle, artefactId: errPostResult.artefactId },
        }).catch(() => {});
      }

      try {
        await createArtefact({
          runId: chatRunId,
          type: 'run_summary',
          title: `Run Summary: ERROR`,
          summary: `SEARCH_PLACES failed: ${errMsg}. Delivered 0 of ${requestedCount} requested.`,
          payload: {
            verdict: 'ERROR',
            delivered: 0,
            requested: requestedCount,
            query: businessType,
            location: city,
            country,
            error: errMsg,
          },
          userId: task.user_id,
          conversationId,
        });
      } catch (summaryErr: any) {
        console.error(`[CHAT_LEADS] Failed to create run_summary for error: ${summaryErr.message}`);
      }

      console.log(`[ARTEFACT_COUNT] runId=${chatRunId} artefacts_written=${errPostResult.ok ? 2 : 1} types=[leads,run_summary] verdict=ERROR`);

      logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId,
        clientRequestId,
        actionTaken: 'run_stopped', status: 'failed',
        taskGenerated: `Chat run STOPPED: SEARCH_PLACES error — ${errMsg}`,
        runType: 'plan', metadata: { leads_count: 0, tool: 'SEARCH_PLACES', error: errMsg },
      }).catch(() => {});

      return {
        response: `I encountered an issue while searching for ${businessType} in ${city}. Let me try again in a moment!`,
        leadIds: []
      };
    }
  }

  private async executeDeepResearchForChat(
    task: SupervisorTask,
    chatRunId: string,
    clientRequestId: string
  ): Promise<{ response: string }> {
    const requestData = task.request_data;
    const conversationId = task.conversation_id;
    const topic = requestData.deep_research?.topic || requestData.user_message || '';
    const prompt = requestData.deep_research?.prompt || topic;

    logAFREvent({
      userId: task.user_id, runId: chatRunId, conversationId,
      clientRequestId,
      actionTaken: 'deep_research_started', status: 'pending',
      taskGenerated: `Deep research started: "${topic}"`,
      runType: 'plan', metadata: { tool: 'DEEP_RESEARCH', topic },
    }).catch(() => {});

    console.log(`[DEEP_RESEARCH] uiRunId=${chatRunId} crid=${clientRequestId} status=started topic="${topic}"`);

    let reportMarkdown = '';
    let sources: Array<{ title: string; url: string }> = [];
    let researchError: string | undefined;
    let artefactTitle = '';
    let artefactSummary = '';
    const provider = createResearchProvider();
    const providerName = provider.name;

    try {
      logToolCallStarted(
        task.user_id, chatRunId, 'DEEP_RESEARCH',
        { topic, prompt, provider: providerName },
        conversationId
      ).catch(() => {});

      const result = await provider.research(topic, prompt);
      reportMarkdown = result.report_markdown;
      sources = result.sources;
      artefactTitle = result.title;
      artefactSummary = result.summary;

      logToolCallCompleted(
        task.user_id, chatRunId, 'DEEP_RESEARCH',
        { summary: `Deep research completed for "${topic}"`, provider: providerName, reportChars: reportMarkdown.length, sourcesCount: sources.length },
        conversationId
      ).catch(() => {});
    } catch (err: any) {
      researchError = err.message || 'Deep research execution failed';
      console.error(`[DEEP_RESEARCH] uiRunId=${chatRunId} crid=${clientRequestId} provider=${providerName} EXCEPTION: ${researchError}`);
      logToolCallFailed(
        task.user_id, chatRunId, 'DEEP_RESEARCH',
        researchError!,
        conversationId
      ).catch(() => {});
    }

    const status = researchError ? 'failed' : 'completed';
    if (researchError) {
      artefactTitle = `Deep research failed: "${topic}"`;
      artefactSummary = `DEEP_RESEARCH failed: ${researchError}`;
    }

    const postResult = await this.postArtefactToUI({
      runId: chatRunId,
      clientRequestId,
      type: 'deep_research_result',
      payload: {
        title: artefactTitle,
        summary: artefactSummary,
        report_markdown: reportMarkdown,
        sources,
        status,
        topic,
        tool: 'DEEP_RESEARCH',
        provider: providerName,
        ...(researchError ? { error: researchError } : {}),
      },
      userId: task.user_id,
      conversationId,
    });

    console.log(`[DEEP_RESEARCH] uiRunId=${chatRunId} crid=${clientRequestId} provider=${providerName} status=${status} reportChars=${reportMarkdown.length} sourcesCount=${sources.length} posted=${postResult.ok} artefactId=${postResult.artefactId || 'none'}`);

    if (postResult.ok) {
      logAFREvent({
        userId: task.user_id, runId: chatRunId, conversationId,
        clientRequestId,
        actionTaken: 'artefact_created', status: 'success',
        taskGenerated: `Artefact created: ${artefactTitle}`,
        runType: 'plan', metadata: { artefactType: 'deep_research_result', title: artefactTitle, artefactId: postResult.artefactId },
      }).catch(() => {});

      if (researchError) {
        logAFREvent({
          userId: task.user_id, runId: chatRunId, conversationId,
          clientRequestId,
          actionTaken: 'deep_research_failed', status: 'failed',
          taskGenerated: `Deep research failed: ${researchError}`,
          runType: 'plan', metadata: { tool: 'DEEP_RESEARCH', error: researchError },
        }).catch(() => {});
      } else {
        logAFREvent({
          userId: task.user_id, runId: chatRunId, conversationId,
          clientRequestId,
          actionTaken: 'deep_research_completed', status: 'success',
          taskGenerated: `Deep research completed: "${topic}"`,
          runType: 'plan', metadata: { tool: 'DEEP_RESEARCH', artefactId: postResult.artefactId, reportChars: reportMarkdown.length, sourcesCount: sources.length },
        }).catch(() => {});

        logRunCompleted(
          task.user_id, chatRunId,
          `Deep research complete: "${topic}"`,
          { tool: 'DEEP_RESEARCH', topic, reportChars: reportMarkdown.length, sourcesCount: sources.length },
          conversationId
        ).catch(() => {});
      }
    }

    const responseText = researchError
      ? `I ran into an issue with the deep research on "${topic}": ${researchError}. Would you like me to try again?`
      : `Here are the results of my deep research on "${topic}":\n\n${reportMarkdown.substring(0, 1500)}${reportMarkdown.length > 1500 ? '\n\n_(Full report available in your artefacts)_' : ''}`;

    return { response: responseText };
  }

  private async analyzeConversation(
    task: SupervisorTask,
    userContext: UserContext,
    conversationContext: Array<{ role: string; content: string }>
  ): Promise<string> {
    // Extract key insights from conversation
    const userMessages = conversationContext.filter(m => m.role === 'user');
    const recentTopics = userMessages.slice(-5).map(m => m.content).join('\n');

    const insights = [];

    if (userContext.profile?.companyName) {
      insights.push(`📊 **Your Company:** ${userContext.profile.companyName}`);
    }

    if (userContext.profile?.primaryObjective) {
      insights.push(`🎯 **Primary Goal:** ${userContext.profile.primaryObjective}`);
    }

    if (userContext.facts.length > 0) {
      const topFacts = userContext.facts.slice(0, 3);
      insights.push(`💡 **Key Insights:**\n${topFacts.map(f => `   • ${f.fact}`).join('\n')}`);
    }

    if (userContext.monitors.length > 0) {
      insights.push(`🔍 **Active Monitors:** ${userContext.monitors.length} running`);
    }

    return `📈 **Conversation Analysis:**

${insights.join('\n\n')}

**Recent Topics:**
${recentTopics}

Would you like me to find leads based on any of these insights?`;
  }

  private async provideInsights(
    task: SupervisorTask,
    userContext: UserContext
  ): Promise<string> {
    const insights = [];

    if (userContext.facts.length > 0) {
      insights.push(`💡 Based on our conversations, I've learned ${userContext.facts.length} key things about your business needs.`);
    }

    if (userContext.monitors.length > 0) {
      insights.push(`🔍 You have ${userContext.monitors.length} active monitors tracking opportunities.`);
    }

    if (userContext.profile?.targetMarkets && userContext.profile.targetMarkets.length > 0) {
      insights.push(`🎯 Your target markets: ${userContext.profile.targetMarkets.join(', ')}`);
    }

    return insights.length > 0
      ? insights.join('\n\n') + '\n\nWant me to find leads in any specific area?'
      : "I'm still learning about your business! Tell me more about what you're looking for.";
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
