import { storage } from '../storage';
import { createArtefact } from './artefacts';
import type { Artefact } from '../schema';

export interface RunConfig {
  run_type: string;
  scenario?: string;
  constraints: Record<string, unknown>;
  user_inputs?: Record<string, unknown>;
  goal?: string;
}

export interface StepFact {
  step_index: number;
  label: string;
  action_taken: string;
  scrap_rate_percent: number | null;
  achievable_scrap_floor_percent: number | null;
  baseline_scrap_percent: number | null;
  drift_detected: boolean | null;
  drift_reason: string | null;
  defect_type: string | null;
  energy_per_part: number | null;
  notes: string | null;
  decision: string | null;
  decision_reason: string | null;
  expected_impact: string | null;
  tower_verdict: string | null;
  tower_action: string | null;
  tower_reasons: string[];
}

export interface OutcomeFact {
  outcome: string;
  stopped_by_tower: boolean;
  stopped_at_step: number | null;
  final_scrap_rate: number | null;
  target_scrap: number | null;
  achievable_floor: number | null;
  floor_above_target: boolean | null;
  plan_changed: boolean;
  mitigation_used: string | null;
  mitigation_attempts: number;
  stop_reason: string | null;
}

export interface RunFactsBundle {
  run_id: string;
  run_type: string;
  generated_at: string;
  config: RunConfig;
  steps: StepFact[];
  outcome: OutcomeFact;
}

function buildFactoryTldr(bundle: RunFactsBundle): string {
  const goal = bundle.outcome.target_scrap;
  const goalLabel = goal !== null ? `${goal}%` : 'an acceptable level';
  const finalScrap = bundle.outcome.final_scrap_rate;
  const lowestPossible = bundle.outcome.achievable_floor;
  const stopped = bundle.outcome.stopped_by_tower;
  const planChanged = bundle.outcome.plan_changed;
  const outcome = bundle.outcome.outcome;

  let sentence1 = `You asked the system to run the factory with no more than ${goalLabel} waste.`;

  let sentence2: string;
  let sentence3: string | null = null;

  if (stopped) {
    if (bundle.outcome.stopped_at_step === 0 || bundle.outcome.stopped_at_step === 1) {
      sentence2 = finalScrap !== null
        ? `The factory produced ${finalScrap}% waste right away, which was already over the ${goalLabel} goal.`
        : `The factory immediately produced more waste than allowed.`;
    } else {
      sentence2 = finalScrap !== null
        ? `Waste reached ${finalScrap}% during production and could not be brought down enough.`
        : `Waste rose during production and could not be reduced enough.`;
    }
    if (lowestPossible !== null && goal !== null && lowestPossible > goal) {
      sentence3 = `The system stopped because even the best possible waste level (${lowestPossible}%) was still above your ${goalLabel} goal.`;
    } else {
      sentence3 = `The system stopped the run because the goal could not be met.`;
    }
  } else if (planChanged) {
    sentence2 = finalScrap !== null
      ? `Waste increased during production, so the system changed its approach.`
      : `Production conditions changed, so the system adjusted its strategy.`;
    if (outcome === 'success' || outcome === 'completed') {
      sentence3 = finalScrap !== null
        ? `After the change, waste dropped to ${finalScrap}% and production finished successfully.`
        : `After the change, waste came back within the goal and production continued.`;
    } else {
      sentence3 = `Despite the change, the run did not fully meet the goal.`;
    }
  } else {
    if (outcome === 'success' || outcome === 'completed') {
      sentence2 = finalScrap !== null
        ? `The factory kept waste at ${finalScrap}% throughout the run, well within the goal.`
        : `The factory stayed within the waste goal throughout the run.`;
      sentence3 = `No changes were needed.`;
    } else {
      sentence2 = `The run ended without a clear result in the recorded data.`;
    }
  }

  const parts = [sentence1, sentence2];
  if (sentence3) parts.push(sentence3);
  return parts.join('\n');
}

function buildTldr(bundle: RunFactsBundle): string {
  switch (bundle.run_type) {
    case 'factory_demo':
      return buildFactoryTldr(bundle);
    default:
      return buildFactoryTldr(bundle);
  }
}

