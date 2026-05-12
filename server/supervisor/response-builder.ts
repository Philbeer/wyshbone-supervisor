import { callLLMText } from './llm-failover';

export interface ResponseBuilderInput {
  businessType: string;
  location: string;
  requestedCount: number | null;
  deliveredCount: number;
  verifiedCount: number;
  towerVerdict: string | null;
  runFailed: boolean;
  failureReason: string;
  circuitBreakerFired: boolean;
  loopsUsed: number;
  executorsUsed: string[];
  monitorCreated: boolean;
  deliveryNote: string | null;
  loopSummaries?: Array<{ executor: string; found: number; verdict: string }> | null;
  scarcityType?: 'A' | 'B' | 'C' | null;
  scarcityNote?: string | null;
}

const EXECUTOR_LABELS: Record<string, string> = {
  gp_cascade: 'Google Places',
  gpt4o_search: 'web search (GPT-4o)',
  outreach: 'outreach',
};

function executorLabel(type: string): string {
  return EXECUTOR_LABELS[type?.toLowerCase()] ?? type ?? 'search';
}

function buildFallbackResponse(input: ResponseBuilderInput): string {
  const { businessType, location, requestedCount, deliveredCount, verifiedCount: rawVerifiedCount,
    runFailed, failureReason, monitorCreated, scarcityType, towerVerdict } = input;

  const towerFailed = ['fail', 'stop', 'error', 'stopped', 'failed'].includes(
    String(towerVerdict ?? '').toLowerCase(),
  );
  const verifiedCount = towerFailed ? 0 : rawVerifiedCount;

  if (runFailed) {
    const reason = failureReason ? failureReason.substring(0, 150) : 'An unexpected error occurred.';
    return [
      `- **Results:** ${reason}`,
      `- **Verification:** n/a`,
      `- **Market:** Unknown — run did not complete.`,
      `- **Suggestion:** Try rephrasing your query or running it again.`,
    ].join('\n\n');
  }

  const resultsLine = requestedCount && deliveredCount < requestedCount
    ? `Found ${deliveredCount} of ${requestedCount} requested ${businessType} in ${location}.`
    : `Found ${deliveredCount} ${businessType} in ${location}.`;

  const verificationLine = deliveredCount === 0
    ? `No results to verify.`
    : verifiedCount === deliveredCount
      ? `All ${deliveredCount} verified with on-page evidence.`
      : verifiedCount > 0
        ? `${verifiedCount} of ${deliveredCount} verified with on-page evidence.`
        : `None could be independently verified.`;

  const marketLine = scarcityType === 'A'
    ? `There may be more — try a wider search.`
    : scarcityType === 'B'
      ? `Market here looks genuinely thin.`
      : scarcityType === 'C'
        ? `Some constraints couldn't be verified reliably.`
        : `Healthy supply in this area.`;

  const suggestionLine = monitorCreated
    ? `Monitoring is already active — I'll alert you when new results appear.`
    : deliveredCount >= 3
      ? `Say "email the top one" to reach out, or ask me to refine the results.`
      : deliveredCount === 0
        ? `Try a broader search term or a wider area.`
        : `Ask me to monitor for new results or expand the search area.`;

  return [
    `- **Results:** ${resultsLine}`,
    `- **Verification:** ${verificationLine}`,
    `- **Market:** ${marketLine}`,
    `- **Suggestion:** ${suggestionLine}`,
  ].join('\n\n');
}

