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
import { runFeature } from "./services/FeatureRunner";
import type { FeatureType } from "./features/types";
import { 
  saveLead as saveLeadToStore, 
  listSavedLeads,
  type IncomingLeadPayload,
  type SaveLeadResponse,
  type ListLeadsResponse
} from "./features/saveLead";

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

      // Execute plan asynchronously (fire-and-forget)
      console.log(`[PLAN_APPROVE] Kicking off execution for plan ${planId}...`);
      const { startPlanExecution } = await import('./plan-executor');
      startPlanExecution(planId);

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

  const httpServer = createServer(app);
  return httpServer;
}
