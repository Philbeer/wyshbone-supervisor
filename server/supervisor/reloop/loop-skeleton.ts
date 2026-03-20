import { randomUUID } from 'crypto';
import type { StructuredMission, MissionExtractionTrace, IntentNarrative } from '../mission-schema';
import type { MissionPlan } from '../mission-planner';
import type { MissionExecutionResult } from '../mission-executor';
import {
  deriveSearchParams,
  buildHardConstraintLabels,
  buildSoftConstraintLabels,
  buildStructuredConstraints,
} from '../mission-executor';
import { createArtefact } from '../artefacts';
import { logAFREvent } from '../afr-logger';
import { logRunEvent } from '../run-logger';
import { supabase } from '../../supabase';
import { getExecutor, getAvailableExecutors } from './executor-registry';
import { plan as plannerPlan } from './planner';
import { evaluate as judgeEvaluate } from './judge-adapter';
import { decide as gateDecide } from './gate';
import type { ExecutorInput, ExecutorEntity, LoopRecord, GateDecision } from './types';
import { judgeArtefact } from '../tower-artefact-judge';

function normaliseEntityName(name: string): string {
  return name.toLowerCase().replace(/^the\s+/i, '').trim();
}

export async function runReloop(params: {
  runId: string;
  userId: string;
  conversationId?: string;
  clientRequestId?: string;
  rawUserInput: string;
  mission: StructuredMission;
  plan: MissionPlan;
  missionTrace: MissionExtractionTrace;
  intentNarrative: IntentNarrative | null;
  queryId?: string | null;
  executionPath?: 'gp_cascade' | 'gpt4o_primary';
}): Promise<MissionExecutionResult> {
  const {
    runId, userId, conversationId, clientRequestId, rawUserInput,
    mission, plan, missionTrace, intentNarrative, queryId, executionPath,
  } = params;

  const chainId = randomUUID();
  const availableExecutors = getAvailableExecutors();

  console.log(`[RELOOP_SKELETON] Starting re-loop chain. runId=${runId} chainId=${chainId} executors=${availableExecutors.join(',')}`);

  const { businessType, location, country, requestedCount } = deriveSearchParams(mission);
  const hardConstraints = buildHardConstraintLabels(mission);
  const softConstraints = buildSoftConstraintLabels(mission);
  const structuredConstraints = buildStructuredConstraints(mission);
  const normalizedGoal = `Find ${requestedCount ? requestedCount + ' ' : ''}${businessType} in ${location}`;

  const MAX_LOOPS_DEFAULT = 3;
  const maxLoops = (() => {
    const env = process.env.RELOOP_MAX_LOOPS;
    if (env) {
      const parsed = parseInt(env, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return MAX_LOOPS_DEFAULT;
  })();

  logRunEvent(runId, {
    stage: 'reloop_start',
    level: 'info',
    message: `Reloop chain started: ${normalizedGoal}`,
    queryText: rawUserInput,
    metadata: {
      chain_id: chainId,
      max_loops: maxLoops,
      available_executors: availableExecutors,
      execution_path: executionPath ?? 'gp_cascade',
    },
  });

  const missionContext: Record<string, unknown> = {
    mission,
    plan,
    missionTrace,
    intentNarrative,
    runId,
    userId,
    conversationId,
    clientRequestId,
    queryId,
    rawUserInput,
    normalizedGoal,
    hardConstraints,
    softConstraints,
    structuredConstraints,
  };

  const baseExecutorInput: ExecutorInput = {
    executorType: '',
    mission: {
      queryText: normalizedGoal,
      rawUserInput,
      businessType,
      location,
      country,
      requestedCount,
    },
    constraints: {
      hardConstraints,
      softConstraints,
      structuredConstraints: structuredConstraints as unknown as Record<string, unknown>[],
    },
    knownEntities: [],
    budget: {
      maxApiCalls: 50,
      maxTimeMs: 300_000,
    },
    missionContext,
  };

  const loopHistory: LoopRecord[] = [];
  const accumulatedEntityMap = new Map<string, ExecutorEntity>();
  const executorsTriedSoFar: string[] = [];
  let loopNumber = 0;
  let finalRawResult: Record<string, unknown> = {};
  let lastGateDecision: GateDecision | null = null;

  while (true) {
    loopNumber++;
    const loopStartedAt = new Date().toISOString();
    const loopStartMs = Date.now();

    const circuitBreaker = loopNumber > maxLoops;

    console.log(`[RELOOP_SKELETON] ── Loop ${loopNumber} start ── chainId=${chainId} circuitBreaker=${circuitBreaker}`);

    const plannerDecision = await plannerPlan({
      loopNumber,
      loopHistory,
      executionPath,
      availableExecutors,
      circuitBreaker,
      mission: baseExecutorInput.mission,
      constraints: {
        hardConstraints,
        softConstraints,
      },
      intentNarrative: intentNarrative ? {
        entityDescription: intentNarrative.entity_description,
        keyDiscriminator: intentNarrative.key_discriminator,
        findability: intentNarrative.findability,
        scarcityExpectation: intentNarrative.scarcity_expectation,
        entityExclusions: intentNarrative.entity_exclusions,
        suggestedApproaches: intentNarrative.suggested_approaches,
      } : null,
      runId,
      userId,
      conversationId,
    });

    const executorFn = getExecutor(plannerDecision.executorType);
    if (!executorFn) {
      console.error(`[RELOOP_SKELETON] No executor found for type "${plannerDecision.executorType}". Breaking.`);
      break;
    }

    const knownEntityNames = Array.from(accumulatedEntityMap.keys());
    const executorInput: ExecutorInput = {
      ...baseExecutorInput,
      executorType: plannerDecision.executorType,
      knownEntities: knownEntityNames,
    };

    console.log(`[RELOOP_SKELETON] Loop ${loopNumber}: running executor "${plannerDecision.executorType}" knownEntities=${knownEntityNames.length}`);

    let executorOutput;
    try {
      executorOutput = await executorFn(executorInput);
    } catch (execErr: any) {
      console.error(`[RELOOP_SKELETON] Loop ${loopNumber}: executor "${plannerDecision.executorType}" threw: ${execErr.message}`);
      executorOutput = {
        executorType: plannerDecision.executorType,
        entities: [],
        entitiesAttempted: 0,
        executionMetadata: {
          toolsUsed: [],
          apiCallsMade: 0,
          timeMs: Date.now() - loopStartMs,
          errorsEncountered: [execErr.message ?? String(execErr)],
          rateLimitsHit: false,
        },
        coverageSignals: {
          maxResultsHit: false,
          searchQueriesExhausted: false,
          estimatedUniverseSize: null,
        },
        rawResult: {},
      };
    }

    if (Object.keys(executorOutput.rawResult).length > 0) {
      finalRawResult = executorOutput.rawResult;
    }

    executorsTriedSoFar.push(plannerDecision.executorType);

    const judgeVerdict = judgeEvaluate({
      executorOutput,
      requestedCount,
      knownEntityNames,
      availableExecutors,
      executorsTriedSoFar,
    });

    const gateDecision = gateDecide({
      loopNumber,
      judgeVerdict,
      accumulatedEntities: Array.from(accumulatedEntityMap.values()),
      currentLoopEntities: executorOutput.entities,
      loopHistory,
      availableExecutors,
      executorsTriedSoFar,
    });

    lastGateDecision = gateDecision;

    for (const entity of gateDecision.contextForward.accumulatedEntities) {
      const key = normaliseEntityName(entity.name);
      accumulatedEntityMap.set(key, entity);
    }

    const loopCompletedAt = new Date().toISOString();
    const loopDurationMs = Date.now() - loopStartMs;

    const loopRecord: LoopRecord = {
      loopNumber,
      plannerDecision,
      executorOutput,
      judgeVerdict,
      gateDecision,
      startedAt: loopStartedAt,
      completedAt: loopCompletedAt,
      durationMs: loopDurationMs,
    };
    loopHistory.push(loopRecord);

    const isLastLoop = gateDecision.decision === 'stop_deliver' || circuitBreaker;
    const loopStatus: 'active' | 'delivered' | 'circuit_broken' = isLastLoop
      ? (gateDecision.circuitBreaker ? 'circuit_broken' : 'delivered')
      : 'active';

    const executorOutputSummary = {
      executorType: executorOutput.executorType,
      entitiesFound: executorOutput.entities.length,
      entitiesAttempted: executorOutput.entitiesAttempted,
      timeMs: executorOutput.executionMetadata.timeMs,
      apiCallsMade: executorOutput.executionMetadata.apiCallsMade,
      errorsEncountered: executorOutput.executionMetadata.errorsEncountered,
      rateLimitsHit: executorOutput.executionMetadata.rateLimitsHit,
      coverageSignals: executorOutput.coverageSignals,
    };

    if (supabase) {
      try {
        const { error } = await supabase.from('loop_state').insert({
          chain_id: chainId,
          run_id: runId,
          user_id: userId,
          loop_number: loopNumber,
          executor_type: plannerDecision.executorType,
          planner_decision: plannerDecision as unknown as Record<string, unknown>,
          executor_output_summary: executorOutputSummary,
          judge_verdict: judgeVerdict as unknown as Record<string, unknown>,
          gate_decision: {
            decision: gateDecision.decision,
            loopNumber: gateDecision.loopNumber,
            circuitBreaker: gateDecision.circuitBreaker,
            failureContext: gateDecision.contextForward.failureContext,
            suggestedNextExecutor: gateDecision.contextForward.suggestedNextExecutor,
          },
          entities_found_this_loop: executorOutput.entities.length,
          entities_accumulated_total: accumulatedEntityMap.size,
          status: loopStatus,
          created_at: loopStartedAt,
          completed_at: loopCompletedAt,
        });
        if (error) {
          console.warn(`[RELOOP_PERSIST] Loop ${loopNumber} Supabase insert failed: ${error.message}`);
        } else {
          console.log(`[RELOOP_PERSIST] Loop ${loopNumber} persisted to loop_state. chainId=${chainId} status=${loopStatus}`);
        }
      } catch (persistErr: any) {
        console.warn(`[RELOOP_PERSIST] Loop ${loopNumber} Supabase insert threw: ${persistErr.message}`);
      }
    } else {
      console.warn(`[RELOOP_PERSIST] Supabase not configured — skipping loop_state persistence for loop ${loopNumber}`);
    }

    await createArtefact({
      runId,
      type: 'reloop_iteration',
      title: `Re-loop iteration ${loopNumber}: ${plannerDecision.executorType} → ${judgeVerdict.verdict}`,
      summary: `Loop ${loopNumber} | executor=${plannerDecision.executorType} | verdict=${judgeVerdict.verdict} | entities=${executorOutput.entities.length} | gate=${gateDecision.decision}`,
      payload: {
        chain_id: chainId,
        loop_number: loopNumber,
        executor_type: plannerDecision.executorType,
        planner_decision: plannerDecision,
        executor_output_summary: executorOutputSummary,
        judge_verdict: judgeVerdict,
        gate_decision: {
          decision: gateDecision.decision,
          loopNumber: gateDecision.loopNumber,
          circuitBreaker: gateDecision.circuitBreaker,
          failureContext: gateDecision.contextForward.failureContext,
          suggestedNextExecutor: gateDecision.contextForward.suggestedNextExecutor,
        },
        accumulated_count: accumulatedEntityMap.size,
        duration_ms: loopDurationMs,
      },
      userId,
      conversationId,
    }).catch(e => console.warn(`[RELOOP_SKELETON] artefact creation failed (non-fatal): ${e.message}`));

    await logAFREvent({
      userId, runId, conversationId, clientRequestId,
      actionTaken: 'reloop_iteration',
      status: judgeVerdict.verdict === 'EXECUTION_FAIL' ? 'failed' : 'success',
      taskGenerated: `Re-loop ${loopNumber}: ${plannerDecision.executorType} → ${judgeVerdict.verdict} → ${gateDecision.decision} (accumulated=${accumulatedEntityMap.size})`,
      runType: 'plan',
      metadata: {
        chain_id: chainId,
        loop_number: loopNumber,
        executor_type: plannerDecision.executorType,
        verdict: judgeVerdict.verdict,
        gate_decision: gateDecision.decision,
        entities_found: executorOutput.entities.length,
        accumulated_total: accumulatedEntityMap.size,
        circuit_breaker: gateDecision.circuitBreaker,
      },
    }).catch(e => console.warn(`[RELOOP_SKELETON] AFR event failed (non-fatal): ${e.message}`));

    logRunEvent(runId, {
      stage: `reloop_iteration_${loopNumber}`,
      level: 'info',
      message: `Loop ${loopNumber}: ${plannerDecision.executorType} → ${judgeVerdict.verdict} → ${gateDecision.decision} (${accumulatedEntityMap.size} accumulated)`,
      queryText: rawUserInput,
      metadata: {
        chain_id: chainId,
        loop_number: loopNumber,
        executor_type: plannerDecision.executorType,
        verdict: judgeVerdict.verdict,
        gate_decision: gateDecision.decision,
        entities_found: executorOutput.entities.length,
        accumulated_total: accumulatedEntityMap.size,
      },
    });

    if (gateDecision.circuitBreaker) {
      await createArtefact({
        runId,
        type: 'diagnostic',
        title: `Re-loop circuit breaker fired at loop ${loopNumber}`,
        summary: `Max loops (${maxLoops}) reached. Forcing delivery with ${accumulatedEntityMap.size} accumulated entities.`,
        payload: {
          chain_id: chainId,
          max_loops: maxLoops,
          loop_number: loopNumber,
          accumulated_entities: accumulatedEntityMap.size,
          failure_context: gateDecision.contextForward.failureContext,
        },
        userId,
        conversationId,
      }).catch(e => console.warn(`[RELOOP_SKELETON] circuit breaker artefact failed (non-fatal): ${e.message}`));
    }

    if (gateDecision.decision === 'stop_deliver' || circuitBreaker) {
      console.log(`[RELOOP_SKELETON] Loop ${loopNumber}: gate decided stop_deliver. Breaking loop.`);
      break;
    }

    console.log(`[RELOOP_SKELETON] Loop ${loopNumber}: gate decided re_loop. Continuing to loop ${loopNumber + 1}.`);
  }

  const totalEntities = accumulatedEntityMap.size;
  const totalLoops = loopHistory.length;

  await createArtefact({
    runId,
    type: 'reloop_chain_summary',
    title: `Re-loop complete: ${totalLoops} loop${totalLoops === 1 ? '' : 's'}, ${totalEntities} entities`,
    summary: `Re-loop chain finished. chainId=${chainId} loops=${totalLoops} accumulated=${totalEntities} final_gate=${lastGateDecision?.decision ?? 'unknown'}`,
    payload: {
      chain_id: chainId,
      total_loops: totalLoops,
      total_entities: totalEntities,
      executors_tried: executorsTriedSoFar,
      final_gate_decision: lastGateDecision?.decision ?? null,
      circuit_breaker_fired: lastGateDecision?.circuitBreaker ?? false,
      loop_history: loopHistory.map(r => ({
        loop_number: r.loopNumber,
        executor_type: r.plannerDecision.executorType,
        verdict: r.judgeVerdict.verdict,
        gate_decision: r.gateDecision.decision,
        entities_found: r.executorOutput.entities.length,
        duration_ms: r.durationMs,
      })),
    },
    userId,
    conversationId,
  }).catch(e => console.warn(`[RELOOP_SKELETON] chain summary artefact failed (non-fatal): ${e.message}`));

  console.log(`[RELOOP_SKELETON] Chain complete. chainId=${chainId} loops=${totalLoops} accumulated=${totalEntities}`);

  logRunEvent(runId, {
    stage: 'reloop_complete',
    level: 'info',
    message: `Reloop chain complete: ${totalLoops} loops, ${totalEntities} entities`,
    queryText: rawUserInput,
    metadata: {
      chain_id: chainId,
      total_loops: totalLoops,
      total_entities: totalEntities,
      executors_tried: executorsTriedSoFar,
      final_gate: lastGateDecision?.decision ?? null,
    },
  });

  // ── Combined delivery: merge all entities from all loops ──
  const allEntities = Array.from(accumulatedEntityMap.values());

  // Build combined leads array with source tagging
  const combinedLeads = allEntities.map(entity => ({
    name: entity.name,
    address: entity.address,
    phone: entity.phone,
    website: entity.website,
    placeId: entity.placeId,
    source: entity.source,
    verified: entity.verified,
    verificationStatus: entity.verificationStatus,
  }));

  // Trim to requested count if specified
  const deliveredLeads = requestedCount
    ? combinedLeads.slice(0, requestedCount)
    : combinedLeads;

  logRunEvent(runId, {
    stage: 'combined_delivery_start',
    level: 'info',
    message: `Building combined delivery: ${deliveredLeads.length} leads from ${totalLoops} loops (accumulated=${allEntities.length})`,
    queryText: rawUserInput,
    metadata: {
      chain_id: chainId,
      delivered_count: deliveredLeads.length,
      accumulated_total: allEntities.length,
      total_loops: totalLoops,
    },
  });

  // Judge the combined delivery — this is the final verdict for the whole run
  try {
    const combinedArtefact = await createArtefact({
      runId,
      type: 'combined_delivery',
      title: `Combined delivery: ${deliveredLeads.length} leads from ${totalLoops} loop${totalLoops === 1 ? '' : 's'}`,
      summary: `${deliveredLeads.length} leads delivered | loops=${totalLoops} | executors=${executorsTriedSoFar.join(',')} | requested=${requestedCount ?? 'any'}`,
      payload: {
        chain_id: chainId,
        total_loops: totalLoops,
        executors_tried: executorsTriedSoFar,
        requested_count: requestedCount,
        delivered_count: deliveredLeads.length,
        accumulated_total: allEntities.length,
        leads: deliveredLeads,
        per_loop_counts: loopHistory.map(r => ({
          loop: r.loopNumber,
          executor: r.plannerDecision.executorType,
          found: r.executorOutput.entities.length,
        })),
      },
      userId,
      conversationId,
    });

    const towerResult = await judgeArtefact({
      artefact: combinedArtefact,
      runId,
      goal: normalizedGoal,
      userId,
      conversationId,
      successCriteria: {
        mission_type: 'leadgen',
        target_count: requestedCount ?? 20,
        requested_count_user: requestedCount !== null ? 'explicit' : 'implicit',
        requested_count_value: requestedCount,
        hard_constraints: hardConstraints,
        soft_constraints: softConstraints,
        structured_constraints: structuredConstraints,
        intent_narrative: intentNarrative ?? null,
      },
      intent_narrative: intentNarrative ?? null,
      queryId: queryId ?? null,
    });

    console.log(`[RELOOP_SKELETON] Combined delivery Tower verdict: ${towerResult.judgement.verdict} action=${towerResult.judgement.action} delivered=${deliveredLeads.length}`);
  } catch (judgeErr: any) {
    const errMsg = judgeErr?.message ?? String(judgeErr);
    const errStack = judgeErr?.stack ?? '';
    console.error(`[RELOOP_SKELETON] Combined delivery judgement failed (non-fatal): ${errMsg}`, errStack);
    logRunEvent(runId, {
      stage: 'combined_delivery_error',
      level: 'error',
      message: `Combined delivery failed: ${errMsg}`,
      queryText: rawUserInput,
      metadata: {
        chain_id: chainId,
        error: errMsg,
        stack: errStack.substring(0, 500),
      },
    });
  }

  // Build the MissionExecutionResult from combined entities
  // Use the last loop's raw result as the base, then override leads
  const lastRawResult = finalRawResult as Record<string, unknown>;
  const combinedResult: MissionExecutionResult = {
    response: (lastRawResult.response as string) ?? 'Run complete. Results are available.',
    leadIds: (lastRawResult.leadIds as string[]) ?? [],
    deliverySummary: (lastRawResult.deliverySummary as any) ?? null,
    towerVerdict: (lastRawResult.towerVerdict as string) ?? null,
    leads: deliveredLeads.map(l => ({
      name: l.name,
      address: l.address,
      phone: l.phone,
      website: l.website,
      placeId: l.placeId,
    })),
  };

  return combinedResult;
}
