import type { ExecutorInput, ExecutorOutput } from './types';

/**
 * gpt4o_verified executor — STUB (Step 1 of plan)
 *
 * Future steps will implement:
 *   - Step 2: loose-prompt GPT-4o websearch discovery (15-30 candidates)
 *   - Step 3: per-lead per-constraint verification via cheap LLM (Haiku/Groq)
 *   - Step 4: aggregation into full-match / partial-match / dropped
 *
 * This stub returns 0 entities so the planner can register the executor type
 * without it producing fake results during development.
 */
export async function gpt4oVerifiedAdapter(input: ExecutorInput): Promise<ExecutorOutput> {
  const startTime = Date.now();
  console.log(
    `[RELOOP_EXECUTOR] gpt4o_verified adapter starting (STUB) — ` +
    `entity="${input.mission.businessType}" location="${input.mission.location}"`,
  );
  console.log(
    `[RELOOP_EXECUTOR] gpt4o_verified is currently a stub. ` +
    `Returning 0 entities. Real implementation is Step 2+ of the gpt4o_verified plan.`,
  );

  return {
    executorType: 'gpt4o_verified',
    entities: [],
    entitiesAttempted: 0,
    executionMetadata: {
      toolsUsed: [],
      apiCallsMade: 0,
      timeMs: Date.now() - startTime,
      errorsEncountered: ['stub_executor_not_yet_implemented'],
      rateLimitsHit: false,
    },
    coverageSignals: {
      maxResultsHit: false,
      searchQueriesExhausted: true,
      estimatedUniverseSize: null,
    },
    rawResult: {
      stub: true,
      message: 'gpt4o_verified executor is registered but not yet implemented (Step 1 of plan)',
    },
  };
}
