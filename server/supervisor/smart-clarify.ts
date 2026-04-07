/**
 * Smart Clarification — Context-aware clarification for incomplete missions
 *
 * Fires when the mission extractor produces an incomplete mission (missing
 * entity type, location, or key constraints). Reads URL content and
 * conversation context to produce a helpful, contextual clarification
 * instead of a blunt "what type of businesses?" question.
 *
 * Uses the existing pending contract system — no new state management.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SmartClarifyInput {
  userMessage: string;
  conversationContext: string | null;
  partialMission: {
    entity_category?: string;
    location_text?: string;
    constraints?: Array<{ type: string; field: string; value: string }>;
  } | null;
  missingFields: string[];
  urlContent: string | null;
  userProfile?: {
    companyName?: string;
    companyDomain?: string;
    inferredIndustry?: string;
    primaryObjective?: string;
  } | null;
}

export interface SmartClarifyResult {
  clarification_message: string;
  inferred_context: {
    product_description?: string;
    suggested_sectors?: string[];
    suggested_locations?: string[];
  };
  still_missing: string[];
  can_proceed_without: boolean;
  proposed_query?: string;
}

// ─── Circuit breaker — prevent runaway calls ─────────────────────────────────

const _smartClarifyTimestamps: number[] = [];
const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000;
const CIRCUIT_BREAKER_MAX_CALLS = 20;

function isCircuitBroken(): boolean {
  const cutoff = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;
  while (_smartClarifyTimestamps.length > 0 && _smartClarifyTimestamps[0] < cutoff) {
    _smartClarifyTimestamps.shift();
  }
  return _smartClarifyTimestamps.length >= CIRCUIT_BREAKER_MAX_CALLS;
}

function recordCall(): void {
  _smartClarifyTimestamps.push(Date.now());
}

// ─── LLM call (reuses same pattern as rescue-llm.ts) ────────────────────────

async function callAnthropicHaiku(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot call smart clarification LLM');
  }

  const model = process.env.RESCUE_LLM_MODEL || 'claude-3-5-haiku-20241022';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${body.substring(0, 200)}`);
  }

  const data = await resp.json() as { content: Array<{ type: string; text?: string }> };
  const textBlock = data.content?.find((b) => b.type === 'text');
  return textBlock?.text || '';
}

// ─── Core function ───────────────────────────────────────────────────────────

export async function generateSmartClarification(input: SmartClarifyInput): Promise<SmartClarifyResult> {
  if (process.env.SMART_CLARIFY_ENABLED !== 'true') {
    throw new Error('Smart clarification disabled');
  }

  if (isCircuitBroken()) {
    throw new Error(`Smart clarify circuit breaker OPEN — ${CIRCUIT_BREAKER_MAX_CALLS} calls in ${CIRCUIT_BREAKER_WINDOW_MS / 1000}s`);
  }

  recordCall();

  const systemPrompt = `You are a clarification assistant for Wyshbone, a business lead finder. A user has asked to find businesses but their request is incomplete. Your job is to:

1. Read any URL content or conversation context to understand what the user's product/service does
2. Suggest relevant business sectors or types that might be interested
3. Ask what's still missing (usually a location or specific sector)
4. Be helpful and specific — don't just ask "what type of businesses?"

You must respond with a JSON object only (no markdown, no backticks):
{
  "clarification_message": "Your helpful message to the user. Can include sector suggestions based on URL analysis. Must end with a specific question about what's missing. Keep it concise — 2-3 sentences max.",
  "inferred_context": {
    "product_description": "One sentence describing the user's product/service if a URL was analysed, or null",
    "suggested_sectors": ["sector1", "sector2", "sector3"] or null if no URL to analyse,
    "suggested_locations": ["location hint"] or null
  },
  "still_missing": ["location"] or ["entity_type"] or ["location", "entity_type"],
  "can_proceed_without": false,
  "proposed_query": "A concrete search query if you have enough to suggest one, or null"
}

RULES:
- Keep clarification_message to 2-3 sentences. Be concise and direct.
- If you analysed a URL, briefly mention what the product does and suggest 2-3 relevant sectors
- Always ask specifically for what's missing — don't be vague
- If the user's company/product is clear, frame suggestions in terms of who would BUY their product
- If location is missing, ask "Where should I search?" not "Can you tell me a location?"
- Never apologise or say "I'm not sure"`;

  const userPrompt = `User's message: "${input.userMessage}"

${input.urlContent ? `URL CONTENT FETCHED:\n${input.urlContent.slice(0, 3000)}` : 'No URL content available.'}

${input.conversationContext ? `CONVERSATION CONTEXT:\n${input.conversationContext.slice(0, 2000)}` : 'No conversation history.'}

PARTIAL MISSION EXTRACTION:
- Entity type: ${input.partialMission?.entity_category || 'MISSING'}
- Location: ${input.partialMission?.location_text || 'MISSING'}
- Constraints: ${JSON.stringify(input.partialMission?.constraints || [])}

WHAT'S MISSING: ${input.missingFields.join(', ')}

${input.userProfile?.companyName ? `USER'S COMPANY: ${input.userProfile.companyName}` : ''}
${input.userProfile?.inferredIndustry ? `USER'S INDUSTRY: ${input.userProfile.inferredIndustry}` : ''}`;

  const rawResponse = await callAnthropicHaiku(systemPrompt, userPrompt);

  const cleaned = rawResponse.trim()
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const result = JSON.parse(cleaned) as SmartClarifyResult;

  if (!result.clarification_message) {
    throw new Error('Smart clarify response missing required clarification_message field');
  }

  console.log(`[SMART_CLARIFY] Generated: "${result.clarification_message.slice(0, 80)}" missing=[${result.still_missing}] inferred=${!!result.inferred_context?.product_description}`);

  return result;
}
