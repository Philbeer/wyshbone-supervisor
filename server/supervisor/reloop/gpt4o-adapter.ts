import { executeGpt4oPrimaryPath, type Gpt4oSearchContext } from '../gpt4o-search';
import type { ExecutorInput, ExecutorOutput, ExecutorEntity } from './types';

export async function gpt4oAdapter(input: ExecutorInput): Promise<ExecutorOutput> {
  const startTime = Date.now();
  console.log(`[RELOOP_EXECUTOR] gpt4o_search adapter starting — entity="${input.mission.businessType}" location="${input.mission.location}"`);

  const plan = input.missionContext.plan as any;
  const verificationPolicy = plan?.verification_policy?.verification_policy ?? 'balanced';
  const verificationPolicyReason = plan?.verification_policy?.reason ?? 'default';

  const gpt4oCtx: Gpt4oSearchContext = {
    runId: input.missionContext.runId as string,
    userId: input.missionContext.userId as string,
    conversationId: input.missionContext.conversationId as string | undefined,
    clientRequestId: input.missionContext.clientRequestId as string | undefined,
    rawUserInput: input.mission.rawUserInput,
    normalizedGoal: input.mission.queryText,
    businessType: input.mission.businessType,
    location: input.mission.location,
    country: input.mission.country,
    requestedCount: input.mission.requestedCount,
    hardConstraints: input.constraints.hardConstraints,
    softConstraints: input.constraints.softConstraints,
    structuredConstraints: input.constraints.structuredConstraints,
    intentNarrative: (input.missionContext.intentNarrative as any) ?? null,
    verificationPolicy,
    verificationPolicyReason,
    queryId: (input.missionContext.queryId as string | null | undefined) ?? null,
  };

  const result = await executeGpt4oPrimaryPath(gpt4oCtx);

  const timeMs = Date.now() - startTime;

  const entities: ExecutorEntity[] = result.leads.map(lead => {
    const dsLeads = (result.deliverySummary as any)?.delivered_exact || [];
    const dsLead = dsLeads.find((dl: any) => dl.name === lead.name);
    const matchEvidence = dsLead?.match_evidence || dsLead?.supporting_evidence || [];

    return {
      name: lead.name,
      address: lead.address,
      phone: lead.phone,
      website: lead.website,
      placeId: lead.placeId,
      source: 'gpt4o_web_search',
      verified: true,
      verificationStatus: result.towerVerdict ?? 'unknown',
      evidence: matchEvidence,
    };
  });

  const searchQueriesExhausted = (result.deliverySummary as any)?.rounds_performed >= 3;

  console.log(`[RELOOP_EXECUTOR] gpt4o_search adapter complete — entities=${entities.length} timeMs=${timeMs} verdict=${result.towerVerdict}`);

  return {
    executorType: 'gpt4o_search',
    entities,
    entitiesAttempted: entities.length,
    executionMetadata: {
      toolsUsed: ['gpt4o_web_search'],
      apiCallsMade: (result.deliverySummary as any)?.rounds_performed ?? 1,
      timeMs,
      errorsEncountered: [],
      rateLimitsHit: false,
    },
    coverageSignals: {
      maxResultsHit: entities.length >= (input.mission.requestedCount ?? 20),
      searchQueriesExhausted,
      estimatedUniverseSize: null,
    },
    rawResult: result as unknown as Record<string, unknown>,
  };
}
