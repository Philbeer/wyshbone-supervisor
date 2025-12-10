/**
 * SQLite Schema for Local Development
 * 
 * This schema is SQLite-compatible and used for local dev only.
 * Production uses PostgreSQL (see schema.ts).
 * 
 * Key differences from PostgreSQL schema:
 * - Uses sqliteTable instead of pgTable
 * - UUIDs stored as text
 * - Timestamps stored as text (ISO strings)
 * - Uses 'json' mode for JSON columns
 */

import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { randomUUID } from "crypto";

// Helper to generate UUIDs for SQLite
export const genId = () => randomUUID();

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => genId()),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const userSignals = sqliteTable("user_signals", {
  id: text("id").primaryKey().$defaultFn(() => genId()),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const suggestedLeads = sqliteTable("suggested_leads", {
  id: text("id").primaryKey().$defaultFn(() => genId()),
  userId: text("user_id").notNull(),
  accountId: text("account_id"),
  rationale: text("rationale").notNull(),
  source: text("source").notNull(),
  score: real("score").notNull(),
  lead: text("lead", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  lastContactedAt: text("last_contacted_at"),
  pipelineStage: text("pipeline_stage"),
  pipelineStageChangedAt: text("pipeline_stage_changed_at"),
  updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const processedSignals = sqliteTable("processed_signals", {
  id: text("id").primaryKey().$defaultFn(() => genId()),
  signalId: text("signal_id").notNull().unique(),
  signalSource: text("signal_source").notNull(),
  signalCreatedAt: text("signal_created_at").notNull(),
  processedAt: text("processed_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const supervisorState = sqliteTable("supervisor_state", {
  id: text("id").primaryKey().$defaultFn(() => genId()),
  source: text("source").notNull().unique(),
  lastProcessedTimestamp: text("last_processed_timestamp"),
  lastProcessedId: text("last_processed_id"),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  accountId: text("account_id"),
  status: text("status").notNull(),
  planData: text("plan_data", { mode: "json" }).notNull(),
  goalText: text("goal_text"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const planExecutions = sqliteTable("plan_executions", {
  id: text("id").primaryKey().$defaultFn(() => genId()),
  planId: text("plan_id").notNull(),
  userId: text("user_id").notNull(),
  accountId: text("account_id"),
  goalId: text("goal_id"),
  goalText: text("goal_text"),
  overallStatus: text("overall_status").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at").notNull(),
  stepResults: text("step_results", { mode: "json" }).notNull(),
  metadata: text("metadata", { mode: "json" }),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const subconsciousNudges = sqliteTable("subconscious_nudges", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  userId: text("user_id"),
  nudgeType: text("nudge_type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  importance: integer("importance").notNull(),
  leadId: text("lead_id"),
  context: text("context", { mode: "json" }),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  resolvedAt: text("resolved_at"),
  dismissedAt: text("dismissed_at"),
}, (table) => ({
  accountIdIdx: index("subconscious_nudges_account_id_idx").on(table.accountId),
}));

// Insert schemas
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

// Type exports
export type InsertUserSignal = z.infer<typeof insertUserSignalSchema>;
export type InsertSuggestedLead = z.infer<typeof insertSuggestedLeadSchema>;
export type InsertPlanExecution = z.infer<typeof insertPlanExecutionSchema>;
export type InsertPlan = z.infer<typeof insertPlanSchema>;
export type InsertSubconsciousNudge = z.infer<typeof insertSubconsciousNudgeSchema>;
export type SuggestedLead = typeof suggestedLeads.$inferSelect;
export type UserSignal = typeof userSignals.$inferSelect;
export type PlanExecution = typeof planExecutions.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type SubconsciousNudge = typeof subconsciousNudges.$inferSelect;