function extractPayload(artefact: Artefact): Record<string, unknown> {
  return (artefact.payloadJson as Record<string, unknown>) ?? {};
}

function buildFactoryFactsBundle(runId: string, artefacts: Artefact[]): RunFactsBundle {
  const sorted = [...artefacts].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const planArtefact = sorted.find(a => a.type === 'plan');
  const planPayload = planArtefact ? extractPayload(planArtefact) : {};
  const resultArtefact = sorted.find(a => a.type === 'plan_result');
  const resultPayload = resultArtefact ? extractPayload(resultArtefact) : {};

  const stateArtefacts = sorted.filter(a => a.type === 'factory_state');
  const decisionArtefacts = sorted.filter(a => a.type === 'factory_decision');
  const judgementArtefacts = sorted.filter(a => a.type === 'tower_judgement');

  const constraints = (planPayload.constraints as Record<string, unknown>) ?? {};
  const scenario = (planPayload.scenario as string) ?? 'unknown';

  const config: RunConfig = {
    run_type: 'factory_demo',
    scenario,
    constraints,
    goal: planArtefact?.summary ?? `Injection moulding demo: scenario=${scenario}`,
  };

  const steps: StepFact[] = [];
  for (const stateArt of stateArtefacts) {
    const sp = extractPayload(stateArt);
    const stepIdx = (sp.step_index as number) ?? steps.length;

    const matchingDecision = decisionArtefacts.find(d => {
      const dp = extractPayload(d);
      return (dp.step_index as number) === stepIdx;
    });
    const dp = matchingDecision ? extractPayload(matchingDecision) : {};

    const matchingJudgement = judgementArtefacts.find(j => {
      const jp = extractPayload(j);
      return (jp.step_index as number) === stepIdx;
    });
    const jp = matchingJudgement ? extractPayload(matchingJudgement) : {};

    steps.push({
      step_index: stepIdx,
      label: stateArt.title?.replace(/^Factory State: Step \d+ — /, '') ?? `Step ${stepIdx + 1}`,
      action_taken: (sp.action_taken as string) ?? 'unknown',
      scrap_rate_percent: (sp.scrap_rate_now as number) ?? null,
      achievable_scrap_floor_percent: (sp.achievable_scrap_floor_percent as number) ?? (sp.achievable_scrap_floor as number) ?? null,
      baseline_scrap_percent: (sp.baseline_scrap_percent as number) ?? null,
      drift_detected: (sp.drift_detected as boolean) ?? null,
      drift_reason: (sp.drift_reason as string) ?? null,
      defect_type: (sp.defect_type as string) ?? null,
      energy_per_part: (sp.energy_per_part as number) ?? (sp.energy_kwh_per_good_part as number) ?? null,
      notes: (sp.notes as string) ?? null,
      decision: (dp.decision as string) ?? null,
      decision_reason: (dp.reason as string) ?? null,
      expected_impact: (dp.expected_impact as string) ?? null,
      tower_verdict: (jp.verdict as string) ?? null,
      tower_action: (jp.action as string) ?? null,
      tower_reasons: (jp.reasons as string[]) ?? [],
    });
  }

  const outcome: OutcomeFact = {
    outcome: (resultPayload.outcome as string) ?? 'unknown',
    stopped_by_tower: (resultPayload.outcome as string) === 'stopped',
    stopped_at_step: (resultPayload.stopped_at_step as number) ?? null,
    final_scrap_rate: (resultPayload.final_scrap_rate as number) ?? null,
    target_scrap: (resultPayload.target_scrap as number) ?? null,
    achievable_floor: (resultPayload.achievable_floor as number) ?? null,
    floor_above_target: (resultPayload.floor_above_target as boolean) ?? null,
    plan_changed: (resultPayload.plan_changed as boolean) ?? false,
    mitigation_used: (resultPayload.mitigation_used as string) ?? null,
    mitigation_attempts: (resultPayload.mitigation_attempts as number) ?? 0,
    stop_reason: resultArtefact?.summary ?? null,
  };

  return {
    run_id: runId,
    run_type: 'factory_demo',
    generated_at: new Date().toISOString(),
    config,
    steps,
    outcome,
  };
}

