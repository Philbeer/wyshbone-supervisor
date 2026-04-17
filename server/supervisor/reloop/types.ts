import type { StructuredConstraintPayload } from '../mission-executor';

// ── Executor Interface ──
export interface ExecutorInput {
  executorType: string;
  mission: {
    queryText: string;
    rawUserInput: string;
    businessType: string;
    location: string;
    country: string;
    requestedCount: number | null;
  };
  constraints: {
    hardConstraints: string[];
    softConstraints: string[];
    structuredConstraints: StructuredConstraintPayload[];
  };
  knownEntities: string[];
  budget: {
    maxApiCalls: number;
    maxTimeMs: number;
  };
  missionContext: Record<string, unknown>;
}

export interface ExecutorOutput {
  executorType: string;
  entities: ExecutorEntity[];
  entitiesAttempted: number;
  executionMetadata: {
    toolsUsed: string[];
    apiCallsMade: number;
    timeMs: number;
    errorsEncountered: string[];
    rateLimitsHit: boolean;
  };
  coverageSignals: {
    maxResultsHit: boolean;
    searchQueriesExhausted: boolean;
    estimatedUniverseSize: number | null;
  };
  rawResult: Record<string, unknown>;
}

export interface ExecutorEntity {
  name: string;
  address: string;
  phone: string | null;
  website: string | null;
  placeId: string;
  source: string;
  verified: boolean;
  verificationStatus: string;
  evidence: Record<string, unknown>[];
}

// ── Judge → Gate ──
export interface JudgeVerdict {
  verdict: 'PASS' | 'CAPABILITY_FAIL' | 'EXECUTION_FAIL' | 'PARTIAL';
  confidence: number;
  variableState: VariableState;
  evidenceSummary: {
    totalChecks: number;
    checksWithEvidence: number;
    towerVerified: number;
    sourceTierMix: Record<string, number>;
  };
  recommendation: 'deliver' | 're_loop' | 're_loop_different_tool';
  recommendationReason: string;
  rawTowerVerdict: string | null;
  rawTowerPayload: Record<string, unknown> | null;
}

export interface VariableState {
  resultCount: { found: number; expected: number | null; concern: boolean };
  toolExhaustion: { exhausted: boolean; tool: string; concern: boolean };
  coverageGap: { percentage: number | null; concern: boolean };
  evidenceQuality: { verifiedCount: number; totalCount: number; concern: boolean };
  duplicateRate: { rate: number; concern: boolean };
}

// ── Gate Decision ──
export interface GateDecision {
  decision: 're_loop' | 'stop_deliver';
  contextForward: {
    accumulatedEntities: ExecutorEntity[];
    loopHistory: LoopRecord[];
    variableState: VariableState;
    suggestedNextExecutor: string | null;
    failureContext: string;
  };
  loopNumber: number;
  circuitBreaker: boolean;
}

// ── Planner Output ──
export interface PlannerDecision {
  executorType: string;
  reasoning: string;
  adjustedMission?: Partial<ExecutorInput['mission']>;
}

// ── Loop Record (one complete iteration) ──
export interface LoopRecord {
  loopNumber: number;
  plannerDecision: PlannerDecision;
  executorOutput: ExecutorOutput;
  judgeVerdict: JudgeVerdict;
  gateDecision: GateDecision;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

// ── Supabase persistence ──
export interface LoopStateRow {
  id: string;
  chain_id: string;
  run_id: string;
  loop_number: number;
  executor_type: string;
  planner_decision: Record<string, unknown>;
  executor_output_summary: Record<string, unknown>;
  judge_verdict: Record<string, unknown>;
  gate_decision: Record<string, unknown>;
  entities_found_this_loop: number;
  entities_accumulated_total: number;
  status: 'active' | 'delivered' | 'circuit_broken';
  created_at: string;
  completed_at: string | null;
  executor_completed?: boolean;
  accumulated_entities?: string;
  executor_output_full?: Record<string, unknown>;
}

// ── Crash Recovery ──
export interface ResumeCheckpoint {
  canResume: boolean;
  chainId: string;
  lastCompletedLoop: number;
  resumeFrom: 'planner' | 'judge' | 'full_restart';
  accumulatedEntities: ExecutorEntity[];
  loopHistory: LoopRecord[];
  executorsTriedSoFar: string[];
  lastExecutorOutput?: ExecutorOutput;
  lastPlannerDecision?: PlannerDecision;
  finalRawResult?: Record<string, unknown>;
}
