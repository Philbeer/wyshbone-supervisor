import type { JudgeVerdict, GateDecision, ExecutorEntity, LoopRecord } from './types';

const MAX_LOOPS_DEFAULT = 3;

function getMaxLoops(): number {
  const env = process.env.RELOOP_MAX_LOOPS;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return MAX_LOOPS_DEFAULT;
}

function normaliseEntityName(name: string): string {
  return name.toLowerCase().replace(/^the\s+/i, '').trim();
}

function deduplicateEntities(entities: ExecutorEntity[]): ExecutorEntity[] {
  const seen = new Map<string, ExecutorEntity>();
  for (const entity of entities) {
    const key = normaliseEntityName(entity.name);
    if (!seen.has(key)) {
      seen.set(key, entity);
    }
  }
  return Array.from(seen.values());
}

export function decide(params: {
  loopNumber: number;
  judgeVerdict: JudgeVerdict;
  accumulatedEntities: ExecutorEntity[];
  currentLoopEntities: ExecutorEntity[];
  loopHistory: LoopRecord[];
  availableExecutors: string[];
  executorsTriedSoFar: string[];
}): GateDecision {
  const {
    loopNumber,
    judgeVerdict,
    accumulatedEntities,
    currentLoopEntities,
    loopHistory,
    availableExecutors,
    executorsTriedSoFar,
  } = params;

  const PARTIAL_RELOOP_PCT = parseInt(process.env.RELOOP_PARTIAL_RELOOP_PCT ?? '60', 10);
  const PASS_CONFIDENCE = parseFloat(process.env.RELOOP_PASS_CONFIDENCE ?? '0.6');

  console.log(`[RELOOP_GATE] Thresholds: PARTIAL_RELOOP_PCT=${PARTIAL_RELOOP_PCT} PASS_CONFIDENCE=${PASS_CONFIDENCE}`);

  const MAX_LOOPS = getMaxLoops();

  const newAccumulated = deduplicateEntities([...accumulatedEntities, ...currentLoopEntities]);

  const circuitBreakerFired = loopNumber >= MAX_LOOPS;

  if (circuitBreakerFired) {
    const reason = `Circuit breaker fired at loop ${loopNumber} (MAX_LOOPS=${MAX_LOOPS}). Forcing delivery.`;
    console.log(`[RELOOP_GATE] Loop ${loopNumber}: decision=stop_deliver reason=${reason} accumulated=${newAccumulated.length} circuitBreaker=true`);
    return {
      decision: 'stop_deliver',
      contextForward: {
        accumulatedEntities: newAccumulated,
        loopHistory,
        variableState: judgeVerdict.variableState,
        suggestedNextExecutor: null,
        failureContext: reason,
      },
      loopNumber,
      circuitBreaker: true,
    };
  }

  if (loopHistory.length >= 2) {
    const previousLoop = loopHistory[loopHistory.length - 1];
    const previousCount = previousLoop.executorOutput.entities.length;
    const currentCount = currentLoopEntities.length;
    if (currentCount <= previousCount && currentCount === 0) {
      const reason = `No improvement between loops (previous=${previousCount}, current=${currentCount}). Stopping to avoid wasting API calls.`;
      console.log(`[RELOOP_GATE] Loop ${loopNumber}: decision=stop_deliver reason=${reason} accumulated=${newAccumulated.length} circuitBreaker=false`);
      return {
        decision: 'stop_deliver',
        contextForward: {
          accumulatedEntities: newAccumulated,
          loopHistory,
          variableState: judgeVerdict.variableState,
          suggestedNextExecutor: null,
          failureContext: reason,
        },
        loopNumber,
        circuitBreaker: false,
      };
    }
  }

  const { verdict, confidence, recommendation, recommendationReason } = judgeVerdict;

  if (verdict === 'PASS' && confidence > PASS_CONFIDENCE) {
    const reason = `Verdict PASS with confidence ${confidence.toFixed(2)}. Delivering results.`;
    console.log(`[RELOOP_GATE] Loop ${loopNumber}: decision=stop_deliver reason=${reason} accumulated=${newAccumulated.length} circuitBreaker=false`);
    return {
      decision: 'stop_deliver',
      contextForward: {
        accumulatedEntities: newAccumulated,
        loopHistory,
        variableState: judgeVerdict.variableState,
        suggestedNextExecutor: null,
        failureContext: '',
      },
      loopNumber,
      circuitBreaker: false,
    };
  }

  if (verdict === 'CAPABILITY_FAIL') {
    const untriedExecutors = availableExecutors.filter(e => !executorsTriedSoFar.includes(e));
    if (untriedExecutors.length > 0) {
      const nextExecutor = untriedExecutors[0];
      const reason = `CAPABILITY_FAIL — tool hit its limit. Switching to ${nextExecutor} for broader coverage. ${recommendationReason}`;
      console.log(`[RELOOP_GATE] Loop ${loopNumber}: decision=re_loop reason=${reason} accumulated=${newAccumulated.length} circuitBreaker=false`);
      return {
        decision: 're_loop',
        contextForward: {
          accumulatedEntities: newAccumulated,
          loopHistory,
          variableState: judgeVerdict.variableState,
          suggestedNextExecutor: nextExecutor,
          failureContext: reason,
        },
        loopNumber,
        circuitBreaker: false,
      };
    }
    const reason = `CAPABILITY_FAIL but no more executors available. Delivering with what was found.`;
    console.log(`[RELOOP_GATE] Loop ${loopNumber}: decision=stop_deliver reason=${reason} accumulated=${newAccumulated.length} circuitBreaker=false`);
    return {
      decision: 'stop_deliver',
      contextForward: {
        accumulatedEntities: newAccumulated,
        loopHistory,
        variableState: judgeVerdict.variableState,
        suggestedNextExecutor: null,
        failureContext: reason,
      },
      loopNumber,
      circuitBreaker: false,
    };
  }

  if (verdict === 'PARTIAL') {
    const untriedExecutors = availableExecutors.filter(e => !executorsTriedSoFar.includes(e));
    const coveragePercent = judgeVerdict.variableState.coverageGap.percentage;
    const shouldReloop = untriedExecutors.length > 0 && (coveragePercent === null || coveragePercent < PARTIAL_RELOOP_PCT);
    if (shouldReloop) {
      const nextExecutor = untriedExecutors[0];
      const reason = `PARTIAL results (coverage=${coveragePercent ?? '?'}%) — re-looping with ${nextExecutor} to improve coverage. ${recommendationReason}`;
      console.log(`[RELOOP_GATE] Loop ${loopNumber}: decision=re_loop reason=${reason} accumulated=${newAccumulated.length} circuitBreaker=false`);
      return {
        decision: 're_loop',
        contextForward: {
          accumulatedEntities: newAccumulated,
          loopHistory,
          variableState: judgeVerdict.variableState,
          suggestedNextExecutor: nextExecutor,
          failureContext: reason,
        },
        loopNumber,
        circuitBreaker: false,
      };
    }
    const reason = `PARTIAL results (coverage=${coveragePercent ?? '?'}%) but coverage is acceptable or no more executors. Delivering.`;
    console.log(`[RELOOP_GATE] Loop ${loopNumber}: decision=stop_deliver reason=${reason} accumulated=${newAccumulated.length} circuitBreaker=false`);
    return {
      decision: 'stop_deliver',
      contextForward: {
        accumulatedEntities: newAccumulated,
        loopHistory,
        variableState: judgeVerdict.variableState,
        suggestedNextExecutor: null,
        failureContext: reason,
      },
      loopNumber,
      circuitBreaker: false,
    };
  }

  if (verdict === 'EXECUTION_FAIL') {
    const alreadyRetried = loopHistory.some(
      r => r.judgeVerdict.verdict === 'EXECUTION_FAIL' &&
           r.plannerDecision.executorType === executorsTriedSoFar[executorsTriedSoFar.length - 1],
    );
    if (!alreadyRetried) {
      const sameExecutor = executorsTriedSoFar[executorsTriedSoFar.length - 1] ?? 'gp_cascade';
      const reason = `EXECUTION_FAIL — retrying same executor (${sameExecutor}) once. ${recommendationReason}`;
      console.log(`[RELOOP_GATE] Loop ${loopNumber}: decision=re_loop reason=${reason} accumulated=${newAccumulated.length} circuitBreaker=false`);
      return {
        decision: 're_loop',
        contextForward: {
          accumulatedEntities: newAccumulated,
          loopHistory,
          variableState: judgeVerdict.variableState,
          suggestedNextExecutor: sameExecutor,
          failureContext: reason,
        },
        loopNumber,
        circuitBreaker: false,
      };
    }
    const reason = `EXECUTION_FAIL after retry — delivering with accumulated results.`;
    console.log(`[RELOOP_GATE] Loop ${loopNumber}: decision=stop_deliver reason=${reason} accumulated=${newAccumulated.length} circuitBreaker=false`);
    return {
      decision: 'stop_deliver',
      contextForward: {
        accumulatedEntities: newAccumulated,
        loopHistory,
        variableState: judgeVerdict.variableState,
        suggestedNextExecutor: null,
        failureContext: reason,
      },
      loopNumber,
      circuitBreaker: false,
    };
  }

  const reason = `Unknown verdict ${verdict} — defaulting to deliver.`;
  console.log(`[RELOOP_GATE] Loop ${loopNumber}: decision=stop_deliver reason=${reason} accumulated=${newAccumulated.length} circuitBreaker=false`);
  return {
    decision: 'stop_deliver',
    contextForward: {
      accumulatedEntities: newAccumulated,
      loopHistory,
      variableState: judgeVerdict.variableState,
      suggestedNextExecutor: null,
      failureContext: reason,
    },
    loopNumber,
    circuitBreaker: false,
  };
}
