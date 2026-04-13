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
import {
  emitPhaseEntered,
  emitMilestoneReached,
  emitIntentResolved,
  emitResultsReady,
} from '../protocol-logger';
import { supabase } from '../../supabase';
import { getExecutor, getAvailableExecutors } from './executor-registry';
import { plan as plannerPlan } from './planner';
import { evaluate as judgeEvaluate } from './judge-adapter';
import { decide as gateDecide } from './gate';
import type { ExecutorInput, ExecutorEntity, ExecutorOutput, LoopRecord, GateDecision, PlannerDecision, ResumeCheckpoint } from './types';
import { judgeArtefact } from '../tower-artefact-judge';
import { computeQueryShapeKey, deriveQueryShapeFromGoal } from '../query-shape-key';
import {
  handleLearningUpdate,
  readLearningStore,
  buildPolicyAppliedPayload,
  emitPolicyAppliedArtefact,
  mergePolicyKnobs,
  BASELINE_DEFAULTS,
} from '../learning-store';

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
  checkpoint?: ResumeCheckpoint | null;
}): Promise<MissionExecutionResult> {
  const {
    runId, userId, conversationId, clientRequestId, rawUserInput,
    mission, plan, missionTrace, intentNarrative, queryId, executionPath,
  } = params;

  const chainId = params.checkpoint?.chainId ?? randomUUID();
  const availableExecutors = getAvailableExecutors();

  console.log(`[RELOOP_SKELETON] Starting re-loop chain. runId=${runId} chainId=${chainId} executors=${availableExecutors.join(',')}`);

  const protocolBase = { userId, runId, conversationId, clientRequestId };
  const isGpt4oPrimary = executionPath === 'gpt4o_primary';
  const manifestPhases = isGpt4oPrimary
    ? [
        { name: 'intent_resolution', label: 'Understanding intent', index: 0 },
        { name: 'gpt4o_search', label: 'GPT-4o search', index: 1 },
        { name: 'quality_check', label: 'Quality check', index: 2 },
        { name: 'delivery', label: 'Delivering results', index: 3 },
      ]
    : [
        { name: 'intent_resolution', label: 'Understanding intent', index: 0 },
        { name: 'gp_cascade', label: 'Google Places search', index: 1 },
        { name: 'web_evidence', label: 'Gathering web evidence', index: 2 },
        { name: 'evidence_verification', label: 'Verifying evidence', index: 3 },
        { name: 'quality_check', label: 'Quality check', index: 4 },
        { name: 'delivery', label: 'Delivering results', index: 5 },
      ];

  console.log('[PROTOCOL_EMIT] Posting run_manifest artefact:', {
    executor: executionPath ?? 'gp_cascade',
    phases: manifestPhases.map(p => p.name),
  });
  createArtefact({
    runId,
    type: 'run_manifest',
    title: 'Run manifest',
    summary: `Protocol manifest for run ${runId}. path=${executionPath ?? 'gp_cascade'} phases=${manifestPhases.map(p => p.name).join(',')}`,
    payload: {
      chain_id: chainId,
      execution_path: executionPath ?? 'gp_cascade',
      phases: manifestPhases,
      available_executors: availableExecutors,
    },
    userId,
    conversationId,
  }).catch(() => {});

  const { businessType, location, country, requestedCount } = deriveSearchParams(mission);
  const hardConstraints = buildHardConstraintLabels(mission);
  const softConstraints = buildSoftConstraintLabels(mission);
  const structuredConstraints = buildStructuredConstraints(mission);
  const normalizedGoal = `Find ${requestedCount ? requestedCount + ' ' : ''}${businessType} in ${location}`;

  const queryShapeInput = deriveQueryShapeFromGoal({
    business_type: businessType,
    location,
    country,
    attribute_filter: null,
    constraints: mission.constraints.map(c => ({
      type: c.type,
      field: c.field,
      hard: c.hardness === 'hard',
      value: typeof c.value === 'string' ? c.value : String(c.value ?? ''),
    })),
  });
  const queryShapeKey = computeQueryShapeKey(queryShapeInput);
  console.log(`[LEARNING] queryShapeKey=${queryShapeKey} for runId=${runId}`);

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

  try {
    const learned = await readLearningStore(queryShapeKey);
    const policy = mergePolicyKnobs(BASELINE_DEFAULTS, learned.exists ? learned.knobs : null, learned.fieldMetadata);
    const policyPayload = buildPolicyAppliedPayload(queryShapeKey, policy, learned.fieldMetadata, learned.exists);

    await emitPolicyAppliedArtefact({
      runId,
      userId,
      conversationId,
      policyApplied: policyPayload,
    });
    console.log(`[LEARNING] Policy applied: shape=${queryShapeKey} learned_used=${policyPayload.learned_used} fields=[${policyPayload.learned_fields_used.join(',')}]`);
  } catch (policyErr: any) {
    console.warn(`[LEARNING] Policy applied artefact failed (non-fatal): ${policyErr.message}`);
  }

  if (intentNarrative) {
    emitIntentResolved({
      ...protocolBase,
      entityDescription: intentNarrative.entity_description,
      scarcityExpectation: intentNarrative.scarcity_expectation,
      keyDiscriminator: intentNarrative.key_discriminator,
      findability: intentNarrative.findability,
      exclusions: intentNarrative.entity_exclusions,
    }).catch(() => {});
  }

  const loopHistory: LoopRecord[] = [];
  const accumulatedEntityMap = new Map<string, ExecutorEntity>();
  const executorsTriedSoFar: string[] = [];
  let loopNumber = 0;
  let finalRawResult: Record<string, unknown> = {};
  let lastGateDecision: GateDecision | null = null;

  // Wall-clock deadline for the entire reloop chain. Prevents infinite execution
  // when individual loops contain slow LLM calls, web visits, or Tower round-trips.
  // Defaults to 8 minutes (well under the 12-minute hard task timeout in supervisor.ts).
  const RELOOP_WALL_CLOCK_TIMEOUT_MS = parseInt(
    process.env.RELOOP_WALL_CLOCK_TIMEOUT_MS || String(8 * 60 * 1000), 10,
  );
  const reloopStartMs = Date.now();
  const isReloopDeadlineExceeded = (): boolean => {
    const elapsed = Date.now() - reloopStartMs;
    if (elapsed > RELOOP_WALL_CLOCK_TIMEOUT_MS) {
      console.warn(`[RELOOP_DEADLINE] runId=${runId} chainId=${chainId} — wall-clock timeout exceeded: ${Math.round(elapsed / 1000)}s > ${Math.round(RELOOP_WALL_CLOCK_TIMEOUT_MS / 1000)}s — forcing delivery`);
      return true;
    }
    return false;
  };

  // ── Restore state from checkpoint if resuming ──
  const isResuming = !!params.checkpoint?.canResume;

  if (isResuming && params.checkpoint) {
    const cp = params.checkpoint;
    console.log(`[RELOOP_SKELETON] RESUMING from checkpoint: lastCompletedLoop=${cp.lastCompletedLoop} resumeFrom=${cp.resumeFrom} entities=${cp.accumulatedEntities.length}`);

    for (const entity of cp.accumulatedEntities) {
      accumulatedEntityMap.set(normaliseEntityName(entity.name), entity);
    }

    loopHistory.push(...cp.loopHistory);
    executorsTriedSoFar.push(...cp.executorsTriedSoFar);
    loopNumber = cp.lastCompletedLoop;

    if (cp.finalRawResult && Object.keys(cp.finalRawResult).length > 0) {
      finalRawResult = cp.finalRawResult;
    }

    await createArtefact({
      runId,
      type: 'diagnostic',
      title: `Crash recovery: resuming from loop ${cp.lastCompletedLoop + 1} (${cp.resumeFrom})`,
      summary: `Recovered ${cp.accumulatedEntities.length} entities from ${cp.lastCompletedLoop} completed loop(s). Resume phase: ${cp.resumeFrom}.`,
      payload: {
        chain_id: chainId,
        resume_from: cp.resumeFrom,
        last_completed_loop: cp.lastCompletedLoop,
        accumulated_entities_count: cp.accumulatedEntities.length,
        executors_tried: cp.executorsTriedSoFar,
        loop_history_count: cp.loopHistory.length,
      },
      userId,
      conversationId,
    }).catch(e => console.warn(`[RELOOP_SKELETON] recovery artefact failed (non-fatal): ${e.message}`));

    logRunEvent(runId, {
      stage: 'reloop_resume',
      level: 'info',
      message: `Resuming from loop ${cp.lastCompletedLoop + 1} (${cp.resumeFrom}). ${cp.accumulatedEntities.length} entities recovered.`,
      queryText: rawUserInput,
      metadata: {
        chain_id: chainId,
        resume_from: cp.resumeFrom,
        last_completed_loop: cp.lastCompletedLoop,
        accumulated_entities: cp.accumulatedEntities.length,
      },
    });
  }

  while (true) {
    loopNumber++;
    const loopStartedAt = new Date().toISOString();
    const loopStartMs = Date.now();

    // Check wall-clock deadline before starting a new loop.
    // This exits cleanly with whatever entities have been accumulated so far.
    const reloopDeadlineHit = isReloopDeadlineExceeded();

    const circuitBreaker = loopNumber > maxLoops || reloopDeadlineHit;

    console.log(`[RELOOP_SKELETON] ── Loop ${loopNumber} start ── chainId=${chainId} circuitBreaker=${circuitBreaker}`);

    // ── Crash recovery: skip planner + executor if resuming mid-loop ──
    const isResumeJudgeLoop = isResuming
      && params.checkpoint?.resumeFrom === 'judge'
      && loopNumber === (params.checkpoint.lastCompletedLoop + 1);

    const knownEntityNames = Array.from(accumulatedEntityMap.keys());
    let plannerDecision: PlannerDecision;
    let executorOutput: ExecutorOutput;

    if (isResumeJudgeLoop && params.checkpoint?.lastPlannerDecision && params.checkpoint?.lastExecutorOutput) {
      // Recovery: skip planner + executor, use checkpoint data
      plannerDecision = params.checkpoint.lastPlannerDecision;
      executorOutput = params.checkpoint.lastExecutorOutput;
      console.log(`[RELOOP_SKELETON] Loop ${loopNumber}: RECOVERY — skipping planner+executor, using checkpoint data. executor=${plannerDecision.executorType} entities=${executorOutput.entities.length}`);
      executorsTriedSoFar.push(plannerDecision.executorType);
    } else {
      // Normal flow: plan then execute
      plannerDecision = await plannerPlan({
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

      const executorInput: ExecutorInput = {
        ...baseExecutorInput,
        executorType: plannerDecision.executorType,
        knownEntities: knownEntityNames,
      };

      console.log(`[RELOOP_SKELETON] Loop ${loopNumber}: running executor "${plannerDecision.executorType}" knownEntities=${knownEntityNames.length}`);

      console.log('[EXECUTOR_START] Beginning execution after clarification:', {
        executor: plannerDecision.executorType,
        runId,
        clientRequestId,
        query: rawUserInput,
      });

      console.log('[PROTOCOL_EMIT] logPhaseEntered:', {
        phaseName: plannerDecision.executorType,
        phaseLabel: `Searching: ${businessType} in ${location}`,
        phaseIndex: 1,
        totalPhases: isGpt4oPrimary ? 4 : 6,
      });
      emitPhaseEntered({
        ...protocolBase,
        phaseName: plannerDecision.executorType,
        phaseLabel: `Searching: ${businessType} in ${location}`,
        phaseIndex: 1,
        totalPhases: isGpt4oPrimary ? 4 : 6,
        detail: `Loop ${loopNumber}`,
      }).catch(() => {});

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

      executorsTriedSoFar.push(plannerDecision.executorType);

      console.log('[PROTOCOL_EMIT] logMilestoneReached:', {
        milestoneKey: `${plannerDecision.executorType}_complete`,
        milestoneText: `${plannerDecision.executorType} search complete`,
        phaseName: plannerDecision.executorType,
      });
      emitMilestoneReached({
        ...protocolBase,
        milestoneKey: `${plannerDecision.executorType}_complete`,
        milestoneText: `${plannerDecision.executorType} search complete`,
        phaseName: plannerDecision.executorType,
        detail: `Loop ${loopNumber} — found ${executorOutput.entities.length} entities`,
      }).catch(() => {});

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

      // ── Phase 1 Write: executor done, judge not yet run ──
      if (supabase) {
        try {
          const { error: phase1Error } = await supabase.from('loop_state').insert({
            chain_id: chainId,
            run_id: runId,
            user_id: userId,
            loop_number: loopNumber,
            executor_type: plannerDecision.executorType,
            planner_decision: plannerDecision as unknown as Record<string, unknown>,
            executor_output_summary: executorOutputSummary,
            executor_completed: true,
            executor_output_full: executorOutput as unknown as Record<string, unknown>,
            accumulated_entities: JSON.stringify(Array.from(accumulatedEntityMap.values())),
            judge_verdict: {},
            gate_decision: {},
            entities_found_this_loop: executorOutput.entities.length,
            entities_accumulated_total: accumulatedEntityMap.size,
            status: 'active',
            created_at: loopStartedAt,
            completed_at: null,
          });
          if (phase1Error) {
            console.warn(`[RELOOP_PERSIST] Loop ${loopNumber} phase-1 insert failed: ${phase1Error.message}`);
          } else {
            console.log(`[RELOOP_PERSIST] Loop ${loopNumber} phase-1 persisted (executor done, judge pending). chainId=${chainId}`);
          }
        } catch (phase1Err: any) {
          console.warn(`[RELOOP_PERSIST] Loop ${loopNumber} phase-1 insert threw: ${phase1Err.message}`);
        }
      } else {
        console.warn(`[RELOOP_PERSIST] Supabase not configured — skipping loop_state phase-1 for loop ${loopNumber}`);
      }
    }

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

    if (Object.keys(executorOutput.rawResult).length > 0) {
      finalRawResult = executorOutput.rawResult;
    }

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

    // ── Phase 2 Write: judge + gate done, entities merged ──
    if (supabase) {
      try {
        const { error: phase2Error } = await supabase.from('loop_state')
          .update({
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
            accumulated_entities: JSON.stringify(Array.from(accumulatedEntityMap.values())),
            status: loopStatus,
            completed_at: loopCompletedAt,
          })
          .eq('chain_id', chainId)
          .eq('loop_number', loopNumber);
        if (phase2Error) {
          console.warn(`[RELOOP_PERSIST] Loop ${loopNumber} phase-2 update failed: ${phase2Error.message}`);
        } else {
          console.log(`[RELOOP_PERSIST] Loop ${loopNumber} phase-2 persisted to loop_state. chainId=${chainId} status=${loopStatus}`);
        }
      } catch (phase2Err: any) {
        console.warn(`[RELOOP_PERSIST] Loop ${loopNumber} phase-2 update threw: ${phase2Err.message}`);
      }
    } else {
      console.warn(`[RELOOP_PERSIST] Supabase not configured — skipping loop_state phase-2 for loop ${loopNumber}`);
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

  try {
    const executorPerformance: Record<string, number> = {};
    for (const record of loopHistory) {
      const exec = record.plannerDecision.executorType;
      const found = record.executorOutput.entities.length;
      executorPerformance[exec] = (executorPerformance[exec] || 0) + found;
    }

    const bestExecutor = Object.entries(executorPerformance)
      .sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'gp_cascade';

    await handleLearningUpdate({
      query_shape_key: queryShapeKey,
      run_id: runId,
      updates: {
        search_budget_pages: totalLoops,
        default_result_count: totalEntities,
      },
    });
    console.log(`[LEARNING] Recorded outcome: shape=${queryShapeKey} bestExecutor=${bestExecutor} performance=${JSON.stringify(executorPerformance)}`);
  } catch (learnErr: any) {
    console.warn(`[LEARNING] Failed to record executor performance (non-fatal): ${learnErr.message}`);
  }

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

  // Only deliver entities that were actually verified by evidence
  const verifiedLeads = combinedLeads.filter(l => l.verified === true);
  const deliveredLeads = requestedCount
    ? verifiedLeads.slice(0, requestedCount)
    : verifiedLeads;

  console.log(`[RELOOP_SKELETON] Combined delivery: ${combinedLeads.length} accumulated → ${verifiedLeads.length} verified → ${deliveredLeads.length} delivered`);

  const circuitBreakerFired = lastGateDecision?.circuitBreaker ?? false;
  const circuitBreakerNote = circuitBreakerFired
    ? `I tried ${executorsTriedSoFar.join(' and ')} across ${totalLoops} search rounds but couldn't find all ${requestedCount ?? 'requested'} results. Here are the ${deliveredLeads.length} I'm confident about.`
    : null;
  const shortfallNote = !circuitBreakerFired && requestedCount && deliveredLeads.length < requestedCount
    ? `I searched using ${executorsTriedSoFar.join(' and ')} and found ${deliveredLeads.length} verified results out of ${requestedCount} requested.`
    : null;
  const deliveryNote = circuitBreakerNote ?? shortfallNote ?? null;

  console.log(`[RELOOP_SKELETON] Delivery note: ${deliveryNote ?? 'none'}`);

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

  let combinedTowerVerdict: string | null = null;

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
        delivery_note: deliveryNote,
      },
      userId,
      conversationId,
    });

    // Check if the per-loop Tower already passed for a single-loop run.
    // If so, skip the combined Tower call — the combined delivery is identical
    // to the per-loop delivery and re-judging it risks a contradictory verdict.
    const perLoopTowerVerdict = (finalRawResult as any)?.towerVerdict ?? null;
    const skipCombinedTower = totalLoops === 1 && perLoopTowerVerdict === 'pass';

    if (skipCombinedTower) {
      console.log(`[RELOOP_SKELETON] Single loop with per-loop Tower PASS — skipping combined Tower call. Using per-loop verdict.`);
      combinedTowerVerdict = 'pass';
    } else {
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
        queryShapeKey: queryShapeKey,
      });

      console.log(`[RELOOP_SKELETON] Combined delivery Tower verdict: ${towerResult.judgement.verdict} action=${towerResult.judgement.action} delivered=${deliveredLeads.length}`);
      combinedTowerVerdict = towerResult.judgement.verdict;
    }

    emitPhaseEntered({
      ...protocolBase,
      phaseName: 'quality_check',
      phaseLabel: 'Quality check',
      phaseIndex: isGpt4oPrimary ? 2 : 4,
      totalPhases: isGpt4oPrimary ? 4 : 6,
      detail: `Tower verdict: ${combinedTowerVerdict ?? 'unknown'}`,
    }).catch(() => {});

    emitMilestoneReached({
      ...protocolBase,
      milestoneKey: 'quality_check_complete',
      milestoneText: 'Quality check complete',
      phaseName: 'quality_check',
      detail: `Tower verdict: ${combinedTowerVerdict ?? 'unknown'}`,
    }).catch(() => {});
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

  // Merge delivery summaries from all loops
  const allDeliverySummaries = loopHistory
    .map(r => (r.executorOutput.rawResult as any)?.deliverySummary)
    .filter(Boolean);
  console.log(`[RELOOP_SKELETON] Merging ${allDeliverySummaries.length} delivery summaries from ${loopHistory.length} loops`);

  // Build merged delivered_exact from all loops' delivery summaries
  // Fix B: check multiple possible field names to handle format differences between executors
  const mergedExact: any[] = [];
  const mergedClosest: any[] = [];
  const seenNames = new Set<string>();
  for (const ds of allDeliverySummaries) {
    const exactLeads = ds.delivered_exact || ds.leads || ds.results || [];
    const closestLeads = ds.delivered_closest || [];
    console.log(`[RELOOP_SKELETON] Merge: ds has delivered_exact=${(ds.delivered_exact || []).length} leads=${(ds.leads || []).length} results=${(ds.results || []).length} delivered_closest=${closestLeads.length}`);
    for (const lead of exactLeads) {
      const key = (lead.name || '').toLowerCase().trim();
      if (key && !seenNames.has(key)) {
        seenNames.add(key);
        mergedExact.push(lead);
      }
    }
    for (const lead of closestLeads) {
      const key = (lead.name || '').toLowerCase().trim();
      if (key && !seenNames.has(key)) {
        seenNames.add(key);
        mergedClosest.push(lead);
      }
    }
  }

  // Fix C: fallback — if merge produced nothing but we have verified entities, build from accumulator
  if (mergedExact.length === 0 && deliveredLeads.length > 0) {
    console.warn(`[RELOOP_SKELETON] Merge found 0 delivered_exact but ${deliveredLeads.length} verified leads exist — building from entity accumulator`);
    for (const lead of deliveredLeads) {
      mergedExact.push({
        entity_id: lead.placeId || `lead:${lead.name}`,
        name: lead.name,
        address: lead.address,
        match_level: 'exact',
        soft_violations: [],
        match_valid: true,
        match_summary: `Found via ${lead.source || 'search'}`,
        source: lead.source,
      });
    }
    console.log(`[RELOOP_SKELETON] Fallback built ${mergedExact.length} delivered_exact entries from entity accumulator`);
  }

  const lastDs = allDeliverySummaries[allDeliverySummaries.length - 1];
  const mergedDeliverySummary = lastDs ? {
    ...lastDs,
    delivered_exact: mergedExact,
    delivered_closest: mergedClosest,
    delivered_exact_count: mergedExact.length,
    delivered_total_count: mergedExact.length + mergedClosest.length,
    shortfall: requestedCount ? Math.max(0, requestedCount - mergedExact.length) : 0,
    tower_verdict: combinedTowerVerdict,
    delivery_note: deliveryNote,
  } : null;

  const combinedResult: MissionExecutionResult = {
    response: (lastRawResult.response as string) ?? 'Run complete. Results are available.',
    leadIds: (lastRawResult.leadIds as string[]) ?? [],
    deliverySummary: mergedDeliverySummary,
    towerVerdict: combinedTowerVerdict ?? (lastRawResult.towerVerdict as string) ?? null,
    leads: deliveredLeads.map(l => ({
      name: l.name,
      address: l.address,
      phone: l.phone,
      website: l.website,
      placeId: l.placeId,
    })),
  };

  emitPhaseEntered({
    ...protocolBase,
    phaseName: 'delivery',
    phaseLabel: 'Delivering results',
    phaseIndex: isGpt4oPrimary ? 3 : 5,
    totalPhases: isGpt4oPrimary ? 4 : 6,
    detail: `${deliveredLeads.length} leads`,
  }).catch(() => {});

  emitMilestoneReached({
    ...protocolBase,
    milestoneKey: 'delivery_complete',
    milestoneText: 'Delivery complete',
    phaseName: 'delivery',
    detail: `${deliveredLeads.length} leads delivered`,
  }).catch(() => {});

  emitResultsReady({
    ...protocolBase,
    resultCount: deliveredLeads.length,
    resultType: 'leads',
    towerVerdict: combinedTowerVerdict,
    totalLoops,
  }).catch(() => {});

  return combinedResult;
}
