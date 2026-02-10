import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertUserSignalSchema, insertSuggestedLeadSchema } from "./schema";
import { fromError } from "zod-validation-error";
import { supabase } from "./supabase";
import { supervisor } from "./supervisor";
import { 
  planLeadGenerationWithHistory,
  executeLeadGenerationPlan,
  type LeadGenGoal,
  type LeadGenContext,
  type LeadGenPlan,
  type SupervisorUserContext
} from "./types/lead-gen-plan";
import { 
  startPlanProgress,
  updateStepStatus,
  completePlan,
  failPlan,
  getProgress 
} from "./plan-progress";
import { runFeature } from "./services/FeatureRunner";
import type { FeatureType } from "./features/types";
import { 
  saveLead as saveLeadToStore, 
  listSavedLeads,
  type IncomingLeadPayload,
  type SaveLeadResponse,
  type ListLeadsResponse
} from "./features/saveLead";
import { planExecutionRouter } from "./supervisor/plan-execution";
import { jobsRouter } from "./supervisor/jobs-router";

const SUPERVISOR_EXECUTION_ENABLED = process.env.SUPERVISOR_EXECUTION_ENABLED === 'true';

// Helper to get userId from request (simple version for MVP)
function getUserId(req: any): string {
  // Priority: body.userId > query.user_id > default demo user
  return req.body?.userId || req.query?.user_id || "8f9079b3ddf739fb0217373c92292e91";
}

/**
 * Map legacy tool identifiers to canonical action types
 */
function mapToolToActionType(tool: string): string | undefined {
  const mapping: Record<string, string> = {
    'GOOGLE_PLACES_SEARCH': 'GLOBAL_DB',
    'HUNTER_DOMAIN_LOOKUP': 'EMAIL_FINDER',
    'HUNTER_ENRICH': 'EMAIL_FINDER',
    'EMAIL_SEQUENCE_SETUP': 'EMAIL_FINDER',
    'LEAD_LIST_SAVE': 'GLOBAL_DB',
    'MONITOR_SETUP': 'SCHEDULED_MONITOR'
  };
  
  return mapping[tool];
}

