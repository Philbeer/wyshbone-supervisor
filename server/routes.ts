import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertUserSignalSchema, insertSuggestedLeadSchema } from "@shared/schema";
import { fromError } from "zod-validation-error";
import { supabase } from "./supabase";
import { supervisor } from "./supervisor";

export async function registerRoutes(app: Express): Promise<Server> {
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

  const httpServer = createServer(app);
  return httpServer;
}
