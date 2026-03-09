import { classifyRunFailure, type RunContext, type PlanHistoryEntry } from './classifyRunFailure';
import type { BenchmarkRunRecord } from '../types/BenchmarkRunRecord';

// Future extension: benchmark runs may be stored in a `benchmark_runs` database table.
// For now, logging to stdout as structured JSON is sufficient.

export interface BenchmarkRunInput {
  runId: string;
  query: string;
  requestedCount: number;
  deliveredCount: number;
  verifiedCount: number;
  towerVerdict: string | null;
  replansTriggered: number;
  runContext: RunContext;
  planHistory: PlanHistoryEntry[];
  uiVerdict?: string | null;
  notes?: string;
}

export function recordBenchmarkRun(input: BenchmarkRunInput): BenchmarkRunRecord {
  const failureClassification = classifyRunFailure(
    input.runContext,
    input.towerVerdict,
    input.planHistory,
    input.uiVerdict,
  );

  const record: BenchmarkRunRecord = {
    run_id: input.runId,
    query: input.query,
    requested_count: input.requestedCount,
    delivered_count: input.deliveredCount,
    verified_count: input.verifiedCount,
    tower_verdict: input.towerVerdict ?? 'unknown',
    replans_triggered: input.replansTriggered,
    failure_classification: failureClassification,
    ...(input.notes ? { notes: input.notes } : {}),
    timestamp: new Date().toISOString(),
  };

  console.log(`[BENCHMARK] ${JSON.stringify(record)}`);

  return record;
}
