import type { LoopRecord, PlannerDecision } from './types';

export function plan(context: {
  loopNumber: number;
  loopHistory: LoopRecord[];
  executionPath?: 'gp_cascade' | 'gpt4o_primary';
  availableExecutors: string[];
  circuitBreaker: boolean;
}): PlannerDecision {
  const { loopNumber, loopHistory, executionPath, availableExecutors, circuitBreaker } = context;

  const executorsTriedSoFar = new Set(loopHistory.map(r => r.plannerDecision.executorType));

  if (circuitBreaker) {
    const fastest = availableExecutors[0] ?? 'gp_cascade';
    const reason = `Circuit breaker active — this is the last attempt. Using ${fastest}.`;
    console.log(`[RELOOP_PLANNER] Loop ${loopNumber}: chose ${fastest} because ${reason}`);
    return { executorType: fastest, reasoning: reason };
  }

  if (loopNumber === 1) {
    if (executionPath === 'gpt4o_primary') {
      const reason = 'User explicitly requested GPT-4o primary path for first loop.';
      console.log(`[RELOOP_PLANNER] Loop ${loopNumber}: chose gpt4o_search because ${reason}`);
      return { executorType: 'gpt4o_search', reasoning: reason };
    }
    const reason = 'First loop — using GP cascade (cheap, fast, structured data).';
    console.log(`[RELOOP_PLANNER] Loop ${loopNumber}: chose gp_cascade because ${reason}`);
    return { executorType: 'gp_cascade', reasoning: reason };
  }

  const lastLoop = loopHistory[loopHistory.length - 1];
  const lastExecutor = lastLoop?.plannerDecision.executorType ?? '';

  if (lastExecutor === 'gp_cascade' && availableExecutors.includes('gpt4o_search') && !executorsTriedSoFar.has('gpt4o_search')) {
    const reason = 'Re-loop after GP cascade exhaustion — switching to GPT-4o search for broader web coverage.';
    console.log(`[RELOOP_PLANNER] Loop ${loopNumber}: chose gpt4o_search because ${reason}`);
    return { executorType: 'gpt4o_search', reasoning: reason };
  }

  if (lastExecutor === 'gpt4o_search') {
    const reason = 'Re-loop after GPT-4o exhaustion — no more executors available, signalling deliver.';
    console.log(`[RELOOP_PLANNER] Loop ${loopNumber}: no more executors. Chose gp_cascade (last resort) because ${reason}`);
    return { executorType: lastExecutor, reasoning: reason };
  }

  const untried = availableExecutors.find(e => !executorsTriedSoFar.has(e));
  if (untried) {
    const reason = `Trying untried executor ${untried} on loop ${loopNumber}.`;
    console.log(`[RELOOP_PLANNER] Loop ${loopNumber}: chose ${untried} because ${reason}`);
    return { executorType: untried, reasoning: reason };
  }

  const fallback = lastExecutor || availableExecutors[0] || 'gp_cascade';
  const reason = `No untried executors remain — retrying ${fallback} as last resort.`;
  console.log(`[RELOOP_PLANNER] Loop ${loopNumber}: chose ${fallback} because ${reason}`);
  return { executorType: fallback, reasoning: reason };
}
