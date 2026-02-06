/**
 * Schema Re-exports for Server
 * 
 * This module re-exports schema tables and types.
 * In development without a database, these are still needed for type definitions.
 */

import { config } from 'dotenv';

// Always load .env
config();

// Always import from the PostgreSQL schema for types and table definitions
// The db.ts module handles the actual database connection
const schema = await import('@shared/schema');

// Re-export everything from the schema
export const {
  users,
  userSignals,
  suggestedLeads,
  processedSignals,
  supervisorState,
  plans,
  planExecutions,
  subconsciousNudges,
  agentRuns,
  insertUserSchema,
  insertUserSignalSchema,
  insertSuggestedLeadSchema,
  insertPlanExecutionSchema,
  insertPlanSchema,
  insertSubconsciousNudgeSchema,
  insertAgentRunSchema,
} = schema;

// Re-export types
export type {
  User,
  InsertUser,
  UserSignal,
  InsertUserSignal,
  SuggestedLead,
  InsertSuggestedLead,
  PlanExecution,
  InsertPlanExecution,
  Plan,
  InsertPlan,
  SubconsciousNudge,
  InsertSubconsciousNudge,
  AgentRun,
  InsertAgentRun,
} from '@shared/schema';
