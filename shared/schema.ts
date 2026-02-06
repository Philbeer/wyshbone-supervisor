import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb, real, integer, index, bigint } from "drizzle-orm/pg-core";
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
});

export const insertAgentRunSchema = createInsertSchema(agentRuns).omit({});

export type InsertAgentRun = z.infer<typeof insertAgentRunSchema>;
export type AgentRun = typeof agentRuns.$inferSelect;
