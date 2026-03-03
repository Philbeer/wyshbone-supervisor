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
  artefacts,
  towerJudgements,
  agentRuns,
  goalLedger,
  beliefStore,
  feedbackEvents,
  insertUserSchema,
  insertUserSignalSchema,
  insertSuggestedLeadSchema,
  insertPlanExecutionSchema,
  insertPlanSchema,
  insertSubconsciousNudgeSchema,
  insertArtefactSchema,
  insertTowerJudgementSchema,
  insertAgentRunSchema,
  insertGoalLedgerSchema,
  insertBeliefStoreSchema,
  insertFeedbackEventSchema,
  telemetryEvents,
  policyVersions,
  policyApplications,
  insertTelemetryEventSchema,
  insertPolicyVersionSchema,
  insertPolicyApplicationSchema,
  learningStore,
  insertLearningStoreSchema,
} = schema;

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
  Artefact,
  InsertArtefact,
  TowerJudgement,
  InsertTowerJudgement,
  AgentRun,
  InsertAgentRun,
  GoalLedger,
  InsertGoalLedger,
  BeliefStore,
  InsertBeliefStore,
  FeedbackEvent,
  InsertFeedbackEvent,
  TelemetryEvent,
  InsertTelemetryEvent,
  PolicyVersion,
  InsertPolicyVersion,
  PolicyApplication,
  InsertPolicyApplication,
  LearningStore,
  InsertLearningStore,
} from '@shared/schema';
