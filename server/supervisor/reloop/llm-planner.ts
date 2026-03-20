import type { PlannerDecision } from './types';
import type { PlannerContext } from './planner';
import { rulesPlan } from './planner';
import { getAllExecutorMeta } from './executor-registry';
import { createArtefact } from '../artefacts';

function buildSystemPrompt(context: PlannerContext): string {
  const { loopNumber, loopHistory, availableExecutors, circuitBreaker, mission, constraints, intentNarrative } = context;

  const allMeta = getAllExecutorMeta();

  const section1 = `You are the Wyshbone planner. Your job is to decide which search executor to use for the next loop iteration.

Principles:
- Pick the executor best suited to the query type, not just the cheapest
- On re-loops, learn from what the previous loop found (or didn't find) and change strategy
- Never pass expected outcomes downstream — executors discover, they don't confirm
- If the circuit breaker is active, pick the fastest executor for a final attempt
- Your reasoning field is logged for debugging — be specific about WHY you chose this executor`;

  const catalogueLines: string[] = [];
  for (const executorId of availableExecutors) {
    const meta = allMeta.get(executorId);
    if (!meta) continue;
    catalogueLines.push(`### ${executorId}
Description: ${meta.description}
Strengths: ${meta.strengths}
Limitations: ${meta.limitations}
Typical use: ${meta.typicalUse}
Cost tier: ${meta.costTier}`);
  }
  const section2 = `## Available Executors\n\n${catalogueLines.join('\n\n')}`;

  const section3 = `## Re-loop Variable Definitions

Re-loop variables that indicate whether previous loops succeeded or failed:
- resultCount: how many entities were found vs how many were requested. Concern if found < 70% of expected.
- toolExhaustion: whether the previous executor hit its result cap. If true, the same executor will likely return similar results.
- coverageGap: percentage of requested count actually found. Below 50% is a significant gap.
- evidenceQuality: what proportion of found entities have verified evidence. Below 50% is a concern.
- duplicateRate: if re-running the same executor, how many results overlap with what we already have. High duplication (>50%) means that executor has been exhausted.

Key thresholds:
- Coverage below 50%: strong signal to switch tools
- Coverage 50-70%: consider switching if another tool is well-suited
- Coverage above 70%: likely sufficient, deliver unless evidence quality is poor
- Tool exhaustion + low coverage: MUST switch to a different executor`;

  const sessionLines: string[] = [];

  sessionLines.push(`## Session Context`);
  sessionLines.push(`Loop number: ${loopNumber}`);
  sessionLines.push(`Circuit breaker active: ${circuitBreaker}`);

  if (mission) {
    sessionLines.push(`Raw user input: ${mission.rawUserInput}`);
    sessionLines.push(`Entity type: ${mission.businessType}`);
    sessionLines.push(`Location: ${mission.location}, ${mission.country}`);
    sessionLines.push(`Requested count: ${mission.requestedCount ?? 'unspecified'}`);
  }

  if (constraints) {
    if (constraints.hardConstraints.length > 0) {
      sessionLines.push(`Hard constraints: ${constraints.hardConstraints.join('; ')}`);
    }
    if (constraints.softConstraints.length > 0) {
      sessionLines.push(`Soft constraints: ${constraints.softConstraints.join('; ')}`);
    }
  }

  if (intentNarrative) {
    sessionLines.push(`Entity description: ${intentNarrative.entityDescription}`);
    sessionLines.push(`Key discriminator: ${intentNarrative.keyDiscriminator}`);
    sessionLines.push(`Findability: ${intentNarrative.findability}`);
    sessionLines.push(`Scarcity expectation: ${intentNarrative.scarcityExpectation}`);
    if (intentNarrative.entityExclusions.length > 0) {
      sessionLines.push(`Exclusions: ${intentNarrative.entityExclusions.join(', ')}`);
    }
    if (intentNarrative.suggestedApproaches.length > 0) {
      sessionLines.push(`Suggested approaches: ${intentNarrative.suggestedApproaches.join('; ')}`);
    }
  }

  if (loopHistory.length > 0) {
    sessionLines.push(`\n## Previous Loop History`);
    for (const record of loopHistory) {
      const vs = record.judgeVerdict.variableState;
      sessionLines.push(`Loop ${record.loopNumber}:
  executor: ${record.plannerDecision.executorType}
  entities found: ${record.executorOutput.entities.length}
  judge verdict: ${record.judgeVerdict.verdict}
  gate decision: ${record.gateDecision.decision}
  failure context: ${record.gateDecision.contextForward.failureContext}
  result count concern: ${vs.resultCount.concern} (found=${vs.resultCount.found}, expected=${vs.resultCount.expected ?? 'unknown'})
  tool exhaustion: ${vs.toolExhaustion.exhausted}
  coverage gap: ${vs.coverageGap.percentage !== null ? vs.coverageGap.percentage + '%' : 'unknown'} (concern=${vs.coverageGap.concern})
  evidence quality concern: ${vs.evidenceQuality.concern}
  duplicate rate concern: ${vs.duplicateRate.concern} (rate=${vs.duplicateRate.rate})`);
    }
  }

  const executorsTriedSoFar = loopHistory.map(r => r.plannerDecision.executorType);
  if (executorsTriedSoFar.length > 0) {
    sessionLines.push(`\nExecutors already tried: ${executorsTriedSoFar.join(', ')}`);
  }

  const section4 = sessionLines.join('\n');

  return [section1, section2, section3, section4].join('\n\n');
}

