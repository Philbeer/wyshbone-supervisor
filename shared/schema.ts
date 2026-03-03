import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb, real, integer, index, bigint, numeric, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const userSignals = pgTable("user_signals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const suggestedLeads = pgTable("suggested_leads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  accountId: varchar("account_id"), // For multi-account isolation (SUP-012)
  rationale: text("rationale").notNull(),
  source: text("source").notNull(),
  score: real("score").notNull(),
  lead: jsonb("lead").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // SUP-12: Stale leads tracking fields
  lastContactedAt: timestamp("last_contacted_at"),
  pipelineStage: text("pipeline_stage"),
  pipelineStageChangedAt: timestamp("pipeline_stage_changed_at"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const processedSignals = pgTable("processed_signals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  signalId: text("signal_id").notNull().unique(),
  signalSource: text("signal_source").notNull(), // 'supabase' or 'postgres'
  signalCreatedAt: timestamp("signal_created_at").notNull(), // When the signal was originally created
  processedAt: timestamp("processed_at").defaultNow().notNull(),
});

export const supervisorState = pgTable("supervisor_state", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  source: text("source").notNull().unique(), // 'supabase' or 'postgres'
  lastProcessedTimestamp: timestamp("last_processed_timestamp"),
  lastProcessedId: text("last_processed_id"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const plans = pgTable("plans", {
  id: varchar("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  accountId: varchar("account_id"), // For multi-account isolation
  status: text("status").notNull(), // 'pending_approval', 'approved', 'executing', 'completed', 'failed', 'cancelled'
  planData: jsonb("plan_data").notNull(), // Full LeadGenPlan object
  goalText: text("goal_text"), // Human-readable goal
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const planExecutions = pgTable("plan_executions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  planId: text("plan_id").notNull(),
  userId: varchar("user_id").notNull(),
  accountId: varchar("account_id"), // For multi-account isolation (SUP-012)
  goalId: text("goal_id"), // Reference to scheduled_monitor id in Supabase or similar
  goalText: text("goal_text"), // Snapshot of the goal for this execution
  overallStatus: text("overall_status").notNull(), // 'succeeded', 'failed', 'partial'
  startedAt: timestamp("started_at").notNull(),
  finishedAt: timestamp("finished_at").notNull(),
  stepResults: jsonb("step_results").notNull(), // Array of step results
  metadata: jsonb("metadata"), // Additional context (source, trigger, etc.)
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// SUP-13: Subconscious nudges storage
export const subconsciousNudges = pgTable("subconscious_nudges", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  userId: text("user_id"),
  nudgeType: text("nudge_type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  importance: integer("importance").notNull(),
  leadId: text("lead_id"),
  context: jsonb("context"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
  dismissedAt: timestamp("dismissed_at"),
}, (table) => ({
  accountIdIdx: index("subconscious_nudges_account_id_idx").on(table.accountId),
}));

// P2-T1: Agent memory for learning system (ADAPT phase)
export const agentMemory = pgTable("agent_memory", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  accountId: varchar("account_id"), // Multi-account isolation
  toolUsed: text("tool_used").notNull(), // Tool that was executed
  query: jsonb("query").notNull(), // Query/params passed to tool
  outcome: jsonb("outcome").notNull(), // Result from tool execution
  userFeedback: text("user_feedback"), // 'helpful', 'not_helpful', or null
  confidenceScore: real("confidence_score"), // 0.0 to 1.0
  planId: varchar("plan_id"), // Link to plan if part of plan execution
  taskId: varchar("task_id"), // Link to specific task
  learnedAt: timestamp("learned_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(), // Auto-expire after 90 days
}, (table) => ({
  userIdIdx: index("agent_memory_user_id_idx").on(table.userId),
  learnedAtIdx: index("agent_memory_learned_at_idx").on(table.learnedAt),
}));

export const insertUserSignalSchema = createInsertSchema(userSignals).omit({
  id: true,
  createdAt: true,
});

export const insertSuggestedLeadSchema = createInsertSchema(suggestedLeads).omit({
  id: true,
  createdAt: true,
});

export const insertPlanExecutionSchema = createInsertSchema(planExecutions).omit({
  id: true,
  createdAt: true,
});

export const insertPlanSchema = createInsertSchema(plans).omit({
  createdAt: true,
  updatedAt: true,
});

export const insertSubconsciousNudgeSchema = createInsertSchema(subconsciousNudges).omit({
  createdAt: true,
});

export const insertAgentMemorySchema = createInsertSchema(agentMemory).omit({
  id: true,
  learnedAt: true,
});

export type InsertUserSignal = z.infer<typeof insertUserSignalSchema>;
export type InsertSuggestedLead = z.infer<typeof insertSuggestedLeadSchema>;
export type InsertAgentMemory = z.infer<typeof insertAgentMemorySchema>;
export type AgentMemory = typeof agentMemory.$inferSelect;
export type InsertPlanExecution = z.infer<typeof insertPlanExecutionSchema>;
export type InsertPlan = z.infer<typeof insertPlanSchema>;
export type InsertSubconsciousNudge = z.infer<typeof insertSubconsciousNudgeSchema>;
export type SuggestedLead = typeof suggestedLeads.$inferSelect;
export type UserSignal = typeof userSignals.$inferSelect;
export type PlanExecution = typeof planExecutions.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type SubconsciousNudge = typeof subconsciousNudges.$inferSelect;

export const artefacts = pgTable("artefacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  runId: varchar("run_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  payloadJson: jsonb("payload_json"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  runIdIdx: index("artefacts_run_id_idx").on(table.runId),
}));

export const insertArtefactSchema = createInsertSchema(artefacts).omit({
  id: true,
  createdAt: true,
});

export type InsertArtefact = z.infer<typeof insertArtefactSchema>;
export type Artefact = typeof artefacts.$inferSelect;

export const towerJudgements = pgTable("tower_judgements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  runId: text("run_id").notNull(),
  artefactId: text("artefact_id").notNull(),
  verdict: text("verdict").notNull(),
  action: text("action").notNull(),
  reasonsJson: jsonb("reasons_json"),
  metricsJson: jsonb("metrics_json"),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  runIdIdx: index("tower_judgements_run_id_idx").on(table.runId),
  artefactIdIdx: index("tower_judgements_artefact_id_idx").on(table.artefactId),
  idempotencyKeyIdx: index("tower_judgements_idempotency_key_idx").on(table.idempotencyKey),
}));

export const insertTowerJudgementSchema = createInsertSchema(towerJudgements).omit({
  id: true,
  createdAt: true,
});

export type InsertTowerJudgement = z.infer<typeof insertTowerJudgementSchema>;
export type TowerJudgement = typeof towerJudgements.$inferSelect;

export const agentRuns = pgTable("agent_runs", {
  id: text("id").primaryKey(),
  clientRequestId: text("client_request_id").notNull(),
  userId: text("user_id").notNull(),
  conversationId: text("conversation_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  status: text("status").notNull().default("starting"),
  terminalState: text("terminal_state"),
  uiReady: integer("ui_ready").notNull().default(0),
  lastEventAt: bigint("last_event_at", { mode: "number" }),
  error: text("error"),
  errorDetails: jsonb("error_details"),
  metadata: jsonb("metadata"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  goalId: text("goal_id"),
});

export const insertAgentRunSchema = createInsertSchema(agentRuns).omit({});

export type InsertAgentRun = z.infer<typeof insertAgentRunSchema>;
export type AgentRun = typeof agentRuns.$inferSelect;

export const goalLedger = pgTable("goal_ledger", {
  goalId: text("goal_id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull(),
  goalText: text("goal_text").notNull(),
  successCriteria: jsonb("success_criteria").notNull().default({}),
  status: text("status").notNull().default("ACTIVE"),
  linkedRunIds: text("linked_run_ids").array().notNull().default(sql`'{}'`),
  stopReason: jsonb("stop_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("idx_goal_ledger_user_id").on(table.userId),
  statusIdx: index("idx_goal_ledger_status").on(table.status),
}));

export const insertGoalLedgerSchema = createInsertSchema(goalLedger).omit({
  goalId: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertGoalLedger = z.infer<typeof insertGoalLedgerSchema>;
export type GoalLedger = typeof goalLedger.$inferSelect;

export const beliefStore = pgTable("belief_store", {
  beliefId: text("belief_id").primaryKey().default(sql`gen_random_uuid()`),
  runId: text("run_id").notNull(),
  goalId: text("goal_id"),
  claim: text("claim").notNull(),
  confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("1.00"),
  evidenceRunIds: text("evidence_run_ids").array().notNull().default(sql`'{}'`),
  evidence: jsonb("evidence").notNull().default({}),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  runIdIdx: index("idx_belief_store_run_id").on(table.runId),
  goalIdIdx: index("idx_belief_store_goal_id").on(table.goalId),
}));

export const insertBeliefStoreSchema = createInsertSchema(beliefStore).omit({
  beliefId: true,
  lastUpdated: true,
});

export type InsertBeliefStore = z.infer<typeof insertBeliefStoreSchema>;
export type BeliefStore = typeof beliefStore.$inferSelect;

export const feedbackEvents = pgTable("feedback_events", {
  eventId: text("event_id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull(),
  goalId: text("goal_id").notNull(),
  runId: text("run_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  goalIdIdx: index("idx_feedback_events_goal_id").on(table.goalId),
  runIdIdx: index("idx_feedback_events_run_id").on(table.runId),
}));

export const insertFeedbackEventSchema = createInsertSchema(feedbackEvents).omit({
  eventId: true,
  createdAt: true,
});

export type InsertFeedbackEvent = z.infer<typeof insertFeedbackEventSchema>;
export type FeedbackEvent = typeof feedbackEvents.$inferSelect;

export const telemetryEvents = pgTable("telemetry_events", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  runId: text("run_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  runIdIdx: index("idx_telemetry_events_run_id").on(table.runId),
  eventTypeIdx: index("idx_telemetry_events_event_type").on(table.eventType),
}));

export const insertTelemetryEventSchema = createInsertSchema(telemetryEvents).omit({
  id: true,
  createdAt: true,
});

export type InsertTelemetryEvent = z.infer<typeof insertTelemetryEventSchema>;
export type TelemetryEvent = typeof telemetryEvents.$inferSelect;

export const policyVersions = pgTable("policy_versions", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  scopeKey: text("scope_key").notNull(),
  version: integer("version").notNull().default(1),
  policyData: jsonb("policy_data").notNull(),
  source: text("source").notNull().default("outcome_feedback"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  scopeKeyIdx: index("idx_policy_versions_scope_key").on(table.scopeKey),
  scopeKeyVersionIdx: index("idx_policy_versions_scope_version").on(table.scopeKey, table.version),
}));

export const insertPolicyVersionSchema = createInsertSchema(policyVersions).omit({
  id: true,
  createdAt: true,
});

export type InsertPolicyVersion = z.infer<typeof insertPolicyVersionSchema>;
export type PolicyVersion = typeof policyVersions.$inferSelect;

export const policyApplications = pgTable("policy_applications", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  runId: text("run_id").notNull(),
  scopeKey: text("scope_key").notNull(),
  policyVersionId: text("policy_version_id"),
  appliedPolicies: jsonb("applied_policies").notNull(),
  inputSnapshot: jsonb("input_snapshot").notNull(),
  outputConstraints: jsonb("output_constraints").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  runIdIdx: index("idx_policy_applications_run_id").on(table.runId),
  scopeKeyIdx: index("idx_policy_applications_scope_key").on(table.scopeKey),
}));

export const insertPolicyApplicationSchema = createInsertSchema(policyApplications).omit({
  id: true,
  createdAt: true,
});

export type InsertPolicyApplication = z.infer<typeof insertPolicyApplicationSchema>;
export type PolicyApplication = typeof policyApplications.$inferSelect;

export const learningStore = pgTable("learning_store", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  queryShapeKey: text("query_shape_key").notNull().unique(),
  defaultResultCount: integer("default_result_count").notNull().default(20),
  verificationLevel: text("verification_level").notNull().default("standard"),
  searchBudgetPages: integer("search_budget_pages").notNull().default(3),
  radiusEscalation: text("radius_escalation").notNull().default("allowed"),
  stopIfUnderfilled: integer("stop_if_underfilled").notNull().default(0),
  fieldMetadata: jsonb("field_metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  queryShapeKeyIdx: index("idx_learning_store_query_shape_key").on(table.queryShapeKey),
}));

export const insertLearningStoreSchema = createInsertSchema(learningStore).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertLearningStore = z.infer<typeof insertLearningStoreSchema>;
export type LearningStore = typeof learningStore.$inferSelect;
