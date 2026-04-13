import {
  executeMissionDrivenPlan,
  type MissionExecutionContext,
} from '../mission-executor';
import type { ExecutorInput, ExecutorOutput, ExecutorEntity } from './types';

export async function gpCascadeAdapter(input: ExecutorInput): Promise<ExecutorOutput> {
  const startTime = Date.now();
  console.log(`[RELOOP_EXECUTOR] gp_cascade adapter starting — loop entity="${input.mission.businessType}" location="${input.mission.location}"`);

  const missionCtx: MissionExecutionContext = {
    mission: input.missionContext.mission as any,
    plan: input.missionContext.plan as any,
    runId: input.missionContext.runId as string,
    userId: input.missionContext.userId as string,
    conversationId: input.missionContext.conversationId as string | undefined,
    clientRequestId: input.missionContext.clientRequestId as string | undefined,
    rawUserInput: input.mission.rawUserInput,
    missionTrace: input.missionContext.missionTrace as any,
    intentNarrative: (input.missionContext.intentNarrative as any) ?? null,
    queryId: (input.missionContext.queryId as string | null | undefined) ?? null,
    executionPath: 'gp_cascade',
    suppressDeliverySummary: true,
  };

  const result = await executeMissionDrivenPlan(missionCtx);

  const timeMs = Date.now() - startTime;

  const entities: ExecutorEntity[] = result.leads.map(lead => ({
    name: lead.name,
    address: lead.address,
    phone: lead.phone,
    website: lead.website,
    placeId: lead.placeId,
    source: 'gp_cascade',
    verified: result.towerVerdict === 'pass' || result.towerVerdict === 'accept',
    verificationStatus: result.towerVerdict ?? 'unknown',
    evidence: [],
  }));

  const deliverySummary = result.deliverySummary as Record<string, unknown> | null;
  const candidateCount = (deliverySummary as any)?.candidate_count ??
    (deliverySummary as any)?.total_candidates ??
    entities.length;

  console.log(`[RELOOP_EXECUTOR] gp_cascade adapter complete — entities=${entities.length} timeMs=${timeMs} verdict=${result.towerVerdict}`);

  return {
    executorType: 'gp_cascade',
    entities,
    entitiesAttempted: typeof candidateCount === 'number' ? candidateCount : entities.length,
    executionMetadata: {
      toolsUsed: ['google_places'],
      apiCallsMade: 1,
      timeMs,
      errorsEncountered: [],
      rateLimitsHit: false,
    },
    coverageSignals: {
      maxResultsHit: entities.length >= (input.mission.requestedCount ?? 20),
      searchQueriesExhausted: false,
      estimatedUniverseSize: null,
    },
    rawResult: result as unknown as Record<string, unknown>,
  };
}
