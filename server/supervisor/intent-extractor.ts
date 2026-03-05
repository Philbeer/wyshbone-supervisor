import {
  type CanonicalIntent,
  type IntentValidationResult,
  parseAndValidateIntentJSON,
  INTENT_ACTION_ENUM,
  CONSTRAINT_TYPE_ENUM,
  HARDNESS_ENUM,
  EVIDENCE_MODE_ENUM,
} from './canonical-intent';

const INTENT_EXTRACTOR_SYSTEM_PROMPT = `You are a strict intent classifier for a B2B lead generation system. Given a user message, extract the canonical intent as JSON.

SCHEMA (all fields required):
{
  "action": one of ${JSON.stringify(INTENT_ACTION_ENUM)},
  "business_type": string or null (core business type only, e.g. "pubs", "dentists"),
  "location": string or null (geographic location only),
  "country": string or null (inferred from location: "UK", "US", etc.),
  "count": number or null (explicit count from user, null if not specified),
  "constraints": [
    {
      "type": one of ${JSON.stringify(CONSTRAINT_TYPE_ENUM)},
      "raw": string (verbatim phrase from user message that triggered this constraint),
      "hardness": one of ${JSON.stringify(HARDNESS_ENUM)},
      "evidence_mode": one of ${JSON.stringify(EVIDENCE_MODE_ENUM)},
      "clarify_if_needed": boolean (true if this constraint is ambiguous or unverifiable),
      "value": string or number or null (the extracted value)
    }
  ],
  "delivery_requirements": { "email": boolean, "phone": boolean, "website": boolean },
  "confidence": number 0-1 (how confident you are in this extraction),
  "raw_input": string (verbatim user message)
}

CONSTRAINT CLASSIFICATION RULES:
- "serve food", "beer garden", "outdoor seating", "air conditioning", "parking", "wifi", "wheelchair accessible", "dog friendly" → type: "attribute", evidence_mode: "website_text"
- "in <place>", "near <place>" → type: "location", evidence_mode: "google_places"
- "find N", "top N" → type: "count", evidence_mode: "not_applicable"
- "opened in last N months", "opened recently", "new" → type: "time", evidence_mode: "web_search" or "news" or "registry"
- "with the word X in the name", "called X" → type: "name_filter", evidence_mode: "google_places"
- "works with", "supplies", "owned by", "run by" → type: "relationship", evidence_mode: "web_search", clarify_if_needed: true
- "serve food", "serves drinks" → type: "attribute", evidence_mode: "website_text" (NOT relationship)
- Phrases you cannot classify → type: "unknown_constraint", evidence_mode: "unknown", clarify_if_needed: true

HARDNESS RULES:
- "must", "only", "exactly", "strict" → hard
- "preferably", "if possible", "ideally", "nice to have" → soft
- Attributes stated as requirements (no hedging) → hard
- Location → soft unless "only in" / "must be in"

Return ONLY valid JSON. No markdown fences, no commentary, no explanation.`;

export interface IntentExtractionResult {
  validation: IntentValidationResult;
  model: string;
  duration_ms: number;
  raw_response: string;
}

export async function extractCanonicalIntent(
  userMessage: string,
  conversationContext?: string,
): Promise<IntentExtractionResult> {
  const startMs = Date.now();
  const model = selectModel();

  let userPrompt = `Extract the canonical intent from this user message:\n\n"${userMessage}"`;
  if (conversationContext) {
    userPrompt = `Conversation context:\n${conversationContext}\n\nExtract the canonical intent from this latest user message:\n\n"${userMessage}"`;
  }

  let rawResponse: string;
  try {
    rawResponse = await callLLM(model, userPrompt);
  } catch (err: any) {
    const duration_ms = Date.now() - startMs;
    return {
      validation: { ok: false, intent: null, errors: [`LLM call failed: ${err.message}`] },
      model,
      duration_ms,
      raw_response: '',
    };
  }

  const duration_ms = Date.now() - startMs;
  const cleaned = cleanJsonResponse(rawResponse);
  const validation = parseAndValidateIntentJSON(cleaned);

  return { validation, model, duration_ms, raw_response: rawResponse };
}

function selectModel(): string {
  if (process.env.OPENAI_API_KEY) return 'gpt-4o-mini';
  if (process.env.ANTHROPIC_API_KEY) return 'claude-3-5-haiku-20241022';
  return 'none';
}

async function callLLM(model: string, userPrompt: string): Promise<string> {
  if (model === 'gpt-4o-mini') {
    return callOpenAI(userPrompt);
  }
  if (model.startsWith('claude-')) {
    return callAnthropic(model, userPrompt);
  }
  throw new Error('No LLM API key available (OPENAI_API_KEY or ANTHROPIC_API_KEY required)');
}

async function callOpenAI(userPrompt: string): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: INTENT_EXTRACTOR_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });
  return response.choices[0]?.message?.content || '';
}

async function callAnthropic(model: string, userPrompt: string): Promise<string> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0,
      system: INTENT_EXTRACTOR_SYSTEM_PROMPT,
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

function cleanJsonResponse(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```json')) s = s.slice(7);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  return s.trim();
}
