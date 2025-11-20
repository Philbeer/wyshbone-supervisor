import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertUserSignalSchema, insertSuggestedLeadSchema } from "@shared/schema";
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

// Helper to get userId from request (simple version for MVP)
function getUserId(req: any): string {
  // Priority: body.userId > query.user_id > default demo user
  return req.body?.userId || req.query?.user_id || "8f9079b3ddf739fb0217373c92292e91";
}

// Execute plan with progress tracking integration
async function executePlanWithProgress(
  plan: LeadGenPlan,
  userContext: SupervisorUserContext,
  sessionId: string
): Promise<void> {
  const planId = plan.id;
  
  // Import event registration functions
  const { registerPlanEventHandler, unregisterPlanEventHandler } = await import("./types/lead-gen-plan");
  
  try {
    console.log(`[EXEC+PROGRESS] Starting execution for plan ${planId}`);

    // Create event handler for this specific plan
    const eventHandler = (eventType: string, payload: any) => {
      if (eventType === "STEP_STARTED") {
        const { stepId } = payload;
        updateStepStatus(sessionId, stepId, "running");
      } else if (eventType === "STEP_SUCCEEDED") {
        const { stepId, attempts } = payload;
        updateStepStatus(sessionId, stepId, "completed", undefined, attempts);
      } else if (eventType === "STEP_FAILED") {
        const { stepId, error, attempts } = payload;
        updateStepStatus(sessionId, stepId, "failed", error, attempts);
      } else if (eventType === "PLAN_COMPLETED") {
        completePlan(sessionId);
      } else if (eventType === "PLAN_FAILED") {
        failPlan(sessionId, payload.error);
      }
    };

    // Register event handler for this plan
    registerPlanEventHandler(planId, eventHandler);

    try {
      // Execute the plan
      const result = await executeLeadGenerationPlan(plan, userContext);

      // Update final status based on result
      if (result.overallStatus === "succeeded") {
        completePlan(sessionId);
        console.log(`[EXEC+PROGRESS] Plan ${planId} completed successfully`);
      } else if (result.overallStatus === "failed") {
        failPlan(sessionId, "Plan execution failed");
        console.log(`[EXEC+PROGRESS] Plan ${planId} failed`);
      }
    } finally {
      // Always unregister handler, even if execution fails
      unregisterPlanEventHandler(planId);
    }

  } catch (error: any) {
    console.error(`[EXEC+PROGRESS] Execution error:`, error);
    failPlan(sessionId, error.message);
    // Ensure cleanup happens even on error
    unregisterPlanEventHandler(planId);
    throw error;
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
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

      // Get user's account ID from Supabase for multi-account isolation
      const { data: userData } = await supabase
        .from('users')
        .select('account_id, email')
        .eq('id', userId)
        .single();

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
    try {
      const userId = getUserId(req);
      const { planId } = req.body;

      if (!planId) {
        return res.status(400).json({ error: "planId is required" });
      }

      // Retrieve plan from database
      const dbPlan = await storage.getPlan(planId);
      if (!dbPlan) {
        return res.status(404).json({ error: "Plan not found" });
      }

      // Validate ownership
      if (dbPlan.userId !== userId) {
        return res.status(403).json({ error: "Not authorized to approve this plan" });
      }

      // Check if already executed
      if (dbPlan.status !== "pending_approval") {
        return res.status(400).json({ error: `Plan is already ${dbPlan.status}` });
      }

      const plan = dbPlan.planData as LeadGenPlan;

      console.log(`[PLAN API] Approved plan ${planId}, starting execution...`);

      // Get user context for execution
      const { data: userData } = await supabase
        .from('users')
        .select('email, account_id')
        .eq('id', userId)
        .single();

      const userContext: SupervisorUserContext = {
        userId,
        accountId: userData?.account_id,
        email: userData?.email || undefined
      };

      // Update plan status to executing
      await storage.updatePlanStatus(planId, "executing");

      // Start progress tracking (use userId as session ID)
      const sessionId = userId;
      startPlanProgress(plan.id, sessionId, plan.steps);

      // Execute plan asynchronously (fire-and-forget)
      executePlanWithProgress(plan, userContext, sessionId).catch(err => {
        console.error(`[PLAN API] Execution error for plan ${planId}:`, err);
        failPlan(sessionId, err.message);
      });

      res.json({ 
        planId: plan.id,
        status: "executing",
        message: "Plan approved and execution started"
      });
    } catch (error: any) {
      console.error("[PLAN API] Error approving plan:", error);
      res.status(500).json({ error: error.message || "Failed to approve plan" });
    }
  });

  // GET /api/plan/progress - Get current execution progress
  app.get("/api/plan/progress", async (req, res) => {
    try {
      const userId = getUserId(req);
      const sessionId = userId; // Using userId as session ID

      const progress = getProgress(sessionId);

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

  // ========================================
  // EXISTING ENDPOINTS
  // ========================================

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

  const httpServer = createServer(app);
  return httpServer;
}
