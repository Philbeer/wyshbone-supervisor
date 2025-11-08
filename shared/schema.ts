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
  rationale: text("rationale").notNull(),
  source: text("source").notNull(),
  score: real("score").notNull(),
  lead: jsonb("lead").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSuggestedLeadSchema = createInsertSchema(suggestedLeads).omit({
  id: true,
  createdAt: true,
});

export type InsertSuggestedLead = z.infer<typeof insertSuggestedLeadSchema>;
export type SuggestedLead = typeof suggestedLeads.$inferSelect;
export type UserSignal = typeof userSignals.$inferSelect;
