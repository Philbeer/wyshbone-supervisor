// Referenced from blueprint:javascript_database
import { 
  users, 
  suggestedLeads, 
  userSignals,
  processedSignals,
  supervisorState,
  planExecutions,
  plans,
  type User, 
  type InsertUser, 
  type SuggestedLead, 
  type UserSignal,
  type PlanExecution,
  type Plan,
  type InsertSuggestedLead,
  type InsertUserSignal,
  type InsertPlanExecution,
  type InsertPlan
} from "@shared/schema";
import { db } from "./db";
import { eq, desc } from "drizzle-orm";
import { supabase } from "./supabase";

export interface SupervisorCheckpoint {
  timestamp: Date | null;
  id: string | null;
}

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getSuggestedLeads(userId: string): Promise<SuggestedLead[]>;
  getSuggestedLeadsByAccount(accountId: string): Promise<SuggestedLead[]>; // SUP-12
  getRecentSignals(userId: string): Promise<UserSignal[]>;
  createSuggestedLead(lead: InsertSuggestedLead): Promise<SuggestedLead>;
  createSignal(signal: InsertUserSignal): Promise<UserSignal>;
  isSignalProcessed(signalId: string, source: string): Promise<boolean>;
  markSignalProcessed(signalId: string, source: string, signalCreatedAt: Date): Promise<void>;
  getSupervisorCheckpoint(source: string): Promise<SupervisorCheckpoint>;
  updateSupervisorCheckpoint(source: string, timestamp: Date, id: string): Promise<void>;
  getUserEmail(userId: string): Promise<{ email: string; name?: string } | null>;
  createPlanExecution(execution: InsertPlanExecution): Promise<PlanExecution>;
  getPlanExecutions(userId: string, limit?: number): Promise<PlanExecution[]>;
  getPlanExecutionsByGoal(goalId: string, limit?: number): Promise<PlanExecution[]>;
  createPlan(plan: InsertPlan): Promise<Plan>;
  getPlan(planId: string): Promise<Plan | undefined>;
  updatePlan(planId: string, updates: Partial<InsertPlan>): Promise<void>;
  updatePlanStatus(planId: string, status: string): Promise<void>;
  getUserActivePlan(userId: string): Promise<Plan | undefined>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getSuggestedLeads(userId: string): Promise<SuggestedLead[]> {
    const leads = await db
      .select()
      .from(suggestedLeads)
      .where(eq(suggestedLeads.userId, userId))
      .orderBy(desc(suggestedLeads.score));
    return leads;
  }

  // SUP-12: Get leads by account for stale leads detection
  async getSuggestedLeadsByAccount(accountId: string): Promise<SuggestedLead[]> {
    const leads = await db
      .select()
      .from(suggestedLeads)
      .where(eq(suggestedLeads.accountId, accountId))
      .orderBy(desc(suggestedLeads.createdAt));
    return leads;
  }

  async getRecentSignals(userId: string): Promise<UserSignal[]> {
    const signals = await db
      .select()
      .from(userSignals)
      .where(eq(userSignals.userId, userId))
      .orderBy(desc(userSignals.createdAt))
      .limit(20);
    return signals;
  }

  async createSuggestedLead(lead: InsertSuggestedLead): Promise<SuggestedLead> {
    const [newLead] = await db
      .insert(suggestedLeads)
      .values(lead)
      .returning();
    return newLead;
  }

  async createSignal(signal: InsertUserSignal): Promise<UserSignal> {
    const [newSignal] = await db
      .insert(userSignals)
      .values(signal)
      .returning();
    return newSignal;
  }

  async isSignalProcessed(signalId: string, source: string): Promise<boolean> {
    const [record] = await db
      .select()
      .from(processedSignals)
      .where(eq(processedSignals.signalId, `${source}:${signalId}`))
      .limit(1);
    return !!record;
  }

  async markSignalProcessed(signalId: string, source: string, signalCreatedAt: Date): Promise<void> {
    await db
      .insert(processedSignals)
      .values({
        signalId: `${source}:${signalId}`,
        signalSource: source,
        signalCreatedAt: signalCreatedAt
      });
  }

  async getSupervisorCheckpoint(source: string): Promise<SupervisorCheckpoint> {
    const [record] = await db
      .select()
      .from(supervisorState)
      .where(eq(supervisorState.source, source))
      .limit(1);
    
    return {
      timestamp: record?.lastProcessedTimestamp || null,
      id: record?.lastProcessedId || null
    };
  }

  async updateSupervisorCheckpoint(source: string, timestamp: Date, id: string): Promise<void> {
    const existing = await db
      .select()
      .from(supervisorState)
      .where(eq(supervisorState.source, source))
      .limit(1);
    
    if (existing.length > 0) {
      await db
        .update(supervisorState)
        .set({
          lastProcessedTimestamp: timestamp,
          lastProcessedId: id,
          updatedAt: new Date()
        })
        .where(eq(supervisorState.source, source));
    } else {
      await db
        .insert(supervisorState)
        .values({
          source,
          lastProcessedTimestamp: timestamp,
          lastProcessedId: id
        });
    }
  }

  async getUserEmail(userId: string): Promise<{ email: string; name?: string } | null> {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('email, name')
        .eq('id', userId)
        .single();
      
      if (error || !data) {
        console.log(`⚠️  No email found for user ${userId}`);
        return null;
      }
      
      return {
        email: data.email,
        name: data.name || undefined
      };
    } catch (error) {
      console.error(`Error fetching user email for ${userId}:`, error);
      return null;
    }
  }

  async createPlanExecution(execution: InsertPlanExecution): Promise<PlanExecution> {
    const [newExecution] = await db
      .insert(planExecutions)
      .values(execution)
      .returning();
    return newExecution;
  }

  async getPlanExecutions(userId: string, limit: number = 50): Promise<PlanExecution[]> {
    const executions = await db
      .select()
      .from(planExecutions)
      .where(eq(planExecutions.userId, userId))
      .orderBy(desc(planExecutions.createdAt))
      .limit(limit);
    return executions;
  }

  async getPlanExecutionsByGoal(goalId: string, limit: number = 50): Promise<PlanExecution[]> {
    const executions = await db
      .select()
      .from(planExecutions)
      .where(eq(planExecutions.goalId, goalId))
      .orderBy(desc(planExecutions.createdAt))
      .limit(limit);
    return executions;
  }

  async createPlan(plan: InsertPlan): Promise<Plan> {
    const [newPlan] = await db
      .insert(plans)
      .values(plan)
      .returning();
    return newPlan;
  }

  async getPlan(planId: string): Promise<Plan | undefined> {
    const [plan] = await db
      .select()
      .from(plans)
      .where(eq(plans.id, planId))
      .limit(1);
    return plan || undefined;
  }

  async updatePlanStatus(planId: string, status: string): Promise<void> {
    await db
      .update(plans)
      .set({ 
        status, 
        updatedAt: new Date() 
      })
      .where(eq(plans.id, planId));
  }

  async updatePlan(planId: string, updates: Partial<InsertPlan>): Promise<void> {
    await db
      .update(plans)
      .set({ 
        ...updates,
        updatedAt: new Date() 
      })
      .where(eq(plans.id, planId));
  }

  async getUserActivePlan(userId: string): Promise<Plan | undefined> {
    const [plan] = await db
      .select()
      .from(plans)
      .where(eq(plans.userId, userId))
      .orderBy(desc(plans.createdAt))
      .limit(1);
    return plan || undefined;
  }
}

export const storage = new DatabaseStorage();
