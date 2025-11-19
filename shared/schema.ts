import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb, real } from "drizzle-orm/pg-core";
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

export type InsertUserSignal = z.infer<typeof insertUserSignalSchema>;
export type InsertSuggestedLead = z.infer<typeof insertSuggestedLeadSchema>;
export type InsertPlanExecution = z.infer<typeof insertPlanExecutionSchema>;
export type SuggestedLead = typeof suggestedLeads.$inferSelect;
export type UserSignal = typeof userSignals.$inferSelect;
export type PlanExecution = typeof planExecutions.$inferSelect;
