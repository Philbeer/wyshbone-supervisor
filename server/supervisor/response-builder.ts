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
  towerRationale?: string | null;
  towerFailingConstraintReason?: string | null;
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

  // If Tower failed AND we have a rationale, override the Results line to be honest.
  // This is the fallback path — used only when the LLM call fails. It keeps the
  // user-facing message coherent even without the LLM.
  if (towerFailed && input.towerRationale && deliveredCount > 0) {
    const honestResultsLine = `Found ${deliveredCount} ${businessType} in ${location}, but the search couldn't fully verify all requirements.`;
    return [
      `- **Results:** ${honestResultsLine}`,
      `- **Verification:** ${verificationLine}`,
      `- **Market:** ${input.towerRationale.substring(0, 200)}`,
      `- **Suggestion:** Try refining the search or relaxing one of the constraints.`,
    ].join('\n\n');
  }

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

  if (runFailed) {
    return buildFallbackResponse(input);
  }

  const facts: string[] = [];
  facts.push(`Entity searched for: ${businessType} in ${location}`);
  if (requestedCount) facts.push(`User asked for: ${requestedCount}`);
  facts.push(`Delivered: ${deliveredCount}`);
  // Always surface verifiedCount — even when zero. The LLM needs to see
  // it explicitly to avoid defaulting to "none verified" when Tower errored.
  facts.push(`Per-lead verified with evidence: ${verifiedCount} (this is the source of truth for the Verification bullet)`);
  facts.push(`Tower verdict: ${towerVerdict ?? 'unknown'} (use this only for Market/Suggestion bullets, NOT Verification)`);

  // Tower's own honest reasoning — included verbatim when Tower failed the run.
  // The Tower has already done the LLM reasoning about what went wrong; we surface it
  // here so the user gets a clear explanation instead of a generic verified-count line.
  const towerFailed = ['fail', 'stop', 'change_plan', 'error', 'stopped', 'failed'].includes(
    String(towerVerdict ?? '').toLowerCase(),
  );
  if (towerFailed && input.towerRationale) {
    facts.push(`Tower's reason for failing this run: "${input.towerRationale}"`);
  }
  if (towerFailed && input.towerFailingConstraintReason) {
    facts.push(`Specific constraint that could not be verified: "${input.towerFailingConstraintReason}"`);
  }

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

HARD RULES (these override everything below):

1. The "Results:" bullet count MUST equal the delivered_count provided in the facts. Never invent a different number, never round up, never claim more than was delivered. If delivered_count is 3, say "Found 3", not "Found 5" or "Found several".

2. The "Verification:" bullet describes the SAME count. Since unverified leads were dropped at the gateway upstream, EVERY delivered lead is verified. The phrasing is "All N verified with on-page evidence" — never "X of N verified" because unverified leads do not appear in the delivery.

3. If delivered_count is 0, the response uses Example B (below). Do not pretend any leads were delivered.

EXAMPLE A — Tower passed, leads verified (the normal case):
Results: Found 3 beer festivals in Sussex.
Verification: All 3 verified with on-page evidence.
Market: Healthy supply in this area.
Suggestion: Consider setting up monitoring for future events.

EXAMPLE B — No verified leads delivered:
Results: Could not deliver verified results.
Verification: Tower could not confirm any matches — the available evidence was insufficient.
Market: Genuinely scarce — there may be few or no qualifying businesses here.
Suggestion: Try broadening your search criteria.

RULES:
- Use markdown bullets (-) and bold labels (**Results:**, **Verification:**, **Market:**, **Suggestion:**).
- Each bullet on its own line, separated by a blank line.
- Each bullet's text must be a single sentence — no run-ons.
- Be specific — use the actual numbers, location, and entity type from the facts above.
- **Results** bullet ALWAYS states the "Delivered" count from the facts. NEVER use "Per-lead verified with evidence" in the Results bullet. The Results bullet answers "how many leads did we surface to the user?" — that is always Delivered, regardless of how many were verified. Example: if Delivered=16 and verified=0, Results says "Found 16 dentists in Brighton." NOT "0 dentists were found."
- The Results and Verification bullets describe DIFFERENT things and must NEVER contradict each other. Results = count delivered. Verification = count independently confirmed. Both can be true at the same time. Example pair: "Results: Found 16 dentists in Brighton. Verification: None could be independently verified." — both correct, no contradiction.
- Verification bullet MUST use the "Per-lead verified with evidence" number. If verified > 0, say "N of M were verified with on-page evidence" (or "all N verified" when N === M). If verified === 0, say "None could be independently verified." NEVER use Tower verdict to write the Verification bullet — Tower verdict is for Market/Suggestion only.
- If Tower's reason for failing this run is provided in the facts, the **Market** bullet MUST paraphrase the Tower's reason naturally (do NOT copy verbatim) — this overrides the default scarcityType-based Market wording for this case. The **Suggestion** bullet should offer a concrete alternative or next step that addresses the unverifiable constraint (e.g. rank by a proxy, relax the constraint, refine the search). The **Results** bullet stays clean — it states the delivered count only. Never claim something was verified that the Tower says was not.
- If Tower verdict is "error", do NOT mention it in the bullets. The user does not need to know about service errors.
- Market bullet: if scarcityType is null, write "Healthy supply in this area." If Type A (batch limit hit), write "There may be more — try a wider search." If Type B (real scarcity), write "Market here looks genuinely thin." If Type C (constraint unverifiable), write "Some constraints couldn't be verified reliably."
- Suggestion bullet: if a monitor has been set up, say monitoring is already active. Otherwise pick the single most relevant action — email a lead, refine results, set up monitoring, or expand the area.
- Do NOT start with "I'm happy to" or any sycophantic opener.
- Do NOT add any text before the first bullet or after the last bullet.

EXAMPLES OF CORRECT OUTPUT (use these to anchor the pattern, not as literal templates):

Example 1 — Tower passed, all verified:
- **Results:** Found 12 accountants in Kent.

- **Verification:** All 12 verified with on-page evidence.

- **Market:** Healthy supply in this area.

- **Suggestion:** Say "email the top one" to reach out, or ask me to refine the results.

Example 2 — Tower failed, some delivered, none verified:
- **Results:** Found 16 dentists in Brighton.

- **Verification:** None could be independently verified.

- **Market:** Ranking by "best" needs comparing reviews across sources, which wasn't done.

- **Suggestion:** Try ranking by Google rating, or refine to specific dental services.

Example 3 — Tower passed, partial verification:
- **Results:** Found 9 upcoming festivals in Bristol.

- **Verification:** 5 of 9 verified with on-page evidence.

- **Market:** Healthy supply in this area.

- **Suggestion:** Ask me to monitor for new results or expand the search area.`;

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