export async function buildNaturalResponse(input: ResponseBuilderInput): Promise<string> {
  const { businessType, location, requestedCount, deliveredCount, verifiedCount,
    runFailed, loopsUsed, executorsUsed, loopSummaries,
    scarcityType, circuitBreakerFired, monitorCreated, towerVerdict } = input;

  // Honest verification count: if Tower returned a failure verdict, the
  // supervisor's optimistic verifiedCount is a lie. The Tower verdict is
  // the truth source — anything Tower didn't pass cannot be claimed as
  // "verified" in the user-facing summary.
  const towerFailed = ['fail', 'stop', 'error', 'stopped', 'failed'].includes(
    String(towerVerdict ?? '').toLowerCase(),
  );
  const effectiveVerifiedCount = towerFailed ? 0 : verifiedCount;

  if (runFailed) {
    return buildFallbackResponse(input);
  }

  const facts: string[] = [];
  facts.push(`Entity searched for: ${businessType} in ${location}`);
  if (requestedCount) facts.push(`User asked for: ${requestedCount}`);
  facts.push(`Delivered: ${deliveredCount}`);
  if (effectiveVerifiedCount > 0) facts.push(`Verified with evidence: ${effectiveVerifiedCount}`);
  if (towerFailed) {
    facts.push(`IMPORTANT: Tower judged this run as ${towerVerdict?.toUpperCase()}. Do NOT claim any leads were verified. The user-facing message must reflect that no leads were verified against the user's hard constraints.`);
  }
  facts.push(`Tower verdict: ${towerVerdict ?? 'unknown'}`);

  if (loopSummaries && loopSummaries.length > 0) {
    const loopLines = loopSummaries.map((s, i) =>
      `Loop ${i + 1}: ${executorLabel(s.executor)} — found ${s.found} (${s.verdict})`
    );
    facts.push(`Search loops:\n${loopLines.join('\n')}`);
  } else if (loopsUsed > 0 && executorsUsed.length > 0) {
    facts.push(`Executors used: ${executorsUsed.map(executorLabel).join(', ')}`);
    facts.push(`Loops: ${loopsUsed}`);
  }

  if (scarcityType === 'A') facts.push(`Scarcity type: A — hit batch limit, more may exist in a wider area`);
  if (scarcityType === 'B') facts.push(`Scarcity type: B — real scarcity, this is likely all there is`);
  if (scarcityType === 'C') facts.push(`Scarcity type: C — capability limit, constraint was hard to verify`);
  if (!scarcityType) facts.push(`Scarcity type: null — supply appears healthy`);
  if (circuitBreakerFired) facts.push(`Note: search was cut short after reaching the loop limit`);
  if (monitorCreated) facts.push(`A monitor has been set up for ongoing checks`);

  const prompt = `You are writing the delivery message for a B2B lead-generation agent called Wyshbone. The user just ran a search. Produce exactly four markdown bullets, nothing else — no preamble, no closing summary.

FACTS ABOUT THIS RUN:
${facts.join('\n')}

OUTPUT FORMAT (copy this structure exactly):

- **Results:** <one sentence: count + business type + location>

- **Verification:** <one sentence: how many were verified with on-page evidence>

- **Market:** <one sentence about supply or scarcity>

- **Suggestion:** <one sentence: the single most relevant next action>

RULES:
- Use markdown bullets (-) and bold labels (**Results:**, **Verification:**, **Market:**, **Suggestion:**).
- Each bullet on its own line, separated by a blank line.
- Each bullet's text must be a single sentence — no run-ons.
- Be specific — use the actual numbers, location, and entity type from the facts above.
- Market bullet: if scarcityType is null, write "Healthy supply in this area." If Type A (batch limit hit), write "There may be more — try a wider search." If Type B (real scarcity), write "Market here looks genuinely thin." If Type C (constraint unverifiable), write "Some constraints couldn't be verified reliably."
- Suggestion bullet: if a monitor has been set up, say monitoring is already active. Otherwise pick the single most relevant action — email a lead, refine results, set up monitoring, or expand the area.
- Do NOT start with "I'm happy to" or any sycophantic opener.
- Do NOT add any text before the first bullet or after the last bullet.`;

  try {
    const response = await callLLMText(
      'You write short, structured delivery summaries for a B2B lead-generation agent. Always output exactly four markdown bullets with bold labels. Be specific. Never add preamble or closing text.',
      prompt,
      'response_builder',
      {
        providerChain: ['openai', 'anthropic'],
        openaiModel: 'gpt-4o-mini',
        anthropicModel: 'claude-haiku-4-5-20251001',
        maxTokens: 200,
        timeoutMs: 8000,
      },
    );
    const cleaned = response.trim().replace(/^"|"$/g, '');
    if (cleaned.length < 10) return buildFallbackResponse(input);
    return cleaned;
  } catch (err: any) {
    console.warn(`[RESPONSE_BUILDER] LLM call failed (non-fatal): ${err.message} — using fallback`);
    return buildFallbackResponse(input);
  }
}