export async function registerRoutes(app: Express): Promise<Server> {
  // ========================================
  // SUPERVISOR PLAN EXECUTION (Feature-flagged)
  // ========================================
  app.use('/api/supervisor', planExecutionRouter);
  app.use('/api/supervisor/jobs', jobsRouter);
  console.log(`[ROUTES] Supervisor execution enabled: ${SUPERVISOR_EXECUTION_ENABLED}`);
  console.log(`[ROUTES] Registered: POST /api/supervisor/execute-plan`);
  console.log(`[ROUTES] Registered: POST /api/supervisor/jobs/start`);
  console.log(`[ROUTES] Registered: GET /api/supervisor/jobs/:jobId`);
  console.log(`[ROUTES] Registered: POST /api/supervisor/jobs/:jobId/cancel`);

  // ========================================
  // PLAN EXECUTION PIPELINE
  // ========================================

  // POST /api/plan/start - Create a new lead generation plan
  app.post("/api/plan/start", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { goal } = req.body;

      if (!goal) {
        return res.status(400).json({ error: "goal is required" });
      }

      // Parse the goal into structured format
      const leadGenGoal: LeadGenGoal = {
        rawGoal: goal.rawGoal || goal,
        targetRegion: goal.targetRegion,
        targetPersona: goal.targetPersona,
        volume: goal.volume,
        timing: goal.timing || "asap",
        preferredChannels: goal.preferredChannels || [],
        includeMonitoring: goal.includeMonitoring || false
      };

      // Get user's account ID from Supabase for multi-account isolation (if configured)
      let userData: { account_id?: string; email?: string } | null = null;
      if (supabase) {
        const result = await supabase
          .from('users')
          .select('account_id, email')
          .eq('id', userId)
          .single();
        userData = result.data;
      }

      const context: LeadGenContext = {
        userId,
        accountId: userData?.account_id,
        defaultRegion: goal.targetRegion || "UK",
        defaultCountry: "GB",
        defaultFromIdentityId: "default-identity"
      };

      console.log(`[PLAN API] Creating plan for goal: "${leadGenGoal.rawGoal}"`);

      // Generate plan using SUP-001 + SUP-012 (with historical context)
      const plan = await planLeadGenerationWithHistory(leadGenGoal, context);

      // Store plan in database
      await storage.createPlan({
        id: plan.id,
        userId,
        accountId: userData?.account_id,
        status: "pending_approval",
        planData: plan as any,
        goalText: leadGenGoal.rawGoal
      });

      console.log(`[PLAN API] Created plan ${plan.id} with ${plan.steps.length} steps`);

      res.json({ 
        planId: plan.id,
        plan: {
          id: plan.id,
          title: plan.title,
          steps: plan.steps.map(step => ({
            id: step.id,
            title: step.label || step.tool,
            tool: step.tool,
            dependsOn: step.dependsOn
          }))
        },
        status: "pending_approval" 
      });
    } catch (error: any) {
      console.error("[PLAN API] Error creating plan:", error);
      res.status(500).json({ error: error.message || "Failed to create plan" });
    }
  });

  // POST /api/plan/approve - Approve and execute a plan
  app.post("/api/plan/approve", async (req, res) => {
    const startTime = Date.now();
    const userId = getUserId(req);
    const { planId } = req.body;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[PLAN_APPROVE] RECEIVED REQUEST`);
    console.log(`  planId: ${planId}`);
    console.log(`  userId: ${userId}`);
    console.log(`  timestamp: ${new Date().toISOString()}`);
    console.log(`${'='.repeat(60)}\n`);

    try {
      if (!planId) {
        console.log(`[PLAN_APPROVE] ERROR: Missing planId`);
        return res.status(400).json({ error: "planId is required" });
      }

      // Retrieve plan from database
      console.log(`[PLAN_APPROVE] Retrieving plan ${planId} from database...`);
      const dbPlan = await storage.getPlan(planId);
      
      if (!dbPlan) {
        console.log(`[PLAN_APPROVE] ERROR: Plan ${planId} not found`);
        return res.status(404).json({ error: "Plan not found" });
      }

      console.log(`[PLAN_APPROVE] Found plan - status: ${dbPlan.status}, owner: ${dbPlan.userId}`);

      // Validate ownership
      if (dbPlan.userId !== userId) {
        console.log(`[PLAN_APPROVE] ERROR: User ${userId} not authorized for plan ${planId} (owner: ${dbPlan.userId})`);
        return res.status(403).json({ error: "Not authorized to approve this plan" });
      }

      // Check if already executed
      if (dbPlan.status !== "pending_approval") {
        console.log(`[PLAN_APPROVE] ERROR: Plan ${planId} already has status ${dbPlan.status}`);
        return res.status(400).json({ error: `Plan is already ${dbPlan.status}` });
      }

      const plan = dbPlan.planData as LeadGenPlan;
      console.log(`[PLAN_APPROVE] Plan ${planId} has ${plan.steps.length} steps`);

      // Get user context for execution
      console.log(`[PLAN_APPROVE] Fetching user context for ${userId}...`);
      let userData: { account_id?: string; email?: string } | null = null;
      if (supabase) {
        const result = await supabase
          .from('users')
          .select('email, account_id')
          .eq('id', userId)
          .single();
        userData = result.data;
      }

      const userContext: SupervisorUserContext = {
        userId,
        accountId: userData?.account_id,
        email: userData?.email || undefined
      };

      console.log(`[PLAN_APPROVE] User context: accountId=${userContext.accountId}, email=${userContext.email}`);

      // Update plan status to executing
      console.log(`[PLAN_APPROVE] Updating plan status to 'executing'...`);
      await storage.updatePlanStatus(planId, "executing");

      // Start progress tracking (use planId)
      console.log(`[PLAN_APPROVE] Starting progress tracking for plan ${planId}...`);
      startPlanProgress(plan.id, plan.id, plan.steps);

      // Execute plan - either via Supervisor or UI based on feature flag
      if (SUPERVISOR_EXECUTION_ENABLED) {
        console.log(`[PLAN_APPROVE] SUPERVISOR_EXECUTION_ENABLED=true - delegating to Supervisor`);
        
        const { startPlanExecutionAsync } = await import('./supervisor/plan-executor');
        startPlanExecutionAsync({
          planId: plan.id,
          userId,
          conversationId: undefined,
          goal: dbPlan.goalText || 'Lead generation',
          steps: plan.steps.map(step => ({
            id: step.id,
            type: step.type || 'search',
            label: step.label || step.tool,
            description: step.note
          })),
          toolMetadata: plan.steps[0]?.input ? {
            toolName: 'SEARCH_PLACES',
            toolArgs: plan.steps[0].input
          } : undefined
        });
      } else {
        console.log(`[PLAN_APPROVE] SUPERVISOR_EXECUTION_ENABLED=false - using UI executor`);
        const { startPlanExecution } = await import('./plan-executor');
        startPlanExecution(planId);
      }

      const elapsed = Date.now() - startTime;
      console.log(`\n${'='.repeat(60)}`);
      console.log(`[PLAN_APPROVE] SUCCESS - Execution kicked off`);
      console.log(`  planId: ${plan.id}`);
      console.log(`  status: executing`);
      console.log(`  elapsed: ${elapsed}ms`);
      console.log(`${'='.repeat(60)}\n`);

      res.json({ 
        planId: plan.id,
        status: "executing",
        message: "Plan approved and execution started"
      });
    } catch (error: any) {
      const elapsed = Date.now() - startTime;
      console.error(`\n${'='.repeat(60)}`);
      console.error(`[PLAN_APPROVE] EXCEPTION CAUGHT`);
      console.error(`  planId: ${planId}`);
      console.error(`  userId: ${userId}`);
      console.error(`  error: ${error.message || error}`);
      console.error(`  stack: ${error.stack || 'N/A'}`);
      console.error(`  elapsed: ${elapsed}ms`);
      console.error(`${'='.repeat(60)}\n`);
      
      res.status(500).json({ error: error.message || "Failed to approve plan" });
    }
  });

  // GET /api/plan/progress - Get current execution progress
  app.get("/api/plan/progress", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { planId } = req.query;

      let progress;
      if (planId) {
        // Get progress for specific plan
        progress = getProgress(planId as string);
      } else {
        // Get user's most recent plan progress
        const { getUserProgress } = await import("./plan-progress");
        progress = getUserProgress(userId);
      }

      if (!progress) {
        return res.json({ 
          status: "idle",
          message: "No active plan execution"
        });
      }

      // Format response for UI
      res.json({
        status: progress.overallStatus,
        planId: progress.planId,
        currentStepIndex: progress.currentStepIndex,
        totalSteps: progress.steps.length,
        steps: progress.steps.map(step => ({
          title: step.title,
          status: step.status,
          errorMessage: step.errorMessage,
          attempts: step.attempts
        })),
        updatedAt: progress.updatedAt
      });
    } catch (error: any) {
      console.error("[PLAN API] Error fetching progress:", error);
      res.status(500).json({ error: error.message || "Failed to fetch progress" });
    }
  });

  // GET /api/plan-status - Alias for UI compatibility (same as /api/plan/progress)
  app.get("/api/plan-status", async (req, res) => {
    console.log(`[PLAN_STATUS] Request received - query params:`, req.query);
    
    try {
      const { planId } = req.query;

      console.log(`[PLAN_STATUS] planId: ${planId}`);

      if (!planId) {
        console.log(`[PLAN_STATUS] No planId provided - returning idle status`);
        return res.json({ 
          hasActivePlan: false,
          status: "idle",
          message: "No planId provided"
        });
      }

      // Get progress for specific plan using planId
      console.log(`[PLAN_STATUS] Looking up progress for planId: ${planId}`);
      const progress = getProgress(planId as string);

      if (!progress) {
        console.log(`[PLAN_STATUS] No progress found - returning idle status`);
        return res.json({ 
          hasActivePlan: false,
          status: "idle",
          message: "No active plan execution"
        });
      }

      console.log(`[PLAN_STATUS] Found progress for plan ${progress.planId} - status: ${progress.overallStatus}, steps: ${progress.steps.length}`);

      // Fetch plan from database to get step results
      const dbPlan = await storage.getPlan(progress.planId);
      const planSteps = dbPlan?.planData?.steps || [];

      // Format response for UI
      const response = {
        hasActivePlan: true,
        status: progress.overallStatus,
        planId: progress.planId,
        currentStepIndex: progress.currentStepIndex,
        totalSteps: progress.steps.length,
        steps: progress.steps.map((step, index) => {
          const planStep = planSteps[index];
          return {
            id: step.id,
            title: step.title,
            status: step.status,
            type: planStep?.type || (planStep?.tool ? mapToolToActionType(planStep.tool) : undefined),
            errorMessage: step.errorMessage,
            attempts: step.attempts,
            resultSummary: planStep?.result?.summary || step.errorMessage || undefined
          };
        }),
        updatedAt: progress.updatedAt
      };

      console.log(`[PLAN_STATUS] Returning:`, JSON.stringify(response, null, 2));
      res.json(response);
    } catch (error: any) {
      console.error("[PLAN_STATUS] ERROR:", error);
      res.status(500).json({ error: error.message || "Failed to fetch plan status" });
    }
  });

  // ========================================
  // UNIFIED TOOL EXECUTION ENDPOINT
  // ========================================

  /**
   * POST /api/tools/execute
   * Unified tool execution endpoint
   * Executes tools via action registry
   */
  app.post("/api/tools/execute", async (req, res) => {
    try {
      const { tool, params = {}, userId, sessionId } = req.body;

      console.log(`[TOOLS_EXECUTE] Request received - tool: ${tool}`);

      if (!tool) {
        return res.status(400).json({
          ok: false,
          error: 'Missing required field: tool'
        });
      }

      // Map tool names to ActionTypes
      // Legacy tool names map to canonical action types
      const toolToActionMap: Record<string, string> = {
        'search_google_places': 'GLOBAL_DB',
        'deep_research': 'DEEP_RESEARCH',
        'email_finder': 'EMAIL_FINDER',
        'create_scheduled_monitor': 'SCHEDULED_MONITOR',
        'get_nudges': 'SCHEDULED_MONITOR',
        // Direct action type names also supported
        'GLOBAL_DB': 'GLOBAL_DB',
        'DEEP_RESEARCH': 'DEEP_RESEARCH',
        'EMAIL_FINDER': 'EMAIL_FINDER',
        'SCHEDULED_MONITOR': 'SCHEDULED_MONITOR'
      };

      const actionType = toolToActionMap[tool];

      if (!actionType) {
        console.log(`[TOOLS_EXECUTE] Unknown tool: ${tool}`);
        return res.status(400).json({
          ok: false,
          error: `Unknown tool: ${tool}. Supported tools: ${Object.keys(toolToActionMap).join(', ')}`
        });
      }

      console.log(`[TOOLS_EXECUTE] Mapped ${tool} -> ${actionType}`);

      // Import and execute via registry
      const { executeAction } = await import('./actions/registry');

      const result = await executeAction(actionType as any, {
        ...params,
        userId,
        sessionId: sessionId || `supervisor_${Date.now()}`
      });

      console.log(`[TOOLS_EXECUTE] ${tool} completed - success: ${result.success}`);

      // Return in UI-compatible format
      return res.status(200).json({
        ok: result.success,
        data: result.data,
        note: result.summary,
        error: result.error
      });

    } catch (error: any) {
      console.error('[TOOLS_EXECUTE] Error:', error);
      return res.status(500).json({
        ok: false,
        error: error.message || 'Internal server error'
      });
    }
  });

  // ========================================
  // EXISTING ENDPOINTS
  // ========================================

  app.post("/api/debug/simulate-chat-task", async (req, res) => {
    const { logAFREvent: logEvt, logMissionReceived, logRunCompleted, logRouterDecision, logToolCallStarted, logToolCallCompleted, logToolCallFailed } = await import('./supervisor/afr-logger');
    const { randomUUID } = await import('crypto');
    const { generateJobId } = await import('./supervisor/jobs');

    const goalText = (req.body?.goal as string) || (req.body?.user_message as string) || 'find pet shops kent';
    const simulateType = (req.body?.simulate_type as string) || 'leads';
    const userId = getUserId(req);
    const taskId = randomUUID();
    const conversationId = `sim_conv_${taskId.substring(0, 8)}`;
    const uiRunId = req.body?.run_id as string | undefined;
    const clientRequestId = req.body?.client_request_id as string | undefined;

    if (!uiRunId || !clientRequestId) {
      const missing = [!uiRunId && 'run_id', !clientRequestId && 'client_request_id'].filter(Boolean).join(', ');
      console.error(`[DEBUG] simulate-chat-task: missing required identifiers (${missing})`);
      await logEvt({
        userId, runId: uiRunId || 'unknown', conversationId,
        actionTaken: 'artefact_post_failed', status: 'failed',
        taskGenerated: `Artefact POST aborted: missing identifiers (${missing})`,
        runType: 'plan', metadata: { taskId, errorCode: 'missing_identifiers', missing },
      }).catch(() => {});
      return res.status(400).json({ ok: false, error: `Missing required identifiers: ${missing}`, taskId });
    }

    const chatRunId = generateJobId();
    console.log(`[ID_MAP] jobId=${chatRunId} uiRunId=${uiRunId} crid=${clientRequestId} taskId=${taskId} entry=simulate-chat-task`);

    const LEAD_FIND_VERBS = /\b(find|list|get|show|search|look\s*for|discover|locate)\b/i;
    const LEAD_FIND_VENUES = /\b(pubs?|bars?|venues?|breweries|brewery|taverns?|inns?|gastropubs?|freehouse|free\s+house|public\s+house|nightclubs?|clubs?|restaurants?|cafes?|coffee\s+shops?|hotels?|b&bs?|guest\s*houses?)\b/i;
    const LEAD_FIND_LOCATION = /\b(in|near|around|across|within|throughout)\s+[A-Za-z]/i;
    const DEEP_RESEARCH_KEYWORDS = /\b(research|investigate|analy[sz]e|summari[sz]e|summary|overview|report|sources|articles?|history|guide|best[- ]of\s+list)\b/i;
    const deepResearchOptInOnly = process.env.DEEP_RESEARCH_OPT_IN_ONLY !== 'false';

    const msgForDetection = goalText || '';
    const hasLeadVerb = LEAD_FIND_VERBS.test(msgForDetection);
    const hasVenue = LEAD_FIND_VENUES.test(msgForDetection);
    const hasLocation = LEAD_FIND_LOCATION.test(msgForDetection);
    const hasResearchKeyword = DEEP_RESEARCH_KEYWORDS.test(msgForDetection);
    const isLeadFind = hasLeadVerb && hasVenue && hasLocation;

    const matchedKeywords: string[] = [];
    if (hasLeadVerb) matchedKeywords.push('lead_verb');
    if (hasVenue) matchedKeywords.push('venue_type');
    if (hasLocation) matchedKeywords.push('location');
    if (hasResearchKeyword) {
      const researchMatch = msgForDetection.match(DEEP_RESEARCH_KEYWORDS);
      if (researchMatch) matchedKeywords.push(`research:${researchMatch[0].toLowerCase()}`);
    }

    let routeIntent: string;
    let routeChosenTool: string;
    let routeReason: string;

    let routerOverrideFired = false;

    if (isLeadFind) {
      routeIntent = 'lead_find';
      routeChosenTool = 'SEARCH_PLACES';
      routeReason = 'venue+location detected → SEARCH_PLACES';
      if (simulateType === 'deep_research') {
        console.log(`[LEAD_FIND_GUARD] Overriding simulate_type from deep_research → leads (venue+location detected in "${msgForDetection.substring(0, 80)}")`);
        routeReason += ` (override from deep_research)`;
        routerOverrideFired = true;
        await logEvt({
          userId, runId: chatRunId, conversationId,
          clientRequestId,
          actionTaken: 'router_override', status: 'success',
          taskGenerated: `Override: DEEP_RESEARCH → SEARCH_PLACES (lead_find priority)`,
          runType: 'plan',
          metadata: {
            original_tool: 'DEEP_RESEARCH',
            forced_tool: 'SEARCH_PLACES',
            reason: 'lead_find_priority',
            message: msgForDetection.substring(0, 200),
          },
        }).catch(() => {});
      }
    } else if (simulateType === 'deep_research' && (!deepResearchOptInOnly || hasResearchKeyword)) {
      routeIntent = 'deep_research';
      routeChosenTool = 'DEEP_RESEARCH';
      routeReason = 'explicit research keyword detected → DEEP_RESEARCH';
    } else if (simulateType === 'deep_research' && deepResearchOptInOnly && !hasResearchKeyword) {
      routeIntent = 'lead_find';
      routeChosenTool = 'SEARCH_PLACES';
      routeReason = 'deep_research_opt_in_only: no research keywords → forcing SEARCH_PLACES';
      console.log(`[DEEP_RESEARCH_GUARD] Blocking deep_research: no explicit research keywords in "${msgForDetection.substring(0, 80)}" → routing to SEARCH_PLACES (DEEP_RESEARCH_OPT_IN_ONLY=${deepResearchOptInOnly})`);
      routerOverrideFired = true;
      await logEvt({
        userId, runId: chatRunId, conversationId,
        clientRequestId,
        actionTaken: 'router_override', status: 'success',
        taskGenerated: `Override: DEEP_RESEARCH → SEARCH_PLACES (opt-in gate)`,
        runType: 'plan',
        metadata: {
          original_tool: 'DEEP_RESEARCH',
          forced_tool: 'SEARCH_PLACES',
          reason: 'deep_research_opt_in_only',
          message: msgForDetection.substring(0, 200),
        },
      }).catch(() => {});
    } else {
      routeIntent = simulateType || 'leads';
      routeChosenTool = simulateType === 'deep_research' ? 'DEEP_RESEARCH' : 'SEARCH_PLACES';
      routeReason = `simulate_type=${simulateType}`;
    }

    await logEvt({
      userId, runId: chatRunId, conversationId,
      clientRequestId,
      actionTaken: 'router_decision_detail', status: 'success',
      taskGenerated: `Intent classification: ${routeIntent} → ${routeChosenTool}`,
      runType: 'plan',
      metadata: {
        intent: routeIntent,
        chosen_tool: routeChosenTool,
        reason: routeReason,
        matched_keywords: matchedKeywords,
      },
    }).catch(() => {});

    const effectiveSimulateType = (routeChosenTool === 'DEEP_RESEARCH') ? 'deep_research' : 'leads';

    if (effectiveSimulateType === 'deep_research') {
      const topic = req.body?.topic || goalText;
      console.log(`[DEBUG] simulate-chat-task(deep_research): topic="${topic}" jobId=${chatRunId} uiRunId=${uiRunId} clientRequestId=${clientRequestId} taskId=${taskId}`);

      try {
        const { createResearchProvider } = await import('./supervisor/research-provider');

        await logMissionReceived(userId, chatRunId, taskId, 'deep_research', conversationId);

        await logEvt({
          userId, runId: chatRunId, conversationId,
          clientRequestId,
          actionTaken: 'deep_research_started', status: 'pending',
          taskGenerated: `Deep research started: "${topic}"`,
          runType: 'plan', metadata: { tool: 'DEEP_RESEARCH', topic },
        });

        await logToolCallStarted(userId, chatRunId, 'DEEP_RESEARCH', { topic }, conversationId);

        let reportMarkdown = '';
        let sources: Array<{ title: string; url: string }> = [];
        let artefactTitle = '';
        let artefactSummary = '';
        let researchStatus: 'completed' | 'failed' = 'completed';
        let researchError: string | undefined;

        const provider = createResearchProvider();
        const providerName = provider.name;

        try {
          const result = await provider.research(topic, topic);
          reportMarkdown = result.report_markdown;
          sources = result.sources;
          artefactTitle = result.title;
          artefactSummary = result.summary;
        } catch (provErr: any) {
          researchStatus = 'failed';
          researchError = provErr.message || 'Research provider error';
          artefactTitle = `Deep research failed: "${topic}"`;
          artefactSummary = `DEEP_RESEARCH failed: ${researchError}`;
        }

        if (researchError) {
          await logToolCallFailed(userId, chatRunId, 'DEEP_RESEARCH', researchError, conversationId);
        } else {
          await logToolCallCompleted(
            userId, chatRunId, 'DEEP_RESEARCH',
            { summary: `Deep research completed for "${topic}"`, provider: providerName, reportChars: reportMarkdown.length, sourcesCount: sources.length },
            conversationId
          );
        }

        const uiBaseUrl = (process.env.UI_URL || '').replace(/\/+$/, '');
        let artefactPosted = false;
        let artefactId: string | undefined;

        if (uiBaseUrl) {
          try {
            const postResp = await fetch(`${uiBaseUrl}/api/afr/artefacts`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                runId: chatRunId,
                clientRequestId,
                type: 'deep_research_result',
                payload: {
                  title: artefactTitle,
                  summary: artefactSummary,
                  report_markdown: reportMarkdown,
                  sources,
                  status: researchStatus,
                  topic,
                  tool: 'DEEP_RESEARCH',
                  provider: providerName,
                  ...(researchError ? { error: researchError } : {}),
                },
                createdAt: new Date().toISOString(),
              }),
            });
            const rawBody = await postResp.text();
            let json: any = {};
            try { json = JSON.parse(rawBody); } catch {}
            artefactId = json?.artefactId || json?.id || undefined;
            artefactPosted = postResp.ok && !!artefactId;

            console.log(`[ARTEFACT_POST] runId=${chatRunId} clientRequestId=${clientRequestId} status=${postResp.status} hasArtefactId=${!!artefactId}${artefactId ? ` artefactId=${artefactId}` : ''}`);

            if (artefactPosted) {
              await logEvt({
                userId, runId: chatRunId, conversationId, clientRequestId,
                actionTaken: 'artefact_post_succeeded', status: 'success',
                taskGenerated: `Artefact POST succeeded: artefactId=${artefactId}`,
                runType: 'plan', metadata: { runId: chatRunId, artefactId },
              }).catch(() => {});
            } else {
              await logEvt({
                userId, runId: chatRunId, conversationId, clientRequestId,
                actionTaken: 'artefact_post_failed', status: 'failed',
                taskGenerated: `Artefact POST failed: HTTP ${postResp.status}`,
                runType: 'plan', metadata: { runId: chatRunId, status: postResp.status },
              }).catch(() => {});
            }
          } catch (e: any) {
            console.error(`[ARTEFACT_POST] runId=${chatRunId} clientRequestId=${clientRequestId} NETWORK_ERROR: ${e.message}`);
          }
        }

        console.log(`[DEEP_RESEARCH] uiRunId=${chatRunId} crid=${clientRequestId} provider=${providerName} status=${researchStatus} reportChars=${reportMarkdown.length} sourcesCount=${sources.length} posted=${artefactPosted} artefactId=${artefactId || 'none'}`);

        if (artefactPosted) {
          await logEvt({
            userId, runId: chatRunId, conversationId, clientRequestId,
            actionTaken: 'artefact_created', status: 'success',
            taskGenerated: `Artefact created: ${artefactTitle}`,
            runType: 'plan', metadata: { artefactType: 'deep_research_result', title: artefactTitle, artefactId },
          });

          if (researchError) {
            await logEvt({
              userId, runId: chatRunId, conversationId, clientRequestId,
              actionTaken: 'deep_research_failed', status: 'failed',
              taskGenerated: `Deep research failed: ${researchError}`,
              runType: 'plan', metadata: { tool: 'DEEP_RESEARCH', error: researchError },
            });
          } else {
            await logEvt({
              userId, runId: chatRunId, conversationId, clientRequestId,
              actionTaken: 'deep_research_completed', status: 'success',
              taskGenerated: `Deep research completed: "${topic}"`,
              runType: 'plan', metadata: { tool: 'DEEP_RESEARCH', artefactId, reportChars: reportMarkdown.length, sourcesCount: sources.length },
            });

            await logRunCompleted(
              userId, chatRunId,
              `Deep research complete: "${topic}"`,
              { tool: 'DEEP_RESEARCH', topic, reportChars: reportMarkdown.length, sourcesCount: sources.length },
              conversationId
            );
          }
        }

        return res.json({
          ok: true,
          chatRunId,
          taskId,
          conversationId,
          clientRequestId,
          simulateType: 'deep_research',
          topic,
          provider: providerName,
          researchStatus,
          reportChars: reportMarkdown.length,
          sourcesCount: sources.length,
          artefactPosted,
          artefactId: artefactId || null,
          afrEvents: artefactPosted
            ? (researchError
              ? ['mission_received', 'router_decision_detail', 'deep_research_started', 'tool_call_started', 'tool_call_failed', 'artefact_post_succeeded', 'artefact_created', 'deep_research_failed']
              : ['mission_received', 'router_decision_detail', 'deep_research_started', 'tool_call_started', 'tool_call_completed', 'artefact_post_succeeded', 'artefact_created', 'deep_research_completed', 'run_completed'])
            : ['mission_received', 'router_decision_detail', 'deep_research_started', 'tool_call_started', researchError ? 'tool_call_failed' : 'tool_call_completed', 'artefact_post_failed'],
        });
      } catch (error: any) {
        console.error(`[DEBUG] simulate-chat-task(deep_research): error — ${error.message}`);
        return res.status(500).json({ ok: false, error: error.message, chatRunId });
      }
    }

    const locationMatch = goalText.match(/\s+in\s+(.+)$/i);
    const city = locationMatch ? locationMatch[1].trim() : 'Kent';
    let businessType = goalText.replace(/^find\s+/i, '').replace(/\s+in\s+.+$/i, '').trim() || 'pet shops';
    const countMatch = businessType.match(/^(\d+)\s+/);
    let requestedCount = 20;
    if (countMatch) {
      requestedCount = Math.min(parseInt(countMatch[1], 10), 200);
      businessType = businessType.replace(/^\d+\s*/, '').trim();
    }
    const country = 'UK';

    console.log(`[DEBUG] simulate-chat-task: goal="${goalText}" jobId=${chatRunId} uiRunId=${uiRunId} clientRequestId=${clientRequestId} taskId=${taskId}`);
    console.log(`[ROUTE_DECISION] intent=lead_find tool=SEARCH_PLACES reason="simulate-chat-task" businessType="${businessType}" location="${city}" count=${requestedCount}`);

    await logEvt({
      userId, runId: chatRunId, conversationId,
      clientRequestId,
      actionTaken: 'tool_dispatch_decision', status: 'success',
      taskGenerated: `Routing decision: SEARCH_PLACES for "${goalText.substring(0, 60)}"`,
      runType: 'plan',
      metadata: {
        intent: 'lead_find',
        requested_count: requestedCount,
        parsed_location: city,
        chosen_tool: 'SEARCH_PLACES',
        reason: 'simulate-chat-task: venue+location detected',
      },
    }).catch(() => {});

    try {
      await logMissionReceived(userId, chatRunId, taskId, 'find_prospects', conversationId);

      await logRouterDecision(
        userId, chatRunId, 'SEARCH_PLACES',
        `lead_find: searching "${businessType}" in ${city} via Google Places (target=${requestedCount})`,
        conversationId
      );

      await logToolCallStarted(
        userId, chatRunId, 'SEARCH_PLACES',
        { query: businessType, location: city, country },
        conversationId
      );

      const apiKey = process.env.GOOGLE_PLACES_API_KEY;
      let normalizedLeads: Array<{ name: string; address: string; phone: string | null; website: string | null; placeId: string; source: string; score: number | null }> = [];

      if (apiKey) {
        try {
          const url = 'https://places.googleapis.com/v1/places:searchText';
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.internationalPhoneNumber'
            },
            body: JSON.stringify({ textQuery: `${businessType} in ${city} ${country}`, maxResultCount: Math.min(requestedCount, 20) })
          });
          if (response.ok) {
            const data = await response.json();
            const places = data.places || [];
            normalizedLeads = places.map((p: any) => ({
              name: p.displayName?.text || 'Unknown',
              address: p.formattedAddress || '',
              phone: p.nationalPhoneNumber || p.internationalPhoneNumber || null,
              website: p.websiteUri || null,
              placeId: p.id || '',
              source: 'google_places',
              score: null,
            }));
          }
        } catch (e: any) {
          console.log(`[DEBUG] simulate-chat-task: Google Places call failed — ${e.message}`);
        }
      }

      const placesCount = normalizedLeads.length;

      await logToolCallCompleted(
        userId, chatRunId, 'SEARCH_PLACES',
        {
          summary: placesCount > 0
            ? `Found ${placesCount} places for "${businessType}" in ${city}`
            : `No results for "${businessType}" in ${city}`,
          places_count: placesCount,
          places: normalizedLeads.map(l => l.name),
        },
        conversationId
      );

      const artefactTitle = `${placesCount} ${businessType} leads in ${city}`;
      const artefactSummary = `SEARCH_PLACES returned ${placesCount} results for "${businessType}" in ${city}, ${country}`;
      const uiBaseUrl = (process.env.UI_URL || '').replace(/\/+$/, '');
      let artefactPosted = false;
      let artefactId: string | undefined;
      let postHttpStatus: number | undefined = 0;

      if (uiBaseUrl) {
        try {
          const postResp = await fetch(`${uiBaseUrl}/api/afr/artefacts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              runId: chatRunId,
              clientRequestId,
              type: 'leads',
              payload: {
                title: artefactTitle,
                summary: artefactSummary,
                leads: normalizedLeads,
                query: { businessType, location: city, country },
                tool: 'SEARCH_PLACES',
              },
              createdAt: new Date().toISOString(),
            }),
          });
          const rawBody = await postResp.text();
          let json: any = {};
          let hasBody = false;
          try { json = JSON.parse(rawBody); hasBody = true; } catch { hasBody = rawBody.length > 0; }
          postHttpStatus = postResp.status;
          artefactId = json?.artefactId || json?.id || undefined;
          const hasArtefactId = !!artefactId;

          console.log(`[ARTEFACT_POST] runId=${chatRunId} clientRequestId=${clientRequestId} status=${postResp.status} hasArtefactId=${hasArtefactId}${hasArtefactId ? ` artefactId=${artefactId}` : ''}`);

          artefactPosted = postResp.ok && hasArtefactId;

          if (artefactPosted) {
            await logEvt({
              userId, runId: chatRunId, conversationId,
              clientRequestId,
              actionTaken: 'artefact_post_succeeded', status: 'success',
              taskGenerated: `Artefact POST succeeded: artefactId=${artefactId}`,
              runType: 'plan', metadata: { runId: chatRunId, artefactId },
            }).catch(() => {});
          } else {
            await logEvt({
              userId, runId: chatRunId, conversationId,
              clientRequestId,
              actionTaken: 'artefact_post_failed', status: 'failed',
              taskGenerated: `Artefact POST failed: HTTP ${postResp.status}${!hasArtefactId ? ' (no artefactId in response)' : ''}`,
              runType: 'plan', metadata: { runId: chatRunId, status: postResp.status, hasBody, errorCode: json?.error || json?.code || null },
            }).catch(() => {});
          }
        } catch (e: any) {
          console.error(`[ARTEFACT_POST] runId=${chatRunId} clientRequestId=${clientRequestId} NETWORK_ERROR: ${e.message}`);
          await logEvt({
            userId, runId: chatRunId, conversationId,
            clientRequestId,
            actionTaken: 'artefact_post_failed', status: 'failed',
            taskGenerated: 'Artefact POST failed: network error',
            runType: 'plan', metadata: { runId: chatRunId, status: 0, hasBody: false, errorCode: 'network_error' },
          }).catch(() => {});
        }
      } else {
        console.error(`[ARTEFACT_POST] runId=${chatRunId} clientRequestId=${clientRequestId} UI_URL not set — cannot POST artefact to UI.`);
        await logEvt({
          userId, runId: chatRunId, conversationId,
          clientRequestId,
          actionTaken: 'artefact_post_failed', status: 'failed',
          taskGenerated: 'Artefact POST failed: UI_URL not configured',
          runType: 'plan', metadata: { runId: chatRunId, status: 0, hasBody: false, errorCode: 'ui_url_missing' },
        }).catch(() => {});
      }

      console.log(`[LEADS_ARTEFACT] uiRunId=${chatRunId} crid=${clientRequestId} count=${placesCount} posted=${artefactPosted} status=${postHttpStatus ?? 0}`);

      if (artefactPosted) {
        await logEvt({
          userId, runId: chatRunId, conversationId,
          clientRequestId,
          actionTaken: 'artefact_created', status: 'success',
          taskGenerated: `Artefact created: ${artefactTitle}`,
          runType: 'plan', metadata: { artefactType: 'leads', title: artefactTitle, artefactId },
        });
      }

      const { createArtefact: createLocalArtefact } = await import('./supervisor/artefacts');
      const { initRunState: initRS, handleTowerVerdict: handleTV, getRunState: getRS } = await import('./supervisor/agent-loop');
      const { executeAction: execAction } = await import('./supervisor/action-executor');

      let finalVerdict = 'PENDING';
      const afrEvents: string[] = ['mission_received', ...(routerOverrideFired ? ['router_override'] : []), 'router_decision_detail', 'tool_dispatch_decision', 'router_decision', 'tool_call_started', 'tool_call_completed'];

      if (artefactPosted) afrEvents.push('artefact_post_succeeded', 'artefact_created');
      else afrEvents.push('artefact_post_failed');

      try {
        const leadsListArtefact = await createLocalArtefact({
          runId: chatRunId,
          type: 'leads_list',
          title: `Leads list: ${businessType} in ${city}`,
          summary: `Delivered ${placesCount} of ${requestedCount} requested for "${businessType}" in ${city}`,
          payload: {
            delivered_count: placesCount,
            target_count: requestedCount,
            success_criteria: { target_count: requestedCount },
            query: businessType,
            location: city,
            country,
          },
          userId,
          conversationId,
        });
        afrEvents.push('leads_list');

        console.log(`[AGENT_LOOP] tool=SEARCH_PLACES target=${requestedCount} delivered=${placesCount}`);

        const toolArgs = { query: businessType, location: city, country, maxResults: requestedCount, target_count: requestedCount };
        if (!getRS(chatRunId)) {
          initRS(chatRunId, userId, toolArgs, conversationId);
        }

        const rerunTool = async (args: Record<string, unknown>) => {
          console.log(`[AGENT_LOOP] Re-running SEARCH_PLACES for simulate-chat with adjusted args`);
          return execAction({
            toolName: 'SEARCH_PLACES',
            toolArgs: args,
            userId,
            runId: chatRunId,
            conversationId,
            clientRequestId,
          });
        };

        const leadsListPayload = (leadsListArtefact.payloadJson as Record<string, unknown>) || {};
        const towerCriteria = { target_leads: requestedCount };
        const reaction = await handleTV(
          chatRunId,
          `Find ${requestedCount} ${businessType} in ${city}`,
          towerCriteria,
          { ...leadsListPayload, delivered_count: placesCount, target_count: requestedCount, leads_count: placesCount, artefact_id: leadsListArtefact.id, artefact_type: 'leads_list' },
          rerunTool,
        );

        finalVerdict = reaction.verdict.verdict;
        afrEvents.push('tower_call_started', 'tower_call_completed', 'tower_verdict', 'tower_judgement', 'run_summary');

        if (reaction.action === 'accept') {
          afrEvents.push('run_completed');
        } else if (reaction.action === 'stop') {
          afrEvents.push('run_stopped');
          console.log(`[DEBUG] simulate-chat-task: Agent Loop STOP — ${reaction.verdict.rationale}`);
        } else {
          afrEvents.push(`agent_loop_${reaction.action}`);
          console.log(`[DEBUG] simulate-chat-task: Agent Loop ${reaction.action} (planVersion=${reaction.planVersion})`);
        }
      } catch (agentLoopErr: any) {
        console.error(`[DEBUG] simulate-chat-task: Agent loop failed — ${agentLoopErr.message}`);
        finalVerdict = 'AGENT_LOOP_ERROR';

        try {
          await createLocalArtefact({
            runId: chatRunId,
            type: 'run_summary',
            title: `Run Summary: AGENT_LOOP_ERROR`,
            summary: `Agent loop failed: ${agentLoopErr.message}. Delivered ${placesCount} of ${requestedCount} requested.`,
            payload: {
              verdict: 'AGENT_LOOP_ERROR',
              delivered: placesCount,
              requested: requestedCount,
              query: businessType,
              location: city,
              country,
              error: agentLoopErr.message,
            },
            userId,
            conversationId,
          });
          afrEvents.push('run_summary');
        } catch (summaryErr: any) {
          console.error(`[DEBUG] simulate-chat-task: Failed to create run_summary after agent loop error: ${summaryErr.message}`);
        }

        await logEvt({
          userId, runId: chatRunId, conversationId,
          clientRequestId,
          actionTaken: 'run_stopped', status: 'failed',
          taskGenerated: `Simulate chat run STOPPED: agent loop error — ${agentLoopErr.message}`,
          runType: 'plan', metadata: { leads_count: placesCount, tool: 'SEARCH_PLACES', target_count: requestedCount, error: agentLoopErr.message },
        }).catch(() => {});
        afrEvents.push('run_stopped');
      }

      console.log(`[ARTEFACT_COUNT] runId=${chatRunId} artefacts_written=${afrEvents.filter(e => ['leads_list', 'run_summary', 'tower_judgement'].includes(e)).length + (artefactPosted ? 1 : 0)} verdict=${finalVerdict}`);

      res.json({
        ok: true,
        chatRunId,
        taskId,
        conversationId,
        clientRequestId,
        goal: goalText,
        businessType,
        location: `${city}, ${country}`,
        placesFound: placesCount,
        leads: normalizedLeads,
        artefactPosted,
        artefactId: artefactId || null,
        towerVerdict: finalVerdict,
        afrEvents,
      });
    } catch (error: any) {
      console.error(`[DEBUG] simulate-chat-task: error — ${error.message}`);
      await logToolCallFailed(userId, chatRunId, 'SEARCH_PLACES', error.message, conversationId).catch(() => {});
      res.status(500).json({ ok: false, error: error.message, chatRunId });
    }
  });

  // Test endpoint - create supervisor chat task
  app.post("/api/test/supervisor-task", async (req, res) => {
    const { userId, conversationId, taskType, searchQuery } = req.body;

    if (!userId || !conversationId || !taskType) {
      return res.status(400).json({ 
        error: 'userId, conversationId, and taskType are required' 
      });
    }

    try {
      // Create supervisor task in Supabase
      const { data: task, error } = await supabase
        .from('supervisor_tasks')
        .insert({
          conversation_id: conversationId,
          user_id: userId,
          task_type: taskType,
          request_data: {
            user_message: searchQuery?.message || 'Find leads',
            search_query: searchQuery || {}
          },
          status: 'pending',
          created_at: Date.now()
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      res.json({ 
        success: true, 
        task,
        message: 'Task created! Supervisor will process it within 30 seconds.' 
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Test endpoint - create signal in Supabase
  app.post("/api/test/signal-supabase", async (req, res) => {
    try {
      const userId = req.body.userId || "8f9079b3ddf739fb0217373c92292e91";
      const industry = req.body.industry || "dental clinic";
      const city = req.body.city || "Bristol";
      
      const { data, error } = await supabase
        .from('user_signals')
        .insert({
          user_id: userId,
          type: 'search_performed',
          payload: {
            userProfile: {
              userId,
              industry,
              location: {
                city,
                country: 'UK',
                radiusKm: 25
              },
              prefs: {
                targetAudience: 'dentists'
              }
            }
          }
        })
        .select();
      
      if (error) {
        return res.status(500).json({ error: error.message });
      }
      
      res.json({ success: true, signal: data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Debug endpoints - gated behind ENABLE_DEBUG_ENDPOINTS=true AND non-production
  const debugEndpointsEnabled = process.env.ENABLE_DEBUG_ENDPOINTS === 'true' && process.env.NODE_ENV !== 'production';
  
  if (debugEndpointsEnabled) {
    console.log('[DEBUG] Debug endpoints enabled at /api/debug/*');

    app.get("/api/debug/env", (_req, res) => {
      res.json({
        openaiKey: !!process.env.OPENAI_API_KEY,
        anthropicKey: !!process.env.ANTHROPIC_API_KEY,
        perplexityKey: !!process.env.PERPLEXITY_API_KEY,
        nodeEnv: process.env.NODE_ENV || 'unknown',
        buildTs: new Date().toISOString(),
      });
    });
    
    app.get("/api/debug/agent-activities", async (req, res) => {
      try {
        const { data, error } = await supabase
          .from('agent_activities')
          .select('id, user_id, action_taken, status, task_generated, run_id, metadata, timestamp')
          .order('timestamp', { ascending: false })
          .limit(20);
        
        if (error) {
          return res.status(500).json({ error: error.message });
        }
        
        res.json({ activities: data });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Debug endpoint - demo plan run
    // Runs a 5-step diverse plan through plan-executor.ts to prove AFR activity logging
    app.post("/api/debug/demo-plan-run", async (req, res) => {
      const { randomUUID } = await import('crypto');
      const { executePlan } = await import('./supervisor/plan-executor');

      if (process.env.NODE_ENV === 'production') {
        console.warn('[DEBUG] demo-plan-run called outside dev — this should never happen in production');
      }

      const clientRequestId = randomUUID();
      const runId = `demo_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
      const userId = getUserId(req);
      const goalText = 'Demo: search → enrich → score → evaluate lead-gen pipeline';

      console.log(`[DEBUG] demo-plan-run: clientRequestId=${clientRequestId}, runId=${runId}`);

      const steps = [
        {
          id: 'demo-search-1', type: 'SEARCH_PLACES', label: 'Search pubs in Kent',
          toolName: 'SEARCH_PLACES',
          toolArgs: { query: 'pubs', location: 'Kent', country: 'GB' },
        },
        {
          id: 'demo-search-2', type: 'SEARCH_PLACES', label: 'Search restaurants in Canterbury',
          toolName: 'SEARCH_PLACES',
          toolArgs: { query: 'restaurants', location: 'Canterbury', country: 'GB' },
        },
        {
          id: 'demo-enrich', type: 'ENRICH_LEADS', label: 'Enrich leads with detail data',
          toolName: 'ENRICH_LEADS',
          toolArgs: { query: 'pubs', location: 'Kent', country: 'GB', enrichType: 'detail' },
        },
        {
          id: 'demo-score', type: 'SCORE_LEADS', label: 'Score and rank leads',
          toolName: 'SCORE_LEADS',
          toolArgs: { query: 'pubs', location: 'Kent', country: 'GB', scoreModel: 'quality-v1' },
        },
        {
          id: 'demo-evaluate', type: 'EVALUATE_RESULTS', label: 'Evaluate pipeline results',
          toolName: 'EVALUATE_RESULTS',
          toolArgs: { totalSearched: 40, totalEnriched: 10, totalScored: 10, goalDescription: 'Kent hospitality lead gen' },
        },
      ];

      try {
        await storage.createPlan({
          id: runId,
          userId,
          status: 'executing',
          goalText,
          planData: { id: runId, steps },
        });
      } catch (dbErr: any) {
        console.error(`[DEBUG] demo-plan-run: failed to persist plan — ${dbErr.message}`);
      }

      const now = Date.now();
      try {
        await storage.createAgentRun({
          id: runId,
          clientRequestId,
          userId,
          status: 'executing',
          createdAt: now,
          updatedAt: now,
          uiReady: 1,
          metadata: { planId: runId, goalText, clientRequestId },
        });
      } catch (dbErr: any) {
        console.error(`[DEBUG] demo-plan-run: failed to persist agent_run — ${dbErr.message}`);
      }

      startPlanProgress(runId, runId, steps);

      const plan = {
        planId: runId,
        userId,
        clientRequestId,
        skipJudgement: true,
        goal: goalText,
        steps,
      };

      console.log(`[DEBUG] demo-plan-run: starting plan ${runId} with ${plan.steps.length} steps (judgement skipped)`);

      res.json({ ok: true, clientRequestId, runId });

      executePlan(plan).then(async result => {
        if (result.success) {
          console.log(`[DEBUG] demo-plan-run ${runId}: completed ${result.stepsCompleted}/${result.totalSteps} steps`);
          try {
            await storage.updateAgentRun(runId, {
              status: 'completed',
              terminalState: 'completed',
              endedAt: new Date(),
              metadata: { planId: runId, goalText, clientRequestId },
            });
          } catch (dbErr: any) {
            console.error(`[DEBUG] demo-plan-run: failed to update agent_run after success — ${dbErr.message}`);
          }
        } else {
          console.error(`[DEBUG] demo-plan-run ${runId}: failed — ${result.error}`);
          try {
            await storage.updateAgentRun(runId, {
              status: 'failed',
              terminalState: 'failed',
              endedAt: new Date(),
              error: result.error || 'Plan execution failed',
              metadata: { planId: runId, goalText, clientRequestId },
            });
          } catch (dbErr: any) {
            console.error(`[DEBUG] demo-plan-run: failed to update agent_run after failure — ${dbErr.message}`);
          }
        }
      }).catch(async err => {
        console.error(`[DEBUG] demo-plan-run ${runId}: threw — ${err.message}`);
        try {
          await storage.updateAgentRun(runId, {
            status: 'failed',
            terminalState: 'failed',
            endedAt: new Date(),
            error: err.message || 'Unexpected error',
            metadata: { planId: runId, goalText, clientRequestId },
          });
        } catch (dbErr: any) {
          console.error(`[DEBUG] demo-plan-run: failed to update agent_run after throw — ${dbErr.message}`);
        }
      });
    });

    // Debug endpoint - inspect tool registry state
    app.get("/api/debug/tool-registry", async (_req, res) => {
      const { getAllTools, getEnabledTools, getDisabledTools, isHospitalityQuery } = await import('./supervisor/tool-registry');
      const wyshboneDbReady = (process.env.WYSHBONE_DB_READY || 'false').toLowerCase().trim();
      res.json({
        all: getAllTools(),
        enabled: getEnabledTools().map(t => t.id),
        disabled: getDisabledTools().map(t => t.id),
        gating: {
          WYSHBONE_DB_READY: wyshboneDbReady,
          sampleIntentChecks: {
            'pubs in London': isHospitalityQuery('pubs in London'),
            'hat shops in London': isHospitalityQuery('hat shops in London'),
            'pet shops in Kent': isHospitalityQuery('pet shops in Kent'),
            'breweries in Manchester': isHospitalityQuery('breweries in Manchester'),
          },
        },
      });
    });

    // Debug endpoint - simulate Tower v1 verdict for a given runId
    // Allows testing Agent Loop reactions without making real Tower calls
    app.post("/api/debug/simulate-tower-verdict", async (req, res) => {
      const { setSimulatedVerdict, getRunState, getAllRunStates } = await import('./supervisor/agent-loop');

      const { runId, verdict, delivered, requested, gaps, confidence, rationale } = req.body;

      if (!runId) {
        return res.status(400).json({
          ok: false,
          error: 'runId is required',
          activeRuns: getAllRunStates().map(s => ({
            runId: s.runId,
            status: s.status,
            planVersion: s.planVersion,
            retryCount: s.retryCount,
          })),
        });
      }

      const validVerdicts = ['ACCEPT', 'RETRY', 'CHANGE_PLAN', 'STOP'];
      const v = (verdict || 'RETRY').toUpperCase();
      if (!validVerdicts.includes(v)) {
        return res.status(400).json({
          ok: false,
          error: `Invalid verdict. Must be one of: ${validVerdicts.join(', ')}`,
        });
      }

      const simulatedVerdict = {
        verdict: v as 'ACCEPT' | 'RETRY' | 'CHANGE_PLAN' | 'STOP',
        delivered: delivered ?? 2,
        requested: requested ?? 10,
        gaps: gaps || ['insufficient_results'],
        confidence: confidence ?? 40,
        rationale: rationale || `Simulated ${v} verdict for testing`,
      };

      setSimulatedVerdict(runId, simulatedVerdict);

      const state = getRunState(runId);

      console.log(`[DEBUG] simulate-tower-verdict: set verdict=${v} for runId=${runId}`);

      return res.json({
        ok: true,
        runId,
        simulatedVerdict,
        currentRunState: state ? {
          status: state.status,
          planVersion: state.planVersion,
          retryCount: state.retryCount,
          lastToolArgs: state.lastToolArgs,
        } : null,
        message: `Verdict ${v} queued for runId=${runId}. It will be consumed on the next Tower judgement call for this run.`,
      });
    });

    // Debug endpoint - list all active agent loop run states
    app.get("/api/debug/agent-loop-states", async (_req, res) => {
      const { getAllRunStates } = await import('./supervisor/agent-loop');

      const states = getAllRunStates().map(s => ({
        runId: s.runId,
        userId: s.userId,
        status: s.status,
        planVersion: s.planVersion,
        retryCount: s.retryCount,
        lastToolArgs: s.lastToolArgs,
        lastVerdict: s.lastVerdict,
        createdAt: new Date(s.createdAt).toISOString(),
      }));

      return res.json({ ok: true, count: states.length, states });
    });

    // Debug endpoint - demo tool-registry-aware plan run
    // Proves that "find pet shops in Kent" → SEARCH_PLACES (not SEARCH_WYSHBONE_DB) + leads_list artefact
    app.post("/api/debug/demo-tool-registry", async (req, res) => {
      const { randomUUID } = await import('crypto');
      const { executePlan } = await import('./supervisor/plan-executor');
      const { getEnabledTools, getDisabledTools, isToolEnabled: isEnabled } = await import('./supervisor/tool-registry');

      const clientRequestId = randomUUID();
      const runId = `demo_tr_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
      const userId = getUserId(req);
      const goalText = req.body?.goal || 'find pet shops in Kent';

      console.log(`[DEBUG] demo-tool-registry: goal="${goalText}", runId=${runId}`);
      console.log(`[DEBUG] demo-tool-registry: enabled tools = [${getEnabledTools().map(t => t.id).join(', ')}]`);
      console.log(`[DEBUG] demo-tool-registry: disabled tools = [${getDisabledTools().map(t => t.id).join(', ')}]`);
      console.log(`[DEBUG] demo-tool-registry: SEARCH_PLACES enabled=${isEnabled('SEARCH_PLACES')}, SEARCH_WYSHBONE_DB enabled=${isEnabled('SEARCH_WYSHBONE_DB')}`);

      const steps = [
        {
          id: 'search-places-1',
          type: 'SEARCH_PLACES',
          label: `Search: ${goalText}`,
          toolName: 'SEARCH_PLACES',
          toolArgs: { query: goalText, location: 'Kent', country: 'GB' },
        },
        {
          id: 'enrich-1',
          type: 'ENRICH_LEADS',
          label: 'Enrich discovered leads',
          toolName: 'ENRICH_LEADS',
          toolArgs: { query: goalText, location: 'Kent', country: 'GB', enrichType: 'detail' },
        },
        {
          id: 'score-1',
          type: 'SCORE_LEADS',
          label: 'Score and rank leads',
          toolName: 'SCORE_LEADS',
          toolArgs: { query: goalText, location: 'Kent', country: 'GB', scoreModel: 'basic' },
        },
      ];

      try {
        await storage.createPlan({
          id: runId,
          userId,
          status: 'executing',
          goalText,
          planData: { id: runId, steps },
        });
      } catch (dbErr: any) {
        console.error(`[DEBUG] demo-tool-registry: failed to persist plan — ${dbErr.message}`);
      }

      const now = Date.now();
      try {
        await storage.createAgentRun({
          id: runId,
          clientRequestId,
          userId,
          status: 'executing',
          createdAt: now,
          updatedAt: now,
          uiReady: 1,
          metadata: { planId: runId, goalText, clientRequestId },
        });
      } catch (dbErr: any) {
        console.error(`[DEBUG] demo-tool-registry: failed to persist agent_run — ${dbErr.message}`);
      }

      startPlanProgress(runId, runId, steps);

      const plan = {
        planId: runId,
        userId,
        clientRequestId,
        skipJudgement: true,
        goal: goalText,
        steps,
      };

      console.log(`[DEBUG] demo-tool-registry: starting plan ${runId} with ${plan.steps.length} steps`);

      res.json({
        ok: true,
        clientRequestId,
        runId,
        goal: goalText,
        toolsUsed: steps.map(s => s.toolName),
        enabledTools: getEnabledTools().map(t => t.id),
        disabledTools: getDisabledTools().map(t => t.id),
        searchWyshboneDbEnabled: isEnabled('SEARCH_WYSHBONE_DB'),
      });

      executePlan(plan).then(async result => {
        if (result.success) {
          console.log(`[DEBUG] demo-tool-registry ${runId}: completed ${result.stepsCompleted}/${result.totalSteps} steps`);
          try {
            await storage.updateAgentRun(runId, {
              status: 'completed',
              terminalState: 'completed',
              endedAt: new Date(),
              metadata: { planId: runId, goalText, clientRequestId },
            });
          } catch (dbErr: any) {
            console.error(`[DEBUG] demo-tool-registry: failed to update agent_run — ${dbErr.message}`);
          }
        } else {
          console.error(`[DEBUG] demo-tool-registry ${runId}: failed — ${result.error}`);
          try {
            await storage.updateAgentRun(runId, {
              status: 'failed',
              terminalState: 'failed',
              endedAt: new Date(),
              error: result.error || 'Plan execution failed',
              metadata: { planId: runId, goalText, clientRequestId },
            });
          } catch (dbErr: any) {
            console.error(`[DEBUG] demo-tool-registry: failed to update agent_run — ${dbErr.message}`);
          }
        }
      }).catch(async err => {
        console.error(`[DEBUG] demo-tool-registry ${runId}: threw — ${err.message}`);
      });
    });

    // Debug endpoint - check what's in Supabase
    app.get("/api/debug/supabase", async (req, res) => {
      try {
        // Check users table
        const { data: users, error: usersError } = await supabase.from('users').select('*').limit(5);
        
        // Check user_signals table
        const { data: signals, error: signalsError } = await supabase
          .from('user_signals')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(5);
        
        // Check facts table
        const { data: facts, error: factsError } = await supabase
          .from('facts')
          .select('*')
          .order('score', { ascending: false })
          .limit(5);
        
        // Check messages table
        const { data: messages, error: messagesError } = await supabase
          .from('messages')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(5);
        
        // Check conversations table
        const { data: conversations, error: conversationsError } = await supabase
          .from('conversations')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(5);
        
        res.json({
          users: { data: users, error: usersError },
          signals: { data: signals, error: signalsError },
          facts: { data: facts, error: factsError },
          messages: { data: messages, error: messagesError },
          conversations: { data: conversations, error: conversationsError }
        });
      } catch (error) {
        console.error("Error fetching Supabase debug data:", error);
        res.status(500).json({ error: "Failed to fetch debug data" });
      }
    });
  } else {
    console.log('[DEBUG] Debug endpoints disabled (ENABLE_DEBUG_ENDPOINTS !== "true" or NODE_ENV === "production")');
  }

  // Get user context (profile, facts, messages, etc.)
  app.get("/api/user/context", async (req, res) => {
    try {
      // Allow specifying user_id via query param, default to em@em.com's ID (Dental Sky)
      const userId = (req.query.user_id as string) || "8f9079b3ddf739fb0217373c92292e91";
      const context = await supervisor.getUserContext(userId);
      res.json(context);
    } catch (error) {
      console.error("Error fetching user context:", error);
      res.status(500).json({ error: "Failed to fetch user context" });
    }
  });

  // Get suggested leads for demo user
  app.get("/api/leads", async (req, res) => {
    try {
      // Allow specifying user_id via query param, default to em@em.com's ID (Dental Sky)
      const userId = (req.query.user_id as string) || "8f9079b3ddf739fb0217373c92292e91";
      const leads = await storage.getSuggestedLeads(userId);
      res.json(leads);
    } catch (error) {
      console.error("Error fetching leads:", error);
      res.status(500).json({ error: "Failed to fetch leads" });
    }
  });

  // Get recent user signals (from both PostgreSQL and Supabase)
  app.get("/api/signals", async (req, res) => {
    try {
      // Allow specifying user_id via query param, default to bobby@test.com's ID
      const userId = (req.query.user_id as string) || "dd71d4fc24290b03e6327aa7467176a8";
      
      // Fetch from PostgreSQL
      const pgSignals = await storage.getRecentSignals(userId);
      
      // Fetch from Supabase - filter by current user only
      const { data: supabaseSignals, error } = await supabase
        .from('user_signals')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);
      
      if (error) {
        console.error("Error fetching Supabase signals:", error);
      }
      
      // Combine and transform Supabase signals to match our schema
      const transformedSupabaseSignals = (supabaseSignals || []).map(signal => ({
        id: signal.id.toString(),
        userId: signal.user_id,
        type: signal.type,
        payload: signal.payload,
        createdAt: new Date(signal.created_at)
      }));
      
      // Merge both sources and sort by createdAt
      const allSignals = [...pgSignals, ...transformedSupabaseSignals]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 20);
      
      res.json(allSignals);
    } catch (error) {
      console.error("Error fetching signals:", error);
      res.status(500).json({ error: "Failed to fetch signals" });
    }
  });

  // Create a new signal (for testing)
  app.post("/api/signals", async (req, res) => {
    try {
      const validationResult = insertUserSignalSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        const validationError = fromError(validationResult.error);
        return res.status(400).json({ 
          error: "Validation failed", 
          details: validationError.toString() 
        });
      }
      
      const signal = await storage.createSignal(validationResult.data);
      res.json(signal);
    } catch (error) {
      console.error("Error creating signal:", error);
      res.status(500).json({ error: "Failed to create signal" });
    }
  });

  // Seed initial data
  app.post("/api/seed", async (req, res) => {
    try {
      // Create some sample signals
      const signal1 = await storage.createSignal({
        userId: "demo-user",
        type: "profile_update",
        payload: {
          userProfile: {
            userId: "demo-user",
            industry: "brewery",
            location: {
              city: "Manchester",
              country: "UK",
              radiusKm: 25
            },
            prefs: {
              packaging: "cans"
            }
          }
        }
      });

      const signal2 = await storage.createSignal({
        userId: "demo-user",
        type: "idle",
        payload: {
          userProfile: {
            userId: "demo-user",
            industry: "brewery",
            location: {
              city: "Leeds",
              country: "UK"
            }
          }
        }
      });

      // Create some sample suggested leads
      const lead1 = await storage.createSuggestedLead({
        userId: "demo-user",
        rationale: "Based on brewery profile - bottle shops near Manchester with craft beer focus",
        source: "google_places_new",
        score: 0.85,
        lead: {
          name: "The Craft Beer Shop",
          address: "123 Main St, Manchester, UK",
          place_id: "place1",
          domain: "craftbeershop.co.uk",
          emailCandidates: ["info@craftbeershop.co.uk"],
          tags: ["bottle_shop", "craft_beer"]
        }
      });

      const lead2 = await storage.createSuggestedLead({
        userId: "demo-user",
        rationale: "Freehouse pub matching profile preferences",
        source: "google_places_new",
        score: 0.72,
        lead: {
          name: "The Old Oak Inn",
          address: "45 High Street, Leeds, UK",
          place_id: "place2",
          domain: "oldoakinn.co.uk",
          emailCandidates: [],
          tags: ["freehouse", "pub"]
        }
      });

      const lead3 = await storage.createSuggestedLead({
        userId: "demo-user",
        rationale: "Premium bottle shop with craft beer focus - high email match confidence",
        source: "google_places_new",
        score: 0.91,
        lead: {
          name: "Hop & Grain Bottle Shop",
          address: "78 Market Street, Sheffield, UK",
          place_id: "place3",
          domain: "hopandgrain.co.uk",
          emailCandidates: ["hello@hopandgrain.co.uk", "sales@hopandgrain.co.uk"],
          tags: ["bottle_shop", "craft_beer"]
        }
      });

      const lead4 = await storage.createSuggestedLead({
        userId: "demo-user",
        rationale: "Independent pub with can-friendly vibe",
        source: "google_places_new",
        score: 0.68,
        lead: {
          name: "The Hoppy Tap",
          address: "15 Station Road, York, UK",
          place_id: "place4",
          domain: "hoppytap.co.uk",
          emailCandidates: ["contact@hoppytap.co.uk"],
          tags: ["pub", "independent"]
        }
      });

      res.json({ 
        success: true, 
        created: {
          signals: 2,
          leads: 4
        }
      });
    } catch (error) {
      console.error("Error seeding data:", error);
      res.status(500).json({ error: "Failed to seed data" });
    }
  });

  // Export API - middleware to check EXPORT_KEY
  const checkExportKey = (req: any, res: any, next: any) => {
    const providedKey = req.headers['x-export-key'];
    const validKey = process.env.EXPORT_KEY || (global as any).GENERATED_EXPORT_KEY;

    if (!providedKey || providedKey !== validKey) {
      return res.status(403).json({ 
        error: 'Forbidden',
        message: 'Valid X-EXPORT-KEY header required' 
      });
    }

    next();
  };

  // Export API - GET /export/status.json
  app.get('/export/status.json', checkExportKey, async (req, res) => {
    try {
      const { getSummary } = await import('./utils/exporter.js');
      const summary = await getSummary();
      res.json(summary);
    } catch (error: any) {
      console.error('[Export API] Error generating summary:', error.message || error);
      res.status(500).json({ 
        error: 'Internal server error',
        message: 'Failed to generate export summary' 
      });
    }
  });

  // Export API - GET /export/file
  app.get('/export/file', checkExportKey, async (req, res) => {
    try {
      const requestedPath = req.query.path as string;

      if (!requestedPath) {
        return res.status(400).json({ 
          error: 'Bad request',
          message: 'Query parameter "path" is required' 
        });
      }

      const { getFileContent } = await import('./utils/exporter.js');
      const result = await getFileContent(requestedPath);
      res.json(result);
    } catch (error: any) {
      console.error('[Export API] Error fetching file:', error.message || error);
      
      if (error.message === 'FILE_NOT_WHITELISTED') {
        return res.status(404).json({ 
          error: 'Not found',
          message: 'Requested file is not available for export' 
        });
      }

      if (error.message === 'FILE_NOT_FOUND') {
        return res.status(404).json({ 
          error: 'Not found',
          message: 'Requested file does not exist' 
        });
      }

      res.status(500).json({ 
        error: 'Internal server error',
        message: 'Failed to retrieve file' 
      });
    }
  });

  // ========================================
  // SAVE LEAD API (SUP-7)
  // ========================================

  // POST /api/leads/save - Save a lead to in-memory store
  app.post("/api/leads/save", async (req, res) => {
    try {
      const { lead, ownerUserId } = req.body;

      // Validate required fields
      if (!lead) {
        return res.status(400).json({ 
          status: "error",
          error: "lead object is required" 
        });
      }

      if (!lead.businessName) {
        return res.status(400).json({ 
          status: "error",
          error: "lead.businessName is required" 
        });
      }

      if (!lead.address) {
        return res.status(400).json({ 
          status: "error",
          error: "lead.address is required" 
        });
      }

      if (!ownerUserId) {
        return res.status(400).json({ 
          status: "error",
          error: "ownerUserId is required" 
        });
      }

      // Validate source if provided
      const validSources = ["google", "database", "manual"];
      if (lead.source && !validSources.includes(lead.source)) {
        return res.status(400).json({ 
          status: "error",
          error: `Invalid lead.source. Valid values: ${validSources.join(", ")}` 
        });
      }

      const payload: IncomingLeadPayload = {
        lead: {
          businessName: lead.businessName,
          address: lead.address,
          placeId: lead.placeId,
          website: lead.website,
          phone: lead.phone,
          lat: lead.lat,
          lng: lead.lng,
          source: lead.source || "manual"
        },
        ownerUserId
      };

      const savedLead = saveLeadToStore(payload);

      const response: SaveLeadResponse = {
        status: "ok",
        leadId: savedLead.id,
        savedLead
      };

      res.json(response);
    } catch (error: any) {
      console.error("[LEADS API] Error saving lead:", error);
      res.status(500).json({ 
        status: "error",
        error: error.message || "Failed to save lead" 
      });
    }
  });

  // GET /api/leads/saved - List saved leads from in-memory store
  app.get("/api/leads/saved", async (req, res) => {
    try {
      const ownerUserId = req.query.ownerUserId as string | undefined;
      
      const leads = listSavedLeads(ownerUserId);

      const response: ListLeadsResponse = {
        status: "ok",
        leads
      };

      res.json(response);
    } catch (error: any) {
      console.error("[LEADS API] Error listing saved leads:", error);
      res.status(500).json({ 
        status: "error",
        error: error.message || "Failed to list saved leads" 
      });
    }
  });

  // ========================================
  // SUBCONSCIOUS NUDGES API (SUP-13)
  // ========================================

  // GET /api/subcon/nudges/account/:accountId - Get all nudges for an account
  app.get("/api/subcon/nudges/account/:accountId", async (req, res) => {
    try {
      const { accountId } = req.params;
      const { unresolved } = req.query;

      if (!accountId) {
        return res.status(400).json({ error: "accountId is required" });
      }

      let nudges;
      if (unresolved === 'true') {
        nudges = await storage.getUnresolvedSubconNudges(accountId);
      } else {
        nudges = await storage.getSubconNudgesByAccount(accountId);
      }

      res.json({ 
        status: "ok",
        nudges,
        count: nudges.length
      });
    } catch (error: any) {
      console.error("[SUBCON API] Error fetching nudges:", error);
      res.status(500).json({ error: error.message || "Failed to fetch nudges" });
    }
  });

  // POST /api/subcon/nudges/resolve/:id - Resolve a nudge
  app.post("/api/subcon/nudges/resolve/:id", async (req, res) => {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({ error: "nudge id is required" });
      }

      await storage.resolveSubconNudge(id);

      res.json({ 
        status: "ok",
        message: `Nudge ${id} resolved`
      });
    } catch (error: any) {
      console.error("[SUBCON API] Error resolving nudge:", error);
      res.status(500).json({ error: error.message || "Failed to resolve nudge" });
    }
  });

  // POST /api/subcon/nudges/dismiss/:id - Dismiss a nudge
  app.post("/api/subcon/nudges/dismiss/:id", async (req, res) => {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({ error: "nudge id is required" });
      }

      await storage.dismissSubconNudge(id);

      res.json({ 
        status: "ok",
        message: `Nudge ${id} dismissed`
      });
    } catch (error: any) {
      console.error("[SUBCON API] Error dismissing nudge:", error);
      res.status(500).json({ error: error.message || "Failed to dismiss nudge" });
    }
  });

  // ========================================
  // FEATURE RUNNER API (SUP-6, SUP-9)
  // ========================================

  // POST /api/features/run - Run a feature
  app.post("/api/features/run", async (req, res) => {
    try {
      const { feature, params } = req.body;

      if (!feature) {
        return res.status(400).json({ error: "feature is required" });
      }

      // Validate feature type
      const validFeatures: FeatureType[] = ["leadFinder"];
      if (!validFeatures.includes(feature)) {
        return res.status(400).json({ 
          error: `Invalid feature type: ${feature}. Valid types: ${validFeatures.join(", ")}` 
        });
      }

      console.log(`[FEATURES API] Running feature: ${feature}`);
      
      const result = await runFeature(feature as FeatureType, params || {});

      // SUP-9: Handle feature disabled status
      if (result.status === "feature_disabled") {
        return res.status(403).json({
          status: "feature_disabled",
          error: result.error,
          errorCode: result.errorCode
        });
      }

      if (result.status === "error") {
        return res.status(500).json({ 
          status: "error",
          error: result.error,
          errorCode: result.errorCode
        });
      }

      res.json(result);
    } catch (error: any) {
      console.error("[FEATURES API] Error running feature:", error);
      res.status(500).json({ 
        status: "error",
        error: error.message || "Failed to run feature" 
      });
    }
  });

  // ========================================
  // DAILY AGENT CRON API (Phase 2 Task 5)
  // ========================================

  // POST /api/agent/trigger - Manually trigger daily agent
  app.post("/api/agent/trigger", async (req, res) => {
    try {
      console.log('[AGENT API] Manual trigger requested');

      const { triggerDailyAgentManually } = await import('./cron/daily-agent');
      const result = await triggerDailyAgentManually();

      res.json({
        status: 'success',
        message: 'Daily agent executed successfully',
        result: {
          cronJobId: result.cronJobId,
          totalUsers: result.totalUsers,
          successfulUsers: result.successfulUsers,
          failedUsers: result.failedUsers,
          totalTasksGenerated: result.totalTasksGenerated,
          totalTasksExecuted: result.totalTasksExecuted,
          totalSuccessfulTasks: result.totalSuccessfulTasks,
          totalInterestingResults: result.totalInterestingResults,
          duration: result.duration
        }
      });
    } catch (error: any) {
      console.error('[AGENT API] Error triggering daily agent:', error);
      res.status(500).json({
        status: 'error',
        error: error.message || 'Failed to trigger daily agent'
      });
    }
  });

  // GET /api/agent/status - Get cron job status
  app.get("/api/agent/status", async (req, res) => {
    try {
      const { isDailyAgentCronRunning, getNextCronRunTime } = await import('./cron/daily-agent');

      const isRunning = isDailyAgentCronRunning();
      const nextRun = getNextCronRunTime();

      res.json({
        enabled: isRunning,
        schedule: process.env.DAILY_AGENT_CRON_SCHEDULE || '0 9 * * *',
        nextRun,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      });
    } catch (error: any) {
      console.error('[AGENT API] Error getting agent status:', error);
      res.status(500).json({
        status: 'error',
        error: error.message || 'Failed to get agent status'
      });
    }
  });

  // ========================================
  // DAG MUTATION API (Phase 3 Task 5)
  // ========================================

  // POST /api/plan/:planId/dag/add-step - Add a step to the plan
  app.post("/api/plan/:planId/dag/add-step", async (req, res) => {
    try {
      const { planId } = req.params;
      const { step, insertAfter, insertBefore, reason } = req.body;

      if (!step) {
        return res.status(400).json({ error: "step is required" });
      }

      const { addStep } = await import('./dag-mutator');
      const result = await addStep(planId, step, {
        insertAfter,
        insertBefore,
        reason,
        automatic: false
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json({
        success: true,
        mutationId: result.mutationId,
        warnings: result.warnings
      });
    } catch (error: any) {
      console.error('[DAG API] Error adding step:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/plan/:planId/dag/step/:stepId - Remove a step
  app.delete("/api/plan/:planId/dag/step/:stepId", async (req, res) => {
    try {
      const { planId, stepId } = req.params;
      const { updateDependencies, reason } = req.body;

      const { removeStep } = await import('./dag-mutator');
      const result = await removeStep(planId, stepId, {
        updateDependencies: updateDependencies !== false, // Default true
        reason,
        automatic: false
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json({
        success: true,
        mutationId: result.mutationId,
        warnings: result.warnings
      });
    } catch (error: any) {
      console.error('[DAG API] Error removing step:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // PUT /api/plan/:planId/dag/step/:stepId/dependencies - Modify step dependencies
  app.put("/api/plan/:planId/dag/step/:stepId/dependencies", async (req, res) => {
    try {
      const { planId, stepId } = req.params;
      const { dependencies, reason } = req.body;

      if (!Array.isArray(dependencies)) {
        return res.status(400).json({ error: "dependencies must be an array" });
      }

      const { modifyStepDependencies } = await import('./dag-mutator');
      const result = await modifyStepDependencies(planId, stepId, dependencies, {
        reason,
        automatic: false
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json({
        success: true,
        mutationId: result.mutationId,
        warnings: result.warnings
      });
    } catch (error: any) {
      console.error('[DAG API] Error modifying dependencies:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // PUT /api/plan/:planId/dag/step/:stepId/replace - Replace a step
  app.put("/api/plan/:planId/dag/step/:stepId/replace", async (req, res) => {
    try {
      const { planId, stepId } = req.params;
      const { newStep, reason } = req.body;

      if (!newStep) {
        return res.status(400).json({ error: "newStep is required" });
      }

      const { replaceStep } = await import('./dag-mutator');
      const result = await replaceStep(planId, stepId, newStep, {
        reason,
        automatic: false
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json({
        success: true,
        mutationId: result.mutationId,
        warnings: result.warnings
      });
    } catch (error: any) {
      console.error('[DAG API] Error replacing step:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/plan/:planId/dag/validate - Validate DAG structure
  app.post("/api/plan/:planId/dag/validate", async (req, res) => {
    try {
      const { planId } = req.params;

      const dbPlan = await storage.getPlan(planId);
      if (!dbPlan) {
        return res.status(404).json({ error: 'Plan not found' });
      }

      const plan = dbPlan.planData;
      const { validateDAG } = await import('./dag-mutator');
      const validation = validateDAG(plan);

      res.json(validation);
    } catch (error: any) {
      console.error('[DAG API] Error validating DAG:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/plan/:planId/dag/mutations - Get mutation history
  app.get("/api/plan/:planId/dag/mutations", async (req, res) => {
    try {
      const { planId } = req.params;

      const { getMutationHistory } = await import('./dag-mutator');
      const history = getMutationHistory(planId);

      res.json({
        planId,
        mutations: history,
        count: history.length
      });
    } catch (error: any) {
      console.error('[DAG API] Error getting mutations:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ========================================
  // AGENT MEMORY API (Phase 2: ADAPT)
  // ========================================

  // POST /api/memory/store - Store a new memory from tool execution
  app.post("/api/memory/store", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { toolUsed, query, outcome, userFeedback, confidenceScore, planId, taskId } = req.body;

      if (!toolUsed || !query || !outcome) {
        return res.status(400).json({ error: "toolUsed, query, and outcome are required" });
      }

      // Calculate expiration date (90 days from now)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90);

      const memory = await storage.storeAgentMemory({
        userId,
        accountId: req.body.accountId,
        toolUsed,
        query,
        outcome,
        userFeedback: userFeedback || null,
        confidenceScore: confidenceScore || null,
        planId: planId || null,
        taskId: taskId || null,
        expiresAt
      });

      console.log(`[MEMORY API] Stored memory for user ${userId}, tool: ${toolUsed}`);

      res.json({
        status: "success",
        memory
      });
    } catch (error: any) {
      console.error("[MEMORY API] Error storing memory:", error);
      res.status(500).json({ error: error.message || "Failed to store memory" });
    }
  });

  // GET /api/memory - Retrieve memories for a user
  app.get("/api/memory", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { toolUsed, limit = 50, offset = 0 } = req.query;

      const memories = await storage.getAgentMemories({
        userId,
        toolUsed: toolUsed as string,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string)
      });

      res.json({
        status: "success",
        memories,
        count: memories.length
      });
    } catch (error: any) {
      console.error("[MEMORY API] Error retrieving memories:", error);
      res.status(500).json({ error: error.message || "Failed to retrieve memories" });
    }
  });

  // GET /api/preferences - Get user's learned preferences (P2-T4)
  app.get("/api/preferences", async (req, res) => {
    try {
      const userId = getUserId(req);

      // Import preference learner (dynamic to avoid circular dependencies)
      const { getUserPreferences } = await import("./services/preference-learner");

      const preferences = await getUserPreferences(userId);

      res.json({
        success: true,
        preferences,
        updatedAt: Date.now()
      });
    } catch (error: any) {
      console.error("[PREFERENCES API] Error retrieving preferences:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to retrieve preferences"
      });
    }
  });

  // POST /api/memory/:id/feedback - Update user feedback on a memory
  app.post("/api/memory/:id/feedback", async (req, res) => {
    try {
      const { id } = req.params;
      const { userFeedback } = req.body;

      if (!userFeedback || !['helpful', 'not_helpful'].includes(userFeedback)) {
        return res.status(400).json({ error: "userFeedback must be 'helpful' or 'not_helpful'" });
      }

      await storage.updateMemoryFeedback(id, userFeedback);

      res.json({
        status: "success",
        message: `Memory ${id} marked as ${userFeedback}`
      });
    } catch (error: any) {
      console.error("[MEMORY API] Error updating feedback:", error);
      res.status(500).json({ error: error.message || "Failed to update feedback" });
    }
  });

  // POST /api/wabs/feedback - Submit WABS scoring feedback (P3-T3)
  app.post("/api/wabs/feedback", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { taskId, resultData, wabsScore, wabsSignals, userFeedback, feedbackReason } = req.body;

      if (!taskId || !wabsScore || !wabsSignals || !userFeedback) {
        return res.status(400).json({
          error: "Missing required fields: taskId, wabsScore, wabsSignals, userFeedback"
        });
      }

      if (!['helpful', 'not_helpful'].includes(userFeedback)) {
        return res.status(400).json({
          error: "userFeedback must be 'helpful' or 'not_helpful'"
        });
      }

      // Import WABS feedback service
      const { storeWABSFeedback } = await import("./services/wabs-feedback");

      const memoryId = await storeWABSFeedback({
        userId,
        taskId,
        resultData: resultData || {},
        wabsScore,
        wabsSignals,
        userFeedback,
        feedbackReason,
        timestamp: Date.now()
      });

      res.json({
        success: true,
        memoryId,
        message: `WABS feedback recorded: ${userFeedback}`
      });

    } catch (error: any) {
      console.error("[WABS FEEDBACK API] Error storing feedback:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to store WABS feedback"
      });
    }
  });

  app.get("/api/afr/runs/:runId/artefacts", async (req, res) => {
    try {
      const { runId } = req.params;
      const artefacts = await storage.getArtefactsByRunId(runId);
      res.json(artefacts);
    } catch (error: any) {
      console.error("[AFR ARTEFACTS] Error fetching artefacts:", error);
      res.status(500).json({ error: error.message || "Failed to fetch artefacts" });
    }
  });

  app.get("/api/afr/artefacts", async (req, res) => {
    const runId = req.query.run_id as string;
    if (!runId) {
      return res.status(400).json({ error: "run_id query parameter is required" });
    }
    try {
      const artefacts = await storage.getArtefactsByRunId(runId);
      res.json(artefacts);
    } catch (error: any) {
      console.error("[AFR ARTEFACTS] Error fetching artefacts:", error);
      res.status(500).json({ error: error.message || "Failed to fetch artefacts" });
    }
  });

  app.get("/api/afr/runs", async (req, res) => {
    try {
      const userId = req.query.user_id as string | undefined;
      const runs = await storage.getAgentRuns(userId);
      res.json(runs);
    } catch (error: any) {
      console.error("[AFR RUNS] Error fetching runs:", error);
      res.status(500).json({ error: error.message || "Failed to fetch runs" });
    }
  });

  app.get("/api/afr/stream", async (req, res) => {
    if (!supabase) {
      res.status(503).json({ error: "Supabase not configured" });
      return;
    }

    const runId = req.query.run_id as string | undefined;

    if (!runId) {
      res.status(400).json({ error: "run_id query parameter is required" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    let lastTimestamp = 0;
    let alive = true;

    req.on("close", () => { alive = false; });

    const poll = async () => {
      while (alive) {
        try {
          const { data, error } = await supabase
            .from("agent_activities")
            .select("id, user_id, action_taken, status, task_generated, run_id, metadata, timestamp, error_message")
            .eq("run_id", runId)
            .gt("timestamp", lastTimestamp)
            .order("timestamp", { ascending: true })
            .limit(50);

          if (error) {
            console.error("[AFR_STREAM] query error:", error.message);
          } else if (data && data.length > 0) {
            for (const row of data) {
              if (!alive) break;

              if (row.run_id !== runId) continue;

              const actionTaken = row.action_taken || "";
              let eventType = "activity";
              if (actionTaken === "plan_execution_started") eventType = "plan_started";
              else if (actionTaken === "plan_execution_completed") eventType = "plan_completed";
              else if (actionTaken === "plan_execution_failed") eventType = "plan_failed";
              else if (actionTaken === "step_started" || actionTaken.startsWith("step_started:")) eventType = "step_started";
              else if (actionTaken === "step_completed" || actionTaken.startsWith("step_completed:")) eventType = "step_completed";
              else if (actionTaken === "step_failed" || actionTaken.startsWith("step_failed:")) eventType = "step_failed";
              else if (actionTaken === "tower_evaluation_completed") eventType = "tower_evaluation";
              else if (actionTaken === "tower_decision_stop") eventType = "tower_decision";
              else if (actionTaken === "tower_decision_change_plan") eventType = "tower_decision";
              else if (actionTaken === "tools_update") eventType = "tools_update";
              else if (actionTaken === "tool_call_started") eventType = "tool_call_started";
              else if (actionTaken === "tool_call_completed") eventType = "tool_call_completed";
              else if (actionTaken === "tool_call_failed") eventType = "tool_call_failed";
              else if (actionTaken === "router_decision") eventType = "router_decision";
              else if (actionTaken === "mission_received") eventType = "mission_received";
              else if (actionTaken === "run_completed") eventType = "run_completed";
              else if (actionTaken === "artefact_created") eventType = "artefact_created";

              const payload = {
                id: row.id,
                eventType,
                actionTaken,
                status: row.status,
                summary: row.task_generated || actionTaken,
                runId: row.run_id,
                timestamp: row.timestamp,
                errorMessage: row.error_message || null,
                metadata: row.metadata || {},
              };

              res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);

              if (row.timestamp > lastTimestamp) {
                lastTimestamp = row.timestamp;
              }
            }
          }
        } catch (err: any) {
          console.error("[AFR_STREAM] poll error:", err.message);
        }

        await new Promise(r => setTimeout(r, 500));
      }
    };

    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    poll();
  });

  const httpServer = createServer(app);
  return httpServer;
}
