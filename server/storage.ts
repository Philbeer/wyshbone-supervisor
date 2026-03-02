// Schema imports - use server/schema.ts for env-aware schema selection
import {
  users,
  suggestedLeads,
  userSignals,
  processedSignals,
  supervisorState,
  planExecutions,
  plans,
  subconsciousNudges,
  artefacts,
  towerJudgements,
  agentRuns,
  goalLedger,
  beliefStore,
  feedbackEvents,
  telemetryEvents,
  policyVersions,
  policyApplications,
  type User,
  type InsertUser,
  type SuggestedLead,
  type UserSignal,
  type PlanExecution,
  type Plan,
  type InsertSuggestedLead,
  type InsertUserSignal,
  type InsertPlanExecution,
  type InsertPlan,
  type SubconsciousNudge as DBSubconsciousNudge,
  type InsertSubconsciousNudge,
  type Artefact,
  type InsertArtefact,
  type TowerJudgement,
  type InsertTowerJudgement,
  type AgentRun,
  type InsertAgentRun,
  type GoalLedger,
  type InsertGoalLedger,
  type BeliefStore,
  type InsertBeliefStore,
  type FeedbackEvent,
  type InsertFeedbackEvent,
  type TelemetryEvent,
  type InsertTelemetryEvent,
  type PolicyVersion,
  type InsertPolicyVersion,
  type PolicyApplication,
  type InsertPolicyApplication,
} from "./schema";
import { db } from "./db";
import { eq, desc, isNull, and } from "drizzle-orm";
import type { SubconNudge } from "./subcon/types";
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
  // SUP-13: Subconscious nudges storage
  saveSubconNudges(accountId: string, nudges: SubconNudge[]): Promise<void>;
  getSubconNudgesByAccount(accountId: string): Promise<DBSubconsciousNudge[]>;
  resolveSubconNudge(id: string): Promise<void>;
  dismissSubconNudge(id: string): Promise<void>;
  getUnresolvedSubconNudges(accountId: string): Promise<DBSubconsciousNudge[]>;
  // P2-T1: Agent memory storage (ADAPT phase)
  storeAgentMemory(memory: InsertAgentMemory): Promise<AgentMemory>;
  getAgentMemories(params: { userId: string; toolUsed?: string; limit?: number; offset?: number }): Promise<AgentMemory[]>;
  updateMemoryFeedback(id: string, userFeedback: string): Promise<void>;
  createArtefact(artefact: InsertArtefact): Promise<Artefact>;
  getArtefactsByRunId(runId: string): Promise<Artefact[]>;
  getArtefact(id: string): Promise<Artefact | undefined>;
  createTowerJudgement(judgement: InsertTowerJudgement): Promise<TowerJudgement>;
  getTowerJudgementsByRunId(runId: string): Promise<TowerJudgement[]>;
  // Agent runs (AFR runs list)
  createAgentRun(run: InsertAgentRun): Promise<AgentRun>;
  updateAgentRun(id: string, updates: Partial<InsertAgentRun>): Promise<void>;
  getAgentRuns(userId?: string): Promise<AgentRun[]>;
  // Goal ledger
  createGoal(goal: InsertGoalLedger): Promise<GoalLedger>;
  getGoal(goalId: string): Promise<GoalLedger | undefined>;
  updateGoalStatus(goalId: string, status: string, stopReason?: Record<string, unknown>): Promise<void>;
  linkRunToGoal(goalId: string, runId: string): Promise<void>;
  getGoalsByUser(userId: string): Promise<GoalLedger[]>;
  // Belief store
  createBelief(belief: InsertBeliefStore): Promise<BeliefStore>;
  getBeliefsByRun(runId: string): Promise<BeliefStore[]>;
  getBeliefsByGoal(goalId: string): Promise<BeliefStore[]>;
  // Feedback events
  createFeedbackEvent(event: InsertFeedbackEvent): Promise<FeedbackEvent>;
  getFeedbackEventsByGoal(goalId: string): Promise<FeedbackEvent[]>;
  // Telemetry events
  createTelemetryEvent(event: InsertTelemetryEvent): Promise<TelemetryEvent>;
  getTelemetryEventsByRun(runId: string): Promise<TelemetryEvent[]>;
  // Policy versions
  createPolicyVersion(pv: InsertPolicyVersion): Promise<PolicyVersion>;
  getLatestPolicyVersion(scopeKey: string): Promise<PolicyVersion | undefined>;
  // Policy applications
  createPolicyApplication(pa: InsertPolicyApplication): Promise<PolicyApplication>;
  getPolicyApplicationsByRun(runId: string): Promise<PolicyApplication[]>;
  getRunSnapshot(runId: string): Promise<{
    run_id: string;
    policy_application_snapshot: Record<string, unknown> | null;
    delivery_summary: Record<string, unknown> | null;
    leads_list: Record<string, unknown> | null;
    agent_run: Record<string, unknown> | null;
  }>;
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

  // SUP-13: Subconscious nudges storage

  /**
   * Convert priority to importance score (0-100 scale)
   */
  private priorityToImportance(priority: 'low' | 'medium' | 'high'): number {
    switch (priority) {
      case 'high': return 90;
      case 'medium': return 60;
      case 'low': return 30;
      default: return 50;
    }
  }

  /**
   * Generate a title from nudge type
   */
  private nudgeTypeToTitle(type: string): string {
    switch (type) {
      case 'stale_lead': return 'Stale Lead Alert';
      case 'follow_up': return 'Follow-up Reminder';
      default: return type.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }

  async saveSubconNudges(accountId: string, nudges: SubconNudge[]): Promise<void> {
    if (nudges.length === 0) return;

    const insertData: InsertSubconsciousNudge[] = nudges.map(nudge => ({
      id: `nudge_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      accountId,
      userId: null, // Could be set from context if needed
      nudgeType: nudge.type,
      title: this.nudgeTypeToTitle(nudge.type),
      message: nudge.message,
      importance: this.priorityToImportance(nudge.priority),
      leadId: nudge.entityId || null,
      context: nudge.metadata ? (nudge.metadata as Record<string, unknown>) : null,
    }));

    await db.insert(subconsciousNudges).values(insertData);
    console.log(`[Storage] Saved ${nudges.length} subconscious nudges for account ${accountId}`);
  }

  async getSubconNudgesByAccount(accountId: string): Promise<DBSubconsciousNudge[]> {
    const nudges = await db
      .select()
      .from(subconsciousNudges)
      .where(eq(subconsciousNudges.accountId, accountId))
      .orderBy(desc(subconsciousNudges.createdAt));
    return nudges;
  }

  async resolveSubconNudge(id: string): Promise<void> {
    await db
      .update(subconsciousNudges)
      .set({ resolvedAt: new Date() })
      .where(eq(subconsciousNudges.id, id));
  }

  async dismissSubconNudge(id: string): Promise<void> {
    await db
      .update(subconsciousNudges)
      .set({ dismissedAt: new Date() })
      .where(eq(subconsciousNudges.id, id));
  }

  async getUnresolvedSubconNudges(accountId: string): Promise<DBSubconsciousNudge[]> {
    const nudges = await db
      .select()
      .from(subconsciousNudges)
      .where(
        and(
          eq(subconsciousNudges.accountId, accountId),
          isNull(subconsciousNudges.resolvedAt),
          isNull(subconsciousNudges.dismissedAt)
        )
      )
      .orderBy(desc(subconsciousNudges.importance), desc(subconsciousNudges.createdAt));
    return nudges;
  }

  // P2-T1: Agent memory storage (ADAPT phase)

  async storeAgentMemory(memory: InsertAgentMemory): Promise<AgentMemory> {
    const [result] = await db
      .insert(agentMemory)
      .values(memory)
      .returning();
    console.log(`[Storage] Stored agent memory for user ${memory.userId}, tool: ${memory.toolUsed}`);
    return result;
  }

  async getAgentMemories(params: { userId: string; toolUsed?: string; limit?: number; offset?: number }): Promise<AgentMemory[]> {
    let query = db
      .select()
      .from(agentMemory)
      .where(eq(agentMemory.userId, params.userId))
      .orderBy(desc(agentMemory.learnedAt));

    if (params.toolUsed) {
      query = db
        .select()
        .from(agentMemory)
        .where(
          and(
            eq(agentMemory.userId, params.userId),
            eq(agentMemory.toolUsed, params.toolUsed)
          )
        )
        .orderBy(desc(agentMemory.learnedAt));
    }

    const memories = await query
      .limit(params.limit || 50)
      .offset(params.offset || 0);

    return memories;
  }

  async updateMemoryFeedback(id: string, userFeedback: string): Promise<void> {
    await db
      .update(agentMemory)
      .set({ userFeedback })
      .where(eq(agentMemory.id, id));
    console.log(`[Storage] Updated memory ${id} feedback: ${userFeedback}`);
  }

  async createArtefact(artefact: InsertArtefact): Promise<Artefact> {
    const [result] = await db
      .insert(artefacts)
      .values(artefact)
      .returning();
    console.log(`[Storage] Created artefact '${artefact.title}' (type=${artefact.type}) for run ${artefact.runId}`);
    return result;
  }

  async getArtefactsByRunId(runId: string): Promise<Artefact[]> {
    return db
      .select()
      .from(artefacts)
      .where(eq(artefacts.runId, runId))
      .orderBy(desc(artefacts.createdAt));
  }

  async getArtefact(id: string): Promise<Artefact | undefined> {
    const [result] = await db
      .select()
      .from(artefacts)
      .where(eq(artefacts.id, id))
      .limit(1);
    return result || undefined;
  }

  async createTowerJudgement(judgement: InsertTowerJudgement): Promise<TowerJudgement> {
    if (judgement.idempotencyKey) {
      const [existing] = await db
        .select()
        .from(towerJudgements)
        .where(eq(towerJudgements.idempotencyKey, judgement.idempotencyKey))
        .limit(1);
      if (existing) {
        console.log(`[Storage] Tower judgement deduplicated by idempotency_key=${judgement.idempotencyKey} for run ${judgement.runId}`);
        return existing;
      }
    }
    const [result] = await db
      .insert(towerJudgements)
      .values(judgement)
      .returning();
    console.log(`[Storage] Created tower judgement (verdict=${judgement.verdict}, action=${judgement.action}) for run ${judgement.runId}${judgement.idempotencyKey ? ` ikey=${judgement.idempotencyKey}` : ''}`);
    return result;
  }

  async getTowerJudgementsByRunId(runId: string): Promise<TowerJudgement[]> {
    return db
      .select()
      .from(towerJudgements)
      .where(eq(towerJudgements.runId, runId))
      .orderBy(desc(towerJudgements.createdAt));
  }

  async createAgentRun(run: InsertAgentRun): Promise<AgentRun> {
    const [newRun] = await db
      .insert(agentRuns)
      .values(run)
      .returning();
    console.log(`[Storage] Created agent run ${run.id} for user ${run.userId}`);
    return newRun;
  }

  async updateAgentRun(id: string, updates: {
    status?: string;
    terminalState?: string | null;
    error?: string | null;
    errorDetails?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
    endedAt?: Date | null;
    goalId?: string | null;
  }): Promise<void> {
    const setClause: Record<string, unknown> = {};
    if (updates.status !== undefined) setClause.status = updates.status;
    if (updates.terminalState !== undefined) setClause.terminalState = updates.terminalState;
    if (updates.error !== undefined) setClause.error = updates.error;
    if (updates.errorDetails !== undefined) setClause.errorDetails = updates.errorDetails;
    if (updates.metadata !== undefined) setClause.metadata = updates.metadata;
    if (updates.endedAt !== undefined) setClause.endedAt = updates.endedAt;
    if (updates.goalId !== undefined) setClause.goalId = updates.goalId;

    await db
      .update(agentRuns)
      .set(setClause)
      .where(eq(agentRuns.id, id));
    console.log(`[Storage] Updated agent run ${id}`);
  }

  async getAgentRuns(userId?: string): Promise<AgentRun[]> {
    if (userId) {
      return db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.userId, userId))
        .orderBy(desc(agentRuns.createdAt));
    }
    return db
      .select()
      .from(agentRuns)
      .orderBy(desc(agentRuns.createdAt));
  }

  async createGoal(goal: InsertGoalLedger): Promise<GoalLedger> {
    const [result] = await db.insert(goalLedger).values(goal).returning();
    console.log(`[Storage] Created goal '${goal.goalText}' for user ${goal.userId}`);
    return result;
  }

  async getGoal(goalId: string): Promise<GoalLedger | undefined> {
    const [result] = await db.select().from(goalLedger).where(eq(goalLedger.goalId, goalId)).limit(1);
    return result || undefined;
  }

  async updateGoalStatus(goalId: string, status: string, stopReason?: Record<string, unknown>): Promise<void> {
    const set: Record<string, unknown> = { status, updatedAt: new Date() };
    if (stopReason !== undefined) set.stopReason = stopReason;
    await db.update(goalLedger).set(set).where(eq(goalLedger.goalId, goalId));
    console.log(`[Storage] Updated goal ${goalId} status=${status}`);
  }

  async linkRunToGoal(goalId: string, runId: string): Promise<void> {
    const goal = await this.getGoal(goalId);
    if (!goal) return;
    const existing = goal.linkedRunIds || [];
    if (!existing.includes(runId)) {
      await db.update(goalLedger).set({
        linkedRunIds: [...existing, runId],
        updatedAt: new Date(),
      }).where(eq(goalLedger.goalId, goalId));
    }
    await db.update(agentRuns).set({ goalId }).where(eq(agentRuns.id, runId));
    console.log(`[Storage] Linked run ${runId} to goal ${goalId}`);
  }

  async getGoalsByUser(userId: string): Promise<GoalLedger[]> {
    return db.select().from(goalLedger).where(eq(goalLedger.userId, userId)).orderBy(desc(goalLedger.createdAt));
  }

  async createBelief(belief: InsertBeliefStore): Promise<BeliefStore> {
    const [result] = await db.insert(beliefStore).values(belief).returning();
    console.log(`[Storage] Created belief '${belief.claim}' for run ${belief.runId}`);
    return result;
  }

  async getBeliefsByRun(runId: string): Promise<BeliefStore[]> {
    return db.select().from(beliefStore).where(eq(beliefStore.runId, runId)).orderBy(desc(beliefStore.lastUpdated));
  }

  async getBeliefsByGoal(goalId: string): Promise<BeliefStore[]> {
    return db.select().from(beliefStore).where(eq(beliefStore.goalId, goalId)).orderBy(desc(beliefStore.lastUpdated));
  }

  async createFeedbackEvent(event: InsertFeedbackEvent): Promise<FeedbackEvent> {
    const [result] = await db.insert(feedbackEvents).values(event).returning();
    console.log(`[Storage] Created feedback event ${event.eventType} for goal ${event.goalId}`);
    return result;
  }

  async getFeedbackEventsByGoal(goalId: string): Promise<FeedbackEvent[]> {
    return db.select().from(feedbackEvents).where(eq(feedbackEvents.goalId, goalId)).orderBy(desc(feedbackEvents.createdAt));
  }

  async createTelemetryEvent(event: InsertTelemetryEvent): Promise<TelemetryEvent> {
    const [result] = await db.insert(telemetryEvents).values(event).returning();
    console.log(`[Storage] Created telemetry event ${event.eventType} for run ${event.runId}`);
    return result;
  }

  async getTelemetryEventsByRun(runId: string): Promise<TelemetryEvent[]> {
    return db.select().from(telemetryEvents).where(eq(telemetryEvents.runId, runId)).orderBy(desc(telemetryEvents.createdAt));
  }

  async createPolicyVersion(pv: InsertPolicyVersion): Promise<PolicyVersion> {
    const [result] = await db.insert(policyVersions).values(pv).returning();
    console.log(`[Storage] Created policy version v${pv.version} for scope ${pv.scopeKey}`);
    return result;
  }

  async getLatestPolicyVersion(scopeKey: string): Promise<PolicyVersion | undefined> {
    const [result] = await db
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.scopeKey, scopeKey))
      .orderBy(desc(policyVersions.version))
      .limit(1);
    return result || undefined;
  }

  async createPolicyApplication(pa: InsertPolicyApplication): Promise<PolicyApplication> {
    const [result] = await db.insert(policyApplications).values(pa).returning();
    console.log(`[Storage] Created policy application for run ${pa.runId} scope ${pa.scopeKey}`);
    return result;
  }

  async getPolicyApplicationsByRun(runId: string): Promise<PolicyApplication[]> {
    return db.select().from(policyApplications).where(eq(policyApplications.runId, runId)).orderBy(desc(policyApplications.createdAt));
  }

  async getRunSnapshot(runId: string): Promise<{
    run_id: string;
    policy_application_snapshot: Record<string, unknown> | null;
    delivery_summary: Record<string, unknown> | null;
    leads_list: Record<string, unknown> | null;
    agent_run: Record<string, unknown> | null;
  }> {
    const [allArtefacts, policyApps, agentRunRows] = await Promise.all([
      db.select().from(artefacts).where(eq(artefacts.runId, runId)).orderBy(desc(artefacts.createdAt)),
      db.select().from(policyApplications).where(eq(policyApplications.runId, runId)).orderBy(desc(policyApplications.createdAt)).limit(1),
      db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1),
    ]);

    const policySnapshotArtefact = allArtefacts.find(a => a.type === 'policy_application_snapshot');
    const deliverySummaryArtefact = allArtefacts.find(a => a.type === 'delivery_summary');
    const leadsListArtefact = allArtefacts.find(a => a.type === 'leads_list');

    const policyAppRow = policyApps[0] ?? null;
    const agentRunRow = agentRunRows[0] ?? null;

    const policySnapshot = policySnapshotArtefact
      ? {
          artefact_id: policySnapshotArtefact.id,
          run_id: policySnapshotArtefact.runId,
          type: policySnapshotArtefact.type,
          title: policySnapshotArtefact.title,
          summary: policySnapshotArtefact.summary,
          payload: policySnapshotArtefact.payloadJson as Record<string, unknown> | null,
          created_at: policySnapshotArtefact.createdAt,
          ...(policyAppRow ? {
            db_row: {
              id: policyAppRow.id,
              scope_key: policyAppRow.scopeKey,
              applied_policies: policyAppRow.appliedPolicies,
              output_constraints: policyAppRow.outputConstraints,
            },
          } : {}),
        }
      : (policyAppRow ? {
          db_row: {
            id: policyAppRow.id,
            run_id: policyAppRow.runId,
            scope_key: policyAppRow.scopeKey,
            applied_policies: policyAppRow.appliedPolicies,
            output_constraints: policyAppRow.outputConstraints,
          },
        } : null);

    const deliverySummary = deliverySummaryArtefact
      ? {
          artefact_id: deliverySummaryArtefact.id,
          run_id: deliverySummaryArtefact.runId,
          type: deliverySummaryArtefact.type,
          title: deliverySummaryArtefact.title,
          summary: deliverySummaryArtefact.summary,
          payload: deliverySummaryArtefact.payloadJson as Record<string, unknown> | null,
          created_at: deliverySummaryArtefact.createdAt,
        }
      : null;

    const leadsList = leadsListArtefact
      ? {
          artefact_id: leadsListArtefact.id,
          run_id: leadsListArtefact.runId,
          type: leadsListArtefact.type,
          title: leadsListArtefact.title,
          summary: leadsListArtefact.summary,
          payload: leadsListArtefact.payloadJson as Record<string, unknown> | null,
          created_at: leadsListArtefact.createdAt,
        }
      : null;

    const agentRun = agentRunRow
      ? {
          id: agentRunRow.id,
          client_request_id: agentRunRow.clientRequestId,
          status: agentRunRow.status,
          terminal_state: agentRunRow.terminalState,
          metadata: agentRunRow.metadata,
          created_at: agentRunRow.createdAt,
          updated_at: agentRunRow.updatedAt,
        }
      : null;

    return {
      run_id: runId,
      policy_application_snapshot: policySnapshot as Record<string, unknown> | null,
      delivery_summary: deliverySummary as Record<string, unknown> | null,
      leads_list: leadsList as Record<string, unknown> | null,
      agent_run: agentRun as Record<string, unknown> | null,
    };
  }
}

export const storage = new DatabaseStorage();
