import type { Express } from "express";
import { createServer, type Server } from "http";
import { registerQaMetricsRoutes } from "./routes/qa-metrics";
import { storage } from "./storage";
import { insertUserSignalSchema, insertSuggestedLeadSchema } from "./schema";
import type { Artefact, TowerJudgement, AgentRun } from "./schema";
import { z } from "zod";
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
import { handleExplainRun } from "./supervisor/explain-run";

// SUPERVISOR_EXECUTION_ENABLED: REMOVED — all execution goes through Supervisor unconditionally.

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
  console.log(`[ROUTES] Supervisor execution enabled: true (unconditional)`);
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
    const { planId, run_id: externalRunId, client_request_id: externalCrid } = req.body;
    const { randomUUID } = await import('crypto');
    const runId = externalRunId || randomUUID();
    const clientRequestId = externalCrid || randomUUID();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[PLAN_APPROVE] RECEIVED REQUEST`);
    console.log(`  planId: ${planId}`);
    console.log(`  runId: ${runId} (source: ${externalRunId ? 'UI' : 'generated'})`);
    console.log(`  clientRequestId: ${clientRequestId}`);
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

      const now = new Date();
      try {
        await storage.createAgentRun({
          id: runId,
          clientRequestId,
          userId,
          status: 'executing',
          createdAt: now,
          updatedAt: now,
          uiReady: 1,
          metadata: { planId: plan.id, goalText: dbPlan.goalText, clientRequestId, source: 'plan_approve' },
        });
        console.log(`[PLAN_APPROVE] Created agent_run ${runId} for plan ${planId}`);
      } catch (dbErr: any) {
        console.warn(`[PLAN_APPROVE] agent_run creation failed (may already exist): ${dbErr.message}`);
      }

      // Start progress tracking (use planId)
      console.log(`[PLAN_APPROVE] Starting progress tracking for plan ${planId}...`);
      startPlanProgress(plan.id, plan.id, plan.steps);

      console.log(`[PLAN_APPROVE] Delegating to Supervisor plan executor (jobId=${runId})`);
      
      const { startPlanExecutionAsync } = await import('./supervisor/plan-executor');
      startPlanExecutionAsync({
        planId: plan.id,
        jobId: runId,
        clientRequestId,
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

      const elapsed = Date.now() - startTime;
      console.log(`\n${'='.repeat(60)}`);
      console.log(`[PLAN_APPROVE] SUCCESS - Execution kicked off`);
      console.log(`  planId: ${plan.id}`);
      console.log(`  runId: ${runId}`);
      console.log(`  status: executing`);
      console.log(`  elapsed: ${elapsed}ms`);
      console.log(`${'='.repeat(60)}\n`);

      res.json({ 
        planId: plan.id,
        runId,
        clientRequestId,
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
    const { randomUUID } = await import('crypto');

    const goalText = (req.body?.goal as string) || (req.body?.user_message as string) || 'find pet shops kent';
    const userId = getUserId(req);
    const taskId = randomUUID();
    const conversationId = req.body?.conversation_id || `sim_conv_${taskId.substring(0, 8)}`;
    const runId = req.body?.run_id || randomUUID();
    const clientRequestId = req.body?.client_request_id || randomUUID();

    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

    try {
      const queryId = (req.body?.query_id as string) || null;

      const { data: task, error } = await supabase
        .from('supervisor_tasks')
        .insert({
          id: taskId,
          conversation_id: conversationId,
          user_id: userId,
          task_type: 'generate_leads',
          request_data: {
            user_message: goalText,
            run_id: runId,
            client_request_id: clientRequestId,
            search_query: req.body?.search_query || {},
            ...(queryId ? { query_id: queryId } : {}),
            ...(req.body?.execution_path ? { execution_path: req.body.execution_path } : {}),
          },
          status: 'pending',
          created_at: Date.now(),
        })
        .select()
        .single();

      if (error) throw error;

      console.log(`[DEBUG] simulate-chat-task: created supervisor_task ${taskId} — message="${goalText.substring(0, 80)}"`);

      const nowMs = Date.now();
      try {
        await storage.createAgentRun({
          id: runId,
          clientRequestId,
          userId,
          createdAt: nowMs,
          updatedAt: nowMs,
          status: 'pending',
          metadata: {
            source: 'simulate_chat_task',
            original_user_goal: goalText.substring(0, 200),
          },
        });
        console.log(`[DEBUG] simulate-chat-task: created agent_run ${runId} at entrypoint`);
      } catch (runErr: any) {
        const msg = runErr.message || '';
        if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
          console.log(`[DEBUG] simulate-chat-task: agent_run ${runId} already exists`);
        } else {
          console.warn(`[DEBUG] simulate-chat-task: agent_run create failed (non-fatal): ${msg}`);
        }
      }

      const { logAFREvent } = await import('./supervisor/afr-logger');
      logAFREvent({
        userId,
        runId,
        conversationId,
        clientRequestId,
        actionTaken: 'user_message_received',
        status: 'success',
        taskGenerated: `Message received: "${goalText.substring(0, 80)}"`,
        runType: 'plan',
        metadata: {
          user_message: goalText.substring(0, 200),
          source: 'simulate_chat_task',
        },
      }).catch((e: any) => console.warn(`[DEBUG] simulate-chat-task: user_message_received log failed: ${e.message}`));

      res.json({
        ok: true,
        taskId,
        runId,
        clientRequestId,
        conversationId,
        message: 'Task created. Supervisor will pick it up on next poll cycle.',
      });
    } catch (error: any) {
      console.error(`[DEBUG] simulate-chat-task: error — ${error.message}`);
      res.status(500).json({ ok: false, error: error.message });
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

    // demo-plan-run: REMOVED — inline execution forbidden. Use simulate-chat-task to enqueue.

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

    app.post("/api/debug/factory-preview", async (req, res) => {
      try {
        const { previewFactoryDemo } = await import('./supervisor/factory-demo');
        const { normalizeSensorScript } = await import('./supervisor/factory-sim');
        const scenario = req.body?.scenario || 'moisture_high';
        const maxScrapPercent = req.body?.max_scrap_percent ?? req.body?.maxScrapPercent ?? 2.0;
        const energyPriceBand = req.body?.energy_price_band || req.body?.energyPriceBand || 'standard';
        const rawSensorScript = req.body?.demo_sensor_script ?? req.body?.sensor_script;
        const demoSensorScript = rawSensorScript ? normalizeSensorScript(rawSensorScript) : undefined;

        console.log(`[DEBUG] Factory preview — scenario=${scenario} max_scrap=${maxScrapPercent}% energy_band=${energyPriceBand}${demoSensorScript ? ' sensor_script=YES' : ''}`);

        const result = previewFactoryDemo({
          scenario,
          maxScrapPercent,
          energyPriceBand,
          demoSensorScript,
        });

        res.json(result);
      } catch (err: any) {
        console.error(`[DEBUG] Factory preview error:`, err.message);
        res.status(500).json({ error: err.message });
      }
    });

    app.post("/api/debug/factory-demo", async (req, res) => {
      try {
        const { executeFactoryDemo } = await import('./supervisor/factory-demo');
        const { randomUUID } = await import('crypto');
        const scenario = req.body?.scenario || 'moisture_high';
        const maxScrapPercent = req.body?.max_scrap_percent ?? req.body?.maxScrapPercent ?? 2.0;
        const energyPriceBand = req.body?.energy_price_band || req.body?.energyPriceBand || 'standard';
        const { normalizeSensorScript } = await import('./supervisor/factory-sim');
        const rawSensorScript = req.body?.demo_sensor_script ?? req.body?.sensor_script;
        const demoSensorScript = rawSensorScript ? normalizeSensorScript(rawSensorScript) : undefined;
        const runId = randomUUID();
        const userId = req.body?.user_id || 'debug-user';

        console.log(`[DEBUG] Running factory demo — scenario=${scenario} max_scrap=${maxScrapPercent}% energy_band=${energyPriceBand}${demoSensorScript ? ' sensor_script=YES' : ''}`);

        const result = await executeFactoryDemo({
          runId,
          userId,
          scenario,
          maxScrapPercent,
          energyPriceBand,
          demoSensorScript,
        });

        const artefacts = await storage.getArtefactsByRunId(runId);

        res.json({
          runId,
          result,
          artefacts: artefacts.map(a => ({
            id: a.id,
            type: a.type,
            title: a.title,
            summary: a.summary,
            createdAt: a.createdAt,
          })),
        });
      } catch (error: any) {
        console.error("[DEBUG] Factory demo error:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.post("/api/debug/run-narrative", async (req, res) => {
      try {
        const { generateRunNarrative } = await import('./supervisor/run-narrative');
        const { runId, run_type } = req.body;
        if (!runId) return res.status(400).json({ error: 'runId is required' });
        const runType = run_type || 'factory_demo';
        const userId = req.body?.user_id || 'debug-user';

        console.log(`[DEBUG] Generating narrative — runId=${runId} type=${runType}`);
        const result = await generateRunNarrative({ runId, runType, userId });
        res.json({ runId, tldr: result.tldr, narrative: result.narrative, facts_bundle: result.factsBundle });
      } catch (error: any) {
        console.error("[DEBUG] Narrative generation error:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.get("/api/debug/task-queue", async (req, res) => {
      if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
      try {
        const limit = Math.min(Number(req.query.limit) || 20, 50);
        const { data, error } = await supabase
          .from('supervisor_tasks')
          .select('id, status, task_type, created_at, run_id, client_request_id, user_id, conversation_id')
          .order('created_at', { ascending: false })
          .limit(limit);

        if (error) throw error;

        const summary = {
          total: data?.length || 0,
          by_status: {} as Record<string, number>,
          tasks: (data || []).map(t => ({
            ...t,
            created_at_readable: new Date(Number(t.created_at) || t.created_at).toISOString(),
            age_seconds: Math.round((Date.now() - (Number(t.created_at) || 0)) / 1000),
          })),
        };
        for (const t of data || []) {
          summary.by_status[t.status] = (summary.by_status[t.status] || 0) + 1;
        }
        res.json(summary);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get("/api/debug/run-trace", async (req, res) => {
      try {
        const crid = req.query.crid as string | undefined;
        const runId = req.query.runId as string | undefined;

        if (!crid && !runId) {
          return res.status(400).json({ error: "At least one of crid or runId is required" });
        }

        const { eq: eqOp, desc: descOp } = await import('drizzle-orm');
        const { agentRuns: agentRunsTable } = await import('./schema');
        const { db: dbConn } = await import('./db');

        let matchedRun: AgentRun | undefined;
        let resolvedRunId = runId;

        if (crid) {
          const runs = await dbConn
            .select()
            .from(agentRunsTable)
            .where(eqOp(agentRunsTable.clientRequestId, crid))
            .orderBy(descOp(agentRunsTable.createdAt))
            .limit(1);
          if (runs.length > 0) {
            matchedRun = runs[0];
            resolvedRunId = resolvedRunId || matchedRun.id;
          }
        }

        if (!matchedRun && resolvedRunId) {
          const runs = await dbConn
            .select()
            .from(agentRunsTable)
            .where(eqOp(agentRunsTable.id, resolvedRunId))
            .limit(1);
          if (runs.length > 0) matchedRun = runs[0];
        }

        let afrEvents: { action_taken: string; status: string; timestamp: number; metadata: any; run_id: string }[] = [];
        if (supabase) {
          if (resolvedRunId) {
            const { data: activities } = await supabase
              .from('agent_activities')
              .select('action_taken, status, timestamp, metadata, run_id')
              .eq('run_id', resolvedRunId)
              .order('timestamp', { ascending: true })
              .limit(200);
            if (activities) afrEvents = activities;
          }

          if (crid && afrEvents.length === 0) {
            const { data: cridActivities } = await supabase
              .from('agent_activities')
              .select('action_taken, status, timestamp, metadata, run_id')
              .contains('metadata', { clientRequestId: crid })
              .order('timestamp', { ascending: true })
              .limit(200);
            if (cridActivities && cridActivities.length > 0) {
              afrEvents = cridActivities;
              const afrRunId = cridActivities[0].run_id;
              if (!resolvedRunId && afrRunId) resolvedRunId = afrRunId;
              if (!matchedRun && afrRunId) {
                const runs = await dbConn
                  .select()
                  .from(agentRunsTable)
                  .where(eqOp(agentRunsTable.id, afrRunId))
                  .limit(1);
                if (runs.length > 0) matchedRun = runs[0];
              }
            }
          }
        }

        const supervisorReceivedRequest = !!matchedRun;

        let runArtefacts: Artefact[] = [];
        let towerJudgementRows: TowerJudgement[] = [];

        if (resolvedRunId) {
          runArtefacts = await storage.getArtefactsByRunId(resolvedRunId);
          towerJudgementRows = await storage.getTowerJudgementsByRunId(resolvedRunId);
        }

        const planResultArtefact = runArtefacts.find(a => a.type === 'plan_result');
        const planPayload = planResultArtefact?.payloadJson as Record<string, unknown> | null;

        const planSummary = planPayload
          ? {
              plan_version: (planPayload.plan_version as string) || 'v1',
              step_count: (planPayload.totalSteps as number) || (planPayload.stepsCompleted as number) || 0,
              tool_names: (planPayload.tools_used as string[]) || [],
            }
          : null;

        const stepsExecuted = runArtefacts
          .filter(a => a.type === 'step_result')
          .map(a => {
            const p = a.payloadJson as Record<string, unknown> | null;
            return {
              step_index: p?.step_index ?? null,
              step_title: p?.step_title ?? a.title,
              step_type: p?.step_type ?? null,
              step_status: p?.step_status ?? null,
              artefact_id: a.id,
            };
          });

        const artefactsSummary = runArtefacts.map(a => ({
          id: a.id,
          type: a.type,
          title: a.title,
          summary: a.summary,
          created_at: a.createdAt,
        }));

        const artefactCreatedEvents = afrEvents.filter(e => e.action_taken === 'artefact_created');

        const TOWER_START_ACTIONS = ['judgement_requested', 'tower_call_started'];
        const TOWER_COMPLETE_ACTIONS = ['judgement_received', 'tower_call_completed', 'tower_evaluation_completed'];
        const TOWER_VERDICT_ACTIONS = ['tower_evaluation_completed', 'tower_decision_stop', 'tower_decision_change_plan', 'tower_verdict'];

        const towerCallStartedEvents = afrEvents.filter(e => TOWER_START_ACTIONS.includes(e.action_taken));
        const towerCallCompletedEvents = afrEvents.filter(e => TOWER_COMPLETE_ACTIONS.includes(e.action_taken));

        const towerCallsFromAfr = towerCallStartedEvents.map((startEvt, idx) => {
          const completedEvt = towerCallCompletedEvents[idx];
          return {
            request_payload_summary: startEvt.metadata || {},
            response_status: completedEvt ? completedEvt.status : 'no_response',
            verdict: completedEvt?.metadata?.verdict || completedEvt?.metadata?.tower_verdict || null,
          };
        });

        const towerCallsFromDb = towerJudgementRows.map(j => ({
          artefact_id: j.artefactId,
          verdict: j.verdict,
          action: j.action,
          reasons: j.reasons,
          created_at: j.createdAt,
        }));

        const towerCalls = {
          from_afr_events: towerCallsFromAfr,
          from_db: towerCallsFromDb,
        };

        const didTowerCallPerArtefact: Record<string, boolean> = {};
        for (const a of artefactsSummary) {
          const hasDbJudgement = towerJudgementRows.some(j => j.artefactId === a.id);
          const hasAfrTowerEvent = afrEvents.some(
            e => TOWER_START_ACTIONS.includes(e.action_taken) &&
              (e.metadata?.artefactId === a.id || e.metadata?.artefact_id === a.id)
          );
          didTowerCallPerArtefact[a.id] = hasDbJudgement || hasAfrTowerEvent;
        }

        const relevantAfrActionNames = [
          'artefact_created',
          ...TOWER_START_ACTIONS,
          ...TOWER_COMPLETE_ACTIONS,
          ...TOWER_VERDICT_ACTIONS,
        ];
        const relevantAfrSet = new Set(relevantAfrActionNames);

        const afrEventsEmitted = afrEvents
          .filter(e => relevantAfrSet.has(e.action_taken))
          .map(e => ({
            event_type: e.action_taken,
            timestamp: e.timestamp,
            status: e.status,
          }));

        const hasArtefacts = runArtefacts.length > 0 || artefactCreatedEvents.length > 0;
        const anyTowerAttempted = towerCallStartedEvents.length > 0 || towerJudgementRows.length > 0;
        const anyTowerCompleted = towerCallCompletedEvents.length > 0 || towerJudgementRows.length > 0;
        const anyVerdictPresent = towerCallCompletedEvents.some(
          e => e.metadata?.verdict || e.metadata?.tower_verdict
        ) || towerJudgementRows.some(j => !!j.verdict);
        const verdictEmittedInAfr = afrEvents.some(e => TOWER_VERDICT_ACTIONS.includes(e.action_taken));
        const afrEmitWorked = afrEvents.length > 0;

        let suspectedBreakpoint: string;
        if (!anyTowerAttempted && hasArtefacts) {
          suspectedBreakpoint = 'tower_call_never_attempted';
        } else if (anyTowerAttempted && !anyTowerCompleted) {
          suspectedBreakpoint = 'tower_call_failed';
        } else if (anyTowerCompleted && !anyVerdictPresent) {
          suspectedBreakpoint = 'tower_return_missing_fields';
        } else if (anyVerdictPresent && !verdictEmittedInAfr) {
          suspectedBreakpoint = 'tower_verdict_not_emitted';
        } else if (supervisorReceivedRequest && !afrEmitWorked) {
          suspectedBreakpoint = 'afr_emit_failed';
        } else {
          suspectedBreakpoint = 'all_good';
        }

        res.json({
          run_ref: {
            resolved_run_id: resolvedRunId || null,
            crid: crid || null,
            supervisor_received_request: supervisorReceivedRequest,
            run_status: matchedRun?.status || null,
            terminal_state: matchedRun?.terminalState || null,
          },
          plan_summary: planSummary,
          steps_executed: stepsExecuted,
          artefacts: artefactsSummary,
          tower_calls: towerCalls,
          tower_attempted_per_artefact: didTowerCallPerArtefact,
          afr_events_emitted: afrEventsEmitted,
          suspected_breakpoint: suspectedBreakpoint,
        });
      } catch (error: any) {
        console.error("[DEBUG] run-trace error:", error);
        res.status(500).json({ error: error.message || "Failed to generate run trace" });
      }
    });
    // proof/tower-loop and proof/tower-loop-v2: REMOVED — inline execution forbidden.
    // All execution must go through supervisor_tasks queue. Use simulate-chat-task to enqueue.

  } else {
    console.log('[DEBUG] Debug endpoints disabled (ENABLE_DEBUG_ENDPOINTS !== "true" or NODE_ENV === "production")');
  }

  app.post("/api/dev/explain-run", handleExplainRun);
  console.log('[DEBUG] Registered: POST /api/dev/explain-run');

  // TEMP DEV TEST HARNESS
  // Used only for tool verification
  // Remove after tools are validated
  if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
    const { executeWebVisit } = await import('./supervisor/web-visit');
    const { executeContactExtract } = await import('./supervisor/contact-extract');
    const { executeWebSearch } = await import('./supervisor/web-search');
    const { executeAskLeadQuestion } = await import('./supervisor/ask-lead-question');
    const { executeLeadEnrich } = await import('./supervisor/lead-enrich');

    const SUPPORTED_TOOLS = ['WEB_VISIT', 'CONTACT_EXTRACT', 'WEB_SEARCH', 'ASK_LEAD_QUESTION', 'LEAD_ENRICH'] as const;
    type SupportedTool = typeof SUPPORTED_TOOLS[number];

    app.get("/api/dev/ping", (_req, res) => {
      res.json({ ok: true, node_env: process.env.NODE_ENV ?? null });
    });

    app.post("/api/dev/run-tool", async (req, res) => {
      try {
        const { tool, run_id, goal_id, inputs } = req.body || {};

        if (!tool || typeof tool !== 'string') {
          return res.status(400).json({ error: 'tool is required' });
        }
        if (!SUPPORTED_TOOLS.includes(tool as SupportedTool)) {
          return res.status(400).json({ error: `tool must be one of: ${SUPPORTED_TOOLS.join(', ')}` });
        }
        if (!run_id || typeof run_id !== 'string') {
          return res.status(400).json({ error: 'run_id is required' });
        }
        if (!inputs || typeof inputs !== 'object') {
          return res.status(400).json({ error: 'inputs is required and must be an object' });
        }

        let envelope: unknown;

        switch (tool as SupportedTool) {
          case 'WEB_VISIT':
            envelope = await executeWebVisit(
              {
                url: inputs.url,
                max_pages: inputs.max_pages ?? 3,
                page_hints: inputs.page_hints,
                same_domain_only: inputs.same_domain_only,
              },
              run_id,
              goal_id,
            );
            break;

          case 'CONTACT_EXTRACT':
            envelope = executeContactExtract(
              {
                pages: inputs.pages ?? [],
                entity_name: inputs.entity_name ?? null,
              },
              run_id,
              goal_id,
            );
            break;

          case 'WEB_SEARCH':
            envelope = await executeWebSearch(
              {
                query: inputs.query,
                location_hint: inputs.location_hint ?? null,
                entity_name: inputs.entity_name ?? null,
                limit: inputs.limit ?? 5,
              },
              run_id,
              goal_id,
            );
            break;

          case 'ASK_LEAD_QUESTION':
            envelope = await executeAskLeadQuestion(
              {
                lead: inputs.lead,
                intent_question: inputs.intent_question,
                evidence_query: inputs.evidence_query,
                search_budget: inputs.search_budget ?? 3,
                visit_budget: inputs.visit_budget ?? 3,
              },
              run_id,
              goal_id,
            );
            break;

          case 'LEAD_ENRICH':
            envelope = executeLeadEnrich(
              {
                places_lead: inputs.places_lead ?? null,
                web_visit_pages: inputs.web_visit_pages ?? null,
                contact_extract: inputs.contact_extract ?? null,
                ask_lead_question_result: inputs.ask_lead_question_result ?? null,
                web_search: inputs.web_search ?? null,
              },
              run_id,
              goal_id,
            );
            break;
        }

        res.json(envelope);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[DEV_RUN_TOOL] Error: ${msg}`);
        res.status(500).json({ error: msg });
      }
    });

    console.log('[DEV] Registered: GET /api/dev/ping');
    console.log('[DEV] Registered: POST /api/dev/run-tool (tool test harness)');
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

  app.get("/api/afr/behaviour-judge", async (req, res) => {
    const runId = req.query.run_id as string;
    if (!runId) {
      return res.status(400).json({ error: "run_id query parameter is required" });
    }
    if (!supabase) {
      return res.status(503).json({ error: "Supabase not configured" });
    }
    try {
      const { data, error } = await supabase
        .from("behaviour_judge_results")
        .select("*")
        .eq("run_id", runId)
        .maybeSingle();
      if (error) {
        console.error("[BEHAVIOUR_JUDGE] Query error:", error.message);
        return res.status(500).json({ error: error.message });
      }
      return res.json(data ?? null);
    } catch (err: any) {
      console.error("[BEHAVIOUR_JUDGE] Unexpected error:", err.message);
      return res.status(500).json({ error: err.message || "Failed to fetch behaviour judge result" });
    }
  });

  app.get("/api/afr/runs/:runId/snapshot", async (req, res) => {
    try {
      const { runId } = req.params;
      if (!runId) {
        return res.status(400).json({ error: "runId is required" });
      }
      const snapshot = await storage.getRunSnapshot(runId);
      res.json(snapshot);
    } catch (error: any) {
      console.error(`[RUN_SNAPSHOT] Error fetching snapshot for runId=${req.params.runId}: ${error.message}`);
      res.status(500).json({ error: error.message || "Failed to fetch run snapshot" });
    }
  });
  console.log('[DEBUG] Registered: GET /api/afr/runs/:runId/snapshot');

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

  // ─── REQUEST JUDGEMENT (manual Tower validation for existing runs) ───
  app.post('/api/supervisor/request-judgement', async (req, res) => {
    const { logAFREvent: logEvt } = await import('./supervisor/afr-logger');
    const { judgeArtefact } = await import('./supervisor/tower-artefact-judge');

    const runId = (req.body.runId || req.body.run_id || '') as string;
    const crid = (req.body.crid || req.body.clientRequestId || '') as string;
    const userId = getUserId(req);
    const conversationId = (req.body.conversationId || req.body.conversation_id || '') as string;
    const goal = (req.body.goal || 'Manual judgement request') as string;

    console.log(`[REQUEST_JUDGEMENT] hit — runId=${runId} crid=${crid} userId=${userId}`);

    if (!runId) {
      console.log('[REQUEST_JUDGEMENT] rejected: missing runId');
      return res.status(400).json({ ok: false, error: 'runId is required' });
    }

    try {
      const artefacts = await storage.getArtefactsByRunId(runId);
      const leadsArtefact = artefacts
        .filter((a: Artefact) => a.type === 'leads_list')
        .sort((a: Artefact, b: Artefact) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

      if (!leadsArtefact) {
        console.log(`[REQUEST_JUDGEMENT] no leads_list artefact found for runId=${runId} (found ${artefacts.length} total artefacts)`);
        return res.status(404).json({ ok: false, error: 'No leads_list artefact found for this run' });
      }

      console.log(`[REQUEST_JUDGEMENT] found leads_list artefact id=${leadsArtefact.id} for runId=${runId}`);

      await logEvt({
        userId, runId, conversationId, clientRequestId: crid || undefined,
        actionTaken: 'tower_call_started', status: 'pending',
        taskGenerated: `Manual Tower judgement requested for artefact ${leadsArtefact.id}`,
        runType: 'plan',
        metadata: { artefactId: leadsArtefact.id, source: 'request_judgement', crid },
      });
      console.log(`[REQUEST_JUDGEMENT] emitted tower_call_started AFR — runId=${runId}`);

      let towerResult;
      try {
        towerResult = await judgeArtefact({
          artefact: leadsArtefact,
          runId,
          goal,
          userId,
          conversationId: conversationId || undefined,
          successCriteria: { min_leads: 1 },
        });
      } catch (towerErr: any) {
        const errMsg = towerErr.message || 'Tower call failed';
        console.error(`[REQUEST_JUDGEMENT] Tower call threw: ${errMsg}`);

        await logEvt({
          userId, runId, conversationId, clientRequestId: crid || undefined,
          actionTaken: 'tower_verdict', status: 'failed',
          taskGenerated: `Tower error: ${errMsg}`,
          runType: 'plan',
          metadata: { artefactId: leadsArtefact.id, verdict: 'error', error: errMsg, source: 'request_judgement' },
        });

        let errorArtefactId: string | null = null;
        try {
          const { createArtefact } = await import('./supervisor/artefacts');
          const errorArt = await createArtefact({
            runId, type: 'tower_judgement', userId, conversationId: conversationId || undefined,
            title: 'Tower Verdict: ERROR',
            summary: errMsg,
            payload: { verdict: 'error', error: errMsg, source: 'request_judgement', artefactId: leadsArtefact.id },
          });
          errorArtefactId = errorArt.id;
        } catch (artErr: any) {
          console.error(`[REQUEST_JUDGEMENT] failed to persist error artefact: ${artErr.message}`);
        }

        return res.json({ ok: false, error: errMsg, tower_judgement_artefact_id: errorArtefactId });
      }

      console.log(`[REQUEST_JUDGEMENT] Tower verdict: ${towerResult.judgement.verdict} action=${towerResult.judgement.action} stubbed=${towerResult.stubbed}`);

      await logEvt({
        userId, runId, conversationId, clientRequestId: crid || undefined,
        actionTaken: 'tower_verdict', status: towerResult.shouldStop ? 'failed' : 'success',
        taskGenerated: `Tower verdict: ${towerResult.judgement.verdict}`,
        runType: 'plan',
        metadata: {
          artefactId: leadsArtefact.id,
          verdict: towerResult.judgement.verdict,
          action: towerResult.judgement.action,
          stubbed: towerResult.stubbed,
          source: 'request_judgement',
        },
      });
      console.log(`[REQUEST_JUDGEMENT] emitted tower_verdict AFR — runId=${runId} verdict=${towerResult.judgement.verdict}`);

      const judgementArtefacts = (await storage.getArtefactsByRunId(runId))
        .filter((a: Artefact) => a.type === 'tower_judgement')
        .sort((a: Artefact, b: Artefact) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const judgementArtefactId = judgementArtefacts[0]?.id || null;

      console.log(`[REQUEST_JUDGEMENT] complete — runId=${runId} tower_judgement_artefact_id=${judgementArtefactId}`);

      return res.json({
        ok: true,
        tower_judgement_artefact_id: judgementArtefactId,
        verdict: towerResult.judgement.verdict,
        action: towerResult.judgement.action,
        stubbed: towerResult.stubbed,
      });
    } catch (err: any) {
      console.error(`[REQUEST_JUDGEMENT] unexpected error: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
  console.log('[DEBUG] Registered: POST /api/supervisor/request-judgement');

  // ─── ALIAS: /api/afr/rerun-judgement → same handler (UI calls this path) ───
  app.post('/api/afr/rerun-judgement', async (req, res) => {
    const { logAFREvent: logEvt } = await import('./supervisor/afr-logger');
    const { judgeArtefact } = await import('./supervisor/tower-artefact-judge');

    const runId = (req.body.runId || req.body.run_id || '') as string;
    const crid = (req.body.crid || req.body.clientRequestId || '') as string;
    const userId = getUserId(req);
    const conversationId = (req.body.conversationId || req.body.conversation_id || '') as string;
    const goal = (req.body.goal || 'Manual judgement request') as string;

    console.log(`[REQUEST_JUDGEMENT] hit via /api/afr/rerun-judgement — runId=${runId} crid=${crid} userId=${userId}`);

    if (!runId) {
      console.log('[REQUEST_JUDGEMENT] rejected: missing runId');
      return res.status(400).json({ ok: false, error: 'runId is required' });
    }

    try {
      const artefacts = await storage.getArtefactsByRunId(runId);
      const leadsArtefact = artefacts
        .filter((a: Artefact) => a.type === 'leads_list')
        .sort((a: Artefact, b: Artefact) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

      if (!leadsArtefact) {
        console.log(`[REQUEST_JUDGEMENT] no leads_list artefact found for runId=${runId} (found ${artefacts.length} total artefacts)`);
        return res.status(404).json({ ok: false, error: 'No leads_list artefact found for this run' });
      }

      console.log(`[REQUEST_JUDGEMENT] found leads_list artefact id=${leadsArtefact.id} for runId=${runId}`);

      await logEvt({
        userId, runId, conversationId, clientRequestId: crid || undefined,
        actionTaken: 'tower_call_started', status: 'pending',
        taskGenerated: `Manual Tower judgement requested for artefact ${leadsArtefact.id}`,
        runType: 'plan',
        metadata: { artefactId: leadsArtefact.id, source: 'request_judgement', crid },
      });
      console.log(`[REQUEST_JUDGEMENT] emitted tower_call_started AFR — runId=${runId}`);

      let towerResult;
      try {
        towerResult = await judgeArtefact({
          artefact: leadsArtefact,
          runId,
          goal,
          userId,
          conversationId: conversationId || undefined,
          successCriteria: { min_leads: 1 },
        });
      } catch (towerErr: any) {
        const errMsg = towerErr.message || 'Tower call failed';
        console.error(`[REQUEST_JUDGEMENT] Tower call threw: ${errMsg}`);

        await logEvt({
          userId, runId, conversationId, clientRequestId: crid || undefined,
          actionTaken: 'tower_verdict', status: 'failed',
          taskGenerated: `Tower error: ${errMsg}`,
          runType: 'plan',
          metadata: { artefactId: leadsArtefact.id, verdict: 'error', error: errMsg, source: 'request_judgement' },
        });

        let errorArtefactId: string | null = null;
        try {
          const { createArtefact } = await import('./supervisor/artefacts');
          const errorArt = await createArtefact({
            runId, type: 'tower_judgement', userId, conversationId: conversationId || undefined,
            title: 'Tower Verdict: ERROR',
            summary: errMsg,
            payload: { verdict: 'error', error: errMsg, source: 'request_judgement', artefactId: leadsArtefact.id },
          });
          errorArtefactId = errorArt.id;
        } catch (artErr: any) {
          console.error(`[REQUEST_JUDGEMENT] failed to persist error artefact: ${artErr.message}`);
        }

        return res.json({ ok: false, error: errMsg, tower_judgement_artefact_id: errorArtefactId });
      }

      console.log(`[REQUEST_JUDGEMENT] Tower verdict: ${towerResult.judgement.verdict} action=${towerResult.judgement.action} stubbed=${towerResult.stubbed}`);

      await logEvt({
        userId, runId, conversationId, clientRequestId: crid || undefined,
        actionTaken: 'tower_verdict', status: towerResult.shouldStop ? 'failed' : 'success',
        taskGenerated: `Tower verdict: ${towerResult.judgement.verdict}`,
        runType: 'plan',
        metadata: {
          artefactId: leadsArtefact.id,
          verdict: towerResult.judgement.verdict,
          action: towerResult.judgement.action,
          stubbed: towerResult.stubbed,
          source: 'request_judgement',
        },
      });
      console.log(`[REQUEST_JUDGEMENT] emitted tower_verdict AFR — runId=${runId} verdict=${towerResult.judgement.verdict}`);

      const judgementArtefacts = (await storage.getArtefactsByRunId(runId))
        .filter((a: Artefact) => a.type === 'tower_judgement')
        .sort((a: Artefact, b: Artefact) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const judgementArtefactId = judgementArtefacts[0]?.id || null;

      console.log(`[REQUEST_JUDGEMENT] complete — runId=${runId} tower_judgement_artefact_id=${judgementArtefactId}`);

      return res.json({
        ok: true,
        tower_judgement_artefact_id: judgementArtefactId,
        verdict: towerResult.judgement.verdict,
        action: towerResult.judgement.action,
        stubbed: towerResult.stubbed,
      });
    } catch (err: any) {
      console.error(`[REQUEST_JUDGEMENT] unexpected error: ${err.message}`);
      console.error(`[REQUEST_JUDGEMENT] stack: ${err.stack}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
  console.log('[DEBUG] Registered: POST /api/afr/rerun-judgement');

  // ============================================================
  // Feedback Signal Logging Endpoints
  // ============================================================

  app.post('/api/feedback/accept', async (req, res) => {
    const { goal_id, run_id, payload } = req.body;
    const userId = getUserId(req);
    if (!goal_id || !run_id) return res.status(400).json({ ok: false, error: 'goal_id and run_id are required' });
    try {
      const event = await storage.createFeedbackEvent({
        userId,
        goalId: goal_id,
        runId: run_id,
        eventType: 'accept_result',
        payload: payload || {},
      });
      await storage.updateGoalStatus(goal_id, 'COMPLETE');
      return res.json({ ok: true, event_id: event.eventId });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/feedback/retry', async (req, res) => {
    const { goal_id, run_id, payload } = req.body;
    const userId = getUserId(req);
    if (!goal_id || !run_id) return res.status(400).json({ ok: false, error: 'goal_id and run_id are required' });
    try {
      const event = await storage.createFeedbackEvent({
        userId,
        goalId: goal_id,
        runId: run_id,
        eventType: 'retry_goal',
        payload: payload || {},
      });
      await storage.updateGoalStatus(goal_id, 'ACTIVE');
      return res.json({ ok: true, event_id: event.eventId });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/feedback/abandon', async (req, res) => {
    const { goal_id, run_id, payload } = req.body;
    const userId = getUserId(req);
    if (!goal_id || !run_id) return res.status(400).json({ ok: false, error: 'goal_id and run_id are required' });
    try {
      const event = await storage.createFeedbackEvent({
        userId,
        goalId: goal_id,
        runId: run_id,
        eventType: 'abandon_goal',
        payload: payload || {},
      });
      await storage.updateGoalStatus(goal_id, 'STOPPED', { reason: 'User abandoned goal', ...(payload || {}) });
      return res.json({ ok: true, event_id: event.eventId });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/feedback/export', async (req, res) => {
    const { goal_id, run_id, payload } = req.body;
    const userId = getUserId(req);
    if (!goal_id || !run_id) return res.status(400).json({ ok: false, error: 'goal_id and run_id are required' });
    try {
      const event = await storage.createFeedbackEvent({
        userId,
        goalId: goal_id,
        runId: run_id,
        eventType: 'export_data',
        payload: payload || {},
      });
      return res.json({ ok: true, event_id: event.eventId });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  console.log('[DEBUG] Registered: POST /api/feedback/accept, /api/feedback/retry, /api/feedback/abandon, /api/feedback/export');

  app.post('/api/telemetry', async (req, res) => {
    const { run_id, event_type, payload } = req.body;
    if (!run_id || !event_type) {
      return res.status(400).json({ ok: false, error: 'run_id and event_type are required' });
    }
    try {
      const existingRun = await storage.getArtefactsByRunId(run_id);
      const agentRuns = await storage.getAgentRuns();
      const runExists = agentRuns.some(r => r.id === run_id) || existingRun.length > 0;
      if (!runExists) {
        return res.status(404).json({ ok: false, error: `run_id ${run_id} not found` });
      }
      const event = await storage.createTelemetryEvent({
        runId: run_id,
        eventType: event_type,
        payload: payload || {},
      });
      return res.json({ ok: true, event_id: event.id });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  console.log('[DEBUG] Registered: POST /api/telemetry');

  app.post('/api/policy/reset', async (req, res) => {
    const { scope_key } = req.body;
    if (!scope_key || typeof scope_key !== 'string') {
      return res.status(400).json({ ok: false, error: 'scope_key is required (string)' });
    }
    try {
      const { GLOBAL_DEFAULT_BUNDLE } = await import('./supervisor/learning-layer');
      const existing = await storage.getLatestPolicyVersion(scope_key);
      const nextVersion = existing ? existing.version + 1 : 1;
      const pv = await storage.createPolicyVersion({
        scopeKey: scope_key,
        version: nextVersion,
        policyData: {
          ...structuredClone(GLOBAL_DEFAULT_BUNDLE) as unknown as Record<string, unknown>,
          reset_reason: 'user_reset',
        },
        source: 'user_reset',
      });
      console.log(`[POLICY_RESET] Scope ${scope_key} reset to defaults as v${nextVersion} (id=${pv.id})`);
      return res.json({ ok: true, policy_version_id: pv.id, version: nextVersion, scope_key });
    } catch (err: any) {
      console.error(`[POLICY_RESET] Failed: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  console.log('[DEBUG] Registered: POST /api/policy/reset');

  const learningUpdateSchema = z.object({
    query_shape_key: z.string().min(1),
    run_id: z.string().min(1),
    updates: z.object({
      default_result_count: z.number().int().positive().optional(),
      verification_level: z.enum(['minimal', 'standard', 'strict']).optional(),
      search_budget_pages: z.number().int().positive().optional(),
      radius_escalation: z.enum(['off', 'allowed', 'aggressive']).optional(),
      stop_if_underfilled: z.boolean().optional(),
    }).refine(obj => Object.keys(obj).length > 0, { message: 'updates must contain at least one knob field' }),
  });

  app.post('/api/learning/update', async (req, res) => {
    const parsed = learningUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: fromError(parsed.error).toString() });
    }
    const { query_shape_key, run_id, updates } = parsed.data;
    try {
      const { handleLearningUpdate } = await import('./supervisor/learning-store');
      await handleLearningUpdate({ query_shape_key, run_id, updates });
      console.log(`[LEARNING_UPDATE] Ingested learning_update for shape_key=${query_shape_key} run_id=${run_id}`);
      return res.json({ ok: true, query_shape_key, run_id, updated_fields: Object.keys(updates) });
    } catch (err: any) {
      console.error(`[LEARNING_UPDATE] Failed: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  console.log('[DEBUG] Registered: POST /api/learning/update');

  registerQaMetricsRoutes(app, supabase);

  const httpServer = createServer(app);
  return httpServer;
}
