import { supabase } from './supabase';
import { storage } from './storage';
import { emailService } from './notifications/email-service';
import type { SupervisorTask, SupervisorMessage, TaskResult } from './types/supervisor-chat';
import { randomUUID } from 'crypto';
import { monitorGoalsOnce, publishGoalMonitorEvents } from './goal-monitoring';
import { logAFREvent, logMissionReceived, logRunCompleted, logRouterDecision, logToolCallStarted, logToolCallCompleted, logToolCallFailed } from './supervisor/afr-logger';

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

    console.log(`[SUPERVISOR] Processing chat task ${task.id} (${task.task_type}) uiRunId=${uiRunId} clientRequestId=${clientRequestId}`);

    logMissionReceived(
      task.user_id, uiRunId, task.id, task.task_type, task.conversation_id
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

    // Generate response based on task type
    let response: string;
    let leadIds: string[] = [];
    let capabilities: string[] = [];

    switch (task.task_type) {
      case 'generate_leads':
      case 'find_prospects':
        const result = await this.generateLeadsForChat(task, userContext, conversationContext, uiRunId, clientRequestId);
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

      default:
        response = "I'm not sure how to help with that request yet. Let me know if you'd like me to find leads or analyze your conversation!";
        capabilities = [];
    }

    // Write response to messages table as Supervisor message
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

    // Mark task as completed
    await supabase
      .from('supervisor_tasks')
      .update({
        status: 'completed',
        result: {
          message_id: newMessage.id,
          lead_ids: leadIds,
          capabilities_used: capabilities
        }
        // processed_at omitted - uses database DEFAULT
      })
      .eq('id', task.id);
  }

  private async postArtefactToUI(params: {
    runId: string;
    clientRequestId?: string;
    type: string;
    title: string;
    summary: string;
    leads: Array<Record<string, unknown>>;
    query: Record<string, unknown>;
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
          payload: {
            title: params.title,
            summary: params.summary,
            leads: params.leads,
            query: params.query,
            tool: 'SEARCH_PLACES',
          },
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

    if (!businessType && requestData.user_message) {
      const msg = (requestData.user_message as string).trim();
      const inMatch = msg.match(/\s+in\s+(.+)$/i);
      if (inMatch) {
        location = inMatch[1].trim();
        businessType = msg.replace(/^find\s+/i, '').replace(/\s+in\s+.+$/i, '').trim() || undefined;
      } else {
        businessType = msg.replace(/^find\s+/i, '').trim() || undefined;
      }
      console.log(`[CHAT_LEADS] user_message fallback: parsed businessType="${businessType}" location="${location}" from "${msg}"`);
    }

    if (!businessType) {
      logRunCompleted(
        task.user_id, chatRunId,
        `Chat run skipped: no business type provided`,
        { leads_count: 0, tool: 'SEARCH_PLACES', reason: 'missing_business_type' },
        conversationId
      ).catch(() => {});

      return {
        response: "I'd be happy to find leads for you! Could you tell me what type of businesses you're looking for?",
        leadIds: []
      };
    }

    if (!location) location = 'Local';
    const city = location.split(',')[0].trim();
    const country = location.split(',')[1]?.trim() || 'UK';

    console.log(`🔍 Chat request: ${businessType} in ${city}, ${country}`);

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
      const businesses = await this.searchGooglePlaces(businessType, city, country);

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
          title: artefactTitle,
          summary: artefactSummary,
          leads: [],
          query: { businessType, location: city, country },
          userId: task.user_id,
          conversationId,
        });

        if (postResult.ok) {
          logAFREvent({
            userId: task.user_id, runId: chatRunId, conversationId,
            clientRequestId,
            actionTaken: 'artefact_created', status: 'success',
            taskGenerated: `Artefact created: ${artefactTitle}`,
            runType: 'plan', metadata: { artefactType: 'leads', title: artefactTitle, artefactId: postResult.artefactId },
          }).catch(() => {});

          logRunCompleted(
            task.user_id, chatRunId,
            `Chat run complete: 0 ${businessType} leads in ${city}`,
            { leads_count: 0, tool: 'SEARCH_PLACES' },
            conversationId
          ).catch(() => {});
        }

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
        title: successTitle,
        summary: successSummary,
        leads: normalizedLeads,
        query: { businessType, location: city, country },
        userId: task.user_id,
        conversationId,
      });

      if (postResult.ok) {
        logAFREvent({
          userId: task.user_id, runId: chatRunId, conversationId,
          clientRequestId,
          actionTaken: 'artefact_created', status: 'success',
          taskGenerated: `Artefact created: ${successTitle}`,
          runType: 'plan', metadata: { artefactType: 'leads', title: successTitle, artefactId: postResult.artefactId },
        }).catch(() => {});

        logRunCompleted(
          task.user_id, chatRunId,
          `Chat run complete: ${createdLeads.length} ${businessType} leads in ${city}`,
          { leads_count: createdLeads.length, tool: 'SEARCH_PLACES' },
          conversationId
        ).catch(() => {});
      }

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
        title: errTitle,
        summary: `SEARCH_PLACES failed: ${errMsg}`,
        leads: [],
        query: { businessType, location: city, country },
        userId: task.user_id,
        conversationId,
      });

      if (errPostResult.ok) {
        logAFREvent({
          userId: task.user_id, runId: chatRunId, conversationId,
          clientRequestId,
          actionTaken: 'artefact_created', status: 'success',
          taskGenerated: `Artefact created: ${errTitle}`,
          runType: 'plan', metadata: { artefactType: 'leads', title: errTitle, artefactId: errPostResult.artefactId },
        }).catch(() => {});

        logRunCompleted(
          task.user_id, chatRunId,
          `Chat run failed: ${errMsg}`,
          { leads_count: 0, tool: 'SEARCH_PLACES', error: errMsg },
          conversationId
        ).catch(() => {});
      }

      return {
        response: `I encountered an issue while searching for ${businessType} in ${city}. Let me try again in a moment!`,
        leadIds: []
      };
    }
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

  private async searchGooglePlaces(industry: string, city: string, country: string): Promise<any[]> {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_PLACES_API_KEY not configured');
    }

    // Map industry to search query
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
      maxResultCount: 3
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