export async function llmPlan(context: PlannerContext): Promise<PlannerDecision> {
  const { loopNumber, availableExecutors } = context;

  console.log(`[RELOOP_LLM_PLANNER] Loop ${loopNumber}: LLM planner invoked (executors=${availableExecutors.join(',')})`);

  const systemPrompt = buildSystemPrompt(context);
  const userMessage = `Based on the context above, which executor should run for loop ${loopNumber}? Respond with JSON only:
{
  "executor_type": "one of the available executor IDs",
  "reasoning": "2-3 sentences explaining your choice"
}`;

  const startMs = Date.now();

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const timeoutMs = 10_000;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('LLM planner timed out after 10s')), timeoutMs)
  );

  const completionPromise = client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.2,
    max_tokens: 256,
    response_format: { type: 'json_object' },
  });

  const response = await Promise.race([completionPromise, timeoutPromise]);

  const latencyMs = Date.now() - startMs;
  const rawContent = response.choices[0]?.message?.content ?? '';
  const usage = response.usage;

  console.log(`[RELOOP_LLM_PLANNER] Loop ${loopNumber}: raw response received (latency=${latencyMs}ms, tokens=${usage?.prompt_tokens ?? '?'}/${usage?.completion_tokens ?? '?'})`);

  let parsed: { executor_type: string; reasoning: string };
  try {
    parsed = JSON.parse(rawContent);
  } catch (parseErr: any) {
    throw new Error(`Failed to parse LLM planner JSON response: ${parseErr.message}. Raw: ${rawContent}`);
  }

  const chosenExecutor = parsed.executor_type;
  const reasoning = parsed.reasoning;

  if (!chosenExecutor || !availableExecutors.includes(chosenExecutor)) {
    throw new Error(`LLM planner returned invalid executor_type "${chosenExecutor}". Available: ${availableExecutors.join(', ')}`);
  }

  if (!reasoning || typeof reasoning !== 'string' || reasoning.trim().length === 0) {
    throw new Error('LLM planner returned empty or missing reasoning field.');
  }

  console.log(`[RELOOP_LLM_PLANNER] Loop ${loopNumber}: chose ${chosenExecutor} because ${reasoning} (latency=${latencyMs}ms, tokens=${usage?.prompt_tokens ?? '?'}/${usage?.completion_tokens ?? '?'})`);

  const runId = (context as any).runId as string | undefined;
  const userId = (context as any).userId as string | undefined;
  const conversationId = (context as any).conversationId as string | undefined;

  if (runId && userId) {
    createArtefact({
      runId,
      type: 'reloop_planner_decision',
      title: `LLM planner decision — loop ${loopNumber}: ${chosenExecutor}`,
      summary: reasoning,
      payload: {
        loop_number: loopNumber,
        system_prompt: systemPrompt,
        user_message: userMessage,
        raw_response: rawContent,
        parsed_decision: { executor_type: chosenExecutor, reasoning },
        latency_ms: latencyMs,
        tokens_in: usage?.prompt_tokens ?? null,
        tokens_out: usage?.completion_tokens ?? null,
      },
      userId,
      conversationId,
    }).catch(e => console.warn(`[RELOOP_LLM_PLANNER] artefact creation failed (non-fatal): ${e.message}`));
  }

  return { executorType: chosenExecutor, reasoning };
}
