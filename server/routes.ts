import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertUserSignalSchema, insertSuggestedLeadSchema } from "@shared/schema";
import { fromError } from "zod-validation-error";
import { supabase } from "./supabase";

export async function registerRoutes(app: Express): Promise<Server> {
  // Get suggested leads for demo user
  app.get("/api/leads", async (req, res) => {
    try {
      // For demo purposes, using a default user ID
      const userId = "demo-user";
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
      const userId = "demo-user";
      
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