export function buildFactsBundle(runId: string, runType: string, artefacts: Artefact[]): RunFactsBundle {
  switch (runType) {
    case 'factory_demo':
      return buildFactoryFactsBundle(runId, artefacts);
    default:
      return buildFactoryFactsBundle(runId, artefacts);
  }
}

const NARRATIVE_SYSTEM_PROMPT = `You are a factory operations analyst writing a plain-English run report.

STRICT RULES:
1. You must ONLY use facts from the provided Run Facts Bundle. Never invent numbers, causes, or steps.
2. If any information is not in the bundle, write "not provided" — never guess.
3. Include the key comparisons: goal vs observed vs floor.
4. Use exact numbers from the bundle (scrap rates, floor values, energy figures).
5. Write in clear, professional prose. No markdown headers — use the section labels provided.
6. Keep each section concise (2-4 sentences max).

OUTPUT FORMAT (use these exact section labels):

**What you asked for**
State the goal and the key constraint (target scrap %).

**Inputs used**
List the scenario, constraints, and any user-specified parameters.

**What the factory reported**
For each step, state: measured scrap %, achievable floor %, defect type, energy per part, and whether drift was detected. Use the step labels from the bundle.

**How it was judged against the goal**
For each step, state the Tower verdict and action, with the reasoning. Compare measured scrap to the target.

**What was decided**
State the decision at each step and any plan changes (mitigation switches).

**Outcome**
State the final result: success, stopped, or partial. If stopped, explain why using the exact numbers (floor vs target). State final scrap rate and whether the target was achievable.`;

async function callLLMForNarrative(factsBundle: RunFactsBundle): Promise<string> {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const userPrompt = `Generate a plain-English narrative report for this factory run. Use ONLY facts from this bundle:\n\n${JSON.stringify(factsBundle, null, 2)}`;

  if (openaiKey) {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: openaiKey });
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: NARRATIVE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
    return response.choices[0]?.message?.content || 'No response from model.';
  }

  if (anthropicKey) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 2000,
        temperature: 0,
        system: NARRATIVE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    const data = await response.json() as any;
    return data.content?.[0]?.text || 'No response from model.';
  }

  throw new Error('No LLM API key configured (need OPENAI_API_KEY or ANTHROPIC_API_KEY)');
}

export interface GenerateNarrativeParams {
  runId: string;
  runType: string;
  userId: string;
  conversationId?: string;
}

export async function generateRunNarrative(params: GenerateNarrativeParams): Promise<{ factsBundle: RunFactsBundle; narrative: string; tldr: string }> {
  const { runId, runType, userId, conversationId } = params;
  const logPrefix = '[RUN_NARRATIVE]';

  console.log(`${logPrefix} Generating narrative for runId=${runId} type=${runType}`);

  const artefacts = await storage.getArtefactsByRunId(runId);
  if (artefacts.length === 0) {
    throw new Error(`No artefacts found for runId=${runId}`);
  }

  const factsBundle = buildFactsBundle(runId, runType, artefacts);

  const tldr = buildTldr(factsBundle);
  console.log(`${logPrefix} TL;DR generated (${tldr.length} chars)`);

  await createArtefact({
    runId, userId, conversationId,
    type: 'run_narrative_facts',
    title: `Run Facts Bundle: ${runType}`,
    summary: `${factsBundle.steps.length} steps, outcome=${factsBundle.outcome.outcome}`,
    payload: factsBundle as unknown as Record<string, unknown>,
  });
  console.log(`${logPrefix} Facts bundle artefact written`);

  const narrative = await callLLMForNarrative(factsBundle);
  console.log(`${logPrefix} LLM narrative generated (${narrative.length} chars)`);

  await createArtefact({
    runId, userId, conversationId,
    type: 'run_narrative',
    title: `Run Narrative: ${runType}`,
    summary: tldr,
    payload: {
      tldr,
      full_explanation: narrative,
      facts_bundle: factsBundle,
      generated_at: new Date().toISOString(),
    },
  });
  console.log(`${logPrefix} Narrative artefact written`);

  return { factsBundle, narrative, tldr };
}
